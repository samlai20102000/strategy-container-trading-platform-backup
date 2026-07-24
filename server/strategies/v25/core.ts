import {
  assertValidV25Config,
  createV25DefaultConfig,
  getV25MartinRangeForLayer,
  type V25StrategyConfig,
} from "../../../shared/strategies/kama3kBreakoutV25";
import {
  createInitialStrategyState,
  type KLineData,
  type StrategyState,
} from "../base";

export type V25CoreAction =
  | "buy"
  | "sell"
  | "close"
  | "add_long"
  | "add_short"
  | "hold";

export type V25CloseReason = "SL" | "TP_TRAILING" | "TP_FIXED" | "OTHER" | null;

export interface V25RuntimeMeta {
  pendingReentry: boolean;
  lastCloseReason: V25CloseReason;
  lastActionBarTimestamp: number;
  lastActionSignature: string;
}

export interface V25RuntimeState extends StrategyState {
  v25Runtime?: V25RuntimeMeta;
}

export interface V25DecisionMetrics {
  kamaFast: number | null;
  kamaSlow: number | null;
  isLongEntry: boolean;
  isShortEntry: boolean;
  profitPct: number | null;
  peakProfitPct: number | null;
  nextMartinLayer: number | null;
}

export interface V25CoreDecision {
  action: V25CoreAction;
  reason: string;
  price: number;
  lotUsdt?: number;
  layerNum?: number;
  closeReason?: Exclude<V25CloseReason, null>;
  nextState: V25RuntimeState;
  metrics: V25DecisionMetrics;
}

export type V25AllowedDirection = "long" | "short" | "both";

const EMPTY_METRICS: V25DecisionMetrics = {
  kamaFast: null,
  kamaSlow: null,
  isLongEntry: false,
  isShortEntry: false,
  profitPct: null,
  peakProfitPct: null,
  nextMartinLayer: null,
};

export function createV25RuntimeMeta(
  seed?: Partial<V25RuntimeMeta>,
): V25RuntimeMeta {
  return {
    pendingReentry: false,
    lastCloseReason: null,
    lastActionBarTimestamp: 0,
    lastActionSignature: "",
    ...seed,
  };
}

export function createV25RuntimeState(
  seed?: Partial<V25RuntimeState>,
): V25RuntimeState {
  const source = seed ?? {};
  return {
    ...createInitialStrategyState(),
    ...source,
    v25Runtime: createV25RuntimeMeta(source.v25Runtime),
  };
}

function cloneV25State(state: StrategyState): V25RuntimeState {
  const source = state as V25RuntimeState;
  return {
    ...source,
    v25Runtime: createV25RuntimeMeta(source.v25Runtime),
  };
}

export function calculateV25Kama(
  closes: readonly number[],
  erPeriod: number,
  fastConst: number,
  slowConst: number,
): Array<number | null> {
  const result: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length <= erPeriod) return result;

  const fastestSC = 2 / (fastConst + 1);
  const slowestSC = 2 / (slowConst + 1);
  let kama = closes[erPeriod - 1];
  result[erPeriod - 1] = kama;

  for (let index = erPeriod; index < closes.length; index += 1) {
    const change = Math.abs(closes[index] - closes[index - erPeriod]);
    let volatility = 0;
    for (let cursor = index - erPeriod + 1; cursor <= index; cursor += 1) {
      volatility += Math.abs(closes[cursor] - closes[cursor - 1]);
    }
    const efficiencyRatio = volatility === 0 ? 1 : change / volatility;
    const smoothing = (
      efficiencyRatio * (fastestSC - slowestSC) + slowestSC
    ) ** 2;
    kama += smoothing * (closes[index] - kama);
    result[index] = kama;
  }

  return result;
}

function holdDecision(
  reason: string,
  price: number,
  nextState: V25RuntimeState,
  metrics: V25DecisionMetrics = EMPTY_METRICS,
): V25CoreDecision {
  return { action: "hold", reason, price, nextState, metrics };
}

function actionDecision(
  decision: Omit<V25CoreDecision, "nextState" | "metrics">,
  nextState: V25RuntimeState,
  metrics: V25DecisionMetrics,
  barTimestamp: number,
): V25CoreDecision {
  const signature = [
    decision.action,
    decision.layerNum ?? 0,
    decision.closeReason ?? "",
  ].join(":");
  const runtime = createV25RuntimeMeta(nextState.v25Runtime);
  if (
    runtime.lastActionBarTimestamp === barTimestamp &&
    runtime.lastActionSignature === signature
  ) {
    return holdDecision(
      `同 K 棒動作已處理：${signature}`,
      decision.price,
      nextState,
      metrics,
    );
  }
  nextState.v25Runtime = createV25RuntimeMeta({
    ...runtime,
    lastActionBarTimestamp: barTimestamp,
    lastActionSignature: signature,
  });
  return { ...decision, nextState, metrics };
}

function getProfitPct(state: StrategyState, currentPrice: number): number {
  if (state.avgPrice <= 0) return 0;
  return state.isLong
    ? ((currentPrice - state.avgPrice) / state.avgPrice) * 100
    : ((state.avgPrice - currentPrice) / state.avgPrice) * 100;
}

