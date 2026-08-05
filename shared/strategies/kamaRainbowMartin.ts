export const KAMA_RAINBOW_MARTIN_STRATEGY_KEY = "KAMA_RAINBOW_MARTIN_V1" as const;
export const KAMA_RAINBOW_MARTIN_STRATEGY_NAME = "Kama彩虹馬丁策略" as const;
export const KAMA_RAINBOW_MARTIN_CONFIG_VERSION = "kamaRainbowMartin.v2" as const;
export const KAMA_RAINBOW_MARTIN_LEGACY_CONFIG_VERSION = "kamaRainbowMartin.v1" as const;
export const KAMA_RAINBOW_MARTIN_LOGIC_REVISION = "kama-rainbow-martin-v2-tiered" as const;
export const KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY = "__kamaRainbowMartinConfig" as const;
export const KAMA_RAINBOW_MARTIN_RUNTIME_NAMESPACE = "kamaRainbowMartin" as const;
export const KAMA_RAINBOW_MARTIN_MAX_ADD_LAYERS = 50 as const;

export const KAMA_RAINBOW_MARTIN_TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4", "D1", "W1"] as const;
export type KamaRainbowMartinTimeframe = (typeof KAMA_RAINBOW_MARTIN_TIMEFRAMES)[number];
export type KamaRainbowMartinBacktestEndPositionPolicy = "mark_to_market" | "force_close";

export const KAMA_RAINBOW_MARTIN_TIMEFRAME_MINUTES: Readonly<Record<KamaRainbowMartinTimeframe, number>> = Object.freeze({
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
  W1: 10080,
});

export interface KamaRainbowMartinLineConfig {
  /** Stable row identity. Renaming a line must never change this value. */
  id: string;
  name: string;
  enabled: boolean;
  erPeriod: number;
  fastEma: number;
  slowEma: number;
  color: string;
}

export interface KamaRainbowMartinTrailingConfig {
  enabled: boolean;
  activationPct: number;
  callbackPct: number;
  stepPct: number;
}

export interface KamaRainbowMartinLayerConfig {
  /** Add-layer range start (inclusive). L1 is the first add after the base fill. */
  layerStart: number;
  /** Add-layer range end (inclusive). */
  layerEnd: number;
  /** Per-layer multiplier; add-layer size compounds from the base size. */
  multiplier: number;
  /** Optional gap from the previous actual fill; blank uses the global gapPct. */
  gapPct?: number;
  /** Optional leg hard-stop override after this add layer has filled. */
  hardStopLossPct?: number;
  /** Optional trailing switch override; blank inherits the global switch. */
  trailingEnabled?: boolean;
  /** Optional trailing activation override; blank inherits the global value. */
  trailingActivationPct?: number;
  /** Optional trailing callback override; blank inherits the global value. */
  trailingCallbackPct?: number;
  /** Optional trailing staircase step override; blank inherits the global value. */
  trailingStepPct?: number;
}

export interface KamaRainbowMartinLayerProtection {
  hardStopLossPct: number;
  trailing: KamaRainbowMartinTrailingConfig;
}

export interface KamaRainbowMartinConfig {
  version: typeof KAMA_RAINBOW_MARTIN_CONFIG_VERSION;
  timeframe: KamaRainbowMartinTimeframe;
  /** Allow a new base entry after this strategy has fully closed its previous leg. */
  reentryEnabled: boolean;
  kamaLines: KamaRainbowMartinLineConfig[];
  /** Number of add layers, excluding the base fill; derived from layerConfigs in layered mode. */
  maxLayers: number;
  /** Fixed-mode fallback multiplier. */
  multiplier: number;
  /** Percentage points relative to the previous layer's actual fill. */
  gapPct: number;
  /** Tiered add-layer configuration; overrides multiplier and optionally gapPct when non-empty. */
  layerConfigs: KamaRainbowMartinLayerConfig[];
  /** Percentage points relative to the leg's weighted average cost. */
  hardStopLossPct: number;
  trailing: KamaRainbowMartinTrailingConfig;
  backtestEndPositionPolicy: KamaRainbowMartinBacktestEndPositionPolicy;
}

export interface KamaRainbowMartinValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface KamaRainbowMartinValidationResult {
  valid: boolean;
  config: KamaRainbowMartinConfig;
  issues: KamaRainbowMartinValidationIssue[];
  warnings: KamaRainbowMartinValidationIssue[];
}

