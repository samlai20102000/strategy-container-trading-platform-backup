export const RAINBOW_TREND_LADDER_STRATEGY_KEY = "RAINBOW_TREND_LADDER_V1" as const;
export const RAINBOW_TREND_LADDER_STRATEGY_NAME = "七彩虹線趨勢跟蹤階梯馬丁策略" as const;
export const RAINBOW_TREND_LADDER_CONFIG_VERSION = "rainbowTrendLadder.v1" as const;
export const RAINBOW_TREND_LADDER_LINE_IDS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"] as const;

export type RainbowTrendLadderLineId = (typeof RAINBOW_TREND_LADDER_LINE_IDS)[number];
export type RainbowTrendLadderLineSource = "close" | "hlc3" | "high" | "low";
export type RainbowTrendLadderPositionMode = "quantity" | "usdt";
export type RainbowTrendLadderBaseLine = "L1" | "L2" | "L3" | "L4";

export interface RainbowTrendLadderLineConfig {
  id: RainbowTrendLadderLineId;
  label: string;
  period: number;
  source: RainbowTrendLadderLineSource;
  color: string;
}

export interface RainbowTrendLadderBaseLot {
  value: number;
  mode: RainbowTrendLadderPositionMode;
}

/**
 * `triggerSpacingPct` 是相對上一層的逆向間距。執行時會自底倉起累加，
 * 因此預設八層的累積觸發距離依次為 0、0.31、0.77、1.39、2.16、2.78、3.24、3.55%。
 * `lotValue` 是真正下單值；`lotMultiplier` 只保留規格說明與 UI 對照，不作複利計算。
 */
export interface RainbowTrendLadderLayerConfig {
  layer: number;
  triggerSpacingPct: number;
  lotMultiplier: number;
  lotValue: number;
  enabled: boolean;
}

export interface RainbowTrendLadderConfig {
  Config_Version: typeof RAINBOW_TREND_LADDER_CONFIG_VERSION;
  Entry_Timeframe_Minutes: number; // 可配置的入場 K 線時間週期 (分鐘)
  Management_Interval_Minutes: number; // 可配置的持倉管理週期 (分鐘)
  Lines: RainbowTrendLadderLineConfig[];
  Base_Lot_Size: RainbowTrendLadderBaseLot;
  Initial_Capital: number;
  Point_Value: number;
  Max_Spread_Points: number;
  Max_Slippage_Points: number;
  Martin_Layers: RainbowTrendLadderLayerConfig[];
  Trailing_Activation_Pct: number;
  Trailing_Callback_Pct: number;
  Trend_Deviation_Points: number;
  Trend_Base_Line: RainbowTrendLadderBaseLine;
  Max_Margin_Usage_Pct: number;
  Close_On_Margin_Breach: boolean;
  Reentry_Wait_Next_M30_Close: boolean;
  Require_Dedicated_Account: boolean;
  Kill_Close_Only_Owned_Position: boolean;
  Live_Trading_Armed: boolean;
}

export interface RainbowTrendLadderValidationIssue {
  path: string;
  message: string;
}

export interface RainbowTrendLadderValidationResult {
  valid: boolean;
  config: RainbowTrendLadderConfig;
  issues: RainbowTrendLadderValidationIssue[];
}

const DEFAULT_LINES: RainbowTrendLadderLineConfig[] = [
  { id: "L1", label: "趨勢快線 SMA30", period: 30, source: "close", color: "#ff453a" },
  { id: "L2", label: "基礎趨勢線 SMA60", period: 60, source: "close", color: "#ff9f0a" },
  { id: "L3", label: "典型價格 SMA15", period: 15, source: "hlc3", color: "#ffd60a" },
  { id: "L4", label: "短線節奏 SMA6", period: 6, source: "close", color: "#30d158" },
  { id: "L5", label: "入場觸發 SMA3", period: 3, source: "close", color: "#64d2ff" },
  { id: "L6", label: "波峰確認 SMA15 High", period: 15, source: "high", color: "#0a84ff" },
  { id: "L7", label: "波谷確認 SMA15 Low", period: 15, source: "low", color: "#bf5af2" },
];