function updatePeakState(
  state: V25RuntimeState,
  currentPrice: number,
): number {
  if (state.avgPrice <= 0) return 0;
  if (state.isLong) {
    state.highestPrice = Math.max(state.highestPrice || state.avgPrice, currentPrice);
    return ((state.highestPrice - state.avgPrice) / state.avgPrice) * 100;
  }
  const previousLow = state.lowestPrice > 0 ? state.lowestPrice : state.avgPrice;
  state.lowestPrice = Math.min(previousLow, currentPrice);
  return ((state.avgPrice - state.lowestPrice) / state.avgPrice) * 100;
}

export function evaluateV25Decision(
  candles: readonly KLineData[],
  state: StrategyState,
  rawConfig: unknown = createV25DefaultConfig(),
  allowedDirection: V25AllowedDirection = "both",
): V25CoreDecision {
  const config = assertValidV25Config(rawConfig);
  const nextState = cloneV25State(state);
  const requiredBars = Math.max(
    3,
    config.KAMA_Fast_Length + 1,
    config.KAMA_Slow_Length + 1,
  );
  if (candles.length < requiredBars) {
    return holdDecision(
      `K線數據不足：需要 ${requiredBars} 根，目前 ${candles.length} 根`,
      candles.at(-1)?.close ?? 0,
      nextState,
    );
  }

  const closes = candles.map((candle) => candle.close);
  const currentIndex = candles.length - 1;
  const currentBar = candles[currentIndex];
  const bar1 = candles[currentIndex - 2];
  const bar2 = candles[currentIndex - 1];
  const currentPrice = currentBar.close;

  const kamaFastSeries = calculateV25Kama(
    closes,
    config.KAMA_Fast_Length,
    config.p2_fastest,
    config.p3_slowest,
  );
  const kamaSlowSeries = calculateV25Kama(
    closes,
    config.KAMA_Slow_Length,
    config.q2_fastest,
    config.q3_slowest,
  );
  const kamaFast = kamaFastSeries[currentIndex];
  const kamaSlow = kamaSlowSeries[currentIndex];

  if (kamaFast == null || kamaSlow == null) {
    return holdDecision("KAMA 尚未形成", currentPrice, nextState);
  }

  const isLongEntry =
    allowedDirection !== "short" &&
    kamaFast > kamaSlow &&
    bar1.close > bar1.open &&
    bar2.close > bar2.open &&
    currentBar.high > Math.max(bar1.high, bar2.high);
  const isShortEntry =
    allowedDirection !== "long" &&
    kamaFast < kamaSlow &&
    bar1.close < bar1.open &&
    bar2.close < bar2.open &&
    currentBar.low < Math.min(bar1.low, bar2.low);

  const hasPosition = nextState.currentLayer > 0 && nextState.totalSize > 0;
  const profitPct = hasPosition ? getProfitPct(nextState, currentPrice) : null;
  const peakProfitPct = hasPosition ? updatePeakState(nextState, currentPrice) : null;
  const nextMartinLayer = hasPosition ? nextState.currentLayer : null;
  const metrics: V25DecisionMetrics = {
    kamaFast,
    kamaSlow,
    isLongEntry,
    isShortEntry,
    profitPct,
    peakProfitPct,
    nextMartinLayer,
  };

  if (hasPosition && profitPct != null && peakProfitPct != null) {
    if (
      config.Hard_Stop_Loss_Pct > 0 &&
      profitPct <= -config.Hard_Stop_Loss_Pct
    ) {
      return actionDecision(
        {
          action: "close",
          reason: `硬止損平倉：名義價格虧損 ${profitPct.toFixed(2)}% ≤ -${config.Hard_Stop_Loss_Pct}%`,
          price: currentPrice,
          closeReason: "SL",
        },
        nextState,
        metrics,
        currentBar.timestamp,
      );
    }

    if (
      config.Trailing_TP_Enabled &&
      peakProfitPct >= config.Trailing_Activation_Pct &&
      peakProfitPct - profitPct >= config.Trailing_Callback_Pct
    ) {
      return actionDecision(
        {
          action: "close",
          reason: `追蹤止盈平倉：峰值 ${peakProfitPct.toFixed(2)}%，回撤 ${(peakProfitPct - profitPct).toFixed(2)}%`,
          price: currentPrice,
          closeReason: "TP_TRAILING",
        },
        nextState,
        metrics,
        currentBar.timestamp,
      );
    }

    if (
      config.Take_Profit_Pct > 0 &&
      profitPct >= config.Take_Profit_Pct
    ) {
      return actionDecision(
        {
          action: "close",
          reason: `固定止盈平倉：名義價格盈利 ${profitPct.toFixed(2)}% ≥ ${config.Take_Profit_Pct}%`,
          price: currentPrice,
          closeReason: "TP_FIXED",
        },
        nextState,
        metrics,
        currentBar.timestamp,
      );
    }

    if (config.Martin_Enabled && nextMartinLayer != null) {
      const range = getV25MartinRangeForLayer(config.Martin_Ranges, nextMartinLayer);
      const referencePrice = nextState.lastLayerPrice > 0
        ? nextState.lastLayerPrice
        : nextState.avgPrice;
      if (range && referencePrice > 0) {
        const triggered = nextState.isLong
          ? currentPrice <= referencePrice * (1 - range.gap / 100)
          : currentPrice >= referencePrice * (1 + range.gap / 100);
        if (triggered) {
          return actionDecision(
            {
              action: nextState.isLong ? "add_long" : "add_short",
              reason: `馬丁加倉 L${nextMartinLayer}（範圍 ${range.start}–${range.end}，偏離 ${range.gap}%）`,
              price: currentPrice,
              lotUsdt: config.Base_Lot_Size * range.multiplier,
              layerNum: nextMartinLayer,
            },
            nextState,
            metrics,
            currentBar.timestamp,
          );
        }
      }
    }

    return holdDecision(
      `持倉中：L${Math.max(0, nextState.currentLayer - 1)}，浮盈 ${profitPct.toFixed(2)}%`,
      currentPrice,
      nextState,
      metrics,
    );
  }

  const runtime = createV25RuntimeMeta(nextState.v25Runtime);
  const canReenter =
    config.Reentry_On_Trend &&
    runtime.pendingReentry &&
    (runtime.lastCloseReason === "TP_FIXED" || runtime.lastCloseReason === "TP_TRAILING");

  if (canReenter) {
    if (isLongEntry || isShortEntry) {
      return actionDecision(
        {
          action: isLongEntry ? "buy" : "sell",
          reason: `原地重入：${isLongEntry ? "多頭" : "空頭"}三K突破條件仍成立`,
          price: currentPrice,
          lotUsdt: config.Base_Lot_Size,
        },
        nextState,
        metrics,
        currentBar.timestamp,
      );
    }
    nextState.v25Runtime = createV25RuntimeMeta({
      ...runtime,
      pendingReentry: false,
      lastCloseReason: null,
    });
  }

  if (isLongEntry || isShortEntry) {
    return actionDecision(
      {
        action: isLongEntry ? "buy" : "sell",
        reason: isLongEntry
          ? "三K實時突破（含影線）＋KAMA 多頭排列"
          : "三K實時跌破（含影線）＋KAMA 空頭排列",
        price: currentPrice,
        lotUsdt: config.Base_Lot_Size,
      },
      nextState,
      metrics,
      currentBar.timestamp,
    );
  }

  return holdDecision("無 V2.5 入場、出場或加倉條件", currentPrice, nextState, metrics);
}

