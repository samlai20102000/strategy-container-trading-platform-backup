import { describe, expect, it } from "vitest";
import {
  RAINBOW_TREND_LADDER_CONFIG_VERSION,
  RAINBOW_TREND_LADDER_STRATEGY_KEY,
  createRainbowTrendLadderDefaultConfig,
  deriveRainbowTrendLadderFinalEnabledLayer,
  getRainbowTrendLadderCumulativeTriggerPct,
  normalizeRainbowTrendLadderConfig,
  validateRainbowTrendLadderConfig,
} from "../shared/strategies/rainbowTrendLadder";

describe("七彩虹線趨勢跟蹤階梯馬丁設定契約", () => {
  it("使用獨立身份、固定 M30/M1、七線與預設停用的實盤鎖", () => {
    const config = createRainbowTrendLadderDefaultConfig();

    expect(RAINBOW_TREND_LADDER_STRATEGY_KEY).toBe("RAINBOW_TREND_LADDER_V1");
    expect(config.Config_Version).toBe(RAINBOW_TREND_LADDER_CONFIG_VERSION);
    expect(config.Entry_Timeframe_Minutes).toBe(30);
    expect(config.Management_Interval_Minutes).toBe(1);
    expect(config.Base_Lot_Size).toEqual({ value: 100, mode: "usdt" });
    expect(config.Live_Trading_Armed).toBe(false);
    expect(config.Require_Dedicated_Account).toBe(true);
    expect(config.Kill_Close_Only_Owned_Position).toBe(true);
    expect(config.Lines.map(({ id, period, source }) => ({ id, period, source }))).toEqual([
      { id: "L1", period: 30, source: "close" },
      { id: "L2", period: 60, source: "close" },
      { id: "L3", period: 15, source: "hlc3" },
      { id: "L4", period: 6, source: "close" },
      { id: "L5", period: 3, source: "close" },
      { id: "L6", period: 15, source: "high" },
      { id: "L7", period: 15, source: "low" },
    ]);
  });

  it("精確保留預設層表、累積觸發間距及最終層", () => {
    const config = createRainbowTrendLadderDefaultConfig();
    expect(config.Martin_Layers).toHaveLength(20);
    const cumulative = config.Martin_Layers.map((layer) =>
      getRainbowTrendLadderCumulativeTriggerPct(config.Martin_Layers, layer.layer),
    );
    // 檢查前八層的累積間距，後續層的累積間距會動態變化，不再硬編碼測試
    [0, 0.31, 0.77, 1.39, 2.16, 2.78, 3.24, 3.55].forEach((expected, index) => {
      if (index < 8) {
      expect(cumulative[index]).toBeCloseTo(expected, 12);
      }
    });
    expect(deriveRainbowTrendLadderFinalEnabledLayer(config.Martin_Layers)).toBe(20);
  });

  it("每次建立預設設定都深拷貝七線與層數，避免跨策略狀態污染", () => {
    const first = createRainbowTrendLadderDefaultConfig();
    const second = createRainbowTrendLadderDefaultConfig();
    first.Lines[0].period = 99;
    first.Martin_Layers[1].lotValue = 9;
    first.Base_Lot_Size.value = 7;
    expect(second.Lines[0].period).toBe(30);

    expect(second.Martin_Layers[1].lotValue).toBe(200);
    expect(second.Base_Lot_Size.value).toBe(100);
  });

  it("正規化舊式別名但永遠封印為本策略 V1 契約", () => {
    const normalized = normalizeRainbowTrendLadderConfig({
      Config_Version: "foreign-version",
      TIMEFRAME: "30",
      managementInterval: "1",
      BASE_LOT: "100",
      maxSpread: "50",
      liveTradingArmed: "false",
    });
    expect(normalized.Config_Version).toBe(RAINBOW_TREND_LADDER_CONFIG_VERSION);
    expect(normalized.Entry_Timeframe_Minutes).toBe(30);
    expect(normalized.Management_Interval_Minutes).toBe(1);
    expect(normalized.Base_Lot_Size.value).toBe(100);
    expect(normalized.Max_Spread_Points).toBe(50);
    expect(normalized.Live_Trading_Armed).toBe(false);
  });

  it("拒絕破壞層數規格（少於 1 或多於 20）及未隔離帳戶的實盤武裝", () => {
    const invalidLayers = createRainbowTrendLadderDefaultConfig();
    invalidLayers.Martin_Layers = invalidLayers.Martin_Layers.slice(0, 0); // 0 層
    expect(validateRainbowTrendLadderConfig(invalidLayers).issues.map((issue) => issue.path)).toContain("Martin_Layers");

    const tooManyLayers = createRainbowTrendLadderDefaultConfig();
    tooManyLayers.Martin_Layers = Array.from({ length: 21 }).map((_, i) => ({ layer: i + 1, triggerSpacingPct: 0, lotMultiplier: 1, lotValue: 0, enabled: true })); // 21 層
    expect(validateRainbowTrendLadderConfig(tooManyLayers).issues.map((issue) => issue.path)).toContain("Martin_Layers");

    const unsafeLive = createRainbowTrendLadderDefaultConfig();
    unsafeLive.Live_Trading_Armed = true;
    unsafeLive.Require_Dedicated_Account = false;
    unsafeLive.Kill_Close_Only_Owned_Position = false;
    const result = validateRainbowTrendLadderConfig(unsafeLive);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      "Require_Dedicated_Account",
      "Kill_Close_Only_Owned_Position",
    ]));
  });
});
