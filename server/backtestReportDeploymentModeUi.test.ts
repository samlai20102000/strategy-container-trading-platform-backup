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

  it("逐筆表格與五工作表 Excel 都保留 S1、cycle／leg 與 canonical 風險稽核身分", () => {
    expect(reportSource).toContain('<TableHead className="text-xs">部署模式</TableHead>');
    for (const sheet of ["摘要", "交易明細", "權益曲線", "風險事件", "執行與會計"]) {
      expect(reportSource).toContain(`addSheet("${sheet}"`);
    }
    expect(reportSource).not.toContain('addSheet("參數"');
    expect(reportSource).toContain('const exportExcel = async () =>');
    expect(reportSource).toContain('anchor.download = `backtest_${runId}.xlsx`');
    expect(reportSource).toContain("tradeDeploymentMode(t)");
    expect(reportSource).toContain('trade.role ?? "PRIMARY"');
    expect(reportSource).toContain('trade.cycleId ?? "legacy-s1"');
    expect(reportSource).toContain('trade.legId ?? `legacy-s1:${trade.id}`');
    expect(reportSource).toContain('trade.triggerSource ?? "LEGACY"');
    expect(reportSource).toContain('trade.entryReason ?? "LEGACY_ENTRY"');
    expect(reportSource).toContain("Risk event count");
    expect(reportSource).toContain("Gross exposure peak");
    expect(reportSource).toContain("Margin headroom low");
  });

  it("INVALID 與 UNVERIFIED 結果仍可稽核匯出，但全面禁止參數重用", () => {
    expect(reportSource).toContain("const canReuseResult = validity?.passed === true");
    expect(reportSource).toContain("INVALID（風險契約違反）");
    expect(reportSource).toContain("UNVERIFIED");
    expect(reportSource).toContain("依 fail-closed 原則");
    expect(reportSource).toContain("disabled={!canReuseResult}");
    expect(reportSource).toContain("sourceRunId: runId");
  });
});
