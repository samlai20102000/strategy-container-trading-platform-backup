import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const homeSource = readFileSync(new URL("../client/src/pages/Home.tsx", import.meta.url), "utf8");
const strategiesSource = readFileSync(new URL("../client/src/pages/Strategies.tsx", import.meta.url), "utf8");

describe("trade report and strategy API UI architecture contract", () => {
  it("has no legacy Block C UI or hidden filter state", () => {
    expect(homeSource).not.toContain("BlockC_Filter");
    expect(homeSource).not.toContain("onGenerateReport");
    expect(homeSource).not.toContain("symbolFilter");
    expect(homeSource).not.toContain("minLayerFilter");
  });

  it("mounts the only report entry and dialog inside the signal journal component", () => {
    const blockEStart = homeSource.indexOf("function BlockE_Signals");
    const blockEEnd = homeSource.indexOf("// BLOCK F:", blockEStart);
    const blockESource = homeSource.slice(blockEStart, blockEEnd);

    expect(blockEStart).toBeGreaterThan(-1);
    expect(blockEEnd).toBeGreaterThan(blockEStart);
    expect(blockESource).toContain("setReportDialogOpen(true)");
    expect(blockESource).toContain("<TradeReportDialog");
    expect(blockESource).toContain("開啟交易報告篩選與生成流程");
    expect(blockESource).toContain('className="min-w-[960px] w-full text-sm"');
    expect(homeSource.match(/<TradeReportDialog/g)).toHaveLength(1);
  });

  it("keeps preflight, zero-row protection, large-export confirmation and both formats in the dialog flow", () => {
    expect(homeSource).toContain("tradeJournal.preflight.query(filters())");
    expect(homeSource).toContain("totalRows === 0");
    expect(homeSource).toContain("confirmLargeExport");
    expect(homeSource).toContain('value="xlsx"');
    expect(homeSource).toContain('value="csv"');
    expect(homeSource).toContain("generateMutation.mutateAsync");
  });

  it("renders the API account identity from the shared strategy-card map", () => {
    expect(strategiesSource).toContain("function StrategyApiAccountIdentity");
    expect(strategiesSource).toContain("<StrategyApiAccountIdentity");
    expect(strategiesSource).toContain("apiKeys={apiKeys}");
    expect(strategiesSource).toContain("data-api-binding-status");
    expect(strategiesSource).toContain("僅顯示安全名稱");
    expect(strategiesSource).toContain("flex-1 break-words font-mono");
    expect(strategiesSource).not.toContain("min-w-0 truncate font-mono text-xs font-medium text-current");
  });
});