const DEFAULT_LAYERS: RainbowTrendLadderLayerConfig[] = Array.from({ length: 20 }).map((_, i) => {
  const layer = i + 1;
  let triggerSpacingPct = 0;
  let lotMultiplier = 1;

  if (layer === 1) {
    triggerSpacingPct = 0;
    lotMultiplier = 1;
  } else if (layer <= 8) {
    // Original 8 layers pattern
    const originalSpacings = [0.31, 0.46, 0.62, 0.77, 0.62, 0.46, 0.31];
    triggerSpacingPct = originalSpacings[layer - 2];
    lotMultiplier = 1.5;
  } else {
    // Extend pattern for layers 9-20, using a simple decreasing spacing and increasing multiplier
    triggerSpacingPct = Math.max(0.1, 0.31 - (layer - 8) * 0.02); // Decrease spacing gradually
    lotMultiplier = 1.5 + (layer - 8) * 0.1; // Increase multiplier gradually
  }

  return {
    layer,
    triggerSpacingPct: parseFloat(triggerSpacingPct.toFixed(2)),
    lotMultiplier: parseFloat(lotMultiplier.toFixed(2)),
    lotValue: 0, // This will be calculated based on Base_Lot_Size later
    enabled: true,
  };
});

export const RAINBOW_TREND_LADDER_DEFAULT_CONFIG: Readonly<RainbowTrendLadderConfig> = {
  Config_Version: RAINBOW_TREND_LADDER_CONFIG_VERSION,
  Entry_Timeframe_Minutes: 30, // 預設入場 K 線時間週期 (分鐘)
  Management_Interval_Minutes: 1, // 預設持倉管理週期 (分鐘)
  Lines: DEFAULT_LINES,
  Base_Lot_Size: { value: 100, mode: "usdt" }, // 預設值改為 100 USDT
  Initial_Capital: 10_000,
  Point_Value: 1,
  Max_Spread_Points: 50,
  Max_Slippage_Points: 5,
  Martin_Layers: DEFAULT_LAYERS.map((layer) => ({
    ...layer,
    lotValue: layer.layer * 100, // 預設層級的 lotValue 根據 Base_Lot_Size 預設值計算
  })),
  Trailing_Activation_Pct: 1.1,
  Trailing_Callback_Pct: 0.1,
  Trend_Deviation_Points: 50,
  Trend_Base_Line: "L2",
  Max_Margin_Usage_Pct: 70,
  Close_On_Margin_Breach: true,
  Reentry_Wait_Next_M30_Close: true,
  Require_Dedicated_Account: true,
  Kill_Close_Only_Owned_Position: true,
  Live_Trading_Armed: false,
};

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
    if (["true", "1", "on", "yes", "enabled"].includes(normalized)) return true;
    if (["false", "0", "off", "no", "disabled"].includes(normalized)) return false;
  }
  return fallback;
}

function toPositionMode(value: unknown, fallback: RainbowTrendLadderPositionMode): RainbowTrendLadderPositionMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["usdt", "quote", "notional"].includes(normalized)) return "usdt";
  if (["quantity", "qty", "base", "lot", "lots"].includes(normalized)) return "quantity";
  return fallback;
}

function toLineSource(value: unknown, fallback: RainbowTrendLadderLineSource): RainbowTrendLadderLineSource {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "close" || normalized === "hlc3" || normalized === "high" || normalized === "low"
    ? normalized
    : fallback;
}

function cloneLines(lines: readonly RainbowTrendLadderLineConfig[]): RainbowTrendLadderLineConfig[] {
  return lines.map((line) => ({ ...line }));
}

function cloneLayers(layers: readonly RainbowTrendLadderLayerConfig[]): RainbowTrendLadderLayerConfig[] {
  return layers.map((layer) => ({ ...layer }));
}

