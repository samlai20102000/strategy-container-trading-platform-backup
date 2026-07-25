/**
 * Bar-Lock 雙重鎖 - V3.5
 * 依據 Pasted_content_17.txt B.2.3（Redis K3_Locked）實作
 *
 * 適配說明：
 * 部署環境為 serverless（Autoscale），無常駐 Redis。
 * 因此以資料庫原子操作實作等效鎖：
 *   key = `K3_Locked:{instanceId}:{barTimestamp}`
 *   TTL = K_Line_Period × 2 × 60 秒
 * 使用 INSERT 唯一鍵衝突判斷（原子性等效於 Redis SETNX）。
 * 另提供記憶體快取層加速同實例熱路徑。
 */

import { getDb } from "../db";
import { barLocks } from "../../drizzle/schema";
import { and, eq, lt } from "drizzle-orm";

/** 記憶體快取（同一實例熱路徑加速，serverless 冷啟動時自動退化為 DB 查詢） */
const memoryLocks = new Map<string, number>(); // key -> expiresAt (ms)

function lockKey(strategyId: number, barTimestamp: number): string {
  return `K3_Locked:${strategyId}:${barTimestamp}`;
}

export interface ProcessLease {
  lockKey: string;
  ownerToken: number;
}

function processLeaseKey(scope: string, strategyId: number): string {
  return `ProcessLease:${scope}:${strategyId}`;
}

/**
 * 嘗試取得跨實例流程租約。
 *
 * 與 Bar-Lock 共用資料表的唯一鍵原子性，但使用負 strategyId 儲存，避免
 * releaseAllLocks(strategyId) 在策略重置時誤刪仍在執行中的流程租約。
 * DB 不可用或鎖狀態無法確認時採 fail-closed：寧可跳過本輪，也不重複下單。
 */
export async function acquireProcessLease(
  scope: string,
  strategyId: number,
  ttlMs: number,
): Promise<ProcessLease | null> {
  if (!scope || !Number.isInteger(strategyId) || strategyId <= 0 || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    console.error(`[ProcessLease] 無效參數 scope=${scope} strategyId=${strategyId} ttlMs=${ttlMs}`);
    return null;
  }

  const db = await getDb();
  if (!db) {
    console.error(`[ProcessLease] DB 不可用，拒絕放行 ${scope}:${strategyId}`);
    return null;
  }

  const key = processLeaseKey(scope, strategyId);
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const ownerToken = now * 1000 + Math.floor(Math.random() * 1000);
  const row = {
    lockKey: key,
    strategyId: -Math.abs(strategyId),
    barTimestamp: ownerToken,
    expiresAt: new Date(expiresAt),
  };

  const tryInsert = async (): Promise<boolean> => {
    try {
      await db.insert(barLocks).values(row);
      memoryLocks.set(key, expiresAt);
      return true;
    } catch {
      return false;
    }
  };

  try {
    if (await tryInsert()) return { lockKey: key, ownerToken };

    const existing = await db
      .select()
      .from(barLocks)
      .where(eq(barLocks.lockKey, key))
      .limit(1);

    if (existing.length > 0 && existing[0].expiresAt.getTime() > now) {
      memoryLocks.set(key, existing[0].expiresAt.getTime());
      return null;
    }

    // 過期租約只由符合 key + expiresAt 條件的刪除移除；競爭者仍須再通過唯一鍵插入。
    await db
      .delete(barLocks)
      .where(and(eq(barLocks.lockKey, key), lt(barLocks.expiresAt, new Date(now))));

    return (await tryInsert()) ? { lockKey: key, ownerToken } : null;
  } catch (error) {
    console.error(`[ProcessLease] 取得租約失敗 ${key}，採 fail-closed:`, error);
    return null;
  }
}

/** 僅租約擁有者可釋放；過期後若已被新實例接手，舊實例不會刪除新租約。 */
export async function releaseProcessLease(lease: ProcessLease): Promise<void> {
  memoryLocks.delete(lease.lockKey);
  const db = await getDb();
  if (!db) return;

  const current = await db
    .select()
    .from(barLocks)
    .where(eq(barLocks.lockKey, lease.lockKey))
    .limit(1);
  if (current.length === 0 || current[0].barTimestamp !== lease.ownerToken) {
    console.log(`[ProcessLease] 略過非擁有者釋放 ${lease.lockKey}`);
    return;
  }

  await db
    .delete(barLocks)
    .where(
      and(
        eq(barLocks.lockKey, lease.lockKey),
        eq(barLocks.barTimestamp, lease.ownerToken),
      ),
    );
}

/**
 * 嘗試獲取 Bar-Lock（原子操作）
 * @returns true = 獲取成功（首次信號）；false = 鎖已存在（重複信號，應攔截）
 */
