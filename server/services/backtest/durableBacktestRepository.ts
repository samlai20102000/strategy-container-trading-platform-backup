import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  backtestJobs,
  backtestWorkerRegistry,
  type BacktestJob,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { BacktestRequest } from "./backtestEngine";
import type { BacktestRunnerIdentity } from "./backtestContracts";

export type BacktestJobPhase =
  | "QUEUED"
  | "PREPARING"
  | "RUNNING"
  | "FINALIZING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export const BACKTEST_LEASE_TTL_MS = 90_000;
export const BACKTEST_MAX_ATTEMPTS = 3;
export const BACKTEST_WORKER_NAME = "durable-backtest-worker-v1";

const ACTIVE_STATUSES = ["pending", "running"] as const;
const TERMINAL_STATUSES = ["completed", "failed", "timeout", "cancelled"] as const;

export class BacktestLeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`BACKTEST_LEASE_LOST:${jobId}`);
    this.name = "BacktestLeaseLostError";
  }
}

export class BacktestCancellationRequestedError extends Error {
  constructor(readonly jobId: string) {
    super(`BACKTEST_CANCEL_REQUESTED:${jobId}`);
    this.name = "BacktestCancellationRequestedError";
  }
}

export interface BacktestLease {
  job: BacktestJob;
  leaseToken: string;
  request: BacktestRequest;
}

export interface BacktestCheckpoint {
  phase: BacktestJobPhase;
  progress: number;
  processedBars: number;
  totalBars: number;
  message: string;
}

