import {
  RAINBOW_TREND_LADDER_CONFIG_VERSION,
  RAINBOW_TREND_LADDER_LINE_IDS,
  assertValidRainbowTrendLadderConfig,
  createRainbowTrendLadderDefaultConfig,
  type RainbowTrendLadderBaseLot,
  type RainbowTrendLadderConfig,
  type RainbowTrendLadderLineConfig,
  type RainbowTrendLadderLineId,
} from "../../../shared/strategies/rainbowTrendLadder";
import {
  createInitialStrategyState,
  type KLineData,
  type StrategyState,
} from "../base";

export type RainbowTrendLadderAllowedDirection = "long" | "short" | "both";
export type RainbowTrendLadderTrendDirection = "UP" | "DOWN" | "MIXED" | "INSUFFICIENT";
export type RainbowTrendLadderCoreAction = "buy" | "sell" | "add_long" | "add_short" | "close" | "hold";
export type RainbowTrendLadderCloseReason =
  | "TRAILING_TAKE_PROFIT"
  | "TREND_REVERSAL"
  | "MARGIN_LIMIT"
  | "KILL"
  | "MANUAL"
  | "OTHER";

export interface RainbowTrendLadderLineSnapshot {
  current: Partial<Record<RainbowTrendLadderLineId, number>>;
  previous: Partial<Record<RainbowTrendLadderLineId, number>>;
  slopes: Partial<Record<RainbowTrendLadderLineId, number>>;
  trendDirection: RainbowTrendLadderTrendDirection;
  longArrangement: boolean;
  shortArrangement: boolean;
  longTriggerCross: boolean;
  shortTriggerCross: boolean;
  longPriceRelativeToL1: boolean;
  shortPriceRelativeToL1: boolean;
  triggerInsideVolatilityBand: boolean;
  ready: boolean;
  requiredBars: number;
  availableBars: number;
  barTimestamp: number;
}

export interface RainbowTrendLadderRuntimeMeta {
  configVersion: typeof RAINBOW_TREND_LADDER_CONFIG_VERSION;
  blindMode: boolean;
  killed: boolean;
  killRequestedAt: number;
  entryTimestamp: number;
  initialEntryPrice: number;
  entryAccountEquity: number;
  highestProfitPct: number;
  trailingActive: boolean;
  lastScanBarTimestamp: number;
  nextEntryBarTimestamp: number;
  lastManagedAt: number;
  lastActionTimestamp: number;
  lastActionSignature: string;
  lastDecisionReason: string;
  lastCloseReason: RainbowTrendLadderCloseReason | null;
  trendDirection: RainbowTrendLadderTrendDirection;
  currentLineValues: Partial<Record<RainbowTrendLadderLineId, number>>;
  previousLineValues: Partial<Record<RainbowTrendLadderLineId, number>>;
  lineSlopes: Partial<Record<RainbowTrendLadderLineId, number>>;
}

export interface RainbowTrendLadderRuntimeState extends StrategyState {
  rainbowTrendLadderRuntime?: RainbowTrendLadderRuntimeMeta;
}

export interface RainbowTrendLadderEntryInput {
  candles: readonly KLineData[];
  state: StrategyState;
  rawConfig?: unknown;
  allowedDirection?: RainbowTrendLadderAllowedDirection;
  /** 交易所實際 bid/ask 點差換算後的點數；缺失時實盤應 fail-closed。 */
  spreadPoints?: number | null;
}

export interface RainbowTrendLadderEntryMetrics {
  mode: "SCAN";
  lines: RainbowTrendLadderLineSnapshot;
  spreadPoints: number | null;
  maxSpreadPoints: number;
  spreadAllowed: boolean;
  isLongEntry: boolean;
  isShortEntry: boolean;
  checks: {
    slopesAligned: boolean;
    arrangementAligned: boolean;
    triggerCrossed: boolean;
    priceRelativeToL1: boolean;
    volatilityBandAllowed: boolean;
    directionAllowed: boolean;
  };
}

export interface RainbowTrendLadderAccountMetrics {
  equity?: number;
  balance?: number;
  usedMargin?: number;
  marginUsagePct?: number;
}

