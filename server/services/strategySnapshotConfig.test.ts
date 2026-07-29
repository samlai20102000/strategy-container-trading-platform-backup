import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_CONFIG_STATE_KEY,
  SNAPSHOT_META_STATE_KEY,
  attachSnapshotConfig,
  getBoundStrategyConfig,
  pickStrategyConfigState,
  resolveSnapshotPositionMode,
} from "./strategySnapshotConfig";
import {
  deploymentPositionColumns,
  finalizeDeploymentPosition,
  withNumericDeploymentBaseLot,
  withObjectDeploymentBaseLot,
} from "./deploymentPosition";

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
    // V4.2 修復：Martin_Layers 保持為對象數組，避免前端反序列化失敗
    // 所有執行器都應使用 normalizeRainbowTrendLadderConfig() 進行規範化
    expect((state.__v61Config as Record<string, unknown>).Martin_Layers).toEqual(martinLayers);
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

  it("快照原始單位保持不變，但實盤部署可選擇不同合法單位", () => {
    const rawConfig = {
      Base_Lot_Size: { value: 35, mode: "usdt" as const },
      Take_Profit_Pct: 1.2,
    };
    const state = attachSnapshotConfig({}, "strategy_20415", rawConfig);
    const effectiveConfig = withObjectDeploymentBaseLot(rawConfig, {
      value: 0.001,
      mode: "quantity",
    });

    expect((state[SNAPSHOT_CONFIG_STATE_KEY] as Record<string, unknown>).Base_Lot_Size)
      .toEqual({ value: 35, mode: "usdt" });
    expect(effectiveConfig.Base_Lot_Size).toEqual({ value: 0.001, mode: "quantity" });
    expect(rawConfig.Base_Lot_Size).toEqual({ value: 35, mode: "usdt" });
  });

  it.each([
    "RAINBOW_TREND_LADDER_V1",
    "FUTURE_ENGINE_V99",
  ])("%s 的快照 100 USDT 只作策略配置，最終部署 500 USDT 獨立持久化", strategyKey => {
    const rawSnapshotConfig = {
      Base_Lot_Size: 100,
      Position_Mode: "usdt",
      Position_Value: 100,
      Keep_Future_Logic: true,
    };
    const state = attachSnapshotConfig({}, strategyKey, rawSnapshotConfig);
    const finalPosition = finalizeDeploymentPosition({
      positionSize: 500,
      positionMode: "usdt",
    }, {
      value: 100,
      mode: "usdt",
    });
    const effectiveConfig = withNumericDeploymentBaseLot(rawSnapshotConfig, finalPosition);

    expect(deploymentPositionColumns(finalPosition)).toEqual({
      positionSize: "500",
      positionMode: "usdt",
      positionSizeObject: { value: 500, mode: "usdt" },
    });
    expect(effectiveConfig).toMatchObject({
      Base_Lot_Size: 500,
      Position_Mode: "usdt",
      Position_Value: 500,
      Keep_Future_Logic: true,
    });
    expect(state[SNAPSHOT_CONFIG_STATE_KEY]).toEqual(rawSnapshotConfig);
    expect(rawSnapshotConfig).toMatchObject({
      Base_Lot_Size: 100,
      Position_Mode: "usdt",
      Position_Value: 100,
    });
  });
});
