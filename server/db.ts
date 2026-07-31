import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  apiKeys,
  favoriteSymbols,
  heartbeatLogs,
  InsertApiKey,
  InsertHeartbeatLog,
  InsertRiskEvent,
  InsertSignal,
  InsertStrategy,
  InsertStrategyDefinition,
  InsertTrade,
  InsertUser,
  riskEvents,
  signals,
  strategies,
  strategyDefinitions,
  trades,
  users,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/* ==================== API 金鑰 ==================== */

export async function listApiKeys(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function getApiKeyById(id: number, userId?: number) {
  const db = await getDb();
  if (!db) return undefined;
  const conditions = userId
    ? and(eq(apiKeys.id, id), eq(apiKeys.userId, userId))
    : eq(apiKeys.id, id);
  const result = await db.select().from(apiKeys).where(conditions).limit(1);
  return result[0];
}

export async function createApiKey(data: InsertApiKey) {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  const result = await db.insert(apiKeys).values(data);
  return result;
}

export async function updateApiKey(
  id: number,
  userId: number,
  data: Partial<InsertApiKey>,
) {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db
    .update(apiKeys)
    .set(data)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)));
}

export async function deleteApiKey(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)));
}

/* ==================== 策略 ==================== */

export async function listStrategies(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(strategies)
    .where(eq(strategies.userId, userId))
    .orderBy(desc(strategies.createdAt));
}

export async function listEnabledStrategies() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(strategies).where(eq(strategies.enabled, true));
}

/** 軟隔離用：查詢同一 API Key + 同一幣對的所有策略（用於 reconcile 對賬） */
export async function getStrategiesByApiKeyAndSymbol(apiKeyId: number, symbol: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(strategies)
    .where(and(eq(strategies.apiKeyId, apiKeyId), eq(strategies.symbol, symbol)));
}

export async function getStrategyById(id: number, userId?: number) {
  const db = await getDb();
  if (!db) return undefined;
  const conditions = userId
    ? and(eq(strategies.id, id), eq(strategies.userId, userId))
    : eq(strategies.id, id);
  const result = await db.select().from(strategies).where(conditions).limit(1);
  return result[0];
}

export async function createStrategy(data: InsertStrategy) {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db.insert(strategies).values(data);
}

export async function updateStrategy(
  id: number,
  userId: number,
  data: Partial<InsertStrategy>,
) {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db
    .update(strategies)
    .set(data)
    .where(and(eq(strategies.id, id), eq(strategies.userId, userId)));
}

/** 系統層級停用策略（風險觸發，無 userId 限制） */
export async function transitionStrategyToDisabled(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  id: number,
  reason: string,
): Promise<boolean> {
  const result = await db
    .update(strategies)
    .set({ enabled: false, disabledReason: reason })
    .where(and(eq(strategies.id, id), eq(strategies.enabled, true)));

  const rawResult = result as unknown as
    | { affectedRows?: number; rowsAffected?: number }
    | [{ affectedRows?: number; rowsAffected?: number }, ...unknown[]];
  const header = Array.isArray(rawResult) ? rawResult[0] : rawResult;
  const affectedRows = header?.affectedRows ?? header?.rowsAffected ?? 0;
  return affectedRows > 0;
}

/** 系統層級停用策略（風險觸發，無 userId 限制） */
export async function disableStrategySystem(id: number, reason: string): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  const disabledNow = await transitionStrategyToDisabled(db, id, reason);

  if (!disabledNow) {
    console.log(`[disableStrategySystem] 策略 #${id} 已停用或不存在，略過重複通知`);
    return false;
  }

  // 策略被系統自動停用時通知擁有者（告警連線，失敗不影響主流程）
  try {
    const { notifyOwner } = await import("./services/notifier");
    await notifyOwner(
      `⚠️ 策略 #${id} 已被系統自動暫停`,
      `原因：${reason}\n請登入平台檢查後手動恢復運行。`,
    );
  } catch (e) {
    console.warn("[disableStrategySystem] 通知發送失敗:", (e as Error)?.message);
  }
  return true;
}

export async function deleteStrategy(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db
    .delete(strategies)
    .where(and(eq(strategies.id, id), eq(strategies.userId, userId)));
}

/* ==================== 訊號日誌 ==================== */

export async function createSignal(data: InsertSignal): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  const result = await db.insert(signals).values(data);
  return (result as any)[0].insertId as number;
}

