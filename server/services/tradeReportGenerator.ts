import ExcelJS from "exceljs";
import { Buffer } from "node:buffer";

import { storagePut } from "../storage.ts";
import {
  fetchAllTradeJournalRows,
  normalizeTradeJournalFilters,
  type TradeJournalFilters,
  type TradeJournalRow,
} from "./tradeJournalQuery";
import { summarizeStrategyPerformance } from "./performanceSummary";

export type TradeReportFormat = "xlsx" | "csv";

export class EmptyTradeReportError extends Error {
  constructor() {
    super("目前篩選條件沒有可匯出的交易資料");
    this.name = "EmptyTradeReportError";
  }
}

type ReportPnlState = "known" | "pending" | "unresolved" | "not_applicable";

export interface TradeCycleReportRow {
  cycleId: string;
  strategyId: number | null;
  strategyName: string;
  strategyKey: string;
  exchange: string;
  symbol: string;
  direction: "LONG" | "SHORT" | "UNKNOWN";
  openedAt: Date | null;
  lastActivityAt: Date | null;
  entryCount: number;
  closeCount: number;
  totalEntrySize: number;
  totalCloseSize: number;
  remainingSize: number;
  averageEntryPrice: number | null;
  averageClosePrice: number | null;
  grossPnl: number | null;
  fee: number | null;
  fundingFee: number | null;
  netRealizedPnl: number | null;
  pnlCurrency: string;
  pnlState: ReportPnlState;
  status: "持倉中" | "部分平倉" | "已平倉" | "資料不足";
  dataQuality: string;
  pnlSources: string;
}

export interface StrategyReportSummary {
  strategyId: number | null;
  strategyName: string;
  strategyKey: string;
  exchange: string;
  signalCount: number;
  executedCount: number;
  failedCount: number;
  skippedCount: number;
  tradeCount: number;
  closeCount: number;
  knownPnlCount: number;
  decisivePnlCount: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  winRatePct: number | null;
  grossPnl: number;
  fee: number;
  fundingFee: number;
  netRealizedPnl: number;
  pendingCount: number;
  unresolvedCount: number;
}

export interface DataQualityReportRow {
  dataQuality: string;
  pnlSource: string;
  reconciliationStatus: string;
  pnlState: ReportPnlState;
  linkage: string;
  rowCount: number;
  percentage: number;
}

