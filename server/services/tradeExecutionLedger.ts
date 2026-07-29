import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { InsertSignal, InsertTrade } from "../../drizzle/schema";
import { signals, trades } from "../../drizzle/schema";
import { getDb } from "../db";
import type { OrderResult } from "../exchanges/types";

export type LedgerSignalSource = "webhook" | "auto" | "manual";
export type LedgerTradeStatus = "submitted" | "filled" | "failed" | "cancelled";
export type LedgerPnlSource = NonNullable<InsertTrade["pnlSource"]>;
export type LedgerDataQuality = NonNullable<InsertTrade["dataQuality"]>;

export interface LedgerStrategyIdentity {
  id: number;
  userId: number;
  name?: string | null;
  strategyKey?: string | null;
  exchange: "okx" | "bybit";
  symbol: string;
}

export interface LedgerSignalInput {
  /** 已由呼叫端建立的 signal；未提供時共用服務會先建立 signal 再建立 trade。 */
  id?: number;
  action: string;
  source: LedgerSignalSource;
  rawPayload?: unknown;
  parsedPrice?: number | null;
  message?: string | null;
  latencyMs?: number | null;
}

export interface LedgerOrderInput {
  side: "buy" | "sell";
  orderType: "market" | "limit";
  requestedSize: number;
  requestedPrice?: number | null;
  reduceOnly: boolean;
  triggerSource: string;
}

export interface LedgerExecutionTruth {
  status: LedgerTradeStatus;
  orderId?: string | null;
  exchangeTradeId?: string | null;
  filledSize?: number | null;
  averagePrice?: number | null;
  grossPnl?: number | null;
  fee?: number | null;
  fundingFee?: number | null;
  /** 已扣除已知費用後的最終淨已實現盈虧。 */
  netRealizedPnl?: number | null;
  realizedPnlPct?: number | null;
  pnlCurrency?: string | null;
  pnlSource?: LedgerPnlSource;
  dataQuality?: LedgerDataQuality;
  filledAt?: Date | null;
  raw?: unknown;
  errorMessage?: string | null;
}

export interface RecordTradeExecutionInput {
  strategy: LedgerStrategyIdentity;
  signal: LedgerSignalInput;
  order: LedgerOrderInput;
  execution: LedgerExecutionTruth;
  /** 呼叫端可提供穩定識別；有交易所 orderId 時會自動生成穩定識別。 */
  executionId?: string;
  /** 部分平倉應傳入既有 cycleId；未提供時會安全尋找尚未完全退出的循環。 */
  cycleId?: string;
}

export interface RecordedTradeExecution {
  signalId: number;
  tradeId: number;
  executionId: string;
  cycleId: string;
  deduplicated: boolean;
  reconciliationStatus: "not_required" | "pending" | "confirmed" | "failed" | "unresolved";
}

export type ExistingTradeExecutionInput = InsertTrade & {
  signal?: Partial<LedgerSignalInput>;
  exchangeResult?: OrderResult;
};

const DECIMAL_SCALE = 8;

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decimal(value: unknown, scale = DECIMAL_SCALE): string | null {
  const parsed = finiteNumber(value);
  return parsed === null ? null : parsed.toFixed(scale);
}

function boundedId(value: string): string {
  return value.replace(/\s+/g, "_").slice(0, 128);
}

function buildExecutionId(input: RecordTradeExecutionInput): string {
  if (input.executionId) return boundedId(input.executionId);
  if (input.execution.orderId) {
    return boundedId(`exec:${input.strategy.exchange}:${input.execution.orderId}`);
  }
  return boundedId(`exec:${input.strategy.id}:${randomUUID()}`);
}

function newCycleId(input: RecordTradeExecutionInput, kind: "open" | "orphan-close"): string {
  return boundedId(`cycle:${kind}:${input.strategy.id}:${input.strategy.symbol}:${randomUUID()}`);
}

function isFilled(status: LedgerTradeStatus): boolean {
  return status === "filled";
}

function normalizeTradeStatus(status: InsertTrade["status"]): LedgerTradeStatus {
  return status === "submitted" || status === "failed" || status === "cancelled"
    ? status
    : "filled";
}

function inferSignalSource(triggerSource: string | null | undefined): LedgerSignalSource {
  const normalized = (triggerSource || "").toLowerCase();
  if (normalized.includes("manual") || normalized.includes("emergency")) return "manual";
  if (normalized.includes("webhook")) return "webhook";
  return "auto";
}

