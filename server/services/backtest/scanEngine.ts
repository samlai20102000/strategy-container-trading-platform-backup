/**
 * 參數掃描引擎（V7.0 - WebSocket 驅動 + NSGA-II 遺傳算法智能優化）
 * 
 * 核心架構（Plan A）：
 * - 所有模式（fast/standard/deep/manual）統一走 processQueue → 本地執行
 * - 通過 WebSocket 即時推送進度（前端訂閱 scanId）
 * - 移除 Heartbeat 分段執行（解決 Rate Exceeded 崩潰問題）
 * - 智能四階段流程：敏感性分析 → 進化搜索 → DE 精煉 → Walk-Forward 驗證
 * - 三檔模式：快速(5代/~2-5分) / 標準(8代/~10-15分) / 深度(15代/~20-35分)
 * - 保留手動模式（網格搜索）作為進階選項
 * - 多交易對並行掃描（最多 3 個）
 * - 全策略版本支援（V3.5 / V5.0 / V6.1 / V7.0 + 自訂策略）
 * - 掃描結果完整持久化到 DB
 * - Pareto 前沿 + 參數重要性排名 + 穩健性評分
 */
import { backtestEngine, type BacktestRequest, type BacktestResult } from "./backtestEngine";
import { ensureOHLCVData } from "./dataFetcher";
import { getTimeframeMilliseconds } from "./timeframeParser";
import type { PerformanceMetrics } from "./performanceCalculator";
import {
  NSGAII,
  SCAN_MODE_CONFIGS,
  calculateWalkForwardSplit,
  calculateRobustnessScore,
  type ParameterSpace,
  type Individual,
  type ObjectiveValues,
  type EvolutionConfig,
  type EvolutionProgress,
  type EvolutionResult,
  type WalkForwardResult,
} from "./nsgaII";
import { getDb } from "../../db";
import { scanJobs } from "../../../drizzle/schema";
import { eq, desc, and, inArray } from "drizzle-orm";
import { TelegramNotifier } from "../telegramNotifier";
import { backtestWsService } from "../wsService";

const telegramNotifier = new TelegramNotifier();

// ============================================================
// 類型定義
// ============================================================

/** 手動模式：參數值列表（向後兼容） */
export interface ScanParameterDef {
  name: string;
  values: number[];
}

/** 智能模式：參數空間定義 */
export interface ScanParameterRange {
  name: string;
  min: number;
  max: number;
  step: number;
}

/** 掃描模式 */
export type ScanMode = "fast" | "standard" | "deep" | "manual";

/** 掃描配置（統一） */
export interface ScanConfig {
  strategyKey: string;
  strategyName?: string;
  symbols: string[];
  timeframe: string;
  startDate: number;
  endDate: number;
  initialCapital: number;
  tradeAmount?: number;
  baseConfig: Record<string, unknown>;
  /** 手動模式用：具體參數值列表 */
  parameters: ScanParameterDef[];
  /** 智能模式用：參數範圍定義 */
  parameterRanges?: ScanParameterRange[];
  /** 掃描模式 */
  mode?: ScanMode;
  /** 是否啟用 Walk-Forward 驗證 */
  walkForward?: boolean;
  commission?: number;
  slippage?: number;
  exchange?: "okx" | "bybit";
  endPositionPolicy?: BacktestRequest["endPositionPolicy"];
  executionMode?: BacktestRequest["executionMode"];
  executionPolicy?: BacktestRequest["executionPolicy"];
  strategyVersion?: BacktestRequest["strategyVersion"];
  strategyLogicHash?: BacktestRequest["strategyLogicHash"];
  strategyModeCapabilities?: BacktestRequest["strategyModeCapabilities"];
  fundingModel?: BacktestRequest["fundingModel"];
  contractSpecification?: BacktestRequest["contractSpecification"];
  /** 多目標優化權重 */
  objectiveWeights?: ObjectiveWeights;
}

export function buildScanBacktestExecutionContext(config: ScanConfig): Partial<BacktestRequest> {
  return {
    endPositionPolicy: config.endPositionPolicy,
    executionMode: config.executionMode,
    executionPolicy: config.executionPolicy,
    strategyVersion: config.strategyVersion,
    strategyLogicHash: config.strategyLogicHash,
    strategyModeCapabilities: config.strategyModeCapabilities,
    fundingModel: config.fundingModel,
    contractSpecification: config.contractSpecification,
  };
}

export interface ObjectiveWeights {
  totalReturn: number;
  winRate: number;
  sharpeRatio: number;
  profitFactor: number;
  maxDrawdown: number;
}

export const DEFAULT_WEIGHTS: ObjectiveWeights = {
  totalReturn: 0.35,
  winRate: 0.25,
  sharpeRatio: 0.20,
  profitFactor: 0.10,
  maxDrawdown: 0.10,
};

export interface ScanResultItem {
  combination: Record<string, number>;
  symbol: string;
  metrics: PerformanceMetrics;
  execution?: BacktestResult["execution"];
  modeResults?: BacktestResult["modeResults"];
  legAccounting?: BacktestResult["legAccounting"];
  objectiveValue: number;
  compositeScore: number;
  isParetoOptimal?: boolean;
}

