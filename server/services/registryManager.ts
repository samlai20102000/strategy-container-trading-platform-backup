/**
 * 策略註冊中心管理器（V4.2）
 * 統一策略定義查詢介面，讓策略工作室、回測中心、策略管理、參數快照庫共享同一數據源。
 * 包裝現有 strategyStudio.ts（記憶體註冊）+ db.ts（持久化）邏輯。
 */
import * as db from "../db";
import { parameterSnapshots } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import {
  listRegisteredStrategies,
  getStrategy,
  initStrategyStudio,
  type StrategyMeta,
} from "./strategyStudio";
import { attachSnapshotConfig } from "./strategySnapshotConfig";
import {
  assertValidV25Config,
  deriveV25MaxMartinLayer,
  V25_STRATEGY_KEY,
} from "../../shared/strategies/kama3kBreakoutV25";

export interface RegistryDefinition {
  key: string;
  name: string;
  description?: string;
  defaultConfig: Record<string, unknown>;
  schemaConfig?: Record<string, unknown> | null;
  isBuiltIn: boolean;
  isActive: boolean;
  sourceType: "system" | "paste" | "upload";
  version: number;
  loaded: boolean;
  updatedAt: Date | null;
}

export interface RegistryInstance {
  id: number;
  userId: number;
  name: string;
  exchange: string;
  symbol: string;
  strategyKey: string | null;
  strategyName?: string;
  enabled: boolean;
}

/**
 * RegistryManager - 單例模式
 * 合併記憶體中的策略（listRegisteredStrategies）與 DB 中的策略定義（strategyDefinitions）
 * 提供統一的查詢介面供所有模塊使用
 */
export class RegistryManager {
  private static instance: RegistryManager;
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private cacheTTL = 3000; // 3 秒快取

  static getInstance(): RegistryManager {
    if (!RegistryManager.instance) {
      RegistryManager.instance = new RegistryManager();
    }
    return RegistryManager.instance;
  }

  // ============================================================
  // 策略定義操作
  // ============================================================

  /**
   * 獲取所有策略定義（合併記憶體 + DB，供所有模塊使用）
   * 這是核心方法：確保策略工作室、回測中心、策略管理、參數快照庫看到相同的列表
   */
  async getStrategyDefinitions(userId?: number): Promise<RegistryDefinition[]> {
    const cacheKey = `definitions_${userId ?? "all"}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    // 確保策略工作室已初始化
    await initStrategyStudio();

    // 從記憶體獲取已載入的策略
    const registered = listRegisteredStrategies();

    // 從 DB 獲取所有活躍策略定義
    const defs = await db.listAllActiveStrategyDefinitions();

    // 合併：內建來自記憶體，自訂來自 DB（含未載入成功的）
    const builtIns: RegistryDefinition[] = registered
      .filter((s) => s.isBuiltIn)
      .map((b) => {
        // 嘗試從 DB 獲取 schemaConfig
        const dbDef = defs.find((d) => d.key === b.key);
        return {
          key: b.key,
          name: b.name,
          description: "系統內建策略，受保護禁止覆蓋與刪除",
          defaultConfig: b.defaultConfig as Record<string, unknown>,
          schemaConfig: (dbDef?.schemaConfig as Record<string, unknown>) ?? null,
          isBuiltIn: true,
          isActive: true,
          sourceType: "system" as const,
          version: dbDef?.version ?? 1,
          loaded: true,
          updatedAt: dbDef?.updatedAt ?? null,
        };
      });

    const customs: RegistryDefinition[] = defs
      .filter((d) => !d.isBuiltIn)
      .map((d) => ({
        key: d.key,
        name: d.name,
        description: d.description ?? undefined,
        defaultConfig: (d.defaultConfig as Record<string, unknown>) ?? {},
        schemaConfig: (d.schemaConfig as Record<string, unknown>) ?? null,
        isBuiltIn: false,
        isActive: d.isActive,
        sourceType: d.sourceType as "system" | "paste" | "upload",
        version: d.version,
        loaded: registered.some((r) => r.key === d.key),
        updatedAt: d.updatedAt,
      }));

    const result = [...builtIns, ...customs];
    this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  }

  /**
   * 根據 key 獲取單個策略定義
   */
  async getStrategyDefinition(key: string): Promise<RegistryDefinition | null> {
    const cacheKey = `definition_${key}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    await initStrategyStudio();
    const registered = listRegisteredStrategies();
    const memStrategy = registered.find((s) => s.key === key);
    const dbDef = await db.getStrategyDefinitionByKey(key);

    if (!memStrategy && !dbDef) {
      return null;
    }

    const result: RegistryDefinition = {
      key: memStrategy?.key ?? dbDef!.key,
      name: memStrategy?.name ?? dbDef!.name,
      description: dbDef?.description ?? undefined,
      defaultConfig:
        (memStrategy?.defaultConfig as Record<string, unknown>) ??
        (dbDef?.defaultConfig as Record<string, unknown>) ??
        {},
      schemaConfig: (dbDef?.schemaConfig as Record<string, unknown>) ?? null,
      isBuiltIn: memStrategy?.isBuiltIn ?? dbDef?.isBuiltIn ?? false,
      isActive: dbDef?.isActive ?? true,
      sourceType: (memStrategy?.sourceType ?? dbDef?.sourceType ?? "system") as
        | "system"
        | "paste"
        | "upload",
      version: dbDef?.version ?? 1,
      loaded: !!memStrategy,
      updatedAt: dbDef?.updatedAt ?? null,
    };

    this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  }