export interface RainbowTrendLadderManagementInput {
  currentPrice: number;
  now: number;
  account?: RainbowTrendLadderAccountMetrics;
  /** 最新一根已收盤 M30 七線；只供規格明列的反轉離場，不重新啟用進場過濾。 */
  trendSnapshot?: RainbowTrendLadderLineSnapshot;
  spreadPoints?: number | null;
}

export interface RainbowTrendLadderManagementMetrics {
  mode: "BLIND";
  profitPct: number;
  highestProfitPct: number;
  trailingActive: boolean;
  trailingDrawdownPct: number;
  marginUsagePct: number | null;
  spreadPoints: number | null;
  spreadAllowed: boolean;
  currentLayer: number;
  finalLayer: number;
  nextLayer: number | null;
  nextCumulativeTriggerPct: number | null;
  nextTriggerPrice: number | null;
  initialEntryPrice: number;
  trendBaseValue: number | null;
  trendBaseSlope: number | null;
  trendDeviationPoints: number | null;
  trendTurnedAgainstPosition: boolean;
  killed: boolean;
}

export interface RainbowTrendLadderFillInput {
  action: "buy" | "sell" | "add_long" | "add_short";
  fillPrice: number;
  fillQuantity: number;
  timestamp: number;
  barTimestamp?: number;
  targetLayer?: number;
  accountEquity?: number;
}

export interface RainbowTrendLadderCoreDecision {
  action: RainbowTrendLadderCoreAction;
  reason: string;
  price: number;
  orderSize?: RainbowTrendLadderBaseLot;
  layerNum?: number;
  closeReason?: RainbowTrendLadderCloseReason;
  nextState: RainbowTrendLadderRuntimeState;
  metrics: RainbowTrendLadderEntryMetrics | RainbowTrendLadderManagementMetrics;
}

const EMPTY_LINE_SNAPSHOT: RainbowTrendLadderLineSnapshot = {
  current: {},
  previous: {},
  slopes: {},
  trendDirection: "INSUFFICIENT",
  longArrangement: false,
  shortArrangement: false,
  longTriggerCross: false,
  shortTriggerCross: false,
  longPriceRelativeToL1: false,
  shortPriceRelativeToL1: false,
  triggerInsideVolatilityBand: false,
  ready: false,
  requiredBars: 0,
  availableBars: 0,
  barTimestamp: 0,
};

function hasActivePosition(state: StrategyState): boolean {
  return state.currentLayer > 0 && state.totalSize > 0 && state.avgPrice > 0;
}

function getLineSourceValue(candle: KLineData, source: RainbowTrendLadderLineConfig["source"]): number {
  if (source === "high") return candle.high;
  if (source === "low") return candle.low;
  if (source === "hlc3") return (candle.high + candle.low + candle.close) / 3;
  return candle.close;
}

export function calculateRainbowTrendLadderSmaSeries(
  candles: readonly KLineData[],
  line: Pick<RainbowTrendLadderLineConfig, "period" | "source">,
): Array<number | null> {
  const result: Array<number | null> = new Array(candles.length).fill(null);
  if (!Number.isSafeInteger(line.period) || line.period < 1 || candles.length < line.period) return result;
  let rolling = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const value = getLineSourceValue(candles[index], line.source);
    if (!Number.isFinite(value) || value <= 0) return new Array(candles.length).fill(null);
    rolling += value;
    if (index >= line.period) rolling -= getLineSourceValue(candles[index - line.period], line.source);
    if (index >= line.period - 1) result[index] = rolling / line.period;
  }
  return result;
}

