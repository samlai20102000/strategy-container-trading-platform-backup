import Database from "better-sqlite3";
import { inArray } from "drizzle-orm";
import { backtestJobs } from "/home/ubuntu/策略容器化自動交易平台-的副本/drizzle/schema.ts";
import { getDb } from "/home/ubuntu/策略容器化自動交易平台-的副本/server/db.ts";
import {
  runAdvancedKamaPortfolioBacktest,
} from "/home/ubuntu/策略容器化自動交易平台-的副本/server/services/backtest/advancedKamaPortfolioBacktest.ts";
import type {
  BacktestRequest,
} from "/home/ubuntu/策略容器化自動交易平台-的副本/server/services/backtest/backtestEngine.ts";
import type {
  OHLCVRow,
} from "/home/ubuntu/策略容器化自動交易平台-的副本/server/services/backtest/backtestDatabase.ts";
import {
  preflightBacktestRunner,
} from "/home/ubuntu/策略容器化自動交易平台-的副本/server/services/backtest/backtestRunnerPreflight.ts";
import {
  ThreeModePortfolioKernel,
} from "/home/ubuntu/策略容器化自動交易平台-的副本/server/services/backtest/threeModePortfolioKernel.ts";
import {
  getStrategy,
  initStrategyStudio,
} from "/home/ubuntu/策略容器化自動交易平台-的副本/server/services/strategyStudio.ts";
import {
  KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY,
  assertValidKamaRainbowMartinConfig,
  getKamaRainbowMartinTimeframeMinutes,
} from "/home/ubuntu/策略容器化自動交易平台-的副本/shared/strategies/kamaRainbowMartin.ts";

const PROJECT_ROOT = "/home/ubuntu/策略容器化自動交易平台-的副本";
const SQLITE_PATH = `${PROJECT_ROOT}/data/backtest_data.db`;
const S1_JOB_ID = "job_1785654375277_2786d336";
const ADVANCED_JOB_ID = process.env.KRM_ADVANCED_JOB_ID ?? "job_1785654377051_95393c64";

type PortfolioResult = ReturnType<ThreeModePortfolioKernel["finalize"]>;
type PersistedTrade = {
  entryTime?: number;
  exitTime?: number;
  side?: "long" | "short";
  role?: "PRIMARY" | "INDEPENDENT" | "HEDGE";
  cycleId?: string;
};
type OccupancyInterval = {
  cycleId: string;
  role: "PRIMARY" | "INDEPENDENT" | "HEDGE";
  openedAt: number;
  closedAt: number | null;
};

function toMs(value: number): number {
  return value < 1e12 ? value * 1_000 : value;
}

function countBy(values: Array<string | undefined>): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    const key = value || "UNSPECIFIED";
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
}

function loadCandles(request: BacktestRequest): OHLCVRow[] {
  const sqlite = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
  try {
    return sqlite.prepare(`
      SELECT symbol, timeframe, timestamp, open, high, low, close, volume
      FROM ohlcv
      WHERE symbol = ? AND timeframe = ? AND timestamp >= ? AND timestamp < ?
      ORDER BY timestamp ASC
    `).all(
      request.symbol,
      request.timeframe,
      toMs(request.startDate),
      toMs(request.endDate),
    ) as OHLCVRow[];
  } finally {
    sqlite.close();
  }
}

function loadCandleCatalog() {
  const sqlite = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
  try {
    return sqlite.prepare(`
      SELECT symbol, timeframe, COUNT(*) AS candleCount,
             MIN(timestamp) AS firstTimestamp, MAX(timestamp) AS lastTimestamp
      FROM ohlcv
      GROUP BY symbol, timeframe
      ORDER BY candleCount DESC
    `).all();
  } finally {
    sqlite.close();
  }
}

function buildOccupancyIntervals(portfolio: PortfolioResult): OccupancyInterval[] {
  const closed = portfolio.trades.map((trade) => ({
    cycleId: trade.cycleId,
    role: trade.role,
    openedAt: trade.entryTime,
    closedAt: trade.exitTime,
  }));
  const open = portfolio.legAccounting.openLegs.map((leg) => ({
    cycleId: leg.cycleId,
    role: leg.role,
    openedAt: leg.openedAt,
    closedAt: null,
  }));
  return [...closed, ...open];
}

