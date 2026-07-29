/**
 * 回測 API 路由（V4.1 升級版）
 * 功能：
 * 1. 異步回測任務（含可配置超時 + 取消）
 * 2. 參數快照庫 CRUD（saveSnapshot / getSnapshots / deleteSnapshot / applySnapshot）
 * 3. 異步參數掃描（submitScan / getScanStatus）
 * 4. 歷史記錄 + 優化 + 多品種
 */

import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { listRegisteredStrategies } from "../services/strategyStudio";
import { backtestJobManager } from "../services/backtest/backtestJobManager";
import { getBacktestDatabase } from "../services/backtest/backtestDatabase";
import { getSupportedTimeframes, isValidTimeframe, convertToOKXFormat } from "../services/backtest/timeframeParser";
import { runOptimization } from "../services/backtest/optimizer";
import { runMultiSymbolBacktest } from "../services/backtest/multiSymbolEngine";
import { scanJobManager } from "../services/backtest/scanEngine";
import type { BacktestRequest } from "../services/backtest/backtestEngine";
import { validateAndProcessMartinConfig } from "../services/parameterValidator";
import { validateRiskSettings, buildEnvironmentSnapshot, ENGINE_VERSION } from "../services/riskSettingsValidator";
import { getDb } from "../db";
import { parameterSnapshots, strategies } from "../../drizzle/schema";
import { eq, desc, and } from "drizzle-orm";
import { attachSnapshotConfig } from "../services/strategySnapshotConfig";
import {
  deploymentPositionColumns,
  finalizeDeploymentPosition,
} from "../services/deploymentPosition";
import {
  assertValidV25Config,
  deriveV25MaxMartinLayer,
  V25_STRATEGY_KEY,
} from "../../shared/strategies/kama3kBreakoutV25";
import {
  assertValidRainbow20415Config,
  deriveRainbow20415FinalEnabledLayer,
  RAINBOW_20415_STRATEGY_KEY,
} from "../../shared/strategies/rainbow20415";
import {
  assertValidRainbowTrendLadderConfig,
  RAINBOW_TREND_LADDER_STRATEGY_KEY,
} from "../../shared/strategies/rainbowTrendLadder";

function assertRegisteredStrategy(strategyKey: string): void {
  const isRegistered = listRegisteredStrategies().some((strategy) => strategy.key === strategyKey);
  if (!isRegistered) {
    throw new Error(
      `快照綁定的策略引擎「${strategyKey}」目前未註冊，為避免使用錯誤引擎，已停止建立。請先在策略工作室註冊此引擎。`,
    );
  }
}

