import { describe, expect, it } from "vitest";
import type { BacktestRequest, BacktestResult } from "./backtestEngine";
import {
  buildBacktestResultPersistence,
  buildBacktestHistoryListItem,
  computePersistedBacktestValidity,
  readPersistedBacktestAudit,
} from "./backtestJobManager";

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
    const riskIntegrity = {
      version: "backtest-risk-integrity-v1",
      passed: true,
      enforcement: "RUNTIME_KERNEL",
      violations: [],
    };
    const riskEvents = [{
      eventId: "risk-event-1",
      sequence: 1,
      timestamp: 1,
      eventKind: "ORDER_ADMISSION",
      decisionOutcome: "ACCEPTED",
      reasonCode: "ORDER_ADMITTED",
    }];
    const reentryDiagnostics = { contractVersion: "backtest-reentry-diagnostics-v1" };
    const result = {
      summary: "completed",
      metrics: { totalReturn: 0.08 },
      trades: [],
      equityCurve: [],
      candleCount: 120,
      execution,
      modeResults,
      legAccounting,
      riskIntegrity,
      riskEvents,
      reentryDiagnostics,
    } as unknown as BacktestResult;

    const persisted = buildBacktestResultPersistence(result, request, 100, new Date(200));

    expect(persisted.executionContext).toMatchObject(execution);
    expect(persisted.executionMode).toBe("HEDGE_GUARDED");
    expect(persisted.executionPolicyVersion).toBe("execution-policy-v1");
    expect(persisted.modeResults).toBe(modeResults);
    expect(persisted.legAccounting).toBe(legAccounting);
    expect(persisted.executionContext).toMatchObject({
      riskIntegrity,
      riskEvents,
      reentryDiagnostics,
    });
    expect(readPersistedBacktestAudit(persisted.executionContext)).toEqual({
      riskIntegrity,
      riskEvents,
      reentryDiagnostics,
    });
  });

  it("歷史讀取優先沿用 canonical runtime assessment，不得以 posthoc 重算覆蓋", () => {
    const canonical = {
      version: "backtest-risk-integrity-v1",
      passed: false,
      enforcement: "RUNTIME_KERNEL",
      violations: [{ code: "POST_INSOLVENCY_RECOVERY", message: "invalid" }],
    };
    const validity = computePersistedBacktestValidity({
      status: "completed",
      executionContext: { riskIntegrity: canonical, riskEvents: [] },
    });
    expect(validity).toBe(canonical);
  });

  it("舊完成結果在讀取時偵測負權益後恢復並標記 INVALID", () => {
    const validity = computePersistedBacktestValidity({
      status: "completed",
      jobId: "legacy-insolvency-recovery",
      strategyKey: "TEST_STRATEGY",
      initialCapital: "10000",
      executionMode: "SINGLE_EXCLUSIVE",
      executionPolicy: { mode: "SINGLE_EXCLUSIVE" },
      environment: { leverage: 1 },
      metrics: { totalReturn: 208.5908 },
      tradesData: [],
      equityCurve: [
        { timestamp: 1, equity: 10_000 },
        { timestamp: 2, equity: -3_242.48 },
        { timestamp: 3, equity: 30_859.08 },
      ],
      executionContext: null,
    });

    expect(validity?.passed).toBe(false);
    expect(validity?.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        "EQUITY_BELOW_ZERO",
        "BANKRUPTCY_STATE_MISSING",
        "POST_INSOLVENCY_RECOVERY",
      ]),
    );
  });

  it("未完成或缺少績效證據的歷史結果維持 UNVERIFIED", () => {
    expect(computePersistedBacktestValidity({ status: "failed" })).toBeNull();
    expect(computePersistedBacktestValidity({ status: "completed", metrics: {} })).toBeNull();
  });

  it("歷史列表只回傳輕量摘要，完整交易與曲線只留在伺服器計算 validity", () => {
    const listItem = buildBacktestHistoryListItem({
      jobId: "history-summary",
      status: "completed",
      strategyKey: "TEST_STRATEGY",
      initialCapital: "10000",
      metrics: { totalReturn: 5 },
      tradesData: [{ id: "trade-1" }],
      equityCurve: [
        { timestamp: 1, equity: 10_000 },
        { timestamp: 2, equity: 10_500 },
      ],
      executionContext: {
        riskIntegrity: {
          version: "backtest-risk-integrity-v1",
          passed: true,
          violations: [],
        },
      },
    });

    expect(listItem.validity?.passed).toBe(true);
    expect(listItem.metrics).toEqual({ totalReturn: 5 });
    expect(listItem).not.toHaveProperty("tradesData");
    expect(listItem).not.toHaveProperty("equityCurve");
    expect(listItem).not.toHaveProperty("executionContext");
  });
});
