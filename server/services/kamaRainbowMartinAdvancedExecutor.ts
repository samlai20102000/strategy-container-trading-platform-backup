import type { PositionLeg, Strategy } from "../../drizzle/schema";
import {
  normalizeExecutionModePolicy,
  type ExecutionPolicy,
} from "../../shared/executionModes";
import type { KamaRainbowMartinConfig } from "../../shared/strategies/kamaRainbowMartin";
import type { ExchangeAdapter, OrderResult } from "../exchanges/types";
import {
  type KamaRainbowMartinPositionSize,
} from "../strategies/kamaRainbowMartin/core";
import { createKamaRainbowMartinRuntimeState } from "../strategies/kamaRainbowMartin/core";
import {
  applyKamaRainbowMartinCloseToState,
  applyKamaRainbowMartinFillToState,
  applyKamaRainbowMartinPartialCloseToState,
} from "../strategies/kamaRainbowMartin/management";
import type {
  KamaRainbowMartinExecutionOptions,
  KamaRainbowMartinExecutionResult,
  KamaRainbowMartinSealedSignal,
} from "./kamaRainbowMartinExecutor";
import { acquireBarLock, releaseAllLocks } from "./barLock";
import { resolveDeploymentPosition } from "./deploymentPosition";
import { fetchKamaRainbowMartinFreshQuote } from "./kamaRainbowMartinMarketData";
import { restoreKamaRainbowMartinLegState } from "./kamaRainbowMartinLegState";
import { authorizeRuntimeModeAction, runtimeModeRejectionMessage } from "./runtimeModeGuard";
import { normalizeQtyForSymbol } from "./symbolSpecs";
import {
  appendExecutionFill,
  createOrderIntent,
  createOrGetHedgeRelationship,
  createOrGetPositionLeg,
  getOwnedPositionLeg,
  listActiveHedgeRelationshipsForLeg,
  listActivePositionLegs,
  transitionHedgeRelationship,
  transitionOrderIntent,
  transitionPositionLeg,
  updatePositionLegRuntime,
} from "./threeModeLedger";
import { tradeFillRecordFields } from "./tradeFillTruth";
import { recordExistingTradeExecution as createTrade } from "./tradeExecutionLedger";

const TIMEFRAME_MINUTES: Readonly<Record<string, number>> = {
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1_440,
  W1: 10_080,
};

function toTriggerSource(source: KamaRainbowMartinExecutionOptions["source"]): string {
  if (source === "RISK") return "risk_monitor";
  if (source === "RECONCILIATION") return "reconciliation";
  if (source === "MANUAL") return "manual";
  if (source === "AUTO") return "auto";
  return "webhook";
}

function boundedIdentity(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 128);
}

function decimal(value: number): string {
  return value.toFixed(8);
}

async function resolveExecutionTruth(
  adapter: ExchangeAdapter,
  symbol: string,
  result: OrderResult,
  expectPnl: boolean,
): Promise<OrderResult> {
  if ((result.filledSize ?? 0) > 0 && (!expectPnl || result.settlementStatus === "final")) return result;
  if (!result.orderId) return result;
  try {
    const truth = await adapter.getOrderExecutionTruth(symbol, result.orderId, expectPnl);
    return { ...result, ...truth };
  } catch {
    return result;
  }
}

async function createIntent(input: {
  strategy: Strategy;
  signal: KamaRainbowMartinSealedSignal;
  cycleId: string;
  legId: string;
  decisionId: string;
  reasonCode: string;
  action: "OPEN" | "ADD" | "REDUCE" | "CLOSE";
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  reduceOnly: boolean;
  quantity: number;
  price: number;
}) {
  const eventKey = input.signal.kamaRainbowMartinEventKey || input.decisionId;
  return createOrderIntent({
    intentId: boundedIdentity(`krm-intent:${input.decisionId}:${input.legId}`),
    idempotencyKey: boundedIdentity(`krm:${input.strategy.id}:${input.legId}:${eventKey}:${input.action}`),
    decisionId: input.decisionId,
    userId: input.strategy.userId,
    strategyId: input.strategy.id,
    cycleId: input.cycleId,
    legId: input.legId,
    action: input.action,
    side: input.side,
    positionSide: input.positionSide,
    reduceOnly: input.reduceOnly,
    requestedQuantity: input.quantity,
    requestedPrice: input.price,
    reasonCode: input.reasonCode,
  });
}

