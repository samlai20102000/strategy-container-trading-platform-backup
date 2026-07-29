import type { OHLCVRow } from "./backtestDatabase";

export const BACKTEST_ENGINE_VERSION = "2.5.0-continuous";
export const BACKTEST_ACCOUNTING_TOLERANCE = 0.02;
export const V25_END_OF_DATA_EXIT_REASON = "回測全域終點強制平倉";

export type BacktestEndPositionPolicy = "mark_to_market" | "force_close";

export interface BacktestEngineSemantics {
  version: typeof BACKTEST_ENGINE_VERSION;
  sessionMode: "continuous";
  dataSlicing: "half_open";
  finalizationScope: "global_end_only";
  defaultEndPositionPolicy: "mark_to_market";
}

export const BACKTEST_ENGINE_SEMANTICS: BacktestEngineSemantics = {
  version: BACKTEST_ENGINE_VERSION,
  sessionMode: "continuous",
  dataSlicing: "half_open",
  finalizationScope: "global_end_only",
  defaultEndPositionPolicy: "mark_to_market",
};

export interface BacktestDataQuality {
  intervalContract: "[start,end)";
  requestedStartMs: number;
  requestedEndMs: number;
  inputCandles: number;
  returnedCandles: number;
  candleCount: number;
  duplicateCandlesRemoved: number;
  duplicateTimestampCount: number;
  outOfRangeCandlesRemoved: number;
  outOfRangeCount: number;
  invalidCandlesRemoved: number;
  invalidCandleCount: number;
  unclosedCandlesRemoved: number;
  unclosedCandleCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  sortedAscending: boolean;
}

export interface BacktestOpenPositionSnapshot {
  side: "long" | "short";
  entryTime: number;
  averageEntryPrice: number;
  size: number;
  markPrice: number;
  entryNotional: number;
  entryFees: number;
  unrealizedGrossPnl: number;
  unrealizedPnl: number;
}

export interface BacktestAccountingSnapshot {
  initialCapital: number;
  realizedPnl: number;
  unrealizedPnl: number;
  finalEquity: number;
  expectedFinalEquity: number;
  reconciliationDifference: number;
  balanced: boolean;
  reconciled: boolean;
  tolerance: number;
  openPosition: BacktestOpenPositionSnapshot | null;
  openPositionCount: number;
  syntheticForceCloseCount: number;
}

export interface BacktestPositionLike {
  side: "long" | "short";
  entryTime: number;
  avgPrice: number;
  totalSize: number;
  layers: Array<{ price: number; size: number; time: number }>;
}

export interface NormalizeOHLCVOptions {
  startMs: number;
  endMs: number;
  timeframeMs: number;
  nowMs?: number;
  requireClosed?: boolean;
}

export interface NormalizedOHLCVData {
  candles: OHLCVRow[];
  quality: BacktestDataQuality;
}

export function normalizeBacktestEndPositionPolicy(value: unknown): BacktestEndPositionPolicy {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  return normalized === "force_close" || normalized === "forceclose"
    ? "force_close"
    : "mark_to_market";
}

export const resolveEndPositionPolicy = normalizeBacktestEndPositionPolicy;

export function createContinuousEngineSemantics(): BacktestEngineSemantics {
  return { ...BACKTEST_ENGINE_SEMANTICS };
}