export function createRainbowTrendLadderDefaultConfig(): RainbowTrendLadderConfig {
  return {
    ...RAINBOW_TREND_LADDER_DEFAULT_CONFIG,
    Lines: cloneLines(RAINBOW_TREND_LADDER_DEFAULT_CONFIG.Lines),
    Base_Lot_Size: { ...RAINBOW_TREND_LADDER_DEFAULT_CONFIG.Base_Lot_Size },
    Martin_Layers: cloneLayers(RAINBOW_TREND_LADDER_DEFAULT_CONFIG.Martin_Layers),
  };
}

function parseBaseLot(input: Record<string, unknown>, fallback: RainbowTrendLadderBaseLot): RainbowTrendLadderBaseLot {
  const raw = firstDefined(input.Base_Lot_Size, input.BASE_LOT, input.baseLot, input.base_lot_size);
  if (isRecord(raw)) {
    return {
      value: toNumber(firstDefined(raw.value, raw.amount, raw.quantity), fallback.value),
      mode: toPositionMode(firstDefined(raw.mode, raw.unit), fallback.mode),
    };
  }
  return {
    value: toNumber(firstDefined(raw, input.Position_Value, input.positionValue), fallback.value),
    mode: toPositionMode(firstDefined(input.Position_Mode, input.positionMode), fallback.mode),
  };
}

function parseLines(value: unknown, defaults: readonly RainbowTrendLadderLineConfig[]): RainbowTrendLadderLineConfig[] {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { return cloneLines(defaults); }
  }
  if (!Array.isArray(source)) return cloneLines(defaults);
  return source.map((item, index) => {
    const raw = isRecord(item) ? item : {};
    const fallback = defaults[index] ?? defaults[defaults.length - 1];
    const idCandidate = String(firstDefined(raw.id, raw.key, RAINBOW_TREND_LADDER_LINE_IDS[index] ?? "L7"));
    const id = RAINBOW_TREND_LADDER_LINE_IDS.includes(idCandidate as RainbowTrendLadderLineId)
      ? idCandidate as RainbowTrendLadderLineId
      : RAINBOW_TREND_LADDER_LINE_IDS[index] ?? "L7";
    return {
      id,
      label: String(firstDefined(raw.label, raw.name, fallback.label)),
      period: toNumber(firstDefined(raw.period, raw.length), fallback.period),
      source: toLineSource(firstDefined(raw.source, raw.priceSource), fallback.source),
      color: String(firstDefined(raw.color, fallback.color)),
    };
  });
}

function parseLayers(value: unknown, defaults: readonly RainbowTrendLadderLayerConfig[]): RainbowTrendLadderLayerConfig[] {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { return cloneLayers(defaults); }
  }
  if (!Array.isArray(source)) return cloneLayers(defaults);
  return source.map((item, index) => {
    const tuple = Array.isArray(item) ? item : null;
    const raw = isRecord(item) ? item : {};
    const fallback = defaults[index] ?? {
      layer: index + 1,
      triggerSpacingPct: 0,
      lotMultiplier: 1,
      lotValue: defaults[0]?.lotValue ?? 0.06,
      enabled: true,
    };
    return {
      layer: toNumber(firstDefined(tuple?.[0], raw.layer, raw.level), fallback.layer),
      triggerSpacingPct: toNumber(
        firstDefined(tuple?.[1], raw.triggerSpacingPct, raw.spacingPct, raw.triggerPct),
        fallback.triggerSpacingPct,
      ),
      lotMultiplier: toNumber(
        firstDefined(tuple?.[2], raw.lotMultiplier, raw.multiplier),
        fallback.lotMultiplier,
      ),
      lotValue: toNumber(
        firstDefined(tuple?.[3], raw.lotValue, raw.lot, raw.size),
        fallback.lotValue,
      ),
      enabled: toBoolean(firstDefined(tuple?.[4], raw.enabled, raw.active), fallback.enabled),
    };
  });
}

