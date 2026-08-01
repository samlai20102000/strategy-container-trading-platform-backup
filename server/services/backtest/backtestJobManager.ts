/**
 * 回測異步任務管理器（V5.0 重構版）
 *
 * 核心升級：
 * 1. 結果持久化到主資料庫（TiDB/MySQL）— 永久保留
 * 2. 最大並行 3 個回測任務
 * 3. 佇列深度 5 個（超出拒絕）
 * 4. 離開頁面不影響回測進行
 * 5. 進度即時寫入 DB，前端隨時可查
 * 6. 伺服器重啟後自動標記 stale running jobs
 */

import { backtestEngine, type BacktestRequest, type BacktestResult } from "./backtestEngine";
import { backtestWsService } from "../wsService";
import { getDb } from "../../db";
import { backtestJobs } from "../../../drizzle/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { normalizeExecutionModePolicy } from "../../../shared/executionModes";
import type { BacktestRunnerIdentity } from "./backtestContracts";
import {
  classifyBacktestFailure,
  preflightBacktestRunner,
  type BacktestFailureMetadata,
} from "./backtestRunnerPreflight";

export interface BacktestJobState {
  jobId: string;
  status: "pending" | "running" | "completed" | "failed" | "timeout" | "cancelled";
  progress: number; // 0-100
  message: string;
  request: BacktestRequest;
  result?: BacktestResult;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  timeoutSeconds: number;
  userId: number;
  strategyName?: string;
  runner?: BacktestRunnerIdentity;
  failure?: BacktestFailureMetadata;
}

const MAX_CONCURRENT_JOBS = 3;
const MAX_QUEUE_SIZE = 5;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 分鐘
const MAX_RETRIES = 1;
const PROGRESS_DB_INTERVAL = 5000; // 每 5 秒寫一次進度到 DB

export function buildBacktestResultPersistence(
  result: BacktestResult,
  request: BacktestRequest,
  startedAt?: number,
  completedAt = new Date(),
) {
  const policy = normalizeExecutionModePolicy(
    result.execution?.executionPolicy
      ?? request.executionPolicy
      ?? { mode: request.executionMode ?? "SINGLE_EXCLUSIVE" },
  );
  return {
    status: "completed" as const,
    progress: 100,
    message: result.summary,
    metrics: result.metrics,
    tradesData: result.trades,
    equityCurve: result.equityCurve,
    summary: result.summary,
    endPositionPolicy:
      result.endPositionPolicy ?? request.endPositionPolicy ?? "mark_to_market",
    candleCount: result.candleCount,
    accounting: result.accounting ?? null,
    dataQuality: result.dataQuality ?? null,
    engineSemantics: result.engineSemantics ?? null,
    environment: result.environment ?? null,
    executionMode: result.execution?.executionMode ?? policy.mode,
    executionPolicy: result.execution?.executionPolicy ?? policy,
    executionPolicyVersion: result.execution?.executionPolicyVersion ?? policy.version,
    executionContext: result.execution ?? null,
    modeResults: result.modeResults ?? null,
    legAccounting: result.legAccounting ?? null,
    startedAt: startedAt ? new Date(startedAt) : null,
    completedAt,
  };
}

export function buildBacktestJobExecutionContext(job: Pick<
  BacktestJobState,
  "status" | "request" | "runner" | "failure"
>) {
  const policy = job.request.executionPolicy as Record<string, unknown> | undefined;
  const mode = job.request.executionMode ?? policy?.mode ?? "SINGLE_EXCLUSIVE";
  return {
    executionMode: mode,
    executionPolicy: job.request.executionPolicy ?? { mode },
    executionPolicyVersion: policy?.version ?? "execution-policy-v1",
    status: job.status === "completed"
      ? "COMPLETED"
      : job.status === "failed" || job.status === "timeout" || job.status === "cancelled"
        ? "FAILED"
        : job.status === "running"
          ? "RUNNING"
          : "RUNNER_READY",
    runner: job.runner ?? null,
    failure: job.failure ?? null,
  };
}

class BacktestJobManager {
  private jobs = new Map<string, BacktestJobState>();
  private queue: string[] = [];
  private running = 0;
  private initialized = false;