export async function acquireBarLock(
  strategyId: number,
  barTimestamp: number,
  kLinePeriodMinutes: number,
): Promise<boolean> {
  const ttlMs = kLinePeriodMinutes * 2 * 60 * 1000;
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const key = lockKey(strategyId, barTimestamp);

  // 1. 記憶體快取快速檢查（但需與 DB 交叉驗證，因為 releaseBarLock 可能已刪除 DB 記錄）
  const cached = memoryLocks.get(key);
  if (cached && cached > now) {
    // 記憶體認為鎖存在，但去 DB 確認一下（可能已被釋放）
    const db = await getDb();
    if (db) {
      const existing = await db
        .select()
        .from(barLocks)
        .where(eq(barLocks.lockKey, key))
        .limit(1);
      if (existing.length === 0) {
        // DB 中已被釋放，清除記憶體快取並允許通過
        memoryLocks.delete(key);
        // 繼續往下執行 DB 插入流程
      } else {
        return false; // DB 中確實存在，放截
      }
    } else {
      return false;
    }
  }

  // 2. DB 原子插入（唯一鍵 = lockKey）
  const db = await getDb();
  if (!db) {
    // DB 不可用時退化為記憶體鎖（盡力而為）
    if (cached && cached > now) return false;
    memoryLocks.set(key, expiresAt);
    return true;
  }

  try {
    await db.insert(barLocks).values({
      lockKey: key,
      strategyId,
      barTimestamp,
      expiresAt: new Date(expiresAt),
    });
    memoryLocks.set(key, expiresAt);
    return true;
  } catch (err: unknown) {
    // 唯一鍵衝突 → 鎖已存在；檢查是否過期
    const existing = await db
      .select()
      .from(barLocks)
      .where(eq(barLocks.lockKey, key))
      .limit(1);

    if (existing.length > 0) {
      const exp = existing[0].expiresAt.getTime();
      if (exp > now) {
        memoryLocks.set(key, exp);
        return false; // 有效鎖存在，攔截
      }
      // 鎖已過期 → 更新為新 TTL 並允許執行
      await db
        .update(barLocks)
        .set({ expiresAt: new Date(expiresAt) })
        .where(eq(barLocks.lockKey, key));
      memoryLocks.set(key, expiresAt);
      return true;
    }
    // 其他錯誤（表不存在等）→ 保守放行並記錄
    console.error("[BarLock] 獲取鎖時發生非預期錯誤:", err);
    return true;
  }
}

/**
 * 檢查 Bar-Lock 是否存在（只查詢不鎖定）
 * @returns true = 鎖已存在（應攔截）；false = 無鎖（可繼續）
 */
export async function checkBarLock(
  strategyId: number,
  barTimestamp: number,
): Promise<boolean> {
  const key = lockKey(strategyId, barTimestamp);
  const now = Date.now();

  // 1. 記憶體快取快速檢查
  const cached = memoryLocks.get(key);
  if (cached && cached > now) {
    // 記憶體認為鎖存在，去 DB 確認
    const db = await getDb();
    if (db) {
      const existing = await db
        .select()
        .from(barLocks)
        .where(eq(barLocks.lockKey, key))
        .limit(1);
      if (existing.length === 0) {
        memoryLocks.delete(key);
        return false; // DB 中已被釋放
      }
      if (existing[0].expiresAt.getTime() <= now) {
        memoryLocks.delete(key);
        return false; // 已過期
      }
      return true; // 確實存在有效鎖
    }
    return true; // DB 不可用，保守認為鎖存在
  }

  // 2. 記憶體無快取，查 DB
  const db = await getDb();
  if (!db) return false; // DB 不可用，放行
  const existing = await db
    .select()
    .from(barLocks)
    .where(eq(barLocks.lockKey, key))
    .limit(1);
  if (existing.length === 0) return false;
  if (existing[0].expiresAt.getTime() <= now) return false; // 已過期
  // 更新記憶體快取
  memoryLocks.set(key, existing[0].expiresAt.getTime());
  return true;
}

/**
 * 釋放指定策略的某一根 K 線鎖（下單失敗時調用，允許下次重試）
 */
export async function releaseBarLock(
  strategyId: number,
  barTimestamp: number,
): Promise<void> {
  const key = lockKey(strategyId, barTimestamp);
  memoryLocks.delete(key);
  const db = await getDb();
  if (db) {
    await db.delete(barLocks).where(eq(barLocks.lockKey, key));
  }
  console.log(`[BarLock] 釋放鎖 ${key}（下單失敗，允許重試）`);
}

/**
 * 釋放指定策略的所有鎖（策略重置/刪除時調用）
 */
export async function releaseAllLocks(strategyId: number): Promise<void> {
  for (const key of Array.from(memoryLocks.keys())) {
    if (key.startsWith(`K3_Locked:${strategyId}:`)) {
      memoryLocks.delete(key);
    }
  }
  const db = await getDb();
  if (db) {
    await db.delete(barLocks).where(eq(barLocks.strategyId, strategyId));
  }
}

/**
 * 清理過期鎖（由監控循環或 webhook 順帶調用）
 */
export async function cleanupExpiredLocks(): Promise<number> {
  const now = Date.now();
  for (const [key, exp] of Array.from(memoryLocks.entries())) {
    if (exp <= now) memoryLocks.delete(key);
  }
  const db = await getDb();
  if (!db) return 0;
  const result = await db.delete(barLocks).where(lt(barLocks.expiresAt, new Date(now)));
  return (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
}

/** 測試輔助：清空記憶體鎖 */
export function __clearMemoryLocks(): void {
  memoryLocks.clear();
}
