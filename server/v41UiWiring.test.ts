import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const backtestSource = readFileSync(
  new URL("../client/src/pages/Backtest.tsx", import.meta.url),
  "utf8",
);
const strategiesSource = readFileSync(
  new URL("../client/src/pages/Strategies.tsx", import.meta.url),
  "utf8",
);
const snapshotsSource = readFileSync(
  new URL("../client/src/pages/ParameterSnapshots.tsx", import.meta.url),
  "utf8",
);
const executionModeConfiguratorSource = readFileSync(
  new URL("../client/src/components/ExecutionModeConfigurator.tsx", import.meta.url),
  "utf8",
);

describe("V4.1 三頁共用 UI 接線契約", () => {
  it("回測中心顯示 AND/OR、n/3 並以 0/3 fail-closed 封鎖提交", () => {
    expect(backtestSource).toContain("V41EntryConditionsPanel");
    expect(backtestSource).toContain("入場邏輯：{cfg.entryConditionLogic.toUpperCase()}");
    expect(backtestSource).toContain("ENTRY CONDITIONS {countEnabledV41EntryConditions(cfg)}/3");
    expect(backtestSource).toContain("disabled={runMutation.isPending || Boolean(v41Validation && !v41Validation.valid)}");
    expect(backtestSource).toContain("disabled={saveSnapshotMutation.isPending || Boolean(v41Validation && !v41Validation.valid)}");
  });

  it("回測中心主要與 fallback 清單都只採用 BACKTEST capability，V4.1 不會再被 LIVE S1-only 誤鎖", () => {
    expect(backtestSource.match(/modeCapabilities: s\.backtestModeCapabilities as StrategyModeCapabilities/g)).toHaveLength(2);
    expect(backtestSource).not.toContain("modeCapabilities: s.modeCapabilities as StrategyModeCapabilities");
    expect(executionModeConfiguratorSource).toContain('context === "backtest" ? "BACKTEST"');
    expect(executionModeConfiguratorSource).toContain("回測、快照與部署均採用 S1 單倉獨占政策");
    expect(executionModeConfiguratorSource).not.toContain("MULTI_POSITION");
    expect(executionModeConfiguratorSource).not.toContain("HEDGE_GUARDED");
  });

  it("策略交易頁用 canonical 空白預設並同時封鎖無效表單及無效快照", () => {
    expect(strategiesSource).toContain("const nextConfig = prev.v4_1 ?? createV41DefaultConfig()");
    expect(strategiesSource).toContain("const v41SubmitBlocked = snapshotImportSource?.strategyKey === V41_STRATEGY_KEY");
    expect(strategiesSource).toContain("disabled={saving || v41SubmitBlocked || kamaRainbowMartinSubmitBlocked}");
    expect(strategiesSource).toContain("startsDisabled: variables.strategyKey === V41_STRATEGY_KEY");
    expect(strategiesSource).toContain("V4.1 新策略預設停用，目前不會自動下單");
  });

  it("參數快照庫顯示 AND/OR 與 n/3，詳情保持唯讀且驗證警告不封鎖瀏覽", () => {
    expect(snapshotsSource).toContain("getV41SnapshotDisplay");
    expect(snapshotsSource).toContain("入場邏輯：{display.config.entryConditionLogic.toUpperCase()}");
    expect(snapshotsSource).toContain("{countEnabledV41EntryConditions(display.config)}/3 條件");
    expect(snapshotsSource).toContain("Canonical 驗證警告（不封鎖唯讀瀏覽）");
    expect(snapshotsSource).toContain("<V41EntryConditionsPanel");
    expect(snapshotsSource).toContain("readOnly");
    expect(snapshotsSource).toContain("validationIssues={viewV41Display.validation.issues}");
  });

  it("參數快照複製流程明示 V4.1 新實例預設停用", () => {
    expect(snapshotsSource).toContain("V4.1 快照複製為新策略後預設停用，必須人工覆核後才可啟用");
  });
});