  /** 初始化：標記 stale running jobs */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const db = await getDb();
      if (!db) return;
      // 標記所有 running/pending 狀態的任務為 failed（伺服器重啟導致中斷）
      await db.update(backtestJobs)
        .set({
          status: "failed",
          error: "伺服器重啟，任務已中斷",
          message: "伺服器重啟，任務已中斷",
          completedAt: new Date(),
        })
        .where(inArray(backtestJobs.status, ["running", "pending"]));
    } catch (e) {
      console.warn("[BacktestJobManager] 初始化標記 stale jobs 失敗:", (e as Error)?.message);
    }
  }

  /** 提交回測任務 */
  async submit(
    request: BacktestRequest,
    userId: number,
    options?: { timeoutSeconds?: number; strategyName?: string; tradeAmount?: number }
  ): Promise<string> {
    await this.initialize();

    const runnerPreflight = preflightBacktestRunner(request);
    const executionPolicy = runnerPreflight.executionPolicy;

    const queuedCount = this.queue.length;
    if (queuedCount >= MAX_QUEUE_SIZE) {
      throw new Error(`回測佇列已滿（最多 ${MAX_QUEUE_SIZE} 個排隊任務），請稍後再試`);
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: BacktestJobState = {
      jobId,
      status: "pending",
      progress: 0,
      message: this.running >= MAX_CONCURRENT_JOBS
        ? `排隊中（前方還有 ${queuedCount} 個任務）`
        : "任務已提交",
      request,
      createdAt: Date.now(),
      timeoutSeconds: options?.timeoutSeconds ?? 0,
      userId,
      strategyName: options?.strategyName,
      runner: runnerPreflight.runner,
    };
    this.jobs.set(jobId, job);

    // 寫入資料庫
    try {
      const db = await getDb();
      if (db) {
        await db.insert(backtestJobs).values({
          userId,
          jobId,
          strategyKey: request.strategyKey,
          strategyName: options?.strategyName || request.strategyKey,
          symbol: request.symbol,
          timeframe: request.timeframe,
          exchange: request.exchange || "okx",
          startDate: request.startDate,
          endDate: request.endDate,
          initialCapital: String(request.initialCapital),
          tradeAmount: options?.tradeAmount ? String(options.tradeAmount) : null,
          config: request.config || {},
          executionMode: executionPolicy.mode,
          executionPolicy,
          executionPolicyVersion: executionPolicy.version,
          executionContext: buildBacktestJobExecutionContext(job),
          endPositionPolicy: request.endPositionPolicy ?? "mark_to_market",
          status: "pending",
          progress: 0,
          message: job.message,
        });
      }
    } catch (e) {
      console.warn("[BacktestJobManager] 寫入 DB 失敗:", (e as Error)?.message);
    }

    this.queue.push(jobId);
    void this.processQueue();

    return jobId;
  }

  /** 取消任務 */
  async cancel(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === "pending" || job.status === "running") {
      job.status = "cancelled";
      job.error = "已由用戶取消";
      job.message = "任務已取消";
      job.finishedAt = Date.now();
      // 從佇列移除
      this.queue = this.queue.filter(id => id !== jobId);
      await this.updateJobInDB(job);
      return true;
    }
    return false;
  }

  /** 佇列消費器 */
  private async processQueue(): Promise<void> {
    while (this.running < MAX_CONCURRENT_JOBS && this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "pending") continue;
      this.running++;
      void this.execute(job).finally(() => {
        this.running--;
        void this.processQueue();
      });
    }
    // 更新排隊位置提示
    this.queue.forEach((id, idx) => {
      const j = this.jobs.get(id);
      if (j && j.status === "pending") {
        j.message = `排隊中（前方還有 ${idx} 個任務）`;
      }
    });
  }

  private async execute(job: BacktestJobState, retryCount = 0): Promise<void> {
    job.status = "running";
    job.startedAt = Date.now();
    job.message = "回測執行中...";
    await this.updateJobInDB(job);

    const timeoutMs = job.timeoutSeconds > 0
      ? job.timeoutSeconds * 1000
      : DEFAULT_TIMEOUT_MS;

    const timeout = setTimeout(() => {
      if (job.status === "running") {
        job.status = "timeout";
        job.error = `回測超過 ${Math.round(timeoutMs / 1000)} 秒上限，已自動終止`;
        job.failure = { stage: "EXECUTION", errorCode: "BACKTEST_TIMEOUT" };
        job.message = job.error;
        job.finishedAt = Date.now();
        void this.updateJobInDB(job);
      }
    }, timeoutMs);

    // 定期寫進度到 DB
    let lastDbWrite = 0;
    const progressCallback = (pct: number, message: string) => {
      if (job.status === "running") {
        job.progress = Math.min(99, Math.round(pct));
        job.message = message;
        // WebSocket 即時推送
        backtestWsService.broadcastProgress(job.jobId, job.progress, job.status, { message });
        // 節流寫 DB
        const now = Date.now();
        if (now - lastDbWrite > PROGRESS_DB_INTERVAL) {
          lastDbWrite = now;
          void this.updateProgressInDB(job.jobId, job.progress, message);
        }
      }
    };

    try {
      const result = await backtestEngine.runBacktest(job.request, progressCallback);
      if (job.status === "running") {
        job.status = "completed";
        job.progress = 100;
        job.message = result.summary;
        job.result = result;
        job.finishedAt = Date.now();

        // WebSocket 推送完成
        backtestWsService.broadcastComplete(job.jobId, {
          summary: result.summary,
          totalTrades: result.metrics.totalTrades,
          winRate: result.metrics.winRate,
          totalReturn: result.metrics.totalReturn,
          maxDrawdown: result.metrics.maxDrawdown,
        });

        // 持久化完整結果到主 DB
        await this.persistResultToDB(job, result);
      }
    } catch (e) {
      if (job.status === "running") {
        if (retryCount < MAX_RETRIES && this.isRetryableError(e)) {
          job.status = "pending";
          job.progress = 0;
          job.message = `執行失敗，正在重試（${retryCount + 1}/${MAX_RETRIES}）...`;
          clearTimeout(timeout);
          await new Promise(r => setTimeout(r, 2000));
          return this.execute(job, retryCount + 1);
        }
        job.status = "failed";
        job.error = e instanceof Error ? e.message : String(e);
        job.failure = classifyBacktestFailure(e);
        job.message = `回測失敗：${job.error}`;
        job.finishedAt = Date.now();
        backtestWsService.broadcastError(job.jobId, job.error);
        await this.updateJobInDB(job);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private isRetryableError(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    const msg = e.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('econnreset') || msg.includes('network') || msg.includes('fetch');
  }

  /** 持久化完整結果到主 DB */
  private async persistResultToDB(job: BacktestJobState, result: BacktestResult): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;

      await db.update(backtestJobs)
        .set(buildBacktestResultPersistence(result, job.request, job.startedAt))
        .where(eq(backtestJobs.jobId, job.jobId));
    } catch (e) {
      console.warn("[BacktestJobManager] 持久化結果失敗:", (e as Error)?.message);
    }
  }

  /** 更新任務狀態到 DB */
  private async updateJobInDB(job: BacktestJobState): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;

      const updateData: Record<string, any> = {
        status: job.status,
        progress: job.progress,
        message: job.message,
      };
      if (job.error) updateData.error = job.error;
      updateData.executionContext = buildBacktestJobExecutionContext(job);
      if (job.startedAt) updateData.startedAt = new Date(job.startedAt);
      if (job.finishedAt) updateData.completedAt = new Date(job.finishedAt);

      await db.update(backtestJobs)
        .set(updateData)
        .where(eq(backtestJobs.jobId, job.jobId));
    } catch (e) {
      console.warn("[BacktestJobManager] 更新 DB 狀態失敗:", (e as Error)?.message);
    }
  }

  /** 節流更新進度到 DB */
  private async updateProgressInDB(jobId: string, progress: number, message: string): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;
      await db.update(backtestJobs)
        .set({ progress, message })
        .where(eq(backtestJobs.jobId, jobId));
    } catch (e) {
      // 靜默失敗，不影響主流程
    }
  }

  // ==================== 查詢方法 ====================

  /** 查詢任務進度（優先從記憶體，fallback 到 DB） */
  getProgress(jobId: string): Omit<BacktestJobState, "result" | "request"> | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const { result: _r, request: _q, ...rest } = job;
    return rest;
  }

  /** 取得完成任務的完整結果（記憶體中） */
  getResult(jobId: string): BacktestResult | null {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "completed" || !job.result) return null;
    return job.result;
  }

  /** 取得任務完整狀態 */
  getJob(jobId: string): BacktestJobState | null {
    return this.jobs.get(jobId) ?? null;
  }

  /** 獲取佇列狀態統計 */
  getQueueStatus() {
    const jobs = Array.from(this.jobs.values());
    return {
      total: jobs.length,
      queued: jobs.filter(j => j.status === "pending").length,
      running: jobs.filter(j => j.status === "running").length,
      completed: jobs.filter(j => j.status === "completed").length,
      failed: jobs.filter(j => j.status === "failed").length,
      timeout: jobs.filter(j => j.status === "timeout").length,
      cancelled: jobs.filter(j => j.status === "cancelled").length,
      maxConcurrent: MAX_CONCURRENT_JOBS,
      maxQueue: MAX_QUEUE_SIZE,
    };
  }

  /** 從 DB 讀取歷史回測記錄（分頁） */
  async listJobsFromDB(userId: number, options?: { limit?: number; offset?: number }): Promise<any[]> {
    try {
      const db = await getDb();
      if (!db) return [];

      const limit = options?.limit ?? 20;
      const offset = options?.offset ?? 0;

      const rows = await db
        .select({
          id: backtestJobs.id,
          jobId: backtestJobs.jobId,
          strategyKey: backtestJobs.strategyKey,
          strategyName: backtestJobs.strategyName,
          symbol: backtestJobs.symbol,
          timeframe: backtestJobs.timeframe,
          exchange: backtestJobs.exchange,
          startDate: backtestJobs.startDate,
          endDate: backtestJobs.endDate,
          initialCapital: backtestJobs.initialCapital,
          executionMode: backtestJobs.executionMode,
          executionPolicy: backtestJobs.executionPolicy,
          executionPolicyVersion: backtestJobs.executionPolicyVersion,
          executionContext: backtestJobs.executionContext,
          status: backtestJobs.status,
          progress: backtestJobs.progress,
          message: backtestJobs.message,
          metrics: backtestJobs.metrics,
          summary: backtestJobs.summary,
          endPositionPolicy: backtestJobs.endPositionPolicy,
          candleCount: backtestJobs.candleCount,
          accounting: backtestJobs.accounting,
          dataQuality: backtestJobs.dataQuality,
          engineSemantics: backtestJobs.engineSemantics,
          environment: backtestJobs.environment,
          modeResults: backtestJobs.modeResults,
          legAccounting: backtestJobs.legAccounting,
          error: backtestJobs.error,
          createdAt: backtestJobs.createdAt,
          startedAt: backtestJobs.startedAt,
          completedAt: backtestJobs.completedAt,
        })
        .from(backtestJobs)
        .where(eq(backtestJobs.userId, userId))
        .orderBy(desc(backtestJobs.createdAt))
        .limit(limit)
        .offset(offset);

      return rows;
    } catch (e) {
      console.warn("[BacktestJobManager] 讀取歷史記錄失敗:", (e as Error)?.message);
      return [];
    }
  }

  /** 從 DB 讀取單個回測的完整結果 */
  async getJobResultFromDB(jobId: string, userId: number): Promise<any | null> {
    try {
      const db = await getDb();
      if (!db) return null;

      const [row] = await db
        .select()
        .from(backtestJobs)
        .where(and(eq(backtestJobs.jobId, jobId), eq(backtestJobs.userId, userId)))
        .limit(1);

      if (!row) return null;
      return row;
    } catch (e) {
      return null;
    }
  }

  /** 從 DB 刪除回測記錄 */
  async deleteJobFromDB(jobId: string, userId: number): Promise<boolean> {
    try {
      const db = await getDb();
      if (!db) return false;

      await db.delete(backtestJobs)
        .where(and(eq(backtestJobs.jobId, jobId), eq(backtestJobs.userId, userId)));
      // 也從記憶體清除
      this.jobs.delete(jobId);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 獲取進行中的任務數（用於側邊欄 badge） */
  getActiveJobCount(): number {
    let count = 0;
    const jobs = Array.from(this.jobs.values());
    for (const job of jobs) {
      if (job.status === "running" || job.status === "pending") count++;
    }
    return count;
  }
}

export const backtestJobManager = new BacktestJobManager();
