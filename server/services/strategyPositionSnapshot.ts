import { eq } from "drizzle-orm";
import { accountPositionSnapshots, type ApiKey, type Strategy } from "../../drizzle/schema";
import { getDb, listApiKeys, listStrategies } from "../db";
import { createAdapter } from "../exchanges/factory";
import type { Position } from "../exchanges/types";
import { acquireProcessLease, releaseProcessLease } from "./barLock";

export const STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION = "exchange-position-v2" as const;

export type PositionSnapshotSource = "exchange_position" | "local_estimate";
export type PositionAttribution = "exact" | "singleton_exchange" | "account_aggregate" | "unavailable";
export type PositionSnapshotStatus =
  | "available"
  | "no_local_position"
  | "no_exchange_position"
  | "exchange_unavailable"
  | "incomplete_exchange_position";
export type PositionPnlKind = "exchange_unrealized" | "strategy_gross_estimate" | "unavailable";

export interface StrategyPositionSnapshot {
  contractVersion: typeof STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION;
  strategyId: number;
  apiKeyId: number;
  exchange: Strategy["exchange"];
  symbol: string;
  side: "long" | "short" | null;
  status: PositionSnapshotStatus;
  source: PositionSnapshotSource;
  attribution: PositionAttribution;
  pnlKind: PositionPnlKind;
  capturedAt: number | null;
  exchangeUpdatedAt: number | null;
  stale: boolean;
  size: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  leverage: number | null;
  positionMargin: number | null;
  accountPositionSize: number | null;
  accountUnrealizedPnl: number | null;
  message: string;
}

export interface AccountPositionResult {
  contractVersion: typeof STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION;
  positions: Position[];
  capturedAt: number;
  error?: string;
  /** 有最後成功快照可用，但最近一次刷新失敗；呼叫端應標示 stale／warning。 */
  refreshError?: string;
}

export interface AccountPositionSnapshotOptions {
  forceRefresh?: boolean;
}

interface LocalPositionState {
  strategy: Strategy;
  side: "long" | "short" | null;
  size: number;
  entryPrice: number;
  hasPosition: boolean;
  groupKey: string | null;
}

export const POSITION_CACHE_TTL_MS = 5_000;
export const POSITION_STALE_AFTER_MS = 15_000;
export const MARTINGALE_POSITION_REFRESH_MS = 60_000;
export const MARTINGALE_POSITION_STALE_MS = 120_000;
export const MARTINGALE_POSITION_HIDE_PNL_MS = 300_000;
const MARTINGALE_REFRESH_ERROR_RETRY_MS = 30_000;
const MARTINGALE_REFRESH_LEASE_MS = 20_000;
const accountPositionCache = new Map<
  string,
  { expiresAt: number; promise: Promise<AccountPositionResult> }
>();

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/** BTCUSDT、BTC-USDT 與 BTC-USDT-SWAP 會被歸到同一標準鍵。 */
export function normalizePositionSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/-SWAP$/i, "").replace(/[^A-Z0-9]/g, "");
}

function toLocalPositionState(strategy: Strategy): LocalPositionState {
  const raw = strategy.martinState && typeof strategy.martinState === "object"
    ? strategy.martinState as Record<string, unknown>
    : {};
  const size = positiveNumber(raw.totalSize) ?? 0;
  const entryPrice = positiveNumber(raw.avgPrice) ?? 0;
  const side = raw.isLong === true ? "long" : raw.isLong === false ? "short" : null;
  const hasPosition = size > 0 && entryPrice > 0 && side !== null;
  return {
    strategy,
    side,
    size,
    entryPrice,
    hasPosition,
    groupKey: hasPosition
      ? `${strategy.apiKeyId}:${normalizePositionSymbol(strategy.symbol)}:${side}`
      : null,
  };
}

function sanitizeExchangeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[\r\n]+/g, " ")
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/([?&](?:api[-_]?key|secret|sign(?:ature)?|passphrase|token|authorization)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(api[-_ ]?key|secret|sign(?:ature)?|passphrase|token|authorization)(\s*[:=]\s*)[^\s,;&]+/gi, "$1$2[REDACTED]")
    .slice(0, 240) || "交易所持倉查詢失敗";
}