function buildScanArtifactKey(symbol: string, genes: Record<string, number>): string {
  return JSON.stringify([
    symbol,
    Object.entries(genes).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

export interface ScanJobStatus {
  scanId: string;
  status: "pending" | "running" | "completed" | "failed";
  totalCombinations: number;
  completedCombinations: number;
  progress: number;
  /** 當前階段 */
  phase?: "preloading" | "sensitivity" | "evolution" | "refinement" | "validation" | "grid";
  phaseProgress?: number;
  /** 預載進度訊息 */
  preloadMessage?: string;
  /** 當前代數（進化模式） */
  currentGeneration?: number;
  maxGenerations?: number;
  /** 當前最佳績效 */
  currentBest?: { score: number; totalReturn: number; winRate: number };
  /** 進化歷史（每代最佳） */
  fitnessHistory?: Array<{ generation: number; bestScore: number; avgScore: number; paretoSize: number }>;
  results?: ScanSummary;
  error?: string;
  /** 任務開始時間戳 */
  startedAt?: number;
}

export interface ScanSummary {
  best: ScanResultItem | null;
  worst: ScanResultItem | null;
  allResults: ScanResultItem[];
  paretoFront: ScanResultItem[];
  heatmapData: Array<{ param1: number; param2: number; value: number; symbol: string }> | null;
  param1Name: string | null;
  param2Name: string | null;
  bestBySymbol: Record<string, ScanResultItem>;
  sensitivityAnalysis: Record<string, Array<{ value: number; avgScore: number }>>;
  executionTimeMs: number;
  objectiveWeights: ObjectiveWeights;
  /** NSGA-II 專屬結果 */
  evolutionResult?: {
    fitnessHistory: Array<{ generation: number; bestScore: number; avgScore: number; paretoSize: number }>;
    parameterImportance: Array<{ name: string; importance: number; bestValue: number }>;
    totalEvaluations: number;
    walkForwardResult?: WalkForwardResult;
    mode: ScanMode;
  };
}

export interface ScanHistoryItem {
  id: number;
  scanId: string;
  strategyKey: string;
  strategyName: string;
  symbols: string[];
  timeframe: string;
  startTime: number;
  endTime: number;
  initialCapital: number;
  totalCombinations: number;
  completedCombinations: number;
  status: string;
  bestScore?: number;
  bestParams?: Record<string, number>;
  mode?: ScanMode;
  createdAt: Date;
  completedAt?: Date;
}

// ============================================================
// 常量
// ============================================================

const MAX_SCAN_COMBINATIONS = 50000;
const MAX_CONCURRENT_SCANS = 3;
const MAX_CONCURRENT_BACKTESTS = 5;
const MAX_SYMBOLS = 3;
const MAX_QUEUE_SIZE = 8;

// ============================================================
// 工具函數
// ============================================================

/** 計算多目標加權綜合評分 */
function calculateCompositeScore(metrics: PerformanceMetrics, weights: ObjectiveWeights): number {
  const returnScore = Math.max(0, Math.min(1, (metrics.totalReturn + 50) / 150));
  const winRateScore = Math.max(0, Math.min(1, metrics.winRate / 100));
  const sharpeScore = Math.max(0, Math.min(1, (metrics.sharpeRatio + 1) / 4));
  const pfScore = Math.max(0, Math.min(1, (metrics.profitFactor - 0.5) / 3));
  const ddScore = Math.max(0, Math.min(1, 1 - Math.abs(metrics.maxDrawdown) / 50));

  return (
    weights.totalReturn * returnScore +
    weights.winRate * winRateScore +
    weights.sharpeRatio * sharpeScore +
    weights.profitFactor * pfScore +
    weights.maxDrawdown * ddScore
  );
}

/** 計算 Pareto 前沿 */
function computeParetoFront(results: ScanResultItem[]): ScanResultItem[] {
  const front: ScanResultItem[] = [];
  for (const candidate of results) {
    let dominated = false;
    for (const other of results) {
      if (other === candidate) continue;
      if (
        other.metrics.totalReturn >= candidate.metrics.totalReturn &&
        Math.abs(other.metrics.maxDrawdown) <= Math.abs(candidate.metrics.maxDrawdown) &&
        (other.metrics.totalReturn > candidate.metrics.totalReturn ||
          Math.abs(other.metrics.maxDrawdown) < Math.abs(candidate.metrics.maxDrawdown))
      ) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      front.push({ ...candidate, isParetoOptimal: true });
    }
  }
  return front.sort((a, b) => b.metrics.totalReturn - a.metrics.totalReturn);
}

/** 計算參數敏感性分析 */
function computeSensitivityAnalysis(
  results: ScanResultItem[],
  paramNames: string[],
): Record<string, Array<{ value: number; avgScore: number }>> {
  const analysis: Record<string, Array<{ value: number; avgScore: number }>> = {};

  for (const paramName of paramNames) {
    const valueScores = new Map<number, number[]>();
    for (const r of results) {
      const val = r.combination[paramName];
      if (val === undefined) continue;
      const rounded = Math.round(val * 100) / 100;
      if (!valueScores.has(rounded)) valueScores.set(rounded, []);
      valueScores.get(rounded)!.push(r.compositeScore);
    }

    analysis[paramName] = Array.from(valueScores.entries())
      .map(([value, scores]) => ({
        value,
        avgScore: scores.reduce((a: number, b: number) => a + b, 0) / scores.length,
      }))
      .sort((a, b) => a.value - b.value);
  }

  return analysis;
}

/** 從 defaultConfig 自動推導參數空間 */
function deriveParameterSpace(baseConfig: Record<string, unknown>): ParameterSpace[] {
  const space: ParameterSpace[] = [];
  for (const [key, val] of Object.entries(baseConfig)) {
    if (typeof val !== "number") continue;
    if (key.startsWith("__") || key === "leverage") continue;

    const absVal = Math.abs(val);
    let min: number, max: number, step: number;

    if (absVal >= 100) {
      min = Math.max(0, val * 0.5);
      max = val * 2;
      step = Math.max(1, Math.round(absVal * 0.05));
    } else if (absVal >= 10) {
      min = Math.max(0, val * 0.5);
      max = val * 2;
      step = Math.max(0.5, Math.round(absVal * 0.05 * 2) / 2);
    } else if (absVal >= 1) {
      min = Math.max(0, val * 0.3);
      max = val * 3;
      step = Math.max(0.1, Math.round(absVal * 0.1 * 10) / 10);
    } else if (absVal > 0) {
      min = Math.max(0, val * 0.2);
      max = val * 5;
      step = Math.max(0.001, Math.round(absVal * 0.1 * 1000) / 1000);
    } else {
      continue; // skip zero-value params
    }

    space.push({
      name: key,
      min: Math.round(min * 1e6) / 1e6,
      max: Math.round(max * 1e6) / 1e6,
      step: Math.round(step * 1e6) / 1e6,
      type: Number.isInteger(val) && absVal >= 1 ? "discrete" : "continuous",
    });
  }
  return space;
}

// ============================================================
// 掃描任務管理器
// ============================================================

class ScanJobManager {
  private jobs = new Map<string, ScanJobStatus>();
  private jobConfigs = new Map<string, { strategyName?: string; symbols: string[]; timeframe: string; mode: ScanMode; createdAt: number }>();
  private runningScans = 0;
  private queue: Array<{ scanId: string; config: ScanConfig; userId: number; objective: string; weights: ObjectiveWeights; mode: ScanMode }> = [];
  private abortControllers = new Map<string, { abort: () => void }>();

  /** 提交掃描任務（統一入口） */
  async submit(
    config: ScanConfig,
    userId: number,
    objective: string = "compositeScore",
    _sessionToken?: string, // 保留參數簽名向後兼容，但不再使用
  ): Promise<string> {
    const scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mode = config.mode ?? "standard";

    // 驗證
    if (config.symbols.length === 0) throw new Error("至少需要一個交易對");
    if (config.symbols.length > MAX_SYMBOLS) throw new Error(`最多支援 ${MAX_SYMBOLS} 個交易對並行掃描`);

    // 根據模式決定總評估次數
    let totalEvaluations: number;
    if (mode === "manual") {
      const combinations = this.generateCombinations(config.parameters);
      if (combinations.length === 0) throw new Error("未提供有效的掃描參數");
      const totalTasks = combinations.length * config.symbols.length;
      if (totalTasks > MAX_SCAN_COMBINATIONS) {
        throw new Error(`總任務數 ${totalTasks} 超過上限 ${MAX_SCAN_COMBINATIONS}`);
      }
      totalEvaluations = totalTasks;
    } else {
      const evoConfig = SCAN_MODE_CONFIGS[mode as keyof typeof SCAN_MODE_CONFIGS] ?? SCAN_MODE_CONFIGS.standard;
      // 估算：初始種群評估 + 種群大小 × 代數 + 敏感性(10) + 精煉(15) + 驗證(2)
      totalEvaluations = (evoConfig.populationSize + evoConfig.populationSize * evoConfig.maxGenerations + 10 + 15 + 2) * config.symbols.length;
    }

    // 檢查佇列容量
    const pendingCount = this.queue.length;
    if (pendingCount >= MAX_QUEUE_SIZE) {
      throw new Error(`掃描佇列已滿（最多 ${MAX_QUEUE_SIZE} 個排隊任務），請稍後再試`);
    }

    const weights = config.objectiveWeights ?? DEFAULT_WEIGHTS;
    const jobStatus: ScanJobStatus = {
      scanId,
      status: "pending",
      totalCombinations: totalEvaluations,
      completedCombinations: 0,
      progress: 0,
      phase: mode === "manual" ? "grid" : "sensitivity",
    };
    this.jobs.set(scanId, jobStatus);
    this.jobConfigs.set(scanId, {
      strategyName: config.strategyName,
      symbols: config.symbols,
      timeframe: config.timeframe,
      mode,
      createdAt: Date.now(),
    });

    // 記錄到 DB
    await this.saveScanRecord(scanId, config, userId, totalEvaluations, mode);

    // 所有模式統一走佇列 → processQueue → 本地執行
    this.queue.push({ scanId, config, userId, objective, weights, mode });
    void this.processQueue();

    return scanId;
  }

  /** 佇列消費器 */
  private async processQueue(): Promise<void> {
    while (this.runningScans < MAX_CONCURRENT_SCANS && this.queue.length > 0) {
      const task = this.queue.shift()!;
      const job = this.jobs.get(task.scanId);
      if (!job || job.status !== "pending") continue;

      if (task.mode === "manual") {
        void this.executeGridScan(task.scanId, task.config, task.objective, task.userId, task.weights)
          .finally(() => void this.processQueue());
      } else {
        void this.executeEvolutionScan(task.scanId, task.config, task.mode as "fast" | "standard" | "deep", task.userId, task.weights)
          .finally(() => void this.processQueue());
      }
    }
    // 更新排隊位置提示
    this.queue.forEach((task, idx) => {
      const j = this.jobs.get(task.scanId);
      if (j && j.status === "pending") {
        j.preloadMessage = `排隊中（前方還有 ${idx} 個任務）`;
      }
    });
  }

  /** 中止掃描 */
  abort(scanId: string): boolean {
    // 先從佇列中移除（如果還在排隊）
    const queueIdx = this.queue.findIndex(t => t.scanId === scanId);
    if (queueIdx >= 0) {
      this.queue.splice(queueIdx, 1);
      const job = this.jobs.get(scanId);
      if (job) {
        job.status = "failed";
        job.error = "用戶手動中止";
      }
      void this.updateScanRecord(scanId, "failed", 0, null, 0);
      backtestWsService.broadcastError(scanId, "用戶手動中止");
      return true;
    }
    // 已在執行中
    const controller = this.abortControllers.get(scanId);
    if (controller) {
      controller.abort();
      const job = this.jobs.get(scanId);
      if (job) {
        job.status = "failed";
        job.error = "用戶手動中止";
      }
      void this.updateScanRecord(scanId, "failed", 0, null, 0);
      backtestWsService.broadcastError(scanId, "用戶手動中止");
      return true;
    }
    return false;
  }

  /** 獲取掃描狀態 */
  getStatus(scanId: string): ScanJobStatus | null {
    return this.jobs.get(scanId) ?? null;
  }

  /** 從 DB 恢復掃描狀態（當內存中的 job 因實例回收而丟失時） */
  async getStatusFromDB(scanId: string): Promise<ScanJobStatus | null> {
    try {
      const db = await getDb();
      if (!db) return null;
      const rows = await db
        .select()
        .from(scanJobs)
        .where(eq(scanJobs.scanId, scanId))
        .limit(1);
      if (rows.length === 0) return null;
      const r: any = rows[0];

      if (r.status === "completed") {
        return {
          scanId: r.scanId || scanId,
          status: "completed",
          totalCombinations: r.totalCombinations ?? 0,
          completedCombinations: r.completedCombinations ?? r.totalCombinations ?? 0,
          progress: 100,
          phase: "validation",
          results: r.results ?? undefined,
        };
      }

      if (r.status === "failed") {
        return {
          scanId: r.scanId || scanId,
          status: "failed",
          totalCombinations: r.totalCombinations ?? 0,
          completedCombinations: r.completedCombinations ?? 0,
          progress: 0,
          error: "掃描任務失敗",
        };
      }

      // status === "running" — 任務可能正在當前實例上執行
      const createdAt = r.createdAt ? new Date(r.createdAt).getTime() : 0;
      const elapsed = Date.now() - createdAt;
      const MAX_SCAN_DURATION = 45 * 60 * 1000; // 45 minutes max

      if (elapsed > MAX_SCAN_DURATION) {
        return {
          scanId: r.scanId || scanId,
          status: "failed",
          totalCombinations: r.totalCombinations ?? 0,
          completedCombinations: r.completedCombinations ?? 0,
          progress: 0,
          error: "掃描任務超時（超過 45 分鐘），請重新啟動",
        };
      }

      const completedFromDB = r.completedCombinations ?? 0;
      const totalFromDB = r.totalCombinations ?? 1;
      const estimatedProgress = completedFromDB > 0
        ? Math.round((completedFromDB / totalFromDB) * 100)
        : Math.min(80, Math.round((elapsed / MAX_SCAN_DURATION) * 80));

      return {
        scanId: r.scanId || scanId,
        status: "running",
        totalCombinations: totalFromDB,
        completedCombinations: completedFromDB,
        progress: Math.min(99, estimatedProgress),
        phase: "evolution",
        preloadMessage: "任務正在執行中...",
        startedAt: createdAt,
      };
    } catch (e) {
      console.warn("[ScanEngine] getStatusFromDB error:", (e as Error)?.message);
      return null;
    }
  }

  /** 獲取掃描歷史列表 */
  async listHistory(userId: number, limit = 50, offset = 0): Promise<{ items: ScanHistoryItem[]; total: number }> {
    try {
      const db = await getDb();
      if (!db) return { items: [], total: 0 };

      const rows = await db
        .select()
        .from(scanJobs)
        .where(eq(scanJobs.userId, userId))
        .orderBy(desc(scanJobs.createdAt))
        .limit(limit)
        .offset(offset);

      const items: ScanHistoryItem[] = rows.map((r: any) => ({
        id: r.id,
        scanId: r.scanId || `scan_legacy_${r.id}`,
        strategyKey: r.strategyKey,
        strategyName: r.strategyName || r.strategyKey,
        symbols: Array.isArray(r.symbols) ? r.symbols : [r.symbol],
        timeframe: r.timeframe,
        startTime: r.startTime,
        endTime: r.endTime,
        initialCapital: Number(r.initialCapital),
        totalCombinations: r.totalCombinations,
        completedCombinations: r.completedCombinations,
        status: r.status,
        bestScore: r.results?.best?.compositeScore ?? undefined,
        bestParams: r.results?.best?.combination ?? undefined,
        mode: r.baseConfig?.mode ?? "manual",
        createdAt: r.createdAt,
        completedAt: r.completedAt ?? undefined,
      }));

      const total = rows.length < limit ? offset + rows.length : offset + limit + 1;
      return { items, total };
    } catch (e) {
      console.warn("[ScanEngine] listHistory error:", (e as Error)?.message);
      return { items: [], total: 0 };
    }
  }

  /** 獲取掃描詳情 */
  async getDetail(scanId: string | number): Promise<ScanSummary | null> {
    const memJob = typeof scanId === "string"
      ? this.jobs.get(scanId)
      : Array.from(this.jobs.values()).find((j) => j.scanId === String(scanId));
    if (memJob?.results) return memJob.results;

    try {
      const db = await getDb();
      if (!db) return null;

      let row: any;
      if (typeof scanId === "number") {
        const rows = await db.select().from(scanJobs).where(eq(scanJobs.id, scanId)).limit(1);
        row = rows[0];
      } else {
        const rows = await db.select().from(scanJobs).where(eq(scanJobs.scanId as any, scanId)).limit(1);
        row = rows[0];
      }

      if (!row?.results) return null;
      return row.results as ScanSummary;
    } catch (e) {
      console.warn("[ScanEngine] getDetail error:", (e as Error)?.message);
      return null;
    }
  }

  /** 對比多個掃描結果 */
  async compareScans(scanIds: number[]): Promise<Array<{ id: number; summary: Partial<ScanSummary>; config: any }>> {
    try {
      const db = await getDb();
      if (!db) return [];

      const rows = await db.select().from(scanJobs).where(inArray(scanJobs.id, scanIds));
      return rows.map((r: any) => ({
        id: r.id,
        summary: r.results ?? {},
        config: {
          strategyKey: r.strategyKey,
          strategyName: r.strategyName,
          symbols: Array.isArray(r.symbols) ? r.symbols : [r.symbol],
          timeframe: r.timeframe,
          startTime: r.startTime,
          endTime: r.endTime,
          initialCapital: Number(r.initialCapital),
        },
      }));
    } catch (e) {
      console.warn("[ScanEngine] compareScans error:", (e as Error)?.message);
      return [];
    }
  }

  /** 刪除掃描記錄 */
  async deleteHistory(id: number, userId: number): Promise<boolean> {
    try {
      const db = await getDb();
      if (!db) return false;
      await db.delete(scanJobs).where(and(eq(scanJobs.id, id), eq(scanJobs.userId, userId)));
      return true;
    } catch (e) {
      console.warn("[ScanEngine] deleteHistory error:", (e as Error)?.message);
      return false;
    }
  }

  // ============================================================
  // NSGA-II 智能進化掃描
  // ============================================================

  private async executeEvolutionScan(
    scanId: string,
    config: ScanConfig,
    mode: "fast" | "standard" | "deep",
    userId: number,
    weights: ObjectiveWeights,
  ): Promise<void> {
    const job = this.jobs.get(scanId);
    if (!job) return;

    // 等待可用槽位
    await this.waitForSlot();
    this.runningScans++;
    job.status = "running";
    job.startedAt = Date.now();
    const started = Date.now();

    // 設置中止控制
    let aborted = false;
    this.abortControllers.set(scanId, { abort: () => { aborted = true; } });

    // WebSocket 進度推送節流（每 2 秒最多推送一次）
    let lastWsBroadcast = 0;
    const WS_THROTTLE_MS = 2000;
    const broadcastScanProgress = () => {
      const now = Date.now();
      if (now - lastWsBroadcast < WS_THROTTLE_MS) return;
      lastWsBroadcast = now;
      backtestWsService.broadcastProgress(scanId, job.progress, job.status, {
        phase: job.phase,
        phaseProgress: job.phaseProgress,
        preloadMessage: job.preloadMessage,
        currentGeneration: job.currentGeneration,
        maxGenerations: job.maxGenerations,
        currentBest: job.currentBest,
        fitnessHistory: job.fitnessHistory,
        completedCombinations: job.completedCombinations,
        totalCombinations: job.totalCombinations,
      });
    };

    try {
      // 確定參數空間
      let paramSpace: ParameterSpace[];
      if (config.parameterRanges && config.parameterRanges.length > 0) {
        paramSpace = config.parameterRanges.map((p) => ({
          name: p.name,
          min: p.min,
          max: p.max,
          step: p.step,
          type: Number.isInteger(p.min) && Number.isInteger(p.max) && p.step >= 1 ? "discrete" as const : "continuous" as const,
        }));
      } else {
        // 從 baseConfig 自動推導
        paramSpace = deriveParameterSpace(config.baseConfig);
      }

      if (paramSpace.length === 0) {
        throw new Error("無法推導參數空間，請確認策略配置包含數值參數");
      }

      const evoConfig = SCAN_MODE_CONFIGS[mode];
      const allEvaluated: Individual[] = [];
      let evaluationCount = 0;

      // 進度回調
      const updateProgress = (progress: EvolutionProgress) => {
        if (aborted) return;
        job.phase = progress.phase;
        job.phaseProgress = progress.phaseProgress;
        job.currentGeneration = progress.generation;
        job.maxGenerations = progress.maxGenerations;
        job.completedCombinations = progress.evaluatedCount;
        job.progress = Math.round((progress.evaluatedCount / job.totalCombinations) * 100);
        if (progress.bestObjectives.totalReturn > -Infinity) {
          job.currentBest = {
            score: nsgaEngine.compositeScore(progress.bestObjectives),
            totalReturn: progress.bestObjectives.totalReturn,
            winRate: progress.bestObjectives.winRate,
          };
        }
        job.fitnessHistory = progress.generation > 0 ? [...(job.fitnessHistory ?? [])] : job.fitnessHistory;
      };

      const nsgaEngine = new NSGAII(paramSpace, evoConfig, updateProgress);

      // ========== 數據預載（避免並發競爭） ==========
      const dataExchange: "okx" | "bybit" = config.exchange ?? "okx";
      job.phase = "preloading";
      job.phaseProgress = 0;
      job.preloadMessage = `正在從 ${dataExchange === "okx" ? "OKX" : "Bybit"} 下載 K 線數據...`;
      broadcastScanProgress();
      console.log(`[ScanEngine] ${scanId} 預載 K 線數據（使用 ${dataExchange}）...`);
      for (let si = 0; si < config.symbols.length; si++) {
        const symbol = config.symbols[si];
        if (aborted) break;
        try {
          const startMs = config.startDate < 1e12 ? config.startDate * 1000 : config.startDate;
          const endMs = config.endDate < 1e12 ? config.endDate * 1000 : config.endDate;
          const expectedCandles = Math.floor((endMs - startMs) / getTimeframeMilliseconds(config.timeframe));
          job.preloadMessage = `下載 ${symbol} K 線數據 (${si + 1}/${config.symbols.length})... 預計 ${expectedCandles.toLocaleString()} 根`;
          job.phaseProgress = Math.round((si / config.symbols.length) * 100);
          broadcastScanProgress();
          await ensureOHLCVData(symbol, config.timeframe, startMs, endMs, dataExchange);
          console.log(`[ScanEngine] ${scanId} 數據預載完成: ${symbol} (約 ${expectedCandles} 根 K 線)`);
          job.phaseProgress = Math.round(((si + 1) / config.symbols.length) * 100);
          broadcastScanProgress();
        } catch (e) {
          console.error(`[ScanEngine] ${scanId} 數據預載失敗: ${symbol} - ${(e as Error).message}`);
          throw new Error(`無法獲取 ${symbol} 的 K 線數據: ${(e as Error).message}`);
        }
      }
      job.preloadMessage = "數據預載完成，開始優化...";
      broadcastScanProgress();

      // finalized artifact 不附著在會被交叉／變異的 Individual 上，避免父代結果被誤配給子代。
      const finalizedArtifacts = new Map<
        string,
        Pick<ScanResultItem, "execution" | "modeResults" | "legAccounting">
      >();

      // 評估函數：執行回測並返回目標值
      const evaluate = async (individual: Individual, symbol: string): Promise<Individual> => {
        if (aborted) return individual;
        try {
          const req: BacktestRequest = {
            strategyKey: config.strategyKey,
            symbol,
            timeframe: config.timeframe,
            startDate: config.startDate,
            endDate: config.endDate,
            initialCapital: config.initialCapital,
            config: { ...config.baseConfig, ...individual.genes },
            commission: config.commission,
            slippage: config.slippage,
            exchange: dataExchange,
            ...buildScanBacktestExecutionContext(config),
          };
          const result = await backtestEngine.runBacktest(req);
          individual.objectives = {
            totalReturn: result.metrics.totalReturn,
            winRate: result.metrics.winRate,
            sharpeRatio: result.metrics.sharpeRatio,
            profitFactor: result.metrics.profitFactor,
            maxDrawdown: Math.abs(result.metrics.maxDrawdown),
          };
          individual.metrics = result.metrics;
          individual.symbol = symbol;
          finalizedArtifacts.set(buildScanArtifactKey(symbol, individual.genes), {
            execution: result.execution,
            modeResults: result.modeResults,
            legAccounting: result.legAccounting,
          });
          evaluationCount++;
        } catch (e) {
          console.warn(`[ScanEngine] 評估失敗: ${(e as Error).message}`);
          individual.objectives = { totalReturn: -100, winRate: 0, sharpeRatio: -5, profitFactor: 0, maxDrawdown: 100 };
        }
        return individual;
      };

      // 批量評估（控制並發）
      let lastDBSync = 0;
      const DB_SYNC_INTERVAL = 10000; // 每 10 秒同步一次 DB
      const batchEvaluate = async (individuals: Individual[], symbol: string): Promise<Individual[]> => {
        const results: Individual[] = [];
        for (let i = 0; i < individuals.length; i += MAX_CONCURRENT_BACKTESTS) {
          if (aborted) break;
          const batch = individuals.slice(i, i + MAX_CONCURRENT_BACKTESTS);
          const evaluated = await Promise.all(batch.map((ind) => evaluate(ind, symbol)));
          results.push(...evaluated);
          job.completedCombinations = evaluationCount;
          job.progress = Math.min(99, Math.round((evaluationCount / job.totalCombinations) * 100));
          broadcastScanProgress();
          // 定期同步進度到 DB
          const now = Date.now();
          if (now - lastDBSync > DB_SYNC_INTERVAL) {
            lastDBSync = now;
            void this.syncProgressToDB(scanId, evaluationCount);
          }
        }
        return results;
      };

      // ========== Phase 1: 敏感性分析（隨機抽樣 10 個點） ==========
      job.phase = "sensitivity";
      job.phaseProgress = 0;
      broadcastScanProgress();
      console.log(`[ScanEngine] ${scanId} Phase 1: 敏感性分析開始 (${paramSpace.length} 參數)`);

      const sensitivityPop = nsgaEngine.initializePopulation().slice(0, 10);
      for (const symbol of config.symbols) {
        if (aborted) break;
        const evaluated = await batchEvaluate(sensitivityPop, symbol);
        allEvaluated.push(...evaluated);
      }
      job.phaseProgress = 100;
      broadcastScanProgress();

      // ========== Phase 2: 進化搜索 ==========
      if (!aborted) {
        job.phase = "evolution";
        job.phaseProgress = 0;
        broadcastScanProgress();
        console.log(`[ScanEngine] ${scanId} Phase 2: NSGA-II 進化搜索 (${evoConfig.maxGenerations} 代)`);

        let population = nsgaEngine.initializePopulation();

        // 初始種群評估
        for (const symbol of config.symbols) {
          if (aborted) break;
          population = await batchEvaluate(population, symbol);
          allEvaluated.push(...population.filter((p) => p.metrics));
        }

        // 進化循環
        const fitnessHistory: Array<{ generation: number; bestScore: number; avgScore: number; paretoSize: number }> = [];

        for (let gen = 0; gen < evoConfig.maxGenerations; gen++) {
          if (aborted) break;

          // 非支配排序
          const fronts = nsgaEngine.nonDominatedSort(population);
          for (const front of fronts) {
            nsgaEngine.calculateCrowdingDistance(front);
          }

          // 記錄進化歷史
          const scores = population
            .filter((p) => p.metrics)
            .map((p) => nsgaEngine.compositeScore(p.objectives));
          const bestScore = scores.length > 0 ? Math.max(...scores) : 0;
          const avgScore = scores.length > 0 ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length : 0;
          fitnessHistory.push({
            generation: gen,
            bestScore,
            avgScore,
            paretoSize: fronts[0]?.length ?? 0,
          });

          job.currentGeneration = gen;
          job.maxGenerations = evoConfig.maxGenerations;
          job.phaseProgress = Math.round((gen / evoConfig.maxGenerations) * 100);
          job.fitnessHistory = fitnessHistory;
          if (scores.length > 0) {
            const bestInd = population.reduce((best, curr) =>
              nsgaEngine.compositeScore(curr.objectives) > nsgaEngine.compositeScore(best.objectives) ? curr : best,
            );
            job.currentBest = {
              score: bestScore,
              totalReturn: bestInd.objectives.totalReturn,
              winRate: bestInd.objectives.winRate,
            };
          }
          broadcastScanProgress();

          // 生成子代
          const offspring: Individual[] = [];
          while (offspring.length < evoConfig.populationSize) {
            const p1 = nsgaEngine.tournamentSelect(population);
            const p2 = nsgaEngine.tournamentSelect(population);
            const [c1, c2] = nsgaEngine.crossover(p1, p2);
            offspring.push(nsgaEngine.mutate(c1));
            if (offspring.length < evoConfig.populationSize) {
              offspring.push(nsgaEngine.mutate(c2));
            }
          }

          // 評估子代（只用第一個交易對做進化，節省時間）
          const primarySymbol = config.symbols[0];
          const evaluatedOffspring = await batchEvaluate(offspring, primarySymbol);
          allEvaluated.push(...evaluatedOffspring.filter((p) => p.metrics));

          // 合併父代+子代，選擇下一代
          const combined = [...population, ...evaluatedOffspring];
          const combinedFronts = nsgaEngine.nonDominatedSort(combined);
          const nextPop: Individual[] = [];
          for (const front of combinedFronts) {
            if (nextPop.length + front.length <= evoConfig.populationSize) {
              nsgaEngine.calculateCrowdingDistance(front);
              nextPop.push(...front);
            } else {
              nsgaEngine.calculateCrowdingDistance(front);
              front.sort((a, b) => b.crowdingDistance - a.crowdingDistance);
              nextPop.push(...front.slice(0, evoConfig.populationSize - nextPop.length));
              break;
            }
          }
          population = nextPop.length > 0 ? nextPop : population;

          // 收斂檢查（連續 3 代無改善）
          if (gen > 3 && gen % 3 === 0 && fitnessHistory.length >= 4) {
            const recent = fitnessHistory.slice(-3);
            const improvement = recent[recent.length - 1].bestScore - recent[0].bestScore;
            if (improvement < 0.001) {
              console.log(`[ScanEngine] ${scanId} 進化收斂於第 ${gen} 代`);
              break;
            }
          }
        }

        job.fitnessHistory = fitnessHistory;
      }

      // ========== Phase 3: 差分進化精煉 ==========
      if (!aborted) {
        job.phase = "refinement";
        job.phaseProgress = 0;
        broadcastScanProgress();
        console.log(`[ScanEngine] ${scanId} Phase 3: DE 精煉`);

        // 取 Pareto 前沿做精煉
        const topIndividuals = allEvaluated
          .filter((p) => p.metrics)
          .sort((a, b) => nsgaEngine.compositeScore(b.objectives) - nsgaEngine.compositeScore(a.objectives))
          .slice(0, 20);

        if (topIndividuals.length >= 4) {
          const refined = nsgaEngine.differentialEvolutionRefine(topIndividuals, 10);
          const newCandidates = refined.filter((r) => !r.metrics);
          if (newCandidates.length > 0) {
            const primarySymbol = config.symbols[0];
            const evaluatedRefined = await batchEvaluate(newCandidates.slice(0, 15), primarySymbol);
            allEvaluated.push(...evaluatedRefined.filter((p) => p.metrics));
          }
        }
        job.phaseProgress = 100;
        broadcastScanProgress();
      }

      // ========== Phase 4: Walk-Forward 驗證 ==========
      let walkForwardResult: WalkForwardResult | undefined;
      if (!aborted && config.walkForward !== false) {
        job.phase = "validation";
        job.phaseProgress = 0;
        broadcastScanProgress();
        console.log(`[ScanEngine] ${scanId} Phase 4: Walk-Forward 驗證`);

        const bestIndividual = allEvaluated
          .filter((p) => p.metrics)
          .sort((a, b) => nsgaEngine.compositeScore(b.objectives) - nsgaEngine.compositeScore(a.objectives))[0];

        if (bestIndividual) {
          const split = calculateWalkForwardSplit(config.startDate, config.endDate, 0.7);
          const primarySymbol = config.symbols[0];

          try {
            const trainReq: BacktestRequest = {
              strategyKey: config.strategyKey,
              symbol: primarySymbol,
              timeframe: config.timeframe,
              startDate: split.trainStart,
              endDate: split.trainEnd,
              initialCapital: config.initialCapital,
              config: { ...config.baseConfig, ...bestIndividual.genes },
              commission: config.commission,
              slippage: config.slippage,
              exchange: dataExchange,
              ...buildScanBacktestExecutionContext(config),
            };
            const trainResult = await backtestEngine.runBacktest(trainReq);

            const testReq: BacktestRequest = {
              ...trainReq,
              startDate: split.testStart,
              endDate: split.testEnd,
            };
            const testResult = await backtestEngine.runBacktest(testReq);

            const { robustnessScore, overfitIndex } = calculateRobustnessScore(
              trainResult.metrics,
              testResult.metrics,
            );

            walkForwardResult = {
              inSampleMetrics: trainResult.metrics,
              outOfSampleMetrics: testResult.metrics,
              robustnessScore,
              overfitIndex,
              splitRatio: 0.7,
            };
            evaluationCount += 2;
          } catch (e) {
            console.warn(`[ScanEngine] Walk-Forward 驗證失敗:`, (e as Error)?.message);
          }
        }
        job.phaseProgress = 100;
        broadcastScanProgress();
      }

      // ========== 彙整結果 ==========
      const validResults = allEvaluated.filter((p) => p.metrics);
      const scanResults: ScanResultItem[] = validResults.map((ind) => ({
        combination: ind.genes,
        symbol: ind.symbol ?? config.symbols[0],
        metrics: ind.metrics!,
        ...finalizedArtifacts.get(buildScanArtifactKey(ind.symbol ?? config.symbols[0], ind.genes)),
        objectiveValue: ind.objectives.totalReturn,
        compositeScore: nsgaEngine.compositeScore(ind.objectives),
      }));

      scanResults.sort((a, b) => b.compositeScore - a.compositeScore);

      // Pareto 前沿
      const paretoFront = computeParetoFront(scanResults);
      const paretoSet = new Set(paretoFront.map((p) => JSON.stringify(p.combination) + p.symbol));
      for (const r of scanResults) {
        r.isParetoOptimal = paretoSet.has(JSON.stringify(r.combination) + r.symbol);
      }

      // 熱力圖（取最重要的 2 個參數）
      const paramImportance = nsgaEngine.calculateParameterImportance(validResults);
      let heatmapData: Array<{ param1: number; param2: number; value: number; symbol: string }> | null = null;
      let param1Name: string | null = null;
      let param2Name: string | null = null;
      if (paramImportance.length >= 2) {
        param1Name = paramImportance[0].name;
        param2Name = paramImportance[1].name;
        heatmapData = scanResults.slice(0, 200).map((r) => ({
          param1: r.combination[param1Name!] ?? 0,
          param2: r.combination[param2Name!] ?? 0,
          value: r.compositeScore,
          symbol: r.symbol,
        }));
      }

      // 按交易對分組最佳
      const bestBySymbol: Record<string, ScanResultItem> = {};
      for (const symbol of config.symbols) {
        const symbolResults = scanResults.filter((r) => r.symbol === symbol);
        if (symbolResults.length > 0) bestBySymbol[symbol] = symbolResults[0];
      }

      // 敏感性分析
      const sensitivityAnalysis = computeSensitivityAnalysis(scanResults, paramSpace.map((p) => p.name));

      const summary: ScanSummary = {
        best: scanResults[0] ?? null,
        worst: scanResults[scanResults.length - 1] ?? null,
        allResults: scanResults.slice(0, 100), // 限制存儲量
        paretoFront,
        heatmapData,
        param1Name,
        param2Name,
        bestBySymbol,
        sensitivityAnalysis,
        executionTimeMs: Date.now() - started,
        objectiveWeights: weights,
        evolutionResult: {
          fitnessHistory: job.fitnessHistory ?? [],
          parameterImportance: paramImportance,
          totalEvaluations: evaluationCount,
          walkForwardResult,
          mode,
        },
      };

      job.status = "completed";
      job.progress = 100;
      job.results = summary;

      await this.updateScanRecord(scanId, "completed", evaluationCount, summary, userId);
      console.log(`[ScanEngine] ${scanId} 完成: ${evaluationCount} 次評估, 耗時 ${Date.now() - started}ms`);

      // WebSocket 推送完成
      backtestWsService.broadcastComplete(scanId, {
        status: "completed",
        summary: {
          bestReturn: summary.best?.metrics.totalReturn,
          bestWinRate: summary.best?.metrics.winRate,
          bestScore: summary.best?.compositeScore,
          totalEvaluations: evaluationCount,
          executionTimeMs: summary.executionTimeMs,
        },
      });

      // Telegram 通知
      void this.sendCompletionNotification(scanId, config, summary, Date.now() - started);
    } catch (e) {
      job.status = "failed";
      job.error = e instanceof Error ? e.message : String(e);
      await this.updateScanRecord(scanId, "failed", job.completedCombinations, null, userId);
      console.error(`[ScanEngine] ${scanId} 失敗:`, e);

      // WebSocket 推送錯誤
      backtestWsService.broadcastError(scanId, job.error);

      // Telegram 失敗通知
      void this.sendFailureNotification(scanId, config, job.error);
    } finally {
      this.runningScans--;
      this.abortControllers.delete(scanId);
    }
  }

  // ============================================================
  // 手動模式（網格搜索，向後兼容）
  // ============================================================

  private async executeGridScan(
    scanId: string,
    config: ScanConfig,
    objective: string,
    userId: number,
    weights: ObjectiveWeights,
  ): Promise<void> {
    const job = this.jobs.get(scanId);
    if (!job) return;

    await this.waitForSlot();
    this.runningScans++;
    job.status = "running";
    job.startedAt = Date.now();
    job.phase = "preloading";
    job.phaseProgress = 0;
    job.preloadMessage = "正在下載 K 線數據...";
    const started = Date.now();

    // 設置中止控制
    let aborted = false;
    this.abortControllers.set(scanId, { abort: () => { aborted = true; } });

    // WebSocket 進度推送節流
    let lastWsBroadcast = 0;
    const WS_THROTTLE_MS = 2000;
    const broadcastScanProgress = () => {
      const now = Date.now();
      if (now - lastWsBroadcast < WS_THROTTLE_MS) return;
      lastWsBroadcast = now;
      backtestWsService.broadcastProgress(scanId, job.progress, job.status, {
        phase: job.phase,
        phaseProgress: job.phaseProgress,
        preloadMessage: job.preloadMessage,
        completedCombinations: job.completedCombinations,
        totalCombinations: job.totalCombinations,
      });
    };

    broadcastScanProgress();

    try {
      // 數據預載
      console.log(`[ScanEngine] ${scanId} 網格掃描預載數據...`);
      for (let si = 0; si < config.symbols.length; si++) {
        const symbol = config.symbols[si];
        if (aborted) break;
        try {
          const startMs = config.startDate < 1e12 ? config.startDate * 1000 : config.startDate;
          const endMs = config.endDate < 1e12 ? config.endDate * 1000 : config.endDate;
          const expectedCandles = Math.floor((endMs - startMs) / getTimeframeMilliseconds(config.timeframe));
          job.preloadMessage = `下載 ${symbol} K 線數據 (${si + 1}/${config.symbols.length})... 預計 ${expectedCandles.toLocaleString()} 根`;
          job.phaseProgress = Math.round((si / config.symbols.length) * 100);
          broadcastScanProgress();
          await ensureOHLCVData(symbol, config.timeframe, startMs, endMs, config.exchange ?? "okx");
          console.log(`[ScanEngine] ${scanId} 數據預載完成: ${symbol} (使用 ${config.exchange ?? "okx"})`);
          job.phaseProgress = Math.round(((si + 1) / config.symbols.length) * 100);
          broadcastScanProgress();
        } catch (e) {
          throw new Error(`無法獲取 ${symbol} 的 K 線數據: ${(e as Error).message}`);
        }
      }
      job.preloadMessage = "數據預載完成，開始網格掃描...";
      job.phase = "grid";
      broadcastScanProgress();

      const combinations = this.generateCombinations(config.parameters);
      const results: ScanResultItem[] = [];

      const symbolPromises = config.symbols.map(async (symbol) => {
        const symbolResults: ScanResultItem[] = [];
        for (let i = 0; i < combinations.length; i += MAX_CONCURRENT_BACKTESTS) {
          if (aborted) break;
          const batch = combinations.slice(i, i + MAX_CONCURRENT_BACKTESTS);
          const batchResults = await Promise.allSettled(
            batch.map(async (params) => {
              const req: BacktestRequest = {
                strategyKey: config.strategyKey,
                symbol,
                timeframe: config.timeframe,
                startDate: config.startDate,
                endDate: config.endDate,
                initialCapital: config.initialCapital,
                config: { ...config.baseConfig, ...params },
                commission: config.commission,
                slippage: config.slippage,
                exchange: config.exchange ?? "okx" as const,
                ...buildScanBacktestExecutionContext(config),
              };
              const result = await backtestEngine.runBacktest(req);
              return {
                params,
                metrics: result.metrics,
                execution: result.execution,
                modeResults: result.modeResults,
                legAccounting: result.legAccounting,
              };
            }),
          );

          for (const br of batchResults) {
            job.completedCombinations++;
            if (br.status === "fulfilled") {
              const objKey = objective as keyof PerformanceMetrics;
              const objectiveValue = Number(br.value.metrics[objKey]) || 0;
              const compositeScore = calculateCompositeScore(br.value.metrics, weights);
              symbolResults.push({
                combination: br.value.params,
                symbol,
                metrics: br.value.metrics,
                execution: br.value.execution,
                modeResults: br.value.modeResults,
                legAccounting: br.value.legAccounting,
                objectiveValue: Number.isFinite(objectiveValue) ? objectiveValue : -Infinity,
                compositeScore,
              });
            }
          }
          job.progress = Math.round((job.completedCombinations / job.totalCombinations) * 100);
          broadcastScanProgress();
        }
        return symbolResults;
      });

      const allSymbolResults = await Promise.all(symbolPromises);
      for (const sr of allSymbolResults) results.push(...sr);

      results.sort((a, b) => b.compositeScore - a.compositeScore);

      const paretoFront = computeParetoFront(results);
      const paretoSet = new Set(paretoFront.map((p) => JSON.stringify(p.combination) + p.symbol));
      for (const r of results) {
        r.isParetoOptimal = paretoSet.has(JSON.stringify(r.combination) + r.symbol);
      }

      let heatmapData: Array<{ param1: number; param2: number; value: number; symbol: string }> | null = null;
      let param1Name: string | null = null;
      let param2Name: string | null = null;
      if (config.parameters.length >= 2) {
        param1Name = config.parameters[0].name;
        param2Name = config.parameters[1].name;
        heatmapData = results.map((r) => ({
          param1: r.combination[param1Name!],
          param2: r.combination[param2Name!],
          value: r.compositeScore,
          symbol: r.symbol,
        }));
      }

      const bestBySymbol: Record<string, ScanResultItem> = {};
      for (const symbol of config.symbols) {
        const symbolResults = results.filter((r) => r.symbol === symbol);
        if (symbolResults.length > 0) bestBySymbol[symbol] = symbolResults[0];
      }

      const sensitivityAnalysis = computeSensitivityAnalysis(results, config.parameters.map((p) => p.name));

      const summary: ScanSummary = {
        best: results[0] ?? null,
        worst: results[results.length - 1] ?? null,
        allResults: results,
        paretoFront,
        heatmapData,
        param1Name,
        param2Name,
        bestBySymbol,
        sensitivityAnalysis,
        executionTimeMs: Date.now() - started,
        objectiveWeights: weights,
      };

      job.status = "completed";
      job.progress = 100;
      job.results = summary;

      await this.updateScanRecord(scanId, "completed", job.completedCombinations, summary, userId);

      // WebSocket 推送完成
      backtestWsService.broadcastComplete(scanId, {
        status: "completed",
        summary: {
          bestReturn: summary.best?.metrics.totalReturn,
          bestWinRate: summary.best?.metrics.winRate,
          bestScore: summary.best?.compositeScore,
          totalEvaluations: job.completedCombinations,
          executionTimeMs: summary.executionTimeMs,
        },
      });

      void this.sendCompletionNotification(scanId, config, summary, Date.now() - started);
    } catch (e) {
      job.status = "failed";
      job.error = e instanceof Error ? e.message : String(e);
      await this.updateScanRecord(scanId, "failed", job.completedCombinations, null, userId);

      // WebSocket 推送錯誤
      backtestWsService.broadcastError(scanId, job.error);

      void this.sendFailureNotification(scanId, config, job.error);
    } finally {
      this.runningScans--;
      this.abortControllers.delete(scanId);
    }
  }

  // ============================================================
  // Telegram 通知
  // ============================================================

  private async sendCompletionNotification(scanId: string, config: ScanConfig, summary: ScanSummary, durationMs: number): Promise<void> {
    try {
      const best = summary.best;
      const durationMin = Math.round(durationMs / 60000);
      const returnPct = best ? `${best.metrics.totalReturn.toFixed(2)}%` : "N/A";
      const winRate = best ? `${best.metrics.winRate.toFixed(1)}%` : "N/A";
      const params = best ? Object.entries(best.combination).map(([k, v]) => `${k}=${v}`).join(", ") : "N/A";

      await telegramNotifier.send({
        strategyName: config.strategyName || config.strategyKey,
        symbol: config.symbols.join(", "),
        type: "success",
        message: [
          `✅ 參數掃描完成`,
          ``,
          `📊 策略: ${config.strategyName || config.strategyKey}`,
          `💱 交易對: ${config.symbols.join(", ")}`,
          `⏱ 耗時: ${durationMin} 分鐘`,
          `🏆 最佳結果:`,
          `   總回報: ${returnPct}`,
          `   勝率: ${winRate}`,
          `   參數: ${params}`,
          summary.evolutionResult?.walkForwardResult
            ? `   穩健性: ${(summary.evolutionResult.walkForwardResult.robustnessScore * 100).toFixed(0)}%`
            : "",
          ``,
          `🔗 請前往參數掃描頁面查看完整結果`,
        ].filter(Boolean).join("\n"),
      });
    } catch (e) {
      console.warn("[ScanEngine] Telegram 通知發送失敗:", (e as Error)?.message);
    }
  }

  private async sendFailureNotification(scanId: string, config: ScanConfig, error: string): Promise<void> {
    try {
      await telegramNotifier.send({
        strategyName: config.strategyName || config.strategyKey,
        symbol: config.symbols.join(", "),
        type: "error",
        message: [
          `❌ 參數掃描失敗`,
          ``,
          `📊 策略: ${config.strategyName || config.strategyKey}`,
          `💱 交易對: ${config.symbols.join(", ")}`,
          `❌ 錯誤: ${error}`,
          ``,
          `請檢查配置後重試`,
        ].join("\n"),
      });
    } catch (e) {
      console.warn("[ScanEngine] Telegram 通知發送失敗:", (e as Error)?.message);
    }
  }

  // ============================================================
  // 佇列狀態查詢
  // ============================================================

  /** 獲取佇列狀態統計 */
  getQueueStatus() {
    const jobs = Array.from(this.jobs.values());
    return {
      total: jobs.length,
      queued: this.queue.length,
      running: jobs.filter(j => j.status === "running").length,
      completed: jobs.filter(j => j.status === "completed").length,
      failed: jobs.filter(j => j.status === "failed").length,
      maxConcurrent: MAX_CONCURRENT_SCANS,
      maxQueue: MAX_QUEUE_SIZE,
    };
  }

  /** 獲取所有活躍任務（running + pending） */
  async getActiveJobs(): Promise<Array<{
    scanId: string; status: string; phase?: string; progress: number;
    preloadMessage?: string; strategyName?: string; symbols?: string[];
    timeframe?: string; mode?: string; createdAt?: number;
    totalCombinations?: number; completedCombinations?: number;
    currentGeneration?: number; maxGenerations?: number;
  }>> {
    const active: Array<any> = [];
    const seenIds = new Set<string>();

    // In-memory jobs（最精確的實時狀態）
    const allJobs = Array.from(this.jobs.values());
    for (const job of allJobs) {
      if (job.status === "running" || job.status === "pending") {
        const cfg = this.jobConfigs.get(job.scanId);
        active.push({
          scanId: job.scanId,
          status: job.status,
          phase: job.phase,
          progress: job.progress,
          preloadMessage: job.preloadMessage,
          strategyName: cfg?.strategyName,
          symbols: cfg?.symbols,
          timeframe: cfg?.timeframe,
          mode: cfg?.mode,
          createdAt: cfg?.createdAt,
          totalCombinations: job.totalCombinations,
          completedCombinations: job.completedCombinations,
          currentGeneration: job.currentGeneration,
          maxGenerations: job.maxGenerations,
        });
        seenIds.add(job.scanId);
      }
    }

    // DB fallback — 查詢 status="running" 的記錄（可能在伺服器重啟前遺留）
    try {
      const db = await getDb();
      if (db) {
        const MAX_SCAN_DURATION = 45 * 60 * 1000;
        const dbRows = await db
          .select()
          .from(scanJobs)
          .where(eq(scanJobs.status, "running"))
          .limit(10);
        for (const r of dbRows) {
          const sid = r.scanId || "";
          if (!sid || seenIds.has(sid)) continue;
          const createdAt = r.createdAt ? new Date(r.createdAt).getTime() : 0;
          const elapsed = Date.now() - createdAt;
          if (elapsed > MAX_SCAN_DURATION) continue; // 超時的不顯示
          const completedFromDB = r.completedCombinations ?? 0;
          const totalFromDB = r.totalCombinations ?? 1;
          const estimatedProgress = completedFromDB > 0
            ? Math.round((completedFromDB / totalFromDB) * 100)
            : Math.min(80, Math.round((elapsed / MAX_SCAN_DURATION) * 80));
          const baseConfig = (r.baseConfig as any) || {};
          active.push({
            scanId: sid,
            status: "running",
            phase: "evolution",
            progress: Math.min(99, estimatedProgress),
            preloadMessage: "任務正在執行中...",
            strategyName: r.strategyName || r.strategyKey,
            symbols: (r as any).symbols || [r.symbol],
            timeframe: r.timeframe,
            mode: baseConfig.mode || "fast",
            createdAt,
            totalCombinations: totalFromDB,
            completedCombinations: completedFromDB,
          });
          seenIds.add(sid);
        }
      }
    } catch (e) {
      console.warn("[ScanEngine] getActiveJobs DB fallback error:", (e as Error)?.message);
    }

    return active;
  }

  /** 獲取進行中的任務數（用於側邊欄 badge） */
  async getActiveCount(): Promise<number> {
    let count = 0;
    const allJobs = Array.from(this.jobs.values());
    const memoryIds = new Set<string>();
    for (const job of allJobs) {
      if (job.status === "running" || job.status === "pending") {
        count++;
        memoryIds.add(job.scanId);
      }
    }

    // DB fallback count（只計算未超時的 running 任務）
    try {
      const db = await getDb();
      if (db) {
        const MAX_SCAN_DURATION = 45 * 60 * 1000;
        const dbRows = await db
          .select({ scanId: scanJobs.scanId, createdAt: scanJobs.createdAt })
          .from(scanJobs)
          .where(eq(scanJobs.status, "running"))
          .limit(10);
        for (const r of dbRows) {
          const sid = r.scanId || "";
          if (!sid || memoryIds.has(sid)) continue;
          const createdAt = r.createdAt ? new Date(r.createdAt).getTime() : 0;
          if (Date.now() - createdAt > MAX_SCAN_DURATION) continue;
          count++;
        }
      }
    } catch {
      // 靜默失敗
    }

    return count;
  }

  // ============================================================
  // 輔助方法
  // ============================================================

  private generateCombinations(params: ScanParameterDef[]): Array<Record<string, number>> {
    if (params.length === 0) return [];
    let combos: Array<Record<string, number>> = [{}];
    for (const param of params) {
      const next: Array<Record<string, number>> = [];
      for (const combo of combos) {
        for (const val of param.values) {
          next.push({ ...combo, [param.name]: val });
        }
      }
      combos = next;
    }
    return combos;
  }

  private async waitForSlot(): Promise<void> {
    if (this.runningScans >= MAX_CONCURRENT_SCANS) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.runningScans < MAX_CONCURRENT_SCANS) {
            clearInterval(check);
            resolve();
          }
        }, 2000);
      });
    }
  }

  private async saveScanRecord(scanId: string, config: ScanConfig, userId: number, total: number, mode: ScanMode): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;
      await db.insert(scanJobs).values({
        userId,
        strategyKey: config.strategyKey,
        strategyName: config.strategyName || config.strategyKey,
        symbol: config.symbols[0] || "",
        timeframe: config.timeframe,
        startTime: config.startDate,
        endTime: config.endDate,
        initialCapital: String(config.initialCapital),
        baseConfig: { ...config.baseConfig, symbols: config.symbols, mode },
        scanParams: config.parameters.length > 0 ? config.parameters : (config.parameterRanges ?? []),
        totalCombinations: total,
        completedCombinations: 0,
        status: "running",
        scanId,
      } as any);
    } catch (e) {
      console.warn("[ScanEngine] 保存掃描記錄失敗:", (e as Error)?.message);
    }
  }

  private async updateScanRecord(
    scanId: string,
    status: string,
    completed: number,
    results: ScanSummary | null,
    _userId: number,
  ): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;
      const updateData: any = {
        status,
        completedCombinations: completed,
      };
      if (results) {
        updateData.results = results;
      }
      if (status === "completed" || status === "failed") {
        updateData.completedAt = new Date();
      }
      await db
        .update(scanJobs)
        .set(updateData)
        .where(eq(scanJobs.scanId, scanId));
    } catch (e) {
      console.warn("[ScanEngine] 更新掃描記錄失敗:", (e as Error)?.message);
    }
  }

  /** 定期更新 DB 中的進度 */
  private async syncProgressToDB(scanId: string, completed: number): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;
      await db
        .update(scanJobs)
        .set({ completedCombinations: completed })
        .where(eq(scanJobs.scanId, scanId));
    } catch {
      // 靜默失敗，不影響主流程
    }
  }
}

export const scanJobManager = new ScanJobManager();
