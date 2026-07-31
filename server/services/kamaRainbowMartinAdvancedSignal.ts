import type { PositionLeg, Strategy } from "../../drizzle/schema";
import { normalizeExecutionModePolicy } from "../../shared/executionModes";
import {
  getKamaRainbowMartinMinimumHistoryBars,
  type KamaRainbowMartinConfig,
} from "../../shared/strategies/kamaRainbowMartin";
import type { ParsedSignal } from "./executor";
import {
  createKamaRainbowMartinRuntimeState,
  evaluateKamaRainbowMartinEntry,
  type KamaRainbowMartinRuntimeState,
} from "../strategies/kamaRainbowMartin/core";
import { evaluateKamaRainbowMartinManagement } from "../strategies/kamaRainbowMartin/management";
import {
  fetchKamaRainbowMartinClosedCandles,
  fetchKamaRainbowMartinFreshQuote,
} from "./kamaRainbowMartinMarketData";
import { restoreKamaRainbowMartinLegState } from "./kamaRainbowMartinLegState";
import { saveStrategyState } from "./strategyStateManager";
import { listActivePositionLegs, updatePositionLegRuntime } from "./threeModeLedger";

type AdvancedMode = "MULTI_POSITION" | "HEDGE_GUARDED";
type HoldReason =
  | { type: "no_data"; detail: string }
  | { type: "strategy_hold"; detail: string };

export type KamaRainbowMartinAdvancedSignalResult =
  | { signal: ParsedSignal; holdReason: null }
  | { signal: null; holdReason: HoldReason };

interface AdvancedSignalInput {
  strategy: Strategy;
  config: KamaRainbowMartinConfig;
  globalState: KamaRainbowMartinRuntimeState;
  mode: AdvancedMode;
}

interface LegCandidate {
  leg: PositionLeg;
  action: "ADD_LONG" | "ADD_SHORT" | "CLOSE" | "HOLD";
  reason: string;
  reasonCode: string;
  price: number;
  eventKey: string;
  layerNum?: number;
  orderSize?: { mode: "quantity" | "usdt"; value: number };
  closeReason?: "HARD_STOP" | "TRAILING_TAKE_PROFIT" | "KILL" | "MANUAL" | "OTHER";
}

function managementAction(action: "add_long" | "add_short" | "close" | "hold"): LegCandidate["action"] {
  if (action === "add_long") return "ADD_LONG";
  if (action === "add_short") return "ADD_SHORT";
  if (action === "close") return "CLOSE";
  return "HOLD";
}

function sealedSignal(input: {
  strategy: Strategy;
  config: KamaRainbowMartinConfig;
  mode: AdvancedMode;
  action: Exclude<LegCandidate["action"], "HOLD"> | "OPEN_LONG" | "OPEN_SHORT";
  reason: string;
  reasonCode: string;
  price: number;
  eventKey: string;
  cycleId: string;
  legId?: string;
  barTimestamp?: number;
  layerNum?: number;
  orderSize?: { mode: "quantity" | "usdt"; value: number };
  closeReason?: LegCandidate["closeReason"];
}): ParsedSignal {
  return {
    action: input.action === "CLOSE"
      ? "close"
      : input.action === "OPEN_LONG" || input.action === "ADD_LONG"
        ? "buy"
        : "sell",
    symbol: input.strategy.symbol,
    price: input.price,
    barTimestamp: input.barTimestamp,
    reason: input.reason,
    confidence: 1,
    kamaRainbowMartinDecision: true,
    kamaRainbowMartinAction: input.action,
    kamaRainbowMartinReasonCode: input.reasonCode,
    kamaRainbowMartinEventKey: input.eventKey,
    kamaRainbowMartinLayerNum: input.layerNum,
    kamaRainbowMartinOrderSize: input.orderSize,
    kamaRainbowMartinCloseReason: input.closeReason,
    kamaRainbowMartinConfigRevision: input.config.version,
    kamaRainbowMartinExecutionMode: input.mode,
    kamaRainbowMartinCycleId: input.cycleId,
    kamaRainbowMartinLegId: input.legId,
  };
}

