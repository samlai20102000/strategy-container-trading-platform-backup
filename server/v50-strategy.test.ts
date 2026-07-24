import { describe, it, expect } from "vitest";
import {
  getLatestATR,
  getLatestADX,
  determineMarketRegime,
  calculateDynamicTP,
  calculateVolatilityScale,
  isWithinTradingHours,
  calculatePartialTPRatio,
  type PartialTakeConfig,
} from "../server/services/indicators";

describe("V5.0 指標計算模組", () => {
  // 生成模擬 K 線數據
  function generateCandles(count: number, basePrice = 50000, volatility = 0.01) {
    const candles = [];
    let price = basePrice;
    for (let i = 0; i < count; i++) {
      const change = (Math.random() - 0.5) * 2 * volatility * price;
      const open = price;
      const close = price + change;
      const high = Math.max(open, close) + Math.random() * volatility * price * 0.5;
      const low = Math.min(open, close) - Math.random() * volatility * price * 0.5;
      candles.push({ open, high, low, close, volume: 100 + Math.random() * 200 });
      price = close;
    }
    return candles;
  }

  describe("getLatestADX", () => {
    it("應返回有效的 ADX 值（0-100 之間）", () => {
      const candles = generateCandles(40);
      const result = getLatestADX(candles, 14);
      expect(result.adx).toBeGreaterThanOrEqual(0);
      expect(result.adx).toBeLessThanOrEqual(100);
    });

    it("數據不足時應返回 null", () => {
      const candles = generateCandles(5);
      const result = getLatestADX(candles, 14);
      expect(result.adx).toBeNull();
    });
  });

  describe("getLatestATR", () => {
    it("應返回正數 ATR 值", () => {
      const candles = generateCandles(20);
      const atr = getLatestATR(candles, 14);
      expect(atr).not.toBeNull();
      expect(atr!).toBeGreaterThan(0);
    });

    it("數據不足時應返回 null", () => {
      const candles = generateCandles(3);
      const atr = getLatestATR(candles, 14);
      expect(atr).toBeNull();
    });
  });

  describe("determineMarketRegime", () => {
    it("ADX >= 30 應返回 strong_trend", () => {
      const regime = determineMarketRegime(35, { adx_strong_threshold: 30, adx_weak_threshold: 20 });
      expect(regime).toBe("strong_trend");
    });

    it("ADX < 20 應返回 ranging", () => {
      const regime = determineMarketRegime(15, { adx_strong_threshold: 30, adx_weak_threshold: 20 });
      expect(regime).toBe("ranging");
    });

    it("ADX 在 20-30 之間應返回 weak_trend", () => {
      const regime = determineMarketRegime(25, { adx_strong_threshold: 30, adx_weak_threshold: 20 });
      expect(regime).toBe("weak_trend");
    });

    it("ADX 為 null 應返回 weak_trend", () => {
      const regime = determineMarketRegime(null);
      expect(regime).toBe("weak_trend");
    });
  });

  describe("calculateDynamicTP", () => {
    it("ATR 較大時應返回大於 tp_min 的值", () => {
      const tp = calculateDynamicTP(1000, 50000, { tp_min_pct: 0.8, tp_atr_multiplier: 2.5 });
      // ATR/price = 1000/50000 = 2%, * 2.5 = 5% → 遠大於 tp_min 0.8%
      expect(tp).toBeGreaterThan(0.8);
    });

    it("ATR 很小時應返回 tp_min", () => {
      const tp = calculateDynamicTP(10, 50000, { tp_min_pct: 0.8, tp_atr_multiplier: 2.5 });
      // ATR/price = 10/50000 = 0.02%, * 2.5 = 0.05% → 小於 tp_min 0.8%
      expect(tp).toBe(0.8);
    });

    it("ATR 為 null 時應返回 tp_min", () => {
      const tp = calculateDynamicTP(null, 50000, { tp_min_pct: 0.8, tp_atr_multiplier: 2.5 });
      expect(tp).toBe(0.8);
    });
  });

  describe("calculateVolatilityScale", () => {
    it("低波動時應放大倉位（受 max_scale 限制）", () => {
      // ATR=50, price=50000 → volPct = 0.1%, target=1.5 → scale = 15, clamped to 2.0
      const scale = calculateVolatilityScale(50, 50000, { target_vol_pct: 1.5, vol_min_scale: 0.5, vol_max_scale: 2.0 });
      expect(scale).toBe(2.0);
    });

    it("高波動時應縮小倉位（受 min_scale 限制）", () => {
      // ATR=5000, price=50000 → volPct = 10%, target=1.5 → scale = 0.15, clamped to 0.5
      const scale = calculateVolatilityScale(5000, 50000, { target_vol_pct: 1.5, vol_min_scale: 0.5, vol_max_scale: 2.0 });
      expect(scale).toBe(0.5);
    });

    it("正常波動時應返回接近 1 的值", () => {
      // ATR=750, price=50000 → volPct = 1.5%, target=1.5 → scale = 1.0
      const scale = calculateVolatilityScale(750, 50000, { target_vol_pct: 1.5, vol_min_scale: 0.5, vol_max_scale: 2.0 });
      expect(scale).toBeCloseTo(1.0);
    });

    it("ATR 為 null 時應返回 1.0", () => {
      const scale = calculateVolatilityScale(null, 50000);
      expect(scale).toBe(1.0);
    });
  });

  describe("isWithinTradingHours", () => {
    it("在活躍時段內應返回 true", () => {
      // UTC 15:00 → 在 12-22 之間
      const ts = new Date("2024-01-01T15:00:00Z").getTime();
      expect(isWithinTradingHours(ts, { enable_time_filter: true, allowed_start_hour: 12, allowed_end_hour: 22 })).toBe(true);
    });

    it("在活躍時段外應返回 false", () => {
      // UTC 05:00 → 不在 12-22 之間
      const ts = new Date("2024-01-01T05:00:00Z").getTime();
      expect(isWithinTradingHours(ts, { enable_time_filter: true, allowed_start_hour: 12, allowed_end_hour: 22 })).toBe(false);
    });

    it("跨午夜時段（如 22-6）應正確處理", () => {
      const ts23 = new Date("2024-01-01T23:00:00Z").getTime();
      const ts03 = new Date("2024-01-01T03:00:00Z").getTime();
      const ts10 = new Date("2024-01-01T10:00:00Z").getTime();
      const config = { enable_time_filter: true, allowed_start_hour: 22, allowed_end_hour: 6 };
      expect(isWithinTradingHours(ts23, config)).toBe(true);
      expect(isWithinTradingHours(ts03, config)).toBe(true);
      expect(isWithinTradingHours(ts10, config)).toBe(false);
    });

    it("停用時間濾網應始終返回 true", () => {
      const ts = new Date("2024-01-01T05:00:00Z").getTime();
      expect(isWithinTradingHours(ts, { enable_time_filter: false, allowed_start_hour: 12, allowed_end_hour: 22 })).toBe(true);
    });
  });

  describe("calculatePartialTPRatio", () => {
    const config: PartialTakeConfig = {
      enable_partial_tp: true,
      partial_tp_layer_4: 0.3,
      partial_tp_layer_6: 0.3,
      partial_tp_layer_8: 0.2,
      partial_tp_trigger_pct: 0.5,
    };

    it("層數 < 4 應返回 0", () => {
      expect(calculatePartialTPRatio(3, 1.0, config)).toBe(0);
    });

    it("層數 = 4 且盈利足夠應返回第一檔比例", () => {
      expect(calculatePartialTPRatio(4, 1.0, config)).toBe(0.3);
    });

    it("層數 = 6 且盈利足夠應返回第二檔比例", () => {
      expect(calculatePartialTPRatio(6, 1.0, config)).toBe(0.3);
    });

    it("層數 >= 8 且盈利足夠應返回第三檔比例", () => {
      expect(calculatePartialTPRatio(8, 1.0, config)).toBe(0.2);
    });

    it("盈利不足時應返回 0", () => {
      expect(calculatePartialTPRatio(8, 0.1, config)).toBe(0);
    });

    it("停用部分獲利時應返回 0", () => {
      const disabledConfig = { ...config, enable_partial_tp: false };
      expect(calculatePartialTPRatio(8, 1.0, disabledConfig)).toBe(0);
    });
  });
});