const DEFAULT_LINES: readonly KamaRainbowMartinLineConfig[] = [
  {
    id: "KAMA_1",
    name: "KAMA 10",
    enabled: true,
    erPeriod: 10,
    fastEma: 2,
    slowEma: 30,
    color: "#00E5FF",
  },
  {
    id: "KAMA_2",
    name: "KAMA 20",
    enabled: true,
    erPeriod: 20,
    fastEma: 2,
    slowEma: 30,
    color: "#FFB000",
  },
];

export const KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG: Readonly<KamaRainbowMartinConfig> = {
  version: KAMA_RAINBOW_MARTIN_CONFIG_VERSION,
  timeframe: "M30",
  reentryEnabled: false,
  kamaLines: DEFAULT_LINES.map(line => ({ ...line })),
  maxLayers: 11,
  multiplier: 1.5,
  gapPct: 2,
  layerConfigs: [
    { layerStart: 1, layerEnd: 4, multiplier: 1.5 },
    { layerStart: 5, layerEnd: 9, multiplier: 1.1 },
    { layerStart: 10, layerEnd: 11, multiplier: 1 },
  ],
  hardStopLossPct: 5,
  trailing: {
    enabled: true,
    activationPct: 3,
    callbackPct: 1.5,
    stepPct: 0.5,
  },
  backtestEndPositionPolicy: "mark_to_market",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find(value => value !== undefined && value !== null);
}

function toNumber(value: unknown, fallback: number): number {
  if (value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "on", "yes", "enabled"].includes(normalized)) return true;
  if (["false", "0", "off", "no", "disabled"].includes(normalized)) return false;
  return fallback;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return toBoolean(value, false);
}

function toTimeframe(value: unknown, fallback: KamaRainbowMartinTimeframe): KamaRainbowMartinTimeframe {
  const normalized = String(value ?? "").trim().toUpperCase();
  return KAMA_RAINBOW_MARTIN_TIMEFRAMES.includes(normalized as KamaRainbowMartinTimeframe)
    ? normalized as KamaRainbowMartinTimeframe
    : fallback;
}

function toBacktestEndPositionPolicy(
  value: unknown,
  fallback: KamaRainbowMartinBacktestEndPositionPolicy,
): KamaRainbowMartinBacktestEndPositionPolicy {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["force_close", "force-close", "close", "liquidate"].includes(normalized)) return "force_close";
  if (["mark_to_market", "mark-to-market", "mtm", "keep_open"].includes(normalized)) return "mark_to_market";
  return fallback;
}

function cloneLines(lines: readonly KamaRainbowMartinLineConfig[]): KamaRainbowMartinLineConfig[] {
  return lines.map(line => ({ ...line }));
}

export function createKamaRainbowMartinDefaultConfig(): KamaRainbowMartinConfig {
  return {
    ...KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
    kamaLines: cloneLines(KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG.kamaLines),
    layerConfigs: KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG.layerConfigs.map(layer => ({ ...layer })),
    trailing: { ...KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG.trailing },
  };
}

function parseLines(value: unknown, defaults: readonly KamaRainbowMartinLineConfig[]): KamaRainbowMartinLineConfig[] {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return cloneLines(defaults);
    }
  }
  if (!Array.isArray(source)) return cloneLines(defaults);

  return source.map((item, index) => {
    const raw = isRecord(item) ? item : {};
    const fallback = defaults[index] ?? {
      id: `KAMA_${index + 1}`,
      name: `KAMA ${index + 1}`,
      enabled: true,
      erPeriod: 10 + index * 10,
      fastEma: 2,
      slowEma: 30,
      color: "#94A3B8",
    };
    return {
      id: String(firstDefined(raw.id, fallback.id)).trim(),
      name: String(firstDefined(raw.name, raw.label, fallback.name)).trim(),
      enabled: toBoolean(firstDefined(raw.enabled, raw.active), fallback.enabled),
      erPeriod: toNumber(firstDefined(raw.erPeriod, raw.length, raw.period), fallback.erPeriod),
      fastEma: toNumber(firstDefined(raw.fastEma, raw.fast, raw.fastest), fallback.fastEma),
      slowEma: toNumber(firstDefined(raw.slowEma, raw.slow, raw.slowest), fallback.slowEma),
      color: String(firstDefined(raw.color, fallback.color)).trim(),
    };
  });
}

interface ParsedKamaRainbowMartinLayers {
  layers: KamaRainbowMartinLayerConfig[];
  error?: string;
}