function persistedSnapshotKey(userId: number, apiKeyId: number): string {
  return `martin-position-v1:${userId}:${apiKeyId}`;
}

function persistedPositions(value: unknown): Position[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Position => {
    if (!item || typeof item !== "object") return false;
    const row = item as Partial<Position>;
    return typeof row.symbol === "string"
      && (row.side === "long" || row.side === "short")
      && Number.isFinite(Number(row.size))
      && Number.isFinite(Number(row.entryPrice))
      && Number.isFinite(Number(row.markPrice));
  });
}

/**
 * 馬丁逐層頁面專用的一分鐘帳戶級共享快照。
 *
 * 跨 instance 以資料庫 row + ProcessLease 去重；同一 API 帳戶無論有多少策略卡或層級，
 * 一分鐘內最多向交易所刷新一次。此函式只呼叫 getPositions，沒有任何下單副作用。
 */
export async function getSharedAccountPositionSnapshot(
  userId: number,
  apiKey: ApiKey,
  options: AccountPositionSnapshotOptions = {},
): Promise<AccountPositionResult> {
  const db = await getDb();
  if (!db) return getAccountPositionSnapshot(userId, apiKey, options);

  const now = Date.now();
  const snapshotKey = persistedSnapshotKey(userId, apiKey.id);
  const readRow = async () => {
    const rows = await db
      .select()
      .from(accountPositionSnapshots)
      .where(eq(accountPositionSnapshots.snapshotKey, snapshotKey))
      .limit(1);
    return rows[0] ?? null;
  };
  const toResult = (row: Awaited<ReturnType<typeof readRow>>): AccountPositionResult | null => {
    if (!row) return null;
    const capturedAt = row.capturedAt.getTime();
    if (row.status === "error") {
      return {
        contractVersion: STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION,
        positions: [],
        capturedAt,
        error: row.sanitizedError || "交易所持倉查詢失敗",
      };
    }
    return {
      contractVersion: STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION,
      positions: persistedPositions(row.positions),
      capturedAt,
      refreshError: row.sanitizedError || undefined,
    };
  };

  const existing = await readRow();
  if (!options.forceRefresh && existing && existing.expiresAt.getTime() > now) {
    return toResult(existing)!;
  }

  const lease = await acquireProcessLease(
    `martin-position-snapshot-v1:${userId}`,
    apiKey.id,
    MARTINGALE_REFRESH_LEASE_MS,
  );
  if (!lease) {
    const latest = await readRow();
    return toResult(latest) ?? {
      contractVersion: STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION,
      positions: [],
      capturedAt: now,
      error: "帳戶持倉快照正在由另一個實例刷新，請稍後重試",
    };
  }

  try {
    // 取得租約後再讀一次，避免等待租約期間其他 instance 已完成刷新。
    const latest = await readRow();
    if (!options.forceRefresh && latest && latest.expiresAt.getTime() > Date.now()) {
      return toResult(latest)!;
    }

    const refreshed = await getAccountPositionSnapshot(userId, apiKey, { forceRefresh: true });
    const refreshedAt = refreshed.capturedAt || Date.now();
    if (!refreshed.error) {
      await db.insert(accountPositionSnapshots).values({
        snapshotKey,
        userId,
        apiKeyId: apiKey.id,
        exchange: apiKey.exchange,
        status: "available",
        positions: refreshed.positions,
        sanitizedError: null,
        capturedAt: new Date(refreshedAt),
        expiresAt: new Date(refreshedAt + MARTINGALE_POSITION_REFRESH_MS),
      }).onDuplicateKeyUpdate({ set: {
        status: "available",
        positions: refreshed.positions,
        sanitizedError: null,
        capturedAt: new Date(refreshedAt),
        expiresAt: new Date(refreshedAt + MARTINGALE_POSITION_REFRESH_MS),
      } });
      return refreshed;
    }

    const sanitizedError = sanitizeExchangeError(refreshed.error);
    const lastGood = latest?.status === "available" ? latest : null;
    if (lastGood) {
      await db.update(accountPositionSnapshots).set({
        sanitizedError,
        expiresAt: new Date(Date.now() + MARTINGALE_REFRESH_ERROR_RETRY_MS),
      }).where(eq(accountPositionSnapshots.id, lastGood.id));
      return {
        contractVersion: STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION,
        positions: persistedPositions(lastGood.positions),
        capturedAt: lastGood.capturedAt.getTime(),
        refreshError: sanitizedError,
      };
    }

    await db.insert(accountPositionSnapshots).values({
      snapshotKey,
      userId,
      apiKeyId: apiKey.id,
      exchange: apiKey.exchange,
      status: "error",
      positions: [],
      sanitizedError,
      capturedAt: new Date(refreshedAt),
      expiresAt: new Date(Date.now() + MARTINGALE_REFRESH_ERROR_RETRY_MS),
    }).onDuplicateKeyUpdate({ set: {
      status: "error",
      positions: [],
      sanitizedError,
      capturedAt: new Date(refreshedAt),
      expiresAt: new Date(Date.now() + MARTINGALE_REFRESH_ERROR_RETRY_MS),
    } });
    return { ...refreshed, error: sanitizedError };
  } finally {
    await releaseProcessLease(lease);
  }
}