async function appendFillTruth(input: {
  strategy: Strategy;
  cycleId: string;
  legId: string;
  intentId: string;
  truth: OrderResult;
  quantity: number;
  price: number;
  fallbackTimestamp: number;
}): Promise<void> {
  const fillTimestamp = input.truth.filledAt ?? input.fallbackTimestamp;
  const fillIdentity = input.truth.tradeId || input.truth.orderId || `${input.intentId}:${fillTimestamp}`;
  await appendExecutionFill({
    fillKey: boundedIdentity(`krm-fill:${fillIdentity}:${input.legId}`),
    intentId: input.intentId,
    userId: input.strategy.userId,
    strategyId: input.strategy.id,
    cycleId: input.cycleId,
    legId: input.legId,
    exchangeOrderId: input.truth.orderId ?? null,
    exchangeTradeId: input.truth.tradeId ?? null,
    quantity: input.quantity,
    price: input.price,
    fee: input.truth.fee ?? null,
    feeCurrency: null,
    filledAt: fillTimestamp,
  });
}

async function closeHedgeRelationships(strategy: Strategy, legId: string, reason: string): Promise<void> {
  const relationships = await listActiveHedgeRelationshipsForLeg({
    userId: strategy.userId,
    strategyId: strategy.id,
    legId,
  });
  for (const relationship of relationships) {
    await transitionHedgeRelationship(relationship.relationshipId, "CLOSED", {
      unwindSnapshot: {
        reason,
        closedLegId: legId,
        closedAt: Date.now(),
      },
      closedAt: new Date(),
    });
  }
}

