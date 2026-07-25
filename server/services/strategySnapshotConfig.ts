export type StrategySnapshotConfig = Record<string, unknown>;

export const SNAPSHOT_CONFIG_STATE_KEY = "__snapshotConfig";
export const SNAPSHOT_META_STATE_KEY = "__snapshotMeta";

/**
 * 既有引擎仍會從版本化欄位讀取配置；新引擎一律可直接讀取
 * __snapshotConfig，因此新增策略時毋須再修改此清單。
 */
const LEGACY_CONFIG_KEY_BY_STRATEGY: Readonly<Record<string, string>> = {
  KAMA_3K_BREAKOUT_V25: "__v25Config",
  "20415_KAMA_MARTIN_V35": "__v35Config",
  KAMA_3K_ULTIMATE_V50: "__v50Config",
  KAMA_3K_HF_V61: "__v61Config",
  KAMA_3K_TORNADO_V70: "__v70Config",
  strategy_20415: "__v2_0Config",
};

export type SnapshotSourceMetadata = {
  strategyKey: string;
  snapshotId?: number;
  snapshotName?: string | null;
  importedAt?: number;
};

export type SnapshotPositionMode = "quantity" | "usdt";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 回測的 tradeAmount 定義為 USDT；舊快照缺少單位時亦採 USDT 作安全預設，
 * 絕不可把例如 100 USDT 靜默解讀為 100 BTC。
 */
export function resolveSnapshotPositionMode(
  backtestSettings: unknown,
): SnapshotPositionMode {
  if (isRecord(backtestSettings)) {
    const mode = backtestSettings.baseLotSizeMode;
    if (mode === "quantity" || mode === "usdt") return mode;
  }
  return "usdt";
}

export function getLegacyConfigKey(strategyKey: string): string | undefined {
  return LEGACY_CONFIG_KEY_BY_STRATEGY[strategyKey];
}

/**
 * 部分既有執行器預期 Martin_Layers 是 JSON 字串。原始快照不會被修改，
 * 只在寫入舊版相容欄位時做格式橋接。
 */
export function toLegacyCompatibleConfig(
  config: StrategySnapshotConfig,
): StrategySnapshotConfig {
  const martinLayers = config.Martin_Layers;
  if (martinLayers == null || typeof martinLayers === "string") {
    return { ...config };
  }

  return {
    ...config,
    Martin_Layers: JSON.stringify(martinLayers),
  };
}

/**
 * 快照部署的不變條件：
 * 1. __snapshotConfig 完整保存快照原始配置，供所有未來策略使用；
 * 2. __snapshotMeta 保存不可由前端覆蓋的原 strategyKey；
 * 3. 已知舊引擎同步寫入版本化欄位，維持向後相容。
 */
export function attachSnapshotConfig(
  currentState: Record<string, unknown> | null | undefined,
  strategyKey: string,
  config: StrategySnapshotConfig,
  metadata: Omit<SnapshotSourceMetadata, "strategyKey"> = {},
): Record<string, unknown> {
  const nextState: Record<string, unknown> = {
    ...(currentState ?? {}),
    [SNAPSHOT_CONFIG_STATE_KEY]: { ...config },
    [SNAPSHOT_META_STATE_KEY]: {
      strategyKey,
      snapshotId: metadata.snapshotId,
      snapshotName: metadata.snapshotName ?? null,
      importedAt: metadata.importedAt ?? Date.now(),
    },
  };

  const legacyConfigKey = getLegacyConfigKey(strategyKey);
  if (legacyConfigKey) {
    nextState[legacyConfigKey] = toLegacyCompatibleConfig(config);
  }

  return nextState;
}

/**
 * 執行期間優先使用與當前引擎身份一致的原始快照配置；舊資料則回退至
 * 既有版本化欄位。未知策略不會錯誤回退到 V3.5。
 */
export function getBoundStrategyConfig(
  state: unknown,
  strategyKey: string,
): StrategySnapshotConfig | undefined {
  if (!isRecord(state)) return undefined;

  const snapshotConfig = state[SNAPSHOT_CONFIG_STATE_KEY];
  const snapshotMeta = state[SNAPSHOT_META_STATE_KEY];
  if (
    isRecord(snapshotConfig) &&
    isRecord(snapshotMeta) &&
    snapshotMeta.strategyKey === strategyKey
  ) {
    return snapshotConfig;
  }

  const legacyConfigKey = getLegacyConfigKey(strategyKey);
  const legacyConfig = legacyConfigKey ? state[legacyConfigKey] : undefined;
  return isRecord(legacyConfig) ? legacyConfig : undefined;
}

/** 保留所有雙底線開頭的配置／中繼資料，避免未來策略在狀態更新時丟失。 */
export function pickStrategyConfigState(
  state: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!state) return {};
  return Object.fromEntries(
    Object.entries(state).filter(([key]) => key.startsWith("__")),
  );
}