/**
 * 控制中心、策略頁與獨立持倉頁共用的帳戶級交易所持倉快照。
 * 同一使用者／API 金鑰／金鑰版本在 TTL 內只會建立一個 Promise，避免跨頁各查一次造成時間差。
 */
export async function getAccountPositionSnapshot(
  userId: number,
  apiKey: ApiKey,
  options: AccountPositionSnapshotOptions = {},
): Promise<AccountPositionResult> {
  const cacheKey = `${userId}:${apiKey.id}:${apiKey.updatedAt.getTime()}`;
  const cached = accountPositionCache.get(cacheKey);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async (): Promise<AccountPositionResult> => {
    try {
      const adapter = createAdapter(apiKey);
      const positions = await adapter.getPositions();
      return {
        contractVersion: STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION,
        positions,
        capturedAt: Date.now(),
      };
    } catch (error) {
      return {
        contractVersion: STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION,
        positions: [],
        capturedAt: Date.now(),
        error: sanitizeExchangeError(error),
      };
    }
  })();
  const cacheEntry = {
    // 未完成請求永不視為過期；完成後才開始計算 TTL，避免慢速交易所回應造成跨頁重複查詢。
    expiresAt: Number.POSITIVE_INFINITY,
    promise,
  };
  accountPositionCache.set(cacheKey, cacheEntry);
  void promise.then(() => {
    if (accountPositionCache.get(cacheKey) === cacheEntry) {
      cacheEntry.expiresAt = Date.now() + POSITION_CACHE_TTL_MS;
    }
  });
  return promise;
}

export function invalidateAccountPositionSnapshotCache(
  userId?: number,
  apiKeyId?: number,
): void {
  if (userId === undefined && apiKeyId === undefined) {
    accountPositionCache.clear();
    return;
  }
  for (const key of Array.from(accountPositionCache.keys())) {
    const [cachedUserId, cachedApiKeyId] = key.split(":", 3).map(Number);
    if ((userId === undefined || cachedUserId === userId)
      && (apiKeyId === undefined || cachedApiKeyId === apiKeyId)) {
      accountPositionCache.delete(key);
    }
  }
}

function baseSnapshot(local: LocalPositionState): StrategyPositionSnapshot {
  return {
    contractVersion: STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION,
    strategyId: local.strategy.id,
    apiKeyId: local.strategy.apiKeyId,
    exchange: local.strategy.exchange,
    symbol: local.strategy.symbol,
    side: local.side,
    status: "exchange_unavailable",
    source: "local_estimate",
    attribution: "unavailable",
    pnlKind: "unavailable",
    capturedAt: null,
    exchangeUpdatedAt: null,
    stale: true,
    size: local.hasPosition ? local.size : null,
    entryPrice: local.hasPosition ? local.entryPrice : null,
    markPrice: null,
    unrealizedPnl: null,
    unrealizedPnlPct: null,
    leverage: positiveNumber(local.strategy.leverage),
    positionMargin: null,
    accountPositionSize: null,
    accountUnrealizedPnl: null,
    message: "交易所持倉資料不可用",
  };
}

