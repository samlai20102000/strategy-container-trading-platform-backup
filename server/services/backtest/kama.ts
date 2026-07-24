/**
 * KAMA（Kaufman Adaptive Moving Average）完整計算模組
 *
 * 與實盤 V3.5 策略（20415_KAMA_MARTIN_V35）的 KAMA 定義完全一致：
 *   ER = |close - close[length]| / Σ|close[i] - close[i-1]|
 *   SC = (ER × (2/(fastest+1) - 2/(slowest+1)) + 2/(slowest+1))²
 *   KAMA = KAMA[1] + SC × (close - KAMA[1])
 *
 * 對應 TradingView Pine 腳本參數：
 *   快線：KAMA_Fast_Length=50, p2_fastest=10, p3_slowest=2
 *   慢線：KAMA_Slow_Length=50, q2_fastest=10, q3_slowest=6
 */

/** 計算完整 KAMA 序列（遞迴，索引與 closes 對齊；前 length 根為 null） */
export function calculateKAMASeries(
  closes: number[],
  length: number,
  fastest: number,
  slowest: number,
): Array<number | null> {
  const result: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length <= length) return result;

  const fastSC = 2 / (fastest + 1);
  const slowSC = 2 / (slowest + 1);

  // 初始值：以第 length 根的收盤價作為 KAMA 起點（Pine ta.kama 慣例）
  let kama = closes[length];
  result[length] = kama;

  for (let i = length + 1; i < closes.length; i++) {
    const change = Math.abs(closes[i] - closes[i - length]);
    let volatility = 0;
    for (let j = i - length + 1; j <= i; j++) {
      volatility += Math.abs(closes[j] - closes[j - 1]);
    }
    const er = volatility > 0 ? change / volatility : 0;
    const sc = Math.pow(er * (fastSC - slowSC) + slowSC, 2);
    kama = kama + sc * (closes[i] - kama);
    result[i] = kama;
  }

  return result;
}

/** 計算 KAMA 序列的最後一個值（便利函數） */
export function calculateKAMA(
  closes: number[],
  length: number,
  fastest: number,
  slowest: number,
): number | null {
  const series = calculateKAMASeries(closes, length, fastest, slowest);
  return series[series.length - 1];
}