function extractAffectedRows(result: unknown): number {
  const raw = result as
    | { affectedRows?: number; rowsAffected?: number }
    | [{ affectedRows?: number; rowsAffected?: number }, ...unknown[]];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return Number(header?.affectedRows ?? header?.rowsAffected ?? 0);
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

export function buildBacktestLogicHash(runner: BacktestRunnerIdentity): string {
  return createHash("sha256").update(stableSerialize(runner)).digest("hex");
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("BACKTEST_DATABASE_UNAVAILABLE");
  return db;
}

/**
 * 只修復舊版無 request snapshot 的 active rows。新工作由 lease expiry 接管，
 * 不會在冷啟動時被粗暴標記失敗。
 */
export async function failUnrecoverableLegacyBacktests(now = new Date()): Promise<number> {
  const db = await requireDb();
  const result = await db
    .update(backtestJobs)
    .set({
      status: "failed",
      phase: "FAILED",
      errorCode: "BACKTEST_WORKER_INTERRUPTED",
      error: "工作由舊版記憶體 worker 中斷，缺少可恢復的 request snapshot；請重新提交回測。",
      message: "舊版工作已中斷，請使用新版 durable 回測重新提交",
      completedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        inArray(backtestJobs.status, [...ACTIVE_STATUSES]),
        isNull(backtestJobs.requestSnapshot),
      ),
    );
  return extractAffectedRows(result);
}

async function failUnrecoverableCandidate(job: BacktestJob, now: Date): Promise<void> {
  const db = await requireDb();
  const exhausted = job.attemptCount >= BACKTEST_MAX_ATTEMPTS;
  await db
    .update(backtestJobs)
    .set({
      status: "failed",
      phase: "FAILED",
      errorCode: exhausted ? "BACKTEST_RETRY_EXHAUSTED" : "BACKTEST_REQUEST_SNAPSHOT_MISSING",
      error: exhausted
        ? `worker 已達最大重試次數 ${BACKTEST_MAX_ATTEMPTS}`
        : "工作缺少 request snapshot，無法安全接管",
      message: exhausted ? "回測重試次數已用盡" : "回測資料不完整，請重新提交",
      completedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(and(eq(backtestJobs.id, job.id), inArray(backtestJobs.status, [...ACTIVE_STATUSES])));
}

/**
 * 以候選查詢 + 條件 UPDATE 取得單一工作。真正互斥點是 UPDATE 的 lease expiry
 * 條件；多 pod 同時看到相同候選時只會有一個 affected row。
 */
export async function acquireNextBacktestLease(now = new Date()): Promise<BacktestLease | null> {
  const db = await requireDb();
  const candidates = await db
    .select()
    .from(backtestJobs)
    .where(
      and(
        inArray(backtestJobs.status, [...ACTIVE_STATUSES]),
        eq(backtestJobs.cancelRequested, false),
        or(isNull(backtestJobs.leaseExpiresAt), lte(backtestJobs.leaseExpiresAt, now)),
      ),
    )
    .orderBy(asc(backtestJobs.createdAt))
    .limit(10);

  for (const candidate of candidates) {
    if (!candidate.requestSnapshot || candidate.attemptCount >= BACKTEST_MAX_ATTEMPTS) {
      await failUnrecoverableCandidate(candidate, now);
      continue;
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + BACKTEST_LEASE_TTL_MS);
    const result = await db
      .update(backtestJobs)
      .set({
        status: "running",
        phase: "PREPARING",
        heartbeatAt: now,
        leaseToken,
        leaseExpiresAt,
        attemptCount: sql`${backtestJobs.attemptCount} + 1`,
        startedAt: candidate.startedAt ?? now,
        message: candidate.attemptCount > 0
          ? `工作中斷後恢復中（第 ${candidate.attemptCount + 1} 次執行）`
          : "durable worker 已取得工作",
      })
      .where(
        and(
          eq(backtestJobs.id, candidate.id),
          inArray(backtestJobs.status, [...ACTIVE_STATUSES]),
          eq(backtestJobs.cancelRequested, false),
          or(isNull(backtestJobs.leaseExpiresAt), lte(backtestJobs.leaseExpiresAt, now)),
        ),
      );
    if (extractAffectedRows(result) !== 1) continue;

    const [leased] = await db
      .select()
      .from(backtestJobs)
      .where(and(eq(backtestJobs.id, candidate.id), eq(backtestJobs.leaseToken, leaseToken)))
      .limit(1);
    if (!leased) continue;
    return {
      job: leased,
      leaseToken,
      request: leased.requestSnapshot as BacktestRequest,
    };
  }
  return null;
}

export async function checkpointBacktestLease(
  jobId: string,
  leaseToken: string,
  checkpoint: BacktestCheckpoint,
  now = new Date(),
): Promise<void> {
  const db = await requireDb();
  const progress = Math.max(0, Math.min(99, Math.round(checkpoint.progress)));
  const processedBars = Math.max(0, Math.round(checkpoint.processedBars));
  const totalBars = Math.max(0, Math.round(checkpoint.totalBars));
  const result = await db
    .update(backtestJobs)
    .set({
      phase: checkpoint.phase,
      progress: sql`GREATEST(${backtestJobs.progress}, ${progress})`,
      processedBars: sql`GREATEST(${backtestJobs.processedBars}, ${processedBars})`,
      totalBars: sql`GREATEST(${backtestJobs.totalBars}, ${totalBars})`,
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + BACKTEST_LEASE_TTL_MS),
      message: checkpoint.message,
    })
    .where(
      and(
        eq(backtestJobs.jobId, jobId),
        eq(backtestJobs.status, "running"),
        eq(backtestJobs.leaseToken, leaseToken),
        eq(backtestJobs.cancelRequested, false),
      ),
    );
  if (extractAffectedRows(result) === 1) return;

  const [row] = await db
    .select({ cancelRequested: backtestJobs.cancelRequested, leaseToken: backtestJobs.leaseToken })
    .from(backtestJobs)
    .where(eq(backtestJobs.jobId, jobId))
    .limit(1);
  if (row?.cancelRequested) throw new BacktestCancellationRequestedError(jobId);
  throw new BacktestLeaseLostError(jobId);
}

export async function readBacktestControlState(jobId: string, leaseToken: string): Promise<{
  cancelRequested: boolean;
  ownsLease: boolean;
}> {
  const db = await requireDb();
  const [row] = await db
    .select({
      cancelRequested: backtestJobs.cancelRequested,
      leaseToken: backtestJobs.leaseToken,
      status: backtestJobs.status,
    })
    .from(backtestJobs)
    .where(eq(backtestJobs.jobId, jobId))
    .limit(1);
  return {
    cancelRequested: row?.cancelRequested ?? true,
    ownsLease: row?.status === "running" && row.leaseToken === leaseToken,
  };
}

export async function requestBacktestCancellation(jobId: string, userId: number, now = new Date()): Promise<boolean> {
  const db = await requireDb();
  const [row] = await db
    .select({ status: backtestJobs.status })
    .from(backtestJobs)
    .where(and(eq(backtestJobs.jobId, jobId), eq(backtestJobs.userId, userId)))
    .limit(1);
  if (!row || TERMINAL_STATUSES.includes(row.status as (typeof TERMINAL_STATUSES)[number])) return false;

  const result = await db
    .update(backtestJobs)
    .set({
      cancelRequested: true,
      status: "cancelled",
      phase: "CANCELLED",
      message: "任務已取消",
      error: "已由用戶取消",
      errorCode: "BACKTEST_CANCELLED",
      completedAt: now,
      heartbeatAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(backtestJobs.jobId, jobId),
        eq(backtestJobs.userId, userId),
        inArray(backtestJobs.status, [...ACTIVE_STATUSES]),
      ),
    );
  return extractAffectedRows(result) === 1;
}

export interface BacktestQueueCounts {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  timeout: number;
  cancelled: number;
}

export async function countBacktestJobs(): Promise<BacktestQueueCounts> {
  const db = await requireDb();
  const rows = await db
    .select({
      status: backtestJobs.status,
      value: sql<number>`count(*)`,
    })
    .from(backtestJobs)
    .groupBy(backtestJobs.status);
  const counts: BacktestQueueCounts = {
    total: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    timeout: 0,
    cancelled: 0,
  };
  for (const row of rows) {
    const value = Number(row.value ?? 0);
    counts.total += value;
    if (row.status === "pending") counts.queued = value;
    else if (row.status === "running") counts.running = value;
    else counts[row.status] = value;
  }
  return counts;
}

export async function markBacktestCancelled(jobId: string, leaseToken: string, now = new Date()): Promise<boolean> {
  const db = await requireDb();
  const result = await db
    .update(backtestJobs)
    .set({
      status: "cancelled",
      phase: "CANCELLED",
      cancelRequested: true,
      progress: sql`LEAST(${backtestJobs.progress}, 99)`,
      message: "任務已取消",
      error: "已由用戶取消",
      errorCode: "BACKTEST_CANCELLED",
      completedAt: now,
      heartbeatAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(backtestJobs.jobId, jobId),
        eq(backtestJobs.status, "running"),
        eq(backtestJobs.leaseToken, leaseToken),
      ),
    );
  return extractAffectedRows(result) === 1;
}

export async function markBacktestFailed(input: {
  jobId: string;
  leaseToken: string;
  status?: "failed" | "timeout";
  errorCode: string;
  error: string;
  message: string;
  executionContext?: unknown;
  retry?: boolean;
}, now = new Date()): Promise<boolean> {
  const db = await requireDb();
  const result = await db
    .update(backtestJobs)
    .set(input.retry
      ? {
          status: "pending",
          phase: "QUEUED",
          message: input.message,
          error: input.error,
          errorCode: input.errorCode,
          executionContext: input.executionContext,
          heartbeatAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        }
      : {
          status: input.status ?? "failed",
          phase: "FAILED",
          message: input.message,
          error: input.error,
          errorCode: input.errorCode,
          executionContext: input.executionContext,
          completedAt: now,
          heartbeatAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        })
    .where(
      and(
        eq(backtestJobs.jobId, input.jobId),
        eq(backtestJobs.status, "running"),
        eq(backtestJobs.leaseToken, input.leaseToken),
      ),
    );
  return extractAffectedRows(result) === 1;
}

export async function persistCompletedBacktest(input: {
  jobId: string;
  leaseToken: string;
  values: Record<string, unknown>;
}, now = new Date()): Promise<boolean> {
  const db = await requireDb();
  const result = await db
    .update(backtestJobs)
    .set({
      ...input.values,
      status: "completed",
      phase: "COMPLETED",
      progress: 100,
      completedAt: now,
      heartbeatAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(backtestJobs.jobId, input.jobId),
        eq(backtestJobs.status, "running"),
        eq(backtestJobs.leaseToken, input.leaseToken),
        eq(backtestJobs.cancelRequested, false),
      ),
    );
  return extractAffectedRows(result) === 1;
}

export async function verifyBacktestWorkerTask(taskUid: string): Promise<boolean> {
  const db = await requireDb();
  const [row] = await db
    .select({ id: backtestWorkerRegistry.id })
    .from(backtestWorkerRegistry)
    .where(
      and(
        eq(backtestWorkerRegistry.scheduleCronTaskUid, taskUid),
        eq(backtestWorkerRegistry.enabled, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * project-level Heartbeat 建立／修正後，以固定 worker name 冪等保存 taskUid。
 * callback 僅信任此 registry，不使用可由呼叫方偽造的 request body。
 */
export async function upsertBacktestWorkerRegistry(
  taskUid: string,
  enabled = true,
): Promise<void> {
  if (!taskUid.trim()) throw new Error("BACKTEST_WORKER_TASK_UID_REQUIRED");
  const db = await requireDb();
  await db
    .insert(backtestWorkerRegistry)
    .values({
      name: BACKTEST_WORKER_NAME,
      scheduleCronTaskUid: taskUid,
      enabled,
    })
    .onDuplicateKeyUpdate({
      set: {
        scheduleCronTaskUid: taskUid,
        enabled,
      },
    });
}

export async function recordBacktestWorkerRun(
  taskUid: string,
  result: string,
  summary: Record<string, unknown>,
  now = new Date(),
): Promise<void> {
  const db = await requireDb();
  await db
    .update(backtestWorkerRegistry)
    .set({ lastHeartbeatAt: now, lastResult: result.slice(0, 40), lastSummary: summary })
    .where(eq(backtestWorkerRegistry.scheduleCronTaskUid, taskUid));
}
