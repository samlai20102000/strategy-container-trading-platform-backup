export const V25_STRATEGY_KEY = "KAMA_3K_BREAKOUT_V25" as const;
export const V25_STRATEGY_NAME = "KAMA 三K突破 V2.5｜階梯式馬丁" as const;
export const V25_STRATEGY_VERSION = "2.5.0" as const;

export interface V25MartinRange {
  start: number;
  end: number;
  multiplier: number;
  gap: number;
}

/**
 * V2.5 全鏈路唯一配置契約。
 * 百分比均採名義價格變動，不乘槓桿；Base_Lot_Size 與加倉金額單位為 USDT。
 */
export interface V25StrategyConfig {
  KAMA_Fast_Length: number;
  p2_fastest: number;
  p3_slowest: number;
  KAMA_Slow_Length: number;
  q2_fastest: number;
  q3_slowest: number;
  Base_Lot_Size: number;
  Hard_Stop_Loss_Pct: number;
  Take_Profit_Pct: number;
  Trailing_TP_Enabled: boolean;
  Trailing_Activation_Pct: number;
  Trailing_Callback_Pct: number;
  Martin_Enabled: boolean;
  Martin_Ranges: V25MartinRange[];
  Reentry_On_Trend: boolean;
  K_Line_Period: number;
}

export type V25ConfigKey = keyof V25StrategyConfig;

export interface V25ValidationIssue {
  path: string;
  message: string;
}

export interface V25ValidationResult {
  valid: boolean;
  config: V25StrategyConfig;
  issues: V25ValidationIssue[];
}

const DEFAULT_RANGES: V25MartinRange[] = [
  { start: 1, end: 3, multiplier: 1.2, gap: 0.8 },
  { start: 4, end: 6, multiplier: 1.1, gap: 1.2 },
  { start: 7, end: 10, multiplier: 1.0, gap: 2.0 },
];

export const V25_DEFAULT_CONFIG: Readonly<V25StrategyConfig> = {
  KAMA_Fast_Length: 50,
  p2_fastest: 10,
  p3_slowest: 2,
  KAMA_Slow_Length: 50,
  q2_fastest: 10,
  q3_slowest: 6,
  Base_Lot_Size: 100,
  Hard_Stop_Loss_Pct: 3,
  Take_Profit_Pct: 1,
  Trailing_TP_Enabled: true,
  Trailing_Activation_Pct: 0.8,
  Trailing_Callback_Pct: 0.4,
  Martin_Enabled: true,
  Martin_Ranges: DEFAULT_RANGES,
  Reentry_On_Trend: true,
  K_Line_Period: 15,
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
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "off", "no"].includes(normalized)) return false;
    if (["true", "1", "on", "yes"].includes(normalized)) return true;
  }
  return fallback;
}

function parseMartinRanges(value: unknown): V25MartinRange[] {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return DEFAULT_RANGES.map((range) => ({ ...range }));
    }
  }

  if (!Array.isArray(source)) {
    return DEFAULT_RANGES.map((range) => ({ ...range }));
  }

  return source.map((item, index) => {
    const range = isRecord(item) ? item : {};
    const fallback = DEFAULT_RANGES[index] ?? {
      start: index === 0 ? 1 : index + 1,
      end: index === 0 ? 1 : index + 1,
      multiplier: 1,
      gap: 1,
    };
    return {
      start: toFiniteNumber(range.start, fallback.start),
      end: toFiniteNumber(range.end, fallback.end),
      multiplier: toFiniteNumber(range.multiplier, fallback.multiplier),
      gap: toFiniteNumber(firstDefined(range.gap, range.stepPct), fallback.gap),
    };
  });
}

export function createV25DefaultConfig(): V25StrategyConfig {
  return {
    ...V25_DEFAULT_CONFIG,
    Martin_Ranges: V25_DEFAULT_CONFIG.Martin_Ranges.map((range) => ({ ...range })),
  };
}

/**
 * 接受平台扁平鍵、文件 PACK 1 的巢狀鍵，以及舊 KAMA 相容別名。
 * 使用 nullish／顯式布林解析，合法 0 與 false 不會被預設值覆蓋。
 */
