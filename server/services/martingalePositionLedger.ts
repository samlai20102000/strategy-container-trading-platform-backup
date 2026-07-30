import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  positionCycles,
  positionLayerCloseAllocations,
  positionLayerEvents,
  strategies,
} from "../../drizzle/schema";
import type { RecordTradeExecutionInput } from "./tradeExecutionLedger";
import { evaluateMartingaleStrategyInstance } from "./martingaleCapability";

const EPSILON = 1e-10;

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decimal(value: number | null): string | null {
  return value === null ? null : value.toFixed(8);
}

function positionSide(input: RecordTradeExecutionInput): "long" | "short" {
  if (input.order.reduceOnly) return input.order.side === "sell" ? "long" : "short";
  return input.order.side === "buy" ? "long" : "short";
}

interface FifoLayerEvent {
  id: number;
  layerIndex: number;
  quantity: unknown;
  entryPrice: unknown;
}

interface FifoPriorAllocation {
  layerEventId: number;
  quantity: unknown;
}

interface PlannedFifoAllocation {
  eventId: number;
  layerIndex: number;
  quantity: number;
  entryPrice: number;
}

function planFifoCloseAllocations(
  events: FifoLayerEvent[],
  existingAllocations: FifoPriorAllocation[],
  closeQuantity: number,
): {
  allocations: PlannedFifoAllocation[];
  unallocatedClose: number;
  totalOpened: number;
  totalClosedBefore: number;
  totalClosedAfter: number;
} {
  const allocatedByEvent = new Map<number, number>();
  for (const allocation of existingAllocations) {
    allocatedByEvent.set(
      allocation.layerEventId,
      (allocatedByEvent.get(allocation.layerEventId) ?? 0)
        + (finiteNumber(allocation.quantity) ?? 0),
    );
  }

  let unallocatedClose = closeQuantity;
  const allocations: PlannedFifoAllocation[] = [];
  for (const event of events) {
    if (unallocatedClose <= EPSILON) break;
    const eventQuantity = finiteNumber(event.quantity) ?? 0;
    const alreadyAllocated = allocatedByEvent.get(event.id) ?? 0;
    const available = Math.max(0, eventQuantity - alreadyAllocated);
    if (available <= EPSILON) continue;
    const entryPrice = finiteNumber(event.entryPrice);
    if (entryPrice === null) continue;
    const quantity = Math.min(available, unallocatedClose);
    allocations.push({ eventId: event.id, layerIndex: event.layerIndex, quantity, entryPrice });
    unallocatedClose -= quantity;
  }

  const totalOpened = events.reduce(
    (sum, event) => sum + (finiteNumber(event.quantity) ?? 0),
    0,
  );
  const totalClosedBefore = existingAllocations.reduce(
    (sum, allocation) => sum + (finiteNumber(allocation.quantity) ?? 0),
    0,
  );
  const totalClosedAfter = totalClosedBefore
    + allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
  return { allocations, unallocatedClose, totalOpened, totalClosedBefore, totalClosedAfter };
}

function nextLayerDecision(
  latestLayerIndex: number,
  maxLayers: number,
  contextQuality: MartingaleCycleContext["dataQuality"],
): { layerIndex: number; dataQuality: MartingaleCycleContext["dataQuality"] } {
  const layerIndex = latestLayerIndex + 1;
  return {
    layerIndex,
    dataQuality: layerIndex > maxLayers ? "reconciliation_required" : contextQuality,
  };
}

export interface MartingaleCycleContext {
  isMartingale: boolean;
  cycleId: string;
  cycleRowId: number | null;
  apiKeyId: number | null;
  side: "long" | "short";
  maxLayers: number;
  dataQuality: "live_exact" | "reconciliation_required";
}

/**
 * 在同一成交 transaction 內解析馬丁循環。
 * 非馬丁／未知／無效配置一律原樣回傳 fallbackCycleId，且不建立任何逐層資料。
 */