/**
 * 純函式：把帳戶合併持倉安全歸屬到策略卡片。
 * exact 才可使用交易所整筆 upl；共享帳戶／交易對／方向時只做策略毛盈虧估算。
 */
export function buildStrategyPositionSnapshots(
  strategies: Strategy[],
  accountResults: ReadonlyMap<number, AccountPositionResult>,
  now = Date.now(),
): StrategyPositionSnapshot[] {
  const locals = strategies.map(toLocalPositionState);
  const localGroupCounts = new Map<string, number>();
  for (const local of locals) {
    if (local.groupKey) localGroupCounts.set(local.groupKey, (localGroupCounts.get(local.groupKey) ?? 0) + 1);
  }

  return locals.map((local) => {
    const snapshot = baseSnapshot(local);
    const account = accountResults.get(local.strategy.apiKeyId);

    if (!local.hasPosition) {
      return {
        ...snapshot,
        status: "no_local_position",
        source: account && !account.error ? "exchange_position" : "local_estimate",
        capturedAt: account?.capturedAt ?? null,
        stale: !account || now - account.capturedAt > POSITION_STALE_AFTER_MS,
        message: "本策略目前沒有可歸屬的本地持倉",
      };
    }
    if (!account || account.error) {
      return {
        ...snapshot,
        capturedAt: account?.capturedAt ?? null,
        message: account?.error ? `交易所持倉查詢失敗：${account.error}` : "找不到本策略的交易所帳戶憑證",
      };
    }

    const normalizedSymbol = normalizePositionSymbol(local.strategy.symbol);
    const matchingPositions = account.positions.filter((position) =>
      normalizePositionSymbol(position.symbol) === normalizedSymbol && position.side === local.side && position.size > 0,
    );
    if (matchingPositions.length === 0) {
      return {
        ...snapshot,
        status: "no_exchange_position",
        source: "exchange_position",
        capturedAt: account.capturedAt,
        stale: now - account.capturedAt > POSITION_STALE_AFTER_MS,
        message: `交易所同帳戶沒有 ${local.side === "long" ? "多" : "空"}向持倉，已停止顯示估算盈虧`,
      };
    }

    const position = matchingPositions[0];
    const markPrice = positiveNumber(position.markPrice);
    const exchangeSize = positiveNumber(position.size);
    const exchangeEntryPrice = positiveNumber(position.entryPrice);
    const exchangePnl = finiteNumber(position.unrealizedPnl);
    const positionMargin = positiveNumber(position.positionMargin);
    const leverage = positiveNumber(position.leverage) ?? positiveNumber(local.strategy.leverage);
    const groupCount = local.groupKey ? localGroupCounts.get(local.groupKey) ?? 0 : 0;
    const stale = now - account.capturedAt > POSITION_STALE_AFTER_MS;

    if (markPrice === null || exchangeSize === null || exchangeEntryPrice === null) {
      return {
        ...snapshot,
        status: "incomplete_exchange_position",
        source: "exchange_position",
        attribution: "unavailable",
        capturedAt: account.capturedAt,
        exchangeUpdatedAt: position.updatedAt ?? null,
        stale,
        accountPositionSize: exchangeSize,
        accountUnrealizedPnl: exchangePnl,
        message: "交易所持倉欄位不完整，未顯示可能誤導的盈虧",
      };
    }

    const sizeDiffRatio = Math.abs(local.size - exchangeSize) / exchangeSize;
    const entryDiffRatio = Math.abs(local.entryPrice - exchangeEntryPrice) / exchangeEntryPrice;
    // 只有「唯一候選策略」且本地數量／均價與交易所持倉吻合時，才可把整筆 OKX／Bybit UPL
    // 精確歸屬給該策略。任何不吻合都視為帳戶合併／外部變更，避免把帳戶總盈虧冒充策略盈虧。
    const attribution: PositionAttribution = groupCount === 1 && sizeDiffRatio <= 0.01 && entryDiffRatio <= 0.005
      ? "exact"
      : groupCount === 1 && matchingPositions.length === 1
        ? "singleton_exchange"
        : "account_aggregate";

    if (attribution === "exact" || attribution === "singleton_exchange") {
      const nativePnlPct = finiteNumber(position.unrealizedPnlRatioPct);
      const derivedPnlPct = exchangePnl !== null && positionMargin !== null
        ? (exchangePnl / positionMargin) * 100
        : null;
      return {
        ...snapshot,
        status: "available",
        source: "exchange_position",
        attribution,
        pnlKind: "exchange_unrealized",
        capturedAt: account.capturedAt,
        exchangeUpdatedAt: position.updatedAt ?? null,
        stale,
        size: exchangeSize,
        entryPrice: exchangeEntryPrice,
        markPrice,
        unrealizedPnl: exchangePnl,
        unrealizedPnlPct: nativePnlPct ?? derivedPnlPct,
        leverage,
        positionMargin,
        accountPositionSize: exchangeSize,
        accountUnrealizedPnl: exchangePnl,
        message: attribution === "exact"
          ? "交易所持倉快照（精確歸屬）"
          : "交易所唯一同向持倉快照（原生 UPL；本地狀態待對帳）",
      };
    }

    const directionSign = local.side === "long" ? 1 : -1;
    const estimatedPnl = directionSign * (markPrice - local.entryPrice) * local.size;
    const estimatedMargin = leverage && leverage > 0 ? (markPrice * local.size) / leverage : null;
    return {
      ...snapshot,
      status: "available",
      source: "exchange_position",
      attribution,
      pnlKind: "strategy_gross_estimate",
      capturedAt: account.capturedAt,
      exchangeUpdatedAt: position.updatedAt ?? null,
      stale,
      size: local.size,
      entryPrice: local.entryPrice,
      markPrice,
      unrealizedPnl: estimatedPnl,
      unrealizedPnlPct: estimatedMargin && estimatedMargin > 0 ? (estimatedPnl / estimatedMargin) * 100 : null,
      leverage,
      positionMargin: estimatedMargin,
      accountPositionSize: exchangeSize,
      accountUnrealizedPnl: exchangePnl,
      message: groupCount > 1
        ? "同帳戶／交易對／方向由多個策略共享；顯示本策略毛盈虧估算，不重複歸入帳戶總盈虧"
        : "本地策略數量或均價與交易所帳戶持倉不一致；已降級為策略毛盈虧估算，帳戶總盈虧不會被冒充為本策略盈虧",
    };
  });
}