function normalizeSnapshotConfigForStrategy(
  strategyKey: string,
  rawConfig: Record<string, unknown>,
): Record<string, unknown> {
  try {
    if (strategyKey === V25_STRATEGY_KEY) return { ...assertValidV25Config(rawConfig) };
    if (strategyKey === RAINBOW_20415_STRATEGY_KEY) {
      return { ...assertValidRainbow20415Config(rawConfig) };
    }
    if (strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY) {
      return { ...assertValidRainbowTrendLadderConfig(rawConfig) };
    }
    return { ...rawConfig };
  } catch (error) {
    const label = strategyKey === RAINBOW_20415_STRATEGY_KEY
      ? "20415 七彩虹"
      : strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY
        ? "七彩虹線趨勢跟蹤階梯馬丁"
        : "V2.5";
    throw new Error(
      `${label}快照參數錯誤：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function timeframeForMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveKLineMinutes(config: Record<string, unknown>, timeframe: unknown): number {
  const configured = finiteNumber(config.K_Line_Period, 0);
  if (configured > 0) return Math.max(1, Math.round(configured));
  if (typeof timeframe !== "string") return 15;

  const match = timeframe.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) return 15;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return amount * (unit === "d" ? 1440 : unit === "h" ? 60 : 1);
}

export const backtestRequestSchema = z.object({
  strategyKey: z.string().min(1),
  symbol: z.string().min(1),
  timeframe: z.string().min(2),
  startDate: z.number().positive(),
  endDate: z.number().positive(),
  initialCapital: z.number().positive().default(10000),
  config: z.record(z.string(), z.unknown()).default({}),
  commission: z.number().min(0).max(0.01).optional(),
  slippage: z.number().min(0).max(0.01).optional(),
  exchange: z.enum(["okx", "bybit"]).default("okx"),
  endPositionPolicy: z.enum(["mark_to_market", "force_close"])
    .default("mark_to_market"),
});

export const backtestSettingsSchema = z.object({
  exchange: z.string(),
  symbol: z.string(),
  timeframe: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  initialCapital: z.number(),
  tradeAmount: z.number().optional(),
  endPositionPolicy: z.enum(["mark_to_market", "force_close"])
    .default("mark_to_market"),
  configJson: z.record(z.string(), z.unknown()).optional(),
  baseLotSize: z.number().optional(),
  baseLotSizeMode: z.string().optional(),
});

function validateRequest(input: z.infer<typeof backtestRequestSchema>): BacktestRequest {
  if (!isValidTimeframe(input.timeframe)) {
    throw new Error(`無效的時間框架：${input.timeframe}（正確格式如 15m、1h、4h、1d）`);
  }
  if (input.exchange === "okx") {
    try {
      convertToOKXFormat(input.timeframe);
    } catch (e: any) {
      throw new Error(`OKX 不支援此時間框架：${input.timeframe}。請選擇 1m/3m/5m/15m/30m/1h/2h/4h/6h/12h/1d`);
    }
  }
  const startMs = input.startDate < 1e12 ? input.startDate * 1000 : input.startDate;
  const endMs = input.endDate < 1e12 ? input.endDate * 1000 : input.endDate;
  if (endMs <= startMs) throw new Error("結束時間必須晚於開始時間");
  const spanDays = (endMs - startMs) / 86400000;
  if (spanDays > 1830) throw new Error("回測區間最長支持 5 年，請縮短日期範圍");
  if (input.config && typeof input.config === "object") {
    if (input.strategyKey === RAINBOW_20415_STRATEGY_KEY) {
      const config = assertValidRainbow20415Config(input.config);
      input.config = { ...config };
    } else if (input.strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY) {
      const config = assertValidRainbowTrendLadderConfig(input.config);
      input.config = { ...config };
    } else if (input.strategyKey === V25_STRATEGY_KEY) {
      const config = assertValidV25Config(input.config);
      input.config = { ...config };
    } else {
      // 舊通用策略：保留歷史 max_layers → Max_Layers 相容橋接。
      if (input.config.max_layers && !input.config.Max_Layers) {
        input.config = { ...input.config, Max_Layers: input.config.max_layers };
      }
      // V6.1 小寫 key → 大寫 key 橋接（確保回測引擎統一使用大寫馬丁參數）
      if (input.config.martin_step_pct && !input.config.Martin_Step_Pct) {
        input.config = { ...input.config, Martin_Step_Pct: input.config.martin_step_pct };
      }
      if (input.config.martin_multiplier && !input.config.Martin_Multiplier) {
        input.config = { ...input.config, Martin_Multiplier: input.config.martin_multiplier };
      }
      // V6.1 max_deviation_pct → Max_Deviation_Pct 橋接
      if (input.config.max_deviation_pct != null && !input.config.Max_Deviation_Pct) {
        input.config = { ...input.config, Max_Deviation_Pct: input.config.max_deviation_pct };
      }
      // 舊的 Martin_Layers → Max_Layers 同步（向後相容）
      const processed = validateAndProcessMartinConfig(input.config);
      if (processed.usedMode === "layered") {
        input.config = { ...input.config, Max_Layers: processed.maxLayers };
      }
    }
  }
  return input;
}

export const backtestRouter = router({
  // ==================== 策略與時間框架 ====================

  /** 策略清單（內建 + 自訂，含 defaultConfig 供表單動態生成） */
  getStrategies: protectedProcedure.query(() => {
    return listRegisteredStrategies().map((s) => ({
      key: s.key,
      name: s.name,
      defaultConfig: s.defaultConfig,
    }));
  }),

  /** 支援的時間框架清單 */
  getTimeframes: protectedProcedure.query(() => getSupportedTimeframes()),

  // ==================== 回測任務（V5.0 持久化 + 並行佇列） ====================

  /** 提交回測任務（立即回傳 jobId，後端異步執行，支援離開頁面） */
  run: protectedProcedure
    .input(backtestRequestSchema.extend({
      timeout: z.number().min(10).max(3600).optional(),
      strategyName: z.string().optional(),
      tradeAmount: z.number().positive().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");
      const { timeout, strategyName, tradeAmount, ...rest } = input;
      const request = validateRequest(rest);
      const jobId = await backtestJobManager.submit(request, userId, {
        timeoutSeconds: timeout,
        strategyName,
        tradeAmount,
      });
      return { jobId };
    }),

  /** 取消回測任務 */
  cancel: protectedProcedure
    .input(z.object({ jobId: z.string() }))
    .mutation(async ({ input }) => {
      const success = await backtestJobManager.cancel(input.jobId);
      if (!success) throw new Error("任務不存在或已完成，無法取消");
      return { success: true, message: "任務已取消" };
    }),

  /** 輪詢任務進度（記憶體優先，fallback DB） */
  getProgress: protectedProcedure
    .input(z.object({ jobId: z.string() }))
    .query(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");
      // 先從記憶體查（即時性最高）
      const memProgress = backtestJobManager.getProgress(input.jobId);
      if (memProgress) return memProgress;
      // Fallback: 從 DB 查（離開頁面後回來的場景）
      const dbJob = await backtestJobManager.getJobResultFromDB(input.jobId, userId);
      if (!dbJob) throw new Error("任務不存在或已過期");
      return {
        jobId: dbJob.jobId,
        status: dbJob.status,
        progress: dbJob.progress,
        message: dbJob.message || "",
        createdAt: new Date(dbJob.createdAt).getTime(),
        startedAt: dbJob.startedAt ? new Date(dbJob.startedAt).getTime() : undefined,
        finishedAt: dbJob.completedAt ? new Date(dbJob.completedAt).getTime() : undefined,
        error: dbJob.error || undefined,
        userId: dbJob.userId,
        timeoutSeconds: 0,
        strategyName: dbJob.strategyName,
      };
    }),

  /** 取得完成任務的完整結果（記憶體優先，fallback DB） */
  getResult: protectedProcedure
    .input(z.object({ jobId: z.string() }))
    .query(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");
      // 先從記憶體查
      const memResult = backtestJobManager.getResult(input.jobId);
      if (memResult) return memResult;
      // Fallback: 從 DB 查
      const dbJob = await backtestJobManager.getJobResultFromDB(input.jobId, userId);
      if (!dbJob || dbJob.status !== "completed") throw new Error("結果不存在（任務未完成或已過期）");
      return {
        runId: dbJob.jobId,
        strategyKey: dbJob.strategyKey,
        strategyName: dbJob.strategyName ?? dbJob.strategyKey,
        metrics: dbJob.metrics as any,
        trades: dbJob.tradesData as any[] || [],
        equityCurve: dbJob.equityCurve as any[] || [],
        config: dbJob.config as Record<string, unknown>,
        summary: dbJob.summary || "",
        candleCount: dbJob.candleCount ?? 0,
        endPositionPolicy: dbJob.endPositionPolicy,
        accounting: dbJob.accounting ?? undefined,
        dataQuality: dbJob.dataQuality ?? undefined,
        engineSemantics: dbJob.engineSemantics ?? undefined,
        environment: dbJob.environment ?? undefined,
      };
    }),

  /** 佇列狀態統計 */
  getQueueStatus: protectedProcedure.query(() => {
    return backtestJobManager.getQueueStatus();
  }),

  // ==================== 歷史記錄（主資料庫持久化） ====================

  /** 歷史回測記錄清單（從主 DB 讀取，永久保留） */
  listRuns: protectedProcedure
    .input(z.object({
      limit: z.number().min(1).max(200).default(20),
      offset: z.number().min(0).default(0),
    }).optional())
    .query(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");
      return backtestJobManager.listJobsFromDB(userId, {
        limit: input?.limit ?? 20,
        offset: input?.offset ?? 0,
      });
    }),

  /** 讀取歷史回測完整結果（從主 DB） */
  getRun: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");
      const dbJob = await backtestJobManager.getJobResultFromDB(input.runId, userId);
      if (!dbJob) throw new Error("回測記錄不存在");
      return {
        run: {
          runId: dbJob.jobId,
          strategyKey: dbJob.strategyKey,
          strategyName: dbJob.strategyName,
          symbol: dbJob.symbol,
          timeframe: dbJob.timeframe,
          exchange: dbJob.exchange,
          startDate: dbJob.startDate,
          endDate: dbJob.endDate,
          initialCapital: parseFloat(dbJob.initialCapital),
          config: dbJob.config as Record<string, unknown>,
          endPositionPolicy: dbJob.endPositionPolicy,
          candleCount: dbJob.candleCount,
          createdAt: new Date(dbJob.createdAt).getTime(),
        },
        metrics: dbJob.metrics ?? null,
        equityCurve: dbJob.equityCurve ?? null,
        trades: dbJob.tradesData ?? [],
        summary: dbJob.summary ?? "",
        accounting: dbJob.accounting ?? null,
        dataQuality: dbJob.dataQuality ?? null,
        engineSemantics: dbJob.engineSemantics ?? null,
        environment: dbJob.environment ?? null,
      };
    }),

  /** 刪除歷史回測記錄 */
  deleteRun: protectedProcedure
    .input(z.object({ jobId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");
      const success = await backtestJobManager.deleteJobFromDB(input.jobId, userId);
      if (!success) throw new Error("刪除失敗");
      return { success: true };
    }),

  /** 獲取進行中的任務數（用於側邊欄 badge） */
  getActiveCount: protectedProcedure.query(() => {
    return { count: backtestJobManager.getActiveJobCount() };
  }),

  // ==================== 參數快照庫 ====================

  /** 儲存參數快照（V5.7 擴展：含環境元數據） */
  saveSnapshot: protectedProcedure
    .input(z.object({
      strategyKey: z.string(),
      strategyName: z.string().optional(),
      snapshotName: z.string().optional(),
      config: z.record(z.string(), z.unknown()),
      metrics: z.object({
        totalReturn: z.number(),
        winRate: z.number(),
        sharpeRatio: z.number().optional(),
        profitFactor: z.number().optional(),
        maxDrawdown: z.number().optional(),
        calmarRatio: z.number().optional(),
        totalTrades: z.number().optional(),
        winningTrades: z.number().optional(),
        losingTrades: z.number().optional(),
        avgWin: z.number().optional(),
        avgLoss: z.number().optional(),
        maxWin: z.number().optional(),
        maxLoss: z.number().optional(),
      }),
      /** 回測設定（交易所、交易對、時間框架、日期、資金等） */
      backtestSettings: backtestSettingsSchema.optional(),
      /** V5.7 環境元數據（可選，回測引擎自動填入） */
      environment: z.object({
        dataHash: z.string(),
        engineVersion: z.string(),
        leverage: z.number(),
        commission: z.number(),
        slippage: z.number(),
      }).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");

      const db = await getDb();
      if (!db) throw new Error("資料庫不可用");

      const snapshotName = input.snapshotName ||
        `${input.strategyKey}_${new Date().toLocaleDateString("zh-TW")}_${new Date().toLocaleTimeString("zh-TW", { hour12: false })}`;
      const storedConfig = normalizeSnapshotConfigForStrategy(
        input.strategyKey,
        input.config,
      );
      const storedBacktestSettings = input.backtestSettings
        ? {
            ...input.backtestSettings,
            ...(input.strategyKey === V25_STRATEGY_KEY
              ? {
                  tradeAmount: Number(storedConfig.Base_Lot_Size),
                  baseLotSize: Number(storedConfig.Base_Lot_Size),
                  baseLotSizeMode: "usdt",
                  configJson: storedConfig,
                }
              : input.strategyKey === RAINBOW_20415_STRATEGY_KEY
                ? {
                    tradeAmount: Number((storedConfig.Base_Lot_Size as { value?: unknown })?.value),
                    baseLotSize: Number((storedConfig.Base_Lot_Size as { value?: unknown })?.value),
                    baseLotSizeMode: String((storedConfig.Base_Lot_Size as { mode?: unknown })?.mode ?? "quantity"),
                    configJson: storedConfig,
                  }
                : input.strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY
                  ? {
                      tradeAmount: Number((storedConfig.Base_Lot_Size as { value?: unknown })?.value),
                      baseLotSize: Number((storedConfig.Base_Lot_Size as { value?: unknown })?.value),
                      baseLotSizeMode: String((storedConfig.Base_Lot_Size as { mode?: unknown })?.mode ?? "quantity"),
                      configJson: storedConfig,
                    }
                : {}),
          }
        : null;

      await db.insert(parameterSnapshots).values({
        userId,
        strategyKey: input.strategyKey,
        strategyName: input.strategyName || input.strategyKey,
        snapshotName,
        config: storedConfig,
        metrics: input.metrics,
        totalReturn: String(input.metrics.totalReturn),
        winRate: String(input.metrics.winRate),
        sharpeRatio: input.metrics.sharpeRatio !== undefined ? String(input.metrics.sharpeRatio) : null,
        profitFactor: input.metrics.profitFactor !== undefined ? String(input.metrics.profitFactor) : null,
        maxDrawdown: input.metrics.maxDrawdown !== undefined ? String(input.metrics.maxDrawdown) : null,
        // 回測設定
        backtestSettings: storedBacktestSettings,
        // V5.7 環境元數據
        dataHash: input.environment?.dataHash ?? null,
        engineVersion: input.environment?.engineVersion ?? null,
        leverage: input.environment?.leverage !== undefined ? String(input.environment.leverage) : null,
        commission: input.environment?.commission !== undefined ? String(input.environment.commission) : null,
        slippage: input.environment?.slippage !== undefined ? String(input.environment.slippage) : null,
      });

      return { success: true, snapshotName };
    }),

  /** 獲取參數快照列表（可按策略過濾） */
  getSnapshots: protectedProcedure
    .input(z.object({
      strategyKey: z.string().optional(),
      limit: z.number().min(1).max(200).default(50),
      sortBy: z.enum(["totalReturn", "winRate", "sharpeRatio", "createdAt"]).default("createdAt"),
    }).optional())
    .query(async ({ ctx, input }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");

      const db = await getDb();
      if (!db) return [];

      const conditions = [eq(parameterSnapshots.userId, userId)];
      if (input?.strategyKey) {
        conditions.push(eq(parameterSnapshots.strategyKey, input.strategyKey));
      }

      const sortField = input?.sortBy === "totalReturn" ? parameterSnapshots.totalReturn :
                        input?.sortBy === "winRate" ? parameterSnapshots.winRate :
                        input?.sortBy === "sharpeRatio" ? parameterSnapshots.sharpeRatio :
                        parameterSnapshots.createdAt;

      const rows = await db
        .select()
        .from(parameterSnapshots)
        .where(and(...conditions))
        .orderBy(desc(sortField))
        .limit(input?.limit ?? 50);

      return rows.map(r => ({
        id: r.id,
        strategyKey: r.strategyKey,
        strategyName: r.strategyName,
        snapshotName: r.snapshotName,
        config: r.config as Record<string, unknown>,
        metrics: r.metrics as Record<string, number>,
        backtestSettings: r.backtestSettings as { exchange: string; symbol: string; timeframe: string; startDate: string; endDate: string; initialCapital: number; tradeAmount?: number; endPositionPolicy?: "mark_to_market" | "force_close"; configJson?: Record<string, unknown>; baseLotSize?: number; baseLotSizeMode?: string } | null,
        totalReturn: r.totalReturn ? parseFloat(r.totalReturn) : 0,
        winRate: r.winRate ? parseFloat(r.winRate) : 0,
        sharpeRatio: r.sharpeRatio ? parseFloat(r.sharpeRatio) : null,
        profitFactor: r.profitFactor ? parseFloat(r.profitFactor) : null,
        maxDrawdown: r.maxDrawdown ? parseFloat(r.maxDrawdown) : null,
        isFavorite: r.isFavorite,
        createdAt: r.createdAt,
      }));
    }),

  /** 刪除快照 */
  deleteSnapshot: protectedProcedure
    .input(z.object({ snapshotId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");

      const db = await getDb();
      if (!db) throw new Error("資料庫不可用");

      await db.delete(parameterSnapshots).where(
        and(eq(parameterSnapshots.id, input.snapshotId), eq(parameterSnapshots.userId, userId))
      );
      return { success: true };
    }),

  /** 套用快照到策略實例 */
  applySnapshot: protectedProcedure
    .input(z.object({
      snapshotId: z.number(),
      targetStrategyId: z.number(),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");

      const db = await getDb();
      if (!db) throw new Error("資料庫不可用");

      // 取得快照
      const [snapshot] = await db
        .select()
        .from(parameterSnapshots)
        .where(and(eq(parameterSnapshots.id, input.snapshotId), eq(parameterSnapshots.userId, userId)))
        .limit(1);
      if (!snapshot) throw new Error("快照不存在");

      // 取得目標策略
      const [strategy] = await db
        .select()
        .from(strategies)
        .where(and(eq(strategies.id, input.targetStrategyId), eq(strategies.userId, userId)))
        .limit(1);
      if (!strategy) throw new Error("目標策略不存在");

      const snapshotKey = snapshot.strategyKey;
      if (!snapshotKey) throw new Error("快照缺少策略引擎身份，無法安全套用");
      assertRegisteredStrategy(snapshotKey);
      const config = normalizeSnapshotConfigForStrategy(
        snapshotKey,
        (snapshot.config as Record<string, unknown>) || {},
      );

      if (!strategy.strategyKey || strategy.strategyKey !== snapshotKey) {
        throw new Error(
          `快照引擎（${snapshotKey}）與目標策略引擎（${strategy.strategyKey || "未綁定"}）不一致，已拒絕套用。`,
        );
      }

      const currentState =
        strategy.martinState && typeof strategy.martinState === "object"
          ? (strategy.martinState as Record<string, unknown>)
          : {};
      const updatedState = attachSnapshotConfig(currentState, snapshotKey, config, {
        snapshotId: snapshot.id,
        snapshotName: snapshot.snapshotName,
      });
      const v25Config = snapshotKey === V25_STRATEGY_KEY
        ? assertValidV25Config(config)
        : undefined;
      const firstV25Range = v25Config?.Martin_Ranges[0];
      const rainbowConfig = snapshotKey === RAINBOW_20415_STRATEGY_KEY
        ? assertValidRainbow20415Config(config)
        : undefined;
      const firstRainbowRange = rainbowConfig?.Martin_Ranges.find((range) => range.enabled);
      const ladderConfig = snapshotKey === RAINBOW_TREND_LADDER_STRATEGY_KEY
        ? assertValidRainbowTrendLadderConfig(config)
        : undefined;
      const firstLadderRange = ladderConfig?.Martin_Layers.find(
        (range) => range.enabled && range.layer <= ladderConfig.Max_Layers,
      );
      const nextLadderRange = ladderConfig?.Martin_Layers.find(
        (range) => range.enabled && range.layer > 1 && range.layer <= ladderConfig.Max_Layers,
      );

      await db.update(strategies)
        .set({
          martinState: updatedState,
          martinMultiplier: String(firstLadderRange?.lotMultiplier ?? firstRainbowRange?.multiplier ?? firstV25Range?.multiplier ?? config.Martin_Multiplier ?? strategy.martinMultiplier),
          maxMartinLevel: v25Config
            ? Math.max(1, deriveV25MaxMartinLayer(v25Config.Martin_Ranges))
            : rainbowConfig
              ? Math.max(1, deriveRainbow20415FinalEnabledLayer(rainbowConfig.Martin_Ranges))
              : ladderConfig
                ? ladderConfig.Max_Layers
                : config.Max_Layers ?? (strategy as any).maxMartinLevel,
          martinSpacingPct: String(
            nextLadderRange?.triggerSpacingPct
              ?? (firstRainbowRange
                ? (firstRainbowRange.useGlobalSpacing ? rainbowConfig?.Global_Spacing_Pct : firstRainbowRange.spacingPct)
                : firstV25Range?.gap ?? config.Martin_Step_Pct ?? strategy.martinSpacingPct),
          ),
          ...(v25Config ? {
            stopLossPct: String(v25Config.Hard_Stop_Loss_Pct),
            takeProfitPct: String(v25Config.Take_Profit_Pct),
            kLinePeriod: v25Config.K_Line_Period,
            reentryEnabled: v25Config.Reentry_On_Trend,
          } : rainbowConfig ? {
            stopLossPct: "0",
            takeProfitPct: String(rainbowConfig.Take_Profit_Pct),
            maxLossPct: String(rainbowConfig.Max_Account_Loss_Pct),
            kLinePeriod: rainbowConfig.Entry_Timeframe_Minutes,
            reentryEnabled: rainbowConfig.Reentry_Enabled,
          } : ladderConfig ? {
            stopLossPct: "0",
            takeProfitPct: String(ladderConfig.Trailing_Activation_Pct),
            kLinePeriod: ladderConfig.Entry_Timeframe_Minutes,
            reentryEnabled: ladderConfig.Reentry_Wait_Next_M30_Close,
          } : {}),
        })
        .where(eq(strategies.id, input.targetStrategyId));

      return { success: true, message: "✅ 參數已套用到策略實例（含馬丁分層設定）" };
    }),

  /** V4.3: 將快照導入為新策略實例 */
  importSnapshotAsNew: protectedProcedure
    .input(z.object({
      snapshotId: z.number(),
      name: z.string().min(1).max(100),
      apiKeyId: z.number(),
      symbol: z.string().min(1).max(32),
      positionSize: z.number().positive(),
      positionMode: z.enum(['quantity', 'usdt']).default('usdt'),
      leverage: z.number().int().min(1).max(125).default(1),
      direction: z.enum(['long', 'short', 'both']).default('both'),
      orderType: z.enum(['market', 'limit']).default('market'),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");

      const db = await getDb();
      if (!db) throw new Error("資料庫不可用");

      // 取得快照
      const [snapshot] = await db
        .select()
        .from(parameterSnapshots)
        .where(and(eq(parameterSnapshots.id, input.snapshotId), eq(parameterSnapshots.userId, userId)))
        .limit(1);
      if (!snapshot) throw new Error("快照不存在");

      // 查詢 API Key 以取得 exchange
      const { getApiKeyById } = await import('../db');
      const keyRecord = await getApiKeyById(input.apiKeyId, userId);
      if (!keyRecord) throw new Error("選擇的 API 金鑰不存在");

      const snapshotKey = snapshot.strategyKey;
      if (!snapshotKey) throw new Error("快照缺少策略引擎身份，無法建立自動交易策略");
      assertRegisteredStrategy(snapshotKey);

      const config = normalizeSnapshotConfigForStrategy(
        snapshotKey,
        (snapshot.config as Record<string, unknown>) || {},
      );
      const v25Config = snapshotKey === V25_STRATEGY_KEY
        ? assertValidV25Config(config)
        : undefined;
      const firstV25Range = v25Config?.Martin_Ranges[0];
      const rainbowConfig = snapshotKey === RAINBOW_20415_STRATEGY_KEY
        ? assertValidRainbow20415Config(config)
        : undefined;
      const firstRainbowRange = rainbowConfig?.Martin_Ranges.find((range) => range.enabled);
      const ladderConfig = snapshotKey === RAINBOW_TREND_LADDER_STRATEGY_KEY
        ? assertValidRainbowTrendLadderConfig(config)
        : undefined;
      const firstLadderRange = ladderConfig?.Martin_Layers.find(
        (range) => range.enabled && range.layer <= ladderConfig.Max_Layers,
      );
      const nextLadderRange = ladderConfig?.Martin_Layers.find(
        (range) => range.enabled && range.layer > 1 && range.layer <= ladderConfig.Max_Layers,
      );
      const backtestSettings =
        snapshot.backtestSettings && typeof snapshot.backtestSettings === "object"
          ? (snapshot.backtestSettings as Record<string, unknown>)
          : {};
      const deploymentPosition = finalizeDeploymentPosition({
        positionSize: input.positionSize,
        positionMode: input.positionMode,
      });

      // 生成 webhookSecret
      const { generateWebhookSecret } = await import('../lib/crypto');
      const webhookSecret = generateWebhookSecret();

      // 建立新策略實例
      const { createStrategy } = await import('../db');
      const insertResult: any = await createStrategy({
        userId,
        name: input.name,
        description: `從快照「${snapshot.snapshotName || '未命名'}」導入；引擎已鎖定為 ${snapshotKey}`,
        apiKeyId: input.apiKeyId,
        exchange: keyRecord.exchange,
        symbol: input.symbol.toUpperCase(),
        ...deploymentPositionColumns(deploymentPosition),
        leverage: input.leverage,
        direction: input.direction,
        orderType: input.orderType,
        // 快照導入只建立配置，不得在尚未人工覆核實盤倉位前自動啟用或觸發交易。
        enabled: false,
        webhookSecret,
        maxPositionPct: String(finiteNumber(config.max_single_position_pct, 0)),
        stopLossPct: String(rainbowConfig || ladderConfig ? 0 : (v25Config?.Hard_Stop_Loss_Pct ?? finiteNumber(config.stop_loss_pct, 0))),
        takeProfitPct: String(ladderConfig?.Trailing_Activation_Pct ?? rainbowConfig?.Take_Profit_Pct ?? v25Config?.Take_Profit_Pct ?? finiteNumber(config.Target_TP_Pct, 0)),
        maxDailyLoss: String(finiteNumber(config.daily_loss_limit, 0)),
        martinMultiplier: String(firstLadderRange?.lotMultiplier ?? firstRainbowRange?.multiplier ?? firstV25Range?.multiplier ?? config.Martin_Multiplier ?? 1),
        maxMartinLevel: v25Config
          ? Math.max(1, deriveV25MaxMartinLayer(v25Config.Martin_Ranges))
          : rainbowConfig
            ? Math.max(1, deriveRainbow20415FinalEnabledLayer(rainbowConfig.Martin_Ranges))
            : ladderConfig
              ? ladderConfig.Max_Layers
              : Math.max(1, Math.round(finiteNumber(config.Max_Layers, 1))),
        martinSpacingPct: String(
          nextLadderRange?.triggerSpacingPct
            ?? (firstRainbowRange
              ? (firstRainbowRange.useGlobalSpacing ? rainbowConfig?.Global_Spacing_Pct : firstRainbowRange.spacingPct)
              : firstV25Range?.gap ?? config.Martin_Step_Pct ?? 0),
        ),
        martinState: attachSnapshotConfig(
          {
            lossCount: 0,
            currentLot: deploymentPosition.value,
            lastEntryPrice: 0,
          },
          snapshotKey,
          config,
          {
            snapshotId: snapshot.id,
            snapshotName: snapshot.snapshotName,
          },
        ),
        strategyKey: snapshotKey,
        tradeMode: 'webhook',
        kLinePeriod: ladderConfig?.Entry_Timeframe_Minutes ?? rainbowConfig?.Entry_Timeframe_Minutes ?? resolveKLineMinutes(config, backtestSettings.timeframe),
        reentryEnabled: ladderConfig?.Reentry_Wait_Next_M30_Close ?? rainbowConfig?.Reentry_Enabled ?? config.Reentry_On_Trend !== false,
      });

      const newId = insertResult?.[0]?.insertId;
      return {
        success: true,
        strategyId: newId,
        strategyKey: snapshotKey,
        positionMode: deploymentPosition.mode,
        enabled: false,
        message: `已從快照建立停用策略「${input.name}」；原引擎鎖定為 ${snapshotKey}，請確認實盤倉位後再手動啟用`,
      };
    }),

  /** V5.3: 直接套用配置到策略實例（含版本校驗，不需先存快照） */
  applySnapshotToInstance: protectedProcedure
    .input(z.object({
      snapshotConfig: z.record(z.string(), z.unknown()),
      strategyKey: z.string(),
      targetInstanceId: z.number(),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");

      const db = await getDb();
      if (!db) throw new Error("資料庫不可用");

      // 1. 獲取目標策略實例
      const [instance] = await db
        .select()
        .from(strategies)
        .where(and(eq(strategies.id, input.targetInstanceId), eq(strategies.userId, userId)))
        .limit(1);
      if (!instance) {
        throw new Error("目標策略實例不存在");
      }

      // 2. 版本校驗 - 比對 strategyKey
      const instanceKey = (instance as any).strategyKey;
      const snapshotKey = input.strategyKey;

      assertRegisteredStrategy(snapshotKey);
      if (!instanceKey || instanceKey !== snapshotKey) {
        throw new Error(
          `⚠️ 快照的策略類型（${snapshotKey}）與目標實例（${instanceKey}）不匹配，無法套用。請選擇相同策略類型的實例。`
        );
      }

      const prevState =
        (instance as any).martinState && typeof (instance as any).martinState === "object"
          ? ((instance as any).martinState as Record<string, unknown>)
          : { lossCount: 0, currentLot: Number(instance.positionSize), lastEntryPrice: 0 };

      const config = normalizeSnapshotConfigForStrategy(
        snapshotKey,
        input.snapshotConfig as Record<string, unknown>,
      );
      const updatedState = attachSnapshotConfig(prevState, snapshotKey, config, {
        snapshotName: "直接套用配置",
      });
      const v25Config = snapshotKey === V25_STRATEGY_KEY
        ? assertValidV25Config(config)
        : undefined;
      const firstV25Range = v25Config?.Martin_Ranges[0];
      const rainbowConfig = snapshotKey === RAINBOW_20415_STRATEGY_KEY
        ? assertValidRainbow20415Config(config)
        : undefined;
      const firstRainbowRange = rainbowConfig?.Martin_Ranges.find((range) => range.enabled);
      const ladderConfig = snapshotKey === RAINBOW_TREND_LADDER_STRATEGY_KEY
        ? assertValidRainbowTrendLadderConfig(config)
        : undefined;
      const firstLadderRange = ladderConfig?.Martin_Layers.find(
        (range) => range.enabled && range.layer <= ladderConfig.Max_Layers,
      );
      const nextLadderRange = ladderConfig?.Martin_Layers.find(
        (range) => range.enabled && range.layer > 1 && range.layer <= ladderConfig.Max_Layers,
      );

      await db.update(strategies)
        .set({
          martinState: updatedState,
          martinMultiplier: String(firstLadderRange?.lotMultiplier ?? firstRainbowRange?.multiplier ?? firstV25Range?.multiplier ?? config.Martin_Multiplier ?? instance.martinMultiplier),
          maxMartinLevel: v25Config
            ? Math.max(1, deriveV25MaxMartinLayer(v25Config.Martin_Ranges))
            : rainbowConfig
              ? Math.max(1, deriveRainbow20415FinalEnabledLayer(rainbowConfig.Martin_Ranges))
              : ladderConfig
                ? ladderConfig.Max_Layers
                : config.Max_Layers ?? (instance as any).maxMartinLevel,
          martinSpacingPct: String(
            nextLadderRange?.triggerSpacingPct
              ?? (firstRainbowRange
              ? (firstRainbowRange.useGlobalSpacing ? rainbowConfig?.Global_Spacing_Pct : firstRainbowRange.spacingPct)
              : firstV25Range?.gap ?? config.Martin_Step_Pct ?? instance.martinSpacingPct),
          ),
          ...(v25Config ? {
            stopLossPct: String(v25Config.Hard_Stop_Loss_Pct),
            takeProfitPct: String(v25Config.Take_Profit_Pct),
            kLinePeriod: v25Config.K_Line_Period,
            reentryEnabled: v25Config.Reentry_On_Trend,
          } : rainbowConfig ? {
            stopLossPct: "0",
            takeProfitPct: String(rainbowConfig.Take_Profit_Pct),
            maxLossPct: String(rainbowConfig.Max_Account_Loss_Pct),
            kLinePeriod: rainbowConfig.Entry_Timeframe_Minutes,
            reentryEnabled: rainbowConfig.Reentry_Enabled,
          } : ladderConfig ? {
            stopLossPct: "0",
            takeProfitPct: String(ladderConfig.Trailing_Activation_Pct),
            kLinePeriod: ladderConfig.Entry_Timeframe_Minutes,
            reentryEnabled: ladderConfig.Reentry_Wait_Next_M30_Close,
          } : {}),
        })
        .where(eq(strategies.id, input.targetInstanceId));

      return {
        success: true,
        message: "✅ 參數已成功套用到策略實例（含馬丁分層設定）",
        instanceId: input.targetInstanceId,
      };
    }),

  /** 獲取單個快照的完整配置（用於導入預覽） */
  getSnapshotConfig: protectedProcedure
    .input(z.object({ snapshotId: z.number() }))
    .query(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");

      const db = await getDb();
      if (!db) throw new Error("資料庫不可用");

      const [snapshot] = await db
        .select()
        .from(parameterSnapshots)
        .where(and(eq(parameterSnapshots.id, input.snapshotId), eq(parameterSnapshots.userId, userId)))
        .limit(1);

      if (!snapshot) throw new Error("快照不存在");

      return {
        id: snapshot.id,
        strategyKey: snapshot.strategyKey,
        strategyName: snapshot.strategyName,
        snapshotName: snapshot.snapshotName,
        config: snapshot.config as Record<string, unknown>,
        metrics: snapshot.metrics as Record<string, number>,
        backtestSettings: snapshot.backtestSettings as { exchange: string; symbol: string; timeframe: string; startDate: string; endDate: string; initialCapital: number; tradeAmount?: number; endPositionPolicy?: "mark_to_market" | "force_close"; configJson?: Record<string, unknown>; baseLotSize?: number; baseLotSizeMode?: string } | null,
        totalReturn: snapshot.totalReturn ? parseFloat(snapshot.totalReturn) : 0,
        winRate: snapshot.winRate ? parseFloat(snapshot.winRate) : 0,
        sharpeRatio: snapshot.sharpeRatio ? parseFloat(snapshot.sharpeRatio) : null,
        maxDrawdown: snapshot.maxDrawdown ? parseFloat(snapshot.maxDrawdown) : null,
        createdAt: snapshot.createdAt,
      };
    }),

  /** 切換快照收藏狀態 */
  toggleSnapshotFavorite: protectedProcedure
    .input(z.object({ snapshotId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");

      const db = await getDb();
      if (!db) throw new Error("資料庫不可用");

      const [snapshot] = await db
        .select()
        .from(parameterSnapshots)
        .where(and(eq(parameterSnapshots.id, input.snapshotId), eq(parameterSnapshots.userId, userId)))
        .limit(1);
      if (!snapshot) throw new Error("快照不存在");

      await db.update(parameterSnapshots)
        .set({ isFavorite: !snapshot.isFavorite })
        .where(eq(parameterSnapshots.id, input.snapshotId));

      return { success: true, isFavorite: !snapshot.isFavorite };
    }),

  /** 更新快照績效指標（用於舊快照重新同步回測結果） */
  updateSnapshotMetrics: protectedProcedure
    .input(z.object({
      snapshotId: z.number(),
      metrics: z.object({
        totalReturn: z.number(),
        winRate: z.number(),
        sharpeRatio: z.number().optional(),
        profitFactor: z.number().optional(),
        maxDrawdown: z.number().optional(),
        calmarRatio: z.number().optional(),
        totalTrades: z.number().optional(),
        winningTrades: z.number().optional(),
        losingTrades: z.number().optional(),
        avgWin: z.number().optional(),
        avgLoss: z.number().optional(),
        maxWin: z.number().optional(),
        maxLoss: z.number().optional(),
      }),
      backtestSettings: z.object({
        exchange: z.string(),
        symbol: z.string(),
        timeframe: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        initialCapital: z.number(),
        tradeAmount: z.number().optional(),
        configJson: z.record(z.string(), z.unknown()).optional(),
        baseLotSize: z.number().optional(),
        baseLotSizeMode: z.string().optional(),
      }).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");

      const db = await getDb();
      if (!db) throw new Error("資料庫不可用");

      const [snapshot] = await db
        .select()
        .from(parameterSnapshots)
        .where(and(eq(parameterSnapshots.id, input.snapshotId), eq(parameterSnapshots.userId, userId)))
        .limit(1);
      if (!snapshot) throw new Error("快照不存在");

      const updateData: Record<string, any> = {
        metrics: input.metrics,
        totalReturn: String(input.metrics.totalReturn),
        winRate: String(input.metrics.winRate),
        sharpeRatio: input.metrics.sharpeRatio !== undefined ? String(input.metrics.sharpeRatio) : null,
        profitFactor: input.metrics.profitFactor !== undefined ? String(input.metrics.profitFactor) : null,
        maxDrawdown: input.metrics.maxDrawdown !== undefined ? String(input.metrics.maxDrawdown) : null,
      };
      if (input.backtestSettings) {
        updateData.backtestSettings = input.backtestSettings;
      }

      await db.update(parameterSnapshots)
        .set(updateData)
        .where(eq(parameterSnapshots.id, input.snapshotId));

      return { success: true, message: "✅ 快照績效已更新" };
    }),

  // ==================== 參數掃描（異步） ====================

  /** 提交參數掃描任務 */
  submitScan: protectedProcedure
    .input(z.object({
      strategyKey: z.string(),
      strategyName: z.string().optional(),
      symbols: z.array(z.string()).min(1).max(3),
      timeframe: z.string(),
      startDate: z.number().positive(),
      endDate: z.number().positive(),
      initialCapital: z.number().positive().default(10000),
      tradeAmount: z.number().positive().optional(),
      baseConfig: z.record(z.string(), z.unknown()),
      /** 手動模式：參數值列表 */
      parameters: z.array(z.object({
        name: z.string(),
        values: z.array(z.number()),
      })).default([]),
      /** 智能模式：參數範圍 */
      parameterRanges: z.array(z.object({
        name: z.string(),
        min: z.number(),
        max: z.number(),
        step: z.number(),
      })).optional(),
      /** 掃描模式：fast/standard/deep/manual */
      mode: z.enum(["fast", "standard", "deep", "manual"]).default("standard"),
      /** Walk-Forward 驗證 */
      walkForward: z.boolean().default(true),
      objective: z.enum(["totalReturn", "winRate", "sharpeRatio", "profitFactor", "compositeScore"]).default("compositeScore"),
      objectiveWeights: z.object({
        totalReturn: z.number().min(0).max(1),
        winRate: z.number().min(0).max(1),
        sharpeRatio: z.number().min(0).max(1),
        profitFactor: z.number().min(0).max(1),
        maxDrawdown: z.number().min(0).max(1),
      }).optional(),
      commission: z.number().optional(),
      slippage: z.number().optional(),
      exchange: z.enum(["okx", "bybit"]).default("okx"),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");

      const scanId = await scanJobManager.submit({
        strategyKey: input.strategyKey,
        strategyName: input.strategyName,
        symbols: input.symbols,
        timeframe: input.timeframe,
        startDate: input.startDate,
        endDate: input.endDate,
        initialCapital: input.initialCapital,
        tradeAmount: input.tradeAmount,
        baseConfig: input.baseConfig,
        parameters: input.parameters,
        parameterRanges: input.parameterRanges,
        mode: input.mode,
        walkForward: input.walkForward,
        commission: input.commission,
        slippage: input.slippage,
        exchange: input.exchange,
        objectiveWeights: input.objectiveWeights,
      }, userId, input.objective);

      return { scanId, message: input.mode === "manual" ? "網格掃描任務已提交" : `NSGA-II ${input.mode} 模式優化已啟動` };
    }),

  /** 中止掃描任務 */
  abortScan: protectedProcedure
    .input(z.object({ scanId: z.string() }))
    .mutation(async ({ input }) => {
      const ok = scanJobManager.abort(input.scanId);
      return { success: ok, message: ok ? "已中止" : "任務不存在或已完成" };
    }),

  /** 獲取掃描任務狀態 */
  getScanStatus: protectedProcedure
    .input(z.object({ scanId: z.string() }))
    .query(async ({ input }) => {
      const status = scanJobManager.getStatus(input.scanId);
      if (status) return status;
      // 內存中找不到（可能實例被回收），嘗試從 DB 恢復
      const dbStatus = await scanJobManager.getStatusFromDB(input.scanId);
      if (dbStatus) return dbStatus;
      throw new Error("掃描任務不存在或已過期");
    }),

  /** 掃描歷史記錄列表 */
  listScanHistory: protectedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");
      return scanJobManager.listHistory(userId);
    }),

  /** 獲取掃描詳情 */
  getScanDetail: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      return scanJobManager.getDetail(input.id);
    }),

  /** 對比多個掃描結果 */
  compareScanResults: protectedProcedure
    .input(z.object({ ids: z.array(z.number()).min(2).max(5) }))
    .query(async ({ input }) => {
      return scanJobManager.compareScans(input.ids);
    }),

  /** 刪除掃描記錄 */
  deleteScanHistory: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new Error("請先登入");
      const ok = await scanJobManager.deleteHistory(input.id, userId);
      return { success: ok };
    }),

  /** 掃描佇列狀態 */
  getScanQueueStatus: protectedProcedure
    .query(async () => {
      return scanJobManager.getQueueStatus();
    }),

  /** 掃描活躍任務列表 */
  getScanActiveJobs: protectedProcedure
    .query(async () => {
      const jobs = await scanJobManager.getActiveJobs();
      // 合併 scan_state 中的深度掃描任務（Heartbeat 模式）
      try {
        const { getDb } = await import("../db");
        const { scanState } = await import("../../drizzle/schema");
        const db = await getDb();
        if (db) {
          const seenIds = new Set(jobs.map((j: any) => j.scanId));
          const deepRows = await db.select().from(scanState).limit(20);
          // Filter active deep scans not already in jobs
          for (const row of deepRows) {
            if (seenIds.has(row.scanId)) continue;
            if (row.currentPhase === 'completed' || row.currentPhase === 'failed') continue;
            const cfg = row.config as any;
            jobs.push({
              scanId: row.scanId,
              status: "running",
              phase: row.currentPhase || "evolution",
              progress: row.maxGenerations > 0
                ? Math.round((row.currentGeneration / row.maxGenerations) * 100)
                : 0,
              preloadMessage: row.currentPhase === 'preloading' ? '已創建後台任務，等待首次觸發...' : row.currentPhase === 'initializing' ? '種群初始化中...' : `後台執行中 (${row.currentPhase})`,
              strategyName: cfg?.strategyName || cfg?.strategyKey,
              symbols: cfg?.symbols,
              timeframe: cfg?.timeframe,
              mode: row.scanMode || "standard",
              createdAt: new Date(row.createdAt).getTime(),
              totalCombinations: undefined,
              completedCombinations: undefined,
              currentGeneration: row.currentGeneration,
              maxGenerations: row.maxGenerations,
            });
          }
        }
      } catch (e) {
        // 靜默失敗
      }
      return jobs;
    }),

  /** 掃描活躍任務數（側邊欄 badge） */
  getScanActiveCount: protectedProcedure
    .query(async () => {
      let count = await scanJobManager.getActiveCount();
      // 加上 scan_state 中的深度掃描任務數
      try {
        const { getDb } = await import("../db");
        const { scanState } = await import("../../drizzle/schema");
        const db = await getDb();
        if (db) {
          const rows = await db.select({ scanId: scanState.scanId, currentPhase: scanState.currentPhase })
            .from(scanState).limit(20);
          for (const row of rows) {
            if (row.currentPhase !== 'completed' && row.currentPhase !== 'failed') {
              count++;
            }
          }
        }
      } catch {}
      return { count };
    }),

  // ==================== 參數掃描優化（同步，保留向後兼容） ====================

  /** 參數掃描優化（同步執行，組合數受限） */
  optimize: protectedProcedure
    .input(
      z.object({
        baseRequest: backtestRequestSchema,
        parameterRanges: z
          .array(
            z.object({
              name: z.string().min(1),
              min: z.number(),
              max: z.number(),
              step: z.number().positive(),
            }),
          )
          .min(1)
          .max(3),
        objective: z
          .enum(["sharpeRatio", "totalReturn", "profitFactor", "calmarRatio", "winRate"])
          .default("sharpeRatio"),
        maxCombinations: z.number().min(1).max(60).default(30),
      }),
    )
    .mutation(async ({ input }) => {
      const baseRequest = validateRequest(input.baseRequest);
      return runOptimization({
        baseRequest,
        parameterRanges: input.parameterRanges,
        objective: input.objective,
        maxCombinations: input.maxCombinations,
      });
    }),

  /** 多品種回測（最多 10 個交易對，串行） */
  multiSymbol: protectedProcedure
    .input(
      z.object({
        symbols: z.array(z.string().min(1)).min(1).max(10),
        baseRequest: backtestRequestSchema.omit({ symbol: true }),
      }),
    )
    .mutation(async ({ input }) => {
      const base = validateRequest({ ...input.baseRequest, symbol: input.symbols[0] });
      const { symbol: _s, ...baseWithoutSymbol } = base;
      return runMultiSymbolBacktest(input.symbols, baseWithoutSymbol);
    }),
});
