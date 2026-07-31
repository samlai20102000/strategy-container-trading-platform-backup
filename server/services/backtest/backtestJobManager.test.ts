import { describe, expect, it } from "vitest";
import type { BacktestRequest, BacktestResult } from "./backtestEngine";
import { buildBacktestResultPersistence } from "./backtestJobManager";

describe("backtest job 三模式持久化映射", () => {
  it("應以 finalize 後的完整 execution context、modeResults 與 legAccounting 為單一真相", () => {
    const request = {
      strategyKey: "KAMA_3K_HF_V61",
      symbol: "BTC-USDT-SWAP",
      timeframe: "15m",
      startDate: 1,
      endDate: 2,
      initialCapital: 10_000,
      config: {},
      executionMode: "HEDGE_GUARDED",
      executionPolicy: { mode: "HEDGE_GUARDED" },
    } as BacktestRequest;
    const execution = {
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
      executionPolicyVersion: "execution-policy-v1",
      strategyVersion: "v6.1.0",
      strategyLogicHash: "sha256:strategy",
      configHash: "sha256:config",
      policyHash: "sha256:policy",
      dataHash: "sha256:data",
      intrabarEventPolicy: "risk_first",
      intrabarEventPolicyVersion: "intrabar-risk-first-v1",
      riskModelVersion: "backtest-risk-model-v1",
      simulatedAdapterVersion: "simulated-adapter-v1",
      engineVersion: "backtest-engine-v3",
      comparisonGroupId: "comparison:job-persistence",
    };
    const modeResults = {
      version: "backtest-mode-results-v1",
      executionMode: "HEDGE_GUARDED",
      fairComparisonEligible: true,
      fairnessBlockers: [],
    };
    const legAccounting = {
      executionMode: "HEDGE_GUARDED",
      legs: [{ legId: "primary", role: "PRIMARY", realizedPnl: 10 }],
      hedgeRelationships: [{ relationshipId: "hedge-1", pairPnl: 8 }],
    };
    const result = {
      summary: "completed",
      metrics: { totalReturn: 0.08 },
      trades: [],
      equityCurve: [],
      candleCount: 120,
      execution,
      modeResults,
      legAccounting,
    } as unknown as BacktestResult;

    const persisted = buildBacktestResultPersistence(result, request, 100, new Date(200));

    expect(persisted.executionContext).toBe(execution);
    expect(persisted.executionMode).toBe("HEDGE_GUARDED");
    expect(persisted.executionPolicyVersion).toBe("execution-policy-v1");
    expect(persisted.modeResults).toBe(modeResults);
    expect(persisted.legAccounting).toBe(legAccounting);
  });
});
