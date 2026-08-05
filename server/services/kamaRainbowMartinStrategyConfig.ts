import {
  assertExplicitKamaRainbowMartinConfig,
  getKamaRainbowMartinTimeframeMinutes,
  getLayerGapPct,
  getLayerMultiplier,
  KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY,
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  type KamaRainbowMartinConfig,
} from "../../shared/strategies/kamaRainbowMartin";
import {
  attachSnapshotConfig,
  getBoundStrategyConfig,
  SNAPSHOT_CONFIG_STATE_KEY,
  SNAPSHOT_META_STATE_KEY,
  type SnapshotAttachMetadata,
} from "./strategySnapshotConfig";

type StrategyState = Record<string, unknown> | null | undefined;

export interface KamaRainbowMartinStrategyColumns {
  stopLossPct: string;
  takeProfitPct: string;
  martinMultiplier: string;
  maxMartinLevel: number;
  martinSpacingPct: string;
  kLinePeriod: number;
  reentryEnabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * KRM 的私有 canonical config 是重新入市及策略參數的真相來源；
 * strategies 頂層欄位只作舊 runtime／卡片查詢的相容投影。
 */
export function resolveBoundKamaRainbowMartinConfig(
  state: unknown,
  _fallbackReentryEnabled = false,
): KamaRainbowMartinConfig {
  const boundConfig = getBoundStrategyConfig(state, KAMA_RAINBOW_MARTIN_STRATEGY_KEY);
  return assertExplicitKamaRainbowMartinConfig(boundConfig);
}

export function deriveKamaRainbowMartinStrategyColumns(
  config: KamaRainbowMartinConfig,
): KamaRainbowMartinStrategyColumns {
  return {
    stopLossPct: String(config.hardStopLossPct),
    takeProfitPct: "0",
    martinMultiplier: String(getLayerMultiplier(1, config.layerConfigs, config.multiplier)),
    maxMartinLevel: config.maxLayers,
    martinSpacingPct: String(getLayerGapPct(1, config.layerConfigs, config.gapPct)),
    kLinePeriod: getKamaRainbowMartinTimeframeMinutes(config.timeframe),
    reentryEnabled: config.reentryEnabled,
  };
}

/**
 * 將已驗證 KRM 配置寫入 canonical 私有欄位，並在需要時同步通用快照綁定。
 * 未提供 metadata（一般新建／編輯）時保留既有快照 provenance，只更新同身份配置。
 */
export function bindKamaRainbowMartinStrategyConfig(
  currentState: StrategyState,
  rawConfig: unknown,
  metadata?: SnapshotAttachMetadata,
): {
  config: KamaRainbowMartinConfig;
  martinState: Record<string, unknown>;
  columns: KamaRainbowMartinStrategyColumns;
} {
  const config = assertExplicitKamaRainbowMartinConfig(rawConfig);
  const state = isRecord(currentState) ? currentState : {};
  let martinState: Record<string, unknown>;

  if (metadata) {
    martinState = attachSnapshotConfig(
      state,
      KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
      config as unknown as Record<string, unknown>,
      metadata,
    );
  } else {
    const snapshotMeta = state[SNAPSHOT_META_STATE_KEY];
    const hasMatchingSnapshotBinding = isRecord(snapshotMeta)
      && snapshotMeta.strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY;
    martinState = {
      ...state,
      [KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY]: { ...config },
      ...(hasMatchingSnapshotBinding
        ? { [SNAPSHOT_CONFIG_STATE_KEY]: { ...config } }
        : {}),
    };
  }

  return {
    config,
    martinState,
    columns: deriveKamaRainbowMartinStrategyColumns(config),
  };
}