export async function updateSignal(id: number, data: Partial<InsertSignal>) {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db.update(signals).set(data).where(eq(signals.id, id));
}

export async function listSignals(
  userId: number,
  opts: { strategyId?: number; status?: string; source?: string; limit?: number; offset?: number; startTime?: Date; endTime?: Date } = {},
) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const conditions = [eq(signals.userId, userId)];
  if (opts.strategyId) conditions.push(eq(signals.strategyId, opts.strategyId));
  if (opts.status) conditions.push(eq(signals.status, opts.status as any));
  if (opts.source) conditions.push(eq(signals.source, opts.source as any));
  if (opts.startTime) conditions.push(gte(signals.createdAt, opts.startTime));
  if (opts.endTime) conditions.push(lte(signals.createdAt, opts.endTime));
  const where = and(...conditions);

  const items = await db
    .select({
      id: signals.id,
      strategyId: signals.strategyId,
      userId: signals.userId,
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
      realizedPnl: trades.realizedPnl,
    })
    .from(signals)
    .leftJoin(trades, or(
      eq(signals.id, trades.signalId),
      and(
        eq(signals.orderId, trades.orderId),
        sql`${trades.orderId} IS NOT NULL`,
        sql`${trades.signalId} IS NULL`
      )
    ))
    .where(where)
    .orderBy(desc(signals.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(signals)
    .where(where);

  return { items, total: Number(countResult[0]?.count ?? 0) };
}

export async function listSignalsByIds(userId: number, ids: number[]) {
  const db = await getDb();
  const uniqueIds = Array.from(new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0)));
  if (!db || uniqueIds.length === 0) return [];
  return db.select({
    id: signals.id,
    userId: signals.userId,
    rawPayload: signals.rawPayload,
    executionMode: signals.executionMode,
    cycleId: signals.cycleId,
    legId: signals.legId,
    reasonCode: signals.reasonCode,
  })
    .from(signals)
    .where(and(eq(signals.userId, userId), inArray(signals.id, uniqueIds)));
}

/* ==================== 交易記錄 ==================== */

export async function createTrade(data: InsertTrade): Promise<number> {
  // 動態 import 避免 db.ts ↔ ledger 初始化循環；所有舊策略成交統一取得冪等、cycle 與馬丁逐層稽核。
  const { recordExistingTradeExecution } = await import("./services/tradeExecutionLedger");
  return recordExistingTradeExecution(data);
}

export async function updateTrade(id: number, data: Partial<InsertTrade>) {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db.update(trades).set(data).where(eq(trades.id, id));
}

function affectedRows(result: unknown): number {
  const raw = result as
    | { affectedRows?: number; rowsAffected?: number }
    | [{ affectedRows?: number; rowsAffected?: number }, ...unknown[]];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.affectedRows ?? header?.rowsAffected ?? 0;
}

/**
 * 取得可安全重試的待對帳平倉成交。
 * lastReconciledAt 同時作為跨實例租約時間戳，避免 Autoscale 重複處理同一筆資料。
 */
export async function listPendingTradeReconciliations(options: {
  limit?: number;
  minimumAgeMs?: number;
  leaseMs?: number;
  now?: Date;
} = {}) {
  const db = await getDb();
  if (!db) return [];
  const now = options.now ?? new Date();
  const minimumAgeMs = options.minimumAgeMs ?? 20_000;
  const leaseMs = options.leaseMs ?? 55_000;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const createdBefore = new Date(now.getTime() - minimumAgeMs);
  const leaseBefore = new Date(now.getTime() - leaseMs);

  return db
    .select()
    .from(trades)
    .where(and(
      eq(trades.reduceOnly, true),
      eq(trades.reconciliationStatus, "pending"),
      isNotNull(trades.orderId),
      lte(trades.createdAt, createdBefore),
      or(isNull(trades.lastReconciledAt), lte(trades.lastReconciledAt, leaseBefore)),
    ))
    .orderBy(asc(trades.createdAt), asc(trades.id))
    .limit(limit);
}

/** 原子取得單筆對帳租約並增加嘗試次數。 */
export async function claimTradeReconciliation(
  tradeId: number,
  leaseBefore: Date,
  claimedAt = new Date(),
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  const result = await db
    .update(trades)
    .set({
      lastReconciledAt: claimedAt,
      reconciliationAttempts: sql`${trades.reconciliationAttempts} + 1`,
      reconciliationError: null,
    })
    .where(and(
      eq(trades.id, tradeId),
      eq(trades.reconciliationStatus, "pending"),
      or(isNull(trades.lastReconciledAt), lte(trades.lastReconciledAt, leaseBefore)),
    ));
  return affectedRows(result) > 0;
}

