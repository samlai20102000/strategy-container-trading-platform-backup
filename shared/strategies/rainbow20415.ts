export const RAINBOW_20415_STRATEGY_KEY = "strategy_20415" as const;
export const RAINBOW_20415_STRATEGY_NAME = "20415七彩虹馬丁策略" as const;
export const RAINBOW_20415_CONFIG_VERSION = "rainbow20415.v1" as const;
export const RAINBOW_20415_LINE_IDS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"] as const;

export type Rainbow20415LineId = (typeof RAINBOW_20415_LINE_IDS)[number];
export type Rainbow20415MaType = "EMA" | "SMA" | "WMA";
export type Rainbow20415PositionMode = "quantity" | "usdt";

export interface Rainbow20415LineConfig {
  id: Rainbow20415LineId;
  label: string;
  type: Rainbow20415MaType;
  period: number;
  source: "close";
  color: string;
}

export interface Rainbow20415BaseLot {
  value: number;
  mode: Rainbow20415PositionMode;
}

export interface Rainbow20415MartinRange {
  id: string;
  startLayer: number;
  endLayer: number;
  multiplier: number;
  useGlobalSpacing: boolean;
  spacingPct: number;
  enabled: boolean;
}

export interface Rainbow20415Config {
  Config_Version: typeof RAINBOW_20415_CONFIG_VERSION;
  Entry_Timeframe_Minutes: number;
  Management_Interval_Minutes: number;
  Lines: Rainbow20415LineConfig[];
  Base_Lot_Size: Rainbow20415BaseLot;
  Initial_Capital: number;
  Take_Profit_Pct: number;
  Global_Spacing_Pct: number;
  Max_Hold_Hours: number;
  Max_Margin_Usage_Pct: number;
  Max_Account_Loss_Pct: number;
  Martingale_Enabled: boolean;
  Martin_Ranges: Rainbow20415MartinRange[];
  Reentry_Enabled: boolean;
  Reentry_Cooldown_Minutes: number;
}

export interface Rainbow20415ValidationIssue {
  path: string;
  message: string;
}

export interface Rainbow20415ValidationResult {
  valid: boolean;
  config: Rainbow20415Config;
  issues: Rainbow20415ValidationIssue[];
}

export type Rainbow20415ConfigSource = "default" | "rainbow" | "document" | "legacy-ema";

export interface Rainbow20415MigrationResult {
  config: Rainbow20415Config;
  source: Rainbow20415ConfigSource;
  migrated: boolean;
  ignoredLegacyKeys: string[];
}

const DEFAULT_LINES: Rainbow20415LineConfig[] = [
  { id: "L1", label: "赤紅先鋒", type: "EMA", period: 5, source: "close", color: "#ff453a" },
  { id: "L2", label: "橙焰快線", type: "EMA", period: 8, source: "close", color: "#ff9f0a" },
  { id: "L3", label: "金黃節奏", type: "EMA", period: 13, source: "close", color: "#ffd60a" },
  { id: "L4", label: "翠綠中樞", type: "EMA", period: 21, source: "close", color: "#30d158" },
  { id: "L5", label: "青藍防線", type: "EMA", period: 34, source: "close", color: "#64d2ff" },
  { id: "L6", label: "靛藍慢線", type: "EMA", period: 55, source: "close", color: "#0a84ff" },
  { id: "L7", label: "紫曜長線", type: "EMA", period: 89, source: "close", color: "#bf5af2" },
];

const DEFAULT_RANGES: Rainbow20415MartinRange[] = [
  { id: "range-1-4", startLayer: 1, endLayer: 4, multiplier: 1.5, useGlobalSpacing: true, spacingPct: 1.5, enabled: true },
  { id: "range-5-9", startLayer: 5, endLayer: 9, multiplier: 1.1, useGlobalSpacing: true, spacingPct: 1.5, enabled: true },
  { id: "range-10-11", startLayer: 10, endLayer: 11, multiplier: 1, useGlobalSpacing: true, spacingPct: 1.5, enabled: true },
];