function inferPnlTruth(input: RecordTradeExecutionInput): {
  netPnl: number | null;
  pnlSource: LedgerPnlSource;
  dataQuality: LedgerDataQuality;
  reconciliationStatus: RecordedTradeExecution["reconciliationStatus"];
} {
  const netPnl = finiteNumber(input.execution.netRealizedPnl);
  if (!input.order.reduceOnly) {
    return {
      netPnl: null,
      pnlSource: input.execution.pnlSource ?? "unknown",
      dataQuality: input.execution.dataQuality ?? "not_applicable",
      reconciliationStatus: "not_required",
    };
  }

  if (!isFilled(input.execution.status)) {
    return {
      netPnl,
      pnlSource: input.execution.pnlSource ?? "unknown",
      dataQuality: input.execution.dataQuality ?? "legacy_unresolved",
      reconciliationStatus: input.execution.status === "failed" ? "failed" : "unresolved",
    };
  }

  if (netPnl !== null) {
    const source = input.execution.pnlSource ?? "exchange_settlement";
    const quality = input.execution.dataQuality
      ?? (source === "exchange_settlement" || source === "exchange"
        ? "exchange_confirmed"
        : "calculated");
    return {
      netPnl,
      pnlSource: source,
      dataQuality: quality,
      reconciliationStatus: "confirmed",
    };
  }

  return {
    netPnl: null,
    pnlSource: input.execution.pnlSource ?? "unknown",
    dataQuality: input.execution.dataQuality ?? "pending_reconciliation",
    reconciliationStatus: "pending",
  };
}

function executionMessage(input: RecordTradeExecutionInput, netPnl: number | null): string {
  if (input.signal.message) return input.signal.message;
  if (input.execution.status === "failed") {
    return input.execution.errorMessage || "交易執行失敗";
  }
  if (input.order.reduceOnly && netPnl !== null) {
    const signed = netPnl >= 0 ? `+${netPnl.toFixed(8)}` : netPnl.toFixed(8);
    return `✅ 平倉已執行｜已實現盈虧 ${signed} ${input.execution.pnlCurrency || "USDT"}`;
  }
  if (input.order.reduceOnly) return "✅ 平倉已執行｜已實現盈虧待交易所對帳";
  return "✅ 交易已執行";
}

async function resolveCycleId(
  tx: any,
  input: RecordTradeExecutionInput,
): Promise<string> {
  if (input.cycleId) return boundedId(input.cycleId);
  if (!input.order.reduceOnly) return newCycleId(input, "open");

  const openSide = input.order.side === "sell" ? "buy" : "sell";
  const closeSide = input.order.side;
  const candidates = await tx
    .select({
      id: trades.id,
      cycleId: trades.cycleId,
      side: trades.side,
      reduceOnly: trades.reduceOnly,
      size: trades.size,
      createdAt: trades.createdAt,
    })
    .from(trades)
    .where(and(
      eq(trades.strategyId, input.strategy.id),
      eq(trades.symbol, input.strategy.symbol),
      isNotNull(trades.cycleId),
    ))
    .orderBy(desc(trades.createdAt), desc(trades.id))
    .limit(500);

  const cycles = new Map<string, { opened: number; closed: number; latest: number }>();
  for (const row of candidates) {
    if (!row.cycleId) continue;
    const entry = cycles.get(row.cycleId) ?? { opened: 0, closed: 0, latest: 0 };
    const quantity = finiteNumber(row.size) ?? 0;
    if (!row.reduceOnly && row.side === openSide) entry.opened += quantity;
    if (row.reduceOnly && row.side === closeSide) entry.closed += quantity;
    entry.latest = Math.max(entry.latest, row.createdAt?.getTime?.() ?? 0);
    cycles.set(row.cycleId, entry);
  }

  const active = Array.from(cycles.entries())
    .filter(([, value]) => value.opened > value.closed + 1e-12)
    .sort((a, b) => b[1].latest - a[1].latest)[0];
  return active?.[0] ?? newCycleId(input, "orphan-close");
}

