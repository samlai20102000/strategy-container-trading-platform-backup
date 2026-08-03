import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { downsampleEquityCurve } from "./equityCurveDownsample";
import type { EquityPoint } from "./performanceCalculator";

function makeCurve(length: number, equity = 10_000): EquityPoint[] {
  return Array.from({ length }, (_, index) => ({
    timestamp: index,
    equity,
    price: 100,
  }));
}

describe("risk-aware equity curve downsampling", () => {
  it("永遠保留等距抽樣本來會漏掉的瞬時破產與恢復點", () => {
    const curve = makeCurve(5_003);
    curve[1_234] = { timestamp: 1_234, equity: 12_000, price: 100 };
    curve[1_235] = { timestamp: 1_235, equity: -250, price: 100 };
    curve[1_236] = { timestamp: 1_236, equity: 11_500, price: 100 };

    const sampled = downsampleEquityCurve(curve, 100);
    const timestamps = sampled.map(point => point.timestamp);

    expect(sampled).toHaveLength(101);
    expect(timestamps).toContain(1_234);
    expect(timestamps).toContain(1_235);
    expect(timestamps).toContain(1_236);
    expect(sampled.some(point => point.equity <= 0)).toBe(true);
  });

  it("保留最大回撤的峰谷，即使兩點都不是全期間最高或最低", () => {
    const curve = makeCurve(4_001, 11_000);
    curve[100] = { timestamp: 100, equity: 20_000, price: 100 };
    curve[101] = { timestamp: 101, equity: 15_000, price: 100 };
    curve[2_345] = { timestamp: 2_345, equity: 18_000, price: 100 };
    curve[2_346] = { timestamp: 2_346, equity: 8_000, price: 100 };
    curve[3_000] = { timestamp: 3_000, equity: 7_000, price: 100 };

    const sampled = downsampleEquityCurve(curve, 80);
    const timestamps = sampled.map(point => point.timestamp);

    expect(timestamps).toContain(100);
    expect(timestamps).toContain(3_000);
  });

  it("短曲線保持原物件與原順序", () => {
    const curve = makeCurve(20);
    expect(downsampleEquityCurve(curve, 2_000)).toBe(curve);
  });

  it("主引擎與兩個專屬 runner 都不得再保留本地等距 downsample", () => {
    const files = [
      "server/services/backtest/backtestEngine.ts",
      "server/services/backtest/kamaRainbowMartinBacktest.ts",
      "server/services/backtest/rainbowTrendLadderBacktest.ts",
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain('downsampleEquityCurve as downsample');
      expect(source).not.toMatch(/function downsample\s*\(/);
    }
  });
});
