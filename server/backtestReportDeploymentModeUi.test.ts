import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const reportSource = readFileSync(
  new URL("../client/src/components/backtest/BacktestReport.tsx", import.meta.url),
  "utf8",
);

describe("BacktestReport S1-only UI 歸因契約", () => {
  it("保留相容資料型別但不再依 M2／H3 腿角色分支顯示", () => {
    expect(reportSource).toContain('deploymentMode?: "S1" | "M2" | "H3"');
    expect(reportSource).toContain('function tradeDeploymentMode(_trade: ReportTrade): "S1"');
    expect(reportSource).toContain('return "S1"');
    expect(reportSource).not.toContain('if (trade.role === "INDEPENDENT") return "M2"');
    expect(reportSource).not.toContain('if (trade.role === "HEDGE") return "H3"');
    expect(reportSource).not.toContain("EXECUTION_MODE_META.MULTI_POSITION");
    expect(reportSource).not.toContain("EXECUTION_MODE_META.HEDGE_GUARDED");
  });

  it("逐筆表格與 CSV 都輸出 S1 模式並保留腿角色及 cycle／leg 稽核身分", () => {
    expect(reportSource).toContain('<TableHead className="text-xs">部署模式</TableHead>');
    expect(reportSource).toContain('const headers = ["時間", "部署模式", "腿角色", "Cycle ID", "Leg ID", "觸發來源", "開倉原因"');
    expect(reportSource).toContain("tradeDeploymentMode(t)");
    expect(reportSource).toContain('t.role ?? "PRIMARY"');
    expect(reportSource).toContain('t.cycleId ?? "legacy-s1"');
    expect(reportSource).toContain('t.legId ?? `legacy-s1:${t.id}`');
    expect(reportSource).toContain('t.triggerSource ?? "LEGACY"');
    expect(reportSource).toContain('t.entryReason ?? "LEGACY_ENTRY"');
  });
});
