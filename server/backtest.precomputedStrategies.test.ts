import { describe, expect, it } from "vitest";
import type { KLineData } from "./strategies/base";
import { createInitialStrategyState } from "./strategies/base";
import {
  calculateRainbow20415LineSnapshotSeries,
  createRainbow20415RuntimeState,
  evaluateRainbow20415Entry,
} from "./strategies/rainbow20415/core";
import {
  calculateRainbowTrendLadderLineSnapshotSeries,
  createRainbowTrendLadderRuntimeState,
  evaluateRainbowTrendLadderEntry,
} from "./strategies/rainbowTrendLadder/core";
import {
  calculateV25PrecomputedBarSeries,
  createV25RuntimeState,
  evaluateV25Decision,
} from "./strategies/v25/core";
import {
  calculateV61PrecomputedBarSeries,
  StrategyKama3kV61,
} from "./strategies/v61/strategy_kama_3k_v61";
import { StrategyKama3kV70 } from "./strategies/v70/strategy_kama_3k_v70";

function candles(count = 280): KLineData[] {
  const start = Date.UTC(2025, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const trend = 42_000 + index * 7.25;
    const wave = Math.sin(index / 8) * 420 + Math.cos(index / 19) * 170;
    const open = trend + wave;
    const close = open + Math.sin(index / 3) * 95;
    return {
      timestamp: start + index * 30 * 60_000,
      open,
      high: Math.max(open, close) + 65 + (index % 7),
      low: Math.min(open, close) - 60 - (index % 5),
      close,
      volume: 100 + index,
    };
  });
}

describe("portfolio strategy causal precomputation", () => {
  it("keeps Rainbow 20415 snapshots and entry decisions equivalent at every bar", () => {
    const series = candles(180);
    const snapshots = calculateRainbow20415LineSnapshotSeries(series);
    series.forEach((candle, index) => {
      const prefix = series.slice(0, index + 1);
      const legacy = evaluateRainbow20415Entry(prefix, createRainbow20415RuntimeState());
      const optimized = evaluateRainbow20415Entry(
        [],
        createRainbow20415RuntimeState(),
        undefined,
        "both",
        { snapshot: snapshots[index], currentPrice: candle.close },
      );
      expect(optimized).toEqual(legacy);
    });
  });

  it("keeps Rainbow Trend Ladder snapshots and entry decisions equivalent at every bar", () => {
    const series = candles(180);
    const snapshots = calculateRainbowTrendLadderLineSnapshotSeries(series);
    series.forEach((candle, index) => {
      const legacy = evaluateRainbowTrendLadderEntry({
        candles: series.slice(0, index + 1),
        state: createRainbowTrendLadderRuntimeState(),
        spreadPoints: 0,
      });
      const optimized = evaluateRainbowTrendLadderEntry({
        state: createRainbowTrendLadderRuntimeState(),
        spreadPoints: 0,
        precomputedSnapshot: snapshots[index],
        precomputedCurrentPrice: candle.close,
      });
      expect(optimized).toEqual(legacy);
    });
  });

  it("keeps V2.5 decisions equivalent at every bar", () => {
    const series = candles(180);
    const bars = calculateV25PrecomputedBarSeries(series);
    series.forEach((_candle, index) => {
      const legacy = evaluateV25Decision(
        series.slice(0, index + 1),
        createV25RuntimeState(),
      );
      const optimized = evaluateV25Decision(
        [],
        createV25RuntimeState(),
        undefined,
        "both",
        bars[index],
      );
      expect(optimized).toEqual(legacy);
    });
  });

  it("keeps V6.1 sequential entry decisions equivalent", () => {
    const series = candles(180);
    const bars = calculateV61PrecomputedBarSeries(series);
    const legacy = new StrategyKama3kV61();
    const optimized = new StrategyKama3kV61();
    series.forEach((_candle, index) => {
      const legacyDecision = legacy.generateSignalV61(series.slice(0, index + 1), false);
      const optimizedDecision = optimized.generateSignalV61(
        [],
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        bars[index],
      );
      expect(optimizedDecision).toEqual(legacyDecision);
    });
  });

  it("keeps V7.0 flat-state decisions equivalent at every bar", () => {
    const series = candles(280);
    const legacy = new StrategyKama3kV70();
    const optimized = new StrategyKama3kV70();
    const bars = optimized.calculatePrecomputedBarSeries(series, {});
    series.forEach((_candle, index) => {
      const legacyDecision = legacy.generateTradingSignal(
        series.slice(0, index + 1),
        createInitialStrategyState(),
        {},
      );
      const optimizedDecision = optimized.generateTradingSignal(
        [],
        createInitialStrategyState(),
        {},
        bars[index],
      );
      expect(optimizedDecision).toEqual(legacyDecision);
    });
  });
});
