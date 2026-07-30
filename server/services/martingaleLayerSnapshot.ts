import { and, asc, eq, inArray } from "drizzle-orm";
import {
  positionCycles,
  positionLayerCloseAllocations,
  positionLayerEvents,
  type PositionCycle,
  type PositionLayerCloseAllocation,
  type PositionLayerEvent,
  type Strategy,
} from "../../drizzle/schema";
import { getDb, listApiKeys, listStrategies } from "../db";
import type { Position } from "../exchanges/types";
import { evaluateMartingaleStrategyInstance } from "./martingaleCapability";
import {
  getSharedAccountPositionSnapshot,
  MARTINGALE_POSITION_HIDE_PNL_MS,
  MARTINGALE_POSITION_STALE_MS,
  normalizePositionSymbol,
  type AccountPositionResult,
} from "./strategyPositionSnapshot";

const EPSILON = 1e-10;
export const MARTINGALE_LAYER_SNAPSHOT_CONTRACT_VERSION = "martin-layer-snapshot-v1" as const;

export type MartingaleLayerQuality = "exact" | "account_aggregate" | "mismatch" | "stale" | "unavailable";

export interface MartingaleOpenLayerSnapshot {
  layerEventId: number;
  layerIndex: number;
  symbol: string;
  side: "buy" | "sell";
  positionSide: "long" | "short";
  remainingQuantity: number;
  entryPrice: number;
  markPrice: number | null;
  grossUnrealizedPnl: number | null;
  quality: MartingaleLayerQuality;
  filledAt: number;
  message: string;
}

export interface MartingaleCycleSnapshot {
  cycleId: string;
  side: "long" | "short";
  status: PositionCycle["status"];
  dataQuality: PositionCycle["dataQuality"];
  totalOpenQuantity: number;
  totalGrossUnrealizedPnl: number | null;
  layers: MartingaleOpenLayerSnapshot[];
}

export interface MartingaleStrategyLayerSnapshot {
  contractVersion: typeof MARTINGALE_LAYER_SNAPSHOT_CONTRACT_VERSION;
  strategyId: number;
  isMartingale: true;
  maxLayers: number;
  activeCycleCount: number;
  openLayerCount: number;
  quality: MartingaleLayerQuality;
  capturedAt: number | null;
  stale: boolean;
  pnlHidden: boolean;
  refreshError: string | null;
  cycles: MartingaleCycleSnapshot[];
}