export async function resolveMartingaleCycle(
  tx: any,
  input: RecordTradeExecutionInput,
  fallbackCycleId: string,
  executionId: string,
): Promise<MartingaleCycleContext> {
  const side = positionSide(input);
  const noOp: MartingaleCycleContext = {
    isMartingale: false,
    cycleId: fallbackCycleId,
    cycleRowId: null,
    apiKeyId: null,
    side,
    maxLayers: 0,
    dataQuality: "reconciliation_required",
  };

  if (input.execution.status !== "filled") return noOp;

  const strategyRows = await tx
    .select({
      id: strategies.id,
      userId: strategies.userId,
      apiKeyId: strategies.apiKeyId,
      exchange: strategies.exchange,
      symbol: strategies.symbol,
      strategyKey: strategies.strategyKey,
      martinState: strategies.martinState,
      maxMartinLevel: strategies.maxMartinLevel,
      martinMultiplier: strategies.martinMultiplier,
    })
    .from(strategies)
    .where(and(
      eq(strategies.id, input.strategy.id),
      eq(strategies.userId, input.strategy.userId),
    ))
    .limit(1);
  const strategy = strategyRows[0];
  if (!strategy) return noOp;

  const capability = evaluateMartingaleStrategyInstance(strategy);
  if (!capability.isMartingale) return noOp;

  // 鎖定策略資料列，序列化同一策略的首次建循環／層號分配；不更新策略狀態。
  await tx.execute(sql`SELECT id FROM strategies WHERE id = ${strategy.id} FOR UPDATE`);

  const activeRows = await tx
    .select({
      id: positionCycles.id,
      cycleId: positionCycles.cycleId,
      dataQuality: positionCycles.dataQuality,
    })
    .from(positionCycles)
    .where(and(
      eq(positionCycles.strategyId, strategy.id),
      eq(positionCycles.symbol, strategy.symbol),
      eq(positionCycles.side, side),
      inArray(positionCycles.status, ["open", "reconciliation_required"]),
    ))
    .orderBy(desc(positionCycles.openedAt), desc(positionCycles.id))
    .limit(1);
  const active = activeRows[0];

  const exactFill = (finiteNumber(input.execution.filledSize) ?? 0) > 0
    && (finiteNumber(input.execution.averagePrice) ?? 0) > 0;
  const dataQuality = exactFill ? "live_exact" : "reconciliation_required";

  if (active) {
    return {
      isMartingale: true,
      cycleId: active.cycleId,
      cycleRowId: active.id,
      apiKeyId: strategy.apiKeyId,
      side,
      maxLayers: capability.maxLayers,
      dataQuality: active.dataQuality === "reconciliation_required"
        ? "reconciliation_required"
        : dataQuality,
    };
  }

  // 沒有已知活躍循環的平倉代表 legacy／外部持倉，不憑空捏造逐層資料。
  if (input.order.reduceOnly) {
    return {
      ...noOp,
      isMartingale: true,
      apiKeyId: strategy.apiKeyId,
      maxLayers: capability.maxLayers,
      dataQuality: "reconciliation_required",
    };
  }

  const cycleId = fallbackCycleId;
  const insertResult = await tx.insert(positionCycles).values({
    cycleId,
    userId: strategy.userId,
    strategyId: strategy.id,
    apiKeyId: strategy.apiKeyId,
    exchange: strategy.exchange,
    symbol: strategy.symbol,
    side,
    status: dataQuality === "live_exact" ? "open" : "reconciliation_required",
    dataQuality,
    openedAt: input.execution.filledAt ?? new Date(),
  });
  const header = Array.isArray(insertResult) ? insertResult[0] : insertResult;
  const cycleRowId = Number((header as { insertId?: number }).insertId);

  return {
    isMartingale: true,
    cycleId,
    cycleRowId: Number.isSafeInteger(cycleRowId) && cycleRowId > 0 ? cycleRowId : null,
    apiKeyId: strategy.apiKeyId,
    side,
    maxLayers: capability.maxLayers,
    dataQuality,
  };
}