export interface TradeReportData {
  rows: TradeJournalRow[];
  cycles: TradeCycleReportRow[];
  strategies: StrategyReportSummary[];
  quality: DataQualityReportRow[];
  generatedAt: Date;
  filters: TradeJournalFilters;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumKnown(values: unknown[]): number | null {
  const known = values.map(numeric).filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

function weightedAverage(rows: TradeJournalRow[], sizeKey: "filledSize", priceKey: "filledPrice") {
  let weightedTotal = 0;
  let totalSize = 0;
  for (const row of rows) {
    const size = numeric(row[sizeKey]);
    const price = numeric(row[priceKey]);
    if (size === null || price === null || size <= 0) continue;
    weightedTotal += size * price;
    totalSize += size;
  }
  return totalSize > 0 ? weightedTotal / totalSize : null;
}

function worstPnlState(rows: TradeJournalRow[]): ReportPnlState {
  if (rows.some(row => row.pnlState === "unresolved")) return "unresolved";
  if (rows.some(row => row.pnlState === "pending")) return "pending";
  if (rows.some(row => row.pnlState === "known")) return "known";
  return "not_applicable";
}

function compactValues(values: Array<string | null | undefined>, fallback = "未提供") {
  const unique = Array.from(new Set(values.filter((value): value is string => Boolean(value))));
  return unique.length > 0 ? unique.join("、") : fallback;
}

function cycleFallbackKey(row: TradeJournalRow) {
  return `legacy:${row.strategyId ?? "unknown"}:${row.parsedSymbol ?? "unknown"}:${row.tradeId ?? row.signalId}`;
}

export function buildTradeCycles(rows: TradeJournalRow[]): TradeCycleReportRow[] {
  const groups = new Map<string, TradeJournalRow[]>();
  for (const row of rows) {
    if (!row.tradeId) continue;
    const key = row.cycleId || cycleFallbackKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return Array.from(groups.entries()).map(([cycleId, group]) => {
    const sorted = [...group].sort(
      (a, b) => new Date(a.filledAt ?? a.createdAt).getTime() - new Date(b.filledAt ?? b.createdAt).getTime(),
    );
    const entries = sorted.filter(row => !row.reduceOnly);
    const closes = sorted.filter(row => row.reduceOnly);
    const totalEntrySize = entries.reduce((sum, row) => sum + (numeric(row.filledSize) ?? 0), 0);
    const totalCloseSize = closes.reduce((sum, row) => sum + (numeric(row.filledSize) ?? 0), 0);
    const remainingSize = Math.max(totalEntrySize - totalCloseSize, 0);
    const epsilon = Math.max(totalEntrySize * 1e-8, 1e-12);
    const status: TradeCycleReportRow["status"] = totalEntrySize <= 0
      ? "資料不足"
      : totalCloseSize <= epsilon
        ? "持倉中"
        : remainingSize > epsilon
          ? "部分平倉"
          : "已平倉";
    const first = sorted[0];
    const last = sorted.at(-1)!;
    const side = entries[0]?.tradeSide;
    const direction: TradeCycleReportRow["direction"] = side === "buy"
      ? "LONG"
      : side === "sell"
        ? "SHORT"
        : "UNKNOWN";

    return {
      cycleId,
      strategyId: first.strategyId,
      strategyName: first.strategyName ?? `策略 #${first.strategyId ?? "未知"}`,
      strategyKey: first.strategyKey ?? "未提供",
      exchange: first.exchange ?? "未提供",
      symbol: first.parsedSymbol ?? "未提供",
      direction,
      openedAt: first ? new Date(first.filledAt ?? first.createdAt) : null,
      lastActivityAt: last ? new Date(last.filledAt ?? last.createdAt) : null,
      entryCount: entries.length,
      closeCount: closes.length,
      totalEntrySize,
      totalCloseSize,
      remainingSize,
      averageEntryPrice: weightedAverage(entries, "filledSize", "filledPrice"),
      averageClosePrice: weightedAverage(closes, "filledSize", "filledPrice"),
      grossPnl: sumKnown(closes.map(row => row.grossPnl)),
      fee: sumKnown(group.map(row => row.fee)),
      fundingFee: sumKnown(group.map(row => row.fundingFee)),
      netRealizedPnl: sumKnown(closes.map(row => row.realizedPnl)),
      pnlCurrency: compactValues(closes.map(row => row.pnlCurrency), "USDT"),
      pnlState: worstPnlState(closes.length > 0 ? closes : group),
      status,
      dataQuality: compactValues(group.map(row => row.dataQuality)),
      pnlSources: compactValues(closes.map(row => row.pnlSource)),
    };
  }).sort((a, b) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0));
}

export function buildStrategySummaries(rows: TradeJournalRow[]): StrategyReportSummary[] {
  const groups = new Map<string, TradeJournalRow[]>();
  for (const row of rows) {
    const key = `${row.strategyId ?? "unknown"}:${row.strategyKey ?? row.strategyName ?? "unknown"}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map(group => {
    const first = group[0];
    const signalRows = group.filter(row => row.signalId !== null);
    const tradeRows = group.filter(row => row.tradeId !== null);
    const closeRows = tradeRows.filter(row => row.reduceOnly);
    const performance = summarizeStrategyPerformance(tradeRows.map(row => ({
      id: row.tradeId,
      executionId: row.executionId,
      exchangeTradeId: row.exchangeTradeId,
      orderId: row.orderId,
      reduceOnly: row.reduceOnly,
      status: row.tradeStatus,
      realizedPnl: row.realizedPnl,
      reconciliationStatus: row.reconciliationStatus,
      dataQuality: row.dataQuality,
      createdAt: row.filledAt ?? row.createdAt,
    })));
    return {
      strategyId: first.strategyId,
      strategyName: first.strategyName ?? `策略 #${first.strategyId ?? "未知"}`,
      strategyKey: first.strategyKey ?? "未提供",
      exchange: compactValues(group.map(row => row.exchange)),
      signalCount: signalRows.length,
      executedCount: signalRows.filter(row => row.status === "executed").length,
      failedCount: signalRows.filter(row => row.status === "failed" || row.status === "rejected").length,
      skippedCount: signalRows.filter(row => row.status === "skipped").length,
      tradeCount: tradeRows.length,
      closeCount: closeRows.length,
      knownPnlCount: performance.closedTradeCount,
      decisivePnlCount: performance.decisiveTradeCount,
      winCount: performance.wins,
      lossCount: performance.losses,
      breakevenCount: performance.breakevens,
      winRatePct: performance.decisiveTradeCount > 0 ? performance.winRate : null,
      grossPnl: sumKnown(closeRows.map(row => row.grossPnl)) ?? 0,
      fee: sumKnown(tradeRows.map(row => row.fee)) ?? 0,
      fundingFee: sumKnown(tradeRows.map(row => row.fundingFee)) ?? 0,
      netRealizedPnl: performance.totalPnl,
      pendingCount: performance.pendingPnlCount,
      unresolvedCount: performance.unresolvedPnlCount,
    };
  }).sort((a, b) => a.strategyName.localeCompare(b.strategyName, "zh-Hant"));
}