export function normalizeV25Config(raw: unknown): V25StrategyConfig {
  const source = isRecord(raw) ? raw : {};
  const kamaFast = isRecord(source.kamaFast) ? source.kamaFast : {};
  const kamaSlow = isRecord(source.kamaSlow) ? source.kamaSlow : {};
  const defaults = createV25DefaultConfig();

  return {
    KAMA_Fast_Length: toFiniteNumber(
      firstDefined(source.KAMA_Fast_Length, source.kama_fast_length, kamaFast.er),
      defaults.KAMA_Fast_Length,
    ),
    p2_fastest: toFiniteNumber(
      firstDefined(source.p2_fastest, source.kama_fast_fastest, kamaFast.fastest),
      defaults.p2_fastest,
    ),
    p3_slowest: toFiniteNumber(
      firstDefined(source.p3_slowest, source.kama_fast_slowest, kamaFast.slowest),
      defaults.p3_slowest,
    ),
    KAMA_Slow_Length: toFiniteNumber(
      firstDefined(source.KAMA_Slow_Length, source.kama_slow_length, kamaSlow.er),
      defaults.KAMA_Slow_Length,
    ),
    q2_fastest: toFiniteNumber(
      firstDefined(source.q2_fastest, source.kama_slow_fastest, kamaSlow.fastest),
      defaults.q2_fastest,
    ),
    q3_slowest: toFiniteNumber(
      firstDefined(source.q3_slowest, source.kama_slow_slowest, kamaSlow.slowest),
      defaults.q3_slowest,
    ),
    Base_Lot_Size: toFiniteNumber(
      firstDefined(source.Base_Lot_Size, source.base_lot_size, source.baseLot),
      defaults.Base_Lot_Size,
    ),
    Hard_Stop_Loss_Pct: toFiniteNumber(
      firstDefined(source.Hard_Stop_Loss_Pct, source.hard_stop_loss_pct, source.slPct),
      defaults.Hard_Stop_Loss_Pct,
    ),
    Take_Profit_Pct: toFiniteNumber(
      firstDefined(source.Take_Profit_Pct, source.take_profit_pct, source.tpPct),
      defaults.Take_Profit_Pct,
    ),
    Trailing_TP_Enabled: toBoolean(
      firstDefined(source.Trailing_TP_Enabled, source.trailing_tp_enabled, source.trailingTpEnabled),
      defaults.Trailing_TP_Enabled,
    ),
    Trailing_Activation_Pct: toFiniteNumber(
      firstDefined(source.Trailing_Activation_Pct, source.trailing_activation_pct, source.trailingTpActivation),
      defaults.Trailing_Activation_Pct,
    ),
    Trailing_Callback_Pct: toFiniteNumber(
      firstDefined(source.Trailing_Callback_Pct, source.trailing_callback_pct, source.trailingTpCallback),
      defaults.Trailing_Callback_Pct,
    ),
    Martin_Enabled: toBoolean(
      firstDefined(source.Martin_Enabled, source.martin_enabled, source.martinEnabled),
      defaults.Martin_Enabled,
    ),
    Martin_Ranges: parseMartinRanges(
      firstDefined(source.Martin_Ranges, source.martin_ranges, source.martinRanges),
    ),
    Reentry_On_Trend: toBoolean(
      firstDefined(source.Reentry_On_Trend, source.reentry_on_trend, source.reentryEnabled),
      defaults.Reentry_On_Trend,
    ),
    K_Line_Period: toFiniteNumber(
      firstDefined(source.K_Line_Period, source.k_line_period, source.timeframeMinutes),
      defaults.K_Line_Period,
    ),
  };
}

function pushNumberIssue(
  issues: V25ValidationIssue[],
  path: keyof V25StrategyConfig,
  value: number,
  min: number,
  max: number | null,
  integer = false,
): void {
  if (!Number.isFinite(value)) {
    issues.push({ path, message: "必須是有限數值" });
    return;
  }
  if (integer && !Number.isInteger(value)) {
    issues.push({ path, message: "必須是整數" });
  }
  if (value < min) {
    issues.push({ path, message: `不可小於 ${min}` });
  }
  if (max !== null && value > max) {
    issues.push({ path, message: `不可大於 ${max}` });
  }
}

