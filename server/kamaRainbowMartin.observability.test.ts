import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("Kama 彩虹馬丁可觀測性契約", () => {
  it("S1 與 advanced 訊號皆封印當次執行模式，不以日後策略狀態反推", () => {
    const generator = source("server/services/autoTradeSignalGenerator.ts");
    const advanced = source("server/services/kamaRainbowMartinAdvancedSignal.ts");

    expect(generator).toContain("kamaRainbowMartinExecutionMode: executionPolicy.mode");
    expect(advanced).toContain("kamaRainbowMartinExecutionMode:");
    expect(advanced).toContain("input.mode");
  });

  it("訊號日誌提供 KRM 專屬 reason、mode、cycle、leg、layer、revision 與 event key 稽核面板", () => {
    const signalsPage = source("client/src/pages/Signals.tsx");
    const traceContract = source("shared/observability/kamaRainbowMartinSignalTrace.ts");

    expect(signalsPage).toContain('data-testid="krm-signal-audit"');
    expect(traceContract).toContain("kamaRainbowMartinReasonCode");
    expect(traceContract).toContain("kamaRainbowMartinExecutionMode");
    expect(traceContract).toContain("kamaRainbowMartinCycleId");
    expect(traceContract).toContain("kamaRainbowMartinLegId");
    expect(traceContract).toContain("kamaRainbowMartinLayerNum");
    expect(traceContract).toContain("kamaRainbowMartinConfigRevision");
    expect(traceContract).toContain("kamaRainbowMartinEventKey");
    expect(signalsPage).toContain("未封印欄位不會由目前策略狀態反推");
  });

  it("訊號展開列橫跨完整十欄，避免 KRM 稽核面板在訊息欄下方錯位", () => {
    const signalsPage = source("client/src/pages/Signals.tsx");
    expect(signalsPage).toContain('colSpan={10}');
  });

  it("Dashboard 使用 canonical KRM key 並顯示腿級 cycle、KAMA slope 與 trailing 證據", () => {
    const dashboard = source("client/src/pages/Home.tsx");
    expect(dashboard).toContain("KAMA_RAINBOW_MARTIN_STRATEGY_KEY");
    expect(dashboard).toContain("Cycle：{leg.cycleId}");
    expect(dashboard).toContain("KAMA Slopes");
    expect(dashboard).toContain("Trailing 觸發線");
    expect(dashboard).toContain("Ledger 更新");
  });

  it("部署工作台呈現最近 canonical mode decision、target leg、cycle 與 reason code", () => {
    const workbench = source("client/src/pages/DeploymentWorkbench.tsx");
    expect(workbench).toContain('data-testid="canonical-mode-decisions"');
    expect(workbench).toContain("row.reasonCode");
    expect(workbench).toContain("row.legId");
    expect(workbench).toContain("row.cycleId");
    expect(workbench).toContain("row.decisionId");
  });

  it("Heartbeat 寫入 KRM trace 並由策略頁共用解碼器顯示", () => {
    const runtime = source("server/_core/index.ts");
    const strategiesPage = source("client/src/pages/Strategies.tsx");
    expect(runtime).toContain("appendKamaRainbowMartinHeartbeatTrace");
    expect(runtime).toContain("kamaRainbowMartinExecutionMode");
    expect(strategiesPage).toContain("parseKamaRainbowMartinHeartbeatDetail");
    expect(strategiesPage).toContain('data-testid="krm-heartbeat-trace"');
  });

  it("交易日誌只以 owner-scoped signalId 關聯封印 payload，成交與 PnL 真相欄位不被重寫", () => {
    const database = source("server/db.ts");
    const router = source("server/routers.ts");
    const positionsPage = source("client/src/pages/Positions.tsx");
    expect(database).toContain("listSignalsByIds(userId: number, ids: number[])");
    expect(database).toContain("eq(signals.userId, userId)");
    expect(router).toContain("row.signalId ? signalById.get(row.signalId)");
    expect(router).toContain("kamaRainbowMartinTrace:");
    expect(positionsPage).toContain('data-testid="krm-trade-trace"');
    expect(positionsPage).toContain("成交與盈虧維持交易表真相");
  });

  it("訊號與交易日誌使用真實頁面路由而非重導回 Dashboard", () => {
    const app = source("client/src/App.tsx");
    expect(app).toContain('<Route path={"/signals"} component={Signals} />');
    expect(app).toContain('<Route path={"/positions"} component={Positions} />');
    expect(app).not.toContain("window.location.href = '/'");
  });
});