async function executeAdvancedClose(input: {
  strategy: Strategy;
  signal: KamaRainbowMartinSealedSignal;
  signalId: number;
  adapter: ExchangeAdapter;
  options: KamaRainbowMartinExecutionOptions;
  config: KamaRainbowMartinConfig;
  policy: Exclude<ExecutionPolicy, { mode: "SINGLE_EXCLUSIVE" }>;
  targetLeg: PositionLeg;
  cycleId: string;
}): Promise<KamaRainbowMartinExecutionResult> {
  const { strategy, signal, signalId, adapter, options, targetLeg, cycleId } = input;
  const state = restoreKamaRainbowMartinLegState(targetLeg);
  const quantity = Number(targetLeg.quantity);
  const positionSide = targetLeg.side;
  const positionSideLower = positionSide === "LONG" ? "long" : "short";
  const authorization = await authorizeRuntimeModeAction({
    strategy,
    signal: {
      action: "close",
      positionSide: positionSideLower,
      price: signal.price,
      reason: signal.reason,
      requestedQuantity: quantity,
      source: options.source,
      eventKey: signal.kamaRainbowMartinEventKey || options.eventKey,
    },
    signalId,
    adapter,
    cycleId,
    legId: targetLeg.legId,
  });
  if (!authorization.allowed) {
    return {
      status: authorization.envelope.decision.outcome === "HOLD" ? "skipped" : "rejected",
      message: runtimeModeRejectionMessage(authorization),
    };
  }
  const decision = authorization.envelope.decision;
  if (decision.targetLegId !== targetLeg.legId) {
    return { status: "rejected", message: "Kama 彩虹馬丁 advanced close target 與 sealed leg 不一致" };
  }

  let exchangePosition;
  try {
    const positions = await adapter.getPositions(strategy.symbol);
    exchangePosition = positions.find(position => position.side === positionSideLower && position.size > 0);
  } catch (error: any) {
    return { status: "failed", message: `Kama 彩虹馬丁無法驗證交易所腿級持倉：${error.message}` };
  }
  if (!exchangePosition) {
    return { status: "rejected", message: `Kama 彩虹馬丁找不到 ${positionSideLower} 交易所腿，拒絕 advanced close` };
  }
  if (quantity > exchangePosition.size + Math.max(1e-12, exchangePosition.size * 1e-8)) {
    return { status: "rejected", message: "Kama 彩虹馬丁 ledger 腿數量大於交易所持倉，需先對賬" };
  }
  const approvedQuantity = Math.min(decision.approvedQuantity ?? quantity, quantity, exchangePosition.size);
  const normalized = await normalizeQtyForSymbol(strategy.exchange, strategy.symbol, approvedQuantity, "linear");
  if (normalized.rejected) {
    return { status: "rejected", message: `Kama 彩虹馬丁 advanced close 數量無效：${normalized.reason}` };
  }
  const intentAction = normalized.qty >= quantity - 1e-12 ? "CLOSE" : "REDUCE";
  const intentResult = await createIntent({
    strategy,
    signal,
    cycleId,
    legId: targetLeg.legId,
    decisionId: decision.decisionId,
    reasonCode: decision.reasonCode,
    action: intentAction,
    side: positionSide === "LONG" ? "SELL" : "BUY",
    positionSide,
    reduceOnly: true,
    quantity: normalized.qty,
    price: signal.price || Number(exchangePosition.markPrice || state.avgPrice),
  });
  if (intentResult.deduplicated) {
    return { status: "skipped", message: `Kama 彩虹馬丁 advanced close intent 已存在（${intentResult.intent.status}）` };
  }
  await transitionOrderIntent(intentResult.intent.intentId, "SUBMITTING");
  const result = await adapter.placeOrder({
    symbol: strategy.symbol,
    side: positionSide === "LONG" ? "sell" : "buy",
    orderType: "market",
    size: normalized.qty,
    reduceOnly: true,
    posSide: positionSideLower,
  });
  if (!result.success) {
    await transitionOrderIntent(intentResult.intent.intentId, "FAILED", { error: result.errorMessage || "exchange rejected" });
    return { status: "failed", message: result.errorMessage || "Kama 彩虹馬丁 advanced close 失敗", exchangeResponse: result.rawResponse };
  }
  await transitionOrderIntent(intentResult.intent.intentId, "SUBMITTED", { exchangeOrderId: result.orderId });
  const truth = await resolveExecutionTruth(adapter, strategy.symbol, result, true);
  const filledQuantity = Number(truth.filledSize || 0);
  const filledPrice = Number(truth.filledPrice || signal.price || state.avgPrice);
  if (!(filledQuantity > 0) || !(filledPrice > 0)) {
    await transitionOrderIntent(intentResult.intent.intentId, "RECONCILIATION_REQUIRED", { exchangeOrderId: truth.orderId });
    return {
      status: "failed",
      message: "Kama 彩虹馬丁 advanced close 缺少成交真相；腿狀態保持不動並等待對賬",
      orderId: truth.orderId,
      exchangeResponse: truth.rawResponse,
    };
  }
  const fillTimestamp = truth.filledAt ?? Date.now();
  await appendFillTruth({ strategy, cycleId, legId: targetLeg.legId, intentId: intentResult.intent.intentId, truth, quantity: filledQuantity, price: filledPrice, fallbackTimestamp: fillTimestamp });
  const fullyClosed = filledQuantity >= quantity - 1e-12;
  await transitionOrderIntent(intentResult.intent.intentId, fullyClosed ? "FILLED" : "PARTIALLY_FILLED", { exchangeOrderId: truth.orderId });
  const closeReason = signal.kamaRainbowMartinCloseReason ?? "OTHER";
  const nextState = fullyClosed
    ? applyKamaRainbowMartinCloseToState(state, closeReason, fillTimestamp)
    : applyKamaRainbowMartinPartialCloseToState(state, filledQuantity, closeReason, fillTimestamp);
  if (fullyClosed) {
    await transitionPositionLeg(targetLeg.legId, "CLOSED", {
      quantity: "0.00000000",
      martinState: nextState,
      closedAt: new Date(fillTimestamp),
    });
    await closeHedgeRelationships(strategy, targetLeg.legId, closeReason);
    const remaining = await listActivePositionLegs({ userId: strategy.userId, strategyId: strategy.id });
    if (remaining.length === 0) await releaseAllLocks(strategy.id);
  } else {
    await updatePositionLegRuntime(targetLeg.legId, {
      quantity: decimal(nextState.totalSize),
      avgEntryPrice: decimal(nextState.avgPrice),
      martinState: nextState,
    });
  }
  await createTrade({
    strategyId: strategy.id,
    userId: strategy.userId,
    signalId,
    exchange: strategy.exchange,
    symbol: strategy.symbol,
    side: positionSide === "LONG" ? "sell" : "buy",
    orderType: "market",
    orderId: truth.orderId,
    ...tradeFillRecordFields(truth, filledPrice, normalized.qty),
    reduceOnly: true,
    status: "filled",
    triggerSource: toTriggerSource(options.source),
    cycleId,
    legId: targetLeg.legId,
    executionMode: input.policy.mode,
  });
  return {
    status: "executed",
    message: `Kama 彩虹馬丁 ${input.policy.mode} 精確關腿 ${targetLeg.legId} ${filledQuantity}`,
    orderId: truth.orderId,
    exchangeResponse: truth.rawResponse,
  };
}