function extractInsertId(result: unknown): number {
  const raw = result as [{ insertId?: number }, ...unknown[]] | { insertId?: number };
  const header = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(header?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("資料庫未回傳有效 insertId");
  return id;
}

/**
 * 全策略唯一交易記錄入口。
 *
 * 不含任何交易所下單副作用；只在下單結果已取得後，原子保存 signal 與 trade 真相。
 * 未來策略只要使用此服務，即自動具備盈虧、關聯、冪等、循環與延遲對帳契約。
 */
export async function recordTradeExecution(
  input: RecordTradeExecutionInput,
): Promise<RecordedTradeExecution> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");

  const executionId = buildExecutionId(input);
  const existing = await db
    .select({ id: trades.id, signalId: trades.signalId, cycleId: trades.cycleId, reconciliationStatus: trades.reconciliationStatus })
    .from(trades)
    .where(eq(trades.executionId, executionId))
    .limit(1);
  if (existing[0]?.signalId && existing[0]?.cycleId) {
    return {
      signalId: existing[0].signalId,
      tradeId: existing[0].id,
      executionId,
      cycleId: existing[0].cycleId,
      deduplicated: true,
      reconciliationStatus: existing[0].reconciliationStatus,
    };
  }

  try {
    return await db.transaction(async tx => {
      const cycleId = await resolveCycleId(tx, input);
      const pnl = inferPnlTruth(input);
      const orderId = input.execution.orderId || null;
      const exchangeResponse = input.execution.raw === undefined
        ? null
        : JSON.stringify(input.execution.raw);

      let signalId = input.signal.id;
      if (!signalId) {
        const signalResult = await tx.insert(signals).values({
          strategyId: input.strategy.id,
          userId: input.strategy.userId,
          executionId,
          cycleId,
          rawPayload: JSON.stringify(input.signal.rawPayload ?? {
            action: input.signal.action,
            symbol: input.strategy.symbol,
            triggerSource: input.order.triggerSource,
          }),
          parsedAction: input.signal.action,
          parsedSymbol: input.strategy.symbol,
          parsedPrice: decimal(input.signal.parsedPrice ?? input.execution.averagePrice),
          status: input.execution.status === "failed" ? "failed" : "executed",
          message: executionMessage(input, pnl.netPnl),
          exchangeResponse,
          orderId,
          latencyMs: input.signal.latencyMs ?? null,
          source: input.signal.source,
        } satisfies InsertSignal);
        signalId = extractInsertId(signalResult);
      } else {
        await tx
          .update(signals)
          .set({
            executionId,
            cycleId,
            status: input.execution.status === "failed" ? "failed" : "executed",
            message: executionMessage(input, pnl.netPnl),
            exchangeResponse,
            orderId,
            latencyMs: input.signal.latencyMs ?? undefined,
          })
          .where(eq(signals.id, signalId));
      }

      const finalSize = finiteNumber(input.execution.filledSize) ?? input.order.requestedSize;
      const finalPrice = finiteNumber(input.execution.averagePrice) ?? finiteNumber(input.order.requestedPrice);
      const tradeResult = await tx.insert(trades).values({
        strategyId: input.strategy.id,
        userId: input.strategy.userId,
        signalId,
        executionId,
        cycleId,
        exchange: input.strategy.exchange,
        symbol: input.strategy.symbol,
        side: input.order.side,
        orderType: input.order.orderType,
        orderId,
        exchangeTradeId: input.execution.exchangeTradeId || null,
        requestedSize: decimal(input.order.requestedSize),
        requestedPrice: decimal(input.order.requestedPrice),
        size: decimal(finalSize)!,
        price: decimal(finalPrice),
        priceSource: finiteNumber(input.execution.averagePrice) !== null ? "exchange_fill" : "order_request",
        sizeSource: finiteNumber(input.execution.filledSize) !== null ? "exchange_fill" : "order_request",
        reduceOnly: input.order.reduceOnly,
        grossPnl: decimal(input.execution.grossPnl),
        fee: decimal(input.execution.fee),
        fundingFee: decimal(input.execution.fundingFee),
        realizedPnl: decimal(pnl.netPnl),
        netRealizedPnl: decimal(pnl.netPnl),
        realizedPnlPct: decimal(input.execution.realizedPnlPct, 6),
        pnlCurrency: input.execution.pnlCurrency || (input.order.reduceOnly ? "USDT" : null),
        pnlSource: pnl.pnlSource,
        dataQuality: pnl.dataQuality,
        reconciliationStatus: pnl.reconciliationStatus,
        reconciliationAttempts: 0,
        filledAt: input.execution.filledAt ?? (isFilled(input.execution.status) ? new Date() : null),
        status: input.execution.status,
        triggerSource: input.order.triggerSource,
        strategyName: input.strategy.name || null,
        strategyKey: input.strategy.strategyKey || null,
      } satisfies InsertTrade);
      const tradeId = extractInsertId(tradeResult);

      return {
        signalId,
        tradeId,
        executionId,
        cycleId,
        deduplicated: false,
        reconciliationStatus: pnl.reconciliationStatus,
      };
    });
  } catch (error) {
    // 並行重試可能同時通過前置查詢；唯一 executionId 使後到者安全回讀既有結果。
    const duplicate = await db
      .select({ id: trades.id, signalId: trades.signalId, cycleId: trades.cycleId, reconciliationStatus: trades.reconciliationStatus })
      .from(trades)
      .where(eq(trades.executionId, executionId))
      .limit(1);
    if (duplicate[0]?.signalId && duplicate[0]?.cycleId) {
      return {
        signalId: duplicate[0].signalId,
        tradeId: duplicate[0].id,
        executionId,
        cycleId: duplicate[0].cycleId,
        deduplicated: true,
        reconciliationStatus: duplicate[0].reconciliationStatus,
      };
    }
    throw error;
  }
}

