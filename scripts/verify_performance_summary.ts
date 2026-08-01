import { asc } from "drizzle-orm";
import { strategies, trades } from "../drizzle/schema";
import { getDb } from "../server/db";
import { summarizeStrategyPerformance } from "../server/services/performanceSummary";
import { buildStrategySummaries } from "../server/services/tradeReportGenerator";
import { fetchAllTradeJournalRows, type TradeJournalRow } from "../server/services/tradeJournalQuery";

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateArgument(name: "start" | "end"): Date | null {
  const raw = process.argv.find(argument => argument.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  if (!raw) return null;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new Error(`無效的 --${name} 日期：${raw}`);
  return date;
}

const startTime = dateArgument("start");
const endTime = dateArgument("end");

const database = await getDb();
if (!database) throw new Error("資料庫不可用");

const [strategyRows, tradeRows] = await Promise.all([
  database.select().from(strategies).orderBy(asc(strategies.userId), asc(strategies.id)),
  database.select().from(trades).orderBy(asc(trades.userId), asc(trades.strategyId), asc(trades.createdAt)),
]);

const scopedTradeRows = tradeRows.filter(trade => {
  const createdAt = new Date(trade.createdAt).getTime();
  return (!startTime || createdAt >= startTime.getTime())
    && (!endTime || createdAt <= endTime.getTime());
});

const rows = strategyRows.map(strategy => {
  const strategyTrades = scopedTradeRows.filter(
    trade => trade.userId === strategy.userId && trade.strategyId === strategy.id,
  );
  const oldKnownRows = strategyTrades.filter(trade => finiteNumber(trade.realizedPnl) !== null);
  const oldWins = oldKnownRows.filter(trade => (finiteNumber(trade.realizedPnl) ?? 0) > 0).length;
  const summary = summarizeStrategyPerformance(strategyTrades);
  const closeQuality = new Map<string, number>();
  for (const trade of strategyTrades) {
    if (trade.reduceOnly !== true || trade.status !== "filled") continue;
    const netPnl = finiteNumber(trade.netRealizedPnl);
    const legacyPnl = finiteNumber(trade.realizedPnl);
    const pnl = netPnl ?? legacyPnl;
    if (pnl === null) continue;
    const pnlField = netPnl !== null && legacyPnl !== null
      ? "net+realized"
      : netPnl !== null
        ? "net-only"
        : "realized-only";
    const sign = pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven";
    const key = [trade.dataQuality, trade.reconciliationStatus, trade.pnlSource, pnlField, sign].join("|");
    closeQuality.set(key, (closeQuality.get(key) ?? 0) + 1);
  }

  return {
    userId: strategy.userId,
    strategyId: strategy.id,
    strategyName: strategy.name,
    rawRows: strategyTrades.length,
    old: {
      denominator: oldKnownRows.length,
      wins: oldWins,
      nonWins: oldKnownRows.length - oldWins,
      winRatePct: oldKnownRows.length > 0 ? (oldWins / oldKnownRows.length) * 100 : null,
    },
    corrected: summary,
    knownCloseQuality: Array.from(closeQuality.entries()).map(([key, count]) => {
      const [dataQuality, reconciliationStatus, pnlSource, pnlField, sign] = key.split("|");
      return { dataQuality, reconciliationStatus, pnlSource, pnlField, sign, count };
    }),
  };
});

const totalOldDenominator = rows.reduce((sum, row) => sum + row.old.denominator, 0);
const totalOldWins = rows.reduce((sum, row) => sum + row.old.wins, 0);
const totalWins = rows.reduce((sum, row) => sum + row.corrected.wins, 0);
const totalLosses = rows.reduce((sum, row) => sum + row.corrected.losses, 0);
const totalDecisive = totalWins + totalLosses;
const reportPages = await Promise.all(
  Array.from(new Set(strategyRows.map(strategy => strategy.userId))).map(userId =>
    fetchAllTradeJournalRows(userId, {
      strategyIds: strategyRows
        .filter(strategy => strategy.userId === userId)
        .map(strategy => strategy.id),
      startTime: startTime ?? undefined,
      endTime: endTime ?? undefined,
    }),
  ),
);
const reportRows = reportPages.flatMap(page => page.rows).filter((row): row is TradeJournalRow => row !== undefined);
const reportSummaries = buildStrategySummaries(reportRows);
const reportByStrategy = new Map<number, typeof reportTotals>();
for (const report of reportSummaries) {
  if (report.strategyId === null) continue;
  const current = reportByStrategy.get(report.strategyId) ?? {
    knownCloses: 0,
    decisiveTradeCount: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
  };
  current.knownCloses += report.knownPnlCount;
  current.decisiveTradeCount += report.decisivePnlCount;
  current.wins += report.winCount;
  current.losses += report.lossCount;
  current.breakevens += report.breakevenCount;
  reportByStrategy.set(report.strategyId, current);
}
const reportTotals = {
  knownCloses: reportSummaries.reduce((sum, row) => sum + row.knownPnlCount, 0),
  decisiveTradeCount: reportSummaries.reduce((sum, row) => sum + row.decisivePnlCount, 0),
  wins: reportSummaries.reduce((sum, row) => sum + row.winCount, 0),
  losses: reportSummaries.reduce((sum, row) => sum + row.lossCount, 0),
  breakevens: reportSummaries.reduce((sum, row) => sum + row.breakevenCount, 0),
};
const dashboardTotals = {
  knownCloses: rows.reduce((sum, row) => sum + row.corrected.closedTradeCount, 0),
  decisiveTradeCount: totalDecisive,
  wins: totalWins,
  losses: totalLosses,
  breakevens: rows.reduce((sum, row) => sum + row.corrected.breakevens, 0),
};
const strategyComparisons = rows.map(row => {
  const dashboard = {
    knownCloses: row.corrected.closedTradeCount,
    decisiveTradeCount: row.corrected.decisiveTradeCount,
    wins: row.corrected.wins,
    losses: row.corrected.losses,
    breakevens: row.corrected.breakevens,
  };
  const report = reportByStrategy.get(row.strategyId) ?? {
    knownCloses: 0,
    decisiveTradeCount: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
  };
  return {
    strategyId: row.strategyId,
    strategyName: row.strategyName,
    dashboard,
    report,
    matches: JSON.stringify(dashboard) === JSON.stringify(report),
  };
});

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  filters: {
    startTime: startTime?.toISOString() ?? null,
    endTime: endTime?.toISOString() ?? null,
  },
  strategies: rows,
  strategyComparisons,
  total: {
    rawRows: rows.reduce((sum, row) => sum + row.rawRows, 0),
    old: {
      denominator: totalOldDenominator,
      wins: totalOldWins,
      nonWins: totalOldDenominator - totalOldWins,
      winRatePct: totalOldDenominator > 0 ? (totalOldWins / totalOldDenominator) * 100 : null,
    },
    corrected: {
      knownCloses: dashboardTotals.knownCloses,
      decisiveTradeCount: totalDecisive,
      wins: totalWins,
      losses: totalLosses,
      breakevens: dashboardTotals.breakevens,
      winRatePct: totalDecisive > 0 ? (totalWins / totalDecisive) * 100 : null,
      totalPnl: rows.reduce((sum, row) => sum + row.corrected.totalPnl, 0),
      pendingPnlCount: rows.reduce((sum, row) => sum + row.corrected.pendingPnlCount, 0),
      unresolvedPnlCount: rows.reduce((sum, row) => sum + row.corrected.unresolvedPnlCount, 0),
      excludedEntryCount: rows.reduce((sum, row) => sum + row.corrected.excludedEntryCount, 0),
      excludedNonFilledCloseCount: rows.reduce(
        (sum, row) => sum + row.corrected.excludedNonFilledCloseCount,
        0,
      ),
      duplicateExcludedCount: rows.reduce(
        (sum, row) => sum + row.corrected.duplicateExcludedCount,
        0,
      ),
    },
    report: reportTotals,
    invariants: {
      decisiveEqualsWinsPlusLosses: totalDecisive === totalWins + totalLosses,
      everyCurrentStrategyMatchesTradeReport: strategyComparisons.every(row => row.matches),
      dashboardMatchesTradeReport: JSON.stringify(dashboardTotals) === JSON.stringify(reportTotals),
    },
  },
}, null, 2));

process.exit(0);
