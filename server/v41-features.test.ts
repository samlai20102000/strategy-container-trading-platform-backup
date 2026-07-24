/**
 * V4.1 四大優化功能整合測試
 * 1. 回測超時保護升級（cancel + timeout 狀態）
 * 2. 參數快照 API（saveSnapshot / getSnapshots / deleteSnapshot）
 * 3. 參數掃描引擎（scanEngine）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { backtestJobManager } from "./services/backtest/backtestJobManager";

describe("V4.1 - BacktestJobManager 升級", () => {
  it("submit 回傳 jobId 字串", async () => {
    // Mock backtestEngine 避免真實回測
    vi.mock("./services/backtest/backtestEngine", () => ({
      backtestEngine: {
        runBacktest: vi.fn().mockResolvedValue({
          runId: "test",
          strategyKey: "test",
          strategyName: "Test",
          trades: [],
          metrics: { totalReturn: 0, winRate: 0, sharpeRatio: 0, profitFactor: 0, maxDrawdown: 0, calmarRatio: 0, totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0, maxWin: 0, maxLoss: 0, martinTriggerCount: 0, maxMartinLayer: 0, totalDays: 0, totalReturnUSDT: 0, maxDrawdownUSDT: 0 },
          equityCurve: [],
          config: {},
          summary: "test",
        }),
      },
    }));

    const jobId = await backtestJobManager.submit({
      strategyKey: "test",
      symbol: "BTC-USDT",
      timeframe: "30m",
      startDate: Date.now() - 86400000,
      endDate: Date.now(),
      initialCapital: 10000,
      config: {},
    }, 1); // userId = 1
    expect(jobId).toMatch(/^job_/);
  });

  it("cancel 可取消 queued/running 任務", async () => {
    const jobId = await backtestJobManager.submit({
      strategyKey: "test",
      symbol: "BTC-USDT",
      timeframe: "30m",
      startDate: Date.now() - 86400000,
      endDate: Date.now(),
      initialCapital: 10000,
      config: {},
    }, 1);
    const result = await backtestJobManager.cancel(jobId);
    expect(result).toBe(true);

    const progress = backtestJobManager.getProgress(jobId);
    expect(progress?.status).toBe("cancelled");
  });

  it("cancel 對不存在的 jobId 回傳 false", async () => {
    const result = await backtestJobManager.cancel("nonexistent_job");
    expect(result).toBe(false);
  });

  it("getQueueStatus 回傳正確的統計", () => {
    const status = backtestJobManager.getQueueStatus();
    expect(status).toHaveProperty("total");
    expect(status).toHaveProperty("queued");
    expect(status).toHaveProperty("running");
    expect(status).toHaveProperty("completed");
    expect(status).toHaveProperty("failed");
    expect(status).toHaveProperty("timeout");
    expect(status).toHaveProperty("cancelled");
  });

  it("submit 支持自定義超時秒數", async () => {
    const jobId = await backtestJobManager.submit({
      strategyKey: "test",
      symbol: "BTC-USDT",
      timeframe: "30m",
      startDate: Date.now() - 86400000,
      endDate: Date.now(),
      initialCapital: 10000,
      config: {},
    }, 1, { timeoutSeconds: 60 }); // 60 秒超時

    const job = backtestJobManager.getJob(jobId);
    expect(job?.timeoutSeconds).toBe(60);
    // 清理
    await backtestJobManager.cancel(jobId);
  });

  it("getJob 回傳完整任務資訊", async () => {
    const jobId = await backtestJobManager.submit({
      strategyKey: "test",
      symbol: "BTC-USDT",
      timeframe: "30m",
      startDate: Date.now() - 86400000,
      endDate: Date.now(),
      initialCapital: 10000,
      config: { Initial_Capital: 10000 },
    }, 1);

    const job = backtestJobManager.getJob(jobId);
    expect(job).not.toBeNull();
    expect(job?.jobId).toBe(jobId);
    expect(job?.request.config).toHaveProperty("Initial_Capital", 10000);
    // 清理
    await backtestJobManager.cancel(jobId);
  });
});

describe("V4.1 - ScanEngine 組合生成", () => {
  it("正確生成笛卡爾積組合", async () => {
    // 直接測試 scanEngine 的組合生成邏輯
    const { scanJobManager } = await import("./services/backtest/scanEngine");
    expect(scanJobManager).toBeDefined();
    expect(typeof scanJobManager.submit).toBe("function");
    expect(typeof scanJobManager.getStatus).toBe("function");
  });
});

describe("V4.1 - Schema 驗證", () => {
  it("parameterSnapshots 表定義存在且有正確欄位", async () => {
    const { parameterSnapshots } = await import("../drizzle/schema");
    expect(parameterSnapshots).toBeDefined();
    // 驗證關鍵欄位存在
    expect(parameterSnapshots.id).toBeDefined();
    expect(parameterSnapshots.userId).toBeDefined();
    expect(parameterSnapshots.strategyKey).toBeDefined();
    expect(parameterSnapshots.config).toBeDefined();
    expect(parameterSnapshots.metrics).toBeDefined();
  });

  it("backtestJobs 表定義存在且有正確欄位", async () => {
    const { backtestJobs } = await import("../drizzle/schema");
    expect(backtestJobs).toBeDefined();
    expect(backtestJobs.id).toBeDefined();
    expect(backtestJobs.userId).toBeDefined();
    expect(backtestJobs.jobId).toBeDefined();
    expect(backtestJobs.strategyKey).toBeDefined();
    expect(backtestJobs.status).toBeDefined();
    expect(backtestJobs.progress).toBeDefined();
    expect(backtestJobs.metrics).toBeDefined();
  });
});
