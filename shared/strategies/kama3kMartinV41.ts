import { z } from "zod";

export const V41_STRATEGY_KEY = "20415_KAMA_MARTIN_V41" as const;
export const V41_STRATEGY_NAME = "V4.1 KAMA+3K 三條件動態馬丁策略" as const;
export const V41_CONFIG_VERSION = "4.1" as const;
export const V41_CONFIG_KEY = "__v41Config" as const;

export const V41_ENTRY_CONDITION_LOGICS = ["and", "or"] as const;
export const V41_THREE_K_MODES = ["breakout", "three_body_same_direction"] as const;

export type V41EntryConditionLogic = (typeof V41_ENTRY_CONDITION_LOGICS)[number];
export type V41ThreeKMode = (typeof V41_THREE_K_MODES)[number];

export interface V41MartinLayer {
  start: number;
  end: number;
  multiplier: number;
  stepPct?: number;
}

const V41MartinLayerSchema = z.object({
  start: z.number().int().min(1),
  end: z.number().int().min(1),
  multiplier: z.number().finite().min(0.1).max(5),
  stepPct: z.number().finite().min(0.1).max(20).optional(),
}).strict();

const V41ConfigShape = z.object({
  strategyKey: z.literal(V41_STRATEGY_KEY),
  configVersion: z.literal(V41_CONFIG_VERSION),
  entryConditionLogic: z.enum(V41_ENTRY_CONDITION_LOGICS),
  enableThreeKFilter: z.boolean(),
  threeKMode: z.enum(V41_THREE_K_MODES),
  enableKamaFastSlowCross: z.boolean(),
  enableKamaPriceVsSlow: z.boolean(),
  enableSameDirectionReentry: z.boolean(),
  Initial_Capital: z.number().finite().min(100).max(10_000_000),
  Base_Lot_Size: z.number().finite().min(1).max(100_000),
  First_Order_Pct: z.number().finite().min(0.01).max(10),
  Max_Loss_Pct: z.number().finite().min(0.5).max(50),
  KAMA_Fast_Length: z.number().int().min(5).max(200),
  p2_fastest: z.number().int().min(2).max(50),
  p3_slowest: z.number().int().min(1).max(30),
  KAMA_Slow_Length: z.number().int().min(5).max(200),
  q2_fastest: z.number().int().min(2).max(50),
  q3_slowest: z.number().int().min(1).max(30),
  Martin_Multiplier: z.number().finite().min(1).max(5),
  Max_Layers: z.number().int().min(1).max(20),
  Martin_Step_Pct: z.number().finite().min(0.1).max(20),
  Martin_Layers: z.array(V41MartinLayerSchema).min(1),
  Target_TP_Pct: z.number().finite().min(0.1).max(20),
  Callback_Pct: z.number().finite().min(0.01).max(5),
  K_Line_Period: z.number().int().min(1).max(1440),
  Kama_Reversal_Min_Layer: z.number().int().min(0).max(20),
}).strict();

export const V41_CONFIG_SCHEMA = V41ConfigShape.superRefine((config, ctx) => {
  if (countEnabledV41EntryConditions(config) === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["entryConditions"],
      message: "V41_NO_ENTRY_CONDITION_ENABLED：至少啟用一個方向條件",
    });
  }

  if (config.q3_slowest <= config.p3_slowest) {
    ctx.addIssue({
      code: "custom",
      path: ["q3_slowest"],
      message: "慢線最慢常數必須大於快線最慢常數",
    });
  }

  config.Martin_Layers.forEach((layer, index) => {
    if (layer.end < layer.start) {
      ctx.addIssue({
        code: "custom",
        path: ["Martin_Layers", index, "end"],
        message: "結束層必須大於等於起始層",
      });
    }
    if (index === 0 && layer.start !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["Martin_Layers", index, "start"],
        message: "第一個分層必須從第 1 層開始",
      });
    }
    if (index > 0 && layer.start !== config.Martin_Layers[index - 1].end + 1) {
      ctx.addIssue({
        code: "custom",
        path: ["Martin_Layers", index, "start"],
        message: "分層必須連續且不可重疊",
      });
    }
  });

  const lastLayer = config.Martin_Layers.at(-1);
  if (lastLayer && lastLayer.end !== config.Max_Layers) {
    ctx.addIssue({
      code: "custom",
      path: ["Max_Layers"],
      message: "最大層數必須等於最後一個馬丁分層的結束層",
    });
  }
});

export type NormalizedV41Config = z.infer<typeof V41ConfigShape>;

export interface V41ConfigValidationIssue {
  path: string;
  message: string;
}

export interface V41ConfigValidationResult {
  valid: boolean;
  config: NormalizedV41Config | null;
  issues: V41ConfigValidationIssue[];
}

