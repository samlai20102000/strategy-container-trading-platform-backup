import { createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  SQL,
  sql,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/mysql-core";
import { signals, strategies, trades } from "../../drizzle/schema";
import { getDb } from "../db";

export type TradeJournalSignalStatus =
  | "received"
  | "executed"
  | "failed"
  | "rejected"
  | "skipped";
export type TradeJournalSource = "webhook" | "auto" | "manual";
export type TradeJournalAction = "buy" | "sell" | "close";
export type TradeJournalPnlState = "known" | "pending" | "unresolved" | "not_applicable";
export type TradeJournalLinkage = "signal_id" | "unlinked" | "orphan_trade";

export interface TradeJournalFilters {
  /** 舊版單策略相容入口；strategyIds 存在時以 strategyIds 為準。 */
  strategyId?: number;
  /** 空陣列或未提供表示全部策略。 */
  strategyIds?: number[];
  status?: TradeJournalSignalStatus;
  source?: TradeJournalSource;
  action?: TradeJournalAction;
  symbol?: string;
  pnlState?: TradeJournalPnlState;
  startTime?: Date;
  endTime?: Date;
}

export interface TradeJournalPageInput extends TradeJournalFilters {
  limit?: number;
  offset?: number;
}

export const TRADE_JOURNAL_EXPORT_WARNING_ROWS = 25_000;
export const TRADE_JOURNAL_EXPORT_WARNING_BYTES = 20 * 1024 * 1024;
export const TRADE_JOURNAL_BATCH_SIZE = 2_000;

function normalizeStrategyIds(filters: TradeJournalFilters): number[] | undefined {
  const source = filters.strategyIds?.length
    ? filters.strategyIds
    : filters.strategyId
      ? [filters.strategyId]
      : undefined;
  if (!source) return undefined;
  return Array.from(new Set(source.filter(id => Number.isInteger(id) && id > 0))).sort(
    (a, b) => a - b,
  );
}

export function normalizeTradeJournalFilters(
  filters: TradeJournalFilters,
): TradeJournalFilters {
  return {
    strategyIds: normalizeStrategyIds(filters),
    status: filters.status,
    source: filters.source,
    action: filters.action,
    symbol: filters.symbol?.trim().toUpperCase() || undefined,
    pnlState: filters.pnlState,
    startTime: filters.startTime,
    endTime: filters.endTime,
  };
}

function buildSignalWhere(userId: number, rawFilters: TradeJournalFilters) {
  const filters = normalizeTradeJournalFilters(rawFilters);
  const conditions: SQL[] = [eq(signals.userId, userId)];

  if (filters.strategyIds?.length) {
    conditions.push(inArray(signals.strategyId, filters.strategyIds));
  }
  if (filters.status) conditions.push(eq(signals.status, filters.status));
  if (filters.source) conditions.push(eq(signals.source, filters.source));
  if (filters.action) conditions.push(eq(signals.parsedAction, filters.action));
  if (filters.symbol) conditions.push(eq(signals.parsedSymbol, filters.symbol));
  if (filters.startTime) conditions.push(gte(signals.createdAt, filters.startTime));
  if (filters.endTime) conditions.push(lte(signals.createdAt, filters.endTime));

  if (filters.pnlState === "known") {
    conditions.push(sql`COALESCE(${trades.netRealizedPnl}, ${trades.realizedPnl}) IS NOT NULL`);
  } else if (filters.pnlState === "pending") {
    conditions.push(eq(trades.reconciliationStatus, "pending"));
  } else if (filters.pnlState === "unresolved") {
    conditions.push(sql`(
      ${trades.reconciliationStatus} IN ('failed', 'unresolved')
      OR (${trades.id} IS NULL AND ${signals.status} = 'executed')
    )`);
  } else if (filters.pnlState === "not_applicable") {
    conditions.push(sql`(
      ${trades.id} IS NULL AND ${signals.status} <> 'executed'
      OR ${trades.dataQuality} = 'not_applicable'
    )`);
  }

  return { filters, where: and(...conditions)! };
}

function orphanSourceExpression() {
  return sql<TradeJournalSource>`CASE
    WHEN ${trades.triggerSource} = 'manual' THEN 'manual'
    WHEN ${trades.triggerSource} = 'webhook' THEN 'webhook'
    ELSE 'auto'
  END`;
}

function orphanActionExpression() {
  return sql<TradeJournalAction>`CASE
    WHEN ${trades.reduceOnly} = TRUE THEN 'close'
    ELSE ${trades.side}
  END`;
}

function orphanStatusExpression() {
  return sql<TradeJournalSignalStatus>`CASE
    WHEN ${trades.status} IN ('failed', 'cancelled') THEN 'failed'
    WHEN ${trades.status} = 'submitted' THEN 'received'
    ELSE 'executed'
  END`;
}

function buildOrphanTradeWhere(userId: number, rawFilters: TradeJournalFilters) {
  const filters = normalizeTradeJournalFilters(rawFilters);
  const conditions: SQL[] = [eq(trades.userId, userId), isNull(trades.signalId)];

  if (filters.strategyIds?.length) {
    conditions.push(inArray(trades.strategyId, filters.strategyIds));
  }
  if (filters.status) conditions.push(sql`${orphanStatusExpression()} = ${filters.status}`);
  if (filters.source) conditions.push(sql`${orphanSourceExpression()} = ${filters.source}`);
  if (filters.action) conditions.push(sql`${orphanActionExpression()} = ${filters.action}`);
  if (filters.symbol) conditions.push(eq(trades.symbol, filters.symbol));
  if (filters.startTime) {
    conditions.push(sql`COALESCE(${trades.filledAt}, ${trades.createdAt}) >= ${filters.startTime}`);
  }
  if (filters.endTime) {
    conditions.push(sql`COALESCE(${trades.filledAt}, ${trades.createdAt}) <= ${filters.endTime}`);
  }

  if (filters.pnlState === "known") {
    conditions.push(sql`COALESCE(${trades.netRealizedPnl}, ${trades.realizedPnl}) IS NOT NULL`);
  } else if (filters.pnlState === "pending") {
    conditions.push(eq(trades.reconciliationStatus, "pending"));
  } else if (filters.pnlState === "unresolved") {
    conditions.push(sql`${trades.reconciliationStatus} IN ('failed', 'unresolved')`);
  } else if (filters.pnlState === "not_applicable") {
    conditions.push(eq(trades.dataQuality, "not_applicable"));
  }

  return { filters, where: and(...conditions)! };
}

const journalSelection = {
  id: sql<number>`${signals.id}`.as("id"),
  signalId: sql<number | null>`${signals.id}`.as("signalId"),
  strategyId: signals.strategyId,
  userId: signals.userId,
  executionId: signals.executionId,
  cycleId: signals.cycleId,
  rawPayload: signals.rawPayload,
  parsedAction: signals.parsedAction,
  parsedSymbol: signals.parsedSymbol,
  parsedPrice: signals.parsedPrice,
  status: signals.status,
  message: signals.message,
  exchangeResponse: signals.exchangeResponse,
  orderId: signals.orderId,
  latencyMs: signals.latencyMs,
  source: signals.source,
  createdAt: signals.createdAt,
  tradeId: sql<number | null>`${trades.id}`.as("tradeId"),
  exchange: sql<string | null>`COALESCE(${trades.exchange}, ${strategies.exchange})`.as("exchange"),
  strategyName: sql<string | null>`COALESCE(${trades.strategyName}, ${strategies.name})`.as("strategyName"),
  strategyKey: sql<string | null>`COALESCE(${trades.strategyKey}, ${strategies.strategyKey})`.as("strategyKey"),
  tradeSide: sql<string | null>`${trades.side}`.as("tradeSide"),
  reduceOnly: trades.reduceOnly,
  orderType: trades.orderType,
  exchangeTradeId: trades.exchangeTradeId,
  triggerSource: trades.triggerSource,
  requestedSize: trades.requestedSize,
  requestedPrice: trades.requestedPrice,
  filledSize: sql<string | null>`${trades.size}`.as("filledSize"),
  filledPrice: sql<string | null>`${trades.price}`.as("filledPrice"),
  priceSource: trades.priceSource,
  sizeSource: trades.sizeSource,
  grossPnl: sql<string | null>`COALESCE(${trades.grossPnl}, ${trades.realizedPnl})`.as("grossPnl"),
  fee: trades.fee,
  fundingFee: trades.fundingFee,
  realizedPnl: sql<string | null>`COALESCE(${trades.netRealizedPnl}, ${trades.realizedPnl})`.as("realizedPnl"),
  realizedPnlPct: trades.realizedPnlPct,
  pnlCurrency: trades.pnlCurrency,
  pnlSource: trades.pnlSource,
  dataQuality: sql<string | null>`${trades.dataQuality}`.as("dataQuality"),
  reconciliationStatus: trades.reconciliationStatus,
  reconciliationAttempts: trades.reconciliationAttempts,
  reconciliationError: trades.reconciliationError,
  filledAt: trades.filledAt,
  tradeStatus: sql<string | null>`${trades.status}`.as("tradeStatus"),
  pnlState: sql<TradeJournalPnlState>`CASE
    WHEN COALESCE(${trades.netRealizedPnl}, ${trades.realizedPnl}) IS NOT NULL THEN 'known'
    WHEN ${trades.reconciliationStatus} = 'pending' THEN 'pending'
    WHEN ${trades.reconciliationStatus} IN ('failed', 'unresolved') THEN 'unresolved'
    WHEN ${trades.id} IS NULL AND ${signals.status} = 'executed' THEN 'unresolved'
    ELSE 'not_applicable'
  END`.as("pnlState"),
  linkage: sql<TradeJournalLinkage>`CASE
    WHEN ${trades.signalId} = ${signals.id} THEN 'signal_id'
    ELSE 'unlinked'
  END`.as("linkage"),
};

const orphanJournalSelection = {
  id: sql<number>`-${trades.id}`.as("id"),
  signalId: sql<number | null>`NULL`.as("signalId"),
  strategyId: trades.strategyId,
  userId: trades.userId,
  executionId: trades.executionId,
  cycleId: trades.cycleId,
  rawPayload: sql<string>`CONCAT(
    '{"legacyOrphanTradeId":', ${trades.id},
    ',"reason":"no_safe_signal_candidate"}'
  )`.as("rawPayload"),
  parsedAction: orphanActionExpression().as("parsedAction"),
  parsedSymbol: trades.symbol,
  parsedPrice: trades.requestedPrice,
  status: orphanStatusExpression().as("status"),
  message: sql<string>`${"歷史孤兒成交：未發現可安全唯一關聯的訊號，未進行猜測回填"}`.as("message"),
  exchangeResponse: sql<string | null>`NULL`.as("exchangeResponse"),
  orderId: trades.orderId,
  latencyMs: sql<number | null>`NULL`.as("latencyMs"),
  source: orphanSourceExpression().as("source"),
  createdAt: sql<Date>`COALESCE(${trades.filledAt}, ${trades.createdAt})`.as("createdAt"),
  tradeId: sql<number>`${trades.id}`.as("tradeId"),
  exchange: sql<string | null>`COALESCE(${trades.exchange}, ${strategies.exchange})`.as("exchange"),
  strategyName: sql<string | null>`COALESCE(${trades.strategyName}, ${strategies.name})`.as("strategyName"),
  strategyKey: sql<string | null>`COALESCE(${trades.strategyKey}, ${strategies.strategyKey})`.as("strategyKey"),
  tradeSide: sql<string>`${trades.side}`.as("tradeSide"),
  reduceOnly: trades.reduceOnly,
  orderType: trades.orderType,
  exchangeTradeId: trades.exchangeTradeId,
  triggerSource: trades.triggerSource,
  requestedSize: trades.requestedSize,
  requestedPrice: trades.requestedPrice,
  filledSize: sql<string>`${trades.size}`.as("filledSize"),
  filledPrice: sql<string>`${trades.price}`.as("filledPrice"),
  priceSource: trades.priceSource,
  sizeSource: trades.sizeSource,
  grossPnl: sql<string | null>`COALESCE(${trades.grossPnl}, ${trades.realizedPnl})`.as("grossPnl"),
  fee: trades.fee,
  fundingFee: trades.fundingFee,
  realizedPnl: sql<string | null>`COALESCE(${trades.netRealizedPnl}, ${trades.realizedPnl})`.as("realizedPnl"),
  realizedPnlPct: trades.realizedPnlPct,
  pnlCurrency: trades.pnlCurrency,
  pnlSource: trades.pnlSource,
  dataQuality: sql<string | null>`'legacy_orphan_trade'`.as("dataQuality"),
  reconciliationStatus: trades.reconciliationStatus,
  reconciliationAttempts: trades.reconciliationAttempts,
  reconciliationError: trades.reconciliationError,
  filledAt: trades.filledAt,
  tradeStatus: sql<string>`${trades.status}`.as("tradeStatus"),
  pnlState: sql<TradeJournalPnlState>`CASE
    WHEN COALESCE(${trades.netRealizedPnl}, ${trades.realizedPnl}) IS NOT NULL THEN 'known'
    WHEN ${trades.reconciliationStatus} = 'pending' THEN 'pending'
    WHEN ${trades.reconciliationStatus} IN ('failed', 'unresolved') THEN 'unresolved'
    ELSE 'not_applicable'
  END`.as("pnlState"),
  linkage: sql<TradeJournalLinkage>`'orphan_trade'`.as("linkage"),
};

async function requireDb() {
  const database = await getDb();
  if (!database) throw new Error("資料庫不可用");
  return database;
}

function buildTradeJournalUnion(
  database: Awaited<ReturnType<typeof requireDb>>,
  userId: number,
  input: TradeJournalFilters,
) {
  const signalContext = buildSignalWhere(userId, input);
  const orphanContext = buildOrphanTradeWhere(userId, input);
  const signalQuery = database
    .select(journalSelection)
    .from(signals)
    .leftJoin(trades, eq(trades.signalId, signals.id))
    .leftJoin(strategies, eq(strategies.id, signals.strategyId))
    .where(signalContext.where);
  const orphanQuery = database
    .select(orphanJournalSelection)
    .from(trades)
    .leftJoin(strategies, eq(strategies.id, trades.strategyId))
    .where(orphanContext.where);

  return {
    filters: signalContext.filters,
    query: unionAll(signalQuery, orphanQuery),
  };
}

/**
 * 訊號日誌畫面與所有匯出格式的唯一資料來源。
 * 僅以 trades.signalId 連接，禁止以時間或文字猜測 PnL。
 */
export async function queryTradeJournal(userId: number, input: TradeJournalPageInput) {
  const database = await requireDb();
  const { filters, query } = buildTradeJournalUnion(database, userId, input);
  const journal = query.as("trade_journal");
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 5_000);
  const offset = Math.max(input.offset ?? 0, 0);

  const [items, countRows] = await Promise.all([
    database
      .select()
      .from(journal)
      .orderBy(desc(journal.createdAt), desc(journal.id))
      .limit(limit)
      .offset(offset),
    database
      .select({ count: sql<number>`COUNT(*)` })
      .from(journal),
  ]);

  return {
    items,
    total: Number(countRows[0]?.count ?? 0),
    limit,
    offset,
    filters,
  };
}

