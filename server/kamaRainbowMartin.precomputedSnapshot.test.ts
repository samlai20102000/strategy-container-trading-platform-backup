import { describe, expect, it } from "vitest";
import { createKamaRainbowMartinDefaultConfig } from "../shared/strategies/kamaRainbowMartin";
import type { KLineData } from "./strategies/base";
import {
  calculateKamaRainbowMartinSnapshot,
  calculateKamaRainbowMartinSnapshotSeries,
  createKamaRainbowMartinRuntimeState,
  evaluateKamaRainbowMartinEntry,
} from "./strategies/kamaRainbowMartin/core";

function makeCandles(count: number): KLineData[] {
  const start = Date.UTC(2025, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const trend = 100 + index * 0.11;
    const wave = Math.sin(index / 7) * 1.7 + Math.cos(index / 19) * 0.8;
    const close = trend + wave;
    return {
      timestamp: start + index * 30 * 60_000,
      open: close - Math.sin(index / 5) * 0.2,
      high: close + 0.65,
      low: close - 0.7,
      close,
      volume: 100 + index,
    };
  });
}

describe("Kama 彩虹馬丁 causal snapshot 預計算", () => {
  it("每一棒 snapshot 與舊版 prefix 計算完全等價", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    const candles = makeCandles(180);
    const snapshots = calculateKamaRainbowMartinSnapshotSeries(candles, config);

    expect(snapshots).toHaveLength(candles.length);
    for (let index = 0; index < candles.length; index += 1) {
      expect(snapshots[index]).toEqual(
        calculateKamaRainbowMartinSnapshot(candles.slice(0, index + 1), config),
      );
    }
  });

  it("注入預計算 snapshot 不改變 entry action、reason code 或 Bar-Lock identity", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    const candles = makeCandles(180);
    const snapshots = calculateKamaRainbowMartinSnapshotSeries(candles, config);

    for (let index = 0; index < candles.length; index += 7) {
      const prefix = candles.slice(0, index + 1);
      const configRevision = `equivalence:${index}`;
      const baseline = evaluateKamaRainbowMartinEntry({
        candles: prefix,
        state: createKamaRainbowMartinRuntimeState(),
        rawConfig: config,
        lastBarClosed: true,
        configRevision,
      });
      const optimized = evaluateKamaRainbowMartinEntry({
        state: createKamaRainbowMartinRuntimeState(),
        rawConfig: config,
        precomputedSnapshot: snapshots[index],
        lastBarClosed: true,
        configRevision,
      });

      expect({
        action: optimized.action,
        reasonCode: optimized.reasonCode,
        reason: optimized.reason,
        price: optimized.price,
        barTimestamp: optimized.barTimestamp,
        snapshot: optimized.snapshot,
        nextState: optimized.nextState,
      }).toEqual({
        action: baseline.action,
        reasonCode: baseline.reasonCode,
        reason: baseline.reason,
        price: baseline.price,
        barTimestamp: baseline.barTimestamp,
        snapshot: baseline.snapshot,
        nextState: baseline.nextState,
      });
    }
  });

  it("首個無效 close 之後保持與 prefix evaluator 相同的 not-ready 語意", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    const candles = makeCandles(120);
    candles[73] = { ...candles[73], close: Number.NaN };
    const snapshots = calculateKamaRainbowMartinSnapshotSeries(candles, config);

    for (const index of [72, 73, 74, 119]) {
      expect(snapshots[index]).toEqual(
        calculateKamaRainbowMartinSnapshot(candles.slice(0, index + 1), config),
      );
    }
  });
});