export function buildDataQualityRows(rows: TradeJournalRow[]): DataQualityReportRow[] {
  const groups = new Map<string, Omit<DataQualityReportRow, "rowCount" | "percentage"> & { rowCount: number }>();
  for (const row of rows) {
    const values = {
      dataQuality: row.dataQuality ?? (row.tradeId ? "未提供" : "無成交"),
      pnlSource: row.pnlSource ?? (row.tradeId ? "未提供" : "無成交"),
      reconciliationStatus: row.reconciliationStatus ?? (row.tradeId ? "未提供" : "不適用"),
      pnlState: row.pnlState,
      linkage: row.linkage,
    };
    const key = Object.values(values).join("|");
    const current = groups.get(key);
    if (current) current.rowCount += 1;
    else groups.set(key, { ...values, rowCount: 1 });
  }
  return Array.from(groups.values())
    .map(row => ({ ...row, percentage: rows.length > 0 ? (row.rowCount / rows.length) * 100 : 0 }))
    .sort((a, b) => b.rowCount - a.rowCount);
}

export function buildTradeReportData(
  rows: TradeJournalRow[],
  filters: TradeJournalFilters,
  generatedAt = new Date(),
): TradeReportData {
  if (rows.length === 0) throw new EmptyTradeReportError();
  return {
    rows,
    cycles: buildTradeCycles(rows),
    strategies: buildStrategySummaries(rows),
    quality: buildDataQualityRows(rows),
    generatedAt,
    filters: normalizeTradeJournalFilters(filters),
  };
}

function safeSpreadsheetText(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function safeExcelCell(value: unknown): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
  return safeSpreadsheetText(value);
}

export function csvEscape(value: unknown) {
  const text = safeSpreadsheetText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : "";
}

const DETAIL_HEADERS = [
  "訊號ID", "成交ID", "執行ID", "交易循環ID", "策略ID", "策略名稱", "策略Key", "交易所",
  "訊號時間(UTC)", "成交時間(UTC)", "交易對", "訊號動作", "成交方向", "是否平倉", "訂單類型",
  "訊號狀態", "成交狀態", "來源", "觸發來源", "訂單ID", "交易所成交ID", "要求數量", "成交數量",
  "要求價格", "成交價格", "價格來源", "數量來源", "毛利", "手續費", "資金費", "淨已實現盈虧",
  "盈虧百分比", "盈虧幣別", "盈虧狀態", "盈虧來源", "資料品質", "對帳狀態", "對帳次數",
  "關聯方式", "延遲(ms)", "訊息", "對帳錯誤",
] as const;

function detailValues(row: TradeJournalRow) {
  return [
    row.signalId, row.tradeId, row.executionId, row.cycleId, row.strategyId, row.strategyName, row.strategyKey,
    row.exchange, iso(row.createdAt), iso(row.filledAt), row.parsedSymbol, row.parsedAction, row.tradeSide,
    row.reduceOnly === null ? "" : row.reduceOnly ? "是" : "否", row.orderType, row.status, row.tradeStatus,
    row.source, row.triggerSource, row.orderId, row.exchangeTradeId, row.requestedSize, row.filledSize,
    row.requestedPrice, row.filledPrice, row.priceSource, row.sizeSource, row.grossPnl, row.fee, row.fundingFee,
    row.realizedPnl, row.realizedPnlPct, row.pnlCurrency, row.pnlState, row.pnlSource, row.dataQuality,
    row.reconciliationStatus, row.reconciliationAttempts, row.linkage, row.latencyMs, row.message,
    row.reconciliationError,
  ];
}

const DETAIL_NUMERIC_INDEXES = new Set([
  0, 1, 4, 21, 22, 23, 24, 27, 28, 29, 30, 31, 37, 39,
]);

function detailExcelValues(row: TradeJournalRow) {
  return detailValues(row).map((value, index) => {
    if (!DETAIL_NUMERIC_INDEXES.has(index)) return safeExcelCell(value);
    return numeric(value);
  });
}

