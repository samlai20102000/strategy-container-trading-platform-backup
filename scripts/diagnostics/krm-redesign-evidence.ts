import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { inArray } from "drizzle-orm";
import { backtestJobs } from "/home/ubuntu/策略容器化自動交易平台-的副本/drizzle/schema.ts";
import { getDb } from "/home/ubuntu/策略容器化自動交易平台-的副本/server/db.ts";

const PROJECT_ROOT = "/home/ubuntu/策略容器化自動交易平台-的副本";
const M2_CSV = "/home/ubuntu/upload/pasted_file_ujurhV_backtest_bt-3m-1433034275-1785627000000(1).csv";
const SQLITE_PATH = path.join(PROJECT_ROOT, "data/backtest_data.db");
const M2_RUN_ID = "bt-3m-1433034275-1785627000000";

const JOB_IDS = [
  "job_1785647779212_c5d6df85",
  "job_1785646858931_95c6b036",
  "job_1785654375277_2786d336",
  "job_1785654377051_95393c64",
  "job_1785654377496_829afe74",
] as const;

type CsvRow = Record<string, string>;

function parseCsv(filePath: string): CsvRow[] {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
  const [headerLine, ...lines] = raw.split(/\r?\n/);
  const headers = headerLine.split(",");
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function parseDisplayTime(value: string): number {
  const parts = value.split(/[\/ :]/).map(Number);
  const [year, month, day, hour, minute, second] = parts;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortObject(nested)]),
    );
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortObject(left)) === JSON.stringify(sortObject(right));
}

function collectDiffs(
  left: unknown,
  right: unknown,
  currentPath = "$",
  output: Array<{ path: string; left: unknown; right: unknown }> = [],
): Array<{ path: string; left: unknown; right: unknown }> {
  if (deepEqual(left, right)) return output;
  if (
    left && right &&
    typeof left === "object" && typeof right === "object" &&
    !Array.isArray(left) && !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    for (const key of [...keys].sort()) {
      collectDiffs(leftRecord[key], rightRecord[key], `${currentPath}.${key}`, output);
    }
    return output;
  }
  output.push({ path: currentPath, left, right });
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function pickScalars(value: unknown, keys: string[]): Record<string, unknown> {
  const record = asRecord(value);
  return Object.fromEntries(keys.map((key) => [key, record[key] ?? null]));
}

function valueShape(value: unknown): unknown {
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (value && typeof value === "object") {
    return { type: "object", keys: Object.keys(value as Record<string, unknown>).sort() };
  }
  return value;
}

function summarizeCsv(rows: CsvRow[]) {
  const cycles = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const cycleId = row["Cycle ID"];
    cycles.set(cycleId, [...(cycles.get(cycleId) ?? []), row]);
  }

  const cyclePairs = [...cycles.entries()].map(([cycleId, cycleRows]) => {
    const s1 = cycleRows.find((row) => row["部署模式"] === "S1");
    const m2 = cycleRows.find((row) => row["部署模式"] === "M2");
    const closeGapHours = s1 && m2
      ? Math.abs(parseDisplayTime(s1["時間"]) - parseDisplayTime(m2["時間"])) / 3_600_000
      : null;
    return {
      cycleId,
      rows: cycleRows.length,
      s1Close: s1?.["時間"] ?? null,
      m2Close: m2?.["時間"] ?? null,
      closeGapHours,
      sameCloseTimestamp: closeGapHours === 0,
      s1Pnl: s1 ? Number(s1["盈虧"]) : null,
      m2Pnl: m2 ? Number(m2["盈虧"]) : null,
    };
  });

  return {
    rowCount: rows.length,
    deploymentModes: countBy(rows.map((row) => row["部署模式"])),
    roles: countBy(rows.map((row) => row["腿角色"])),
    entryReasons: countBy(rows.map((row) => row["開倉原因"])),
    exitReasons: countBy(rows.map((row) => row["平倉原因"])),
    martinLayers: countBy(rows.map((row) => row["馬丁層數"])),
    realizedPnl: Number(rows.reduce((sum, row) => sum + Number(row["盈虧"]), 0).toFixed(2)),
    s1RealizedPnl: Number(rows
      .filter((row) => row["部署模式"] === "S1")
      .reduce((sum, row) => sum + Number(row["盈虧"]), 0)
      .toFixed(2)),
    m2RealizedPnl: Number(rows
      .filter((row) => row["部署模式"] === "M2")
      .reduce((sum, row) => sum + Number(row["盈虧"]), 0)
      .toFixed(2)),
    uniqueCycles: cycles.size,
    pairedCycles: cyclePairs.filter((cycle) => cycle.s1Close && cycle.m2Close).length,
    jointlyClosedCycles: cyclePairs.filter((cycle) => cycle.sameCloseTimestamp).length,
    maxCloseGapDays: Number((Math.max(
      ...cyclePairs.map((cycle) => cycle.closeGapHours ?? 0),
    ) / 24).toFixed(3)),
    cyclePairs,
  };
}