export function calculateRainbowTrendLadderLineSnapshot(
  candles: readonly KLineData[],
  rawConfig: unknown = createRainbowTrendLadderDefaultConfig(),
): RainbowTrendLadderLineSnapshot {
  const config = assertValidRainbowTrendLadderConfig(rawConfig);
  const requiredBars = Math.max(...config.Lines.map((line) => line.period)) + 1;
  const barTimestamp = candles.at(-1)?.timestamp ?? 0;
  if (candles.length < requiredBars) {
    return { ...EMPTY_LINE_SNAPSHOT, requiredBars, availableBars: candles.length, barTimestamp };
  }

  const currentIndex = candles.length - 1;
  const previousIndex = currentIndex - 1;
  const current = {} as Record<RainbowTrendLadderLineId, number>;
  const previous = {} as Record<RainbowTrendLadderLineId, number>;
  const slopes = {} as Record<RainbowTrendLadderLineId, number>;
  for (const line of config.Lines) {
    const series = calculateRainbowTrendLadderSmaSeries(candles, line);
    const currentValue = series[currentIndex];
    const previousValue = series[previousIndex];
    if (currentValue == null || previousValue == null) {
      return { ...EMPTY_LINE_SNAPSHOT, requiredBars, availableBars: candles.length, barTimestamp };
    }
    current[line.id] = currentValue;
    previous[line.id] = previousValue;
    slopes[line.id] = currentValue - previousValue;
  }

  // V3.0 新邏輯：排名序列不變 + 全部同向
  const allLineIds: RainbowTrendLadderLineId[] = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"];
  
  // 條件1：計算排名序列（將7條線按數值由大至小排序）
  const currentRankArray = [...allLineIds].sort((a, b) => (current[b] ?? 0) - (current[a] ?? 0));
  const previousRankArray = [...allLineIds].sort((a, b) => (previous[b] ?? 0) - (previous[a] ?? 0));
  const rankSequenceUnchanged = currentRankArray.every((line, idx) => line === previousRankArray[idx]);
  
  // 條件2：全部7條線斜率同向
  const allSlopes = allLineIds.map((lineId) => slopes[lineId]);
  const allUpSlopes = allSlopes.every((value) => value > 0);
  const allDownSlopes = allSlopes.every((value) => value < 0);
  const trendDirection: RainbowTrendLadderTrendDirection = allUpSlopes
    ? "UP"
    : allDownSlopes
      ? "DOWN"
      : "MIXED";
  
  // 條件3：價格方向確認
  const currentClose = candles[currentIndex].close;
  const previousClose = candles[previousIndex].close;
  const priceDirectionConfirmed = 
    (trendDirection === "UP" && currentClose > previousClose) ||
    (trendDirection === "DOWN" && currentClose < previousClose);
  
  // 保留舊邏輯的字段以保持兼容性（但不再用於進場判斷）
  const longArrangement = rankSequenceUnchanged && trendDirection === "UP" && priceDirectionConfirmed;
  const shortArrangement = rankSequenceUnchanged && trendDirection === "DOWN" && priceDirectionConfirmed;
  const longTriggerCross = longArrangement;
  const shortTriggerCross = shortArrangement;
  const longPriceRelativeToL1 = rankSequenceUnchanged && trendDirection === "UP" && priceDirectionConfirmed;
  const shortPriceRelativeToL1 = rankSequenceUnchanged && trendDirection === "DOWN" && priceDirectionConfirmed;
  const triggerInsideVolatilityBand = rankSequenceUnchanged && (trendDirection === "UP" || trendDirection === "DOWN");
  return {
    current,
    previous,
    slopes,
    trendDirection,
    longArrangement,
    shortArrangement,
    longTriggerCross,
    shortTriggerCross,
    longPriceRelativeToL1,
    shortPriceRelativeToL1,
    triggerInsideVolatilityBand,
    ready: true,
    requiredBars,
    availableBars: candles.length,
    barTimestamp,
  };
}

export function createRainbowTrendLadderRuntimeMeta(
  seed?: Partial<RainbowTrendLadderRuntimeMeta>,
): RainbowTrendLadderRuntimeMeta {
  return {
    configVersion: RAINBOW_TREND_LADDER_CONFIG_VERSION,
    blindMode: false,
    killed: false,
    killRequestedAt: 0,
    entryTimestamp: 0,
    initialEntryPrice: 0,
    entryAccountEquity: 0,
    highestProfitPct: 0,
    trailingActive: false,
    lastScanBarTimestamp: 0,
    nextEntryBarTimestamp: 0,
    lastManagedAt: 0,
    lastActionTimestamp: 0,
    lastActionSignature: "",
    lastDecisionReason: "尚未執行七彩虹線趨勢跟蹤階梯馬丁決策",
    lastCloseReason: null,
    trendDirection: "INSUFFICIENT",
    ...seed,
    currentLineValues: { ...(seed?.currentLineValues ?? {}) },
    previousLineValues: { ...(seed?.previousLineValues ?? {}) },
    lineSlopes: { ...(seed?.lineSlopes ?? {}) },
  };
}