/** 以交易所權威結果完成對帳，並同步更新訊號日誌的人類可讀訊息。 */
export async function completeTradeReconciliation(input: {
  tradeId: number;
  signalId: number | null;
  values: Partial<InsertTrade>;
  message: string;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db.transaction(async tx => {
    const result = await tx
      .update(trades)
      .set({
        ...input.values,
        reconciliationStatus: "confirmed",
        reconciliationError: null,
        lastReconciledAt: new Date(),
      })
      .where(and(
        eq(trades.id, input.tradeId),
        eq(trades.reconciliationStatus, "pending"),
      ));
    const changed = affectedRows(result) > 0;
    if (changed && input.signalId) {
      await tx.update(signals).set({ message: input.message }).where(eq(signals.id, input.signalId));
    }
    return changed;
  });
}

/** 保留待對帳狀態，或在多次無權威結果後轉為明確未解。 */
export async function markTradeReconciliationIncomplete(input: {
  tradeId: number;
  error: string;
  terminal: boolean;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  await db
    .update(trades)
    .set({
      reconciliationStatus: input.terminal ? "unresolved" : "pending",
      dataQuality: input.terminal ? "legacy_unresolved" : "pending_reconciliation",
      pnlSource: input.terminal ? "unavailable" : "unknown",
      reconciliationError: input.error.slice(0, 2_000),
      lastReconciledAt: new Date(),
    })
    .where(and(
      eq(trades.id, input.tradeId),
      eq(trades.reconciliationStatus, "pending"),
    ));
}

export async function listTrades(
  userId: number,
  opts: {
    strategyId?: number;
    startTime?: Date;
    endTime?: Date;
    limit?: number;
  } = {},
) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(trades.userId, userId)];
  if (opts.strategyId) conditions.push(eq(trades.strategyId, opts.strategyId));
  if (opts.startTime) conditions.push(gte(trades.createdAt, opts.startTime));
  if (opts.endTime) conditions.push(lte(trades.createdAt, opts.endTime));
  return db
    .select()
    .from(trades)
    .where(and(...conditions))
    .orderBy(desc(trades.createdAt))
    .limit(opts.limit ?? 200);
}

/** 計算策略今日已實現盈虧（用於每日虧損上限檢查） */
export async function getTodayRealizedPnl(strategyId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const result = await db
    .select({ total: sql<string>`COALESCE(SUM(realizedPnl), 0)` })
    .from(trades)
    .where(
      and(eq(trades.strategyId, strategyId), gte(trades.createdAt, todayStart)),
    );
  return parseFloat(result[0]?.total ?? "0");
}

/* ==================== 風險事件 ==================== */

export async function createRiskEvent(data: InsertRiskEvent) {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db.insert(riskEvents).values(data);
}

export async function listRiskEvents(userId: number, limit = 50, offset = 0) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(riskEvents)
    .where(eq(riskEvents.userId, userId))
    .orderBy(desc(riskEvents.createdAt))
    .limit(limit)
    .offset(offset);
}

/* ==================== 策略定義（策略工作室） ==================== */

/** 取得所有啟用中的策略定義（冷啟動重載用，跨用戶） */
export async function listAllActiveStrategyDefinitions() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(strategyDefinitions)
    .where(eq(strategyDefinitions.isActive, true))
    .orderBy(desc(strategyDefinitions.updatedAt));
}

/** 取得某用戶的策略定義列表 */
export async function listStrategyDefinitions(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(strategyDefinitions)
    .where(
      and(
        eq(strategyDefinitions.userId, userId),
        eq(strategyDefinitions.isActive, true),
      ),
    )
    .orderBy(desc(strategyDefinitions.updatedAt));
}

/** 依 key 取得策略定義（任一用戶，key 全域唯一） */
export async function getStrategyDefinitionByKey(key: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(strategyDefinitions)
    .where(
      and(eq(strategyDefinitions.key, key), eq(strategyDefinitions.isActive, true)),
    )
    .limit(1);
  return rows[0];
}

