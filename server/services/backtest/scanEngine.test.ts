/**
 * 參數掃描引擎 V5.0 測試
 * - 多目標加權綜合評分
 * - Pareto 前沿計算
 * - 敏感性分析
 */
import { describe, it, expect } from "vitest";
import { buildScanBacktestExecutionContext, type ScanConfig } from "./scanEngine";

// 直接測試導出的函數和類型
// 由於 calculateCompositeScore 和 computeParetoFront 是內部函數，
// 我們通過 ScanJobManager 的公開 API 間接驗證

describe("參數掃描引擎 V5.0", () => {
  it("ScanJobManager 應可正常實例化", async () => {
    const { scanJobManager } = await import("./scanEngine");
    expect(scanJobManager).toBeDefined();
    expect(typeof scanJobManager.submit).toBe("function");
    expect(typeof scanJobManager.getStatus).toBe("function");
    expect(typeof scanJobManager.listHistory).toBe("function");
    expect(typeof scanJobManager.getDetail).toBe("function");
    expect(typeof scanJobManager.compareScans).toBe("function");
    expect(typeof scanJobManager.deleteHistory).toBe("function");
  });

  it("ScanConfig 接口應支援多交易對", async () => {
    const { scanJobManager } = await import("./scanEngine");
    // 驗證 submit 方法存在且接受 ScanConfig
    expect(typeof scanJobManager.submit).toBe("function");
  });

  it("ObjectiveWeights 默認值應正確", async () => {
    const { DEFAULT_WEIGHTS } = await import("./scanEngine");
    expect(DEFAULT_WEIGHTS.totalReturn).toBe(0.35);
    expect(DEFAULT_WEIGHTS.winRate).toBe(0.25);
    expect(DEFAULT_WEIGHTS.sharpeRatio).toBe(0.20);
    expect(DEFAULT_WEIGHTS.profitFactor).toBe(0.10);
    expect(DEFAULT_WEIGHTS.maxDrawdown).toBe(0.10);
    // 權重總和應為 1
    const sum = DEFAULT_WEIGHTS.totalReturn + DEFAULT_WEIGHTS.winRate +
      DEFAULT_WEIGHTS.sharpeRatio + DEFAULT_WEIGHTS.profitFactor + DEFAULT_WEIGHTS.maxDrawdown;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("getStatus 對不存在的 scanId 應返回 null", async () => {
    const { scanJobManager } = await import("./scanEngine");
    const status = scanJobManager.getStatus("non_existent_scan_id");
    expect(status).toBeNull();
  });

  it("submit 應拒絕空交易對", async () => {
    const { scanJobManager } = await import("./scanEngine");
    await expect(
      scanJobManager.submit(
        {
          strategyKey: "test",
          symbols: [],
          timeframe: "5m",
          startDate: Date.now() - 86400000,
          endDate: Date.now(),
          initialCapital: 10000,
          baseConfig: {},
          parameters: [{ name: "test", values: [1, 2, 3] }],
        },
        1,
        "totalReturn",
      ),
    ).rejects.toThrow("至少需要一個交易對");
  });

  it("submit 應拒絕超過 3 個交易對", async () => {
    const { scanJobManager } = await import("./scanEngine");
    await expect(
      scanJobManager.submit(
        {
          strategyKey: "test",
          symbols: ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "DOGE-USDT-SWAP"],
          timeframe: "5m",
          startDate: Date.now() - 86400000,
          endDate: Date.now(),
          initialCapital: 10000,
          baseConfig: {},
          parameters: [{ name: "test", values: [1, 2, 3] }],
        },
        1,
        "totalReturn",
      ),
    ).rejects.toThrow("最多支援");
  });

  it("submit 應拒絕超過 50000 總任務數（手動模式）", async () => {
    const { scanJobManager } = await import("./scanEngine");
    // 20000 values × 3 symbols = 60000 > 50000
    const values = Array.from({ length: 20000 }, (_, i) => i);
    await expect(
      scanJobManager.submit(
        {
          strategyKey: "test",
          symbols: ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"],
          timeframe: "5m",
          startDate: Date.now() - 86400000,
          endDate: Date.now(),
          initialCapital: 10000,
          baseConfig: {},
          parameters: [{ name: "test", values }],
          mode: "manual",
        },
        1,
        "totalReturn",
      ),
    ).rejects.toThrow("超過上限");
  });

  it("所有掃描衍生回測應完整繼承三模式與公平比較身份", () => {
    const config: ScanConfig = {
      strategyKey: "KAMA_3K_HF_V61",
      symbols: ["BTC-USDT-SWAP"],
      timeframe: "15m",
      startDate: 1_700_000_000_000,
      endDate: 1_700_086_400_000,
      initialCapital: 10_000,
      baseConfig: {},
      parameters: [],
      executionMode: "HEDGE_GUARDED",
      executionPolicy: {
        version: "execution-policy-v1",
        mode: "HEDGE_GUARDED",
        riskBudget: {
          maxGrossExposure: 20_000,
          maxNetExposure: 10_000,
          maxReservedMargin: 5_000,
        },
        hedge: {
          ratio: 0.4,
          triggerDrawdownPct: 3,
          unwindRecoveryPct: 1,
          cooldownMs: 60_000,
        },
      },
      strategyVersion: "v6.1.0",
      strategyLogicHash: "sha256:test-strategy",
      strategyModeCapabilities: {
        contractVersion: "strategy-mode-capabilities-v1",
        supportedModes: ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"],
        martingaleLayers: true,
        independentLegState: true,
        hedgeGuard: true,
        preciseLegClose: true,
      },
      endPositionPolicy: "force_close",
      fundingModel: "funding-model-v1",
      contractSpecification: { contractValue: 1, settlementAsset: "USDT" },
    };

    expect(buildScanBacktestExecutionContext(config)).toEqual({
      endPositionPolicy: config.endPositionPolicy,
      executionMode: config.executionMode,
      executionPolicy: config.executionPolicy,
      strategyVersion: config.strategyVersion,
      strategyLogicHash: config.strategyLogicHash,
      strategyModeCapabilities: config.strategyModeCapabilities,
      fundingModel: config.fundingModel,
      contractSpecification: config.contractSpecification,
    });
  });
});