const DEFAULT_MARTIN_LAYERS: V41MartinLayer[] = [
  { start: 1, end: 4, multiplier: 1.5 },
  { start: 5, end: 9, multiplier: 1.1 },
  { start: 10, end: 11, multiplier: 1.0 },
];

export const V41_DEFAULT_CONFIG: Readonly<NormalizedV41Config> = {
  strategyKey: V41_STRATEGY_KEY,
  configVersion: V41_CONFIG_VERSION,
  entryConditionLogic: "and",
  enableThreeKFilter: false,
  threeKMode: "breakout",
  enableKamaFastSlowCross: false,
  enableKamaPriceVsSlow: false,
  enableSameDirectionReentry: false,
  Initial_Capital: 10_000,
  Base_Lot_Size: 30,
  First_Order_Pct: 0.3,
  Max_Loss_Pct: 5,
  KAMA_Fast_Length: 50,
  p2_fastest: 10,
  p3_slowest: 2,
  KAMA_Slow_Length: 50,
  q2_fastest: 10,
  q3_slowest: 6,
  Martin_Multiplier: 1.5,
  Max_Layers: 11,
  Martin_Step_Pct: 2,
  Martin_Layers: DEFAULT_MARTIN_LAYERS,
  Target_TP_Pct: 1,
  Callback_Pct: 0.1,
  K_Line_Period: 30,
  Kama_Reversal_Min_Layer: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function toFiniteNumber(value: unknown, fallback: number): number {
  if (value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : fallback;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "on", "yes"].includes(normalized)) return true;
    if (["false", "0", "off", "no"].includes(normalized)) return false;
  }
  return fallback;
}

function cloneMartinLayers(layers: readonly V41MartinLayer[]): V41MartinLayer[] {
  return layers.map((layer) => ({ ...layer }));
}

function parseMartinLayers(value: unknown): V41MartinLayer[] {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return cloneMartinLayers(DEFAULT_MARTIN_LAYERS);
    }
  }
  if (!Array.isArray(source) || source.length === 0) {
    return cloneMartinLayers(DEFAULT_MARTIN_LAYERS);
  }

  return source.map((candidate, index) => {
    const layer = isRecord(candidate) ? candidate : {};
    const fallback = DEFAULT_MARTIN_LAYERS[index] ?? {
      start: index + 1,
      end: index + 1,
      multiplier: 1,
    };
    const stepSource = firstDefined(layer.stepPct, layer.gap);
    const stepPct = stepSource === undefined
      ? fallback.stepPct
      : toFiniteNumber(stepSource, fallback.stepPct ?? V41_DEFAULT_CONFIG.Martin_Step_Pct);
    return {
      start: toFiniteNumber(layer.start, fallback.start),
      end: toFiniteNumber(layer.end, fallback.end),
      multiplier: toFiniteNumber(layer.multiplier, fallback.multiplier),
      ...(stepPct === undefined ? {} : { stepPct }),
    };
  });
}

export function createV41DefaultConfig(): NormalizedV41Config {
  return {
    ...V41_DEFAULT_CONFIG,
    Martin_Layers: cloneMartinLayers(V41_DEFAULT_CONFIG.Martin_Layers),
  };
}

/**
 * 僅供建立表單草稿、讀取既有資料及顯式版本轉換。
 * API 寫入必須另外呼叫 assertValidV41Config，藉此拒絕缺欄位與未知欄位。
 */
