import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const reportSource = readFileSync(
  new URL("../client/src/components/backtest/BacktestReport.tsx", import.meta.url),
  "utf8",
);

describe("BacktestReport 三模式逐筆歸因契約", () => {
  it("保留後端提供的 S1／M2／H3 部署模式並為舊報告依腿角色回退", () => {
    expect(reportSource).toContain('deploymentMode?: "S1" | "M2" | "H3"');
    expect(reportSource).toContain('if (trade.deploymentMode) return trade.deploymentMode');
    expect(reportSource).toContain('if (trade.role === "INDEPENDENT") return "M2"');
    expect(reportSource).toContain('if (trade.role === "HEDGE") return "H3"');
    expect(reportSource).toContain('return "S1"');
  });

  it("逐筆表格與 CSV 都輸出部署模式、腿角色及 cycle／leg 身分", () => {
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
