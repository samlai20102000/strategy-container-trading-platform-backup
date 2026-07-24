/**
 * KAMA 計算模組 - V3.5 版本
 * Kaufman's Adaptive Moving Average
 * 依據 Pasted_content_17.txt 第 B.1.3 節實作
 * 
 * KAMA 公式：
 * ER (Efficiency Ratio) = |change| / volatility
 * SSC (Smoothing Constant) = [2/(fastest+1) - 2/(slowest+1)]^2
 * KAMA = KAMA_prev + SSC × ER × (price - KAMA_prev)
 */

export interface KAMAConfig {
  fastLength: number;      // p2_fastest (預設 10)
  slowLength: number;      // p3_slowest (預設 2)
  kamaLength: number;      // KAMA_Fast_Length 或 KAMA_Slow_Length (預設 50)
}

export class KAMACalculator {
  private prices: number[] = [];
  private kamaValues: number[] = [];
  private config: KAMAConfig;

  constructor(config: KAMAConfig) {
    this.config = config;
  }

  /**
   * 添加新價格並計算 KAMA
   */
  addPrice(price: number): number {
    this.prices.push(price);

    if (this.prices.length < this.config.kamaLength + 1) {
      // 數據不足，返回簡單移動平均
      const sma = this.prices.reduce((a, b) => a + b, 0) / this.prices.length;
      this.kamaValues.push(sma);
      return sma;
    }

    const kama = this.calculateKAMA();
    this.kamaValues.push(kama);
    return kama;
  }

  /**
   * 計算單個 KAMA 值
   */
  private calculateKAMA(): number {
    const n = this.prices.length;
    const kamaLength = this.config.kamaLength;

    // 計算 Change（價格變化）
    const change = Math.abs(this.prices[n - 1] - this.prices[n - 1 - kamaLength]);

    // 計算 Volatility（波動率）
    let volatility = 0;
    for (let i = n - kamaLength; i < n; i++) {
      volatility += Math.abs(this.prices[i] - this.prices[i - 1]);
    }

    // 計算 Efficiency Ratio
    const er = volatility !== 0 ? change / volatility : 0;

    // 計算 Smoothing Constant
    const fastest = 2 / (this.config.fastLength + 1);
    const slowest = 2 / (this.config.slowLength + 1);
    const ssc = Math.pow(er * (fastest - slowest) + slowest, 2);

    // 計算 KAMA
    const prevKAMA = this.kamaValues[n - 2] || this.prices[0];
    const kama = prevKAMA + ssc * (this.prices[n - 1] - prevKAMA);

    return kama;
  }

  /**
   * 獲取最新 KAMA 值
   */
  getLatestKAMA(): number {
    if (this.kamaValues.length === 0) return 0;
    return this.kamaValues[this.kamaValues.length - 1];
  }

  /**
   * 獲取歷史 KAMA 值
   */
  getKAMAHistory(count: number = 50): number[] {
    return this.kamaValues.slice(-count);
  }

  /**
   * 清空數據
   */
  reset(): void {
    this.prices = [];
    this.kamaValues = [];
  }

  /**
   * 批量計算 KAMA
   */
  static calculateBatch(prices: number[], config: KAMAConfig): number[] {
    const calculator = new KAMACalculator(config);
    const results: number[] = [];

    for (const price of prices) {
      results.push(calculator.addPrice(price));
    }

    return results;
  }
}

/**
 * 3K 破位驗證模組
 * 依據 Pasted_content_17.txt 第 B.1.4 節實作
 */
export interface KBreakoutData {
  k1High: number;
  k1Low: number;
  k2High: number;
  k2Low: number;
  k1Bull: boolean;  // K1 是否為陽線
  k2Bull: boolean;  // K2 是否為陽線
  k1Bear: boolean;  // K1 是否為陰線
  k2Bear: boolean;  // K2 是否為陰線
}

export class BreakoutValidator {
  /**
   * 驗證 BUY 破位（價格突破 K1/K2 最高點）
   */
  static validateBuyBreakout(price: number, data: KBreakoutData): boolean {
    const maxHigh = Math.max(data.k1High, data.k2High);
    return price > maxHigh && data.k1Bull && data.k2Bull;
  }

  /**
   * 驗證 SELL 破位（價格跌破 K1/K2 最低點）
   */
  static validateSellBreakout(price: number, data: KBreakoutData): boolean {
    const minLow = Math.min(data.k1Low, data.k2Low);
    return price < minLow && data.k1Bear && data.k2Bear;
  }

  /**
   * 判斷 K 線方向
   */
  static isKlineBull(open: number, close: number): boolean {
    return close > open;
  }

  static isKlineBear(open: number, close: number): boolean {
    return close < open;
  }
}