export function normalizeV41Config(raw: unknown): NormalizedV41Config {
  const source = isRecord(raw) ? raw : {};
  const defaults = createV41DefaultConfig();
  const logic = source.entryConditionLogic === "or" ? "or" : "and";
  const threeKMode = source.threeKMode === "three_body_same_direction"
    ? "three_body_same_direction"
    : "breakout";

  return {
    strategyKey: V41_STRATEGY_KEY,
    configVersion: V41_CONFIG_VERSION,
    entryConditionLogic: logic,
    enableThreeKFilter: toBoolean(source.enableThreeKFilter, defaults.enableThreeKFilter),
    threeKMode,
    enableKamaFastSlowCross: toBoolean(source.enableKamaFastSlowCross, defaults.enableKamaFastSlowCross),
    enableKamaPriceVsSlow: toBoolean(source.enableKamaPriceVsSlow, defaults.enableKamaPriceVsSlow),
    enableSameDirectionReentry: toBoolean(source.enableSameDirectionReentry, defaults.enableSameDirectionReentry),
    Initial_Capital: toFiniteNumber(source.Initial_Capital, defaults.Initial_Capital),
    Base_Lot_Size: toFiniteNumber(source.Base_Lot_Size, defaults.Base_Lot_Size),
    First_Order_Pct: toFiniteNumber(source.First_Order_Pct, defaults.First_Order_Pct),
    Max_Loss_Pct: toFiniteNumber(source.Max_Loss_Pct, defaults.Max_Loss_Pct),
    KAMA_Fast_Length: toFiniteNumber(source.KAMA_Fast_Length, defaults.KAMA_Fast_Length),
    p2_fastest: toFiniteNumber(source.p2_fastest, defaults.p2_fastest),
    p3_slowest: toFiniteNumber(source.p3_slowest, defaults.p3_slowest),
    KAMA_Slow_Length: toFiniteNumber(source.KAMA_Slow_Length, defaults.KAMA_Slow_Length),
    q2_fastest: toFiniteNumber(source.q2_fastest, defaults.q2_fastest),
    q3_slowest: toFiniteNumber(source.q3_slowest, defaults.q3_slowest),
    Martin_Multiplier: toFiniteNumber(source.Martin_Multiplier, defaults.Martin_Multiplier),
    Max_Layers: toFiniteNumber(source.Max_Layers, defaults.Max_Layers),
    Martin_Step_Pct: toFiniteNumber(source.Martin_Step_Pct, defaults.Martin_Step_Pct),
    Martin_Layers: parseMartinLayers(source.Martin_Layers),
    Target_TP_Pct: toFiniteNumber(source.Target_TP_Pct, defaults.Target_TP_Pct),
    Callback_Pct: toFiniteNumber(source.Callback_Pct, defaults.Callback_Pct),
    K_Line_Period: toFiniteNumber(source.K_Line_Period, defaults.K_Line_Period),
    Kama_Reversal_Min_Layer: toFiniteNumber(source.Kama_Reversal_Min_Layer, defaults.Kama_Reversal_Min_Layer),
  };
}

export function validateV41Config(raw: unknown): V41ConfigValidationResult {
  const parsed = V41_CONFIG_SCHEMA.safeParse(raw);
  if (parsed.success) {
    return { valid: true, config: parsed.data, issues: [] };
  }
  return {
    valid: false,
    config: null,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "config",
      message: issue.message,
    })),
  };
}

export function assertValidV41Config(raw: unknown): NormalizedV41Config {
  const result = validateV41Config(raw);
  if (!result.valid || !result.config) {
    throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"));
  }
  return result.config;
}

export function countEnabledV41EntryConditions(
  config: Pick<NormalizedV41Config, "enableThreeKFilter" | "enableKamaFastSlowCross" | "enableKamaPriceVsSlow">,
): number {
  return Number(config.enableThreeKFilter)
    + Number(config.enableKamaFastSlowCross)
    + Number(config.enableKamaPriceVsSlow);
}

export function hasV41ContinuousDirectionCondition(
  config: Pick<NormalizedV41Config, "enableKamaFastSlowCross" | "enableKamaPriceVsSlow">,
): boolean {
  return config.enableKamaFastSlowCross || config.enableKamaPriceVsSlow;
}

export function convertV40ToV41Draft(raw: unknown): NormalizedV41Config {
  const source = isRecord(raw) ? raw : {};
  return normalizeV41Config({
    ...source,
    strategyKey: V41_STRATEGY_KEY,
    configVersion: V41_CONFIG_VERSION,
    entryConditionLogic: "and",
    enableThreeKFilter: toBoolean(source.enableThreeKFilter, false),
    threeKMode: firstDefined(source.threeKMode, source.threeKPatternMode),
    enableKamaFastSlowCross: false,
    enableKamaPriceVsSlow: toBoolean(source.enableKamaDirectionLock, false),
    enableSameDirectionReentry: toBoolean(source.enableSameDirectionReentry, false),
  });
}

function sortForStableSerialization(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableSerialization);
  if (!isRecord(value)) return value;
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const item = value[key];
      if (item !== undefined) result[key] = sortForStableSerialization(item);
      return result;
    }, {});
}

export function stableSerializeV41Config(config: NormalizedV41Config): string {
  return JSON.stringify(sortForStableSerialization(config));
}

/** 穩定身份雜湊；伺服器可信封印仍必須另外使用帶密鑰簽章。 */
export function getV41ConfigHash(config: NormalizedV41Config): string {
  const serialized = stableSerializeV41Config(config);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `v41-fnv1a32-${hash.toString(16).padStart(8, "0")}`;
}

export function summarizeV41EntryConfig(config: NormalizedV41Config): string {
  const enabled: string[] = [];
  if (config.enableThreeKFilter) enabled.push(`三 K（${config.threeKMode}）`);
  if (config.enableKamaFastSlowCross) enabled.push("KAMA 快慢線方向");
  if (config.enableKamaPriceVsSlow) enabled.push("Price／慢 KAMA 方向");
  return enabled.length === 0
    ? "0/3：尚未啟用方向條件"
    : `${enabled.length}/3 · ${config.entryConditionLogic.toUpperCase()} · ${enabled.join("、")}`;
}
