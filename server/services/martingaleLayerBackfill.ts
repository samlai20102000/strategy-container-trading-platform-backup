import { and, asc, eq, inArray } from "drizzle-orm";
import {
  positionCycles,
  positionLayerCloseAllocations,
  positionLayerEvents,
  trades,
  type Strategy,
  type Trade,
} from "../../drizzle/schema";
import { getDb, listStrategies } from "../db";
import type { OrderResult } from "../exchanges/types";
import { evaluateMartingaleStrategyInstance } from "./martingaleCapability";

const QUANTITY_TOLERANCE = 0.01;
const ENTRY_PRICE_TOLERANCE = 0.005;
const EPSILON = 1e-10;

type RejectReason =
  | "no_local_open_position"
  | "existing_active_cycle"
  | "no_filled_trade_history"
  | "unverifiable_fill_truth"
  | "direction_conflict"
  | "close_exceeds_open_quantity"
  | "cycle_already_flat"
  | "layer_count_exceeds_configuration"
  | "quantity_mismatch"
  | "entry_price_mismatch";

export interface MartingaleBackfillDecision {
  strategyId: number;
  strategyName: string;
  strategyKey: string | null;
  eligible: boolean;
  reason: "eligible" | RejectReason;
  cycleId: string | null;
  side: "long" | "short" | null;
  layerCount: number;
  reconstructedQuantity: number | null;
  localQuantity: number | null;
  reconstructedEntryPrice: number | null;
  localEntryPrice: number | null;
  written: boolean;
}

export interface MartingaleBackfillReport {
  contractVersion: "martin-layer-backfill-v1";
  mode: "dry-run" | "apply";
  userId: number;
  scannedMartingaleStrategies: number;
  eligibleStrategies: number;
  writtenStrategies: number;
  skippedStrategies: number;
  decisions: MartingaleBackfillDecision[];
}

interface LocalOpenState {
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
}

interface ReconstructedOpen {
  trade: Trade;
  layerIndex: number;
  remainingQuantity: number;
}

interface ReconstructedAllocation {
  openTradeId: number;
  layerIndex: number;
  closeTrade: Trade;
  quantity: number;
}

interface EligibleReconstruction {
  cycleId: string;
  side: "long" | "short";
  opens: ReconstructedOpen[];
  allocations: ReconstructedAllocation[];
  quantity: number;
  entryPrice: number;
}

export type MartingaleOrderTruthResolver = (
  strategy: Strategy,
  trade: Trade,
) => Promise<Partial<OrderResult>>;

