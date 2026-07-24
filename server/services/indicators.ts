/**
 * 技術指標計算模組（V5.0 策略共用）
 * - ADX (Average Directional Index)
 * - ATR (Average True Range)
 * - KAMA 斜率
 * - 成交量放大判斷
 */

export interface KLineInput {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp?: number;
}

// ============================================================
// ATR (Average True Range)
// ============================================================

/**
 * 計算 True Range 序列
 */
export function calculateTR(candles: KLineInput[]): number[] {
  const tr: number[] = [candles[0].high - candles[0].low]; // 第一根用 H-L
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return tr;
}

/**
 * 計算 ATR 序列（Wilder's Smoothing）
 * 返回長度 = candles.length 的數組，前 period-1 個為 null
 */
export function calculateATR(candles: KLineInput[], period: number = 14): (number | null)[] {
  const tr = calculateTR(candles);
  const atr: (number | null)[] = new Array(candles.length).fill(null);

  if (tr.length < period) return atr;

  // 第一個 ATR = 前 period 根 TR 的簡單平均
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;

  // 後續用 Wilder's Smoothing
  for (let i = period; i < tr.length; i++) {
    atr[i] = ((atr[i - 1] as number) * (period - 1) + tr[i]) / period;
  }
  return atr;
}

/**
 * 計算最新一根的 ATR 值（便捷方法）
 */
export function getLatestATR(candles: KLineInput[], period: number = 14): number | null {
  const atrSeries = calculateATR(candles, period);
  for (let i = atrSeries.length - 1; i >= 0; i--) {
    if (atrSeries[i] !== null) return atrSeries[i];
  }
  return null;
}

// ============================================================
// ADX (Average Directional Index)
// ============================================================

/**
 * 計算 ADX 序列
 * 返回 { adx, plusDI, minusDI } 各為長度 = candles.length 的數組
 */