async function evaluateLegs(input: AdvancedSignalInput, legs: PositionLeg[]): Promise<LegCandidate[]> {
  if (legs.length === 0) return [];
  const quote = await fetchKamaRainbowMartinFreshQuote(
    input.strategy.exchange as "okx" | "bybit",
    input.strategy.symbol,
  );
  const candidates: LegCandidate[] = [];
  for (const leg of legs) {
    const price = leg.side === "LONG" ? quote.bid : quote.ask;
    const quantity = Number(leg.quantity);
    const avgPrice = Number(leg.avgEntryPrice);
    const unrealizedPnl = (leg.side === "LONG" ? 1 : -1) * (price - avgPrice) * quantity;
    const eventKey = `${quote.exchange}:${quote.symbol}:risk:${quote.capturedAt}:${leg.legId}:${price}`;
    const decision = evaluateKamaRainbowMartinManagement(
      { currentPrice: price, now: quote.capturedAt, riskEventKey: eventKey },
      restoreKamaRainbowMartinLegState(leg),
      input.config,
    );
    await updatePositionLegRuntime(leg.legId, {
      unrealizedPnl: unrealizedPnl.toFixed(8),
      martinState: decision.nextState,
      riskState: {
        markPrice: price,
        unrealizedPnl,
        observedAt: quote.capturedAt,
        reasonCode: decision.reasonCode,
      },
    });
    candidates.push({
      leg,
      action: managementAction(decision.action),
      reason: decision.reason,
      reasonCode: decision.reasonCode,
      price,
      eventKey,
      layerNum: decision.layerNum,
      orderSize: decision.orderSize,
      closeReason: decision.closeReason,
    });
  }
  return candidates;
}

function selectManagementCandidate(mode: AdvancedMode, candidates: LegCandidate[]): LegCandidate | null {
  const closes = candidates
    .filter(candidate => candidate.action === "CLOSE")
    .sort((left, right) => Number(right.leg.role === "HEDGE") - Number(left.leg.role === "HEDGE"));
  const primaryClose = closes.find(candidate => candidate.leg.role === "PRIMARY");
  const activeHedge = candidates.find(candidate => candidate.leg.role === "HEDGE");
  if (mode === "HEDGE_GUARDED" && primaryClose && activeHedge) {
    return {
      ...activeHedge,
      action: "CLOSE",
      reason: `主腿觸發 ${primaryClose.reasonCode} 前先解除 H3 保護腿`,
      reasonCode: "KRM_H3_UNWIND_HEDGE_FIRST",
      eventKey: `${primaryClose.eventKey}:unwind:${activeHedge.leg.legId}`,
      closeReason: "OTHER",
    };
  }
  return closes[0]
    ?? candidates.find(candidate => candidate.action !== "HOLD" && candidate.leg.role !== "HEDGE")
    ?? null;
}

function selectH3ProtectionCandidate(
  input: AdvancedSignalInput,
  candidates: LegCandidate[],
): ParsedSignal | null {
  if (input.mode !== "HEDGE_GUARDED") return null;
  const policy = normalizeExecutionModePolicy(
    input.strategy.executionPolicy ?? { mode: input.strategy.executionMode || "SINGLE_EXCLUSIVE" },
  );
  if (policy.mode !== "HEDGE_GUARDED") return null;
  if (candidates.some(candidate => candidate.leg.role === "HEDGE")) return null;
  const primary = candidates.find(candidate => candidate.leg.role === "PRIMARY");
  if (!primary) return null;
  const avgPrice = Number(primary.leg.avgEntryPrice);
  if (!(avgPrice > 0) || !(primary.price > 0)) return null;
  const primaryLossPct = primary.leg.side === "LONG"
    ? (primary.price - avgPrice) / avgPrice * 100
    : (avgPrice - primary.price) / avgPrice * 100;
  if (!Number.isFinite(primaryLossPct) || primaryLossPct > -policy.primaryLossTriggerPct) return null;
  return sealedSignal({
    strategy: input.strategy,
    config: input.config,
    mode: input.mode,
    action: primary.leg.side === "LONG" ? "OPEN_SHORT" : "OPEN_LONG",
    reason: `H3 主腿 ${primary.leg.legId} 未實現損益 ${primaryLossPct.toFixed(4)}%，達 ${policy.primaryLossTriggerPct}% 保護門檻`,
    reasonCode: "KRM_H3_PROTECTION_TRIGGER",
    price: primary.price,
    eventKey: `${primary.eventKey}:h3-protection:${policy.primaryLossTriggerPct}`,
    cycleId: primary.leg.cycleId,
  });
}

