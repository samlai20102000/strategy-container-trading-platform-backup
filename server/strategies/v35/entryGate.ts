import { calculateKAMA } from "../../services/backtest/kama";

export const V40_STRATEGY_KEY = "20415_KAMA_MARTIN_V35" as const;

export type V40ThreeKPatternMode = "breakout" | "three_body_same_direction";
export type V40EntryDirection = "long" | "short";

export interface V40EntryGateConfig {
  enableThreeKFilter: boolean;
  threeKPatternMode: V40ThreeKPatternMode;
  enableKamaDirectionLock: boolean;
  enableSameDirectionReentry: boolean;
}

export interface V40EntryCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp?: number;
}

export interface V40EntryEvaluationInput {
  candles: V40EntryCandle[];
  rawConfig?: Record<string, unknown> | null;
  currentPrice?: number;
  slowKama?: number | null;
  requestedDirection?: V40EntryDirection;
  allowedDirection?: "long" | "short" | "both";
}

export interface V40EntryEvaluationResult {
  passed: boolean;
  direction: V40EntryDirection | null;
  reason: string;
  config: V40EntryGateConfig;
  evidence: {
    threeKDirection: V40EntryDirection | null;
    threeKRule: "disabled" | V40ThreeKPatternMode;
    currentPrice: number | null;
    slowKama: number | null;
  };
}

export const DEFAULT_V40_ENTRY_GATE_CONFIG: Readonly<V40EntryGateConfig> = Object.freeze({
  enableThreeKFilter: true,
  threeKPatternMode: "breakout",
  enableKamaDirectionLock: true,
  enableSameDirectionReentry: true,
});

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "on", "enabled", "enable"].includes(normalized)) return true;
    if (["0", "false", "off", "disabled", "disable"].includes(normalized)) return false;
  }
  return fallback;
}

export function normalizeV40EntryGateConfig(
  rawConfig?: Record<string, unknown> | null,
): V40EntryGateConfig {
  const rawMode = rawConfig?.threeKPatternMode;
  const threeKPatternMode: V40ThreeKPatternMode = rawMode === "three_body_same_direction"
    ? "three_body_same_direction"
    : "breakout";

  return {
    enableThreeKFilter: normalizeBoolean(
      rawConfig?.enableThreeKFilter,
      DEFAULT_V40_ENTRY_GATE_CONFIG.enableThreeKFilter,
    ),
    threeKPatternMode,
    enableKamaDirectionLock: normalizeBoolean(
      rawConfig?.enableKamaDirectionLock,
      DEFAULT_V40_ENTRY_GATE_CONFIG.enableKamaDirectionLock,
    ),
    enableSameDirectionReentry: normalizeBoolean(
      rawConfig?.enableSameDirectionReentry,
      DEFAULT_V40_ENTRY_GATE_CONFIG.enableSameDirectionReentry,
    ),
  };
}

