import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "./db";
import {
  BACKTEST_MAX_ATTEMPTS,
  BacktestCancellationRequestedError,
  acquireNextBacktestLease,
  checkpointBacktestLease,
  persistCompletedBacktest,
  requestBacktestCancellation,
  verifyBacktestWorkerTask,
} from "./services/backtest/durableBacktestRepository";

vi.mock("./db", () => ({ getDb: vi.fn() }));

const requestSnapshot = {
  strategyKey: "KAMA_RAINBOW_MARTIN",
  symbol: "BTC-USDT-SWAP",
  timeframe: "30m",
  startTime: 1,
  endTime: 2,
  initialCapital: 10_000,
  commission: 0.0005,
  slippage: 0.0002,
} as any;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    jobId: "job-durable-1",
    userId: 7,
    status: "pending",
    phase: "QUEUED",
    progress: 0,
    processedBars: 0,
    totalBars: 0,
    cancelRequested: false,
    attemptCount: 0,
    requestSnapshot,
    leaseToken: null,
    leaseExpiresAt: null,
    startedAt: null,
    createdAt: new Date(1_000),
    ...overrides,
  } as any;
}

describe("durable backtest repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("同一候選即使被兩個 pod 同時看見，也只允許一個條件 UPDATE 取得 lease", async () => {
    const row = candidate();
    let leased = false;
    let storedLeaseToken: string | null = null;
    const update = vi.fn(() => ({
      set: vi.fn((values: any) => ({
        where: vi.fn(async () => {
          if (values.phase !== "PREPARING" || leased) return [{ affectedRows: 0 }];
          leased = true;
          storedLeaseToken = values.leaseToken;
          return [{ affectedRows: 1 }];
        }),
      })),
    }));
    const select = vi.fn(() => ({
      from: vi.fn(() => {
        const chain: any = {
          where: vi.fn(() => chain),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(async (limit: number) => limit === 10
            ? [row]
            : leased
              ? [{ ...row, status: "running", phase: "PREPARING", leaseToken: storedLeaseToken }]
              : []),
        };
        return chain;
      }),
    }));
    vi.mocked(getDb).mockResolvedValue({ update, select } as any);

    const now = new Date(5_000);
    const first = await acquireNextBacktestLease(now);
    const second = await acquireNextBacktestLease(now);

    expect(first?.job.jobId).toBe(row.jobId);
    expect(first?.leaseToken).toBe(storedLeaseToken);
    expect(second).toBeNull();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("持久化取消以 owner 條件原子寫入 cancelled 終態並撤銷 lease", async () => {
    const capturedSets: any[] = [];
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ status: "running" }]),
        })),
      })),
    }));
    const update = vi.fn(() => ({
      set: vi.fn((values: any) => {
        capturedSets.push(values);
        return { where: vi.fn(async () => [{ affectedRows: 1 }]) };
      }),
    }));
    vi.mocked(getDb).mockResolvedValue({ select, update } as any);

    await expect(requestBacktestCancellation("job-durable-1", 7, new Date(8_000))).resolves.toBe(true);
    expect(capturedSets).toHaveLength(1);
    expect(capturedSets[0]).toMatchObject({
      cancelRequested: true,
      status: "cancelled",
      phase: "CANCELLED",
      errorCode: "BACKTEST_CANCELLED",
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  it("checkpoint 更新失敗且 DB 已記錄取消時，runner 必須收到可辨識取消錯誤", async () => {
    const update = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => [{ affectedRows: 0 }]) })),
    }));
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ cancelRequested: true, leaseToken: null }]),
        })),
      })),
    }));
    vi.mocked(getDb).mockResolvedValue({ update, select } as any);

    await expect(checkpointBacktestLease("job-durable-1", "old-token", {
      phase: "RUNNING",
      progress: 56,
      processedBars: 10_000,
      totalBars: 27_744,
      message: "checkpoint",
    })).rejects.toBeInstanceOf(BacktestCancellationRequestedError);
  });

  it("達最大 attempt 的 stale 候選不得再執行，必須明確寫入 retry exhausted", async () => {
    const row = candidate({ attemptCount: BACKTEST_MAX_ATTEMPTS });
    const capturedSets: any[] = [];
    const select = vi.fn(() => ({
      from: vi.fn(() => {
        const chain: any = {
          where: vi.fn(() => chain),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(async () => [row]),
        };
        return chain;
      }),
    }));
    const update = vi.fn(() => ({
      set: vi.fn((values: any) => {
        capturedSets.push(values);
        return { where: vi.fn(async () => [{ affectedRows: 1 }]) };
      }),
    }));
    vi.mocked(getDb).mockResolvedValue({ select, update } as any);

    await expect(acquireNextBacktestLease(new Date(10_000))).resolves.toBeNull();
    expect(capturedSets).toHaveLength(1);
    expect(capturedSets[0]).toMatchObject({
      status: "failed",
      phase: "FAILED",
      errorCode: "BACKTEST_RETRY_EXHAUSTED",
      leaseToken: null,
    });
  });

  it("結果與 completed 終態必須由同一個 lease-guarded UPDATE 一次保存", async () => {
    const capturedSets: any[] = [];
    const update = vi.fn(() => ({
      set: vi.fn((values: any) => {
        capturedSets.push(values);
        return { where: vi.fn(async () => [{ affectedRows: 1 }]) };
      }),
    }));
    vi.mocked(getDb).mockResolvedValue({ update } as any);

    await expect(persistCompletedBacktest({
      jobId: "job-durable-1",
      leaseToken: "current-token",
      values: { metrics: { totalReturn: 12.5 }, summary: "done" },
    }, new Date(12_000))).resolves.toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(capturedSets[0]).toMatchObject({
      status: "completed",
      phase: "COMPLETED",
      progress: 100,
      leaseToken: null,
      metrics: { totalReturn: 12.5 },
      summary: "done",
    });
  });

  it("scheduled callback 只接受 registry 中已啟用的 taskUid", async () => {
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ id: 99 }]),
        })),
      })),
    }));
    vi.mocked(getDb).mockResolvedValue({ select } as any);

    await expect(verifyBacktestWorkerTask("task-backtest-worker")).resolves.toBe(true);
  });
});
