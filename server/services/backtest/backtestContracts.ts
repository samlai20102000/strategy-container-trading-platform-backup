import { createHash } from "node:crypto";
import type {
  ExecutionMode,
  ExecutionPolicy,
  PositionLegRole,
  PositionSide,
} from "../../../shared/executionModes";
import type { OHLCVRow } from "./backtestDatabase";

export const BACKTEST_ENGINE_VERSION = "3.0.0-three-mode";
export const BACKTEST_SIMULATED_ADAPTER_VERSION = "simulated-exchange-v1";
export const BACKTEST_RISK_MODEL_VERSION = "gross-margin-liquidation-v2";
export const BACKTEST_INTRABAR_POLICY_VERSION = "risk-first-v1";
export const BACKTEST_ACCOUNTING_TOLERANCE = 0.02;
export const V25_END_OF_DATA_EXIT_REASON = "回測全域終點強制平倉";

export type BacktestEndPositionPolicy = "mark_to_market" | "force_close";
export type BacktestIntrabarEventPolicy = "risk_first";

/** 同一根 K 棒固定採風險優先，不依策略表現挑選較有利路徑。 */
export const BACKTEST_INTRABAR_EVENT_ORDER = [
  "FORCED_RISK_EXIT",
  "REGULAR_EXIT",
  "HEDGE_UNWIND",
  "MARTIN_ADD",
  "NEW_DIRECTION_OR_HEDGE",
] as const;

export type BacktestIntrabarEventKind = (typeof BACKTEST_INTRABAR_EVENT_ORDER)[number];

export interface BacktestRunnerIdentity {
  runnerId: string;
  runnerVersion: number;
  descriptorVersion: string;
  strategyVersion: string | number;
  logicRevision: string;
  executionPath: "S1_STRATEGY_ENGINE" | "PORTFOLIO_RUNTIME_ADAPTER";
}

export interface BacktestVersionedExecutionContext {
  executionMode: ExecutionMode;
  executionPolicy: ExecutionPolicy;
  executionPolicyVersion: string;
  strategyVersion: string;
  strategyLogicHash: string;
  configHash: string;
  policyHash: string;
  dataHash: string;
  intrabarEventPolicy: BacktestIntrabarEventPolicy;
  intrabarEventPolicyVersion: typeof BACKTEST_INTRABAR_POLICY_VERSION;
  riskModelVersion: typeof BACKTEST_RISK_MODEL_VERSION;
  simulatedAdapterVersion: typeof BACKTEST_SIMULATED_ADAPTER_VERSION;
  engineVersion: typeof BACKTEST_ENGINE_VERSION;
  comparisonGroupId: string;
  runner: BacktestRunnerIdentity;
}

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

export interface BacktestOpenLegSnapshot extends BacktestOpenPositionSnapshot {
  legId: string;
  cycleId: string;
  role: PositionLegRole;
  sideCode: PositionSide;
  martinLayer: number;
  lastEntryPrice: number;
  openedAt: number;
  mfePct: number;
  maePct: number;
}

export interface BacktestLegAttribution {
  legId: string;
  side: "long" | "short";
  sideCode: PositionSide;
  role: PositionLegRole;
  cycleId: string;
  tradeCount: number;
  addCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  grossPnl: number;
  fees: number;
  funding: number;
  turnover: number;
  maxNotional: number;
  mfePct: number;
  maePct: number;
  openedAt: number;
  closedAt: number | null;
  exitReason: string | null;
}

export interface BacktestHedgeAttribution {
  relationshipId: string;
  primaryLegId: string;
  hedgeLegId: string;
  triggeredAt: number;
  closedAt: number | null;
  triggerLossPct: number;
  targetRatio: number;
  actualRatio: number;
  pairPnl: number;
  hedgeCost: number;
  unwindOutcome: string | null;
  counterfactualWithoutHedgePnl: number;
}

export interface BacktestLegAccounting {
  version: "backtest-leg-accounting-v1";
  executionMode: ExecutionMode;
  legs: BacktestLegAttribution[];
  openLegs: BacktestOpenLegSnapshot[];
  hedgeRelationships: BacktestHedgeAttribution[];
  grossExposurePeak: number;
  netExposureAbsPeak: number;
  marginUsagePeak: number;
  marginHeadroomLow: number;
  turnover: number;
  fees: number;
  funding: number;
  overlapDurationMs: number;
  eventCount: number;
  decisionCount: number;
  rejectedDecisionCount: number;
  /** 由 portfolio kernel 觸發的 maintenance-margin 強制平倉次數。 */
  marginLiquidationCount?: number;
  /** 權益已耗盡並停止新開倉。 */
  bankrupt?: boolean;
}