export async function summarizeTradeJournal(userId: number, input: TradeJournalFilters) {
  const database = await requireDb();
  const { filters, query } = buildTradeJournalUnion(database, userId, input);
  const journal = query.as("trade_journal_summary");
  const rows = await database
    .select({
      totalRows: sql<number>`COUNT(*)`,
      executedRows: sql<number>`SUM(CASE WHEN ${journal.status} = 'executed' THEN 1 ELSE 0 END)`,
      failedRows: sql<number>`SUM(CASE WHEN ${journal.status} IN ('failed', 'rejected') THEN 1 ELSE 0 END)`,
      skippedRows: sql<number>`SUM(CASE WHEN ${journal.status} = 'skipped' THEN 1 ELSE 0 END)`,
      pnlKnownRows: sql<number>`SUM(CASE WHEN ${journal.pnlState} = 'known' THEN 1 ELSE 0 END)`,
      pnlPendingRows: sql<number>`SUM(CASE WHEN ${journal.pnlState} = 'pending' THEN 1 ELSE 0 END)`,
      pnlUnresolvedRows: sql<number>`SUM(CASE WHEN ${journal.pnlState} = 'unresolved' THEN 1 ELSE 0 END)`,
      totalRealizedPnl: sql<string>`COALESCE(SUM(${journal.realizedPnl}), 0)`,
      textBytes: sql<number>`COALESCE(SUM(
        CHAR_LENGTH(COALESCE(${journal.message}, ''))
        + CHAR_LENGTH(COALESCE(${journal.rawPayload}, ''))
        + CHAR_LENGTH(COALESCE(${journal.exchangeResponse}, ''))
      ), 0)`,
      firstTimestamp: sql<Date | null>`MIN(${journal.createdAt})`,
      lastTimestamp: sql<Date | null>`MAX(${journal.createdAt})`,
    })
    .from(journal);

  const row = rows[0];
  return {
    filters,
    totalRows: Number(row?.totalRows ?? 0),
    executedRows: Number(row?.executedRows ?? 0),
    failedRows: Number(row?.failedRows ?? 0),
    skippedRows: Number(row?.skippedRows ?? 0),
    pnlKnownRows: Number(row?.pnlKnownRows ?? 0),
    pnlPendingRows: Number(row?.pnlPendingRows ?? 0),
    pnlUnresolvedRows: Number(row?.pnlUnresolvedRows ?? 0),
    totalRealizedPnl: Number(row?.totalRealizedPnl ?? 0),
    textBytes: Number(row?.textBytes ?? 0),
    firstTimestamp: row?.firstTimestamp ?? null,
    lastTimestamp: row?.lastTimestamp ?? null,
  };
}

