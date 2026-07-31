import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_CONFIG_STATE_KEY,
  SNAPSHOT_META_STATE_KEY,
  SNAPSHOT_ARTIFACT_STATE_KEY,
  attachSnapshotConfig,
  getBoundStrategyArtifact,
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
import {
  createV41DefaultConfig,
  getV41ConfigHash,
  V41_STRATEGY_KEY,
} from "../../shared/strategies/kama3kMartinV41";
import {
  buildStrategyArtifactEnvelope,
  buildStrategyLogicHash,
  createVersionedCapabilityManifest,
} from "./strategyArtifacts";

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

  it("canonical artifact 與配置一同 round-trip，且錯誤策略 identity fail closed", () => {
    const strategyKey = "20415_KAMA_MARTIN_V35";
    const strategyLogicHash = buildStrategyLogicHash({
      strategyKey,
      strategyVersion: 1,
      logicSource: "snapshot-state-bridge-test",
    });
    const capabilityManifest = createVersionedCapabilityManifest({
      strategyKey,
      strategyVersion: 1,
      strategyLogicHash,
      certification: "CERTIFIED",
      capabilities: {
        supportedModes: ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"],
        martingaleLayers: true,
        independentLegState: true,
        hedgeGuard: true,
        preciseLegClose: true,
      },
    });
    const config = { Initial_Capital: 10_000, Base_Lot_Size: 30 };
    const artifact = buildStrategyArtifactEnvelope({
      artifactScope: "EXECUTION_PROFILE",
      strategyKey,
      strategyVersion: 1,
      strategyLogicHash,
      config,
      executionMode: "HEDGE_GUARDED",
      capabilityManifest,
      source: { origin: "PARAMETER_SNAPSHOT", sourceSnapshotId: 88 },
    });
    const state = attachSnapshotConfig({}, strategyKey, config, {
      snapshotId: 88,
      artifact,
    });

    expect(state[SNAPSHOT_ARTIFACT_STATE_KEY]).toEqual(artifact);
    expect(getBoundStrategyArtifact(state, strategyKey)).toEqual(artifact);
    expect(getBoundStrategyArtifact(state, "KAMA_3K_ULTIMATE_V50")).toBeUndefined();
    expect(pickStrategyConfigState({ ...state, currentLayer: 3 }))
      .toHaveProperty(SNAPSHOT_ARTIFACT_STATE_KEY, artifact);
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
    expect((state.__v61Config as Record<string, unknown>).Martin_Layers).toEqual(martinLayers);
    expect((state.__v61Config as Record<string, unknown>).Reentry_On_Trend).toBe(false);
  });

  it("舊資料沒有通用快照中繼資料時，已知引擎仍可讀取既有版本配置", () => {
    const legacyState = { __v70Config: { risk_hard_stop_pct: 0, trailing_enabled: false } };
    expect(getBoundStrategyConfig(legacyState, "KAMA_3K_TORNADO_V70")).toEqual(legacyState.__v70Config);
  });

  it("V4.0 快照完整保留三 K 模式與三個顯式 false，不被導入／部署 fallback 改寫", () => {
    const rawConfig = {
      enableThreeKFilter: false,
      threeKPatternMode: "three_body_same_direction",
      enableKamaDirectionLock: false,
      enableSameDirectionReentry: false,
      KAMA_Slow_Length: 89,
      q2_fastest: 8,
      q3_slowest: 21,
    };
    const state = attachSnapshotConfig({}, "20415_KAMA_MARTIN_V35", rawConfig, {
      snapshotId: 40,
      snapshotName: "V4.0 入場安全閘",
      importedAt: 4000,
    });
    expect(state.__v35Config).toEqual(rawConfig);
    expect(state[SNAPSHOT_CONFIG_STATE_KEY]).toEqual(rawConfig);
    expect(getBoundStrategyConfig(state, "20415_KAMA_MARTIN_V35")).toEqual(rawConfig);
    expect(pickStrategyConfigState({ ...state, currentLayer: 3 })).toMatchObject({
      __v35Config: rawConfig,
      __snapshotConfig: rawConfig,
    });
  });

  it("V4.1 快照以同 key 雙寫並完整 round-trip AND／OR 與顯式 false", () => {
    const config = {
      ...createV41DefaultConfig(),
      entryConditionLogic: "or" as const,
      enableThreeKFilter: true,
      enableKamaFastSlowCross: false,
      enableKamaPriceVsSlow: false,
      enableSameDirectionReentry: false,
    };
    const state = attachSnapshotConfig({}, V41_STRATEGY_KEY, config, {
      snapshotId: 41,
      snapshotName: "V4.1 三條件 OR",
      importedAt: 4100,
    });
    expect(state.__v41Config).toEqual(config);
    expect(state[SNAPSHOT_CONFIG_STATE_KEY]).toEqual(config);
    expect(getBoundStrategyConfig(state, V41_STRATEGY_KEY)).toEqual(config);
    expect(getBoundStrategyConfig(state, "20415_KAMA_MARTIN_V35")).toBeUndefined();
    expect(getV41ConfigHash(getBoundStrategyConfig(state, V41_STRATEGY_KEY) as typeof config))
      .toBe(getV41ConfigHash(config));
    expect((state.__v41Config as Record<string, unknown>).enableKamaFastSlowCross).toBe(false);
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
    const rawConfig = { Base_Lot_Size: { value: 35, mode: "usdt" as const }, Take_Profit_Pct: 1.2 };
    const state = attachSnapshotConfig({}, "strategy_20415", rawConfig);
    const effectiveConfig = withObjectDeploymentBaseLot(rawConfig, { value: 0.001, mode: "quantity" });
    expect((state[SNAPSHOT_CONFIG_STATE_KEY] as Record<string, unknown>).Base_Lot_Size)
      .toEqual({ value: 35, mode: "usdt" });
    expect(effectiveConfig.Base_Lot_Size).toEqual({ value: 0.001, mode: "quantity" });
    expect(rawConfig.Base_Lot_Size).toEqual({ value: 35, mode: "usdt" });
  });

  it.each(["RAINBOW_TREND_LADDER_V1", "FUTURE_ENGINE_V99"])(
    "%s 的快照 100 USDT 只作策略配置，最終部署 500 USDT 獨立持久化",
    strategyKey => {
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
      }, { value: 100, mode: "usdt" });
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
    },
  );
});
