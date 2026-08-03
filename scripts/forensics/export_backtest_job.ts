import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

type EquityPoint = {
  timestamp: number;
  equity: number;
  price: number;
};

type Trade = {
  id: number;
  cycleId?: string;
  entryTime: number;
  exitTime: number;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPct: number;
  exitReason: string;
  martinLayer: number;
};

type JobRow = {
  jobId: string;
  strategyKey: string;
  symbol: string;
  timeframe: string;
  initialCapital: string | number;
  startDate: number;
  endDate: number;
  config: unknown;
  metrics: unknown;
  tradesData: Trade[] | string;
  equityCurve: EquityPoint[] | string;
  accounting: unknown;
  dataQuality: unknown;
  executionContext: unknown;
  engineSemantics: unknown;
  environment: unknown;
  createdAt: Date;
  completedAt: Date;
};

const JOB_ID = process.argv[2] ?? "job_1785770356467_b7fe7008";
const OUTPUT_DIR = path.resolve("artifacts/backtest-100dd");

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function asIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL 未注入；拒絕以其他來源猜測資料");

  const connection = await mysql.createConnection(databaseUrl);
  try {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT jobId, strategyKey, symbol, timeframe, initialCapital, startDate, endDate,
              config, metrics, tradesData, equityCurve, accounting, dataQuality,
              executionContext, engineSemantics, environment, createdAt, completedAt
         FROM backtest_jobs
        WHERE jobId = ?
        LIMIT 1`,
      [JOB_ID],
    );
    if (rows.length !== 1) throw new Error(`找不到回測 job: ${JOB_ID}`);

    const row = rows[0] as JobRow & mysql.RowDataPacket;
    const equityCurve = parseJson<EquityPoint[]>(row.equityCurve);
    const trades = parseJson<Trade[]>(row.tradesData);
    const initialCapital = Number(row.initialCapital);
    if (!Array.isArray(equityCurve) || equityCurve.length === 0) {
      throw new Error("equityCurve 為空，無法進行回撤法證");
    }

    let runningPeak = initialCapital;
    let peakIndex = -1;
    let maximumDrawdown = -Infinity;
    let maximumDrawdownUsdt = -Infinity;
    let maximumDrawdownIndex = -1;
    let minimumEquityIndex = 0;
    let firstNonPositiveIndex = -1;
    let nonPositiveCount = 0;

    const enriched = equityCurve.map((point, index) => {
      if (point.equity > runningPeak) {
        runningPeak = point.equity;
        peakIndex = index;
      }
      if (point.equity < equityCurve[minimumEquityIndex].equity) minimumEquityIndex = index;
      if (point.equity <= 0) {
        nonPositiveCount += 1;
        if (firstNonPositiveIndex < 0) firstNonPositiveIndex = index;
      }
      const boundedEquity = Math.max(0, point.equity);
      const drawdownUsdt = Math.max(0, runningPeak - boundedEquity);
      const drawdownPct = runningPeak > 0 ? Math.min(100, drawdownUsdt / runningPeak * 100) : 0;
      if (drawdownPct > maximumDrawdown) {
        maximumDrawdown = drawdownPct;
        maximumDrawdownUsdt = drawdownUsdt;
        maximumDrawdownIndex = index;
      }
      return {
        ...point,
        index,
        timestampIso: asIso(point.timestamp),
        runningPeak,
        runningPeakIndex: peakIndex,
        drawdownUsdt,
        drawdownPct,
      };
    });

    const eventIndex = firstNonPositiveIndex >= 0 ? firstNonPositiveIndex : minimumEquityIndex;
    const eventPoint = equityCurve[eventIndex];
    const activeTradesByTime = trades
      .filter(trade => trade.entryTime <= eventPoint.timestamp && eventPoint.timestamp <= trade.exitTime)
      .map(trade => ({
        ...trade,
        entryTimeIso: asIso(trade.entryTime),
        exitTimeIso: asIso(trade.exitTime),
        entryNotional: trade.entryPrice * trade.size,
        markGrossPnlAtEvent: trade.side === "long"
          ? (eventPoint.price - trade.entryPrice) * trade.size
          : (trade.entryPrice - eventPoint.price) * trade.size,
      }));

    const nearestTrade = trades
      .map(trade => ({
        trade,
        distanceMs: Math.min(
          Math.abs(trade.entryTime - eventPoint.timestamp),
          Math.abs(trade.exitTime - eventPoint.timestamp),
        ),
      }))
      .sort((a, b) => a.distanceMs - b.distanceMs)[0];

    const before = Math.max(0, eventIndex - 10);
    const after = Math.min(enriched.length, eventIndex + 11);
    const maxDdPoint = enriched[maximumDrawdownIndex];
    const peakPoint = maxDdPoint.runningPeakIndex >= 0
      ? enriched[maxDdPoint.runningPeakIndex]
      : { timestamp: row.startDate, timestampIso: asIso(row.startDate), equity: initialCapital, price: null };

    const forensicSummary = {
      job: {
        jobId: row.jobId,
        strategyKey: row.strategyKey,
        symbol: row.symbol,
        timeframe: row.timeframe,
        initialCapital,
        startDate: row.startDate,
        startDateIso: asIso(row.startDate),
        endDate: row.endDate,
        endDateIso: asIso(row.endDate),
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        config: parseJson(row.config),
        metrics: parseJson(row.metrics),
        accounting: parseJson(row.accounting),
        dataQuality: parseJson(row.dataQuality),
        executionContext: parseJson(row.executionContext),
        engineSemantics: parseJson(row.engineSemantics),
        environment: parseJson(row.environment),
      },
      counts: {
        trades: trades.length,
        equityPoints: equityCurve.length,
        nonPositiveEquityPoints: nonPositiveCount,
      },
      pathForensics: {
        minimumEquity: enriched[minimumEquityIndex],
        firstNonPositiveEquity: firstNonPositiveIndex >= 0 ? enriched[firstNonPositiveIndex] : null,
        maximumDrawdown: maxDdPoint,
        maximumDrawdownPeak: peakPoint,
        independentlyCalculatedMaximumDrawdownPct: maximumDrawdown,
        independentlyCalculatedMaximumDrawdownUsdt: maximumDrawdownUsdt,
        activeClosedTradeRecordsAtEvent: activeTradesByTime,
        nearestTradeRecord: nearestTrade
          ? {
              ...nearestTrade.trade,
              entryTimeIso: asIso(nearestTrade.trade.entryTime),
              exitTimeIso: asIso(nearestTrade.trade.exitTime),
              distanceMs: nearestTrade.distanceMs,
            }
          : null,
        windowAroundFirstInsolvencyOrMinimum: enriched.slice(before, after),
      },
    };

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(OUTPUT_DIR, `${JOB_ID}_forensic_summary.json`),
        JSON.stringify(forensicSummary, null, 2),
        "utf8",
      ),
      fs.writeFile(
        path.join(OUTPUT_DIR, `${JOB_ID}_equity_curve.json`),
        JSON.stringify(enriched, null, 2),
        "utf8",
      ),
      fs.writeFile(
        path.join(OUTPUT_DIR, `${JOB_ID}_trades.json`),
        JSON.stringify(trades, null, 2),
        "utf8",
      ),
    ]);

    console.log(JSON.stringify({
      jobId: JOB_ID,
      minimumEquity: enriched[minimumEquityIndex],
      firstNonPositiveEquity: firstNonPositiveIndex >= 0 ? enriched[firstNonPositiveIndex] : null,
      maximumDrawdown: maxDdPoint,
      maximumDrawdownPeak: peakPoint,
      activeClosedTradeRecordsAtEvent: activeTradesByTime,
      outputDir: OUTPUT_DIR,
    }, null, 2));
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