export async function executeKamaRainbowMartinAdvancedSignal(input: {
  strategy: Strategy;
  signal: KamaRainbowMartinSealedSignal;
  signalId: number;
  adapter: ExchangeAdapter;
  options: KamaRainbowMartinExecutionOptions;
  config: KamaRainbowMartinConfig;
}): Promise<KamaRainbowMartinExecutionResult> {
  const { strategy, signal, signalId, adapter, options, config } = input;
  const policy = normalizeExecutionModePolicy(
    strategy.executionPolicy ?? { mode: strategy.executionMode || "SINGLE_EXCLUSIVE" },
  );
  if (policy.mode === "SINGLE_EXCLUSIVE") {
    return { status: "rejected", message: "Kama 彩虹馬丁 advanced executor 不接受 S1" };
  }
  const action = signal.kamaRainbowMartinAction;
  if (!action) return { status: "rejected", message: "Kama 彩虹馬丁缺少 sealed action" };
  const existingTarget = options.legId
    ? await getOwnedPositionLeg({ userId: strategy.userId, strategyId: strategy.id, legId: options.legId })
    : null;
  const eventKey = signal.kamaRainbowMartinEventKey || options.eventKey || `${signal.barTimestamp || Date.now()}:${action}`;
  const cycleId = boundedIdentity(options.cycleId || existingTarget?.cycleId || `krm-cycle:${strategy.id}:${eventKey}`);
  if (action === "CLOSE") {
    if (!existingTarget) return { status: "rejected", message: "Kama 彩虹馬丁 advanced close 缺少可證明 ownership 的 legId" };
    return executeAdvancedClose({ strategy, signal, signalId, adapter, options, config, policy, targetLeg: existingTarget, cycleId });
  }

  const opensLong = action === "OPEN_LONG" || action === "ADD_LONG";
  const initialAction = action === "OPEN_LONG" || action === "OPEN_SHORT";
  if (!initialAction && !existingTarget) {
    return { status: "rejected", message: "Kama 彩虹馬丁 advanced add 缺少目標腿" };
  }
  if (existingTarget && existingTarget.side !== (opensLong ? "LONG" : "SHORT")) {
    return { status: "rejected", message: "Kama 彩虹馬丁 sealed action 與目標腿方向不一致" };
  }
  if (existingTarget?.role === "HEDGE" && !initialAction) {
    return { status: "rejected", message: "Kama 彩虹馬丁 H3 保護腿禁止馬丁加倉" };
  }

  let quote;
  try {
    quote = await fetchKamaRainbowMartinFreshQuote(strategy.exchange, strategy.symbol);
  } catch (error: any) {
    return { status: "failed", message: `Kama 彩虹馬丁 fresh quote 取得失敗：${error.message}` };
  }
  const executionPrice = opensLong ? quote.ask : quote.bid;
  const deploymentPosition = resolveDeploymentPosition(strategy, { value: 0.01, mode: "quantity" });
  const requestedPosition: KamaRainbowMartinPositionSize | undefined = initialAction
    ? deploymentPosition
    : signal.kamaRainbowMartinOrderSize;
  if (!requestedPosition || !(requestedPosition.value > 0)) {
    return { status: "rejected", message: "Kama 彩虹馬丁 advanced 下單缺少有效腿級數量" };
  }
  let quantity = requestedPosition.mode === "usdt"
    ? requestedPosition.value / executionPrice
    : requestedPosition.value;
  const maxPositionPct = Number(strategy.maxPositionPct || 0);
  if (maxPositionPct > 0) {
    try {
      const balance = await adapter.getBalance();
      const maxMargin = balance.total * maxPositionPct / 100;
      const requestedMargin = quantity * executionPrice / Math.max(1, Number(strategy.leverage || 1));
      if (requestedMargin > maxMargin && maxMargin > 0) {
        quantity = maxMargin * Math.max(1, Number(strategy.leverage || 1)) / executionPrice;
      }
    } catch (error: any) {
      return { status: "failed", message: `Kama 彩虹馬丁無法核對最大倉位：${error.message}` };
    }
  }
  const normalized = await normalizeQtyForSymbol(strategy.exchange, strategy.symbol, quantity, "linear");
  if (normalized.rejected) {
    return { status: "rejected", message: `Kama 彩虹馬丁 advanced 下單量無效：${normalized.reason}` };
  }
  const authorization = await authorizeRuntimeModeAction({
    strategy,
    signal: {
      action: opensLong ? "buy" : "sell",
      price: executionPrice,
      barTimestamp: signal.barTimestamp,
      reason: signal.reason,
      requestedQuantity: normalized.qty,
      source: options.source,
      eventKey,
    },
    signalId,
    adapter,
    cycleId,
    legId: existingTarget?.legId ?? options.legId,
  });
  if (!authorization.allowed) {
    return {
      status: authorization.envelope.decision.outcome === "HOLD" ? "skipped" : "rejected",
      message: runtimeModeRejectionMessage(authorization),
    };
  }
  const decision = authorization.envelope.decision;
  const targetLegId = decision.targetLegId;
  const targetRole = decision.targetRole;
  if (!targetLegId || !targetRole || !decision.targetSide) {
    return { status: "rejected", message: "Kama 彩虹馬丁 advanced decision 缺少 leg ownership" };
  }
  if (targetRole === "HEDGE" && !initialAction) {
    return { status: "rejected", message: "Kama 彩虹馬丁 H3 保護腿禁止加倉" };
  }
  const approvedQuantity = decision.approvedQuantity ?? normalized.qty;
  const approvedNormalized = await normalizeQtyForSymbol(strategy.exchange, strategy.symbol, approvedQuantity, "linear");
  if (approvedNormalized.rejected) {
    return { status: "rejected", message: `Kama 彩虹馬丁 advanced approved quantity 無效：${approvedNormalized.reason}` };
  }
  const intentResult = await createIntent({
    strategy,
    signal,
    cycleId,
    legId: targetLegId,
    decisionId: decision.decisionId,
    reasonCode: decision.reasonCode,
    action: existingTarget ? "ADD" : "OPEN",
    side: opensLong ? "BUY" : "SELL",
    positionSide: opensLong ? "LONG" : "SHORT",
    reduceOnly: false,
    quantity: approvedNormalized.qty,
    price: executionPrice,
  });
  if (intentResult.deduplicated) {
    return { status: "skipped", message: `Kama 彩虹馬丁 advanced intent 已存在（${intentResult.intent.status}）` };
  }
  await transitionOrderIntent(intentResult.intent.intentId, "SUBMITTING");
  try {
    await adapter.setLeverage(strategy.symbol, Number(strategy.leverage || 1));
  } catch (error: any) {
    await transitionOrderIntent(intentResult.intent.intentId, "FAILED", { error: `set leverage: ${error.message}` });
    return { status: "failed", message: `Kama 彩虹馬丁設定槓桿失敗：${error.message}` };
  }
  const result = await adapter.placeOrder({
    symbol: strategy.symbol,
    side: opensLong ? "buy" : "sell",
    orderType: "market",
    size: approvedNormalized.qty,
    leverage: Number(strategy.leverage || 1),
    reduceOnly: false,
    posSide: opensLong ? "long" : "short",
  });
  if (!result.success) {
    await transitionOrderIntent(intentResult.intent.intentId, "FAILED", { error: result.errorMessage || "exchange rejected" });
    return { status: "failed", message: result.errorMessage || "Kama 彩虹馬丁 advanced 下單失敗", exchangeResponse: result.rawResponse };
  }
  await transitionOrderIntent(intentResult.intent.intentId, "SUBMITTED", { exchangeOrderId: result.orderId });
  const truth = await resolveExecutionTruth(adapter, strategy.symbol, result, false);
  const filledQuantity = Number(truth.filledSize || 0);
  const filledPrice = Number(truth.filledPrice || 0);
  if (!(filledQuantity > 0) || !(filledPrice > 0)) {
    await transitionOrderIntent(intentResult.intent.intentId, "RECONCILIATION_REQUIRED", { exchangeOrderId: truth.orderId });
    return {
      status: "failed",
      message: "Kama 彩虹馬丁 advanced 成功回應缺少成交價量；ledger 保持不動並等待對賬",
      orderId: truth.orderId,
      exchangeResponse: truth.rawResponse,
    };
  }
  const fillTimestamp = truth.filledAt ?? Date.now();
  await appendFillTruth({ strategy, cycleId, legId: targetLegId, intentId: intentResult.intent.intentId, truth, quantity: filledQuantity, price: filledPrice, fallbackTimestamp: fillTimestamp });
  await transitionOrderIntent(intentResult.intent.intentId, filledQuantity >= approvedNormalized.qty - 1e-12 ? "FILLED" : "PARTIALLY_FILLED", { exchangeOrderId: truth.orderId });

  const baseState = existingTarget
    ? restoreKamaRainbowMartinLegState(existingTarget)
    : createKamaRainbowMartinRuntimeState();
  const fillId = truth.tradeId || truth.orderId || `${eventKey}:${action}:${fillTimestamp}`;
  const nextState = applyKamaRainbowMartinFillToState(baseState, {
    action,
    fillId,
    orderId: truth.orderId,
    fillPrice: filledPrice,
    fillQuantity: filledQuantity,
    timestamp: fillTimestamp,
    targetLayer: initialAction ? 1 : signal.kamaRainbowMartinLayerNum,
    rawConfig: config,
    configRevision: signal.kamaRainbowMartinConfigRevision ?? config.version,
    positionSizeAtOpen: initialAction ? deploymentPosition : undefined,
  });
  if (existingTarget) {
    await updatePositionLegRuntime(targetLegId, {
      quantity: decimal(nextState.totalSize),
      avgEntryPrice: decimal(nextState.avgPrice),
      unrealizedPnl: "0.00000000",
      martinState: nextState,
    });
  } else {
    const created = await createOrGetPositionLeg({
      legId: targetLegId,
      userId: strategy.userId,
      strategyId: strategy.id,
      deploymentKey: strategy.deploymentKey,
      apiKeyId: strategy.apiKeyId,
      cycleId,
      exchange: strategy.exchange,
      symbol: strategy.symbol,
      executionMode: policy.mode,
      side: opensLong ? "LONG" : "SHORT",
      role: targetRole,
      status: "OPEN",
      quantity: decimal(nextState.totalSize),
      avgEntryPrice: decimal(nextState.avgPrice),
      realizedPnl: "0.00000000",
      unrealizedPnl: "0.00000000",
      martinState: nextState,
      riskState: { lastDecisionId: decision.decisionId, reasonCode: decision.reasonCode },
      openedAt: new Date(fillTimestamp),
      closedAt: null,
    });
    if (created.deduplicated) {
      await transitionOrderIntent(intentResult.intent.intentId, "RECONCILIATION_REQUIRED", { error: "leg identity collision after fill" });
      return { status: "failed", message: "Kama 彩虹馬丁成交後發現 leg identity 衝突，已標記待對賬", orderId: truth.orderId };
    }
  }
  if (policy.mode === "HEDGE_GUARDED" && targetRole === "HEDGE") {
    const primaryLegId = String(decision.contextSnapshot.primaryLegId || "");
    if (!primaryLegId) {
      await transitionPositionLeg(targetLegId, "RECONCILIATION_REQUIRED", { riskState: { reason: "H3_PRIMARY_LEG_ID_MISSING" } });
      return { status: "failed", message: "Kama 彩虹馬丁 H3 成交後缺少 primary leg 關聯，已標記待對賬", orderId: truth.orderId };
    }
    await createOrGetHedgeRelationship({
      relationshipId: boundedIdentity(`krm-hedge:${primaryLegId}:${targetLegId}`),
      userId: strategy.userId,
      strategyId: strategy.id,
      cycleId,
      primaryLegId,
      hedgeLegId: targetLegId,
      status: "ACTIVE",
      targetRatio: policy.hedgeRatio.toFixed(6),
      triggerSnapshot: {
        decisionId: decision.decisionId,
        reasonCode: decision.reasonCode,
        primaryLossPct: decision.contextSnapshot.primaryLossPct,
        triggerLossPct: policy.primaryLossTriggerPct,
        hedgeRatio: policy.hedgeRatio,
        hedgeMartinEnabled: false,
      },
      unwindSnapshot: null,
      openedAt: new Date(fillTimestamp),
      closedAt: null,
    });
  }
  if (initialAction && signal.barTimestamp) {
    await acquireBarLock(strategy.id, signal.barTimestamp, TIMEFRAME_MINUTES[config.timeframe] ?? 30);
  }
  await createTrade({
    strategyId: strategy.id,
    userId: strategy.userId,
    signalId,
    exchange: strategy.exchange,
    symbol: strategy.symbol,
    side: opensLong ? "buy" : "sell",
    orderType: "market",
    orderId: truth.orderId,
    ...tradeFillRecordFields(truth, executionPrice, approvedNormalized.qty),
    reduceOnly: false,
    status: "filled",
    triggerSource: toTriggerSource(options.source),
    cycleId,
    legId: targetLegId,
    executionMode: policy.mode,
  });
  return {
    status: "executed",
    message: `Kama 彩虹馬丁 ${policy.mode} ${action} ${targetRole}:${targetLegId} L${nextState.currentLayer} 成交 ${filledQuantity} @ ${filledPrice}`,
    orderId: truth.orderId,
    exchangeResponse: truth.rawResponse,
  };
}