export async function preflightTradeJournalExport(
  userId: number,
  input: TradeJournalFilters,
) {
  const summary = await summarizeTradeJournal(userId, input);
  const estimatedCsvBytes = Math.max(
    summary.totalRows === 0 ? 0 : 1_024,
    summary.totalRows * 420 + summary.textBytes,
  );
  const estimatedXlsxBytes = Math.max(
    summary.totalRows === 0 ? 0 : 4_096,
    Math.round(estimatedCsvBytes * 0.62),
  );
  const warnings: string[] = [];
  if (summary.totalRows >= TRADE_JOURNAL_EXPORT_WARNING_ROWS) {
    warnings.push("row_count");
  }
  if (estimatedXlsxBytes >= TRADE_JOURNAL_EXPORT_WARNING_BYTES) {
    warnings.push("file_size");
  }
  const confirmationToken = createHash("sha256")
    .update(JSON.stringify({
      userId,
      filters: summary.filters,
      totalRows: summary.totalRows,
      estimatedXlsxBytes,
    }))
    .digest("hex")
    .slice(0, 24);

  return {
    ...summary,
    estimatedCsvBytes,
    estimatedXlsxBytes,
    warnings,
    requiresConfirmation: warnings.length > 0,
    confirmationToken,
    generatedAt: new Date(),
  };
}