function parseLayerConfigs(value: unknown): ParsedKamaRainbowMartinLayers {
  let source = value;
  if (source === undefined || source === null || source === "") return { layers: [] };
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return { layers: [], error: "分層表不是合法 JSON" };
    }
  }
  if (!Array.isArray(source)) return { layers: [], error: "分層表必須是陣列" };

  return {
    layers: source.map(item => {
      const raw = isRecord(item) ? item : {};
      const rawTrailing = isRecord(raw.trailing) ? raw.trailing : {};
      const rawGap = firstDefined(raw.gapPct, raw.stepPct, raw.gap, raw.spacingPct);
      const hardStopLossPct = toOptionalNumber(firstDefined(raw.hardStopLossPct, raw.hardStopPct));
      const trailingEnabled = toOptionalBoolean(firstDefined(raw.trailingEnabled, rawTrailing.enabled));
      const trailingActivationPct = toOptionalNumber(firstDefined(raw.trailingActivationPct, rawTrailing.activationPct));
      const trailingCallbackPct = toOptionalNumber(firstDefined(raw.trailingCallbackPct, rawTrailing.callbackPct));
      const trailingStepPct = toOptionalNumber(firstDefined(raw.trailingStepPct, rawTrailing.stepPct));
      return {
        layerStart: toNumber(firstDefined(raw.layerStart, raw.start), Number.NaN),
        layerEnd: toNumber(firstDefined(raw.layerEnd, raw.end), Number.NaN),
        multiplier: toNumber(firstDefined(raw.multiplier, raw.martinMultiplier), Number.NaN),
        ...(rawGap === undefined || rawGap === null || rawGap === ""
          ? {}
          : { gapPct: toNumber(rawGap, Number.NaN) }),
        ...(hardStopLossPct === undefined ? {} : { hardStopLossPct }),
        ...(trailingEnabled === undefined ? {} : { trailingEnabled }),
        ...(trailingActivationPct === undefined ? {} : { trailingActivationPct }),
        ...(trailingCallbackPct === undefined ? {} : { trailingCallbackPct }),
        ...(trailingStepPct === undefined ? {} : { trailingStepPct }),
      };
    }),
  };
}

export function normalizeKamaRainbowMartinConfig(raw: unknown): KamaRainbowMartinConfig {
  const input = isRecord(raw) ? raw : {};
  const defaults = createKamaRainbowMartinDefaultConfig();
  const trailingInput = isRecord(input.trailing) ? input.trailing : {};
  const suppliedVersion = String(firstDefined(input.version, input.Config_Version, "")).trim();
  const rawLayerConfigs = firstDefined(input.layerConfigs, input.Martin_Layers);
  const legacyFixedShape = suppliedVersion === KAMA_RAINBOW_MARTIN_LEGACY_CONFIG_VERSION || (
    !suppliedVersion
    && ["maxLayers", "Max_Layers", "multiplier", "martinMultiplier", "gapPct", "martinGapPct"]
      .some(key => Object.prototype.hasOwnProperty.call(input, key))
  );
  const layerConfigs = rawLayerConfigs === undefined
    ? legacyFixedShape
      ? []
      : defaults.layerConfigs.map(layer => ({ ...layer }))
    : parseLayerConfigs(rawLayerConfigs).layers;
  const rawMaxLayers = firstDefined(input.maxLayers, input.Max_Layers);
  const suppliedMaxLayers = toNumber(rawMaxLayers, defaults.maxLayers);
  const shouldMigrateLegacyInclusiveCount = legacyFixedShape && layerConfigs.length === 0;
  const maxLayers = layerConfigs.length > 0
    ? Math.max(...layerConfigs.map(layer => layer.layerEnd).filter(Number.isFinite), 0)
    : shouldMigrateLegacyInclusiveCount
      ? Math.max(0, suppliedMaxLayers - 1)
      : suppliedMaxLayers;

  return {
    version: KAMA_RAINBOW_MARTIN_CONFIG_VERSION,
    timeframe: toTimeframe(firstDefined(input.timeframe, input.entryTimeframe), defaults.timeframe),
    reentryEnabled: toBoolean(
      firstDefined(input.reentryEnabled, input.autoReentryEnabled, input.autoReentry, input.Reentry_Enabled),
      defaults.reentryEnabled,
    ),
    kamaLines: parseLines(firstDefined(input.kamaLines, input.lines), defaults.kamaLines),
    maxLayers,
    multiplier: toNumber(firstDefined(input.multiplier, input.martinMultiplier), defaults.multiplier),
    gapPct: toNumber(firstDefined(input.gapPct, input.martinGapPct), defaults.gapPct),
    layerConfigs,
    hardStopLossPct: toNumber(firstDefined(input.hardStopLossPct, input.hardStopPct), defaults.hardStopLossPct),
    trailing: {
      enabled: toBoolean(firstDefined(trailingInput.enabled, input.trailingEnabled), defaults.trailing.enabled),
      activationPct: toNumber(
        firstDefined(trailingInput.activationPct, input.trailingActivationPct),
        defaults.trailing.activationPct,
      ),
      callbackPct: toNumber(
        firstDefined(trailingInput.callbackPct, input.trailingCallbackPct),
        defaults.trailing.callbackPct,
      ),
      stepPct: toNumber(firstDefined(trailingInput.stepPct, input.trailingStepPct), defaults.trailing.stepPct),
    },
    backtestEndPositionPolicy: toBacktestEndPositionPolicy(
      firstDefined(input.backtestEndPositionPolicy, input.Backtest_End_Position_Policy),
      defaults.backtestEndPositionPolicy,
    ),
  };
}