export interface BacktestModeResults {
  version: "backtest-mode-results-v1";
  executionMode: ExecutionMode;
  comparisonGroupId: string;
  fairComparisonEligible: boolean;
  fairnessBlockers: string[];
  intrabarEventPolicy: BacktestIntrabarEventPolicy;
  intrabarEventOrder: readonly BacktestIntrabarEventKind[];
  grossExposurePeak: number;
  netExposureAbsPeak: number;
  marginHeadroomLow: number;
  turnover: number;
  fees: number;
  funding: number;
  longRealizedPnl: number;
  shortRealizedPnl: number;
  primaryRealizedPnl: number;
  hedgeRealizedPnl: number;
  pairPnl: number;
  hedgeCost: number;
  counterfactualWithoutHedgePnl: number;
  overlapDurationMs: number;
  marginLiquidationCount?: number;
  bankrupt?: boolean;
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
  /** 舊欄位只保留第一腿；三模式請以 openPositions 為準。 */
  openPositions?: BacktestOpenLegSnapshot[];
  openPositionCount: number;
  syntheticForceCloseCount: number;
  grossExposure?: number;
  netExposure?: number;
  /** 權益耗盡後用於有限責任零下限的明確對帳項，不會偽裝成交易損益。 */
  bankruptcyAdjustment?: number;
  marginLiquidationCount?: number;
  bankrupt?: boolean;
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function buildBacktestHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** mode/policy 刻意不納入，才能在同一策略、資料、成本與引擎下比較 S1/M2/H3。 */
export function buildBacktestComparisonGroupId(input: {
  strategyKey: string;
  strategyVersion: string;
  strategyLogicHash: string;
  configHash: string;
  dataHash: string;
  symbol: string;
  timeframe: string;
  startDate: number;
  endDate: number;
  commission: number;
  slippage: number;
  fundingModel?: string;
  contractSpecification?: unknown;
  intrabarEventPolicy: BacktestIntrabarEventPolicy;
  endPositionPolicy: BacktestEndPositionPolicy;
}): string {
  return `btcmp_${buildBacktestHash({
    strategyKey: input.strategyKey,
    strategyVersion: input.strategyVersion,
    strategyLogicHash: input.strategyLogicHash,
    configHash: input.configHash,
    dataHash: input.dataHash,
    symbol: input.symbol,
    timeframe: input.timeframe,
    startDate: input.startDate,
    endDate: input.endDate,
    commission: input.commission,
    slippage: input.slippage,
    fundingModel: input.fundingModel ?? null,
    contractSpecification: input.contractSpecification ?? null,
    intrabarEventPolicy: input.intrabarEventPolicy,
    endPositionPolicy: input.endPositionPolicy,
    engineVersion: BACKTEST_ENGINE_VERSION,
    simulatedAdapterVersion: BACKTEST_SIMULATED_ADAPTER_VERSION,
    riskModelVersion: BACKTEST_RISK_MODEL_VERSION,
    intrabarEventPolicyVersion: BACKTEST_INTRABAR_POLICY_VERSION,
  }).slice(0, 24)}`;
}

export function evaluateBacktestFairness(
  contexts: Array<Pick<
    BacktestVersionedExecutionContext,
    | "comparisonGroupId"
    | "strategyLogicHash"
    | "configHash"
    | "dataHash"
    | "engineVersion"
    | "simulatedAdapterVersion"
    | "riskModelVersion"
  >>,
): { eligible: boolean; blockers: string[] } {
  if (contexts.length < 2) return { eligible: false, blockers: ["AT_LEAST_TWO_RUNS_REQUIRED"] };
  const first = contexts[0];
  const keys = [
    "comparisonGroupId",
    "strategyLogicHash",
    "configHash",
    "dataHash",
    "engineVersion",
    "simulatedAdapterVersion",
    "riskModelVersion",
  ] as const;
  const blockers = keys
    .filter(key => contexts.some(context => context[key] !== first[key]))
    .map(key => `MISMATCH_${key.replace(/[A-Z]/g, char => `_${char}`).toUpperCase()}`);
  return { eligible: blockers.length === 0, blockers };
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