export interface MartingaleBackfillOptions {
  apply?: boolean;
  resolveOrderTruth?: MartingaleOrderTruthResolver;
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function localOpenState(strategy: Strategy): LocalOpenState | null {
  const state = strategy.martinState && typeof strategy.martinState === "object"
    ? strategy.martinState as Record<string, unknown>
    : {};
  const quantity = finitePositive(state.totalSize);
  const entryPrice = finitePositive(state.avgPrice);
  const side = state.isLong === true ? "long" : state.isLong === false ? "short" : null;
  return quantity && entryPrice && side ? { side, quantity, entryPrice } : null;
}

function isExactFill(trade: Trade): boolean {
  return trade.status === "filled"
    && Boolean(trade.executionId)
    && finitePositive(trade.size) !== null
    && finitePositive(trade.price) !== null
    && trade.sizeSource === "exchange_fill"
    && trade.priceSource === "exchange_fill";
}

/**
 * 只建立供本次回填使用的記憶體副本；原 trades 列永不改寫。
 * 指定 orderId 的交易所真值必須完整證明狀態、方向、reduce-only、價、量與時間。
 */
export function hydrateLegacyTradeFromOrderTruth(
  trade: Trade,
  truth: Partial<OrderResult>,
): Trade | null {
  if (isExactFill(trade)) return trade;
  const filledPrice = finitePositive(truth.filledPrice);
  const filledSize = finitePositive(truth.filledSize);
  const filledAt = Number(truth.filledAt);
  if (!trade.orderId
    || truth.fillQuality !== "exact"
    || truth.executionStatus !== "filled"
    || truth.executedSide !== trade.side
    || truth.executedReduceOnly !== (trade.reduceOnly === true)
    || filledPrice === null
    || filledSize === null
    || !Number.isFinite(filledAt)
    || filledAt <= 0) {
    return null;
  }
  return {
    ...trade,
    status: "filled",
    executionId: trade.executionId || `legacy-truth:${trade.exchange}:${trade.orderId}`.slice(0, 128),
    exchangeTradeId: truth.tradeId || trade.exchangeTradeId,
    price: filledPrice.toFixed(8),
    size: filledSize.toFixed(8),
    priceSource: "exchange_fill",
    sizeSource: "exchange_fill",
    filledAt: new Date(filledAt),
  };
}

async function resolveVerifiableHistory(
  strategy: Strategy,
  history: Trade[],
  resolver?: MartingaleOrderTruthResolver,
): Promise<Trade[]> {
  if (!resolver) return history;
  const resolved: Trade[] = [];
  for (const trade of history) {
    if (isExactFill(trade) || trade.status !== "filled" || !trade.orderId) {
      resolved.push(trade);
      continue;
    }
    try {
      const truth = await resolver(strategy, trade);
      resolved.push(hydrateLegacyTradeFromOrderTruth(trade, truth) ?? trade);
    } catch {
      resolved.push(trade);
    }
  }
  return resolved;
}

function relativeDiff(left: number, right: number): number {
  return right > EPSILON ? Math.abs(left - right) / right : Number.POSITIVE_INFINITY;
}

function effectiveFillTime(trade: Trade): number {
  const timestamp = (trade.filledAt ?? trade.createdAt)?.getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function reject(
  strategy: Strategy,
  local: LocalOpenState | null,
  reason: RejectReason,
): MartingaleBackfillDecision {
  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    strategyKey: strategy.strategyKey,
    eligible: false,
    reason,
    cycleId: null,
    side: local?.side ?? null,
    layerCount: 0,
    reconstructedQuantity: null,
    localQuantity: local?.quantity ?? null,
    reconstructedEntryPrice: null,
    localEntryPrice: local?.entryPrice ?? null,
    written: false,
  };
}

/**
 * 依交易所精確成交逐筆重播 FIFO 淨倉；每次淨倉精確歸零即形成可證明的循環邊界，
 * 因此較早且已平倉的 LONG／SHORT 循環不會污染最後活躍循環。任何 fill 真值不足、
 * 未歸零前反向開倉、錯向／超量平倉仍整體拒絕，絕不猜測逐層成交。
 */
export function reconstructStrictLegacyCycle(
  strategy: Strategy,
  history: Trade[],
  maxLayers: number,
): { decision: MartingaleBackfillDecision; reconstruction: EligibleReconstruction | null } {
  const local = localOpenState(strategy);
  if (!local) return { decision: reject(strategy, local, "no_local_open_position"), reconstruction: null };
  const filled = history
    .filter(trade => trade.status === "filled")
    .slice()
    .sort((left, right) => effectiveFillTime(left) - effectiveFillTime(right) || left.id - right.id);
  if (filled.length === 0) {
    return { decision: reject(strategy, local, "no_filled_trade_history"), reconstruction: null };
  }
  if (filled.some(trade => !isExactFill(trade))) {
    return { decision: reject(strategy, local, "unverifiable_fill_truth"), reconstruction: null };
  }

  let opens: ReconstructedOpen[] = [];
  let allocations: ReconstructedAllocation[] = [];
  let cycleSide: "long" | "short" | null = null;

  for (const trade of filled) {
    const quantity = finitePositive(trade.size)!;
    if (!trade.reduceOnly) {
      const tradeSide = trade.side === "buy" ? "long" : "short";
      if (cycleSide !== null && tradeSide !== cycleSide) {
        return { decision: reject(strategy, local, "direction_conflict"), reconstruction: null };
      }
      cycleSide = tradeSide;
      opens.push({ trade, layerIndex: opens.length + 1, remainingQuantity: quantity });
      continue;
    }
    if (cycleSide === null) {
      return { decision: reject(strategy, local, "close_exceeds_open_quantity"), reconstruction: null };
    }
    const expectedCloseSide = cycleSide === "long" ? "sell" : "buy";
    if (trade.side !== expectedCloseSide) {
      return { decision: reject(strategy, local, "direction_conflict"), reconstruction: null };
    }

    let remainingClose = quantity;
    for (const open of opens) {
      if (remainingClose <= EPSILON) break;
      const allocated = Math.min(open.remainingQuantity, remainingClose);
      if (allocated <= EPSILON) continue;
      open.remainingQuantity -= allocated;
      remainingClose -= allocated;
      allocations.push({
        openTradeId: open.trade.id,
        layerIndex: open.layerIndex,
        closeTrade: trade,
        quantity: allocated,
      });
    }
    if (remainingClose > EPSILON) {
      return { decision: reject(strategy, local, "close_exceeds_open_quantity"), reconstruction: null };
    }

    if (opens.every(open => open.remainingQuantity <= EPSILON)) {
      // 完全平倉是明確循環邊界；較早事件不屬於現行持倉。
      opens = [];
      allocations = [];
      cycleSide = null;
    }
  }

  const remainingOpens = opens.filter(open => open.remainingQuantity > EPSILON);
  if (remainingOpens.length === 0) {
    return { decision: reject(strategy, local, "cycle_already_flat"), reconstruction: null };
  }
  if (cycleSide !== local.side) {
    return { decision: reject(strategy, local, "direction_conflict"), reconstruction: null };
  }
  if (opens.length > maxLayers) {
    return {
      decision: reject(strategy, local, "layer_count_exceeds_configuration"),
      reconstruction: null,
    };
  }

  const quantity = remainingOpens.reduce((sum, open) => sum + open.remainingQuantity, 0);
  const entryPrice = remainingOpens.reduce(
    (sum, open) => sum + open.remainingQuantity * finitePositive(open.trade.price)!,
    0,
  ) / quantity;
  if (relativeDiff(quantity, local.quantity) > QUANTITY_TOLERANCE) {
    const decision = reject(strategy, local, "quantity_mismatch");
    decision.reconstructedQuantity = quantity;
    decision.reconstructedEntryPrice = entryPrice;
    return { decision, reconstruction: null };
  }
  if (relativeDiff(entryPrice, local.entryPrice) > ENTRY_PRICE_TOLERANCE) {
    const decision = reject(strategy, local, "entry_price_mismatch");
    decision.reconstructedQuantity = quantity;
    decision.reconstructedEntryPrice = entryPrice;
    return { decision, reconstruction: null };
  }

  const firstExecutionId = opens[0]?.trade.executionId!;
  const cycleId = `legacy:${strategy.id}:${firstExecutionId}`.slice(0, 128);
  const reconstruction: EligibleReconstruction = {
    cycleId,
    side: cycleSide,
    opens,
    allocations,
    quantity,
    entryPrice,
  };
  return {
    decision: {
      strategyId: strategy.id,
      strategyName: strategy.name,
      strategyKey: strategy.strategyKey,
      eligible: true,
      reason: "eligible",
      cycleId,
      side: local.side,
      layerCount: remainingOpens.length,
      reconstructedQuantity: quantity,
      localQuantity: local.quantity,
      reconstructedEntryPrice: entryPrice,
      localEntryPrice: local.entryPrice,
      written: false,
    },
    reconstruction,
  };
}

async function writeReconstruction(
  strategy: Strategy,
  reconstruction: EligibleReconstruction,
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db.transaction(async tx => {
    const existing = await tx.select({ id: positionCycles.id })
      .from(positionCycles)
      .where(eq(positionCycles.cycleId, reconstruction.cycleId))
      .limit(1);
    if (existing.length > 0) return false;

    await tx.insert(positionCycles).values({
      cycleId: reconstruction.cycleId,
      userId: strategy.userId,
      strategyId: strategy.id,
      apiKeyId: strategy.apiKeyId,
      exchange: strategy.exchange,
      symbol: strategy.symbol,
      side: reconstruction.side,
      status: "open",
      dataQuality: "legacy_reconstructed",
      openedAt: reconstruction.opens[0].trade.filledAt ?? reconstruction.opens[0].trade.createdAt,
    });

    const eventIdByTradeId = new Map<number, number>();
    for (const open of reconstruction.opens) {
      const result = await tx.insert(positionLayerEvents).values({
        userId: strategy.userId,
        strategyId: strategy.id,
        apiKeyId: strategy.apiKeyId,
        cycleId: reconstruction.cycleId,
        layerIndex: open.layerIndex,
        executionId: open.trade.executionId!,
        layerIntentId: open.trade.executionId!,
        orderId: open.trade.orderId,
        exchangeTradeId: open.trade.exchangeTradeId,
        side: open.trade.side,
        quantity: open.trade.size,
        entryPrice: open.trade.price!,
        fee: open.trade.fee,
        source: "legacy_reconstructed",
        dataQuality: "legacy_reconstructed",
        filledAt: open.trade.filledAt ?? open.trade.createdAt,
      });
      const header = Array.isArray(result) ? result[0] : result;
      const eventId = Number((header as { insertId?: number }).insertId);
      if (!Number.isSafeInteger(eventId) || eventId <= 0) {
        throw new Error(`回填 layer event insertId 無效：tradeId=${open.trade.id}`);
      }
      eventIdByTradeId.set(open.trade.id, eventId);
    }

    for (const allocation of reconstruction.allocations) {
      const layerEventId = eventIdByTradeId.get(allocation.openTradeId);
      if (!layerEventId) throw new Error(`找不到回填 layer event：tradeId=${allocation.openTradeId}`);
      const closePrice = finitePositive(allocation.closeTrade.price)!;
      const open = reconstruction.opens.find(item => item.trade.id === allocation.openTradeId)!;
      const entryPrice = finitePositive(open.trade.price)!;
      const grossPnl = (reconstruction.side === "long" ? closePrice - entryPrice : entryPrice - closePrice)
        * allocation.quantity;
      await tx.insert(positionLayerCloseAllocations).values({
        allocationKey: `legacy:${allocation.closeTrade.executionId}:${allocation.openTradeId}`.slice(0, 180),
        userId: strategy.userId,
        strategyId: strategy.id,
        cycleId: reconstruction.cycleId,
        layerEventId,
        layerIndex: allocation.layerIndex,
        closeExecutionId: allocation.closeTrade.executionId!,
        allocatedQuantity: allocation.quantity.toFixed(8),
        closePrice: closePrice.toFixed(8),
        grossPnl: grossPnl.toFixed(8),
        feeShare: null,
        realizedPnl: null,
        allocationPolicy: "fifo",
        dataQuality: "legacy_reconstructed",
        allocatedAt: allocation.closeTrade.filledAt ?? allocation.closeTrade.createdAt,
      });
    }
    return true;
  });
}

export async function backfillMartingaleLayersForUser(
  userId: number,
  options: MartingaleBackfillOptions = {},
): Promise<MartingaleBackfillReport> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  const strategies = (await listStrategies(userId)).filter(strategy =>
    evaluateMartingaleStrategyInstance(strategy).isMartingale,
  );
  if (strategies.length === 0) {
    return {
      contractVersion: "martin-layer-backfill-v1",
      mode: options.apply ? "apply" : "dry-run",
      userId,
      scannedMartingaleStrategies: 0,
      eligibleStrategies: 0,
      writtenStrategies: 0,
      skippedStrategies: 0,
      decisions: [],
    };
  }