function addIssue(
  target: KamaRainbowMartinValidationIssue[],
  path: string,
  code: string,
  message: string,
): void {
  target.push({ path, code, message });
}

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function validateKamaRainbowMartinConfig(raw: unknown): KamaRainbowMartinValidationResult {
  const input = isRecord(raw) ? raw : {};
  const config = normalizeKamaRainbowMartinConfig(raw);
  const issues: KamaRainbowMartinValidationIssue[] = [];
  const warnings: KamaRainbowMartinValidationIssue[] = [];

  const suppliedVersion = firstDefined(input.version, input.Config_Version);
  if (
    suppliedVersion !== undefined
    && suppliedVersion !== KAMA_RAINBOW_MARTIN_CONFIG_VERSION
    && suppliedVersion !== KAMA_RAINBOW_MARTIN_LEGACY_CONFIG_VERSION
  ) {
    addIssue(issues, "version", "KRM_UNSUPPORTED_CONFIG_VERSION", `只接受 ${KAMA_RAINBOW_MARTIN_CONFIG_VERSION} 或可遷移的 ${KAMA_RAINBOW_MARTIN_LEGACY_CONFIG_VERSION}`);
  } else if (suppliedVersion === KAMA_RAINBOW_MARTIN_LEGACY_CONFIG_VERSION) {
    addIssue(warnings, "version", "KRM_LEGACY_CONFIG_MIGRATED", "舊 V1 快照已轉換：原 maxLayers（含底倉）會換算為 V2 加倉層數");
  }

  const suppliedTimeframe = firstDefined(input.timeframe, input.entryTimeframe);
  if (
    suppliedTimeframe !== undefined
    && !KAMA_RAINBOW_MARTIN_TIMEFRAMES.includes(String(suppliedTimeframe).trim().toUpperCase() as KamaRainbowMartinTimeframe)
  ) {
    addIssue(issues, "timeframe", "KRM_UNSUPPORTED_TIMEFRAME", "週期只允許 M5/M15/M30/H1/H4/D1/W1");
  }

  if (config.kamaLines.length < 2 || config.kamaLines.length > 32) {
    addIssue(issues, "kamaLines", "KRM_LINE_COUNT_INVALID", "KAMA 清單總數必須介乎 2 至 32 條");
  }

  const enabledCount = config.kamaLines.filter(line => line.enabled).length;
  if (enabledCount < 2) {
    addIssue(issues, "kamaLines", "KRM_ENABLED_LINE_COUNT_INVALID", "至少需要兩條啟用中的 KAMA 線");
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  config.kamaLines.forEach((line, index) => {
    const path = `kamaLines.${index}`;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(line.id)) {
      addIssue(issues, `${path}.id`, "KRM_LINE_ID_INVALID", "id 必須為 1–64 位英數字、底線或連字號");
    } else if (ids.has(line.id)) {
      addIssue(issues, `${path}.id`, "KRM_LINE_ID_DUPLICATE", "KAMA id 不可重複");
    }
    ids.add(line.id);

    const normalizedName = line.name.toLocaleLowerCase();
    if (line.name.length < 1 || line.name.length > 40) {
      addIssue(issues, `${path}.name`, "KRM_LINE_NAME_INVALID", "名稱長度必須介乎 1 至 40 字");
    } else if (names.has(normalizedName)) {
      addIssue(issues, `${path}.name`, "KRM_LINE_NAME_DUPLICATE", "KAMA 顯示名稱不可重複");
    }
    names.add(normalizedName);

    if (!isIntegerInRange(line.erPeriod, 2, 500)) {
      addIssue(issues, `${path}.erPeriod`, "KRM_ER_PERIOD_INVALID", "ER 週期必須為 2 至 500 的整數");
    }
    if (!isIntegerInRange(line.fastEma, 1, 500)) {
      addIssue(issues, `${path}.fastEma`, "KRM_FAST_EMA_INVALID", "快速 EMA 必須為 1 至 500 的整數");
    }
    if (!isIntegerInRange(line.slowEma, 1, 500)) {
      addIssue(issues, `${path}.slowEma`, "KRM_SLOW_EMA_INVALID", "慢速 EMA 必須為 1 至 500 的整數");
    }
    if (line.fastEma > line.slowEma) {
      addIssue(issues, `${path}.fastEma`, "KRM_FAST_GREATER_THAN_SLOW", "快速 EMA 不可大於慢速 EMA");
    } else if (line.fastEma === line.slowEma) {
      addIssue(warnings, `${path}.fastEma`, "KRM_DEGENERATE_FIXED_EMA", "快速與慢速 EMA 相等，KAMA 會退化為固定 EMA");
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(line.color)) {
      addIssue(issues, `${path}.color`, "KRM_COLOR_INVALID", "顏色必須使用 #RRGGBB 格式");
    }
  });

  if (!isIntegerInRange(config.maxLayers, 0, KAMA_RAINBOW_MARTIN_MAX_ADD_LAYERS)) {
    addIssue(issues, "maxLayers", "KRM_MAX_LAYERS_INVALID", `最大加倉層數必須為 0 至 ${KAMA_RAINBOW_MARTIN_MAX_ADD_LAYERS} 的整數，不包含底倉`);
  }
  if (!Number.isFinite(config.multiplier) || config.multiplier < 1 || config.multiplier > 10) {
    addIssue(issues, "multiplier", "KRM_MULTIPLIER_INVALID", "倍數必須介乎 1 至 10");
  }
  if (!Number.isFinite(config.gapPct) || config.gapPct <= 0 || config.gapPct > 100) {
    addIssue(issues, "gapPct", "KRM_GAP_INVALID", "加倉間距必須大於 0 且不超過 100 個百分點");
  }
  const parsedLayerConfigs = parseLayerConfigs(firstDefined(input.layerConfigs, input.Martin_Layers));
  if (parsedLayerConfigs.error) {
    addIssue(issues, "layerConfigs", "KRM_LAYER_FORMAT_INVALID", parsedLayerConfigs.error);
  }
  if (config.layerConfigs.length === 0) {
    addIssue(warnings, "layerConfigs", "KRM_FIXED_MODE_FALLBACK", "未設定分層表，將使用固定乘數與全域加倉間距");
  } else {
    const sortedLayers = [...config.layerConfigs].sort((a, b) => a.layerStart - b.layerStart);
    sortedLayers.forEach((layer, index) => {
      const path = `layerConfigs.${index}`;
      if (!isIntegerInRange(layer.layerStart, 1, KAMA_RAINBOW_MARTIN_MAX_ADD_LAYERS)) {
        addIssue(issues, `${path}.layerStart`, "KRM_LAYER_START_INVALID", `起始層必須為 1 至 ${KAMA_RAINBOW_MARTIN_MAX_ADD_LAYERS} 的整數`);
      }
      if (!isIntegerInRange(layer.layerEnd, 1, KAMA_RAINBOW_MARTIN_MAX_ADD_LAYERS)) {
        addIssue(issues, `${path}.layerEnd`, "KRM_LAYER_END_INVALID", `結束層必須為 1 至 ${KAMA_RAINBOW_MARTIN_MAX_ADD_LAYERS} 的整數`);
      }
      if (layer.layerStart > layer.layerEnd) {
        addIssue(issues, `${path}.layerStart`, "KRM_LAYER_RANGE_REVERSED", "起始層不可大於結束層");
      }
      if (!Number.isFinite(layer.multiplier) || layer.multiplier < 1 || layer.multiplier > 10) {
        addIssue(issues, `${path}.multiplier`, "KRM_LAYER_MULTIPLIER_INVALID", "分層乘數必須介乎 1 至 10");
      }
      if (layer.gapPct !== undefined && (!Number.isFinite(layer.gapPct) || layer.gapPct <= 0 || layer.gapPct > 100)) {
        addIssue(issues, `${path}.gapPct`, "KRM_LAYER_GAP_INVALID", "分層間距留空時使用全域值；填寫時必須大於 0 且不超過 100");
      }
      if (layer.hardStopLossPct !== undefined && (!Number.isFinite(layer.hardStopLossPct) || layer.hardStopLossPct <= 0 || layer.hardStopLossPct > 100)) {
        addIssue(issues, `${path}.hardStopLossPct`, "KRM_LAYER_HARD_STOP_INVALID", "分層硬止損留空時使用全域值；填寫時必須大於 0 且不超過 100");
      }
      for (const [field, value, code, label] of [
        ["trailingActivationPct", layer.trailingActivationPct, "KRM_LAYER_TRAILING_ACTIVATION_INVALID", "Trailing 啟動"],
        ["trailingCallbackPct", layer.trailingCallbackPct, "KRM_LAYER_TRAILING_CALLBACK_INVALID", "Trailing 回調"],
        ["trailingStepPct", layer.trailingStepPct, "KRM_LAYER_TRAILING_STEP_INVALID", "Trailing 步長"],
      ] as const) {
        if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 100)) {
          addIssue(issues, `${path}.${field}`, code, `分層 ${label} 留空時使用全域值；填寫時必須大於 0 且不超過 100`);
        }
      }
      const effectiveActivation = layer.trailingActivationPct ?? config.trailing.activationPct;
      const effectiveCallback = layer.trailingCallbackPct ?? config.trailing.callbackPct;
      if (Number.isFinite(effectiveActivation) && Number.isFinite(effectiveCallback) && effectiveCallback >= effectiveActivation) {
        addIssue(issues, `${path}.trailingCallbackPct`, "KRM_LAYER_TRAILING_CALLBACK_TOO_LARGE", "分層 Trailing 回調必須小於該層生效的啟動值");
      }
      const previous = sortedLayers[index - 1];
      if (index === 0 && layer.layerStart !== 1) {
        addIssue(issues, `${path}.layerStart`, "KRM_LAYER_MUST_START_AT_ONE", "第一個分層必須由 L1 開始");
      } else if (previous && layer.layerStart <= previous.layerEnd) {
        addIssue(issues, `${path}.layerStart`, "KRM_LAYER_OVERLAP", `層級範圍與 L${previous.layerStart}–L${previous.layerEnd} 重疊`);
      } else if (previous && layer.layerStart !== previous.layerEnd + 1) {
        addIssue(issues, `${path}.layerStart`, "KRM_LAYER_GAP", `層級範圍必須連續；上一段結束於 L${previous.layerEnd}`);
      }
    });
  }
  if (!Number.isFinite(config.hardStopLossPct) || config.hardStopLossPct <= 0 || config.hardStopLossPct > 100) {
    addIssue(issues, "hardStopLossPct", "KRM_HARD_STOP_INVALID", "硬止損必須大於 0 且不超過 100 個百分點");
  }
  if (!Number.isFinite(config.trailing.activationPct) || config.trailing.activationPct <= 0) {
    addIssue(issues, "trailing.activationPct", "KRM_TRAILING_ACTIVATION_INVALID", "移動止盈啟動值必須大於 0");
  }
  if (!Number.isFinite(config.trailing.callbackPct) || config.trailing.callbackPct <= 0) {
    addIssue(issues, "trailing.callbackPct", "KRM_TRAILING_CALLBACK_INVALID", "回調值必須大於 0");
  }
  if (!Number.isFinite(config.trailing.stepPct) || config.trailing.stepPct <= 0) {
    addIssue(issues, "trailing.stepPct", "KRM_TRAILING_STEP_INVALID", "階梯步長必須大於 0");
  }
  if (config.trailing.callbackPct >= config.trailing.activationPct) {
    addIssue(issues, "trailing.callbackPct", "KRM_TRAILING_CALLBACK_TOO_LARGE", "回調值必須小於啟動值");
  }

  return { valid: issues.length === 0, config, issues, warnings };
}