export const RAINBOW_20415_DEFAULT_CONFIG: Readonly<Rainbow20415Config> = {
  Config_Version: RAINBOW_20415_CONFIG_VERSION,
  Entry_Timeframe_Minutes: 30,
  Management_Interval_Minutes: 1,
  Lines: DEFAULT_LINES,
  Base_Lot_Size: { value: 0.01, mode: "quantity" },
  Initial_Capital: 10_000,
  Take_Profit_Pct: 0.2,
  Global_Spacing_Pct: 1.5,
  Max_Hold_Hours: 48,
  Max_Margin_Usage_Pct: 70,
  Max_Account_Loss_Pct: 5,
  Martingale_Enabled: true,
  Martin_Ranges: DEFAULT_RANGES,
  Reentry_Enabled: true,
  Reentry_Cooldown_Minutes: 0,
};

const LEGACY_EMA_KEYS = [
  "ema_killer", "ema_wave", "ema_enter", "buffer_points", "Point_Value", "multiplier", "max_layers",
  "pip_step_base", "enable_dynamic_pip", "atr_period", "pipstep_atr_multiplier", "pipstep_min", "pipstep_max",
  "tp_normal", "tp_trend", "trail_normal", "trail_trend", "trend_threshold", "slope_threshold",
  "hard_stop_max", "hard_stop_atr_multiplier",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
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
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "off", "no", "disabled"].includes(normalized)) return false;
    if (["true", "1", "on", "yes", "enabled"].includes(normalized)) return true;
  }
  return fallback;
}

function toPositionMode(value: unknown, fallback: Rainbow20415PositionMode): Rainbow20415PositionMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["usdt", "quote", "notional"].includes(normalized)) return "usdt";
  if (["quantity", "qty", "base", "lot", "lots"].includes(normalized)) return "quantity";
  return fallback;
}

function parseTimeframeMinutes(value: unknown, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toUpperCase();
  const direct = Number(normalized);
  if (Number.isFinite(direct)) return direct;
  const match = normalized.match(/^(M|H|D)(\d+)$/);
  if (!match) return fallback;
  const amount = Number(match[2]);
  return match[1] === "D" ? amount * 1440 : match[1] === "H" ? amount * 60 : amount;
}

function cloneLines(lines: readonly Rainbow20415LineConfig[]): Rainbow20415LineConfig[] {
  return lines.map((line) => ({ ...line }));
}

function cloneRanges(ranges: readonly Rainbow20415MartinRange[]): Rainbow20415MartinRange[] {
  return ranges.map((range) => ({ ...range }));
}

export function createRainbow20415DefaultConfig(): Rainbow20415Config {
  return {
    ...RAINBOW_20415_DEFAULT_CONFIG,
    Lines: cloneLines(RAINBOW_20415_DEFAULT_CONFIG.Lines),
    Base_Lot_Size: { ...RAINBOW_20415_DEFAULT_CONFIG.Base_Lot_Size },
    Martin_Ranges: cloneRanges(RAINBOW_20415_DEFAULT_CONFIG.Martin_Ranges),
  };
}

export function isLegacyEma20415Config(raw: unknown): boolean {
  return isRecord(raw) && LEGACY_EMA_KEYS.some((key) => raw[key] !== undefined);
}

function parseBaseLot(input: Record<string, unknown>, fallback: Rainbow20415BaseLot): Rainbow20415BaseLot {
  const raw = firstDefined(input.Base_Lot_Size, input.BASE_LOT, input.baseLot, input.base_lot_size);
  if (isRecord(raw)) {
    return {
      value: toNumber(firstDefined(raw.value, raw.amount, raw.quantity), fallback.value),
      mode: toPositionMode(firstDefined(raw.mode, raw.unit), fallback.mode),
    };
  }
  return {
    value: toNumber(firstDefined(raw, input.Position_Value, input.positionValue), fallback.value),
    mode: toPositionMode(firstDefined(input.Position_Mode, input.POSITION_MODE, input.positionMode), fallback.mode),
  };
}