export function recordCloseExecution(
  input: Omit<RecordTradeExecutionInput, "order"> & {
    order: Omit<LedgerOrderInput, "reduceOnly">;
  },
): Promise<RecordedTradeExecution> {
  return recordTradeExecution({
    ...input,
    order: { ...input.order, reduceOnly: true },
  });
}

/**
 * 舊策略／控制路徑的相容遷移入口。
 *
 * 接受原 createTrade 物件，保留既有下單控制流，但將持久化統一導入 ledger。
 * 沒有 signalId 時會先以 orderId 尋找既有訊號；仍找不到便建立結構化訊號，
 * 因而未來任何策略都不再能產生「有成交、訊號盈虧卻為空」的孤兒交易。
 */
export async function recordExistingTradeExecution(
  input: ExistingTradeExecutionInput,
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");

  let signalId = input.signalId ?? undefined;
  if (!signalId && input.orderId) {
    const linked = await db
      .select({ id: signals.id })
      .from(signals)
      .where(and(
        eq(signals.strategyId, input.strategyId),
        eq(signals.orderId, input.orderId),
      ))
      .orderBy(desc(signals.id))
      .limit(1);
    signalId = linked[0]?.id;
  }

  const exchangeResult = input.exchangeResult;
  const result = await recordTradeExecution({
    strategy: {
      id: input.strategyId,
      userId: input.userId,
      name: input.strategyName ?? null,
      strategyKey: input.strategyKey ?? null,
      exchange: input.exchange,
      symbol: input.symbol,
    },
    signal: {
      id: signalId,
      action: input.signal?.action ?? (input.reduceOnly ? "close" : input.side),
      source: input.signal?.source ?? inferSignalSource(input.triggerSource),
      rawPayload: input.signal?.rawPayload,
      parsedPrice: finiteNumber(input.signal?.parsedPrice ?? input.price),
      message: input.signal?.message ?? null,
      latencyMs: input.signal?.latencyMs ?? null,
    },
    order: {
      side: input.side,
      orderType: input.orderType,
      requestedSize: finiteNumber(input.requestedSize ?? input.size) ?? 0,
      requestedPrice: finiteNumber(input.requestedPrice ?? input.price),
      reduceOnly: Boolean(input.reduceOnly),
      triggerSource: input.triggerSource || "legacy_migrated",
    },
    execution: {
      status: normalizeTradeStatus(input.status),
      orderId: exchangeResult?.orderId ?? input.orderId,
      exchangeTradeId: exchangeResult?.tradeId ?? input.exchangeTradeId,
      filledSize: finiteNumber(exchangeResult?.filledSize ?? input.size),
      averagePrice: finiteNumber(exchangeResult?.filledPrice ?? input.price),
      grossPnl: finiteNumber(exchangeResult?.grossRealizedPnl ?? input.grossPnl),
      fee: finiteNumber(exchangeResult?.fee ?? input.fee),
      fundingFee: finiteNumber(exchangeResult?.fundingFee ?? input.fundingFee),
      netRealizedPnl: finiteNumber(
        exchangeResult?.netRealizedPnl
          ?? exchangeResult?.realizedPnl
          ?? input.netRealizedPnl
          ?? input.realizedPnl,
      ),
      realizedPnlPct: finiteNumber(input.realizedPnlPct),
      pnlCurrency: input.pnlCurrency,
      pnlSource: input.pnlSource ?? undefined,
      dataQuality: input.dataQuality ?? undefined,
      filledAt: exchangeResult?.filledAt ? new Date(exchangeResult.filledAt) : input.filledAt,
      raw: exchangeResult?.rawResponse
        ?? (input as ExistingTradeExecutionInput & { exchangeResponse?: unknown }).exchangeResponse,
    },
    executionId: input.executionId ?? undefined,
    cycleId: input.cycleId ?? undefined,
  });
  return result.tradeId;
}

export const __tradeExecutionLedgerTestUtils = {
  buildExecutionId,
  inferPnlTruth,
  inferSignalSource,
  normalizeTradeStatus,
};