export function normalizeRainbowTrendLadderConfig(raw: unknown): RainbowTrendLadderConfig {
  const input = isRecord(raw) ? raw : {};
  const defaults = createRainbowTrendLadderDefaultConfig();
  const baseLineCandidate = String(firstDefined(input.Trend_Base_Line, input.trendBaseLine, defaults.Trend_Base_Line));
  const trendBaseLine: RainbowTrendLadderBaseLine = ["L1", "L2", "L3", "L4"].includes(baseLineCandidate)
    ? baseLineCandidate as RainbowTrendLadderBaseLine
    : defaults.Trend_Base_Line;
  return {
    Config_Version: RAINBOW_TREND_LADDER_CONFIG_VERSION,
    Entry_Timeframe_Minutes: toNumber(firstDefined(input.Entry_Timeframe_Minutes, input.TIMEFRAME, input.entryTimeframe), defaults.Entry_Timeframe_Minutes),
    Management_Interval_Minutes: toNumber(firstDefined(input.Management_Interval_Minutes, input.managementInterval), defaults.Management_Interval_Minutes),
    Lines: parseLines(firstDefined(input.Lines, input.lines, input.MA_Lines), defaults.Lines),
    Base_Lot_Size: parseBaseLot(input, defaults.Base_Lot_Size),
    Initial_Capital: toNumber(firstDefined(input.Initial_Capital, input.initialCapital), defaults.Initial_Capital),
    Point_Value: toNumber(firstDefined(input.Point_Value, input.pointValue), defaults.Point_Value),
    Max_Spread_Points: toNumber(firstDefined(input.Max_Spread_Points, input.maxSpread), defaults.Max_Spread_Points),
    Max_Slippage_Points: toNumber(firstDefined(input.Max_Slippage_Points, input.maxSlippage), defaults.Max_Slippage_Points),
    Martin_Layers: parseLayers(firstDefined(input.Martin_Layers, input.MARTINGALE_LAYERS, input.layers), defaults.Martin_Layers),
    Trailing_Activation_Pct: toNumber(firstDefined(input.Trailing_Activation_Pct, input.trailingActivationPct), defaults.Trailing_Activation_Pct),
    Trailing_Callback_Pct: toNumber(firstDefined(input.Trailing_Callback_Pct, input.trailingCallbackPct), defaults.Trailing_Callback_Pct),
    Trend_Deviation_Points: toNumber(firstDefined(input.Trend_Deviation_Points, input.trendDeviationPoints), defaults.Trend_Deviation_Points),
    Trend_Base_Line: trendBaseLine,
    Max_Margin_Usage_Pct: toNumber(firstDefined(input.Max_Margin_Usage_Pct, input.maxMarginPct), defaults.Max_Margin_Usage_Pct),
    Close_On_Margin_Breach: toBoolean(firstDefined(input.Close_On_Margin_Breach, input.closeOnMarginBreach), defaults.Close_On_Margin_Breach),
    Reentry_Wait_Next_M30_Close: toBoolean(firstDefined(input.Reentry_Wait_Next_M30_Close, input.reentryWaitNextM30Close), defaults.Reentry_Wait_Next_M30_Close),
    Require_Dedicated_Account: toBoolean(firstDefined(input.Require_Dedicated_Account, input.requireDedicatedAccount), defaults.Require_Dedicated_Account),
    Kill_Close_Only_Owned_Position: toBoolean(firstDefined(input.Kill_Close_Only_Owned_Position, input.killCloseOnlyOwnedPosition), defaults.Kill_Close_Only_Owned_Position),
    Live_Trading_Armed: toBoolean(firstDefined(input.Live_Trading_Armed, input.liveTradingArmed), defaults.Live_Trading_Armed),
  };
}

function pushNumberIssue(
  issues: RainbowTrendLadderValidationIssue[],
  path: string,
  value: number,
  min: number,
  max: number | null,
  options?: { integer?: boolean; allowMin?: boolean },
): void {
  if (!Number.isFinite(value)) { issues.push({ path, message: "必須是有限數值" }); return; }
  if (options?.integer && !Number.isInteger(value)) issues.push({ path, message: "必須是整數" });
  const allowMin = options?.allowMin ?? true;
  if ((allowMin && value < min) || (!allowMin && value <= min)) {
    issues.push({ path, message: `${allowMin ? "不可小於" : "必須大於"} ${min}` });
  }
  if (max !== null && value > max) issues.push({ path, message: `不可大於 ${max}` });
}