function summarizeSqlite() {
  const sqlite = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
  try {
    const run = sqlite.prepare(`
      SELECT run_id, strategy_key, symbol, timeframe, start_date, end_date,
             initial_capital, status, created_at, config, execution_context,
             mode_results, leg_accounting
      FROM backtest_runs
      WHERE run_id = ?
    `).get(M2_RUN_ID) as Record<string, unknown> | undefined;
    const trades = sqlite.prepare(`
      SELECT entry_time, exit_time, side, entry_price, exit_price, size, pnl,
             pnl_pct, exit_reason, martin_layer, leg_id, cycle_id, role,
             deployment_mode, trigger_source, entry_reason
      FROM backtest_trades
      WHERE run_id = ?
      ORDER BY exit_time ASC, id ASC
    `).all(M2_RUN_ID) as Array<Record<string, unknown>>;
    const performance = sqlite.prepare(`
      SELECT metrics, equity_curve, created_at
      FROM performance_metrics
      WHERE run_id = ?
    `).get(M2_RUN_ID) as Record<string, unknown> | undefined;

    const parsedExecutionContext = run?.execution_context
      ? JSON.parse(String(run.execution_context))
      : null;
    const parsedModeResults = run?.mode_results
      ? JSON.parse(String(run.mode_results))
      : null;
    const parsedLegAccounting = run?.leg_accounting
      ? JSON.parse(String(run.leg_accounting))
      : null;

    return {
      run: run ? {
        runId: run.run_id,
        strategyKey: run.strategy_key,
        symbol: run.symbol,
        timeframe: run.timeframe,
        startDate: run.start_date,
        endDate: run.end_date,
        initialCapital: run.initial_capital,
        status: run.status,
        createdAt: run.created_at,
        configShape: valueShape(JSON.parse(String(run.config))),
        executionContextShape: valueShape(parsedExecutionContext),
        modeResultsShape: valueShape(parsedModeResults),
        legAccountingSummary: {
          shape: valueShape(parsedLegAccounting),
          ...pickScalars(parsedLegAccounting, [
            "version",
            "cycleCount",
            "closedLegCount",
            "openLegCount",
            "rejectedDecisionCount",
            "overlapDurationMs",
            "turnover",
          ]),
        },
      } : null,
      tradeCount: trades.length,
      trades,
      performance: performance ? {
        metrics: JSON.parse(String(performance.metrics)),
        equityCurvePoints: JSON.parse(String(performance.equity_curve)).length,
        createdAt: performance.created_at,
      } : null,
    };
  } finally {
    sqlite.close();
  }
}

async function summarizeJobs() {
  const db = await getDb();
  if (!db) throw new Error("BACKTEST_DATABASE_UNAVAILABLE");
  const rows = await db
    .select()
    .from(backtestJobs)
    .where(inArray(backtestJobs.jobId, [...JOB_IDS]));
  const byId = new Map(rows.map((row) => [row.jobId, row]));
  const s1 = byId.get("job_1785654375277_2786d336");
  const m2 = byId.get("job_1785654377051_95393c64");
  const snapshotDiffs = collectDiffs(s1?.requestSnapshot, m2?.requestSnapshot);

  return {
    jobs: rows.map((row) => ({
      jobId: row.jobId,
      status: row.status,
      strategyKey: row.strategyKey,
      symbol: row.symbol,
      timeframe: row.timeframe,
      startDate: row.startDate,
      endDate: row.endDate,
      initialCapital: row.initialCapital,
      tradeAmount: row.tradeAmount,
      executionMode: row.executionMode,
      executionPolicy: row.executionPolicy,
      endPositionPolicy: row.endPositionPolicy,
      logicHash: row.logicHash,
      candleCount: row.candleCount,
      metrics: row.metrics,
      modeResultsShape: valueShape(row.modeResults),
      legAccountingSummary: {
        shape: valueShape(row.legAccounting),
        ...pickScalars(row.legAccounting, [
          "version",
          "cycleCount",
          "closedLegCount",
          "openLegCount",
          "rejectedDecisionCount",
          "overlapDurationMs",
          "turnover",
        ]),
      },
      accounting: pickScalars(row.accounting, [
        "balanced",
        "reconciled",
        "initialCapital",
        "realizedPnl",
        "unrealizedPnl",
        "finalEquity",
        "expectedFinalEquity",
        "reconciliationDifference",
        "openPositionCount",
        "grossExposure",
        "netExposure",
        "marginLiquidationCount",
        "syntheticForceCloseCount",
        "bankrupt",
      ]),
      dataQuality: pickScalars(row.dataQuality, [
        "inputCandles",
        "returnedCandles",
        "candleCount",
        "firstTimestamp",
        "lastTimestamp",
        "requestedStartMs",
        "requestedEndMs",
        "duplicateCandlesRemoved",
        "invalidCandlesRemoved",
        "unclosedCandlesRemoved",
      ]),
      engineSemantics: row.engineSemantics,
      tradeCount: Array.isArray(row.tradesData) ? row.tradesData.length : null,
    })),
    repairedRerunComparison: {
      s1JobId: s1?.jobId ?? null,
      m2JobId: m2?.jobId ?? null,
      sameConfig: deepEqual(s1?.config, m2?.config),
      sameSymbol: s1?.symbol === m2?.symbol,
      sameTimeframe: s1?.timeframe === m2?.timeframe,
      sameDateRange: s1?.startDate === m2?.startDate && s1?.endDate === m2?.endDate,
      sameInitialCapital: String(s1?.initialCapital) === String(m2?.initialCapital),
      sameTradeAmount: String(s1?.tradeAmount) === String(m2?.tradeAmount),
      sameEndPositionPolicy: s1?.endPositionPolicy === m2?.endPositionPolicy,
      sameCandleCount: s1?.candleCount === m2?.candleCount,
      sameLogicHash: s1?.logicHash === m2?.logicHash,
      requestSnapshotDiffCount: snapshotDiffs.length,
      requestSnapshotDiffs: snapshotDiffs,
    },
  };
}

async function main() {
  const csvRows = parseCsv(M2_CSV);
  const result = {
    generatedAt: new Date().toISOString(),
    safety: "READ_ONLY_DIAGNOSTIC_NO_LIVE_TRADE_MUTATION",
    csv: summarizeCsv(csvRows),
    sqlite: summarizeSqlite(),
    mysql: await summarizeJobs(),
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error("KRM_REDESIGN_EVIDENCE_FAILED", error);
  process.exitCode = 1;
});
