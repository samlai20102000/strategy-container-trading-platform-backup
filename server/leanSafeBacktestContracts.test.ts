import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routerSource = readFileSync("server/routers/backtest.router.ts", "utf8");
const historySource = readFileSync("client/src/components/backtest/BacktestHistory.tsx", "utf8");
const pageSource = readFileSync("client/src/pages/Backtest.tsx", "utf8");

describe("Lean-Safe P1/P2 全鏈路 source contract", () => {
  it("伺服器 compareRuns 只接受已授權、完成且 VALID 的 2-4 筆回測", () => {
    expect(routerSource).toContain("compareRuns: protectedProcedure");
    expect(routerSource).toContain("runIds: z.array(z.string().min(1)).min(2).max(4)");
    expect(routerSource).toContain('dbJob.status !== "completed"');
    expect(routerSource).toContain("if (!dbJob.validity)");
    expect(routerSource).toContain("if (!dbJob.validity.passed)");
    expect(routerSource).toContain("INVALID，禁止策略比較");
  });

  it("所有回測來源參數重用入口都接入 sourceRunId 權威守門", () => {
    expect(routerSource).toContain("async function requireReusableBacktestSourceRun");
    expect(routerSource.match(/await requireReusableBacktestSourceRun\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(routerSource.match(/sourceRunId: z\.string\(\)\.min\(1\)\.max\(128\)\.optional\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(routerSource).toContain("來源回測缺少可驗證的 risk-integrity 證據");
    expect(routerSource).toContain("來源回測為 INVALID，禁止比較或參數重用");
  });

  it("歷史比較 UI 僅勾選 VALID 結果並使用 server compareRuns", () => {
    expect(historySource).toContain('const comparisonEligible = r.status === "completed" && validity?.passed === true');
    expect(historySource).toContain("disabled={!comparisonEligible}");
    expect(historySource).toContain("utils.backtest.compareRuns.fetch");
    expect(historySource).toContain("UNVERIFIED");
  });

  it("即時與歷史報告都接入 canonical validity、riskEvents、legAccounting 與 modeResults", () => {
    expect(pageSource.match(/validity=/g)?.length).toBeGreaterThanOrEqual(2);
    expect(pageSource.match(/riskEvents=/g)?.length).toBeGreaterThanOrEqual(2);
    expect(pageSource.match(/legAccounting=/g)?.length).toBeGreaterThanOrEqual(2);
    expect(pageSource.match(/modeResults=/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
