import { describe, expect, it } from "vitest";
import { KamaAccumulator, calculateKamaSeries, latestReadyKamaPair } from "./strategies/kamaRainbowMartin/kama";

describe("Kama 彩虹馬丁逐棒 KAMA 純核心", () => {
  it("在固定 seed 前回傳 null，並按逐棒 ER 更新", () => {
    const values = calculateKamaSeries([1, 2, 3, 2], { erPeriod: 2, fastEma: 2, slowEma: 30 });
    expect(values[0]).toBeNull();
    expect(values[1]).toBeCloseTo(1.5, 12);
    expect(values[2]).toBeCloseTo(2.1666666666666665, 12);
    expect(values[3]).toBeCloseTo(2.1659729448491154, 12);
  });

  it("batch 與 streaming 對每一點完全一致", () => {
    const closes = [100, 101, 99, 103, 105, 104, 108, 107, 109, 112, 111, 114];
    const parameters = { erPeriod: 4, fastEma: 2, slowEma: 30 };
    const accumulator = new KamaAccumulator(parameters);
    const streaming = closes.map(close => accumulator.add(close));
    expect(calculateKamaSeries(closes, parameters)).toEqual(streaming);
  });

  it("零波動序列不產生 NaN 或 Infinity", () => {
    const values = calculateKamaSeries([10, 10, 10, 10, 10, 10], { erPeriod: 3, fastEma: 2, slowEma: 30 });
    expect(values).toEqual([null, null, 10, 10, 10, 10]);
    expect(values.filter(value => value !== null).every(Number.isFinite)).toBe(true);
  });

  it("允許 fast 等於 slow，拒絕 fast 大於 slow 與非有限 close", () => {
    expect(calculateKamaSeries([1, 2, 3], { erPeriod: 2, fastEma: 2, slowEma: 2 })[2]).toBeTypeOf("number");
    expect(() => new KamaAccumulator({ erPeriod: 2, fastEma: 3, slowEma: 2 })).toThrow(/fastEma/);
    expect(() => calculateKamaSeries([1, Number.NaN], { erPeriod: 2, fastEma: 2, slowEma: 30 })).toThrow(
      /finite/,
    );
  });

  it("只在至少兩個 ready 值時提供 previous/current pair", () => {
    expect(latestReadyKamaPair([null, 1])).toBeNull();
    expect(latestReadyKamaPair([null, 1, 2])).toEqual({ previous: 1, current: 2 });
  });
});
