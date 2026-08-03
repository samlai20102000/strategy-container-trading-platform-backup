import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_STRATEGY_KEYS } from "../strategyRunnerDescriptors";
import { createDefaultExecutionPolicy } from "../../../shared/executionModes";
import { assessBacktestRiskIntegrity } from "./backtestRiskIntegrity";

describe("backtest risk integrity coverage", () => {
  const engineSource = readFileSync(
    resolve(process.cwd(), "server/services/backtest/backtestEngine.ts"),
    "utf8",
  );

  it("locks the current nine built-in strategies to the shared finalizer guard", () => {
    expect(BUILT_IN_STRATEGY_KEYS).toHaveLength(9);
    for (const strategyKey of BUILT_IN_STRATEGY_KEYS) {
      const assessment = assessBacktestRiskIntegrity({
        runId: `coverage:${strategyKey}`,
        strategyKey,
        initialCapital: 10_000,
        leverage: 1,
        executionPolicy: createDefaultExecutionPolicy("SINGLE_EXCLUSIVE"),
        trades: [],
        equityCurve: [
          { timestamp: 1, equity: 10_000, price: 100 },
          { timestamp: 2, equity: 10_100, price: 101 },
        ],
        hasRuntimeRiskEvidence: true,
      });
      expect(assessment.passed).toBe(true);
    }

    expect(engineSource).toContain("const riskIntegrity = assertBacktestRiskIntegrity");
    expect(engineSource).toContain("assertBacktestRiskIntegrity,");
    expect(engineSource).toContain("riskIntegrity,");
  });

  it("contains no direct S1 runner return that bypasses finalizeV25Result", () => {
    const unsafeDirectReturn = /return\s+(?:await\s+)?(?:this\.)?(?:runRainbow20415Backtest|runRainbowTrendLadderBacktest|runKamaRainbowMartinBacktest|runV25Backtest|runGenericBacktest|runV70Backtest)\s*\(/;
    expect(engineSource).not.toMatch(unsafeDirectReturn);

    const finalizedRunnerCalls = engineSource.match(
      /return\s+this\.finalizeV25Result\(await\s+(?:this\.)?[A-Za-z0-9_]+Backtest\s*\(/g,
    ) ?? [];
    expect(finalizedRunnerCalls.length).toBeGreaterThanOrEqual(6);
  });
});