export function validateRainbowTrendLadderConfig(raw: unknown): RainbowTrendLadderValidationResult {
  const config = normalizeRainbowTrendLadderConfig(raw);
  const issues: RainbowTrendLadderValidationIssue[] = [];
  pushNumberIssue(issues, "Entry_Timeframe_Minutes", config.Entry_Timeframe_Minutes, 1, 1440, { integer: true });
  pushNumberIssue(issues, "Management_Interval_Minutes", config.Management_Interval_Minutes, 1, 1440, { integer: true }); // 允許最大 24 小時 (1440 分鐘)
  if (config.Entry_Timeframe_Minutes % config.Management_Interval_Minutes !== 0) {
    issues.push({ path: "Management_Interval_Minutes", message: "持倉管理週期必須可整除進場週期" });
  }
  if (config.Lines.length !== 7) issues.push({ path: "Lines", message: "必須恰好配置 7 條 SMA" });
  const lineIds = new Set<string>();
  config.Lines.forEach((line, index) => {
    const path = `Lines.${index}`;
    if (lineIds.has(line.id)) issues.push({ path: `${path}.id`, message: `線識別 ${line.id} 重複` });
    lineIds.add(line.id);
    pushNumberIssue(issues, `${path}.period`, line.period, 1, 250, { integer: true });
    if (!/^#[0-9a-f]{6}$/i.test(line.color)) issues.push({ path: `${path}.color`, message: "顏色必須是六位十六進位格式" });
    if (line.label.trim().length === 0 || line.label.length > 40) issues.push({ path: `${path}.label`, message: "名稱長度必須介於 1 與 40 個字元" });
  });
  for (const id of RAINBOW_TREND_LADDER_LINE_IDS) {
    if (!lineIds.has(id)) issues.push({ path: "Lines", message: `缺少必要線識別 ${id}` });
  }

  pushNumberIssue(issues, "Base_Lot_Size.value", config.Base_Lot_Size.value, 0, null, { allowMin: false });
  pushNumberIssue(issues, "Initial_Capital", config.Initial_Capital, 0, null, { allowMin: false });
  pushNumberIssue(issues, "Point_Value", config.Point_Value, 0, null, { allowMin: false });
  pushNumberIssue(issues, "Max_Spread_Points", config.Max_Spread_Points, 0, null, { allowMin: false });
  pushNumberIssue(issues, "Max_Slippage_Points", config.Max_Slippage_Points, 0, null);
  pushNumberIssue(issues, "Trailing_Activation_Pct", config.Trailing_Activation_Pct, 0, 100, { allowMin: false });
  pushNumberIssue(issues, "Trailing_Callback_Pct", config.Trailing_Callback_Pct, 0, config.Trailing_Activation_Pct, { allowMin: false });
  pushNumberIssue(issues, "Trend_Deviation_Points", config.Trend_Deviation_Points, 0, null, { allowMin: false });
  pushNumberIssue(issues, "Max_Margin_Usage_Pct", config.Max_Margin_Usage_Pct, 0, 100, { allowMin: false });

  if (config.Martin_Layers.length < 1 || config.Martin_Layers.length > 20) issues.push({ path: "Martin_Layers", message: "階梯馬丁層數必須介於 1 到 20 層之間" });
  config.Martin_Layers.forEach((layer, index) => {
    const path = `Martin_Layers.${index}`;
    if (!Number.isSafeInteger(layer.layer) || layer.layer !== index + 1) {
      issues.push({ path: `${path}.layer`, message: `層級必須連續且等於 ${index + 1}` });
    }
    pushNumberIssue(issues, `${path}.triggerSpacingPct`, layer.triggerSpacingPct, 0, 100, { allowMin: index === 0 });
    if (index === 0 && layer.triggerSpacingPct !== 0) issues.push({ path: `${path}.triggerSpacingPct`, message: "底倉觸發間距必須為 0" });
    if (index > 0 && layer.triggerSpacingPct <= 0) issues.push({ path: `${path}.triggerSpacingPct`, message: "加倉層觸發間距必須大於 0" });
    pushNumberIssue(issues, `${path}.lotMultiplier`, layer.lotMultiplier, 0, 10, { allowMin: false });
    pushNumberIssue(issues, `${path}.lotValue`, layer.lotValue, 0, null, { allowMin: false });
    if (index === 0 && !layer.enabled) issues.push({ path: `${path}.enabled`, message: "底倉第 1 層不可停用" });
  });
  // 驗證 Base_Lot_Size 與第一層的 lotValue 一致性
  const firstLayer = config.Martin_Layers[0];
  if (firstLayer) {
    const expectedFirstLayerLotValue = config.Base_Lot_Size.mode === "usdt"
      ? config.Base_Lot_Size.value
      : config.Base_Lot_Size.value * firstLayer.lotMultiplier; // 如果是 quantity 模式，則需要乘以 multiplier

    if (Math.abs(firstLayer.lotValue - expectedFirstLayerLotValue) > 1e-12) {
      issues.push({ path: "Base_Lot_Size.value", message: `必須與第 1 層明確手數（${expectedFirstLayerLotValue}）完全一致` });
    }
  }

  // 驗證後續層級的 lotValue 是否符合 Base_Lot_Size * layer 的規則 (僅限 USDT 模式)
  if (config.Base_Lot_Size.mode === "usdt") {
    config.Martin_Layers.forEach((layer, index) => {
      const expectedLotValue = config.Base_Lot_Size.value * (index + 1);
      if (Math.abs(layer.lotValue - expectedLotValue) > 1e-12) {
        issues.push({
          path: `Martin_Layers.${index}.lotValue`,
          message: `第 ${index + 1} 層的 USDT 金額必須為 Base_Lot_Size (${config.Base_Lot_Size.value}) 乘以層級編號 (${index + 1})，即 ${expectedLotValue}`,
        });
      }
    });
  }
  if (config.Live_Trading_Armed && !config.Require_Dedicated_Account) {
    issues.push({
      path: "Require_Dedicated_Account",
      message: "武裝實盤前必須啟用專用帳戶隔離，避免同交易對聚合持倉干擾其他策略",
    });
  }
  if (config.Live_Trading_Armed && !config.Kill_Close_Only_Owned_Position) {
    issues.push({
      path: "Kill_Close_Only_Owned_Position",
      message: "武裝實盤前必須限制 KILL 僅處置可由本地成交狀態證明擁有的持倉",
    });
  }
  return { valid: issues.length === 0, config, issues };
}

export function assertValidRainbowTrendLadderConfig(raw: unknown): RainbowTrendLadderConfig {
  const result = validateRainbowTrendLadderConfig(raw);
  if (!result.valid) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"));
  return result.config;
}

export function getRainbowTrendLadderCumulativeTriggerPct(
  layers: readonly RainbowTrendLadderLayerConfig[],
  targetLayer: number,
): number {
  return layers
    .filter((layer) => layer.layer >= 2 && layer.layer <= targetLayer)
    .reduce((sum, layer) => sum + layer.triggerSpacingPct, 0);
}

export function getRainbowTrendLadderNextEnabledLayer(
  layers: readonly RainbowTrendLadderLayerConfig[],
  currentLayer: number,
): RainbowTrendLadderLayerConfig | undefined {
  return layers.find((layer) => layer.enabled && layer.layer > currentLayer);
}

export function deriveRainbowTrendLadderFinalEnabledLayer(
  layers: readonly RainbowTrendLadderLayerConfig[],
): number {
  return Math.max(1, ...layers.filter((layer) => layer.enabled).map((layer) => layer.layer));
}

export function formatRainbowTrendLadderTimeframe(minutes: number): string {
  if (minutes % 1440 === 0) return `D${minutes / 1440}`;
  if (minutes % 60 === 0) return `H${minutes / 60}`;
  return `M${minutes}`;
}