export function createRainbowTrendLadderRuntimeState(
  seed?: Partial<RainbowTrendLadderRuntimeState>,
): RainbowTrendLadderRuntimeState {
  const source = seed ?? {};
  return {
    ...createInitialStrategyState(),
    ...source,
    rainbowTrendLadderRuntime: createRainbowTrendLadderRuntimeMeta(source.rainbowTrendLadderRuntime),
  };
}

function cloneRainbowTrendLadderState(state: StrategyState): RainbowTrendLadderRuntimeState {
  const source = state as RainbowTrendLadderRuntimeState;
  return {
    ...source,
    rainbowTrendLadderRuntime: createRainbowTrendLadderRuntimeMeta(source.rainbowTrendLadderRuntime),
  };
}

function updateEntryObservation(
  state: RainbowTrendLadderRuntimeState,
  snapshot: RainbowTrendLadderLineSnapshot,
  reason: string,
): RainbowTrendLadderRuntimeState {
  state.rainbowTrendLadderRuntime = createRainbowTrendLadderRuntimeMeta({
    ...state.rainbowTrendLadderRuntime,
    blindMode: hasActivePosition(state),
    lastScanBarTimestamp: snapshot.ready
      ? snapshot.barTimestamp
      : state.rainbowTrendLadderRuntime?.lastScanBarTimestamp ?? 0,
    lastDecisionReason: reason,
    trendDirection: snapshot.trendDirection,
    currentLineValues: snapshot.current,
    previousLineValues: snapshot.previous,
    lineSlopes: snapshot.slopes,
  });
  return state;
}

function createEntryMetrics(
  config: RainbowTrendLadderConfig,
  snapshot: RainbowTrendLadderLineSnapshot,
  spreadPoints: number | null,
  allowedDirection: RainbowTrendLadderAllowedDirection,
): RainbowTrendLadderEntryMetrics {
  const spreadAllowed = spreadPoints != null && Number.isFinite(spreadPoints) && spreadPoints < config.Max_Spread_Points;
  const longDirectionAllowed = allowedDirection !== "short";
  const shortDirectionAllowed = allowedDirection !== "long";
  const isLongEntry =
    snapshot.ready &&
    spreadAllowed &&
    snapshot.trendDirection === "UP" &&
    snapshot.longArrangement &&
    snapshot.longTriggerCross &&
    snapshot.longPriceRelativeToL1 &&
    snapshot.triggerInsideVolatilityBand &&
    longDirectionAllowed;
  const isShortEntry =
    snapshot.ready &&
    spreadAllowed &&
    snapshot.trendDirection === "DOWN" &&
    snapshot.shortArrangement &&
    snapshot.shortTriggerCross &&
    snapshot.shortPriceRelativeToL1 &&
    snapshot.triggerInsideVolatilityBand &&
    shortDirectionAllowed;
  return {
    mode: "SCAN",
    lines: snapshot,
    spreadPoints,
    maxSpreadPoints: config.Max_Spread_Points,
    spreadAllowed,
    isLongEntry,
    isShortEntry,
    checks: {
      slopesAligned: snapshot.trendDirection === "UP" || snapshot.trendDirection === "DOWN",
      arrangementAligned: snapshot.longArrangement || snapshot.shortArrangement,
      triggerCrossed: snapshot.longTriggerCross || snapshot.shortTriggerCross,
      priceRelativeToL1: snapshot.trendDirection === "UP"
        ? snapshot.longPriceRelativeToL1
        : snapshot.shortPriceRelativeToL1,
      volatilityBandAllowed: snapshot.triggerInsideVolatilityBand,
      directionAllowed: snapshot.trendDirection === "UP" ? longDirectionAllowed : shortDirectionAllowed,
    },
  };
}

function entryHold(
  reason: string,
  price: number,
  state: RainbowTrendLadderRuntimeState,
  snapshot: RainbowTrendLadderLineSnapshot,
  metrics: RainbowTrendLadderEntryMetrics,
): RainbowTrendLadderCoreDecision {
  return {
    action: "hold",
    reason,
    price,
    nextState: updateEntryObservation(state, snapshot, reason),
    metrics,
  };
}