export function roundBacktestMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isFiniteCandle(row: OHLCVRow): boolean {
  return [row.timestamp, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
    && row.timestamp >= 0
    && row.open > 0
    && row.high > 0
    && row.low > 0
    && row.close > 0
    && row.volume >= 0
    && row.high >= Math.max(row.open, row.close, row.low)
    && row.low <= Math.min(row.open, row.close, row.high);
}

/** 統一交易所、SQLite 與相鄰資料片為 `[startMs,endMs)`，並只保留已收盤 K 棒。 */
export function normalizeOHLCVData(
  rows: OHLCVRow[],
  options: NormalizeOHLCVOptions,
): NormalizedOHLCVData {
  const requireClosed = options.requireClosed ?? true;
  const nowMs = options.nowMs ?? Date.now();
  const byTimestamp = new Map<number, OHLCVRow>();
  let duplicateTimestampCount = 0;
  let outOfRangeCount = 0;
  let invalidCandleCount = 0;
  let unclosedCandleCount = 0;

  for (const row of rows) {
    if (!isFiniteCandle(row)) {
      invalidCandleCount += 1;
      continue;
    }
    if (row.timestamp < options.startMs || row.timestamp >= options.endMs) {
      outOfRangeCount += 1;
      continue;
    }
    if (requireClosed && row.timestamp + options.timeframeMs > nowMs) {
      unclosedCandleCount += 1;
      continue;
    }
    if (byTimestamp.has(row.timestamp)) duplicateTimestampCount += 1;
    byTimestamp.set(row.timestamp, row);
  }

  const candles = Array.from(byTimestamp.values()).sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const quality: BacktestDataQuality = {
    intervalContract: "[start,end)",
    requestedStartMs: options.startMs,
    requestedEndMs: options.endMs,
    inputCandles: rows.length,
    returnedCandles: candles.length,
    candleCount: candles.length,
    duplicateCandlesRemoved: duplicateTimestampCount,
    duplicateTimestampCount,
    outOfRangeCandlesRemoved: outOfRangeCount,
    outOfRangeCount,
    invalidCandlesRemoved: invalidCandleCount,
    invalidCandleCount,
    unclosedCandlesRemoved: unclosedCandleCount,
    unclosedCandleCount,
    firstTimestamp: candles[0]?.timestamp ?? null,
    lastTimestamp: candles[candles.length - 1]?.timestamp ?? null,
    sortedAscending: candles.every(
      (candle, index) => index === 0 || candles[index - 1].timestamp < candle.timestamp,
    ),
  };
  return { candles, quality };
}

export function buildOpenPositionSnapshot(
  position: BacktestPositionLike | null,
  markPrice: number,
  commission: number,
): BacktestOpenPositionSnapshot | null {
  if (!position || !(position.totalSize > 0) || !(position.avgPrice > 0)) return null;
  const entryNotional = position.layers.reduce(
    (total, layer) => total + layer.price * layer.size,
    0,
  );
  const entryFees = entryNotional * commission;
  const unrealizedGrossPnl = position.side === "long"
    ? (markPrice - position.avgPrice) * position.totalSize
    : (position.avgPrice - markPrice) * position.totalSize;
  return {
    side: position.side,
    entryTime: position.entryTime,
    averageEntryPrice: position.avgPrice,
    size: position.totalSize,
    markPrice,
    entryNotional: roundBacktestMoney(entryNotional),
    entryFees: roundBacktestMoney(entryFees),
    unrealizedGrossPnl: roundBacktestMoney(unrealizedGrossPnl),
    unrealizedPnl: roundBacktestMoney(unrealizedGrossPnl - entryFees),
  };
}

export function buildBacktestAccountingSnapshot(input: {
  initialCapital: number;
  tradePnls: number[];
  openPosition: BacktestOpenPositionSnapshot | null;
  finalEquity?: number;
  tolerance?: number;
  syntheticForceCloseCount?: number;
}): BacktestAccountingSnapshot {
  const tolerance = input.tolerance ?? BACKTEST_ACCOUNTING_TOLERANCE;
  const realizedPnl = roundBacktestMoney(
    input.tradePnls.reduce((total, pnl) => total + roundBacktestMoney(pnl), 0),
  );
  const unrealizedPnl = roundBacktestMoney(input.openPosition?.unrealizedPnl ?? 0);
  const expectedFinalEquity = roundBacktestMoney(input.initialCapital + realizedPnl + unrealizedPnl);
  const finalEquity = roundBacktestMoney(input.finalEquity ?? expectedFinalEquity);
  const reconciliationDifference = roundBacktestMoney(finalEquity - expectedFinalEquity);
  const reconciled = Math.abs(reconciliationDifference) <= tolerance;
  return {
    initialCapital: roundBacktestMoney(input.initialCapital),
    realizedPnl,
    unrealizedPnl,
    finalEquity,
    expectedFinalEquity,
    reconciliationDifference,
    balanced: reconciled,
    reconciled,
    tolerance,
    openPosition: input.openPosition,
    openPositionCount: input.openPosition ? 1 : 0,
    syntheticForceCloseCount: input.syntheticForceCloseCount ?? 0,
  };
}

export function buildAccountingSnapshot(input: {
  initialCapital: number;
  trades: Array<{ pnl: number }>;
  unrealizedPnl: number;
  finalEquity: number;
  openPositionCount: number;
  syntheticForceCloseCount: number;
  openPosition?: BacktestOpenPositionSnapshot | null;
  tolerance?: number;
}): BacktestAccountingSnapshot {
  const tolerance = input.tolerance ?? BACKTEST_ACCOUNTING_TOLERANCE;
  const realizedPnl = roundBacktestMoney(
    input.trades.reduce((sum, trade) => sum + roundBacktestMoney(trade.pnl), 0),
  );
  const unrealizedPnl = roundBacktestMoney(input.unrealizedPnl);
  const expectedFinalEquity = roundBacktestMoney(input.initialCapital + realizedPnl + unrealizedPnl);
  const finalEquity = roundBacktestMoney(input.finalEquity);
  const reconciliationDifference = roundBacktestMoney(finalEquity - expectedFinalEquity);
  const reconciled = Math.abs(reconciliationDifference) <= tolerance;
  return {
    initialCapital: roundBacktestMoney(input.initialCapital),
    realizedPnl,
    unrealizedPnl,
    finalEquity,
    expectedFinalEquity,
    reconciliationDifference,
    balanced: reconciled,
    reconciled,
    tolerance,
    openPosition: input.openPosition ?? null,
    openPositionCount: input.openPositionCount,
    syntheticForceCloseCount: input.syntheticForceCloseCount,
  };
}

export function assertBalancedBacktestAccounting(
  accounting: BacktestAccountingSnapshot,
  context: string,
): void {
  if (!accounting.reconciled) {
    throw new Error(
      `${context} 權益帳本對帳失敗：final=${accounting.finalEquity}, expected=${accounting.expectedFinalEquity}, difference=${accounting.reconciliationDifference}`,
    );
  }
}

export function assertSingleEquityLedger(
  accounting: BacktestAccountingSnapshot,
  context = "V2.5 回測",
): void {
  assertBalancedBacktestAccounting(accounting, context);
}