export async function generateKamaRainbowMartinAdvancedSignal(
  input: AdvancedSignalInput,
): Promise<KamaRainbowMartinAdvancedSignalResult> {
  const activeLegs = await listActivePositionLegs({
    userId: input.strategy.userId,
    strategyId: input.strategy.id,
  });
  if (
    input.mode === "HEDGE_GUARDED"
    && activeLegs.some(leg => leg.role === "HEDGE")
    && !activeLegs.some(leg => leg.role === "PRIMARY")
  ) {
    return {
      signal: null,
      holdReason: {
        type: "strategy_hold",
        detail: "Kama 彩虹馬丁 H3 偵測到 orphan hedge，禁止新增曝險並等待 reconciliation",
      },
    };
  }

  let candidates: LegCandidate[];
  try {
    candidates = await evaluateLegs(input, activeLegs);
  } catch (error: any) {
    return {
      signal: null,
      holdReason: {
        type: "no_data",
        detail: `Kama 彩虹馬丁 advanced fresh quote 或腿級狀態更新失敗，禁止新增曝險：${error.message}`,
      },
    };
  }
  const selected = selectManagementCandidate(input.mode, candidates);
  if (selected?.action === "CLOSE") {
    return {
      signal: sealedSignal({
        strategy: input.strategy,
        config: input.config,
        mode: input.mode,
        action: selected.action,
        reason: selected.reason,
        reasonCode: selected.reasonCode,
        price: selected.price,
        eventKey: selected.eventKey,
        cycleId: selected.leg.cycleId,
        legId: selected.leg.legId,
        layerNum: selected.layerNum,
        orderSize: selected.orderSize,
        closeReason: selected.closeReason,
      }),
      holdReason: null,
    };
  }

  const protectionSignal = selectH3ProtectionCandidate(input, candidates);
  if (protectionSignal) return { signal: protectionSignal, holdReason: null };

  if (selected && selected.action !== "HOLD") {
    return {
      signal: sealedSignal({
        strategy: input.strategy,
        config: input.config,
        mode: input.mode,
        action: selected.action,
        reason: selected.reason,
        reasonCode: selected.reasonCode,
        price: selected.price,
        eventKey: selected.eventKey,
        cycleId: selected.leg.cycleId,
        legId: selected.leg.legId,
        layerNum: selected.layerNum,
        orderSize: selected.orderSize,
        closeReason: selected.closeReason,
      }),
      holdReason: null,
    };
  }

  const minimumBars = getKamaRainbowMartinMinimumHistoryBars(input.config);
  const batch = await fetchKamaRainbowMartinClosedCandles(
    input.strategy.exchange as "okx" | "bybit",
    input.strategy.symbol,
    input.config.timeframe,
    Math.min(1_000, Math.max(minimumBars, minimumBars + 5)),
  );
  if (batch.candles.length === 0 || !batch.lastClosedBarIdentity) {
    return {
      signal: null,
      holdReason: {
        type: "no_data",
        detail: `Kama 彩虹馬丁無法取得 ${input.strategy.symbol} ${input.config.timeframe} 已收盤 K 線`,
      },
    };
  }
  const scanState = createKamaRainbowMartinRuntimeState({
    kamaRainbowMartinRuntime: input.globalState.kamaRainbowMartinRuntime,
  });
  const entry = evaluateKamaRainbowMartinEntry({
    candles: batch.candles,
    state: scanState,
    rawConfig: input.config,
    allowedDirection: input.strategy.direction as "long" | "short" | "both",
    lastBarClosed: true,
    configRevision: input.config.version,
  });
  await saveStrategyState(input.strategy.id, entry.nextState);
  const entrySide = entry.action === "OPEN_LONG" ? "LONG" : entry.action === "OPEN_SHORT" ? "SHORT" : null;
  const sameSideLeg = entrySide ? activeLegs.find(leg => leg.side === entrySide) : null;
  if (!entrySide || sameSideLeg) {
    const reasonCode = sameSideLeg ? "KRM_ADVANCED_SIDE_ALREADY_OPEN" : entry.reasonCode;
    const reason = sameSideLeg
      ? `同方向 ${sameSideLeg.legId} 已存在；收線掃描不得把 OPEN 偽裝為馬丁加倉`
      : entry.reason;
    return {
      signal: null,
      holdReason: {
        type: "strategy_hold",
        detail: `Kama 彩虹馬丁觀望 [${reasonCode}]：${reason}`,
      },
    };
  }

  return {
    signal: sealedSignal({
      strategy: input.strategy,
      config: input.config,
      mode: input.mode,
      action: entry.action as "OPEN_LONG" | "OPEN_SHORT",
      reason: entry.reason,
      reasonCode: entry.reasonCode,
      price: entry.price,
      eventKey: batch.lastClosedBarIdentity,
      cycleId: activeLegs[0]?.cycleId ?? `krm:${input.strategy.id}:${entry.barTimestamp || Date.now()}`,
      barTimestamp: entry.barTimestamp,
    }),
    holdReason: null,
  };
}