/**
 * Persisted／execution 邊界的嚴格契約。
 * Draft 表單仍可使用 normalizeKamaRainbowMartinConfig(undefined) 建立兩線起始值；
 * 但任何保存、回測或實盤執行都必須明確提供版本與 KAMA 陣列，禁止 implicit default。
 */
export function validateExplicitKamaRainbowMartinConfig(raw: unknown): KamaRainbowMartinValidationResult {
  const result = validateKamaRainbowMartinConfig(raw);
  const issues = [...result.issues];

  if (!isRecord(raw)) {
    addIssue(
      issues,
      "config",
      "KRM_CONFIG_MISSING",
      "Kama 彩虹馬丁執行配置缺失；只允許在未保存草稿中使用預設範本",
    );
  } else {
    const suppliedVersion = firstDefined(raw.version, raw.Config_Version);
    if (suppliedVersion === undefined || String(suppliedVersion).trim() === "") {
      addIssue(
        issues,
        "version",
        "KRM_CONFIG_MISSING",
        "執行配置必須明確包含 version",
      );
    }

    const suppliedLines = firstDefined(raw.kamaLines, raw.lines);
    if (!Array.isArray(suppliedLines)) {
      addIssue(
        issues,
        "kamaLines",
        "KRM_CONFIG_MISSING",
        "執行配置必須明確包含 kamaLines 陣列",
      );
    }
  }

  return {
    ...result,
    valid: issues.length === 0,
    issues,
  };
}

