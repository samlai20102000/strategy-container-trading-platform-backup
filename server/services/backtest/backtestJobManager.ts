/**
 * Durable 回測工作管理器。
 *
 * 記憶體只保留同一 pod 的即時 AbortController／UI 快取；任務真相、佇列、
 * lease、進度、取消與結果全部在 backtest_jobs。提交請求可立即嘗試執行，
 * project-level Heartbeat 使用相同 acquire/execute 路徑接管冷啟動或中斷工作。
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { backtestJobs } from "../../../drizzle/schema";
import { normalizeExecutionModePolicy } from "../../../shared/executionModes";
import { getDb } from "../../db";
import { backtestWsService } from "../wsService";
import { backtestEngine, type BacktestRequest, type BacktestResult } from "./backtestEngine";
import type { BacktestRunnerIdentity } from "./backtestContracts";
import {
  classifyBacktestFailure,
  preflightBacktestRunner,
  type BacktestFailureMetadata,
} from "./backtestRunnerPreflight";
import {
  BACKTEST_MAX_ATTEMPTS,
  BacktestCancellationRequestedError,
  BacktestLeaseLostError,
  acquireNextBacktestLease,
  buildBacktestLogicHash,
  checkpointBacktestLease,
  countBacktestJobs,
  failUnrecoverableLegacyBacktests,
  markBacktestCancelled,
  markBacktestFailed,
  persistCompletedBacktest,
  requestBacktestCancellation,
  type BacktestJobPhase,
  type BacktestLease,
  type BacktestQueueCounts,
} from "./durableBacktestRepository";
import {
  BacktestExecutionCancelledError,
  type BacktestJobControl,
  type BacktestJobCheckpoint,
} from "./backtestJobControl";

export interface BacktestJobState {
  jobId: string;
  status: "pending" | "running" | "completed" | "failed" | "timeout" | "cancelled";
  phase: BacktestJobPhase;
  progress: number;
  processedBars: number;
  totalBars: number;
  heartbeatAt?: number;
  cancelRequested: boolean;
  attemptCount: number;
  message: string;
  request: BacktestRequest;
  result?: BacktestResult;
  error?: string;
  errorCode?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  timeoutSeconds: number;
  userId: number;
  strategyName?: string;
  runner?: BacktestRunnerIdentity;
  failure?: BacktestFailureMetadata;
}

export interface DurableBacktestWorkerSummary {
  acquired: boolean;
  jobId?: string;
  status?: BacktestJobState["status"] | "lease-lost";
  progress?: number;
  processedBars?: number;
  totalBars?: number;
}

const MAX_CONCURRENT_JOBS = 3;
const MAX_QUEUE_SIZE = 5;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const CHECKPOINT_INTERVAL_MS = 2_000;
const CHECKPOINT_BAR_INTERVAL = 250;

const EMPTY_COUNTS: BacktestQueueCounts = {
  total: 0,
  queued: 0,
  running: 0,
  completed: 0,
  failed: 0,
  timeout: 0,
  cancelled: 0,
};

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
    phase: "COMPLETED" as const,
    progress: 100,
    processedBars: result.candleCount,
    totalBars: result.candleCount,
    message: result.summary,
    metrics: result.metrics,
    tradesData: result.trades,
    equityCurve: result.equityCurve,
    summary: result.summary,
    endPositionPolicy: result.endPositionPolicy ?? request.endPositionPolicy ?? "mark_to_market",
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
    error: null,
    errorCode: null,
    heartbeatAt: completedAt,
    leaseToken: null,
    leaseExpiresAt: null,
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

function parseProgressMessage(message: string, pct: number, currentTotal: number): {
  processedBars: number;
  totalBars: number;
} {
  const pair = message.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
  if (pair) {
    return {
      processedBars: Number(pair[1].replaceAll(",", "")),
      totalBars: Number(pair[2].replaceAll(",", "")),
    };
  }
  const totalMatch = message.match(/(\d[\d,]*)\s*根/);
  const totalBars = totalMatch
    ? Number(totalMatch[1].replaceAll(",", ""))
    : currentTotal;
  const processedBars = totalBars > 0 && pct >= 35
    ? Math.floor(totalBars * Math.min(1, Math.max(0, (pct - 35) / 60)))
    : 0;
  return { processedBars, totalBars };
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timeout|econnreset|network|fetch|socket|temporar/i.test(error.message);
}

function toLocalState(lease: BacktestLease, runner: BacktestRunnerIdentity): BacktestJobState {
  const row = lease.job;
  return {
    jobId: row.jobId,
    status: "running",
    phase: "PREPARING",
    progress: row.progress,
    processedBars: row.processedBars,
    totalBars: row.totalBars,
    heartbeatAt: row.heartbeatAt?.getTime(),
    cancelRequested: row.cancelRequested,
    attemptCount: row.attemptCount,
    message: row.message ?? "durable worker 已取得工作",
    request: lease.request,
    createdAt: row.createdAt.getTime(),
    startedAt: row.startedAt?.getTime() ?? Date.now(),
    timeoutSeconds: row.timeoutSeconds,
    userId: row.userId,
    strategyName: row.strategyName ?? undefined,
    runner,
  };
}

class BacktestJobManager {
  private jobs = new Map<string, BacktestJobState>();
  private controllers = new Map<string, AbortController>();
  private activeExecutions = new Map<string, Promise<DurableBacktestWorkerSummary>>();
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private counts: BacktestQueueCounts = { ...EMPTY_COUNTS };

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      const repaired = await failUnrecoverableLegacyBacktests();
      if (repaired > 0) {
        console.warn(`[BacktestJobManager] 已終止 ${repaired} 個缺少 snapshot 的舊版孤兒工作`);
      }
      this.counts = await countBacktestJobs();
      this.initialized = true;
    })().finally(() => {
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  async submit(
    request: BacktestRequest,
    userId: number,
    options?: { timeoutSeconds?: number; strategyName?: string; tradeAmount?: number },
  ): Promise<string> {
    await this.initialize();
    const runnerPreflight = preflightBacktestRunner(request);
    const executionPolicy = runnerPreflight.executionPolicy;
    const counts = await countBacktestJobs();
    if (counts.queued >= MAX_QUEUE_SIZE) {
      throw new Error(`回測佇列已滿（最多 ${MAX_QUEUE_SIZE} 個排隊任務），請稍後再試`);
    }

    const jobId = `job_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const timeoutSeconds = options?.timeoutSeconds ?? 0;
    const message = counts.running >= MAX_CONCURRENT_JOBS
      ? `排隊中（目前 ${counts.running} 個任務執行中）`
      : "任務已提交，等待 durable worker";
    const job: BacktestJobState = {
      jobId,
      status: "pending",
      phase: "QUEUED",
      progress: 0,
      processedBars: 0,
      totalBars: 0,
      cancelRequested: false,
      attemptCount: 0,
      message,
      request,
      createdAt: Date.now(),
      timeoutSeconds,
      userId,
      strategyName: options?.strategyName,
      runner: runnerPreflight.runner,
    };

    const db = await getDb();
    if (!db) throw new Error("BACKTEST_DATABASE_UNAVAILABLE");
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
      requestSnapshot: structuredClone(request),
      logicHash: buildBacktestLogicHash(runnerPreflight.runner),
      timeoutSeconds,
      executionMode: executionPolicy.mode,
      executionPolicy,
      executionPolicyVersion: executionPolicy.version,
      executionContext: buildBacktestJobExecutionContext(job),
      endPositionPolicy: request.endPositionPolicy ?? "mark_to_market",
      status: "pending",
      phase: "QUEUED",
      progress: 0,
      processedBars: 0,
      totalBars: 0,
      cancelRequested: false,
      attemptCount: 0,
      message,
    });
    this.jobs.set(jobId, job);
    this.counts = { ...counts, total: counts.total + 1, queued: counts.queued + 1 };
    void this.fillLocalSlots();
    return jobId;
  }

  async cancel(jobId: string, userId?: number): Promise<boolean> {
    const local = this.jobs.get(jobId);
    const ownerId = userId ?? local?.userId;
    if (!ownerId) return false;
    const cancelled = await requestBacktestCancellation(jobId, ownerId);
    if (!cancelled) return false;
    this.controllers.get(jobId)?.abort(new BacktestCancellationRequestedError(jobId));
    if (local) {
      local.status = "cancelled";
      local.phase = "CANCELLED";
      local.cancelRequested = true;
      local.error = "已由用戶取消";
      local.errorCode = "BACKTEST_CANCELLED";
      local.message = "任務已取消";
      local.finishedAt = Date.now();
    }
    backtestWsService.broadcastProgress(jobId, local?.progress ?? 0, "cancelled", {
      message: "任務已取消",
    });
    void this.refreshCounts();
    return true;
  }

  private async refreshCounts(): Promise<void> {
    try {
      this.counts = await countBacktestJobs();
    } catch (error) {
      console.warn("[BacktestJobManager] 更新 DB queue counts 失敗:", (error as Error).message);
    }
  }

  private async fillLocalSlots(): Promise<void> {
    await this.initialize();
    while (this.activeExecutions.size < MAX_CONCURRENT_JOBS) {
      const lease = await acquireNextBacktestLease();
      if (!lease) break;
      const execution = this.executeLease(lease).finally(() => {
        this.activeExecutions.delete(lease.job.jobId);
        this.controllers.delete(lease.job.jobId);
        void this.refreshCounts();
        void this.fillLocalSlots();
      });
      this.activeExecutions.set(lease.job.jobId, execution);
    }
  }

  async runDurableWorkerTick(): Promise<DurableBacktestWorkerSummary> {
    await this.initialize();
    const lease = await acquireNextBacktestLease();
    if (!lease) {
      await this.refreshCounts();
      return { acquired: false };
    }
    const existing = this.activeExecutions.get(lease.job.jobId);
    if (existing) return existing;
    const execution = this.executeLease(lease).finally(() => {
      this.activeExecutions.delete(lease.job.jobId);
      this.controllers.delete(lease.job.jobId);
      void this.refreshCounts();
    });
    this.activeExecutions.set(lease.job.jobId, execution);
    return execution;
  }

  private async executeLease(lease: BacktestLease): Promise<DurableBacktestWorkerSummary> {
    const preflight = preflightBacktestRunner(lease.request);
    const expectedLogicHash = buildBacktestLogicHash(preflight.runner);
    if (lease.job.logicHash && lease.job.logicHash !== expectedLogicHash) {
      const error = "runner identity 已變更，拒絕以不同策略邏輯重試舊工作";
      await markBacktestFailed({
        jobId: lease.job.jobId,
        leaseToken: lease.leaseToken,
        errorCode: "BACKTEST_LOGIC_HASH_MISMATCH",
        error,
        message: `回測失敗：${error}`,
      });
      return { acquired: true, jobId: lease.job.jobId, status: "failed" };
    }

    const job = toLocalState(lease, preflight.runner);
    this.jobs.set(job.jobId, job);
    const controller = new AbortController();
    this.controllers.set(job.jobId, controller);
    const timeoutMs = job.timeoutSeconds > 0 ? job.timeoutSeconds * 1_000 : DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let lastCheckpointAt = 0;
    let lastCheckpointBars = job.processedBars;
    let checkpointChain = Promise.resolve();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("BACKTEST_TIMEOUT"));
    }, timeoutMs);

    const enqueueCheckpoint = (force = false): Promise<void> => {
      const now = Date.now();
      const enoughTime = now - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS;
      const enoughBars = job.processedBars - lastCheckpointBars >= CHECKPOINT_BAR_INTERVAL;
      if (!force && !enoughTime && !enoughBars) return checkpointChain;
      lastCheckpointAt = now;
      lastCheckpointBars = job.processedBars;
      checkpointChain = checkpointChain.then(async () => {
        await checkpointBacktestLease(job.jobId, lease.leaseToken, {
          phase: job.phase,
          progress: job.progress,
          processedBars: job.processedBars,
          totalBars: job.totalBars,
          message: job.message,
        });
        job.heartbeatAt = Date.now();
      }).catch(error => {
        if (error instanceof BacktestCancellationRequestedError || error instanceof BacktestLeaseLostError) {
          controller.abort(error);
          throw error;
        }
        throw error;
      });
      return checkpointChain;
    };

    const applyControlCheckpoint = async (input: BacktestJobCheckpoint): Promise<void> => {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new BacktestExecutionCancelledError();
      }
      job.status = "running";
      job.phase = input.phase;
      job.progress = Math.max(job.progress, Math.min(99, Math.round(input.progress)));
      job.processedBars = Math.max(job.processedBars, Math.trunc(input.processedBars));
      job.totalBars = Math.max(job.totalBars, Math.trunc(input.totalBars));
      job.message = input.message;
      backtestWsService.broadcastProgress(job.jobId, job.progress, job.status, {
        message: job.message,
        phase: job.phase,
        processedBars: job.processedBars,
        totalBars: job.totalBars,
        heartbeatAt: Date.now(),
      });
      await enqueueCheckpoint(input.force === true);
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new BacktestExecutionCancelledError();
      }
    };

    const jobControl: BacktestJobControl = {
      signal: controller.signal,
      checkpoint: applyControlCheckpoint,
      throwIfCancelled: async () => {
        await applyControlCheckpoint({
          phase: job.phase === "FINALIZING" ? "FINALIZING" : "RUNNING",
          processedBars: job.processedBars,
          totalBars: job.totalBars,
          progress: job.progress,
          message: job.message,
          force: true,
        });
      },
    };

    try {
      await checkpointBacktestLease(job.jobId, lease.leaseToken, {
        phase: "PREPARING",
        progress: Math.max(1, job.progress),
        processedBars: job.processedBars,
        totalBars: job.totalBars,
        message: "驗證 runner 並載入歷史資料",
      });
      job.progress = Math.max(1, job.progress);
      job.message = "驗證 runner 並載入歷史資料";

      const result = await backtestEngine.runBacktest(lease.request, (pct, message) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        const parsed = parseProgressMessage(message, pct, job.totalBars);
        job.status = "running";
        job.phase = pct >= 95 ? "FINALIZING" : pct >= 35 ? "RUNNING" : "PREPARING";
        job.progress = Math.max(job.progress, Math.min(99, Math.round(pct)));
        job.processedBars = Math.max(job.processedBars, parsed.processedBars);
        job.totalBars = Math.max(job.totalBars, parsed.totalBars);
        job.message = message;
        backtestWsService.broadcastProgress(job.jobId, job.progress, job.status, {
          message,
          phase: job.phase,
          processedBars: job.processedBars,
          totalBars: job.totalBars,
          heartbeatAt: Date.now(),
        });
        void enqueueCheckpoint(pct >= 95);
      }, jobControl);

      void enqueueCheckpoint(true);
      await checkpointChain;
      if (controller.signal.aborted) throw controller.signal.reason;
      job.phase = "FINALIZING";
      job.progress = 99;
      job.totalBars = Math.max(job.totalBars, result.candleCount);
      job.processedBars = job.totalBars;
      await checkpointBacktestLease(job.jobId, lease.leaseToken, {
        phase: "FINALIZING",
        progress: 99,
        processedBars: job.processedBars,
        totalBars: job.totalBars,
        message: "原子保存回測結果",
      });

      const persisted = await persistCompletedBacktest({
        jobId: job.jobId,
        leaseToken: lease.leaseToken,
        values: buildBacktestResultPersistence(result, lease.request, job.startedAt),
      });
      if (!persisted) throw new BacktestLeaseLostError(job.jobId);

      job.status = "completed";
      job.phase = "COMPLETED";
      job.progress = 100;
      job.message = result.summary;
      job.result = result;
      job.finishedAt = Date.now();
      backtestWsService.broadcastComplete(job.jobId, {
        summary: result.summary,
        totalTrades: result.metrics.totalTrades,
        winRate: result.metrics.winRate,
        totalReturn: result.metrics.totalReturn,
        maxDrawdown: result.metrics.maxDrawdown,
      });
      return {
        acquired: true,
        jobId: job.jobId,
        status: "completed",
        progress: 100,
        processedBars: job.processedBars,
        totalBars: job.totalBars,
      };
    } catch (error) {
      try {
        await checkpointChain;
      } catch (checkpointError) {
        error = checkpointError;
      }
      if (error instanceof BacktestLeaseLostError) {
        return {
          acquired: true,
          jobId: job.jobId,
          status: "lease-lost",
          progress: job.progress,
          processedBars: job.processedBars,
          totalBars: job.totalBars,
        };
      }
      if (
        error instanceof BacktestCancellationRequestedError
        || error instanceof BacktestExecutionCancelledError
        || controller.signal.reason instanceof BacktestCancellationRequestedError
        || job.status === "cancelled"
      ) {
        await markBacktestCancelled(job.jobId, lease.leaseToken);
        job.status = "cancelled";
        job.phase = "CANCELLED";
        return { acquired: true, jobId: job.jobId, status: "cancelled", progress: job.progress };
      }

      const failure = classifyBacktestFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      const timeoutFailure = timedOut || message.includes("BACKTEST_TIMEOUT");
      const retry = !timeoutFailure
        && lease.job.attemptCount < BACKTEST_MAX_ATTEMPTS
        && isRetryableError(error);
      job.status = timeoutFailure ? "timeout" : retry ? "pending" : "failed";
      job.phase = retry ? "QUEUED" : "FAILED";
      job.failure = timeoutFailure
        ? { stage: "EXECUTION", errorCode: "BACKTEST_TIMEOUT" }
        : failure;
      job.errorCode = timeoutFailure ? "BACKTEST_TIMEOUT" : failure.errorCode;
      job.error = message;
      job.message = retry
        ? `暫時性失敗，等待 durable worker 重試：${message}`
        : `回測失敗：${message}`;
      job.finishedAt = retry ? undefined : Date.now();
      await markBacktestFailed({
        jobId: job.jobId,
        leaseToken: lease.leaseToken,
        status: timeoutFailure ? "timeout" : "failed",
        errorCode: job.errorCode,
        error: message,
        message: job.message,
        executionContext: buildBacktestJobExecutionContext(job),
        retry,
      });
      if (!retry) backtestWsService.broadcastError(job.jobId, message);
      return {
        acquired: true,
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        processedBars: job.processedBars,
        totalBars: job.totalBars,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  getProgress(jobId: string, userId?: number): Omit<BacktestJobState, "result" | "request"> | null {
    const job = this.jobs.get(jobId);
    if (!job || (userId !== undefined && job.userId !== userId)) return null;
    const { result: _result, request: _request, ...progress } = job;
    return progress;
  }

  getResult(jobId: string, userId?: number): BacktestResult | null {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "completed" || !job.result) return null;
    if (userId !== undefined && job.userId !== userId) return null;
    return job.result;
  }

  getJob(jobId: string): BacktestJobState | null {
    return this.jobs.get(jobId) ?? null;
  }

  getQueueStatus() {
    return { ...this.counts, maxConcurrent: MAX_CONCURRENT_JOBS, maxQueue: MAX_QUEUE_SIZE };
  }

  async getQueueStatusFromDB() {
    await this.refreshCounts();
    return this.getQueueStatus();
  }

  async listJobsFromDB(userId: number, options?: { limit?: number; offset?: number }): Promise<any[]> {
    const db = await getDb();
    if (!db) return [];
    return db
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
        phase: backtestJobs.phase,
        progress: backtestJobs.progress,
        processedBars: backtestJobs.processedBars,
        totalBars: backtestJobs.totalBars,
        heartbeatAt: backtestJobs.heartbeatAt,
        leaseExpiresAt: backtestJobs.leaseExpiresAt,
        cancelRequested: backtestJobs.cancelRequested,
        attemptCount: backtestJobs.attemptCount,
        errorCode: backtestJobs.errorCode,
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
      .limit(options?.limit ?? 20)
      .offset(options?.offset ?? 0);
  }

  async getJobResultFromDB(jobId: string, userId: number): Promise<any | null> {
    const db = await getDb();
    if (!db) return null;
    const [row] = await db
      .select()
      .from(backtestJobs)
      .where(and(eq(backtestJobs.jobId, jobId), eq(backtestJobs.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async deleteJobFromDB(jobId: string, userId: number): Promise<boolean> {
    const db = await getDb();
    if (!db) return false;
    const [row] = await db
      .select({ status: backtestJobs.status })
      .from(backtestJobs)
      .where(and(eq(backtestJobs.jobId, jobId), eq(backtestJobs.userId, userId)))
      .limit(1);
    if (!row || ["pending", "running"].includes(row.status)) return false;
    await db.delete(backtestJobs)
      .where(and(eq(backtestJobs.jobId, jobId), eq(backtestJobs.userId, userId)));
    this.jobs.delete(jobId);
    await this.refreshCounts();
    return true;
  }

  getActiveJobCount(): number {
    return this.counts.queued + this.counts.running;
  }

  async getActiveJobCountFromDB(): Promise<number> {
    await this.refreshCounts();
    return this.getActiveJobCount();
  }
}

export const backtestJobManager = new BacktestJobManager();
