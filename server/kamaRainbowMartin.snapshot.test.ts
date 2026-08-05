import { describe, expect, it } from "vitest";
import {
  KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY,
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  createKamaRainbowMartinDefaultConfig,
  createKamaRainbowMartinLineSetReceipt,
  validateKamaRainbowMartinConfig,
} from "../shared/strategies/kamaRainbowMartin";
import { normalizeSnapshotConfigForStrategy } from "./routers/backtest.router";
import {
  SNAPSHOT_CONFIG_STATE_KEY,
  SNAPSHOT_META_STATE_KEY,
  attachSnapshotConfig,
  getBoundStrategyConfig,
  resolveSnapshotPositionMode,
} from "./services/strategySnapshotConfig";

describe("Kama 彩虹馬丁快照 canonical round-trip", () => {
  it("從私有命名空間擷取 canonical config，且不把頂層 Position_Size／Mode 污染策略配置", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    const normalized = normalizeSnapshotConfigForStrategy(KAMA_RAINBOW_MARTIN_STRATEGY_KEY, {
      [KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY]: config,
      Position_Size_Value: 250,
      Position_Size_Mode: "quantity",
      tradeAmount: 250,
    });

    expect(normalized).toEqual(config);
    expect(normalized).not.toHaveProperty("Position_Size_Value");
    expect(normalized).not.toHaveProperty("Position_Size_Mode");
    expect(normalized).not.toHaveProperty("tradeAmount");
    expect(validateKamaRainbowMartinConfig(normalized).valid).toBe(true);
  });

  it("完整配置經 attach、JSON 序列化與讀回後不漂移，wrong-key 讀取必須 fail-closed", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    config.reentryEnabled = true;
    config.trailing.enabled = false;
    config.kamaLines[1].enabled = false;
    config.kamaLines.push(
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `KAMA_${index + 3}`,
        name: `KAMA ${index + 3}`,
        erPeriod: 30 + index * 10,
        fastEma: 2,
        slowEma: 30 + index,
        enabled: true,
        color: `#${(index + 3).toString(16).padStart(6, "0")}`,
      })),
    );
    const sourceReceipt = createKamaRainbowMartinLineSetReceipt(config, "snapshot");

    const state = attachSnapshotConfig(
      { currentLayer: 0, runtimeOnly: "preserved" },
      KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
      config,
      { snapshotId: 101, snapshotName: "KRM round-trip", importedAt: 123456 },
    );
    const restored = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    const restoredConfig = getBoundStrategyConfig(restored, KAMA_RAINBOW_MARTIN_STRATEGY_KEY);

    expect(restored[SNAPSHOT_CONFIG_STATE_KEY]).toEqual(config);
    expect(restored[SNAPSHOT_META_STATE_KEY]).toMatchObject({
      strategyKey: KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
      snapshotId: 101,
      snapshotName: "KRM round-trip",
      importedAt: 123456,
    });
    expect(restoredConfig).toEqual(config);
    expect(restoredConfig?.reentryEnabled).toBe(true);
    expect(validateKamaRainbowMartinConfig(restoredConfig).valid).toBe(true);
    expect(restoredConfig?.kamaLines.map(line => line.id)).toEqual([
      config.kamaLines[0].id,
      config.kamaLines[1].id,
      "KAMA_3",
      "KAMA_4",
      "KAMA_5",
      "KAMA_6",
    ]);
    expect(createKamaRainbowMartinLineSetReceipt(restoredConfig, "strategy-binding")).toMatchObject({
      totalLineCount: 6,
      enabledLineCount: 5,
      lineSetHash: sourceReceipt.lineSetHash,
      configHash: sourceReceipt.configHash,
    });
    expect(getBoundStrategyConfig(restored, "RAINBOW_TREND_LADDER_V1")).toBeUndefined();
  });

  it("錯誤策略配置與不支援版本一律拒絕，舊快照缺單位時安全預設為 USDT", () => {
    expect(() => normalizeSnapshotConfigForStrategy(KAMA_RAINBOW_MARTIN_STRATEGY_KEY, {
      version: "rainbow-trend-ladder-v1",
      Base_Lot_Size: { mode: "quantity", value: 1 },
    })).toThrow("Kama 彩虹馬丁快照參數錯誤");

    expect(resolveSnapshotPositionMode({ baseLotSizeMode: "quantity" })).toBe("quantity");
    expect(resolveSnapshotPositionMode({ baseLotSizeMode: "usdt" })).toBe("usdt");
    expect(resolveSnapshotPositionMode({})).toBe("usdt");
    expect(resolveSnapshotPositionMode(undefined)).toBe("usdt");
  });
});
