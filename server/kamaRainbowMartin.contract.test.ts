import { describe, expect, it } from "vitest";
import {
  KAMA_RAINBOW_MARTIN_CONFIG_VERSION,
  KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
  KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY,
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  buildKamaRainbowMartinLayerQuantities,
  createKamaRainbowMartinDefaultConfig,
  getKamaRainbowMartinMinimumHistoryBars,
  validateKamaRainbowMartinConfig,
} from "../shared/strategies/kamaRainbowMartin";

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
    expect(config.maxLayers).toBe(5);
    expect(config.multiplier).toBe(2);
    expect(config.gapPct).toBe(2);
    expect(config.hardStopLossPct).toBe(5);
    expect(config.trailing).toEqual({ enabled: true, activationPct: 3, callbackPct: 1.5, stepPct: 0.5 });
    expect(config).not.toHaveProperty("targetProfitPct");
    expect(validateKamaRainbowMartinConfig(config).valid).toBe(true);
  });

  it("每次建立預設配置都深複製動態線與 trailing", () => {
    const first = createKamaRainbowMartinDefaultConfig();
    const second = createKamaRainbowMartinDefaultConfig();
    first.kamaLines[0].name = "changed";
    first.trailing.activationPct = 99;
    expect(second.kamaLines[0].name).toBe(KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG.kamaLines[0].name);
    expect(second.trailing.activationPct).toBe(3);
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

  it("五層含底倉的數量只由單一 maxLayers 與 multiplier 衍生", () => {
    expect(buildKamaRainbowMartinLayerQuantities(0.01, 5, 2)).toEqual([0.01, 0.02, 0.04, 0.08, 0.16]);
    expect(buildKamaRainbowMartinLayerQuantities(0.01, 0, 2)).toEqual([]);
  });
});