function resolveThreeKDirection(
  candles: V40EntryCandle[],
  mode: V40ThreeKPatternMode,
): V40EntryDirection | null {
  if (candles.length < 3) return null;
  const [k1, k2, k3] = candles.slice(-3);

  if (mode === "three_body_same_direction") {
    if (k1.close > k1.open && k2.close > k2.open && k3.close > k3.open) return "long";
    if (k1.close < k1.open && k2.close < k2.open && k3.close < k3.open) return "short";
    return null;
  }

  const longBreakout = k1.close > k1.open
    && k2.close > k2.open
    && k3.close >= Math.max(k1.high, k2.high);
  const shortBreakout = k1.close < k1.open
    && k2.close < k2.open
    && k3.close <= Math.min(k1.low, k2.low);
  if (longBreakout) return "long";
  if (shortBreakout) return "short";
  return null;
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function calculateV40SlowKama(
  candles: V40EntryCandle[],
  rawConfig?: Record<string, unknown> | null,
): number | null {
  const length = finitePositive(rawConfig?.KAMA_Slow_Length) ?? 50;
  const fastest = finitePositive(rawConfig?.q2_fastest) ?? 10;
  const slowest = finitePositive(rawConfig?.q3_slowest) ?? 6;
  return calculateKAMA(
    candles.map((candle) => candle.close),
    Math.trunc(length),
    fastest,
    slowest,
  );
}

function hold(
  reason: string,
  config: V40EntryGateConfig,
  threeKDirection: V40EntryDirection | null,
  currentPrice: number | null,
  slowKama: number | null,
): V40EntryEvaluationResult {
  return {
    passed: false,
    direction: null,
    reason,
    config,
    evidence: {
      threeKDirection,
      threeKRule: config.enableThreeKFilter ? config.threeKPatternMode : "disabled",
      currentPrice,
      slowKama,
    },
  };
}

export function evaluateV40EntryGates(
  input: V40EntryEvaluationInput,
): V40EntryEvaluationResult {
  const config = normalizeV40EntryGateConfig(input.rawConfig);
  const currentPrice = finitePositive(
    input.currentPrice ?? input.candles.at(-1)?.close,
  );
  const slowKama = input.slowKama === undefined
    ? calculateV40SlowKama(input.candles, input.rawConfig)
    : finitePositive(input.slowKama);
  const threeKDirection = config.enableThreeKFilter
    ? resolveThreeKDirection(input.candles, config.threeKPatternMode)
    : null;

  if (config.enableThreeKFilter && input.candles.length < 3) {
    return hold("三 K 入場條件已啟用，但已收盤 K 線不足三根", config, null, currentPrice, slowKama);
  }
  if (config.enableThreeKFilter && !threeKDirection) {
    const label = config.threeKPatternMode === "breakout"
      ? "前兩根同向＋第三根收盤破位"
      : "三根 K 線實體全部連續同向";
    return hold(`三 K 條件未通過：${label}`, config, null, currentPrice, slowKama);
  }

  let direction = input.requestedDirection ?? threeKDirection;
  if (input.requestedDirection && threeKDirection && input.requestedDirection !== threeKDirection) {
    return hold(
      `外部方向為${input.requestedDirection === "long" ? "做多" : "做空"}，與三 K 判定方向不一致`,
      config,
      threeKDirection,
      currentPrice,
      slowKama,
    );
  }

  if (!direction && config.enableKamaDirectionLock) {
    if (currentPrice === null || slowKama === null) {
      return hold("KAMA 方向鎖已啟用，但價格或 slow KAMA 資料不足", config, threeKDirection, currentPrice, slowKama);
    }
    if (currentPrice > slowKama) direction = "long";
    else if (currentPrice < slowKama) direction = "short";
    else return hold("價格等於 slow KAMA，方向不明確", config, threeKDirection, currentPrice, slowKama);
  }

  if (!direction) {
    return hold(
      "三 K 與 KAMA 入場條件皆停用，自動／回測無法安全推導方向",
      config,
      threeKDirection,
      currentPrice,
      slowKama,
    );
  }

  if (config.enableKamaDirectionLock) {
    if (currentPrice === null || slowKama === null) {
      return hold("KAMA 方向鎖已啟用，但價格或 slow KAMA 資料不足", config, threeKDirection, currentPrice, slowKama);
    }
    const kamaPass = direction === "long" ? currentPrice > slowKama : currentPrice < slowKama;
    if (!kamaPass) {
      return hold(
        `KAMA 方向鎖未通過：${direction === "long" ? "做多需 price > slow KAMA" : "做空需 price < slow KAMA"}`,
        config,
        threeKDirection,
        currentPrice,
        slowKama,
      );
    }
  }

  const allowedDirection = input.allowedDirection ?? "both";
  if (allowedDirection !== "both" && allowedDirection !== direction) {
    return hold(
      `策略方向限制為${allowedDirection === "long" ? "只做多" : "只做空"}，拒絕本次${direction === "long" ? "做多" : "做空"}入場`,
      config,
      threeKDirection,
      currentPrice,
      slowKama,
    );
  }

  const activeRules = [
    config.enableThreeKFilter
      ? `三 K：${config.threeKPatternMode === "breakout" ? "前二同向＋第三破位" : "三根實體同向"}`
      : null,
    config.enableKamaDirectionLock ? "price／slow KAMA 方向鎖" : null,
  ].filter(Boolean).join("；");

  return {
    passed: true,
    direction,
    reason: `${direction === "long" ? "做多" : "做空"}入場條件通過${activeRules ? `（${activeRules}）` : ""}`,
    config,
    evidence: {
      threeKDirection,
      threeKRule: config.enableThreeKFilter ? config.threeKPatternMode : "disabled",
      currentPrice,
      slowKama,
    },
  };
}
