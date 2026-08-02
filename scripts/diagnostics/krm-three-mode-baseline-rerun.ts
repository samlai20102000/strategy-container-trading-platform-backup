import { inArray } from "drizzle-orm";
import { backtestJobs } from "/home/ubuntu/策略容器化自動交易平台-的副本/drizzle/schema.ts";
import { getDb } from "/home/ubuntu/策略容器化自動交易平台-的副本/server/db.ts";
import { backtestJobManager } from "/home/ubuntu/策略容器化自動交易平台-的副本/server/services/backtest/backtestJobManager.ts";
import type { BacktestRequest } from "/home/ubuntu/策略容器化自動交易平台-的副本/server/services/backtest/backtestEngine.ts";
import { initStrategyStudio } from "/home/ubuntu/策略容器化自動交易平台-的副本/server/services/strategyStudio.ts";
import { createDefaultStrategyExecutionPolicy } from "/home/ubuntu/策略容器化自動交易平台-的副本/shared/strategies/kamaRainbowMartinExecutionPolicy.ts";

const BASELINE_S1_JOB = "job_1785647779212_c5d6df85";
const BASELINE_M2_JOB = "job_1785646858931_95c6b036";
const TERMINAL = new Set(["completed", "failed", "timeout", "cancelled"]);

type RerunMode = "S1" | "M2" | "H3";
type TradeEvidence = {
  deploymentMode?: RerunMode;
  role?: "PRIMARY" | "INDEPENDENT" | "HEDGE";
  cycleId?: string;
  legId?: string;
  triggerSource?: string;
  entryReason?: string;
  exitReason?: string;
  martinLayer?: number;
  pnl?: number;
};

function countBy(values: Array<string | number | undefined>): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    const key = value === undefined || value === "" ? "UNSPECIFIED" : String(value);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function summarizeTrades(trades: TradeEvidence[]) {
  return {
    totalTrades: trades.length,
    deploymentModes: countBy(trades.map((trade) => trade.deploymentMode)),
    roles: countBy(trades.map((trade) => trade.role)),
    triggerSources: countBy(trades.map((trade) => trade.triggerSource)),
    entryReasons: countBy(trades.map((trade) => trade.entryReason)),
    exitReasons: countBy(trades.map((trade) => trade.exitReason)),
    martinLayers: countBy(trades.map((trade) => trade.martinLayer)),
    uniqueCycles: new Set(trades.map((trade) => trade.cycleId).filter(Boolean)).size,
    uniqueLegs: new Set(trades.map((trade) => trade.legId).filter(Boolean)).size,
    realizedPnl: Number(trades.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0).toFixed(8)),
    firstFive: trades.slice(0, 5).map((trade) => ({
      deploymentMode: trade.deploymentMode,
      role: trade.role,
      cycleId: trade.cycleId,
      legId: trade.legId,
      triggerSource: trade.triggerSource,
      entryReason: trade.entryReason,
      exitReason: trade.exitReason,
      martinLayer: trade.martinLayer,
      pnl: trade.pnl,
    })),
  };
}

async function main() {
  await initStrategyStudio();
  const db = await getDb();
  if (!db) throw new Error("BACKTEST_DATABASE_UNAVAILABLE");
  const baselines = await db
    .select()
    .from(backtestJobs)
    .where(inArray(backtestJobs.jobId, [BASELINE_S1_JOB, BASELINE_M2_JOB]));
  const byId = new Map(baselines.map((row) => [row.jobId, row]));
  const s1 = byId.get(BASELINE_S1_JOB);
  const m2 = byId.get(BASELINE_M2_JOB);
  if (!s1?.requestSnapshot || !m2?.requestSnapshot) {
    throw new Error("KRM_BASELINE_SNAPSHOT_NOT_FOUND");
  }
  if (s1.userId !== m2.userId) throw new Error("KRM_BASELINE_OWNER_MISMATCH");

  const s1Request = structuredClone(s1.requestSnapshot) as BacktestRequest;
  const m2Request = structuredClone(m2.requestSnapshot) as BacktestRequest;
  const h3Request = structuredClone(m2Request) as BacktestRequest;
  h3Request.executionMode = "HEDGE_GUARDED";
  h3Request.executionPolicy = createDefaultStrategyExecutionPolicy(
    h3Request.strategyKey,
    "HEDGE_GUARDED",
  );

  const requests: Array<{ mode: RerunMode; request: BacktestRequest }> = [
    { mode: "S1", request: s1Request },
    { mode: "M2", request: m2Request },
    { mode: "H3", request: h3Request },
  ];

  const submitted: Array<{ mode: RerunMode; jobId: string }> = [];
  for (const item of requests) {
    const jobId = await backtestJobManager.submit(item.request, s1.userId, {
      timeoutSeconds: 1_800,
      strategyName: `Kama彩虹馬丁策略－KRM P0 ${item.mode} 重跑`,
      tradeAmount: Number(item.request.config?.Position_Size_Value ?? 100),
    });
    submitted.push({ mode: item.mode, jobId });
    console.log(`[KRM_RERUN_SUBMITTED] ${item.mode} ${jobId}`);
  }

  const startedAt = Date.now();
  let lastLogAt = 0;
  while (Date.now() - startedAt < 35 * 60_000) {
    const rows = await Promise.all(
      submitted.map(async (item) => ({
        ...item,
        row: await backtestJobManager.getJobResultFromDB(item.jobId, s1.userId),
      })),
    );
    if (rows.every((item) => item.row && TERMINAL.has(item.row.status))) {
      const evidence = rows.map((item) => {
        const trades = Array.isArray(item.row.tradesData)
          ? item.row.tradesData as TradeEvidence[]
          : [];
        return {
          mode: item.mode,
          jobId: item.jobId,
          status: item.row.status,
          phase: item.row.phase,
          errorCode: item.row.errorCode,
          error: item.row.error,
          candleCount: item.row.candleCount,
          metrics: item.row.metrics,
          accounting: item.row.accounting,
          modeResults: item.row.modeResults,
          legAccounting: item.row.legAccounting,
          trades: summarizeTrades(trades),
        };
      });
      console.log("KRM_RERUN_EVIDENCE_START");
      console.log(JSON.stringify({
        baselineJobs: { S1: BASELINE_S1_JOB, M2: BASELINE_M2_JOB },
        rerunAt: new Date().toISOString(),
        evidence,
      }, null, 2));
      console.log("KRM_RERUN_EVIDENCE_END");
      process.exit(evidence.every((item) => item.status === "completed") ? 0 : 2);
    }
    if (Date.now() - lastLogAt > 15_000) {
      lastLogAt = Date.now();
      console.log("[KRM_RERUN_PROGRESS]", rows.map((item) => ({
        mode: item.mode,
        jobId: item.jobId,
        status: item.row?.status,
        phase: item.row?.phase,
        progress: item.row?.progress,
        processedBars: item.row?.processedBars,
        totalBars: item.row?.totalBars,
      })));
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("KRM_RERUN_TIMEOUT");
}

main().catch((error) => {
  console.error("KRM_RERUN_FAILED", error);
  process.exit(1);
});