function summarizeSuppressedS1Entries(
  baselineTrades: PersistedTrade[],
  intervals: OccupancyInterval[],
) {
  const m2PrimaryEntries = new Set(
    intervals
      .filter((interval) => interval.role === "PRIMARY")
      .map((interval) => interval.openedAt),
  );
  const baselineEntries = baselineTrades
    .map((trade) => Number(trade.entryTime))
    .filter((timestamp) => Number.isFinite(timestamp));
  const suppressed = baselineEntries
    .filter((timestamp) => !m2PrimaryEntries.has(timestamp))
    .map((timestamp) => {
      const active = intervals.filter((interval) => (
        interval.openedAt <= timestamp
        && (interval.closedAt === null || timestamp < interval.closedAt)
      ));
      const roles = [...new Set(active.map((interval) => interval.role))].sort();
      return {
        timestamp,
        activeCycleIds: [...new Set(active.map((interval) => interval.cycleId))].sort(),
        activeRoles: roles,
        blockedByAnyOpenLeg: active.length > 0,
        blockedByPrimary: roles.includes("PRIMARY"),
        blockedByAuxiliaryOnly: active.length > 0 && !roles.includes("PRIMARY"),
      };
    });
  const overlappingEntryCount = baselineEntries.filter((timestamp) => m2PrimaryEntries.has(timestamp)).length;

  return {
    baselineEntryCount: baselineEntries.length,
    m2PrimaryEntryCount: m2PrimaryEntries.size,
    overlappingEntryCount,
    suppressedEntryCount: suppressed.length,
    blockedByAnyOpenLeg: suppressed.filter((item) => item.blockedByAnyOpenLeg).length,
    blockedByPrimary: suppressed.filter((item) => item.blockedByPrimary).length,
    blockedByAuxiliaryOnly: suppressed.filter((item) => item.blockedByAuxiliaryOnly).length,
    outsideObservedOccupancy: suppressed.filter((item) => !item.blockedByAnyOpenLeg).length,
    firstTenSuppressed: suppressed.slice(0, 10),
  };
}

function summarizeCycles(intervals: OccupancyInterval[], endMs: number) {
  const grouped = new Map<string, OccupancyInterval[]>();
  for (const interval of intervals) {
    grouped.set(interval.cycleId, [...(grouped.get(interval.cycleId) ?? []), interval]);
  }
  return [...grouped.entries()].map(([cycleId, cycleIntervals]) => {
    const openedAt = Math.min(...cycleIntervals.map((interval) => interval.openedAt));
    const hasOpenLeg = cycleIntervals.some((interval) => interval.closedAt === null);
    const effectiveClosedAt = hasOpenLeg
      ? endMs
      : Math.max(...cycleIntervals.map((interval) => interval.closedAt ?? endMs));
    return {
      cycleId,
      roles: [...new Set(cycleIntervals.map((interval) => interval.role))].sort(),
      openedAt,
      closedAt: hasOpenLeg ? null : effectiveClosedAt,
      occupiedDays: Number(((effectiveClosedAt - openedAt) / 86_400_000).toFixed(3)),
      hasOpenLeg,
    };
  }).sort((left, right) => right.occupiedDays - left.occupiedDays);
}

