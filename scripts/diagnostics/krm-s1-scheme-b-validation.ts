import { eq } from "drizzle-orm";
import { backtestJobs } from "../../drizzle/schema";
import { createDefaultStrategyExecutionPolicy } from "../../shared/strategies/kamaRainbowMartinExecutionPolicy";
import { getDb } from "../../server/db";
import type { BacktestRequest } from "../../server/services/backtest/backtestEngine";
import { buildBacktestHash } from "../../server/services/backtest/backtestContracts";
import { backtestJobManager } from "../../server/services/backtest/backtestJobManager";
import { getStrategyChannelCapabilities } from "../../server/services/strategyRunnerDescriptors";
import { initStrategyStudio } from "../../server/services/strategyStudio";

const KRM_STRATEGY_KEY = "KAMA_RAINBOW_MARTIN_V1";
const REPAIRED_S1_BASELINE_JOB = "job_1785654375277_2786d336";
const EXPECTED_CANDLE_COUNT = 27_744;
const EXPECTED_TRADE_COUNT = 95;
const TERMINAL = new Set(["completed", "failed", "timeout", "cancelled"]);
const EXCHANGE_MUTATION_URL = /(?:\/api\/v5\/trade\/|\/trade\/order|\/orders?(?:\?|$))/i;

type BacktestTrade = Record<string, unknown>;

const observedExchangeMutations: Array<{ method: string; url: string }> = [];
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
  const url = String(request?.url ?? input);
  if (method !== "GET" && EXCHANGE_MUTATION_URL.test(url)) {
    observedExchangeMutations.push({ method, url: url.split("?")[0] });
  }
  return originalFetch(input, init);
};

function asTrades(value: unknown): BacktestTrade[] {
  return Array.isArray(value)
    ? value.filter((item): item is BacktestTrade => Boolean(item) && typeof item === "object")
    : [];
}

function tradeIdentity(trade: BacktestTrade) {
  return {
    deploymentMode: trade.deploymentMode,
    role: trade.role,
    cycleId: trade.cycleId,
    legId: trade.legId,
    side: trade.side,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    size: trade.size,
    pnl: trade.pnl,
    pnlPct: trade.pnlPct,
    martinLayer: trade.martinLayer,
    triggerSource: trade.triggerSource,
    entryReason: trade.entryReason,
    exitReason: trade.exitReason,
  };
}

function assertCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

