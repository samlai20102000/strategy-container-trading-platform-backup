import { describe, expect, it } from "vitest";
import {
  evaluateV40EntryGates,
  normalizeV40EntryGateConfig,
  type V40EntryCandle,
} from "./entryGate";

const breakoutLong: V40EntryCandle[] = [
  { open: 100, high: 103, low: 99, close: 102 },
  { open: 102, high: 105, low: 101, close: 104 },
  { open: 104, high: 107, low: 103, close: 106 },
];

const bodyLongButNoBreakout: V40EntryCandle[] = [
  { open: 100, high: 108, low: 99, close: 102 },
  { open: 102, high: 109, low: 101, close: 104 },
  { open: 104, high: 107, low: 103, close: 106 },
];

describe("V4.0 入場安全閘", () => {
  it("舊資料缺值維持原有開啟狀態與 breakout 模式", () => {
    expect(normalizeV40EntryGateConfig({})).toEqual({
      enableThreeKFilter: true,
      threeKPatternMode: "breakout",
      enableKamaDirectionLock: true,
      enableSameDirectionReentry: true,
    });
  });

  it("保留顯式 false，不被 truthy fallback 覆蓋", () => {
    expect(normalizeV40EntryGateConfig({
      enableThreeKFilter: false,
      enableKamaDirectionLock: false,
      enableSameDirectionReentry: false,
      threeKPatternMode: "three_body_same_direction",
    })).toEqual({
      enableThreeKFilter: false,
      threeKPatternMode: "three_body_same_direction",
      enableKamaDirectionLock: false,
      enableSameDirectionReentry: false,
    });
  });

  it("breakout 模式沿用前兩根同向＋第三根收盤破位", () => {
    const result = evaluateV40EntryGates({
      candles: breakoutLong,
      slowKama: 103,
      rawConfig: { threeKPatternMode: "breakout" },
    });
    expect(result.passed).toBe(true);
    expect(result.direction).toBe("long");
  });

  it("三根實體同向模式不要求第三根突破前高", () => {
    const result = evaluateV40EntryGates({
      candles: bodyLongButNoBreakout,
      slowKama: 103,
      rawConfig: { threeKPatternMode: "three_body_same_direction" },
    });
    expect(result.passed).toBe(true);
    expect(result.direction).toBe("long");
  });

  it("相同 K 線在 breakout 模式下未破位即 HOLD", () => {
    const result = evaluateV40EntryGates({
      candles: bodyLongButNoBreakout,
      slowKama: 103,
      rawConfig: { threeKPatternMode: "breakout" },
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("三 K 條件未通過");
  });

  it("KAMA 鎖啟用時拒絕 price 不在 slow KAMA 正確一側的方向", () => {
    const result = evaluateV40EntryGates({
      candles: breakoutLong,
      slowKama: 108,
      rawConfig: {
        enableThreeKFilter: true,
        enableKamaDirectionLock: true,
      },
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("KAMA 方向鎖未通過");
  });

  it("僅啟用 KAMA 鎖時以 price／slow KAMA 推導方向", () => {
    const result = evaluateV40EntryGates({
      candles: breakoutLong,
      slowKama: 103,
      rawConfig: {
        enableThreeKFilter: false,
        enableKamaDirectionLock: true,
      },
    });
    expect(result.passed).toBe(true);
    expect(result.direction).toBe("long");
  });

  it("僅啟用三 K 時不要求 KAMA 資料", () => {
    const result = evaluateV40EntryGates({
      candles: breakoutLong,
      slowKama: null,
      rawConfig: {
        enableThreeKFilter: true,
        enableKamaDirectionLock: false,
      },
    });
    expect(result.passed).toBe(true);
    expect(result.direction).toBe("long");
  });

  it("自動／回測在兩項入場條件皆停用時 fail-safe HOLD", () => {
    const result = evaluateV40EntryGates({
      candles: breakoutLong,
      rawConfig: {
        enableThreeKFilter: false,
        enableKamaDirectionLock: false,
      },
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("無法安全推導方向");
  });

  it("raw Webhook 已指定方向時只檢查已啟用條件；兩項停用可保留外部方向", () => {
    const result = evaluateV40EntryGates({
      candles: [],
      requestedDirection: "short",
      allowedDirection: "both",
      currentPrice: 100,
      rawConfig: {
        enableThreeKFilter: false,
        enableKamaDirectionLock: false,
      },
    });
    expect(result.passed).toBe(true);
    expect(result.direction).toBe("short");
  });

  it("方向限制在 evaluator 最後一道攔截", () => {
    const result = evaluateV40EntryGates({
      candles: breakoutLong,
      slowKama: 103,
      allowedDirection: "short",
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("只做空");
  });
});
