import { describe, expect, it } from "vitest";
import {
  KAMA_RAINBOW_MARTIN_CONFIG_VERSION,
  KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
  KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY,
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  buildKamaRainbowMartinAddLayerQuantities,
  buildKamaRainbowMartinLayerQuantities,
  createKamaRainbowMartinDefaultConfig,
  getKamaRainbowMartinLayerProtection,
  getKamaRainbowMartinMinimumHistoryBars,
  normalizeKamaRainbowMartinConfig,
  validateKamaRainbowMartinConfig,
} from "../shared/strategies/kamaRainbowMartin";
import {
  KAMA_RAINBOW_MARTIN_H3_PRIMARY_LOSS_TRIGGER_PCT,
  createDefaultStrategyExecutionPolicy,
  normalizeStrategyExecutionPolicy,
} from "../shared/strategies/kamaRainbowMartinExecutionPolicy";

describe("Kama 彩虹馬丁 canonical contract", () => {
  it("使用獨立 identity、核准預設值且不含無語義 target profit", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    expect(KAMA_RAINBOW_MARTIN_STRATEGY_KEY).toBe("KAMA_RAINBOW_MARTIN_V1");
    expect(KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY).toBe("__kamaRainbowMartinConfig");
    expect(config.version).toBe(KAMA_RAINBOW_MARTIN_CONFIG_VERSION);
    expect(config.kamaLines.map(line => [line.erPeriod, line.fastEma, line.slowEma])).toEqual([
      [10, 2, 30],
      [20, 2, 30],
    ]);
    expect(config.maxLayers).toBe(11);
    expect(config.multiplier).toBe(1.5);
    expect(config.gapPct).toBe(2);
    expect(config.layerConfigs).toEqual([
      { layerStart: 1, layerEnd: 4, multiplier: 1.5 },
      { layerStart: 5, layerEnd: 9, multiplier: 1.1 },
      { layerStart: 10, layerEnd: 11, multiplier: 1 },
    ]);
    expect(config.hardStopLossPct).toBe(5);
    expect(config.trailing).toEqual({ enabled: true, activationPct: 3, callbackPct: 1.5, stepPct: 0.5 });
    expect(config).not.toHaveProperty("targetProfitPct");
    expect(validateKamaRainbowMartinConfig(config).valid).toBe(true);
  });

  it("每次建立預設配置都深複製動態線、分層表與 trailing", () => {
    const first = createKamaRainbowMartinDefaultConfig();
    const second = createKamaRainbowMartinDefaultConfig();
    first.kamaLines[0].name = "changed";
    first.layerConfigs[0].multiplier = 9;
    first.trailing.activationPct = 99;
    expect(second.kamaLines[0].name).toBe(KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG.kamaLines[0].name);
    expect(second.layerConfigs[0].multiplier).toBe(1.5);
    expect(second.trailing.activationPct).toBe(3);
  });

  it("依分段乘數逐層累乘，且新增尾段會自動衍生最大加倉層", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    const quantities = buildKamaRainbowMartinAddLayerQuantities(
      100,
      config.maxLayers,
      config.layerConfigs,
      config.multiplier,
    );
    expect(quantities.slice(0, 5)).toEqual([150, 225, 337.5, 506.25, 556.875]);
    expect(quantities[9]).toBeCloseTo(815.3206875, 8);
    expect(quantities[10]).toBeCloseTo(815.3206875, 8);

    const extended = validateKamaRainbowMartinConfig({
      ...config,
      layerConfigs: [...config.layerConfigs, { layerStart: 12, layerEnd: 14, multiplier: 1.2, gapPct: 3 }],
    });
    expect(extended.valid).toBe(true);
    expect(extended.config.maxLayers).toBe(14);
  });

  it("V1 固定倍數快照維持固定模式並把含底倉總層數換算為加倉層數", () => {
    const migrated = validateKamaRainbowMartinConfig({
      version: "kamaRainbowMartin.v1",
      timeframe: "M30",
      kamaLines: createKamaRainbowMartinDefaultConfig().kamaLines,
      maxLayers: 5,
      multiplier: 2,
      gapPct: 2,
      hardStopLossPct: 5,
      trailing: { enabled: true, activationPct: 3, callbackPct: 1.5, stepPct: 0.5 },
    });
    expect(migrated.valid).toBe(true);
    expect(migrated.config.maxLayers).toBe(4);
    expect(migrated.config.layerConfigs).toEqual([]);
    expect(migrated.warnings.map(warning => warning.code)).toEqual(expect.arrayContaining([
      "KRM_LEGACY_CONFIG_MIGRATED",
      "KRM_FIXED_MODE_FALLBACK",
    ]));
    expect(normalizeKamaRainbowMartinConfig(migrated.config).maxLayers).toBe(4);
  });

  it("拒絕分層重疊、空缺及未由 L1 開始", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    const overlap = validateKamaRainbowMartinConfig({
      ...config,
      layerConfigs: [
        { layerStart: 1, layerEnd: 4, multiplier: 1.5 },
        { layerStart: 4, layerEnd: 6, multiplier: 1.1 },
      ],
    });
    expect(overlap.issues.map(issue => issue.code)).toContain("KRM_LAYER_OVERLAP");
    const gap = validateKamaRainbowMartinConfig({
      ...config,
      layerConfigs: [
        { layerStart: 1, layerEnd: 4, multiplier: 1.5 },
        { layerStart: 6, layerEnd: 8, multiplier: 1.1 },
      ],
    });
    expect(gap.issues.map(issue => issue.code)).toContain("KRM_LAYER_GAP");
    const wrongStart = validateKamaRainbowMartinConfig({
      ...config,
      layerConfigs: [{ layerStart: 2, layerEnd: 4, multiplier: 1.5 }],
    });
    expect(wrongStart.issues.map(issue => issue.code)).toContain("KRM_LAYER_MUST_START_AT_ONE");
  });

  it("分層保護欄位可由快照字串／nested trailing 正規化並完整往返", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    const normalized = normalizeKamaRainbowMartinConfig({
      ...config,
      layerConfigs: [{
        layerStart: "1",
        layerEnd: "4",
        multiplier: "1.25",
        gapPct: "3",
        hardStopLossPct: "8",
        trailing: {
          enabled: "true",
          activationPct: "2.5",
          callbackPct: "0.8",
          stepPct: "0.25",
        },
      }],
    });
    expect(normalized.layerConfigs).toEqual([{
      layerStart: 1,
      layerEnd: 4,
      multiplier: 1.25,
      gapPct: 3,
      hardStopLossPct: 8,
      trailingEnabled: true,
      trailingActivationPct: 2.5,
      trailingCallbackPct: 0.8,
      trailingStepPct: 0.25,
    }]);
    expect(validateKamaRainbowMartinConfig(normalized).valid).toBe(true);
  });

  it("腿級保護空欄位回退全域值，非法止損與 callback 關係則 fail closed", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    const inherited = getKamaRainbowMartinLayerProtection(
      1,
      config.layerConfigs,
      config.hardStopLossPct,
      config.trailing,
    );
    expect(inherited).toEqual({
      hardStopLossPct: config.hardStopLossPct,
      trailing: config.trailing,
    });
    const invalid = validateKamaRainbowMartinConfig({
      ...config,
      layerConfigs: [{
        layerStart: 1,
        layerEnd: 11,
        multiplier: 1.5,
        hardStopLossPct: 0,
        trailingActivationPct: 2,
        trailingCallbackPct: 2,
      }],
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      "KRM_LAYER_HARD_STOP_INVALID",
      "KRM_LAYER_TRAILING_CALLBACK_TOO_LARGE",
    ]));
  });

  it("拒絕未知版本、重複 id／名稱與 fast 大於 slow", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    const result = validateKamaRainbowMartinConfig({
      ...config,
      version: "unknown",
      kamaLines: [
        config.kamaLines[0],
        { ...config.kamaLines[0], name: config.kamaLines[0].name, fastEma: 31, slowEma: 30 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      "KRM_UNSUPPORTED_CONFIG_VERSION",
      "KRM_LINE_ID_DUPLICATE",
      "KRM_LINE_NAME_DUPLICATE",
      "KRM_FAST_GREATER_THAN_SLOW",
    ]));
  });

  it("fast 等於 slow 只警告退化 EMA，不誤判為無效", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    config.kamaLines[0].fastEma = 2;
    config.kamaLines[0].slowEma = 2;
    const result = validateKamaRainbowMartinConfig(config);
    expect(result.valid).toBe(true);
    expect(result.warnings.map(warning => warning.code)).toContain("KRM_DEGENERATE_FIXED_EMA");
  });

  it("至少需要兩條啟用線並提供正確 warm-up 下限", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    config.kamaLines[1].enabled = false;
    expect(validateKamaRainbowMartinConfig(config).issues.map(issue => issue.code)).toContain(
      "KRM_ENABLED_LINE_COUNT_INVALID",
    );
    config.kamaLines[1].enabled = true;
    expect(getKamaRainbowMartinMinimumHistoryBars(config)).toBe(21);
  });

  it("保留舊固定模式的含底倉數量工具供 V1 相容路徑使用", () => {
    expect(buildKamaRainbowMartinLayerQuantities(0.01, 5, 2)).toEqual([0.01, 0.02, 0.04, 0.08, 0.16]);
    expect(buildKamaRainbowMartinLayerQuantities(0.01, 0, 2)).toEqual([]);
  });

  it("S1／M2 採用共享預設，而 KRM H3 封印 4% 保護先後順序", () => {
    expect(createDefaultStrategyExecutionPolicy(
      KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
      "SINGLE_EXCLUSIVE",
    )).toMatchObject({ mode: "SINGLE_EXCLUSIVE" });
    expect(createDefaultStrategyExecutionPolicy(
      KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
      "MULTI_POSITION",
    )).toMatchObject({ mode: "MULTI_POSITION" });
    expect(createDefaultStrategyExecutionPolicy(
      KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
      "HEDGE_GUARDED",
    )).toMatchObject({
      mode: "HEDGE_GUARDED",
      primaryLossTriggerPct: KAMA_RAINBOW_MARTIN_H3_PRIMARY_LOSS_TRIGGER_PCT,
      hedgeMartinEnabled: false,
    });
  });

  it("KRM H3 忽略前端門檻漂移，非 KRM 策略仍保留合法自訂門檻", () => {
    const generic = createDefaultStrategyExecutionPolicy("OTHER_STRATEGY", "HEDGE_GUARDED");
    const requested = {
      ...generic,
      primaryLossTriggerPct: 9,
      hedgeMartinEnabled: true,
    };
    expect(normalizeStrategyExecutionPolicy(
      KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
      requested,
    )).toMatchObject({
      primaryLossTriggerPct: 4,
      hedgeMartinEnabled: false,
    });
    expect(normalizeStrategyExecutionPolicy("OTHER_STRATEGY", requested)).toMatchObject({
      primaryLossTriggerPct: 9,
      hedgeMartinEnabled: false,
    });
  });
});