function parseLines(value: unknown, defaults: readonly Rainbow20415LineConfig[]): Rainbow20415LineConfig[] {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { return cloneLines(defaults); }
  }
  if (!Array.isArray(source)) return cloneLines(defaults);
  return source.map((item, index) => {
    const raw = isRecord(item) ? item : {};
    const fallback = defaults[index] ?? defaults[defaults.length - 1];
    const idCandidate = String(firstDefined(raw.id, raw.key, raw.line, RAINBOW_20415_LINE_IDS[index] ?? "L7"));
    const id = RAINBOW_20415_LINE_IDS.includes(idCandidate as Rainbow20415LineId)
      ? idCandidate as Rainbow20415LineId
      : RAINBOW_20415_LINE_IDS[index] ?? "L7";
    const typeCandidate = String(firstDefined(raw.type, raw.maType, raw.method, fallback.type)).toUpperCase();
    const type: Rainbow20415MaType = typeCandidate === "SMA" || typeCandidate === "WMA" ? typeCandidate : "EMA";
    return {
      id,
      label: String(firstDefined(raw.label, raw.name, fallback.label)),
      type,
      period: toNumber(firstDefined(raw.period, raw.length), fallback.period),
      source: "close",
      color: String(firstDefined(raw.color, fallback.color)),
    };
  });
}

function parseRanges(
  value: unknown,
  defaults: readonly Rainbow20415MartinRange[],
  globalSpacingPct: number,
): Rainbow20415MartinRange[] {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { return cloneRanges(defaults); }
  }
  if (!Array.isArray(source)) return cloneRanges(defaults);
  return source.map((item, index) => {
    const tuple = Array.isArray(item) ? item : null;
    const raw = isRecord(item) ? item : {};
    const fallback = defaults[index] ?? {
      id: `range-${index + 1}`, startLayer: index + 1, endLayer: index + 1, multiplier: 1,
      useGlobalSpacing: true, spacingPct: globalSpacingPct, enabled: true,
    };
    const multiplier = toNumber(firstDefined(tuple?.[2], raw.multiplier, raw.mult, raw.factor), fallback.multiplier);
    const spacingRaw = firstDefined(tuple?.[3], raw.spacingPct, raw.spacing, raw.gap, raw.stepPct);
    const isGlobalAlias = typeof spacingRaw === "string" && spacingRaw.trim().toUpperCase() === "GLOBAL";
    const useGlobalSpacing = isGlobalAlias || toBoolean(
      firstDefined(raw.useGlobalSpacing, raw.use_global_spacing),
      spacingRaw === undefined ? fallback.useGlobalSpacing : false,
    );
    return {
      id: String(firstDefined(raw.id, `range-${index + 1}`)),
      startLayer: toNumber(firstDefined(tuple?.[0], raw.startLayer, raw.start, raw.from), fallback.startLayer),
      endLayer: toNumber(firstDefined(tuple?.[1], raw.endLayer, raw.end, raw.to), fallback.endLayer),
      multiplier,
      useGlobalSpacing,
      spacingPct: toNumber(useGlobalSpacing ? globalSpacingPct : spacingRaw, fallback.spacingPct),
      enabled: toBoolean(firstDefined(raw.enabled, raw.active), multiplier === 0 ? false : fallback.enabled),
    };
  });
}

function detectSource(raw: unknown): Rainbow20415ConfigSource {
  if (!isRecord(raw) || Object.keys(raw).length === 0) return "default";
  if (isLegacyEma20415Config(raw)) return "legacy-ema";
  if (raw.Config_Version === RAINBOW_20415_CONFIG_VERSION || raw.Lines !== undefined) return "rainbow";
  if (raw.TIMEFRAME !== undefined || raw.BASE_LOT !== undefined || raw.MARTINGALE_LAYERS !== undefined) return "document";
  return "rainbow";
}