export function buildTradeCsv(data: TradeReportData): Buffer {
  const lines = [
    DETAIL_HEADERS.map(csvEscape).join(","),
    ...data.rows.map(row => detailValues(row).map(csvEscape).join(",")),
  ];
  return Buffer.from("\uFEFF" + lines.join("\r\n") + "\r\n", "utf8");
}

const HEADER_FILL = "FF17324D";
const HEADER_TEXT = "FFFFFFFF";
const ACCENT_FILL = "FFD8EAF3";

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: HEADER_TEXT } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  row.alignment = { vertical: "middle", wrapText: true };
  row.height = 30;
}

function styleTableSheet(sheet: ExcelJS.Worksheet, headerRowNumber = 1) {
  sheet.views = [{ state: "frozen", ySplit: headerRowNumber }];
  styleHeader(sheet.getRow(headerRowNumber));
  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber, column: sheet.columnCount },
  };
  sheet.eachRow((row: ExcelJS.Row, rowNumber: number) => {
    if (rowNumber <= headerRowNumber) return;
    row.alignment = { vertical: "top", wrapText: false };
    if (rowNumber % 2 === 0) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F8FA" } };
    }
  });
}

function addMetadata(sheet: ExcelJS.Worksheet, data: TradeReportData) {
  const filters = data.filters;
  const metadata: Array<[string, string | number | undefined]> = [
    ["報告生成時間（UTC）", data.generatedAt.toISOString()],
    ["資料筆數", data.rows.length],
    ["策略範圍", filters.strategyIds?.length ? filters.strategyIds.join("、") : "全部策略"],
    ["開始時間（UTC）", filters.startTime?.toISOString() ?? "未限制"],
    ["結束時間（UTC）", filters.endTime?.toISOString() ?? "未限制"],
    ["訊號狀態", filters.status ?? "全部"],
    ["訊號來源", filters.source ?? "全部"],
    ["動作", filters.action ?? "全部"],
    ["交易對", filters.symbol ?? "全部"],
    ["盈虧狀態", filters.pnlState ?? "全部"],
  ];
  for (const values of metadata) sheet.addRow(values as ExcelJS.CellValue[]);
  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 56;
  for (let rowNumber = 1; rowNumber <= metadata.length; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.getCell(1).font = { bold: true };
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_FILL } };
  }
  sheet.addRow([]);
}

