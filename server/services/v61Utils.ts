import { getLatestADX, getLatestATR, KLineInput } from "./indicators";
import { V61Config, V61_REGIME_PARAMS } from "../strategies/v61/strategy_kama_3k_v61";

/**
 * 取得當前市場制度
 */
export function getRegime(candles: KLineInput[], cfg: V61Config): string {
  const adxResult = getLatestADX(candles, cfg.adx_period);
  const atrVal = getLatestATR(candles, 14);
  
  if (!adxResult || !atrVal) return 'ranging';
  
  const adxVal = adxResult?.adx ?? 0;
  const atrMa = calculateATRMA(candles, 50);
  
  if (adxVal > cfg.adx_strong_threshold && (atrVal ?? 0) > atrMa * cfg.atr_ratio_threshold) {
    return 'strong_trend';
  } else if (adxVal > cfg.adx_trend_threshold) {
    return 'weak_trend';
  }
  return 'ranging';
}

/**
 * 計算 ATR 移動平均
 */
export function calculateATRMA(candles: KLineInput[], period: number): number {
  if (candles.length < period + 14) return 0;
  const atrValues: number[] = [];
  for (let i = 14; i <= candles.length; i++) {
    const slice = candles.slice(0, i);
    const atr = getLatestATR(slice, 14);
    if (atr) atrValues.push(atr);
  }
  if (atrValues.length < period) return atrValues[atrValues.length - 1] || 0;
  const recent = atrValues.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}
