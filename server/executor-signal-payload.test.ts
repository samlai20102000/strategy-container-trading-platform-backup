import { describe, expect, it } from "vitest";

import { parseSignalPayload } from "./services/executor";

describe("parseSignalPayload deployment-position boundary", () => {
  it("drops externally supplied size and strategy-internal decision fields", () => {
    const parsed = parseSignalPayload({
      action: "buy",
      symbol: "BTCUSDT",
      price: "62500.5",
      barTimestamp: "1721880000000",
      lotUsdt: 999999,
      v25Decision: true,
      v25LayerNum: 99,
      rainbow20415Decision: true,
      rainbow20415LayerNum: 99,
      rainbow20415OrderSize: { value: 999999, mode: "usdt" },
    });

    expect(parsed).toEqual({
      action: "buy",
      symbol: "BTCUSDT",
      price: 62500.5,
      barTimestamp: 1721880000000,
    });
    expect(parsed).not.toHaveProperty("lotUsdt");
    expect(parsed).not.toHaveProperty("v25Decision");
    expect(parsed).not.toHaveProperty("rainbow20415Decision");
    expect(parsed).not.toHaveProperty("rainbow20415OrderSize");
  });
});
