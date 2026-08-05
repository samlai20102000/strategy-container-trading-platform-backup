import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KamaRainbowMartinLineSetReceiptPanel } from "../client/src/components/KamaRainbowMartinConfigPanel";
import { createKamaRainbowMartinDefaultConfig } from "../shared/strategies/kamaRainbowMartin";

describe("KRM line-set receipt UI contract", () => {
  it("renders all six enabled line IDs, binding source, hashes, and entry semantics", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    config.kamaLines.push(
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `KAMA_${index + 3}`,
        name: `KAMA ${index + 3}`,
        erPeriod: 30 + index * 10,
        fastEma: 2,
        slowEma: 30 + index,
        enabled: true,
        color: `#${(index + 3).toString(16).padStart(6, "0")}`,
      })),
    );

    const html = renderToStaticMarkup(createElement(KamaRainbowMartinLineSetReceiptPanel, {
      config,
      source: "strategy-binding",
    }));

    expect(html).toContain("6/6 ENABLED");
    expect(html).toContain("策略綁定");
    expect(html).toContain("Line-set hash");
    expect(html).toContain("Config hash");
    expect(html).toContain("全部啟用線斜率同向");
    for (const line of config.kamaLines) expect(html).toContain(line.id);
  });

  it("renders a fail-closed warning instead of inventing a two-line receipt", () => {
    const html = renderToStaticMarkup(createElement(KamaRainbowMartinLineSetReceiptPanel, {
      config: undefined,
      source: "live-binding",
    }));

    expect(html).toContain("KAMA 入市線集合不可執行");
    expect(html).toContain("KRM_CONFIG_MISSING");
    expect(html).not.toContain("2/2 ENABLED");
  });
});
