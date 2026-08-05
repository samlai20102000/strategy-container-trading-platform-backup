import { describe, expect, it } from "vitest";

import {
  KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY,
  createKamaRainbowMartinDefaultConfig,
} from "../../shared/strategies/kamaRainbowMartin";
import {
  SNAPSHOT_CONFIG_STATE_KEY,
  SNAPSHOT_META_STATE_KEY,
} from "./strategySnapshotConfig";
import {
  bindKamaRainbowMartinStrategyConfig,
  resolveBoundKamaRainbowMartinConfig,
} from "./kamaRainbowMartinStrategyConfig";

describe("KRM canonical strategy config binding", () => {
  it("新建策略時由 canonical config 同步寫入重新入市與相容欄位", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    config.reentryEnabled = true;
    config.hardStopLossPct = 6.5;
    config.maxLayers = 9;

    const binding = bindKamaRainbowMartinStrategyConfig(undefined, config);

    expect(binding.martinState[KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY]).toEqual(binding.config);
    expect(binding.columns).toMatchObject({
      reentryEnabled: true,
      stopLossPct: "6.5",
      takeProfitPct: "0",
      maxMartinLevel: binding.config.maxLayers,
    });
  });

  it("快照匯入時同時保存 canonical 私有配置、通用快照配置與 provenance", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    config.reentryEnabled = true;

    const binding = bindKamaRainbowMartinStrategyConfig(
      { currentLayer: 3 },
      config,
      { snapshotId: 88, snapshotName: "KRM 重入快照", importedAt: 12_345 },
    );

    expect(binding.martinState.currentLayer).toBe(3);
    expect(binding.martinState[KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY]).toEqual(binding.config);
    expect(binding.martinState[SNAPSHOT_CONFIG_STATE_KEY]).toEqual(binding.config);
    expect(binding.martinState[SNAPSHOT_META_STATE_KEY]).toMatchObject({
      snapshotId: 88,
      snapshotName: "KRM 重入快照",
    });
    expect(binding.columns.reentryEnabled).toBe(true);
  });

  it("編輯已綁定快照策略時更新兩份 canonical 配置且保留原 provenance", () => {
    const initialConfig = createKamaRainbowMartinDefaultConfig();
    initialConfig.reentryEnabled = true;
    const imported = bindKamaRainbowMartinStrategyConfig(
      {},
      initialConfig,
      { snapshotId: 99, snapshotName: "原始快照", importedAt: 99_000 },
    );
    const editedConfig = { ...imported.config, reentryEnabled: false };

    const edited = bindKamaRainbowMartinStrategyConfig(imported.martinState, editedConfig);

    expect((edited.martinState[KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY] as Record<string, unknown>).reentryEnabled)
      .toBe(false);
    expect((edited.martinState[SNAPSHOT_CONFIG_STATE_KEY] as Record<string, unknown>).reentryEnabled)
      .toBe(false);
    expect(edited.martinState[SNAPSHOT_META_STATE_KEY]).toEqual(imported.martinState[SNAPSHOT_META_STATE_KEY]);
    expect(edited.columns.reentryEnabled).toBe(false);
  });

  it("讀取時以 canonical 私有配置為真相來源，缺少綁定時 fail-closed", () => {
    const canonical = createKamaRainbowMartinDefaultConfig();
    canonical.reentryEnabled = false;

    expect(resolveBoundKamaRainbowMartinConfig({
      [KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY]: canonical,
    }, true).reentryEnabled).toBe(false);
    expect(() => resolveBoundKamaRainbowMartinConfig({}, true)).toThrow(/KRM_CONFIG_MISSING/);
  });

  it("保存邊界不得把 undefined 靜默正規化為兩線預設", () => {
    expect(() => bindKamaRainbowMartinStrategyConfig(undefined, undefined))
      .toThrow(/KRM_CONFIG_MISSING/);
  });
});