export async function getStrategyPositionSnapshotsForUser(
  userId: number,
  requestedStrategyIds?: readonly number[],
  options: AccountPositionSnapshotOptions = {},
): Promise<StrategyPositionSnapshot[]> {
  const [strategies, apiKeys] = await Promise.all([listStrategies(userId), listApiKeys(userId)]);
  const requestedSet = requestedStrategyIds?.length ? new Set(requestedStrategyIds) : null;
  const requestedStrategies = requestedSet
    ? strategies.filter((strategy) => requestedSet.has(strategy.id))
    : strategies;
  const neededApiKeyIds = new Set(requestedStrategies.map((strategy) => strategy.apiKeyId));
  const apiKeyById = new Map(apiKeys.map((apiKey) => [apiKey.id, apiKey]));
  const accountResults = new Map<number, AccountPositionResult>();

  await Promise.all(Array.from(neededApiKeyIds).map(async (apiKeyId) => {
    const apiKey = apiKeyById.get(apiKeyId);
    if (!apiKey) return;
    accountResults.set(apiKeyId, await getAccountPositionSnapshot(userId, apiKey, options));
  }));

  const allSnapshots = buildStrategyPositionSnapshots(strategies, accountResults);
  return requestedSet
    ? allSnapshots.filter((snapshot) => requestedSet.has(snapshot.strategyId))
    : allSnapshots;
}