interface SnapshotBuildInput {
  strategies: Strategy[];
  cycles: PositionCycle[];
  events: PositionLayerEvent[];
  allocations: PositionLayerCloseAllocation[];
  accounts: ReadonlyMap<number, AccountPositionResult>;
  now?: number;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchingPosition(
  account: AccountPositionResult | undefined,
  symbol: string,
  side: "long" | "short",
): Position | null {
  if (!account || account.error) return null;
  const normalized = normalizePositionSymbol(symbol);
  return account.positions.find(position =>
    normalizePositionSymbol(position.symbol) === normalized
      && position.side === side
      && position.size > 0,
  ) ?? null;
}

function worstQuality(qualities: MartingaleLayerQuality[]): MartingaleLayerQuality {
  const rank: Record<MartingaleLayerQuality, number> = {
    exact: 0,
    account_aggregate: 1,
    stale: 2,
    mismatch: 3,
    unavailable: 4,
  };
  return qualities.reduce<MartingaleLayerQuality>(
    (worst, quality) => rank[quality] > rank[worst] ? quality : worst,
    "exact",
  );
}

/** 純函式，供單元／壓力測試驗證 quantity、quality 與 PnL 降級規則。 */
export function buildMartingaleLayerSnapshots({
  strategies,
  cycles,
  events,
  allocations,
  accounts,
  now = Date.now(),
}: SnapshotBuildInput): MartingaleStrategyLayerSnapshot[] {
  const martingaleStrategies = strategies.flatMap(strategy => {
    const capability = evaluateMartingaleStrategyInstance(strategy);
    return capability.isMartingale ? [{ strategy, maxLayers: capability.maxLayers }] : [];
  });
  const strategyById = new Map(martingaleStrategies.map(item => [item.strategy.id, item]));
  const activeCycles = cycles.filter(cycle => strategyById.has(cycle.strategyId)
    && (cycle.status === "open" || cycle.status === "reconciliation_required"));
  const activeCycleIds = new Set(activeCycles.map(cycle => cycle.cycleId));

  const allocatedByEvent = new Map<number, number>();
  for (const allocation of allocations) {
    if (!activeCycleIds.has(allocation.cycleId)) continue;
    allocatedByEvent.set(
      allocation.layerEventId,
      (allocatedByEvent.get(allocation.layerEventId) ?? 0)
        + (finiteNumber(allocation.allocatedQuantity) ?? 0),
    );
  }

  const openEvents = events.flatMap(event => {
    if (!activeCycleIds.has(event.cycleId)) return [];
    const original = finiteNumber(event.quantity) ?? 0;
    const remaining = Math.max(0, original - (allocatedByEvent.get(event.id) ?? 0));
    return remaining > EPSILON ? [{ event, remaining }] : [];
  });

  // 對帳單位是交易所實際合併持倉：API 帳戶 + 標準交易對 + 方向。
  const groupOpenQuantity = new Map<string, number>();
  const groupStrategyIds = new Map<string, Set<number>>();
  for (const cycle of activeCycles) {
    const key = `${cycle.apiKeyId}:${normalizePositionSymbol(cycle.symbol)}:${cycle.side}`;
    groupStrategyIds.set(key, groupStrategyIds.get(key) ?? new Set<number>());
    groupStrategyIds.get(key)!.add(cycle.strategyId);
  }
  for (const item of openEvents) {
    const cycle = activeCycles.find(candidate => candidate.cycleId === item.event.cycleId);
    if (!cycle) continue;
    const key = `${cycle.apiKeyId}:${normalizePositionSymbol(cycle.symbol)}:${cycle.side}`;
    groupOpenQuantity.set(key, (groupOpenQuantity.get(key) ?? 0) + item.remaining);
  }

  return martingaleStrategies.map(({ strategy, maxLayers }) => {
    const strategyCycles = activeCycles.filter(cycle => cycle.strategyId === strategy.id);
    const account = accounts.get(strategy.apiKeyId);
    const capturedAt = account?.capturedAt ?? null;
    const ageMs = capturedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - capturedAt);
    const hardStale = ageMs > MARTINGALE_POSITION_HIDE_PNL_MS;
    const stale = hardStale || ageMs > MARTINGALE_POSITION_STALE_MS || Boolean(account?.refreshError);
    const cycleSnapshots: MartingaleCycleSnapshot[] = strategyCycles.map(cycle => {
      const cycleEvents = openEvents
        .filter(item => item.event.cycleId === cycle.cycleId)
        .sort((a, b) => a.event.layerIndex - b.event.layerIndex || a.event.id - b.event.id);
      const position = matchingPosition(account, cycle.symbol, cycle.side);
      const markPrice = finiteNumber(position?.markPrice);
      const groupKey = `${cycle.apiKeyId}:${normalizePositionSymbol(cycle.symbol)}:${cycle.side}`;
      const ledgerGroupQuantity = groupOpenQuantity.get(groupKey) ?? 0;
      const exchangeQuantity = finiteNumber(position?.size);
      const quantityMismatch = exchangeQuantity === null
        || exchangeQuantity <= EPSILON
        || Math.abs(ledgerGroupQuantity - exchangeQuantity) / exchangeQuantity > 0.01;
      const isAggregate = (groupStrategyIds.get(groupKey)?.size ?? 0) > 1;
      const eventNeedsReconciliation = cycle.dataQuality === "reconciliation_required"
        || cycleEvents.some(item => item.event.dataQuality === "reconciliation_required");

      let quality: MartingaleLayerQuality;
      let message: string;
      if (!account || account.error || markPrice === null) {
        quality = "unavailable";
        message = account?.error || "交易所標記價不可用";
      } else if (eventNeedsReconciliation || quantityMismatch) {
        quality = "mismatch";
        message = "逐層剩餘數量與交易所持倉不一致，已隱藏可能誤導的盈虧";
      } else if (hardStale || stale) {
        quality = "stale";
        message = hardStale
          ? "快照超過五分鐘，已隱藏盈虧"
          : `快照已過期${account.refreshError ? `：${account.refreshError}` : ""}`;
      } else if (isAggregate) {
        quality = "account_aggregate";
        message = "多個馬丁策略共享同一帳戶持倉；按逐層 ledger 分配毛盈虧";
      } else {
        quality = "exact";
        message = "交易所標記價與逐層剩餘數量已對帳";
      }

      const pnlAllowed = markPrice !== null
        && !hardStale
        && quality !== "mismatch"
        && quality !== "unavailable";
      const layers = cycleEvents.map(({ event, remaining }): MartingaleOpenLayerSnapshot => {
        const entryPrice = finiteNumber(event.entryPrice) ?? 0;
        const direction = cycle.side === "long" ? 1 : -1;
        return {
          layerEventId: event.id,
          layerIndex: event.layerIndex,
          symbol: cycle.symbol,
          side: event.side,
          positionSide: cycle.side,
          remainingQuantity: remaining,
          entryPrice,
          markPrice,
          grossUnrealizedPnl: pnlAllowed && markPrice !== null
            ? direction * (markPrice - entryPrice) * remaining
            : null,
          quality,
          filledAt: event.filledAt.getTime(),
          message,
        };
      });
      const pnlValues = layers.map(layer => layer.grossUnrealizedPnl);
      return {
        cycleId: cycle.cycleId,
        side: cycle.side,
        status: cycle.status,
        dataQuality: cycle.dataQuality,
        totalOpenQuantity: layers.reduce((sum, layer) => sum + layer.remainingQuantity, 0),
        totalGrossUnrealizedPnl: pnlValues.every(value => value !== null)
          ? pnlValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
          : null,
        layers,
      };
    });
    const qualities = cycleSnapshots.flatMap(cycle => cycle.layers.map(layer => layer.quality));
    const quality = qualities.length > 0 ? worstQuality(qualities) : "unavailable";
    const openLayerCount = cycleSnapshots.reduce((sum, cycle) => sum + cycle.layers.length, 0);
    return {
      contractVersion: MARTINGALE_LAYER_SNAPSHOT_CONTRACT_VERSION,
      strategyId: strategy.id,
      isMartingale: true,
      maxLayers,
      activeCycleCount: cycleSnapshots.length,
      openLayerCount,
      quality,
      capturedAt,
      stale,
      pnlHidden: hardStale || quality === "mismatch" || quality === "unavailable",
      refreshError: account?.refreshError ?? account?.error ?? null,
      cycles: cycleSnapshots,
    };
  });
}