export function evaluateRainbowTrendLadderEntry(
  input: RainbowTrendLadderEntryInput,
): RainbowTrendLadderCoreDecision {
  const config = assertValidRainbowTrendLadderConfig(input.rawConfig ?? createRainbowTrendLadderDefaultConfig());
  const nextState = cloneRainbowTrendLadderState(input.state);
  const currentPrice = input.candles.at(-1)?.close ?? 0;
  const snapshot = calculateRainbowTrendLadderLineSnapshot(input.candles, config);
  const spreadPoints = typeof input.spreadPoints === "number" && Number.isFinite(input.spreadPoints)
    ? input.spreadPoints
    : null;
  const allowedDirection = input.allowedDirection ?? "both";
  const metrics = createEntryMetrics(config, snapshot, spreadPoints, allowedDirection);
  const runtime = createRainbowTrendLadderRuntimeMeta(nextState.rainbowTrendLadderRuntime);

  if (runtime.killed) {
    return entryHold("策略已由 KILL 鎖定，必須人工解除後才可重新掃描", currentPrice, nextState, snapshot, metrics);
  }
  if (hasActivePosition(nextState)) {
    return entryHold("持倉盲人模式中：進場七線不干預既有倉位", currentPrice, nextState, snapshot, metrics);
  }
  if (!snapshot.ready) {
    return entryHold(
      `M30 七線數據不足：需要 ${snapshot.requiredBars} 根，現有 ${snapshot.availableBars} 根`,
      currentPrice,
      nextState,
      snapshot,
      metrics,
    );
  }
  if (runtime.lastScanBarTimestamp === snapshot.barTimestamp) {
    return entryHold("此 M30 收盤 K 棒已完成掃描", currentPrice, nextState, snapshot, metrics);
  }
  if (runtime.nextEntryBarTimestamp > 0 && snapshot.barTimestamp < runtime.nextEntryBarTimestamp) {
    return entryHold(
      `平倉後等待下一根 M30 收盤，最早掃描時間 ${new Date(runtime.nextEntryBarTimestamp).toISOString()}`,
      currentPrice,
      nextState,
      snapshot,
      metrics,
    );
  }
  if (!metrics.spreadAllowed) {
    const reason = spreadPoints == null
      ? "缺少交易所即時點差，安全封鎖新底倉"
      : `點差 ${spreadPoints.toFixed(2)} 點未低於上限 ${config.Max_Spread_Points} 點`;
    return entryHold(reason, currentPrice, nextState, snapshot, metrics);
  }
  if (!metrics.isLongEntry && !metrics.isShortEntry) {
    const reason = !metrics.checks.slopesAligned
      ? "L1-L4 斜率未全同向"
      : !metrics.checks.arrangementAligned
        ? "L4、L3、L1、L2 排列不符合多頭或空頭規格"
        : !metrics.checks.triggerCrossed
          ? "L5 尚未於本根收盤穿越 L1"
          : !metrics.checks.priceRelativeToL1
            ? "M30 收盤價未位於 L1 的正確趨勢側"
            : !metrics.checks.volatilityBandAllowed
              ? "M30 收盤價不在 L6/L7 波動區間內"
              : "策略方向限制阻擋本次訊號";
    return entryHold(reason, currentPrice, nextState, snapshot, metrics);
  }

  const action = metrics.isLongEntry ? "buy" : "sell";
  const sideLabel = metrics.isLongEntry ? "多" : "空";
  const reason = `M30 ${sideLabel}頭確認：L1-L4 斜率、L4/L3/L1/L2 排列、L5 穿越 L1、收盤價相對 L1 及 L6/L7 區間全部成立`;
  return {
    action,
    reason,
    price: currentPrice,
    orderSize: { ...config.Base_Lot_Size },
    layerNum: 1,
    nextState: updateEntryObservation(nextState, snapshot, reason),
    metrics,
  };
}

export function getRainbowTrendLadderLineIds(): readonly RainbowTrendLadderLineId[] {
  return RAINBOW_TREND_LADDER_LINE_IDS;
}
