import { describe, expect, it } from "vitest";

import {
  RAINBOW_20415_CONFIG_VERSION,
  RAINBOW_20415_STRATEGY_KEY,
  RAINBOW_20415_STRATEGY_NAME,
  assertValidRainbow20415Config,
  createRainbow20415DefaultConfig,
  deriveRainbow20415FinalEnabledLayer,
  getRainbow20415EffectiveSpacing,
  getRainbow20415NextEnabledLayer,
  migrateRainbow20415Config,
  normalizeRainbow20415Config,
  validateRainbow20415Config,
} from "../shared/strategies/rainbow20415";

describe("20415 七彩虹單一配置契約", () => {
  it("保留穩定 key、正式名稱與文件預設值", () => {
    const config = createRainbow20415DefaultConfig();
    expect(RAINBOW_20415_STRATEGY_KEY).toBe("strategy_20415");
    expect(RAINBOW_20415_STRATEGY_NAME).toBe("20415七彩虹馬丁策略");
    expect(config.Config_Version).toBe(RAINBOW_20415_CONFIG_VERSION);
    expect(config.Entry_Timeframe_Minutes).toBe(30);
    expect(config.Management_Interval_Minutes).toBe(1);
    expect(config.Lines.map((line) => line.id)).toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7"]);
    expect(config.Base_Lot_Size).toEqual({ value: 0.01, mode: "quantity" });
    expect(config.Take_Profit_Pct).toBe(0.2);
    expect(config.Global_Spacing_Pct).toBe(1.5);
    expect(config.Max_Hold_Hours).toBe(48);
    expect(config.Max_Margin_Usage_Pct).toBe(70);
    expect(config.Max_Account_Loss_Pct).toBe(5);
    expect(validateRainbow20415Config(config)).toMatchObject({ valid: true, issues: [] });
  });

  it("深拷貝預設七線、底倉與階梯", () => {
    const first = createRainbow20415DefaultConfig();
    const second = createRainbow20415DefaultConfig();
    first.Lines[0].period = 777;
    first.Base_Lot_Size.value = 99;
    first.Martin_Ranges[0].multiplier = 9;
    expect(second.Lines[0].period).toBe(5);
    expect(second.Base_Lot_Size.value).toBe(0.01);
    expect(second.Martin_Ranges[0].multiplier).toBe(1.5);
  });

  it("解析文件大寫鍵、負數虧損門檻、GLOBAL 與停用範圍", () => {
    const result = migrateRainbow20415Config({
      TIMEFRAME: "M30",
      MANAGEMENT_TIMEFRAME: "M1",
      BASE_LOT: 0.02,
      TAKE_PROFIT_PCT: 0.35,
      GLOBAL_SPACING: 2.25,
      MAX_HOLD_HOURS: 72,
      MAX_MARGIN_PCT: 65,
      MAX_LOSS_LIMIT: -7.5,
      MARTINGALE_LAYERS: [[1, 2, 1.4, "GLOBAL"], [3, 120, 0, 3.5]],
      REENTRY_ENABLED: false,
      REENTRY_COOLDOWN_MINUTES: 0,
    });
    expect(result.source).toBe("document");
    expect(result.config.Max_Account_Loss_Pct).toBe(7.5);
    expect(result.config.Martin_Ranges[0]).toMatchObject({ useGlobalSpacing: true, spacingPct: 2.25 });
    expect(result.config.Martin_Ranges[1]).toMatchObject({ endLayer: 120, multiplier: 0, enabled: false });
    expect(result.config.Reentry_Enabled).toBe(false);
    expect(result.config.Reentry_Cooldown_Minutes).toBe(0);
    expect(validateRainbow20415Config(result.config).valid).toBe(true);
  });

  it("舊 EMA 只遷移底倉與資金，不誤解 ATR、points 或固定層數", () => {
    const result = migrateRainbow20415Config({
      ema_killer: 3,
      ema_wave: 6,
      ema_enter: 15,
      Base_Lot_Size: { value: 250, mode: "usdt" },
      Initial_Capital: 25_000,
      multiplier: 4.5,
      max_layers: 50,
      pip_step_base: 9000,
      tp_normal: 999,
    });
    expect(result.source).toBe("legacy-ema");
    expect(result.config.Base_Lot_Size).toEqual({ value: 250, mode: "usdt" });
    expect(result.config.Initial_Capital).toBe(25_000);
    expect(result.config.Take_Profit_Pct).toBe(0.2);
    expect(result.config.Martin_Ranges[0].multiplier).toBe(1.5);
    expect(result.ignoredLegacyKeys).toEqual(expect.arrayContaining(["ema_killer", "max_layers", "pip_step_base", "tp_normal"]));
  });

  it("保留合法 false、零冷卻與停用層零乘數，且跳至下一啟用層", () => {
    const config = normalizeRainbow20415Config({
      ...createRainbow20415DefaultConfig(),
      Martingale_Enabled: false,
      Reentry_Enabled: false,
      Reentry_Cooldown_Minutes: 0,
      Martin_Ranges: [
        { id: "base", startLayer: 1, endLayer: 2, multiplier: 1.5, useGlobalSpacing: true, spacingPct: 1.5, enabled: true },
        { id: "off", startLayer: 3, endLayer: 4, multiplier: 0, useGlobalSpacing: false, spacingPct: 2, enabled: false },
        { id: "tail", startLayer: 5, endLayer: 999, multiplier: 1, useGlobalSpacing: false, spacingPct: 3, enabled: true },
      ],
    });
    expect(config.Martingale_Enabled).toBe(false);
    expect(config.Reentry_Enabled).toBe(false);
    expect(config.Reentry_Cooldown_Minutes).toBe(0);
    expect(validateRainbow20415Config(config).valid).toBe(true);
    expect(getRainbow20415NextEnabledLayer(config.Martin_Ranges, 2)).toMatchObject({ layer: 5, range: { id: "tail" } });
    expect(deriveRainbow20415FinalEnabledLayer(config.Martin_Ranges)).toBe(999);
    expect(getRainbow20415EffectiveSpacing(config, config.Martin_Ranges[2])).toBe(3);
  });

  it("阻擋重複七線、階梯重疊及無效風控", () => {
    const invalid = createRainbow20415DefaultConfig();
    invalid.Lines[1] = { ...invalid.Lines[0], id: "L2" };
    invalid.Martin_Ranges[1].startLayer = 4;
    invalid.Max_Margin_Usage_Pct = -1;
    const result = validateRainbow20415Config(invalid);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "Lines.1" }),
      expect.objectContaining({ path: "Martin_Ranges.1.startLayer" }),
      expect.objectContaining({ path: "Max_Margin_Usage_Pct" }),
    ]));
    expect(() => assertValidRainbow20415Config(invalid)).toThrow(/排名將失去意義/);
  });
});