export function applyV25FillToState(
  state: StrategyState,
  action: "buy" | "sell" | "add_long" | "add_short",
  fillPrice: number,
  fillQuantity: number,
  barTimestamp: number,
): V25RuntimeState {
  if (!(fillPrice > 0) || !(fillQuantity > 0)) {
    throw new Error("V2.5 成交價格與數量必須大於 0");
  }

  const nextState = cloneV25State(state);
  const isInitial = action === "buy" || action === "sell";
  const isLong = action === "buy" || action === "add_long";
  if (isInitial) {
    nextState.currentLayer = 1;
    nextState.totalSize = fillQuantity;
    nextState.totalCost = fillPrice * fillQuantity;
    nextState.avgPrice = fillPrice;
    nextState.lastLayerPrice = fillPrice;
    nextState.highestPrice = fillPrice;
    nextState.lowestPrice = fillPrice;
    nextState.isLong = isLong;
    nextState.isTrailingActivated = false;
  } else {
    if (nextState.totalSize <= 0 || nextState.currentLayer <= 0) {
      throw new Error("V2.5 無底倉時不可套用馬丁加倉成交");
    }
    if (nextState.isLong !== isLong) {
      throw new Error("V2.5 加倉方向與既有持倉不一致");
    }
    const addedCost = fillPrice * fillQuantity;
    nextState.totalCost += addedCost;
    nextState.totalSize += fillQuantity;
    nextState.avgPrice = nextState.totalCost / nextState.totalSize;
    nextState.lastLayerPrice = fillPrice;
    nextState.currentLayer += 1;
  }
  nextState.lockedBarTimestamp = barTimestamp;
  nextState.v25Runtime = createV25RuntimeMeta({
    ...nextState.v25Runtime,
    pendingReentry: false,
    lastCloseReason: null,
    lastActionBarTimestamp: barTimestamp,
    lastActionSignature: action,
  });
  return nextState;
}

export function applyV25CloseToState(
  state: StrategyState,
  closeReason: Exclude<V25CloseReason, null>,
  reentryEnabled: boolean,
  barTimestamp: number,
): V25RuntimeState {
  const pendingReentry =
    reentryEnabled && (closeReason === "TP_FIXED" || closeReason === "TP_TRAILING");
  return createV25RuntimeState({
    capital: state.capital,
    lockedBarTimestamp: barTimestamp,
    v25Runtime: {
      pendingReentry,
      lastCloseReason: closeReason,
      lastActionBarTimestamp: barTimestamp,
      lastActionSignature: `close:${closeReason}`,
    },
  });
}