export interface GetMartingaleLayerSnapshotsOptions {
  forceRefresh?: boolean;
  includeMarketData?: boolean;
}

/**
 * 使用者級批次讀取。requestedStrategyIds 先經 owner + capability 過濾；非馬丁策略不查 cycle、
 * 不讀 API 帳戶快照，也不會出現在回傳結果。
 */
export async function getMartingaleLayerSnapshotsForUser(
  userId: number,
  requestedStrategyIds?: readonly number[],
  options: GetMartingaleLayerSnapshotsOptions = {},
): Promise<MartingaleStrategyLayerSnapshot[]> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");

  const allStrategies = await listStrategies(userId);
  const requestedSet = requestedStrategyIds?.length ? new Set(requestedStrategyIds) : null;
  const martingaleStrategies = allStrategies.filter(strategy =>
    (!requestedSet || requestedSet.has(strategy.id))
      && evaluateMartingaleStrategyInstance(strategy).isMartingale,
  );
  if (martingaleStrategies.length === 0) return [];

  const strategyIds = martingaleStrategies.map(strategy => strategy.id);
  const cycles = await db
    .select()
    .from(positionCycles)
    .where(and(
      eq(positionCycles.userId, userId),
      inArray(positionCycles.strategyId, strategyIds),
      inArray(positionCycles.status, ["open", "reconciliation_required"]),
    ))
    .orderBy(asc(positionCycles.strategyId), asc(positionCycles.openedAt));
  const cycleIds = cycles.map(cycle => cycle.cycleId);
  const [events, allocations] = cycleIds.length === 0
    ? [[], []] as [PositionLayerEvent[], PositionLayerCloseAllocation[]]
    : await Promise.all([
      db.select().from(positionLayerEvents)
        .where(inArray(positionLayerEvents.cycleId, cycleIds))
        .orderBy(asc(positionLayerEvents.cycleId), asc(positionLayerEvents.layerIndex)),
      db.select().from(positionLayerCloseAllocations)
        .where(inArray(positionLayerCloseAllocations.cycleId, cycleIds))
        .orderBy(asc(positionLayerCloseAllocations.cycleId), asc(positionLayerCloseAllocations.id)),
    ]);

  const accounts = new Map<number, AccountPositionResult>();
  if (options.includeMarketData !== false && cycles.length > 0) {
    const apiKeys = await listApiKeys(userId);
    const apiKeyById = new Map(apiKeys.map(apiKey => [apiKey.id, apiKey]));
    const neededApiKeyIds = Array.from(new Set(cycles.map(cycle => cycle.apiKeyId)));
    await Promise.all(neededApiKeyIds.map(async apiKeyId => {
      const apiKey = apiKeyById.get(apiKeyId);
      if (!apiKey) return;
      accounts.set(apiKeyId, await getSharedAccountPositionSnapshot(userId, apiKey, {
        forceRefresh: options.forceRefresh,
      }));
    }));
  }

  return buildMartingaleLayerSnapshots({
    strategies: martingaleStrategies,
    cycles,
    events,
    allocations,
    accounts,
  });
}
