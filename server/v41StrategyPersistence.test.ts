import { describe, expect, it } from "vitest";
import {
  createV41DefaultConfig,
  getV41ConfigHash,
  validateV41Config,
  V41_CONFIG_KEY,
  V41_STRATEGY_KEY,
} from "../shared/strategies/kama3kMartinV41";
import {
  assertV41ConfigIsolation,
  attachV41StrategyConfig,
  deriveV41StrategyColumns,
  resolveV41ConfigForStrategy,
} from "./services/v41StrategyConfig";
import {
  getBoundStrategyConfig,
  SNAPSHOT_CONFIG_STATE_KEY,
  SNAPSHOT_META_STATE_KEY,
} from "./services/strategySnapshotConfig";

function validConfig() {
  return {
    ...createV41DefaultConfig(),
    entryConditionLogic: "or" as const,
    enableThreeKFilter: true,
    enableKamaFastSlowCross: false,
    enableKamaPriceVsSlow: false,
    enableSameDirectionReentry: false,
  };
}

describe("V4.1 策略持久化契約", () => {
  it("V4.1 create 必須提供可執行的完整 canonical config", () => {
    expect(() => resolveV41ConfigForStrategy(V41_STRATEGY_KEY, undefined, { required: true }))
      .toThrow("必須提供完整 v41Config");
    expect(() => resolveV41ConfigForStrategy(V41_STRATEGY_KEY, createV41DefaultConfig(), { required: true }))
      .toThrow("V41_NO_ENTRY_CONDITION_ENABLED");
  });

  it("非 V4.1 引擎夾帶 v41Config 必須拒絕", () => {
    expect(() => resolveV41ConfigForStrategy("20415_KAMA_MARTIN_V35", validConfig()))
      .toThrow(`僅可用於 ${V41_STRATEGY_KEY}`);
  });

  it("V4.1 不可夾帶 V4.0 或其他版本私有配置", () => {
    expect(() => assertV41ConfigIsolation(V41_STRATEGY_KEY, {
      v35Config: { enableThreeKFilter: true },
      v50Config: undefined,
    })).toThrow("不可夾帶其他版本配置：v35Config");
    expect(() => assertV41ConfigIsolation(V41_STRATEGY_KEY, { v35Config: undefined }))
      .not.toThrow();
  });

  it("AND／OR、三條件 false 與重入 false 經寫入後保持原值", () => {
    const config = resolveV41ConfigForStrategy(V41_STRATEGY_KEY, validConfig(), { required: true })!;
    const state = attachV41StrategyConfig({ currentLayer: 2 }, config, "策略建立配置");

    expect(state[V41_CONFIG_KEY]).toEqual(config);
    expect(state[SNAPSHOT_CONFIG_STATE_KEY]).toEqual(config);
    expect(state[SNAPSHOT_META_STATE_KEY]).toMatchObject({ strategyKey: V41_STRATEGY_KEY });
    expect(getBoundStrategyConfig(state, V41_STRATEGY_KEY)).toEqual(config);
    expect(getV41ConfigHash(getBoundStrategyConfig(state, V41_STRATEGY_KEY) as typeof config))
      .toBe(getV41ConfigHash(config));
    expect(config).toMatchObject({
      entryConditionLogic: "or",
      enableKamaFastSlowCross: false,
      enableKamaPriceVsSlow: false,
      enableSameDirectionReentry: false,
    });
  });

  it("完整 canonical martinState 經 JSON round-trip 後身份、false、陣列與 hash 均不漂移", () => {
    const config = resolveV41ConfigForStrategy(V41_STRATEGY_KEY, validConfig(), { required: true })!;
    const state = attachV41StrategyConfig({ currentLayer: 0, totalSize: 0 }, config, "JSON round-trip");

    const restoredState = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    const restoredConfig = getBoundStrategyConfig(restoredState, V41_STRATEGY_KEY);
    const restoredValidation = validateV41Config(restoredConfig);

    expect(restoredState[SNAPSHOT_META_STATE_KEY]).toMatchObject({
      strategyKey: V41_STRATEGY_KEY,
      snapshotName: "JSON round-trip",
    });
    expect(restoredValidation.valid).toBe(true);
    expect(restoredValidation.config).toEqual(config);
    expect(restoredValidation.config?.Martin_Layers).toHaveLength(3);
    expect(restoredValidation.config).toMatchObject({
      entryConditionLogic: "or",
      enableThreeKFilter: true,
      enableKamaFastSlowCross: false,
      enableKamaPriceVsSlow: false,
      enableSameDirectionReentry: false,
    });
    expect(getV41ConfigHash(restoredValidation.config!)).toBe(getV41ConfigHash(config));
  });

  it("canonical config 正確投影策略查詢欄位", () => {
    const config = validConfig();
    expect(deriveV41StrategyColumns(config)).toEqual({
      stopLossPct: "5",
      takeProfitPct: "1",
      martinMultiplier: "1.5",
      maxMartinLevel: 11,
      martinSpacingPct: "2",
      kLinePeriod: 30,
      reentryEnabled: false,
    });
  });
});