async function main() {
  await initStrategyStudio();
  const db = await getDb();
  if (!db) throw new Error("BACKTEST_DATABASE_UNAVAILABLE");

  const [baseline] = await db
    .select()
    .from(backtestJobs)
    .where(eq(backtestJobs.jobId, REPAIRED_S1_BASELINE_JOB))
    .limit(1);
  assertCondition(baseline?.requestSnapshot, "KRM_REPAIRED_S1_BASELINE_NOT_FOUND");
  assertCondition(baseline.strategyKey === KRM_STRATEGY_KEY, "KRM_BASELINE_STRATEGY_MISMATCH");

  const baselineTrades = asTrades(baseline.tradesData);
  assertCondition(baselineTrades.length === EXPECTED_TRADE_COUNT, "KRM_BASELINE_TRADE_COUNT_MISMATCH");

  const request = structuredClone(baseline.requestSnapshot) as BacktestRequest;
  request.executionMode = "SINGLE_EXCLUSIVE";
  request.executionPolicy = createDefaultStrategyExecutionPolicy(
    KRM_STRATEGY_KEY,
    "SINGLE_EXCLUSIVE",
  );
  request.strategyModeCapabilities = getStrategyChannelCapabilities(KRM_STRATEGY_KEY, "BACKTEST");

  const jobId = await backtestJobManager.submit(request, baseline.userId, {
    timeoutSeconds: 1_800,
    strategyName: "Kama彩虹馬丁策略－方案 B S1-only 驗證",
    tradeAmount: Number(request.config?.Position_Size_Value ?? 100),
  });
  console.log(`[KRM_S1_SCHEME_B_SUBMITTED] ${jobId}`);

  const startedAt = Date.now();
  let lastLogAt = 0;
  while (Date.now() - startedAt < 35 * 60_000) {
    const result = await backtestJobManager.getJobResultFromDB(jobId, baseline.userId);
    if (result && TERMINAL.has(result.status)) {
      const trades = asTrades(result.tradesData);
      const baselineIdentities = baselineTrades.map(tradeIdentity);
      const resultIdentities = trades.map(tradeIdentity);
      const mismatchIndexes = baselineIdentities
        .map((trade, index) => buildBacktestHash(trade) === buildBacktestHash(resultIdentities[index]) ? -1 : index)
        .filter((index) => index >= 0);
      const advancedTrades = trades.filter((trade) =>
        trade.deploymentMode === "M2"
        || trade.deploymentMode === "H3"
        || trade.role === "INDEPENDENT"
        || trade.role === "HEDGE"
      );
      const resultText = JSON.stringify({ error: result.error, errorCode: result.errorCode });

      const evidence = {
        contractVersion: "krm-s1-scheme-b-validation-v1",
        baselineJobId: REPAIRED_S1_BASELINE_JOB,
        jobId,
        status: result.status,
        phase: result.phase,
        errorCode: result.errorCode,
        error: result.error,
        candleCount: result.candleCount,
        baselineTradeCount: baselineTrades.length,
        resultTradeCount: trades.length,
        baselineTradeIdentityHash: buildBacktestHash(baselineIdentities),
        resultTradeIdentityHash: buildBacktestHash(resultIdentities),
        mismatchCount: mismatchIndexes.length,
        mismatchIndexes: mismatchIndexes.slice(0, 20),
        advancedTradeCount: advancedTrades.length,
        deploymentModes: Array.from(new Set(trades.map((trade) => trade.deploymentMode))),
        roles: Array.from(new Set(trades.map((trade) => trade.role))),
        observedExchangeMutationCount: observedExchangeMutations.length,
        observedExchangeMutations,
        metrics: result.metrics,
        accounting: result.accounting,
      };

      console.log("KRM_S1_SCHEME_B_EVIDENCE_START");
      console.log(JSON.stringify(evidence, null, 2));
      console.log("KRM_S1_SCHEME_B_EVIDENCE_END");

      assertCondition(result.status === "completed", `KRM_S1_JOB_${result.status.toUpperCase()}`);
      assertCondition(result.errorCode == null, `KRM_S1_ERROR_CODE:${result.errorCode}`);
      assertCondition(!/this\.pnl is not a function/i.test(resultText), "KRM_S1_PNL_METHOD_REGRESSION");
      assertCondition(result.candleCount === EXPECTED_CANDLE_COUNT, "KRM_S1_CANDLE_COUNT_MISMATCH");
      assertCondition(trades.length === EXPECTED_TRADE_COUNT, "KRM_S1_TRADE_COUNT_MISMATCH");
      assertCondition(mismatchIndexes.length === 0, "KRM_S1_TRADE_IDENTITY_MISMATCH");
      assertCondition(advancedTrades.length === 0, "KRM_S1_ADVANCED_LEG_LEAK");
      assertCondition(observedExchangeMutations.length === 0, "KRM_S1_EXCHANGE_MUTATION_DETECTED");
      return;
    }

    if (Date.now() - lastLogAt >= 15_000) {
      lastLogAt = Date.now();
      console.log("[KRM_S1_SCHEME_B_PROGRESS]", {
        jobId,
        status: result?.status,
        phase: result?.phase,
        progress: result?.progress,
        processedBars: result?.processedBars,
        totalBars: result?.totalBars,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("KRM_S1_SCHEME_B_TIMEOUT");
}

main().catch((error) => {
  console.error("KRM_S1_SCHEME_B_FAILED", error);
  process.exitCode = 1;
});