export function validateV25Config(raw: unknown): V25ValidationResult {
  const config = normalizeV25Config(raw);
  const issues: V25ValidationIssue[] = [];

  pushNumberIssue(issues, "KAMA_Fast_Length", config.KAMA_Fast_Length, 5, 200, true);
  pushNumberIssue(issues, "p2_fastest", config.p2_fastest, 2, 20, true);
  pushNumberIssue(issues, "p3_slowest", config.p3_slowest, 1, 10, true);
  pushNumberIssue(issues, "KAMA_Slow_Length", config.KAMA_Slow_Length, 5, 200, true);
  pushNumberIssue(issues, "q2_fastest", config.q2_fastest, 2, 20, true);
  pushNumberIssue(issues, "q3_slowest", config.q3_slowest, 1, 10, true);
  if (config.q3_slowest <= config.p3_slowest) {
    issues.push({ path: "q3_slowest", message: "慢線最慢常數必須大於快線最慢常數" });
  }

  pushNumberIssue(issues, "Base_Lot_Size", config.Base_Lot_Size, 1, null);
  pushNumberIssue(issues, "Hard_Stop_Loss_Pct", config.Hard_Stop_Loss_Pct, 0, 10);
  pushNumberIssue(issues, "Take_Profit_Pct", config.Take_Profit_Pct, 0, 10);
  pushNumberIssue(issues, "Trailing_Activation_Pct", config.Trailing_Activation_Pct, 0.1, 5);
  pushNumberIssue(issues, "Trailing_Callback_Pct", config.Trailing_Callback_Pct, 0.05, 3);
  if (
    config.Trailing_TP_Enabled &&
    config.Trailing_Callback_Pct > config.Trailing_Activation_Pct
  ) {
    issues.push({
      path: "Trailing_Callback_Pct",
      message: "追蹤回撤不可大於啟動門檻",
    });
  }
  pushNumberIssue(issues, "K_Line_Period", config.K_Line_Period, 1, 1440, true);

  if (config.Martin_Ranges.length === 0) {
    issues.push({ path: "Martin_Ranges", message: "至少需要一個馬丁範圍" });
  }

  config.Martin_Ranges.forEach((range, index) => {
    const path = `Martin_Ranges.${index}`;
    if (!Number.isSafeInteger(range.start) || range.start < 1) {
      issues.push({ path: `${path}.start`, message: "起始層必須是大於等於 1 的安全整數" });
    }
    if (!Number.isSafeInteger(range.end) || range.end < range.start) {
      issues.push({ path: `${path}.end`, message: "結束層必須是大於等於起始層的安全整數" });
    }
    if (index === 0 && range.start !== 1) {
      issues.push({ path: `${path}.start`, message: "第一個範圍必須從第 1 層開始" });
    }
    if (index > 0 && range.start !== config.Martin_Ranges[index - 1].end + 1) {
      issues.push({ path: `${path}.start`, message: "範圍必須連續，不可重疊或斷層" });
    }
    if (!Number.isFinite(range.multiplier) || range.multiplier < 0.1 || range.multiplier > 5) {
      issues.push({ path: `${path}.multiplier`, message: "乘數必須介於 0.1 與 5.0" });
    }
    if (!Number.isFinite(range.gap) || range.gap < 0.1 || range.gap > 20) {
      issues.push({ path: `${path}.gap`, message: "間距必須介於 0.1% 與 20%" });
    }
  });

  return { valid: issues.length === 0, config, issues };
}

export function assertValidV25Config(raw: unknown): V25StrategyConfig {
  const result = validateV25Config(raw);
  if (!result.valid) {
    throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"));
  }
  return result.config;
}

export function deriveV25MaxMartinLayer(ranges: readonly V25MartinRange[]): number {
  return ranges.length > 0 ? ranges[ranges.length - 1].end : 0;
}

export function getV25MartinRangeForLayer(
  ranges: readonly V25MartinRange[],
  layer: number,
): V25MartinRange | undefined {
  return ranges.find((range) => layer >= range.start && layer <= range.end);
}

export function getV25CumulativeMultiplier(
  ranges: readonly V25MartinRange[],
  throughRangeIndex: number,
): number {
  let cumulative = 1;
  for (let index = 0; index <= throughRangeIndex && index < ranges.length; index += 1) {
    const range = ranges[index];
    cumulative *= range.multiplier ** (range.end - range.start + 1);
  }
  return cumulative;
}

/** 文件 PACK 1 的巢狀 context.params 形式，供摘要與相容邊界使用。 */
export function toV25DocumentParams(config: V25StrategyConfig): Record<string, unknown> {
  return {
    kamaFast: {
      er: config.KAMA_Fast_Length,
      fastest: config.p2_fastest,
      slowest: config.p3_slowest,
    },
    kamaSlow: {
      er: config.KAMA_Slow_Length,
      fastest: config.q2_fastest,
      slowest: config.q3_slowest,
    },
    baseLot: config.Base_Lot_Size,
    slPct: config.Hard_Stop_Loss_Pct,
    tpPct: config.Take_Profit_Pct,
    trailingTpEnabled: config.Trailing_TP_Enabled,
    trailingTpActivation: config.Trailing_Activation_Pct,
    trailingTpCallback: config.Trailing_Callback_Pct,
    martinEnabled: config.Martin_Enabled,
    martinRanges: config.Martin_Ranges.map((range) => ({ ...range })),
    reentryEnabled: config.Reentry_On_Trend,
  };
}
