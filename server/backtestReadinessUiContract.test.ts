import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const backtestSource = readFileSync(
  new URL("../client/src/pages/Backtest.tsx", import.meta.url),
  "utf8",
);

describe("backtest readiness UI contract", () => {
  it("queries the same authoritative admission contract and fails closed before submission", () => {
    expect(backtestSource).toContain("trpc.backtest.getReadiness.useQuery");
    expect(backtestSource).toContain("if (!readinessAssessment)");
    expect(backtestSource).toContain("if (!readinessAssessment.allowed)");
    expect(backtestSource).toContain("disabled={runMutation.isPending || readinessBlocked");
    expect(backtestSource).toContain("describeBacktestReadinessReason");
  });

  it("keeps readiness, data-quality prerequisites, block reasons and metric v2 semantics visible", () => {
    expect(backtestSource).toContain('data-testid="backtest-readiness-card"');
    expect(backtestSource).toContain("最低資料量");
    expect(backtestSource).toContain("資料品質守門");
    expect(backtestSource).toContain("阻擋理由");
    expect(backtestSource).toContain("限制與注意事項");
    expect(backtestSource).toContain('data-testid="performance-metric-spec"');
    expect(backtestSource).toContain("BACKTEST_PERFORMANCE_METRIC_DESCRIPTIONS_ZH_TW");
  });
});
