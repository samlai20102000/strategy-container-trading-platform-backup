import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const strategiesSource = readFileSync(
  new URL("../client/src/pages/Strategies.tsx", import.meta.url),
  "utf8",
);

describe("Strategies 行動版響應式佈局契約", () => {
  it("標題與主要操作在窄螢幕採垂直排列及可換行寬度", () => {
    expect(strategiesSource).toContain(
      'className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"',
    );
    expect(strategiesSource).toContain(
      'className="flex w-full flex-wrap gap-2 sm:w-auto sm:flex-nowrap"',
    );
    expect(strategiesSource).toContain(
      'className="min-w-0 flex-1 border-cyan-600 text-cyan-400 hover:bg-cyan-600/10 sm:flex-none"',
    );
  });

  it("每張策略卡片的八個操作在行動版使用有界三欄網格", () => {
    expect(strategiesSource).toContain(
      'className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-center"',
    );
    expect(strategiesSource).toContain(
      'className="h-8 w-full shrink-0 text-destructive hover:text-destructive sm:w-8"',
    );
  });

  it("響應式修改沒有移除既有交易及狀態操作處理器", () => {
    expect(strategiesSource).toContain('status: "paused"');
    expect(strategiesSource).toContain('status: "stopped"');
    expect(strategiesSource).toContain("closeMutation.mutate({ id: s.id, pauseAfterClose: true })");
    expect(strategiesSource).toContain("resetStateMutation.mutate({ id: s.id })");
    expect(strategiesSource).toContain("testSignalMutation.mutate({ strategyId: s.id })");
    expect(strategiesSource).toContain("deleteMutation.mutate({ id: s.id })");
  });

  it("以 activationState 判斷 canonical deployment，不再把 executionMode 誤當 LEGACY 狀態", () => {
    expect(strategiesSource).toContain('strategyActivationState(strategy.activationState) !== "LEGACY"');
    expect(strategiesSource).not.toContain('(s as any).executionMode !== "LEGACY"');
    expect(strategiesSource).not.toContain('(s as any).executionMode === "LEGACY"');
  });

  it("策略卡只顯示 S1 Execution Profile，沒有模式選項或切換 mutation", () => {
    expect(strategiesSource).toContain("<ExecutionProfileSummary");
    expect(strategiesSource).toContain("建立 S1 停用部署草稿");
    expect(strategiesSource).not.toContain("EXECUTION_MODES.map((mode)");
    expect(strategiesSource).not.toContain("strategy-mode-controls-${s.id}");
    expect(strategiesSource).not.toContain("trpc.deployments.switchMode.useMutation");
    expect(strategiesSource).not.toContain("switchCanonicalDeploymentMode");
  });

  it("LEGACY 策略只能建立 S1 停用部署草稿，不會直接啟用或送單", () => {
    expect(strategiesSource).toContain("trpc.deployments.create.useMutation");
    expect(strategiesSource).toContain('const executionMode: ExecutionMode = "SINGLE_EXCLUSIVE"');
    expect(strategiesSource).toContain("sourceStrategyId: strategy.id");
    expect(strategiesSource).toContain("建立後不會送單、不會自動啟用");
    expect(strategiesSource).toContain("DEPLOYMENT_SAFETY_COPY.defaultDisabled");
  });
});
