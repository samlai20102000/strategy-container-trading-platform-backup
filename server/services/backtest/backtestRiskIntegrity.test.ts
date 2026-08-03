import { describe, expect, it } from "vitest";
import { createDefaultExecutionPolicy } from "../../../shared/executionModes";
import {
  assertBacktestRiskIntegrity,
  assessBacktestRiskIntegrity,
  BacktestRiskIntegrityGuardError,
  type BacktestRiskIntegrityInput,
} from "./backtestRiskIntegrity";

const START = 1_700_000_000_000;

function inputFixture(
  overrides: Partial<BacktestRiskIntegrityInput> = {},
): BacktestRiskIntegrityInput {
  return {
    runId: "risk_integrity_test",
    strategyKey: "TEST_STRATEGY",
    initialCapital: 10_000,
    leverage: 1,
    executionPolicy: createDefaultExecutionPolicy("SINGLE_EXCLUSIVE"),
    trades: [],
    equityCurve: [
      { timestamp: START, equity: 10_000 },
      { timestamp: START + 1, equity: 10_500 },
    ],
    hasRuntimeRiskEvidence: false,
    ...overrides,
  };
}

describe("回測風險完整性守門", () => {
  it("拒絕負權益後又恢復正值的破產後續跑結果", () => {
    const assessment = assessBacktestRiskIntegrity(inputFixture({
      equityCurve: [
        { timestamp: START, equity: 10_000 },
        { timestamp: START + 1, equity: -3_242.48 },
        { timestamp: START + 2, equity: 30_859.08 },
      ],
    }));

    expect(assessment.passed).toBe(false);
    expect(assessment.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        "EQUITY_BELOW_ZERO",
        "BANKRUPTCY_STATE_MISSING",
        "POST_INSOLVENCY_RECOVERY",
      ]),
    );
    expect(() => assertBacktestRiskIntegrity(inputFixture({
      equityCurve: [
        { timestamp: START, equity: 10_000 },
        { timestamp: START + 1, equity: -3_242.48 },
        { timestamp: START + 2, equity: 30_859.08 },
      ],
    }))).toThrow(BacktestRiskIntegrityGuardError);
  });

  it("拒絕 KRM 類型在 S1／1x 下明確超過 gross 與 margin policy 的成交", () => {
    const assessment = assessBacktestRiskIntegrity(inputFixture({
      trades: [{ entryPrice: 107_128.41, size: 3.822515447253175 }],
      equityCurve: [
        { timestamp: START, equity: 10_000 },
        { timestamp: START + 1, equity: 30_859.08 },
      ],
    }));

    expect(assessment.observedEntryNotionalPeak).toBeCloseTo(409_500, 0);
    expect(assessment.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        "GROSS_NOTIONAL_POLICY_BREACH",
        "MARGIN_USAGE_POLICY_BREACH",
      ]),
    );
  });

  it("接受已由 runtime kernel 宣告破產、權益固定為零且不再恢復的有限責任結果", () => {
    const assessment = assessBacktestRiskIntegrity(inputFixture({
      equityCurve: [
        { timestamp: START, equity: 10_000 },
        { timestamp: START + 1, equity: 0 },
        { timestamp: START + 2, equity: 0 },
      ],
      accounting: {
        initialCapital: 10_000,
        realizedPnl: -12_000,
        unrealizedPnl: 0,
        finalEquity: 0,
        expectedFinalEquity: 0,
        reconciliationDifference: 0,
        balanced: true,
        reconciled: true,
        tolerance: 0.02,
        openPosition: null,
        openPositionCount: 0,
        syntheticForceCloseCount: 0,
        bankruptcyAdjustment: 2_000,
        marginLiquidationCount: 1,
        bankrupt: true,
      },
      hasRuntimeRiskEvidence: true,
    }));

    expect(assessment).toMatchObject({
      passed: true,
      enforcement: "RUNTIME_KERNEL",
      minimumEquity: 0,
      recoveredAfterInsolvency: false,
      bankruptcyDeclared: true,
      marginLiquidationCount: 1,
      violations: [],
    });
  });

  it("正常正權益結果通過，但誠實標記為僅完成發布前後驗守門", () => {
    expect(assessBacktestRiskIntegrity(inputFixture())).toMatchObject({
      passed: true,
      enforcement: "POSTHOC_ONLY",
      violations: [],
    });
  });
});