async function main() {
  await initStrategyStudio();
  const db = await getDb();
  if (!db) throw new Error("BACKTEST_DATABASE_UNAVAILABLE");
  const rows = await db
    .select()
    .from(backtestJobs)
    .where(inArray(backtestJobs.jobId, [S1_JOB_ID, ADVANCED_JOB_ID]));
  const byId = new Map(rows.map((row) => [row.jobId, row]));
  const s1 = byId.get(S1_JOB_ID);
  const advanced = byId.get(ADVANCED_JOB_ID);
  if (!s1?.requestSnapshot || !advanced?.requestSnapshot) {
    throw new Error("KRM_REPAIRED_SNAPSHOT_NOT_FOUND");
  }

  const request = structuredClone(advanced.requestSnapshot) as BacktestRequest;
  const rawConfig = request.config[KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY] ?? request.config;
  const validatedConfig = assertValidKamaRainbowMartinConfig(rawConfig);
  const config = { ...request.config, ...validatedConfig };
  const preflight = preflightBacktestRunner(request);
  if (!preflight.resolvedPortfolioAdapter) {
    throw new Error("KRM_M2_PORTFOLIO_ADAPTER_NOT_RESOLVED");
  }
  const canonicalSymbol = advanced.symbol.endsWith("-SWAP")
    ? advanced.symbol
    : `${advanced.symbol}-SWAP`;
  const effectiveRequest: BacktestRequest = {
    ...request,
    // 正式 BacktestEngine 會在 preflight 前把 request.symbol 正規化；直接呼叫
    // advanced runner 時必須復用 completed Job 的 canonical symbol 才能完全對齊。
    symbol: canonicalSymbol,
    timeframe: `${getKamaRainbowMartinTimeframeMinutes(validatedConfig.timeframe)}m`,
    executionMode: preflight.executionPolicy.mode,
    executionPolicy: preflight.executionPolicy,
  };
  const candles = loadCandles(effectiveRequest);
  if (candles.length !== Number(advanced.candleCount)) {
    throw new Error(`KRM_CANDLE_COUNT_MISMATCH:${JSON.stringify({
      actual: candles.length,
      expected: advanced.candleCount,
      request: {
        symbol: effectiveRequest.symbol,
        timeframe: effectiveRequest.timeframe,
        startDate: effectiveRequest.startDate,
        endDate: effectiveRequest.endDate,
        startMs: toMs(effectiveRequest.startDate),
        endMs: toMs(effectiveRequest.endDate),
      },
      catalog: loadCandleCatalog(),
    })}`);
  }
  const strategy = getStrategy(effectiveRequest.strategyKey);
  if (!strategy) throw new Error("KRM_STRATEGY_NOT_REGISTERED");

  const originalFinalize = ThreeModePortfolioKernel.prototype.finalize;
  let capturedPortfolio: PortfolioResult | null = null;
  ThreeModePortfolioKernel.prototype.finalize = function (endPolicy, timestamp, price) {
    const result = originalFinalize.call(this, endPolicy, timestamp, price);
    capturedPortfolio = result;
    return result;
  };

  let replayResult;
  try {
    replayResult = await runAdvancedKamaPortfolioBacktest({
      request: effectiveRequest,
      strategy,
      config,
      candles,
      startMs: toMs(effectiveRequest.startDate),
      endMs: toMs(effectiveRequest.endDate),
      executionPolicy: preflight.executionPolicy,
      endPositionPolicy: effectiveRequest.endPositionPolicy ?? "mark_to_market",
      commission: effectiveRequest.commission ?? 0.0004,
      slippage: effectiveRequest.slippage ?? 0.0001,
      resolvedAdapter: preflight.resolvedPortfolioAdapter,
    });
  } finally {
    ThreeModePortfolioKernel.prototype.finalize = originalFinalize;
  }
  if (!capturedPortfolio) throw new Error("KRM_PORTFOLIO_CAPTURE_FAILED");
  const portfolio = capturedPortfolio as PortfolioResult;
  const intervals = buildOccupancyIntervals(portfolio);
  const decisions = portfolio.decisions;
  const nonApproved = decisions.filter((decision) => (
    decision.outcome !== "APPROVED" && decision.outcome !== "CLOSE_ONLY"
  ));
  const baselineTrades = Array.isArray(s1.tradesData)
    ? s1.tradesData as PersistedTrade[]
    : [];

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    safety: "READ_ONLY_IN_MEMORY_REPLAY_NO_JOB_PERSISTENCE_NO_EXCHANGE_CALL",
    sourceJobs: { s1: S1_JOB_ID, advanced: ADVANCED_JOB_ID },
    advancedMode: preflight.executionPolicy.mode,
    replayParity: {
      candleCount: candles.length,
      persistedTradeCount: Array.isArray(advanced.tradesData) ? advanced.tradesData.length : null,
      replayTradeCount: replayResult.trades.length,
      persistedRejectedDecisionCount: Number((advanced.legAccounting as { rejectedDecisionCount?: number } | null)?.rejectedDecisionCount ?? 0),
      replayRejectedDecisionCount: portfolio.legAccounting.rejectedDecisionCount,
      persistedRealizedPnl: Number((advanced.accounting as { realizedPnl?: number } | null)?.realizedPnl ?? 0),
      replayRealizedPnl: portfolio.accounting.realizedPnl,
      persistedOpenPositionCount: Number((advanced.accounting as { openPositionCount?: number } | null)?.openPositionCount ?? 0),
      replayOpenPositionCount: portfolio.accounting.openPositionCount,
    },
    decisions: {
      total: decisions.length,
      outcomes: countBy(decisions.map((decision) => decision.outcome)),
      nonApprovedCount: nonApproved.length,
      nonApprovedReasonCodes: countBy(nonApproved.map((decision) => decision.reasonCode)),
      nonApprovedCandidateActions: countBy(nonApproved.map((decision) => (
        decision.candidateId.split(":").at(-1)
      ))),
      outcomeReasonPairs: countBy(decisions.map((decision) => `${decision.outcome}:${decision.reasonCode}`)),
    },
    cycleOccupancy: {
      intervals,
      cycles: summarizeCycles(intervals, toMs(effectiveRequest.endDate)),
      suppressedBaselineS1: summarizeSuppressedS1Entries(baselineTrades, intervals),
    },
  }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error("KRM_M2_INMEMORY_ROOT_CAUSE_FAILED", error);
  process.exit(1);
});