  const strategyIds = strategies.map(strategy => strategy.id);
  const [history, existingCycles] = await Promise.all([
    db.select().from(trades)
      .where(and(eq(trades.userId, userId), inArray(trades.strategyId, strategyIds)))
      .orderBy(asc(trades.strategyId), asc(trades.filledAt), asc(trades.createdAt), asc(trades.id)),
    db.select({ strategyId: positionCycles.strategyId }).from(positionCycles)
      .where(and(
        eq(positionCycles.userId, userId),
        inArray(positionCycles.strategyId, strategyIds),
        inArray(positionCycles.status, ["open", "reconciliation_required"]),
      )),
  ]);
  const existingStrategyIds = new Set(existingCycles.map(cycle => cycle.strategyId));
  const historyByStrategy = new Map<number, Trade[]>();
  for (const trade of history) {
    historyByStrategy.set(trade.strategyId, historyByStrategy.get(trade.strategyId) ?? []);
    historyByStrategy.get(trade.strategyId)!.push(trade);
  }

  const decisions: MartingaleBackfillDecision[] = [];
  for (const strategy of strategies) {
    const local = localOpenState(strategy);
    if (existingStrategyIds.has(strategy.id)) {
      decisions.push(reject(strategy, local, "existing_active_cycle"));
      continue;
    }
    const capability = evaluateMartingaleStrategyInstance(strategy);
    const verifiedHistory = await resolveVerifiableHistory(
      strategy,
      historyByStrategy.get(strategy.id) ?? [],
      options.resolveOrderTruth,
    );
    const result = reconstructStrictLegacyCycle(
      strategy,
      verifiedHistory,
      capability.maxLayers,
    );
    if (options.apply && result.reconstruction) {
      result.decision.written = await writeReconstruction(strategy, result.reconstruction);
    }
    decisions.push(result.decision);
  }

  return {
    contractVersion: "martin-layer-backfill-v1",
    mode: options.apply ? "apply" : "dry-run",
    userId,
    scannedMartingaleStrategies: decisions.length,
    eligibleStrategies: decisions.filter(decision => decision.eligible).length,
    writtenStrategies: decisions.filter(decision => decision.written).length,
    skippedStrategies: decisions.filter(decision => !decision.eligible).length,
    decisions,
  };
}
