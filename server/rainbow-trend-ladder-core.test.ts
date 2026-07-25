import { describe, expect, it } from "vitest";
import type { KLineData } from "./strategies/base";
import {
  calculateRainbowTrendLadderLineSnapshot,
  calculateRainbowTrendLadderSmaSeries,
  createRainbowTrendLadderRuntimeState,
  evaluateRainbowTrendLadderEntry,
} from "./strategies/rainbowTrendLadder/core";

const BAR_MS = 30 * 60_000;

function candlesFromCloses(
  closes: readonly number[],
  direction: "long" | "short",
  band: "wide" | "narrow" = "wide",
): KLineData[] {
  const highOffset = band === "narrow" ? 2 : direction === "long" ? 30 : 38.1;
  const lowOffset = band === "narrow" ? -2 : direction === "long" ? -38.1 : -30;
  return closes.map((close, index) => ({
    timestamp: (index + 1) * BAR_MS,
    open: close,
    high: close + highOffset,
    low: close + lowOffset,
    close,
    volume: 1,
  }));
}

function longSignalCandles(band: "wide" | "narrow" = "wide"): KLineData[] {
  return candlesFromCloses([
    ...Array(46).fill(100),
    ...Array(8).fill(108),
    ...Array(6).fill(100),
    121,
  ], "long", band);
}

function shortSignalCandles(): KLineData[] {
  return candlesFromCloses([
    ...Array(46).fill(200),
    ...Array(8).fill(192),
    ...Array(6).fill(200),
    179,
  ], "short");
}

describe("七彩虹線 M30 進場純核心", () => {
  it("依 Close／HLC3／High／Low 計算 SMA，不混用價格來源", () => {
    const candles: KLineData[] = [
      { timestamp: 1, open: 10, high: 14, low: 8, close: 11, volume: 1 },
      { timestamp: 2, open: 12, high: 16, low: 10, close: 13, volume: 1 },
      { timestamp: 3, open: 14, high: 18, low: 12, close: 15, volume: 1 },
    ];
    expect(calculateRainbowTrendLadderSmaSeries(candles, { period: 2, source: "close" })).toEqual([null, 12, 14]);
    expect(calculateRainbowTrendLadderSmaSeries(candles, { period: 2, source: "high" })).toEqual([null, 15, 17]);
    expect(calculateRainbowTrendLadderSmaSeries(candles, { period: 2, source: "low" })).toEqual([null, 9, 11]);
    expect(calculateRainbowTrendLadderSmaSeries(candles, { period: 2, source: "hlc3" })).toEqual([null, 12, 14]);
  });

  it("只在 L1-L4 同升、L4>L3>L1>L2、L5 上穿 L1、收盤價高於 L1 且位於 L6/L7 時買入", () => {
    const candles = longSignalCandles();
    const snapshot = calculateRainbowTrendLadderLineSnapshot(candles);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.trendDirection).toBe("UP");
    expect(snapshot.longArrangement).toBe(true);
    expect(snapshot.current.L4).toBeGreaterThan(snapshot.current.L3!);
    expect(snapshot.current.L3).toBeGreaterThan(snapshot.current.L1!);
    expect(snapshot.current.L1).toBeGreaterThan(snapshot.current.L2!);
    expect(snapshot.longTriggerCross).toBe(true);
    expect(snapshot.longPriceRelativeToL1).toBe(true);
    expect(snapshot.triggerInsideVolatilityBand).toBe(true);

    const decision = evaluateRainbowTrendLadderEntry({
      candles,
      state: createRainbowTrendLadderRuntimeState(),
      spreadPoints: 1,
    });
    expect(decision.action).toBe("buy");
    expect(decision.orderSize).toEqual({ value: 100, mode: "usdt" });
    expect(decision.layerNum).toBe(1);
  });

  it("只在對稱空頭條件成立時賣出，空頭觸發同樣以 L1 為基準", () => {
    const candles = shortSignalCandles();
    const snapshot = calculateRainbowTrendLadderLineSnapshot(candles);
    expect(snapshot.trendDirection).toBe("DOWN");
    expect(snapshot.shortArrangement).toBe(true);
    expect(snapshot.current.L4).toBeLessThan(snapshot.current.L3!);
    expect(snapshot.current.L3).toBeLessThan(snapshot.current.L1!);
    expect(snapshot.current.L1).toBeLessThan(snapshot.current.L2!);
    expect(snapshot.shortTriggerCross).toBe(true);
    expect(snapshot.shortPriceRelativeToL1).toBe(true);
    expect(snapshot.triggerInsideVolatilityBand).toBe(true);

    const decision = evaluateRainbowTrendLadderEntry({
      candles,
      state: createRainbowTrendLadderRuntimeState(),
      spreadPoints: 1,
    });
    expect(decision.action).toBe("sell");
  });

  it("缺少真實點差、方向不允許或收盤價不在 L6/L7 區間時 fail-closed", () => {
    const candles = longSignalCandles();
    expect(evaluateRainbowTrendLadderEntry({
      candles,
      state: createRainbowTrendLadderRuntimeState(),
      spreadPoints: null,
    }).action).toBe("hold");
    expect(evaluateRainbowTrendLadderEntry({
      candles,
      state: createRainbowTrendLadderRuntimeState(),
      spreadPoints: 1,
      allowedDirection: "short",
    }).action).toBe("hold");

    const narrowBandCandles = longSignalCandles("narrow");
    const narrowSnapshot = calculateRainbowTrendLadderLineSnapshot(narrowBandCandles);
    expect(narrowSnapshot.triggerInsideVolatilityBand).toBe(false);
    expect(evaluateRainbowTrendLadderEntry({
      candles: narrowBandCandles,
      state: createRainbowTrendLadderRuntimeState(),
      spreadPoints: 1,
    }).action).toBe("hold");
  });

  it("同一根 M30 收盤只掃描一次，持倉時進入盲人模式而不重新判斷七線", () => {
    const candles = longSignalCandles();
    const first = evaluateRainbowTrendLadderEntry({
      candles,
      state: createRainbowTrendLadderRuntimeState(),
      spreadPoints: 1,
    });
    const repeated = evaluateRainbowTrendLadderEntry({
      candles,
      state: first.nextState,
      spreadPoints: 1,
    });
    expect(repeated.action).toBe("hold");
    expect(repeated.reason).toContain("已完成掃描");

    const positioned = {
      ...createRainbowTrendLadderRuntimeState(),
      currentLayer: 1,
      totalSize: 0.06,
      totalCost: 6,
      avgPrice: 100,
      isLong: true,
    };
    const blind = evaluateRainbowTrendLadderEntry({ candles, state: positioned, spreadPoints: 1 });
    expect(blind.action).toBe("hold");
    expect(blind.reason).toContain("盲人模式");
  });
});
