import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) => readFileSync(
  new URL(`../${relativePath}`, import.meta.url),
  "utf8",
);

describe("Kama 彩虹馬丁自動重入與 S1 UI 契約", () => {
  it("共用 KRM 設定面板以 canonical reentryEnabled 驅動可存取開關", () => {
    const panel = readSource("client/src/components/KamaRainbowMartinConfigPanel.tsx");

    expect(panel).toContain("自動重新入市（Auto Re-entry）");
    expect(panel).toContain('aria-label="自動重新入市"');
    expect(panel).toContain("checked={config.reentryEnabled}");
    expect(panel).toContain("updateConfig({ reentryEnabled })");
  });

  it("從側欄與全部回測策略配置移除指定 S1 UI，但保留部署路由與底層風控元件", () => {
    const dashboard = readSource("client/src/components/DashboardLayout.tsx");
    const backtest = readSource("client/src/pages/Backtest.tsx");
    const strategies = readSource("client/src/pages/Strategies.tsx");
    const app = readSource("client/src/App.tsx");
    const hiddenPolicyComponent = readSource("client/src/components/ExecutionModeConfigurator.tsx");

    expect(dashboard).not.toContain("S1 部署");
    expect(backtest).not.toContain("<ExecutionModeConfigurator");
    expect(backtest).not.toContain("S1 單模式與風控政策");
    expect(backtest).not.toContain("S1 單倉獨占");
    expect(strategies).not.toContain("<ExecutionProfileSummary");
    expect(strategies).not.toContain("建立 S1 停用部署草稿");
    expect(strategies).not.toContain("部署工作台");
    expect(strategies).not.toContain("Preflight 與生命週期");
    expect(strategies).not.toContain("canonical deployment");

    expect(app).toContain('path={"/deployments"}');
    expect(app).toContain("DeploymentWorkbench");
    expect(hiddenPolicyComponent).toContain("S1 單模式與風控政策");
    expect(hiddenPolicyComponent).toContain('aria-label="S1 單倉獨占"');
  });
});