export function assertValidKamaRainbowMartinConfig(raw: unknown): KamaRainbowMartinConfig {
  const result = validateKamaRainbowMartinConfig(raw);
  if (!result.valid) {
    throw new Error(result.issues.map(issue => `${issue.path}: ${issue.message}`).join("；"));
  }
  return result.config;
}

export function assertExplicitKamaRainbowMartinConfig(raw: unknown): KamaRainbowMartinConfig {
  const result = validateExplicitKamaRainbowMartinConfig(raw);
  if (!result.valid) {
    throw new Error(
      result.issues
        .map(issue => `[${issue.code}] ${issue.path}: ${issue.message}`)
        .join("；"),
    );
  }
  return result.config;
}

export const KAMA_RAINBOW_MARTIN_LINE_SET_RECEIPT_VERSION = "krm-line-set-receipt.v1" as const;
export const KAMA_RAINBOW_MARTIN_ENTRY_SEMANTICS = "ALL_ENABLED_SAME_SLOPE_WITH_PAIR_LOCK" as const;

export type KamaRainbowMartinLineSetSource =
  | "draft"
  | "backtest-input"
  | "backtest-result"
  | "snapshot"
  | "snapshot-apply"
  | "strategy-binding"
  | "live-binding"
  | "unknown";

export interface KamaRainbowMartinLineSetReceipt {
  schemaVersion: typeof KAMA_RAINBOW_MARTIN_LINE_SET_RECEIPT_VERSION;
  source: KamaRainbowMartinLineSetSource;
  inputVersion: string;
  configVersion: typeof KAMA_RAINBOW_MARTIN_CONFIG_VERSION;
  migrated: boolean;
  totalLineCount: number;
  enabledLineCount: number;
  enabledLineIds: string[];
  entrySemantics: typeof KAMA_RAINBOW_MARTIN_ENTRY_SEMANTICS;
  lineSetHash: string;
  configHash: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
}

