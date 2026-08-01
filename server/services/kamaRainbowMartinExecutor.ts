import type { Strategy } from "../../drizzle/schema";
import {
  KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY,
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  validateKamaRainbowMartinConfig,
} from "../../shared/strategies/kamaRainbowMartin";
import { normalizeExecutionModePolicy } from "../../shared/executionModes";
import type { ExchangeAdapter, OrderResult } from "../exchanges/types";
import {
  approvedEmergencyReasonFromCloseReason,
  orderPolicyFields,
} from "../exchanges/orderPolicyIntent";
import {
  applyKamaRainbowMartinCloseToState,
  applyKamaRainbowMartinFillToState,
  applyKamaRainbowMartinPartialCloseToState,
  type KamaRainbowMartinCloseReason,
} from "../strategies/kamaRainbowMartin/management";
import type { KamaRainbowMartinPositionSize } from "../strategies/kamaRainbowMartin/core";
import { listEnabledStrategies } from "../db";
import { acquireBarLock, releaseAllLocks } from "./barLock";
import { resolveDeploymentPosition } from "./deploymentPosition";
import { fetchKamaRainbowMartinFreshQuote } from "./kamaRainbowMartinMarketData";
import { executeKamaRainbowMartinAdvancedSignal } from "./kamaRainbowMartinAdvancedExecutor";
import { loadStrategyState, saveStrategyState } from "./strategyStateManager";
import { getBoundStrategyConfig } from "./strategySnapshotConfig";
import { normalizeQtyForSymbol } from "./symbolSpecs";
import { tradeFillRecordFields } from "./tradeFillTruth";
import { recordExistingTradeExecution as createTrade } from "./tradeExecutionLedger";

export interface KamaRainbowMartinSealedSignal {
  action: "buy" | "sell" | "close";
  price?: number;
  barTimestamp?: number;
  reason?: string;
  kamaRainbowMartinDecision?: boolean;
  kamaRainbowMartinAction?: "OPEN_LONG" | "OPEN_SHORT" | "ADD_LONG" | "ADD_SHORT" | "CLOSE";
  kamaRainbowMartinReasonCode?: string;
  kamaRainbowMartinEventKey?: string;
  kamaRainbowMartinLayerNum?: number;
  kamaRainbowMartinOrderSize?: KamaRainbowMartinPositionSize;
  kamaRainbowMartinCloseReason?: KamaRainbowMartinCloseReason;
  kamaRainbowMartinConfigRevision?: string;
  kamaRainbowMartinExecutionMode?: "SINGLE_EXCLUSIVE" | "MULTI_POSITION" | "HEDGE_GUARDED";
}

export interface KamaRainbowMartinExecutionOptions {
  source?: "WEBHOOK" | "AUTO" | "MANUAL" | "RISK" | "RECONCILIATION";
  eventKey?: string;
  cycleId?: string | null;
  legId?: string | null;
}

export interface KamaRainbowMartinExecutionResult {
  status: "executed" | "failed" | "rejected" | "skipped";
  message: string;
  orderId?: string;
  exchangeResponse?: string;
}

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

