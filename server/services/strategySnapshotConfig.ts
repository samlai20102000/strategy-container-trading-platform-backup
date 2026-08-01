export type StrategySnapshotConfig = Record<string, unknown>;

import type { StrategyArtifactEnvelope } from "./strategyArtifacts";

export const SNAPSHOT_CONFIG_STATE_KEY = "__snapshotConfig";
export const SNAPSHOT_META_STATE_KEY = "__snapshotMeta";
export const SNAPSHOT_ARTIFACT_STATE_KEY = "__strategyArtifact";

/**
 * 既有引擎仍會從版本化欄位讀取配置；新引擎一律可直接讀取
 * __snapshotConfig，因此新增策略時毋須再修改此清單。
 */
const LEGACY_CONFIG_KEY_BY_STRATEGY: Readonly<Record<string, string>> = {
  KAMA_3K_BREAKOUT_V25: "__v25Config",
  "20415_KAMA_MARTIN_V35": "__v35Config",
  "20415_KAMA_MARTIN_V41": "__v41Config",
  KAMA_3K_ULTIMATE_V50: "__v50Config",
  KAMA_3K_HF_V61: "__v61Config",
  KAMA_3K_TORNADO_V70: "__v70Config",
  strategy_20415: "__v2_0Config",
  RAINBOW_TREND_LADDER_V1: "__rainbowTrendLadderConfig",
  KAMA_RAINBOW_MARTIN_V1: "__kamaRainbowMartinConfig",
};

export type SnapshotSourceMetadata = {
  strategyKey: string;
  sourceKind?: "STRATEGY_DEFINITION" | "STRATEGY_INSTANCE" | "PARAMETER_SNAPSHOT" | "BACKTEST_RUN";
  sourceStrategyId?: number;
  sourceBacktestRunId?: string;
  snapshotId?: number;
  snapshotName?: string | null;
  importedAt?: number;
};

export type SnapshotAttachMetadata = Omit<SnapshotSourceMetadata, "strategyKey"> & {
  artifact?: StrategyArtifactEnvelope;
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
 * 
 * 修復（V4.2）：保持 Martin_Layers 為對象數組，避免前端反序列化失敗。
 * 舊版執行器會自動透過 parseLayers() 處理字符串或對象。
 */
export function toLegacyCompatibleConfig(
  config: StrategySnapshotConfig,
): StrategySnapshotConfig {
  // V4.2: 不再轉換 Martin_Layers，保持原始格式
  // 所有執行器都應使用 normalizeRainbowTrendLadderConfig() 進行規範化
  return { ...config };
}

/**
 * 快照部署的不變條件：
 * 1. __snapshotConfig 完整保存快照原始配置，供所有未來策略使用；
 * 2. __snapshotMeta 保存不可由前端覆蓋的原 strategyKey；
 * 3. 已知舊引擎同步寫入版本化欄位，維持向後相容；
 * 4. 此函式只更新 martinState，快照中的 Base_Lot_Size 永遠不得投影到
 *    strategies.positionSize／positionMode；執行期由部署倉位契約覆寫。
 */
export function attachSnapshotConfig(
  currentState: Record<string, unknown> | null | undefined,
  strategyKey: string,
  config: StrategySnapshotConfig,
  metadata: SnapshotAttachMetadata = {},
): Record<string, unknown> {
  const nextState: Record<string, unknown> = {
    ...(currentState ?? {}),
    [SNAPSHOT_CONFIG_STATE_KEY]: { ...config },
    [SNAPSHOT_META_STATE_KEY]: {
      strategyKey,
      sourceKind: metadata.sourceKind,
      sourceStrategyId: metadata.sourceStrategyId,
      sourceBacktestRunId: metadata.sourceBacktestRunId,
      snapshotId: metadata.snapshotId,
      snapshotName: metadata.snapshotName ?? null,
      importedAt: metadata.importedAt ?? Date.now(),
    },
    ...(metadata.artifact ? { [SNAPSHOT_ARTIFACT_STATE_KEY]: metadata.artifact } : {}),
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

/**
 * 僅回傳與目前引擎 identity 一致且具 canonical contract 的 artifact。
 * 舊快照沒有 artifact 時回傳 undefined，由呼叫端執行明確 legacy S1 migration。
 */
export function getBoundStrategyArtifact(
  state: unknown,
  strategyKey: string,
): StrategyArtifactEnvelope | undefined {
  if (!isRecord(state)) return undefined;
  const artifact = state[SNAPSHOT_ARTIFACT_STATE_KEY];
  if (!isRecord(artifact)) return undefined;
  if (artifact.contractVersion !== "strategy-artifact-v1") return undefined;
  if (artifact.strategyKey !== strategyKey) return undefined;
  return artifact as unknown as StrategyArtifactEnvelope;
}

/**
 * 只替換已驗證 execution profile artifact，不觸碰策略 runtime state、原始配置或來源 metadata。
 * lifecycle policy／mode 變更與 runtime legacy migration 共用此唯一寫入邊界。
 */
export function replaceBoundStrategyArtifact(
  state: Record<string, unknown> | null | undefined,
  strategyKey: string,
  artifact: StrategyArtifactEnvelope,
): Record<string, unknown> {
  if (artifact.strategyKey !== strategyKey) {
    throw new Error("ARTIFACT_STRATEGY_KEY_MISMATCH");
  }
  if (artifact.artifactScope !== "EXECUTION_PROFILE") {
    throw new Error("RUNTIME_ARTIFACT_SCOPE_INVALID");
  }
  return {
    ...(state ?? {}),
    [SNAPSHOT_ARTIFACT_STATE_KEY]: artifact,
  };
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