function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createKamaRainbowMartinLineSetReceipt(
  raw: unknown,
  source: KamaRainbowMartinLineSetSource = "unknown",
): KamaRainbowMartinLineSetReceipt {
  const config = assertExplicitKamaRainbowMartinConfig(raw);
  const rawRecord = isRecord(raw) ? raw : {};
  const inputVersion = String(firstDefined(rawRecord.version, rawRecord.Config_Version, "unknown"));
  const enabledLineIds = config.kamaLines
    .filter(line => line.enabled)
    .map(line => line.id);
  const canonicalLineSet = config.kamaLines.map(line => ({
    id: line.id,
    name: line.name,
    enabled: line.enabled,
    erPeriod: line.erPeriod,
    fastEma: line.fastEma,
    slowEma: line.slowEma,
    color: line.color,
  }));

  return {
    schemaVersion: KAMA_RAINBOW_MARTIN_LINE_SET_RECEIPT_VERSION,
    source,
    inputVersion,
    configVersion: config.version,
    migrated: inputVersion !== config.version,
    totalLineCount: config.kamaLines.length,
    enabledLineCount: enabledLineIds.length,
    enabledLineIds,
    entrySemantics: KAMA_RAINBOW_MARTIN_ENTRY_SEMANTICS,
    lineSetHash: `krm-lines-${fnv1a32Hex(stableJson(canonicalLineSet))}`,
    configHash: `krm-config-${fnv1a32Hex(stableJson(config))}`,
  };
}

export function getKamaRainbowMartinTimeframeMinutes(timeframe: KamaRainbowMartinTimeframe): number {
  return KAMA_RAINBOW_MARTIN_TIMEFRAME_MINUTES[timeframe];
}

export function getKamaRainbowMartinMinimumHistoryBars(config: KamaRainbowMartinConfig): number {
  const enabled = config.kamaLines.filter(line => line.enabled);
  const maxErPeriod = Math.max(...enabled.map(line => line.erPeriod));
  return maxErPeriod + 1;
}