export async function buildTradeXlsx(data: TradeReportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "策略容器化自動交易平台";
  workbook.created = data.generatedAt;
  workbook.modified = data.generatedAt;
  workbook.properties.date1904 = false;

  const detailSheet = workbook.addWorksheet("交易明細", { properties: { defaultRowHeight: 20 } });
  detailSheet.addRow([...DETAIL_HEADERS]);
  for (const row of data.rows) detailSheet.addRow(detailExcelValues(row));
  detailSheet.columns = DETAIL_HEADERS.map((header, index) => ({
    header,
    key: header,
    width: index >= 40 ? 38 : index >= 27 && index <= 32 ? 16 : 20,
  }));
  for (const index of [28, 29, 30, 31, 32]) detailSheet.getColumn(index).numFmt = "0.00000000";
  styleTableSheet(detailSheet);

  const cycleSheet = workbook.addWorksheet("交易循環", { properties: { defaultRowHeight: 20 } });
  const cycleHeaders = [
    "交易循環ID", "策略ID", "策略名稱", "策略Key", "交易所", "交易對", "方向", "開始時間(UTC)",
    "最後活動時間(UTC)", "開倉筆數", "平倉筆數", "開倉總量", "平倉總量", "剩餘數量", "開倉均價",
    "平倉均價", "毛利", "手續費", "資金費", "淨已實現盈虧", "幣別", "盈虧狀態", "循環狀態",
    "資料品質", "盈虧來源",
  ];
  cycleSheet.addRow(cycleHeaders);
  for (const cycle of data.cycles) {
    cycleSheet.addRow([
      cycle.cycleId, cycle.strategyId, cycle.strategyName, cycle.strategyKey, cycle.exchange, cycle.symbol,
      cycle.direction, iso(cycle.openedAt), iso(cycle.lastActivityAt), cycle.entryCount, cycle.closeCount,
      cycle.totalEntrySize, cycle.totalCloseSize, cycle.remainingSize, cycle.averageEntryPrice,
      cycle.averageClosePrice, cycle.grossPnl, cycle.fee, cycle.fundingFee, cycle.netRealizedPnl,
      cycle.pnlCurrency, cycle.pnlState, cycle.status, cycle.dataQuality, cycle.pnlSources,
    ].map(safeExcelCell));
  }
  cycleSheet.columns = cycleHeaders.map((header, index) => ({
    header,
    key: header,
    width: index >= 22 ? 25 : 18,
  })) as Partial<ExcelJS.Column>[];
  for (let index = 12; index <= 20; index += 1) cycleSheet.getColumn(index).numFmt = "0.00000000";
  styleTableSheet(cycleSheet);

  const summarySheet = workbook.addWorksheet("策略摘要", { properties: { defaultRowHeight: 20 } });
  addMetadata(summarySheet, data);
  const summaryHeaderRow = summarySheet.rowCount + 1;
  summarySheet.addRow([
    "策略ID", "策略名稱", "策略Key", "交易所", "訊號數", "已執行", "失敗／拒絕", "已跳過", "成交數",
    "平倉數", "已知盈虧數", "有方向結果數", "盈利數", "虧損數", "持平數", "勝率(%)", "毛利", "手續費", "資金費",
    "淨已實現盈虧", "待對帳", "未解",
  ]);
  for (const summary of data.strategies) {
    summarySheet.addRow([
      summary.strategyId, summary.strategyName, summary.strategyKey, summary.exchange, summary.signalCount,
      summary.executedCount, summary.failedCount, summary.skippedCount, summary.tradeCount, summary.closeCount,
      summary.knownPnlCount, summary.decisivePnlCount, summary.winCount, summary.lossCount, summary.breakevenCount,
      summary.winRatePct, summary.grossPnl, summary.fee,
      summary.fundingFee, summary.netRealizedPnl, summary.pendingCount, summary.unresolvedCount,
    ]);
  }
  summarySheet.columns.forEach((column, index) => { column.width = index <= 3 ? 24 : 16; });
  summarySheet.getColumn(16).numFmt = "0.00";
  for (let index = 17; index <= 20; index += 1) summarySheet.getColumn(index).numFmt = "0.00000000";
  styleTableSheet(summarySheet, summaryHeaderRow);

  const qualitySheet = workbook.addWorksheet("資料品質", { properties: { defaultRowHeight: 20 } });
  qualitySheet.addRow(["資料品質", "盈虧來源", "對帳狀態", "盈虧狀態", "關聯方式", "筆數", "占比(%)"]);
  for (const quality of data.quality) {
    qualitySheet.addRow([
      quality.dataQuality, quality.pnlSource, quality.reconciliationStatus, quality.pnlState, quality.linkage,
      quality.rowCount, quality.percentage,
    ]);
  }
qualitySheet.columns = [
      { header: "資料品質", key: "dataQuality", width: 28 },
      { header: "盈虧來源", key: "pnlSource", width: 28 },
      { header: "對帳狀態", key: "reconciliationStatus", width: 24 },
      { header: "盈虧狀態", key: "pnlState", width: 22 },
      { header: "關聯方式", key: "linkage", width: 20 },
      { header: "筆數", key: "rowCount", width: 14 },
      { header: "占比(%)", key: "percentage", width: 14 },
    ];
  qualitySheet.getColumn(7).numFmt = "0.00";
  styleTableSheet(qualitySheet);

  const binary = await workbook.xlsx.writeBuffer();
  return Buffer.from(binary);
}

function reportTimestamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function generateAndStoreTradeReport(input: {
  userId: number;
  format: TradeReportFormat;
  filters: TradeJournalFilters;
}) {
  const fetched = await fetchAllTradeJournalRows(input.userId, input.filters);
  const rows = "rows" in fetched && fetched.rows ? fetched.rows : [];
  const generatedAt = new Date();
  const data = buildTradeReportData(rows, input.filters, generatedAt);
  const isXlsx = input.format === "xlsx";
  const buffer = isXlsx ? await buildTradeXlsx(data) : buildTradeCsv(data);
  const extension = isXlsx ? "xlsx" : "csv";
  const contentType = isXlsx
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "text/csv; charset=utf-8";
  const filename = `trade-report-${reportTimestamp(generatedAt)}.${extension}`;
  const stored = await storagePut(
    `trade-reports/${input.userId}/${filename}`,
    buffer,
    contentType,
  );

  return {
    ...stored,
    filename,
    format: input.format,
    contentType,
    bytes: buffer.byteLength,
    rowCount: data.rows.length,
    cycleCount: data.cycles.length,
    strategyCount: data.strategies.length,
    generatedAt,
  };
}