export type TradeJournalRow = Awaited<ReturnType<typeof queryTradeJournal>>["items"][number];

export interface TradeJournalBatchPage<Row> {
  items: Row[];
  total: number;
}

/**
 * 可測的批次核心：以服務端回報 total 為終點，不使用 10,000 等隱性總筆數截斷。
 */
export async function collectTradeJournalBatches<Row>(
  fetchPage: (offset: number, limit: number) => Promise<TradeJournalBatchPage<Row>>,
  onBatch?: (batch: Row[], offset: number) => void | Promise<void>,
) {
  const rows: Row[] = [];
  let offset = 0;
  let total = 0;
  do {
    const page = await fetchPage(offset, TRADE_JOURNAL_BATCH_SIZE);
    total = page.total;
    if (onBatch) await onBatch(page.items, offset);
    else rows.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);
  return onBatch ? { total } : { total, rows };
}

/** 無隱性總筆數上限；只以固定批次讀取，供 CSV/XLSX 生成器控制記憶體。 */
export async function fetchAllTradeJournalRows(
  userId: number,
  input: TradeJournalFilters,
  onBatch?: (batch: TradeJournalRow[], offset: number) => void | Promise<void>,
) {
  return collectTradeJournalBatches(
    (offset, limit) => queryTradeJournal(userId, {
      ...input,
      limit,
      offset,
    }),
    onBatch,
  );
}
