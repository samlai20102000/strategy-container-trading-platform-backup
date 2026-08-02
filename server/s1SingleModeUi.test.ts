import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../client/src/${relativePath}`, import.meta.url), "utf8");
}

const s1OnlyUiFiles = [
  "pages/DeploymentWorkbench.tsx",
  "pages/Strategies.tsx",
  "pages/Home.tsx",
  "pages/Positions.tsx",
  "pages/Signals.tsx",
  "components/DashboardLayout.tsx",
  "components/ExecutionModeConfigurator.tsx",
  "components/ExecutionProfileSummary.tsx",
  "components/backtest/BacktestHistory.tsx",
];

describe("S1 單模式 UI 防回歸契約", () => {
  it.each(s1OnlyUiFiles)("%s 不包含 M2／H3 可見模式或切換入口", (relativePath) => {
    const uiSource = source(relativePath);
    expect(uiSource).not.toMatch(/\bM2\b|\bH3\b|MULTI_POSITION|HEDGE_GUARDED|三模式|雙向獨立|保護對沖/);
    expect(uiSource).not.toContain("trpc.deployments.switchMode.useMutation");
    expect(uiSource).not.toContain("strategy-mode-controls");
  });

  it("共用模式設定元件固定提交 S1 且保留共通風控欄位", () => {
    const configurator = source("components/ExecutionModeConfigurator.tsx");
    expect(configurator).toContain('mode: "SINGLE_EXCLUSIVE"');
    expect(configurator).toContain("maxGrossNotionalPct");
    expect(configurator).toContain("maxMarginUsagePct");
    expect(configurator).toContain("capabilityTtlSeconds");
  });

  it("部署工作台的可選模式集合只保留 SINGLE_EXCLUSIVE", () => {
    const workbench = source("pages/DeploymentWorkbench.tsx");
    expect(workbench).toMatch(/const EXECUTION_MODES: ExecutionMode\[\] = \[\s*"SINGLE_EXCLUSIVE",?\s*\]/);
    expect(workbench).not.toContain("modeOpen");
    expect(workbench).not.toContain("openModeDialog");
  });

  it("回測報告只使用 S1 顯示 metadata，仍保留相容資料欄位", () => {
    const report = source("components/backtest/BacktestReport.tsx");
    expect(report).toContain("S1_EXECUTION_MODE_META");
    expect(report).toContain('deploymentMode?: "S1" | "M2" | "H3"');
    expect(report).not.toContain("EXECUTION_MODE_META.MULTI_POSITION");
    expect(report).not.toContain("EXECUTION_MODE_META.HEDGE_GUARDED");
  });
});
