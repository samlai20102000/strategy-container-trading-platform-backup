import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_CONFIG_STATE_KEY,
  SNAPSHOT_META_STATE_KEY,
  assertSnapshotPositionMode,
  attachSnapshotConfig,
  getBoundStrategyConfig,
  pickStrategyConfigState,
  resolveSnapshotPositionMode,
} from "./strategySnapshotConfig";

describe("通用快照部署契約", () => {
  it("未知未來策略應完整保存原始配置，而不錯誤回退到 V3.5", () => {
    const rawConfig = {
      threshold: 0,
      allowReentry: false,
      nested: { mode: "future", weights: [0, 0.5, 1] },
    };

    const state = attachSnapshotConfig(null, "FUTURE_ENGINE_V99", rawConfig, {
      snapshotId: 99,
      snapshotName: "未來策略最佳參數",
      importedAt: 123456,
    });

    expect(state[SNAPSHOT_CONFIG_STATE_KEY]).toEqual(rawConfig);
    expect(state[SNAPSHOT_META_STATE_KEY]).toEqual({
      strategyKey: "FUTURE_ENGINE_V99",
      snapshotId: 99,
      snapshotName: "未來策略最佳參數",
      importedAt: 123456,
    });
    expect(state.__v35Config).toBeUndefined();
    expect(getBoundStrategyConfig(state, "FUTURE_ENGINE_V99")).toEqual(rawConfig);
  });

  it("快照身份與目前策略引擎不一致時必須拒絕讀取原始配置", () => {
    const state = attachSnapshotConfig({}, "ENGINE_A", { risk: 0, enabled: false });

    expect(getBoundStrategyConfig(state, "ENGINE_A")).toEqual({ risk: 0, enabled: false });
    expect(getBoundStrategyConfig(state, "ENGINE_B")).toBeUndefined();
  });

  it("既有策略應同時保存完整原始配置及相容欄位，但不改寫原始 Martin_Layers", () => {
    const martinLayers = [
      { start: 1, end: 3, multiplier: 1.2, stepPct: 0 },
      { start: 4, end: 8, multiplier: 1.1, stepPct: 2 },
    ];
    const rawConfig = { Martin_Layers: martinLayers, Reentry_On_Trend: false };

    const state = attachSnapshotConfig({}, "KAMA_3K_HF_V61", rawConfig);

    expect(state[SNAPSHOT_CONFIG_STATE_KEY]).toEqual(rawConfig);
    expect((state[SNAPSHOT_CONFIG_STATE_KEY] as Record<string, unknown>).Martin_Layers).toEqual(martinLayers);
    expect((state.__v61Config as Record<string, unknown>).Martin_Layers).toBe(JSON.stringify(martinLayers));
    expect((state.__v61Config as Record<string, unknown>).Reentry_On_Trend).toBe(false);
  });

  it("舊資料沒有通用快照中繼資料時，已知引擎仍可讀取既有版本配置", () => {
    const legacyState = {
      __v70Config: { risk_hard_stop_pct: 0, trailing_enabled: false },
    };

    expect(getBoundStrategyConfig(legacyState, "KAMA_3K_TORNADO_V70")).toEqual(
      legacyState.__v70Config,
    );
  });

  it("停止或重置策略時應保留所有雙底線配置，包括未來新增的鍵", () => {
    const state = {
      __snapshotConfig: { zero: 0, disabled: false },
      __snapshotMeta: { strategyKey: "FUTURE_ENGINE_V99" },
      __futureEngineConfig: { alpha: 7 },
      currentLayer: 8,
      avgPrice: 123,
    };

    expect(pickStrategyConfigState(state)).toEqual({
      __snapshotConfig: { zero: 0, disabled: false },
      __snapshotMeta: { strategyKey: "FUTURE_ENGINE_V99" },
      __futureEngineConfig: { alpha: 7 },
    });
  });

  it("舊快照缺少倉位單位時必須安全回退為 USDT，而不能當作幣量", () => {
    expect(resolveSnapshotPositionMode(null)).toBe("usdt");
    expect(resolveSnapshotPositionMode({ tradeAmount: 100 })).toBe("usdt");
    expect(resolveSnapshotPositionMode({ baseLotSizeMode: "invalid" })).toBe("usdt");
    expect(resolveSnapshotPositionMode({ baseLotSizeMode: "quantity" })).toBe("quantity");
  });

  it("前端不得覆蓋快照保存的倉位單位", () => {
    expect(assertSnapshotPositionMode("usdt", { baseLotSizeMode: "usdt" })).toBe("usdt");
    expect(() =>
      assertSnapshotPositionMode("quantity", { baseLotSizeMode: "usdt" }),
    ).toThrow("倉位單位與快照不一致");
  });
});