  /**
   * 獲取策略的參數結構定義（用於前端動態渲染）
   * 優先返回 schemaConfig，若無則返回 defaultConfig 作為結構參考
   */
  async getStrategySchema(
    key: string,
  ): Promise<Record<string, unknown> | null> {
    const definition = await this.getStrategyDefinition(key);
    if (!definition) return null;
    return definition.schemaConfig ?? definition.defaultConfig ?? null;
  }

  /**
   * 獲取策略的預設參數（用於回測中心、策略管理自動填入）
   */
  async getStrategyDefaults(
    key: string,
  ): Promise<Record<string, unknown> | null> {
    const definition = await this.getStrategyDefinition(key);
    if (!definition) return null;
    return definition.defaultConfig;
  }

  // ============================================================
  // 策略實例操作（包裝現有 db.listStrategies）
  // ============================================================

  /**
   * 獲取所有策略實例（含關聯的策略名稱）
   */
  async getInstances(userId: number): Promise<RegistryInstance[]> {
    const cacheKey = `instances_${userId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    const strategies = await db.listStrategies(userId);
    const definitions = await this.getStrategyDefinitions();

    const result: RegistryInstance[] = strategies.map((s: any) => {
      const def = definitions.find((d) => d.key === s.strategyKey);
      return {
        id: s.id,
        userId: s.userId,
        name: s.name,
        exchange: s.exchange,
        symbol: s.symbol,
        strategyKey: s.strategyKey,
        strategyName: def?.name ?? s.strategyKey ?? "未綁定策略",
        enabled: s.enabled,
      };
    });

    this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  }

  /**
   * 套用參數快照到策略實例（驗證定義匹配）
   */
  async applySnapshotToInstance(
    snapshotId: number,
    targetInstanceId: number,
    userId: number,
  ): Promise<{ success: boolean; message: string }> {
    // 1. 獲取快照
    const dbConn = await db.getDb();
    if (!dbConn) throw new Error("資料庫連線不可用");
    const rows = await dbConn
      .select()
      .from(parameterSnapshots)
      .where(and(eq(parameterSnapshots.id, snapshotId), eq(parameterSnapshots.userId, userId)))
      .limit(1);
    const snapshot = rows[0];
    if (!snapshot) {
      throw new Error("快照不存在");
    }

    // 2. 獲取目標實例
    const instance = await db.getStrategyById(targetInstanceId, userId);
    if (!instance) {
      throw new Error("策略實例不存在");
    }

    // 3. 驗證定義匹配
    const snapshotKey = snapshot.strategyKey;
    const instanceKey = instance.strategyKey;
    if (!snapshotKey) {
      throw new Error("快照缺少策略引擎身份，無法安全套用");
    }
    const definition = await this.getStrategyDefinition(snapshotKey);
    if (!definition?.loaded || !definition.isActive) {
      throw new Error(`快照綁定的策略引擎「${snapshotKey}」目前未載入或已停用`);
    }
    if (!instanceKey || snapshotKey !== instanceKey) {
      throw new Error(
        `快照的策略類型 (${snapshotKey}) 與目標實例 (${instanceKey || "未綁定"}) 不匹配，無法套用`,
      );
    }

    // 4. 以通用契約保存原始配置及快照來源；既有版本相容欄位會自動同步。
    const rawConfig = (snapshot.config as Record<string, unknown>) || {};
    let config: Record<string, unknown> = { ...rawConfig };
    let v25Config: ReturnType<typeof assertValidV25Config> | undefined;
    if (snapshotKey === V25_STRATEGY_KEY) {
      try {
        v25Config = assertValidV25Config(rawConfig);
        config = { ...v25Config };
      } catch (error) {
        throw new Error(
          `V2.5 快照參數錯誤：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const firstV25Range = v25Config?.Martin_Ranges[0];
    const prevState =
      instance.martinState && typeof instance.martinState === "object"
        ? (instance.martinState as Record<string, unknown>)
        : { lossCount: 0, currentLot: Number(instance.positionSize), lastEntryPrice: 0 };

    await db.updateStrategy(targetInstanceId, userId, {
      martinState: attachSnapshotConfig(prevState, snapshotKey, config, {
        snapshotId: snapshot.id,
        snapshotName: snapshot.snapshotName,
      }),
      ...(v25Config ? {
        stopLossPct: String(v25Config.Hard_Stop_Loss_Pct),
        takeProfitPct: String(v25Config.Take_Profit_Pct),
        martinMultiplier: String(firstV25Range?.multiplier ?? 1),
        maxMartinLevel: Math.max(1, deriveV25MaxMartinLayer(v25Config.Martin_Ranges)),
        martinSpacingPct: String(firstV25Range?.gap ?? 0),
        kLinePeriod: v25Config.K_Line_Period,
        reentryEnabled: v25Config.Reentry_On_Trend,
      } : {}),
    });

    return { success: true, message: "參數已成功套用到策略實例" };
  }

  // ============================================================
  // 快取管理
  // ============================================================

  clearCache(): void {
    this.cache.clear();
  }
}

export const registryManager = RegistryManager.getInstance();