export function migrateRainbow20415Config(raw: unknown): Rainbow20415MigrationResult {
  const source = detectSource(raw);
  const input = isRecord(raw) ? raw : {};
  const defaults = createRainbow20415DefaultConfig();
  if (source === "legacy-ema") {
    return {
      config: {
        ...defaults,
        Base_Lot_Size: parseBaseLot(input, defaults.Base_Lot_Size),
        Initial_Capital: toNumber(input.Initial_Capital, defaults.Initial_Capital),
      },
      source,
      migrated: true,
      ignoredLegacyKeys: LEGACY_EMA_KEYS.filter((key) => input[key] !== undefined),
    };
  }

  const globalSpacingPct = toNumber(
    firstDefined(input.Global_Spacing_Pct, input.GLOBAL_SPACING, input.globalSpacing, input.global_spacing_pct),
    defaults.Global_Spacing_Pct,
  );
  const config: Rainbow20415Config = {
    Config_Version: RAINBOW_20415_CONFIG_VERSION,
    Entry_Timeframe_Minutes: parseTimeframeMinutes(
      firstDefined(input.Entry_Timeframe_Minutes, input.TIMEFRAME, input.K_Line_Period, input.entryTimeframe),
      defaults.Entry_Timeframe_Minutes,
    ),
    Management_Interval_Minutes: parseTimeframeMinutes(
      firstDefined(input.Management_Interval_Minutes, input.MANAGEMENT_TIMEFRAME, input.managementInterval),
      defaults.Management_Interval_Minutes,
    ),
    Lines: parseLines(firstDefined(input.Lines, input.lines, input.MA_Lines), defaults.Lines),
    Base_Lot_Size: parseBaseLot(input, defaults.Base_Lot_Size),
    Initial_Capital: toNumber(input.Initial_Capital, defaults.Initial_Capital),
    Take_Profit_Pct: toNumber(firstDefined(input.Take_Profit_Pct, input.TAKE_PROFIT_PCT, input.takeProfitPct), defaults.Take_Profit_Pct),
    Global_Spacing_Pct: globalSpacingPct,
    Max_Hold_Hours: toNumber(firstDefined(input.Max_Hold_Hours, input.MAX_HOLD_HOURS, input.maxHoldHours), defaults.Max_Hold_Hours),
    Max_Margin_Usage_Pct: toNumber(firstDefined(input.Max_Margin_Usage_Pct, input.MAX_MARGIN_PCT, input.maxMarginPct), defaults.Max_Margin_Usage_Pct),
    Max_Account_Loss_Pct: Math.abs(toNumber(firstDefined(input.Max_Account_Loss_Pct, input.MAX_LOSS_LIMIT, input.maxLossPct), defaults.Max_Account_Loss_Pct)),
    Martingale_Enabled: toBoolean(firstDefined(input.Martingale_Enabled, input.MARTINGALE_ENABLED), defaults.Martingale_Enabled),
    Martin_Ranges: [],
    Reentry_Enabled: toBoolean(firstDefined(input.Reentry_Enabled, input.REENTRY_ENABLED), defaults.Reentry_Enabled),
    Reentry_Cooldown_Minutes: toNumber(
      firstDefined(input.Reentry_Cooldown_Minutes, input.REENTRY_COOLDOWN_MINUTES),
      defaults.Reentry_Cooldown_Minutes,
    ),
  };
  config.Martin_Ranges = parseRanges(
    firstDefined(input.Martin_Ranges, input.MARTINGALE_LAYERS, input.martinRanges),
    defaults.Martin_Ranges,
    config.Global_Spacing_Pct,
  );
  return {
    config,
    source,
    migrated: source !== "rainbow" || input.Config_Version !== RAINBOW_20415_CONFIG_VERSION,
    ignoredLegacyKeys: [],
  };
}

export function normalizeRainbow20415Config(raw: unknown): Rainbow20415Config {
  return migrateRainbow20415Config(raw).config;
}