/** 建立或更新策略定義（同 key 同用戶則版本 +1 並更新代碼） */
export async function upsertStrategyDefinition(def: InsertStrategyDefinition) {
  const db = await getDb();
  if (!db) throw new Error("資料庫連線不可用");
  const existing = await db
    .select()
    .from(strategyDefinitions)
    .where(
      and(
        eq(strategyDefinitions.key, def.key),
        eq(strategyDefinitions.userId, def.userId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    if (row.isBuiltIn) throw new Error("內建策略禁止覆蓋");
    await db
      .update(strategyDefinitions)
      .set({
        name: def.name,
        description: def.description ?? row.description,
        sourceCode: def.sourceCode,
        defaultConfig: def.defaultConfig,
        ...(def.schemaConfig ? { schemaConfig: def.schemaConfig } : {}),
        sourceType: def.sourceType,
        filePath: def.filePath ?? row.filePath,
        capabilityManifest: def.capabilityManifest ?? null,
        modeContractVersion: def.modeContractVersion ?? "strategy-mode-capabilities-v1",
        isActive: true,
        version: row.version + 1,
      })
      .where(eq(strategyDefinitions.id, row.id));
    return { id: row.id, version: row.version + 1, updated: true };
  }

  const result = await db.insert(strategyDefinitions).values(def);
  const insertId = (result as unknown as [{ insertId: number }])[0]?.insertId;
  return { id: insertId, version: 1, updated: false };
}

/** 停用（軟刪除）策略定義；內建策略禁止刪除 */
export async function deleteStrategyDefinition(userId: number, key: string) {
  const db = await getDb();
  if (!db) throw new Error("資料庫連線不可用");
  const rows = await db
    .select()
    .from(strategyDefinitions)
    .where(
      and(
        eq(strategyDefinitions.key, key),
        eq(strategyDefinitions.userId, userId),
      ),
    )
    .limit(1);
  if (rows.length === 0) throw new Error("找不到該策略定義");
  if (rows[0].isBuiltIn) throw new Error("內建策略禁止刪除");
  await db
    .update(strategyDefinitions)
    .set({ isActive: false })
    .where(eq(strategyDefinitions.id, rows[0].id));
  return { success: true };
}

/** 更新策略的馬丁狀態 */
export async function updateStrategyMartinState(
  strategyId: number,
  martinState: { lossCount: number; currentLot: number; lastEntryPrice: number },
) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(strategies)
    .set({ martinState })
    .where(eq(strategies.id, strategyId));
}

/* ============ 收藏交易對（第二輪優化） ============ */

/** 列出用戶在指定交易所收藏的交易對（按收藏時間倒序） */
export async function listFavoriteSymbols(userId: number, exchange: "bybit" | "okx") {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(favoriteSymbols)
    .where(and(eq(favoriteSymbols.userId, userId), eq(favoriteSymbols.exchange, exchange)))
    .orderBy(desc(favoriteSymbols.createdAt));
}

/** 切換收藏：已收藏則取消，未收藏則加入；回傳最新收藏狀態 */
export async function toggleFavoriteSymbol(
  userId: number,
  exchange: "bybit" | "okx",
  symbol: string,
): Promise<{ favorited: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("資料庫連線不可用");
  const favKey = `${userId}:${exchange}:${symbol}`;
  const existing = await db
    .select({ id: favoriteSymbols.id })
    .from(favoriteSymbols)
    .where(eq(favoriteSymbols.favKey, favKey))
    .limit(1);
  if (existing.length > 0) {
    await db.delete(favoriteSymbols).where(eq(favoriteSymbols.favKey, favKey));
    return { favorited: false };
  }
  await db.insert(favoriteSymbols).values({ userId, exchange, symbol, favKey });
  return { favorited: true };
}


/* ==================== Heartbeat 輪詢日誌 ==================== */


export async function createHeartbeatLog(data: InsertHeartbeatLog): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  const result = await db.insert(heartbeatLogs).values(data);
  return (result as any)[0].insertId as number;
}

export async function listHeartbeatLogs(
  strategyId: number,
  opts: { limit?: number; offset?: number; excludeHold?: boolean } = {},
) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const conditions = [eq(heartbeatLogs.strategyId, strategyId)];
  if (opts.excludeHold) {
    conditions.push(sql`${heartbeatLogs.result} != 'hold'`);
  }
  const where = and(...conditions);
  const items = await db
    .select()
    .from(heartbeatLogs)
    .where(where)
    .orderBy(desc(heartbeatLogs.createdAt))
    .limit(opts.limit ?? 10)
    .offset(opts.offset ?? 0);
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatLogs)
    .where(where);
  return { items, total: Number(countResult[0]?.count ?? 0) };
}
