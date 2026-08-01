import ExcelJS from "exceljs";
import { Buffer } from "node:buffer";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { trades } from "../drizzle/schema";
import { getDb } from "../server/db";
import {
  fetchAllTradeJournalRows,
  queryTradeJournal,
  summarizeTradeJournal,
} from "../server/services/tradeJournalQuery";
import {
  buildTradeCsv,
  buildTradeReportData,
  buildTradeXlsx,
} from "../server/services/tradeReportGenerator";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const database = await getDb();
  invariant(database, "資料庫不可用");

  const ownerRows = await database
    .select({
      userId: trades.userId,
      orphanCount: sql<number>`COUNT(*)`,
    })
    .from(trades)
    .where(isNull(trades.signalId))
    .groupBy(trades.userId)
    .orderBy(desc(sql<number>`COUNT(*)`))
    .limit(1);
  const owner = ownerRows[0];
  invariant(owner, "真實資料庫目前沒有可驗收的孤兒成交");

  const targetTradeRows = await database
    .select({
      id: trades.id,
      userId: trades.userId,
      strategyId: trades.strategyId,
      signalId: trades.signalId,
      realizedPnl: trades.realizedPnl,
      netRealizedPnl: trades.netRealizedPnl,
    })
    .from(trades)
    .where(eq(trades.id, 180001))
    .limit(1);
  const targetTrade = targetTradeRows[0];
  invariant(targetTrade, "歷史成交 180001 不存在");

  const [page, summary, batchResult] = await Promise.all([
    queryTradeJournal(owner.userId, { limit: 5_000 }),
    summarizeTradeJournal(owner.userId, {}),
    fetchAllTradeJournalRows(owner.userId, {}),
  ]);
  const rows = batchResult.rows ?? [];
  const orphanRows = rows.filter(row => row.linkage === "orphan_trade");
  const knownOrphans = orphanRows.filter(row => row.pnlState === "known");
  const targetUserRows = targetTrade.userId === owner.userId
    ? rows
    : ((await fetchAllTradeJournalRows(targetTrade.userId, {})).rows ?? []);
  const target = targetUserRows.find(row => row.tradeId === targetTrade.id);

  invariant(page.total === summary.totalRows, "列表與預檢總筆數不一致");
  invariant(rows.length === summary.totalRows, "全量批次與預檢總筆數不一致");
  invariant(orphanRows.length === Number(owner.orphanCount), "孤兒成交筆數與資料庫事實不一致");
  invariant(orphanRows.every(row => row.signalId === null), "孤兒成交被偽造 signalId");
  invariant(orphanRows.every(row => row.dataQuality === "legacy_orphan_trade"), "孤兒成交缺少明確資料品質");
  invariant(target, "歷史成交 180001 未納入其資料擁有者的 journal");
  invariant(Math.abs(Number(target.grossPnl) - 1.56986) < 1e-10, "歷史成交 180001 的 +1.56986 USDT 毛利真值不符");
  invariant(
    Math.abs(Number(target.realizedPnl) - Number(targetTrade.netRealizedPnl)) < 1e-10,
    "歷史成交 180001 的費用後淨已實現盈虧真值不符",
  );

  const orphanReport = buildTradeReportData(rows, {});
  const orphanCsv = buildTradeCsv(orphanReport);
  const targetCsv = targetTrade.userId === owner.userId
    ? orphanCsv
    : buildTradeCsv(buildTradeReportData(targetUserRows, {}));
  invariant(targetCsv.toString("utf8").includes("1.56986"), "CSV 遺漏 +1.56986 USDT 毛利");
  invariant(orphanCsv.toString("utf8").includes("orphan_trade"), "CSV 遺漏 orphan_trade 關聯標記");

  const xlsx = await buildTradeXlsx(orphanReport);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx as any);
  invariant(
    workbook.worksheets.map((sheet: ExcelJS.Worksheet) => sheet.name).join("|") === "交易明細|交易循環|策略摘要|資料品質",
    "XLSX 四工作表結構不符",
  );

  console.log(JSON.stringify({
    userId: owner.userId,
    totalRows: summary.totalRows,
    orphanRows: orphanRows.length,
    knownOrphanRows: knownOrphans.length,
    totalRealizedPnl: summary.totalRealizedPnl,
    targetTradeId: target.tradeId,
    targetSignalId: target.signalId,
    targetGrossPnl: target.grossPnl,
    targetNetRealizedPnl: target.realizedPnl,
    targetLinkage: target.linkage,
    targetDataQuality: target.dataQuality,
    csvBytes: orphanCsv.length,
    xlsxBytes: xlsx.length,
    sheets: workbook.worksheets.map((sheet: ExcelJS.Worksheet) => sheet.name),
  }, null, 2));
  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
