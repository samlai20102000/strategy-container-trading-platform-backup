import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  V40EntryGatePanel,
  normalizeV40EntryGateValue,
} from "../../client/src/components/V40EntryGatePanel";

describe("V4.0 entry gate shared UI contract", () => {
  it("keeps legacy defaults while preserving every explicit false", () => {
    expect(normalizeV40EntryGateValue(undefined)).toEqual({
      enableThreeKFilter: true,
      threeKPatternMode: "breakout",
      enableKamaDirectionLock: true,
      enableSameDirectionReentry: true,
    });

    expect(normalizeV40EntryGateValue({
      enableThreeKFilter: false,
      threeKPatternMode: "three_body_same_direction",
      enableKamaDirectionLock: false,
      enableSameDirectionReentry: false,
    })).toEqual({
      enableThreeKFilter: false,
      threeKPatternMode: "three_body_same_direction",
      enableKamaDirectionLock: false,
      enableSameDirectionReentry: false,
    });
  });

  it("falls back to breakout when imported mode is outside the two-option enum", () => {
    expect(normalizeV40EntryGateValue({ threeKPatternMode: "both" })).toMatchObject({
      threeKPatternMode: "breakout",
    });
  });

  it("renders the same two mutually exclusive rule choices in strategy and backtest contexts", () => {
    const value = normalizeV40EntryGateValue({
      threeKPatternMode: "three_body_same_direction",
    });
    const render = (context: "strategy" | "backtest") => renderToStaticMarkup(
      createElement(V40EntryGatePanel, {
        value,
        onChange: () => undefined,
        context,
      }),
    );

    for (const html of [render("strategy"), render("backtest")]) {
      expect(html).toContain("V4.0 入場安全閘");
      expect(html).toContain("A｜前兩根同向＋第三根收盤破位");
      expect(html).toContain("B｜三根 K 線實體全部連續同向");
      expect(html).toContain("KAMA 方向鎖");
      expect(html).toContain("特殊原地重入");
      expect(html).toContain("value=\"three_body_same_direction\"");
      expect(html).toContain("aria-checked=\"true\"");
    }
  });

  it("keeps both pages wired to the shared panel and all four payload keys", () => {
    const strategiesSource = readFileSync(
      new URL("../../client/src/pages/Strategies.tsx", import.meta.url),
      "utf8",
    );
    const backtestSource = readFileSync(
      new URL("../../client/src/pages/Backtest.tsx", import.meta.url),
      "utf8",
    );

    for (const source of [strategiesSource, backtestSource]) {
      expect(source).toContain("<V40EntryGatePanel");
      expect(source).toContain("enableThreeKFilter");
      expect(source).toContain("threeKPatternMode");
      expect(source).toContain("enableKamaDirectionLock");
      expect(source).toContain("enableSameDirectionReentry");
    }
  });
});