function pushNumberIssue(
  issues: Rainbow20415ValidationIssue[], path: string, value: number,
  min: number, max: number | null, integer = false, allowMin = true,
): void {
  if (!Number.isFinite(value)) { issues.push({ path, message: "必須是有限數值" }); return; }
  if (integer && !Number.isInteger(value)) issues.push({ path, message: "必須是整數" });
  if ((allowMin && value < min) || (!allowMin && value <= min)) {
    issues.push({ path, message: `${allowMin ? "不可小於" : "必須大於"} ${min}` });
  }
  if (max !== null && value > max) issues.push({ path, message: `不可大於 ${max}` });
}

export function validateRainbow20415Config(raw: unknown): Rainbow20415ValidationResult {
  const config = normalizeRainbow20415Config(raw);
  const issues: Rainbow20415ValidationIssue[] = [];
  pushNumberIssue(issues, "Entry_Timeframe_Minutes", config.Entry_Timeframe_Minutes, 1, 1440, true);
  pushNumberIssue(issues, "Management_Interval_Minutes", config.Management_Interval_Minutes, 1, 60, true);
  if (Number.isInteger(config.Entry_Timeframe_Minutes) && Number.isInteger(config.Management_Interval_Minutes)
    && config.Entry_Timeframe_Minutes % config.Management_Interval_Minutes !== 0) {
    issues.push({ path: "Management_Interval_Minutes", message: "持倉管理週期必須可整除進場週期" });
  }

  if (config.Lines.length !== 7) issues.push({ path: "Lines", message: "七彩虹必須恰好配置 7 條均線" });
  const lineIds = new Set<string>();
  const lineDefinitions = new Set<string>();
  config.Lines.forEach((line, index) => {
    const path = `Lines.${index}`;
    if (lineIds.has(line.id)) issues.push({ path: `${path}.id`, message: `線識別 ${line.id} 重複` });
    lineIds.add(line.id);
    // OKX 單次 candles 端點最多可安全取得 300 根；保留 2 根給前後 K 棒比較。
    pushNumberIssue(issues, `${path}.period`, line.period, 1, 250, true);
    const signature = `${line.type}:${line.period}:${line.source}`;
    if (lineDefinitions.has(signature)) issues.push({ path, message: `均線定義 ${signature} 重複，排名將失去意義` });
    lineDefinitions.add(signature);
    if (!/^#[0-9a-f]{6}$/i.test(line.color)) issues.push({ path: `${path}.color`, message: "顏色必須是六位十六進位格式" });
    if (line.label.trim().length === 0 || line.label.length > 24) issues.push({ path: `${path}.label`, message: "名稱長度必須介於 1 與 24 個字元" });
  });
  for (const id of RAINBOW_20415_LINE_IDS) if (!lineIds.has(id)) issues.push({ path: "Lines", message: `缺少必要線識別 ${id}` });

  pushNumberIssue(issues, "Base_Lot_Size.value", config.Base_Lot_Size.value, 0, null, false, false);
  pushNumberIssue(issues, "Initial_Capital", config.Initial_Capital, 0, null, false, false);
  pushNumberIssue(issues, "Take_Profit_Pct", config.Take_Profit_Pct, 0, 100, false, false);
  pushNumberIssue(issues, "Global_Spacing_Pct", config.Global_Spacing_Pct, 0, 100, false, false);
  pushNumberIssue(issues, "Max_Hold_Hours", config.Max_Hold_Hours, 0, 8760, false, false);
  pushNumberIssue(issues, "Max_Margin_Usage_Pct", config.Max_Margin_Usage_Pct, 0, 100, false, false);
  pushNumberIssue(issues, "Max_Account_Loss_Pct", config.Max_Account_Loss_Pct, 0, 100, false, false);
  pushNumberIssue(issues, "Reentry_Cooldown_Minutes", config.Reentry_Cooldown_Minutes, 0, 10080, true);

  if (config.Martin_Ranges.length === 0) issues.push({ path: "Martin_Ranges", message: "至少需要一個連續的馬丁範圍" });
  let enabledCount = 0;
  const rangeIds = new Set<string>();
  config.Martin_Ranges.forEach((range, index) => {
    const path = `Martin_Ranges.${index}`;
    if (rangeIds.has(range.id)) issues.push({ path: `${path}.id`, message: "範圍識別不可重複" });
    rangeIds.add(range.id);
    if (!Number.isSafeInteger(range.startLayer) || range.startLayer < 1) issues.push({ path: `${path}.startLayer`, message: "起始層必須是大於等於 1 的安全整數" });
    if (!Number.isSafeInteger(range.endLayer) || range.endLayer < range.startLayer) issues.push({ path: `${path}.endLayer`, message: "結束層必須大於等於起始層" });
    if (index === 0 && range.startLayer !== 1) issues.push({ path: `${path}.startLayer`, message: "第一個範圍必須從底倉第 1 層開始" });
    if (index > 0 && range.startLayer !== config.Martin_Ranges[index - 1].endLayer + 1) issues.push({ path: `${path}.startLayer`, message: "範圍必須連續，不可重疊或斷層" });
    if (range.enabled) {
      enabledCount += 1;
      if (!Number.isFinite(range.multiplier) || range.multiplier <= 0 || range.multiplier > 10) issues.push({ path: `${path}.multiplier`, message: "啟用範圍乘數必須大於 0 且不超過 10" });
    } else if (!Number.isFinite(range.multiplier) || range.multiplier < 0 || range.multiplier > 10) {
      issues.push({ path: `${path}.multiplier`, message: "停用範圍乘數必須介於 0 與 10" });
    }
    if (!Number.isFinite(range.spacingPct) || range.spacingPct <= 0 || range.spacingPct > 100) issues.push({ path: `${path}.spacingPct`, message: "間距必須大於 0% 且不超過 100%" });
  });
  if (enabledCount === 0) issues.push({ path: "Martin_Ranges", message: "至少需要一個啟用中的馬丁範圍" });
  if (config.Martin_Ranges[0] && !config.Martin_Ranges[0].enabled) issues.push({ path: "Martin_Ranges.0.enabled", message: "包含底倉第 1 層的第一範圍不可停用" });
  return { valid: issues.length === 0, config, issues };
}

export function assertValidRainbow20415Config(raw: unknown): Rainbow20415Config {
  const result = validateRainbow20415Config(raw);
  if (!result.valid) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"));
  return result.config;
}

export function getRainbow20415EffectiveSpacing(
  config: Pick<Rainbow20415Config, "Global_Spacing_Pct">,
  range: Rainbow20415MartinRange,
): number {
  return range.useGlobalSpacing ? config.Global_Spacing_Pct : range.spacingPct;
}

export function getRainbow20415RangeForLayer(
  ranges: readonly Rainbow20415MartinRange[], layer: number,
): Rainbow20415MartinRange | undefined {
  return ranges.find((range) => layer >= range.startLayer && layer <= range.endLayer);
}

export function getRainbow20415NextEnabledLayer(
  ranges: readonly Rainbow20415MartinRange[], currentLayer: number,
): { layer: number; range: Rainbow20415MartinRange } | undefined {
  for (const range of ranges) {
    if (!range.enabled || range.endLayer <= currentLayer) continue;
    return { layer: Math.max(currentLayer + 1, range.startLayer), range };
  }
  return undefined;
}

export function deriveRainbow20415FinalEnabledLayer(ranges: readonly Rainbow20415MartinRange[]): number {
  return ranges.reduce((finalLayer, range) => range.enabled ? Math.max(finalLayer, range.endLayer) : finalLayer, 0);
}

export function formatRainbow20415Timeframe(minutes: number): string {
  if (minutes % 1440 === 0) return `D${minutes / 1440}`;
  if (minutes % 60 === 0) return `H${minutes / 60}`;
  return `M${minutes}`;
}