export async function executeKamaRainbowMartinSignal(
  strategy: Strategy,
  signal: KamaRainbowMartinSealedSignal,
  signalId: number,
  adapter: ExchangeAdapter,
  options: KamaRainbowMartinExecutionOptions,
): Promise<KamaRainbowMartinExecutionResult> {
  if (signal.kamaRainbowMartinDecision !== true || !signal.kamaRainbowMartinAction) {
    return { status: "rejected", message: "Kama 彩虹馬丁拒絕未經伺服器封印的訊號" };
  }

  const state = loadStrategyState(strategy);
  const stateRecord = state as unknown as Record<string, unknown>;
  const rawConfig = getBoundStrategyConfig(stateRecord, KAMA_RAINBOW_MARTIN_STRATEGY_KEY)
    ?? stateRecord[KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY]
    ?? {};
  const validation = validateKamaRainbowMartinConfig(rawConfig);
  if (!validation.valid) {
    return {
      status: "rejected",
      message: `Kama 彩虹馬丁配置無效：${validation.issues.map(issue => `${issue.path} ${issue.message}`).join("；")}`,
    };
  }

  const config = validation.config;
  const policy = normalizeExecutionModePolicy(
    strategy.executionPolicy ?? { mode: strategy.executionMode || "SINGLE_EXCLUSIVE" },
  );
  if (policy.mode !== "SINGLE_EXCLUSIVE") {
    return executeKamaRainbowMartinAdvancedSignal({
      strategy,
      signal,
      signalId,
      adapter,
      options,
      config,
    });
  }
  const action = signal.kamaRainbowMartinAction;
  const active = state.currentLayer > 0 && state.totalSize > 0 && state.avgPrice > 0;
  const triggerSource = toTriggerSource(options.source);

  if (action === "CLOSE") {
    if (!active) return { status: "skipped", message: "Kama 彩虹馬丁目標腿無持倉，無需平倉" };
    const posSide = state.isLong ? "long" : "short";
    let exchangePosition;
    try {
      const positions = await adapter.getPositions(strategy.symbol);
      exchangePosition = positions.find(position => position.side === posSide && position.size > 0);
    } catch (error: any) {
      return { status: "failed", message: `Kama 彩虹馬丁無法驗證交易所腿級持倉：${error.message}` };
    }
    if (!exchangePosition) {
      return { status: "rejected", message: `Kama 彩虹馬丁找不到可證明擁有的 ${posSide} 腿，拒絕聚合平倉` };
    }
    if (state.totalSize > exchangePosition.size + Math.max(1e-12, exchangePosition.size * 1e-8)) {
      return {
        status: "rejected",
        message: `Kama 彩虹馬丁本地腿數量 ${state.totalSize} 大於交易所 ${exchangePosition.size}，需先對賬`,
      };
    }
    const normalized = await normalizeQtyForSymbol(strategy.exchange, strategy.symbol, state.totalSize, "linear");
    if (normalized.rejected) {
      return { status: "rejected", message: `Kama 彩虹馬丁腿級平倉量無效：${normalized.reason}` };
    }
    const requestedQuantity = Math.min(normalized.qty, exchangePosition.size);
    const closeReason = signal.kamaRainbowMartinCloseReason ?? "OTHER";
    const emergencyReason = approvedEmergencyReasonFromCloseReason(closeReason);
    const result = await adapter.placeOrder({
      symbol: strategy.symbol,
      side: state.isLong ? "sell" : "buy",
      orderType: "market",
      size: requestedQuantity,
      reduceOnly: true,
      posSide,
      clientOrderId: `clOrdId_KRM_CLOSE_${strategy.id}_${posSide}_${Date.now()}`,
      ...orderPolicyFields({
        strategyId: strategy.id,
        signalId,
        source: options.source,
        reasonCode: signal.kamaRainbowMartinReasonCode ?? closeReason,
      }, emergencyReason),
    });
    if (!result.success) {
      return { status: "failed", message: result.errorMessage || "Kama 彩虹馬丁腿級平倉失敗", exchangeResponse: result.rawResponse };
    }
    const truth = await resolveExecutionTruth(adapter, strategy.symbol, result, true);
    const filledQuantity = Number(truth.filledSize || 0);
    if (!(filledQuantity > 0)) {
      return {
        status: "failed",
        message: "Kama 彩虹馬丁平倉成功回應缺少成交數量；狀態保持不動並等待對賬",
        orderId: truth.orderId,
        exchangeResponse: truth.rawResponse,
      };
    }
    const nextState = filledQuantity >= state.totalSize - 1e-12
      ? applyKamaRainbowMartinCloseToState(state, closeReason, truth.filledAt ?? Date.now())
      : applyKamaRainbowMartinPartialCloseToState(state, filledQuantity, closeReason, truth.filledAt ?? Date.now());
    await saveStrategyState(strategy.id, nextState);
    if (!(nextState.totalSize > 0)) await releaseAllLocks(strategy.id);
    await createTrade({
      strategyId: strategy.id,
      userId: strategy.userId,
      signalId,
      exchange: strategy.exchange,
      symbol: strategy.symbol,
      side: state.isLong ? "sell" : "buy",
      orderType: "market",
      orderId: truth.orderId,
      ...tradeFillRecordFields(truth, signal.price, requestedQuantity),
      reduceOnly: true,
      status: "filled",
      triggerSource,
    });
    return {
      status: "executed",
      message: `Kama 彩虹馬丁精確平倉 ${filledQuantity} [${signal.kamaRainbowMartinReasonCode ?? closeReason}]`,
      orderId: truth.orderId,
      exchangeResponse: truth.rawResponse,
    };
  }

  const opensLong = action === "OPEN_LONG" || action === "ADD_LONG";
  const initialAction = action === "OPEN_LONG" || action === "OPEN_SHORT";
  if (initialAction && active) return { status: "rejected", message: "Kama 彩虹馬丁已有腿級持倉，拒絕重複底倉" };
  if (!initialAction && !active) return { status: "rejected", message: "Kama 彩虹馬丁無底倉，拒絕跳層加倉" };
  if (!initialAction && state.isLong !== opensLong) return { status: "rejected", message: "Kama 彩虹馬丁加倉方向與現有腿不一致" };
  if (!initialAction && signal.kamaRainbowMartinLayerNum !== state.currentLayer + 1) {
    return { status: "rejected", message: "Kama 彩虹馬丁加倉層級不連續" };
  }

  if (initialAction) {
    const enabled = await listEnabledStrategies();
    const conflict = enabled.find(candidate => {
      if (candidate.id === strategy.id || candidate.apiKeyId !== strategy.apiKeyId || candidate.symbol !== strategy.symbol) return false;
      const candidateState = loadStrategyState(candidate);
      return candidateState.currentLayer > 0 && candidateState.totalSize > 0;
    });
    if (conflict) {
      return { status: "rejected", message: `Kama 彩虹馬丁 S1 單腿排他：策略 #${conflict.id} 已持有同帳戶／同商品曝險` };
    }
    try {
      const positions = await adapter.getPositions(strategy.symbol);
      if (positions.some(position => position.size > 0)) {
        return { status: "rejected", message: "Kama 彩虹馬丁 S1 發現交易所既有持倉，禁止建立無法證明歸屬的新底倉" };
      }
    } catch (error: any) {
      return { status: "failed", message: `Kama 彩虹馬丁無法執行 S1 持倉排他檢查：${error.message}` };
    }
  }

  let quote;
  try {
    quote = await fetchKamaRainbowMartinFreshQuote(strategy.exchange, strategy.symbol);
  } catch (error: any) {
    return { status: "failed", message: `Kama 彩虹馬丁 fresh quote 取得失敗：${error.message}` };
  }
  const executionPrice = opensLong ? quote.ask : quote.bid;
  const deploymentPosition = resolveDeploymentPosition(strategy, { value: 0.01, mode: "quantity" });
  const requestedPosition = initialAction ? deploymentPosition : signal.kamaRainbowMartinOrderSize;
  if (!requestedPosition || !(requestedPosition.value > 0)) {
    return { status: "rejected", message: "Kama 彩虹馬丁缺少有效腿級下單數量" };
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
    return { status: "rejected", message: `Kama 彩虹馬丁下單量無效：${normalized.reason}` };
  }
  try {
    await adapter.setLeverage(strategy.symbol, Number(strategy.leverage || 1));
  } catch (error: any) {
    return { status: "failed", message: `Kama 彩虹馬丁設定槓桿失敗：${error.message}` };
  }
  const result = await adapter.placeOrder({
    symbol: strategy.symbol,
    side: opensLong ? "buy" : "sell",
    orderType: "market",
    size: normalized.qty,
    leverage: Number(strategy.leverage || 1),
    reduceOnly: false,
    posSide: opensLong ? "long" : "short",
    clientOrderId: `clOrdId_KRM_${strategy.id}_${action}_${Date.now()}`,
    ...orderPolicyFields({
      strategyId: strategy.id,
      signalId,
      source: options.source,
      reasonCode: signal.kamaRainbowMartinReasonCode ?? action,
    }),
  });
  if (!result.success) {
    return { status: "failed", message: result.errorMessage || "Kama 彩虹馬丁下單失敗", exchangeResponse: result.rawResponse };
  }
  const truth = await resolveExecutionTruth(adapter, strategy.symbol, result, false);
  const filledQuantity = Number(truth.filledSize || 0);
  const filledPrice = Number(truth.filledPrice || 0);
  if (!(filledQuantity > 0) || !(filledPrice > 0)) {
    return {
      status: "failed",
      message: "Kama 彩虹馬丁成功回應缺少成交價量；狀態保持不動並等待對賬",
      orderId: truth.orderId,
      exchangeResponse: truth.rawResponse,
    };
  }
  const fillTimestamp = truth.filledAt ?? Date.now();
  const fillId = truth.tradeId || truth.orderId || `${signal.kamaRainbowMartinEventKey ?? "event"}:${action}:${fillTimestamp}`;
  const nextState = applyKamaRainbowMartinFillToState(state, {
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
  await saveStrategyState(strategy.id, nextState);
  if (initialAction && signal.barTimestamp) {
    await acquireBarLock(
      strategy.id,
      signal.barTimestamp,
      TIMEFRAME_MINUTES[config.timeframe] ?? 30,
    );
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
    ...tradeFillRecordFields(truth, executionPrice, normalized.qty),
    reduceOnly: false,
    status: "filled",
    triggerSource,
  });
  return {
    status: "executed",
    message: `Kama 彩虹馬丁 ${action} L${nextState.currentLayer} 成交 ${filledQuantity} @ ${filledPrice}`,
    orderId: truth.orderId,
    exchangeResponse: truth.rawResponse,
  };
}
