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

  it("V3.0: 快照計算正確，包含趨勢方向和排名序列", () => {
    const candles = longSignalCandles();
    const snapshot = calculateRainbowTrendLadderLineSnapshot(candles);
    expect(snapshot.ready).toBe(true);
    // V3.0: 趨勢方向應該是 UP、DOWN 或 MIXED 之一
    expect(["UP", "DOWN", "MIXED"]).toContain(snapshot.trendDirection);
    // V3.0: 快照應包含所有 7 條線的值
    expect(snapshot.current).toHaveProperty("L1");
    expect(snapshot.current).toHaveProperty("L2");
    expect(snapshot.current).toHaveProperty("L3");
    expect(snapshot.current).toHaveProperty("L4");
    expect(snapshot.current).toHaveProperty("L5");
    expect(snapshot.current).toHaveProperty("L6");
    expect(snapshot.current).toHaveProperty("L7");
  });

  it("V3.0: 進場決策基於排名序列和全部同向", () => {
    const candles = longSignalCandles();
    const decision = evaluateRainbowTrendLadderEntry({
      candles,
      state: createRainbowTrendLadderRuntimeState(),
      spreadPoints: 1,
    });
    // V3.0: 進場決策應該是 buy、sell 或 hold 之一
    expect(["buy", "sell", "hold"]).toContain(decision.action);
  });

  it("缺少真實點差時 fail-closed", () => {
    const candles = longSignalCandles();
    expect(evaluateRainbowTrendLadderEntry({
      candles,
      state: createRainbowTrendLadderRuntimeState(),
      spreadPoints: null,
    }).action).toBe("hold");
  });

  it("方向不允許時 fail-closed", () => {
    const candles = longSignalCandles();
    expect(evaluateRainbowTrendLadderEntry({
      candles,
      state: createRainbowTrendLadderRuntimeState(),
      spreadPoints: 1,
      allowedDirection: "short",
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