export function calculateADX(candles: KLineInput[], period: number = 14): {
  adx: (number | null)[];
  plusDI: (number | null)[];
  minusDI: (number | null)[];
} {
  const len = candles.length;
  const adx: (number | null)[] = new Array(len).fill(null);
  const plusDI: (number | null)[] = new Array(len).fill(null);
  const minusDI: (number | null)[] = new Array(len).fill(null);

  if (len < period * 2) return { adx, plusDI, minusDI };

  // 1. 計算 +DM, -DM, TR
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr: number[] = [candles[0].high - candles[0].low];

  for (let i = 1; i < len; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  // 2. Wilder's Smoothing for +DM14, -DM14, TR14
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;
  let smoothTR = 0;

  for (let i = 0; i < period; i++) {
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
    smoothTR += tr[i];
  }

  // 3. 計算 +DI14, -DI14, DX
  const dx: number[] = [];

  for (let i = period - 1; i < len; i++) {
    if (i > period - 1) {
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
      smoothTR = smoothTR - smoothTR / period + tr[i];
    }

    const pdi = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const mdi = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    plusDI[i] = pdi;
    minusDI[i] = mdi;

    const diSum = pdi + mdi;
    const dxVal = diSum > 0 ? (Math.abs(pdi - mdi) / diSum) * 100 : 0;
    dx.push(dxVal);
  }

  // 4. ADX = DX 的 Wilder's Smoothing
  if (dx.length >= period) {
    let adxSum = 0;
    for (let i = 0; i < period; i++) adxSum += dx[i];
    const firstAdxIdx = period - 1 + period - 1; // 在 candles 中的索引
    adx[firstAdxIdx] = adxSum / period;

    for (let i = period; i < dx.length; i++) {
      const candleIdx = i + period - 1;
      adx[candleIdx] = ((adx[candleIdx - 1] as number) * (period - 1) + dx[i]) / period;
    }
  }

  return { adx, plusDI, minusDI };
}

/**
 * 獲取最新 ADX 值
 */
export function getLatestADX(candles: KLineInput[], period: number = 14): {
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
} {
  const result = calculateADX(candles, period);
  let adxVal: number | null = null;
  let pdiVal: number | null = null;
  let mdiVal: number | null = null;
  for (let i = result.adx.length - 1; i >= 0; i--) {
    if (result.adx[i] !== null) {
      adxVal = result.adx[i];
      pdiVal = result.plusDI[i];
      mdiVal = result.minusDI[i];
      break;
    }
  }
  return { adx: adxVal, plusDI: pdiVal, minusDI: mdiVal };
}

// ============================================================
// 市場制度判斷 (Market Regime)
// ============================================================

export type MarketRegime = "strong_trend" | "weak_trend" | "ranging";

export interface RegimeConfig {
  adx_strong_threshold: number;  // ADX ≥ 此值 = 強趨勢（預設 30）
  adx_weak_threshold: number;    // ADX ≥ 此值 = 弱趨勢（預設 20）
  // ADX < weak_threshold = 震盪
}

/**
 * 根據 ADX 判斷市場制度
 */
export function determineMarketRegime(
  adxValue: number | null,
  config: RegimeConfig = { adx_strong_threshold: 30, adx_weak_threshold: 20 },
): MarketRegime {
  if (adxValue === null) return "weak_trend"; // 數據不足時預設弱趨勢
  if (adxValue >= config.adx_strong_threshold) return "strong_trend";
  if (adxValue >= config.adx_weak_threshold) return "weak_trend";
  return "ranging";
}

// ============================================================
// 市場制度對應的馬丁參數覆蓋
// ============================================================

export interface RegimeMartinOverride {
  steps: { start: number; end: number; stepPct: number }[];
  layers: { start: number; end: number; multiplier: number }[];
  maxLayers: number;
  hardStopPct: number;
}

/**
 * 根據市場制度返回對應的馬丁參數覆蓋
 */
export function getRegimeMartinParams(regime: MarketRegime): RegimeMartinOverride {
  switch (regime) {
    case "strong_trend":
      return {
        steps: [
          { start: 1, end: 3, stepPct: 2.0 },
          { start: 4, end: 6, stepPct: 3.0 },
          { start: 7, end: 9, stepPct: 4.0 },
          { start: 10, end: 13, stepPct: 5.0 },
        ],
        layers: [
          { start: 1, end: 4, multiplier: 1.5 },
          { start: 5, end: 9, multiplier: 1.2 },
          { start: 10, end: 13, multiplier: 1.0 },
        ],
        maxLayers: 13,
        hardStopPct: 8.0,
      };
    case "weak_trend":
      return {
        steps: [
          { start: 1, end: 3, stepPct: 1.5 },
          { start: 4, end: 6, stepPct: 2.5 },
          { start: 7, end: 9, stepPct: 3.0 },
          { start: 10, end: 13, stepPct: 4.0 },
        ],
        layers: [
          { start: 1, end: 4, multiplier: 1.6 },
          { start: 5, end: 9, multiplier: 1.3 },
          { start: 10, end: 13, multiplier: 1.0 },
        ],
        maxLayers: 11,
        hardStopPct: 6.5,
      };
    case "ranging":
      return {
        steps: [
          { start: 1, end: 3, stepPct: 1.0 },
          { start: 4, end: 6, stepPct: 2.0 },
          { start: 7, end: 9, stepPct: 3.0 },
          { start: 10, end: 13, stepPct: 4.0 },
        ],
        layers: [
          { start: 1, end: 4, multiplier: 1.8 },
          { start: 5, end: 9, multiplier: 1.2 },
          { start: 10, end: 13, multiplier: 1.0 },
        ],
        maxLayers: 9,
        hardStopPct: 5.0,
      };
  }
}

/**
 * 根據制度覆蓋獲取指定層的間距百分比
 */
export function getRegimeStepPct(layer: number, override: RegimeMartinOverride): number {
  for (const s of override.steps) {
    if (layer >= s.start && layer <= s.end) return s.stepPct;
  }
  return override.steps[override.steps.length - 1]?.stepPct ?? 2.0;
}

/**
 * 根據制度覆蓋獲取指定層的乘數
 */
export function getRegimeMultiplier(layer: number, override: RegimeMartinOverride): number {
  for (const l of override.layers) {
    if (layer >= l.start && layer <= l.end) return l.multiplier;
  }
  return 1.0;
}

// ============================================================
// F3：ATR 動態止盈
// ============================================================

export interface DynamicTPConfig {
  tp_min_pct: number;         // 最低止盈百分比（預設 0.8）
  tp_atr_multiplier: number;  // ATR 乘數（預設 2.5）
}

/**
 * 計算 ATR 動態止盈百分比
 * TP_Pct = MAX(tp_min_pct, ATR/price × tp_atr_multiplier × 100)
 */
export function calculateDynamicTP(
  atrValue: number | null,
  currentPrice: number,
  config: DynamicTPConfig = { tp_min_pct: 0.8, tp_atr_multiplier: 2.5 },
): number {
  if (atrValue === null || currentPrice <= 0) return config.tp_min_pct;
  const atrPct = (atrValue / currentPrice) * config.tp_atr_multiplier * 100;
  return Math.max(config.tp_min_pct, atrPct);
}

// ============================================================
// F5：波動率倉位調整
// ============================================================

export interface VolPositionConfig {
  target_vol_pct: number;  // 目標波動率百分比（預設 1.5）
  vol_min_scale: number;   // 最小縮放（預設 0.5）
  vol_max_scale: number;   // 最大縮放（預設 2.0）
}

/**
 * 計算波動率調整後的倉位比例
 * scale = target_vol / current_ATR_pct，限制在 [min, max]
 */
export function calculateVolatilityScale(
  atrValue: number | null,
  currentPrice: number,
  config: VolPositionConfig = { target_vol_pct: 1.5, vol_min_scale: 0.5, vol_max_scale: 2.0 },
): number {
  if (atrValue === null || currentPrice <= 0) return 1.0;
  const currentVolPct = (atrValue / currentPrice) * 100;
  if (currentVolPct <= 0) return 1.0;
  const scale = config.target_vol_pct / currentVolPct;
  return Math.max(config.vol_min_scale, Math.min(config.vol_max_scale, scale));
}

// ============================================================
// F4：時間濾網
// ============================================================

export interface TimeFilterConfig {
  enable_time_filter: boolean;  // 是否啟用（預設 true）
  allowed_start_hour: number;   // 允許開倉起始 UTC 時（預設 12）
  allowed_end_hour: number;     // 允許開倉結束 UTC 時（預設 22）
}

/**
 * 判斷當前時間是否在允許交易時段內
 */
export function isWithinTradingHours(
  timestamp: number,
  config: TimeFilterConfig = { enable_time_filter: true, allowed_start_hour: 12, allowed_end_hour: 22 },
): boolean {
  if (!config.enable_time_filter) return true;
  const hour = new Date(timestamp).getUTCHours();
  if (config.allowed_start_hour <= config.allowed_end_hour) {
    return hour >= config.allowed_start_hour && hour < config.allowed_end_hour;
  }
  // 跨日（如 22-6）
  return hour >= config.allowed_start_hour || hour < config.allowed_end_hour;
}

// ============================================================
// F6：AI 輔助過濾（KAMA 斜率 + 成交量放大）
// ============================================================

/**
 * 計算 KAMA 斜率（最近 N 根的變化率）
 */
export function calculateKAMASlope(kamaSeries: (number | null)[], idx: number, lookback: number = 5): number {
  if (idx < lookback) return 0;
  const current = kamaSeries[idx];
  const prev = kamaSeries[idx - lookback];
  if (current === null || prev === null || prev === 0) return 0;
  return ((current - prev) / prev) * 100; // 百分比變化
}

/**
 * 判斷成交量是否放大（相對於 MA）
 */
export function isVolumeExpansion(
  volumes: number[],
  idx: number,
  period: number = 20,
  threshold: number = 1.5,
): boolean {
  if (idx < period) return false;
  let sum = 0;
  for (let i = idx - period; i < idx; i++) sum += volumes[i];
  const avgVol = sum / period;
  return avgVol > 0 && volumes[idx] >= avgVol * threshold;
}

// ============================================================
// F2：部分獲利
// ============================================================

export interface PartialTakeConfig {
  enable_partial_tp: boolean;     // 是否啟用（預設 true）
  partial_tp_layer_4: number;     // 層數≥4 時平倉比例（預設 0.3 = 30%）
  partial_tp_layer_6: number;     // 層數≥6 時平倉比例（預設 0.3）
  partial_tp_layer_8: number;     // 層數≥8 時平倉比例（預設 0.2）
  partial_tp_trigger_pct: number; // 觸發部分獲利的盈利百分比（預設 0.5%）
}

/**
 * 計算部分獲利應平倉的比例
 * 返回 0 表示不觸發，>0 表示應平倉的比例
 */
export function calculatePartialTPRatio(
  currentLayer: number,
  unrealizedPnlPct: number,
  config: PartialTakeConfig,
  alreadyPartialClosed: number[] = [], // 已觸發過的層級
): number {
  if (!config.enable_partial_tp) return 0;
  if (unrealizedPnlPct < config.partial_tp_trigger_pct) return 0;

  if (currentLayer >= 8 && !alreadyPartialClosed.includes(8)) {
    return config.partial_tp_layer_8;
  }
  if (currentLayer >= 6 && !alreadyPartialClosed.includes(6)) {
    return config.partial_tp_layer_6;
  }
  if (currentLayer >= 4 && !alreadyPartialClosed.includes(4)) {
    return config.partial_tp_layer_4;
  }
  return 0;
}
