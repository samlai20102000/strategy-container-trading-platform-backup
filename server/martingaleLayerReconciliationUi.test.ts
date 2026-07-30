import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "client/src/components/MartingaleLayerPositionPanel.tsx"),
  "utf8",
);

describe("馬丁逐層待對帳 UI 契約", () => {
  it("只在 awaiting_reconciliation 顯示唯讀提示，無持倉仍維持隱藏", () => {
    expect(source).toContain('summary.availability === "no_open_position"');
    expect(source).toContain('summary.availability === "awaiting_reconciliation"');
    expect(source).toContain("data-martingale-layer-reconciliation");
    expect(source).toContain("馬丁逐層持倉待對帳");
  });

  it("待對帳狀態明確禁止推算層價與偽精確盈虧，並宣告零交易副作用", () => {
    expect(source).toContain("系統不會推算各層成交價或顯示偽精確盈虧");
    expect(source).toContain("不會改變策略、持倉或任何下單／平倉行為");
  });
});
