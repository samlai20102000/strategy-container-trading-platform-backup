import { getStrategy, getStrategyCapabilities } from "./strategyStudio";

export interface MartingaleCapabilityResult {
  isMartingale: boolean;
  supportsMartingale: boolean;
  enabled: boolean;
  maxLayers: number;
  reason:
    | "enabled"
    | "strategy_not_registered"
    | "capability_not_declared"
    | "disabled_by_config"
    | "invalid_layer_config";
}

export interface MartingaleStrategyInstanceLike {
  strategyKey?: string | null;
  martinState?: unknown;
  maxMartinLevel?: number | null;
  martinMultiplier?: string | number | null;
}

const PRIVATE_CONFIG_KEYS = [
  "__v25Config",
  "__v35Config",
  "__v41Config",
  "__v50Config",
  "__v61Config",
  "__v70Config",
  "__v2_0Config",
  "__rainbowTrendLadderConfig",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "off", "no", "disabled"].includes(normalized)) return false;
    if (["true", "1", "on", "yes", "enabled"].includes(normalized)) return true;
  }
  return fallback;
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function positiveLayerNumber(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function deriveMaxLayer(config: Record<string, unknown>): number {
  const explicit = positiveLayerNumber(firstDefined(config, [
    "Max_Layers",
    "max_layers",
    "maxLayers",
    "martin_max_layers",
  ]));

  const layerSource = firstDefined(config, [
    "Martin_Ranges",
    "Martin_Layers",
    "martin_ranges",
    "martin_layers",
    "MARTINGALE_LAYERS",
  ]);
  const derived = parseArray(layerSource).reduce<number>((maxLayer, item, index) => {
    if (!isRecord(item)) return Math.max(maxLayer, index + 1);
    const enabled = parseBoolean(item.enabled ?? item.active, true);
    if (!enabled) return maxLayer;
    return Math.max(
      maxLayer,
      positiveLayerNumber(item.endLayer),
      positiveLayerNumber(item.end),
      positiveLayerNumber(item.layer),
      index + 1,
    );
  }, 0);

  if (explicit > 0 && derived > 0) return Math.min(explicit, derived);
  return explicit || derived;
}

/**
 * 單一馬丁能力真相來源。
 *
 * 三重門檻：已註冊策略、類別明確 capability、實例配置啟用且至少兩層。
 * 未知／舊自訂策略與畸形配置一律 fail-closed，避免非馬丁策略出現逐層功能。
 */
export function evaluateMartingaleCapability(
  strategyKey: string,
  instanceConfig: unknown,
): MartingaleCapabilityResult {
  const strategy = getStrategy(strategyKey);
  if (!strategy) {
    return {
      isMartingale: false,
      supportsMartingale: false,
      enabled: false,
      maxLayers: 0,
      reason: "strategy_not_registered",
    };
  }

  const supportsMartingale = getStrategyCapabilities(strategyKey).martingaleLayers === true;
  if (!supportsMartingale) {
    return {
      isMartingale: false,
      supportsMartingale: false,
      enabled: false,
      maxLayers: 0,
      reason: "capability_not_declared",
    };
  }

  const config = {
    ...strategy.defaultConfig,
    ...(isRecord(instanceConfig) ? instanceConfig : {}),
  } as Record<string, unknown>;
  const enabled = parseBoolean(firstDefined(config, [
    "Martingale_Enabled",
    "Martin_Enabled",
    "martin_enabled",
    "martingale_enabled",
    "martinEnabled",
  ]), true);
  if (!enabled) {
    return {
      isMartingale: false,
      supportsMartingale: true,
      enabled: false,
      maxLayers: 0,
      reason: "disabled_by_config",
    };
  }

  const maxLayers = deriveMaxLayer(config);
  if (maxLayers < 2) {
    return {
      isMartingale: false,
      supportsMartingale: true,
      enabled: true,
      maxLayers,
      reason: "invalid_layer_config",
    };
  }

  return {
    isMartingale: true,
    supportsMartingale: true,
    enabled: true,
    maxLayers,
    reason: "enabled",
  };
}

export function isMartingaleStrategy(strategyKey: string, instanceConfig: unknown): boolean {
  return evaluateMartingaleCapability(strategyKey, instanceConfig).isMartingale;
}

/** 將 DB strategy row 的狀態與私有配置子鍵正規化後，再套用同一 fail-closed 契約。 */
export function evaluateMartingaleStrategyInstance(
  instance: MartingaleStrategyInstanceLike,
): MartingaleCapabilityResult {
  const strategyKey = typeof instance.strategyKey === "string" ? instance.strategyKey : "";
  const state = isRecord(instance.martinState) ? instance.martinState : {};
  const privateConfig = PRIVATE_CONFIG_KEYS.reduce<Record<string, unknown>>((merged, key) => {
    const candidate = state[key];
    return isRecord(candidate) ? { ...merged, ...candidate } : merged;
  }, {});

  return evaluateMartingaleCapability(strategyKey, {
    ...state,
    ...privateConfig,
    Max_Layers: instance.maxMartinLevel ?? privateConfig.Max_Layers ?? state.Max_Layers,
    martin_multiplier: instance.martinMultiplier,
  });
}