export async function appendMartingaleExecution(
  tx: any,
  input: RecordTradeExecutionInput,
  context: MartingaleCycleContext,
  executionId: string,
  finalSize: number,
  finalPrice: number | null,
): Promise<void> {
  if (!context.isMartingale || !context.cycleRowId || !context.apiKeyId) return;
  if (input.execution.status !== "filled" || finalSize <= EPSILON) return;

  if (!input.order.reduceOnly) {
    if (finalPrice === null || finalPrice <= 0) {
      await tx
        .update(positionCycles)
        .set({ status: "reconciliation_required", dataQuality: "reconciliation_required" })
        .where(eq(positionCycles.id, context.cycleRowId));
      return;
    }

    // 先鎖循環列，再讀最大層號，避免同策略並行成交取得相同 layerIndex。
    await tx.execute(sql`SELECT id FROM position_cycles WHERE id = ${context.cycleRowId} FOR UPDATE`);
    const latest = await tx
      .select({ layerIndex: positionLayerEvents.layerIndex })
      .from(positionLayerEvents)
      .where(eq(positionLayerEvents.cycleId, context.cycleId))
      .orderBy(desc(positionLayerEvents.layerIndex), desc(positionLayerEvents.id))
      .limit(1);
    const { layerIndex, dataQuality } = nextLayerDecision(
      latest[0]?.layerIndex ?? 0,
      context.maxLayers,
      context.dataQuality,
    );

    await tx.insert(positionLayerEvents).values({
      userId: input.strategy.userId,
      strategyId: input.strategy.id,
      apiKeyId: context.apiKeyId,
      cycleId: context.cycleId,
      layerIndex,
      executionId,
      layerIntentId: executionId,
      orderId: input.execution.orderId || null,
      exchangeTradeId: input.execution.exchangeTradeId || null,
      side: input.order.side,
      quantity: decimal(finalSize)!,
      entryPrice: decimal(finalPrice)!,
      fee: decimal(finiteNumber(input.execution.fee)),
      source: "live_execution",
      dataQuality,
      filledAt: input.execution.filledAt ?? new Date(),
    });

    if (dataQuality === "reconciliation_required") {
      await tx
        .update(positionCycles)
        .set({ status: "reconciliation_required", dataQuality: "reconciliation_required" })
        .where(eq(positionCycles.id, context.cycleRowId));
    }
    return;
  }

  const events = await tx
    .select({
      id: positionLayerEvents.id,
      layerIndex: positionLayerEvents.layerIndex,
      quantity: positionLayerEvents.quantity,
      entryPrice: positionLayerEvents.entryPrice,
    })
    .from(positionLayerEvents)
    .where(eq(positionLayerEvents.cycleId, context.cycleId))
    .orderBy(asc(positionLayerEvents.layerIndex), asc(positionLayerEvents.filledAt), asc(positionLayerEvents.id));
  const existingAllocations = await tx
    .select({
      layerEventId: positionLayerCloseAllocations.layerEventId,
      quantity: positionLayerCloseAllocations.allocatedQuantity,
    })
    .from(positionLayerCloseAllocations)
    .where(eq(positionLayerCloseAllocations.cycleId, context.cycleId));
  const allocationPlan = planFifoCloseAllocations(events, existingAllocations, finalSize);
  const { allocations, unallocatedClose } = allocationPlan;

  const allocatedTotal = allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
  const closeFee = finiteNumber(input.execution.fee);
  for (const allocation of allocations) {
    const grossPnl = finalPrice === null
      ? null
      : (context.side === "long"
        ? finalPrice - allocation.entryPrice
        : allocation.entryPrice - finalPrice) * allocation.quantity;
    const feeShare = closeFee === null || allocatedTotal <= EPSILON
      ? null
      : closeFee * (allocation.quantity / allocatedTotal);
    const realizedPnl = grossPnl === null ? null : grossPnl - (feeShare ?? 0);
    await tx.insert(positionLayerCloseAllocations).values({
      allocationKey: `${executionId}:${allocation.eventId}`,
      userId: input.strategy.userId,
      strategyId: input.strategy.id,
      cycleId: context.cycleId,
      layerEventId: allocation.eventId,
      layerIndex: allocation.layerIndex,
      closeExecutionId: executionId,
      allocatedQuantity: decimal(allocation.quantity)!,
      closePrice: decimal(finalPrice),
      grossPnl: decimal(grossPnl),
      feeShare: decimal(feeShare),
      realizedPnl: decimal(realizedPnl),
      allocationPolicy: "fifo",
      dataQuality: context.dataQuality,
      allocatedAt: input.execution.filledAt ?? new Date(),
    });
  }

  const { totalOpened, totalClosedAfter } = allocationPlan;
  if (unallocatedClose > EPSILON) {
    await tx
      .update(positionCycles)
      .set({ status: "reconciliation_required", dataQuality: "reconciliation_required" })
      .where(eq(positionCycles.id, context.cycleRowId));
  } else if (totalOpened - totalClosedAfter <= EPSILON) {
    await tx
      .update(positionCycles)
      .set({ status: "closed", closedAt: input.execution.filledAt ?? new Date() })
      .where(eq(positionCycles.id, context.cycleRowId));
  }
}

export const __martingalePositionLedgerTestUtils = {
  nextLayerDecision,
  planFifoCloseAllocations,
  positionSide,
};