export function buildKamaRainbowMartinLayerQuantities(
  initialQuantity: number,
  maxLayers: number,
  multiplier: number,
): number[] {
  if (!Number.isFinite(initialQuantity) || initialQuantity <= 0) return [];
  if (!Number.isInteger(maxLayers) || maxLayers < 1 || maxLayers > 20) return [];
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) return [];
  return Array.from({ length: maxLayers }, (_, index) => initialQuantity * multiplier ** index);
}

/**
 * Get the multiplier for a specific layer based on layer configs.
 * If no layer configs are provided or the layer is not covered, returns the default multiplier.
 */
export function getLayerMultiplier(
  layer: number,
  layerConfigs: readonly KamaRainbowMartinLayerConfig[] | undefined,
  defaultMultiplier: number,
): number {
  if (!layerConfigs || layerConfigs.length === 0) return defaultMultiplier;
  const config = layerConfigs.find(cfg => layer >= cfg.layerStart && layer <= cfg.layerEnd);
  return config ? config.multiplier : defaultMultiplier;
}

/**
 * Get the gap percentage for a specific layer based on layer configs.
 * If no layer configs are provided or the layer is not covered, returns the default gap.
 */
export function getLayerGapPct(
  layer: number,
  layerConfigs: readonly KamaRainbowMartinLayerConfig[] | undefined,
  defaultGapPct: number,
): number {
  if (!layerConfigs || layerConfigs.length === 0) return defaultGapPct;
  const config = layerConfigs.find(cfg => layer >= cfg.layerStart && layer <= cfg.layerEnd);
  return config?.gapPct ?? defaultGapPct;
}

export function getKamaRainbowMartinLayerProtection(
  addLayer: number,
  layerConfigs: readonly KamaRainbowMartinLayerConfig[] | undefined,
  defaultHardStopLossPct: number,
  defaultTrailing: KamaRainbowMartinTrailingConfig,
): KamaRainbowMartinLayerProtection {
  const layer = addLayer > 0
    ? layerConfigs?.find(config => addLayer >= config.layerStart && addLayer <= config.layerEnd)
    : undefined;
  return {
    hardStopLossPct: layer?.hardStopLossPct ?? defaultHardStopLossPct,
    trailing: {
      enabled: layer?.trailingEnabled ?? defaultTrailing.enabled,
      activationPct: layer?.trailingActivationPct ?? defaultTrailing.activationPct,
      callbackPct: layer?.trailingCallbackPct ?? defaultTrailing.callbackPct,
      stepPct: layer?.trailingStepPct ?? defaultTrailing.stepPct,
    },
  };
}

export function getKamaRainbowMartinCumulativeMultiplier(
  addLayer: number,
  layerConfigs: readonly KamaRainbowMartinLayerConfig[],
  defaultMultiplier: number,
): number {
  if (!Number.isInteger(addLayer) || addLayer < 1) return 1;
  let cumulative = 1;
  for (let layer = 1; layer <= addLayer; layer += 1) {
    cumulative *= getLayerMultiplier(layer, layerConfigs, defaultMultiplier);
  }
  return cumulative;
}

export function buildKamaRainbowMartinAddLayerQuantities(
  initialQuantity: number,
  maxAddLayers: number,
  layerConfigs: readonly KamaRainbowMartinLayerConfig[],
  defaultMultiplier: number,
): number[] {
  if (!Number.isFinite(initialQuantity) || initialQuantity <= 0) return [];
  if (!Number.isInteger(maxAddLayers) || maxAddLayers < 0 || maxAddLayers > KAMA_RAINBOW_MARTIN_MAX_ADD_LAYERS) return [];
  return Array.from(
    { length: maxAddLayers },
    (_, index) => initialQuantity * getKamaRainbowMartinCumulativeMultiplier(index + 1, layerConfigs, defaultMultiplier),
  );
}

/**
 * Build layer quantities using tiered martin configuration.
 */
export function buildTieredLayerQuantities(
  initialQuantity: number,
  maxLayers: number,
  layerConfigs: readonly KamaRainbowMartinLayerConfig[] | undefined,
  defaultMultiplier: number,
): number[] {
  if (!Number.isFinite(initialQuantity) || initialQuantity <= 0) return [];
  if (!Number.isInteger(maxLayers) || maxLayers < 0 || maxLayers > KAMA_RAINBOW_MARTIN_MAX_ADD_LAYERS) return [];
  return [initialQuantity, ...buildKamaRainbowMartinAddLayerQuantities(
    initialQuantity,
    maxLayers,
    layerConfigs ?? [],
    defaultMultiplier,
  )];
}
