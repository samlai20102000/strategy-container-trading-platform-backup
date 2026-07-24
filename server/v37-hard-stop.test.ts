/**
 * V3.7（Pasted_content_23）硬止損 Max_Loss_Pct 單元測試
 *
 * 驗收標準：
 * 1. RiskManager.checkHardStopLoss：浮虧 % ≥ Max_Loss_Pct → 觸發
 * 2. 多單/空單雙向正確
 * 3. Max_Loss_Pct = 0 → 不啟用（跳過）
 * 4. 浮虧未達閾值 → 不觸發
 * 5. V3.7 預設值驗證（策略 defaultConfig）
 */
import { describe, expect, it } from "vitest";
import { RiskManager } from "./services/riskManager";
import { strategyKama3kV35 } from "./strategies/v35/strategy_kama_3k_v35";

describe("V3.7 硬止損 Max_Loss_Pct：RiskManager.checkHardStopLoss", () => {
  const makeRm = (maxLossPct: number) =>
    new RiskManager({
      initialCapital: 1000,
      maxDrawdownPct: 10,
      lastLayerDeviationPct: 3,
      maxLossUsdt: 0,
      maxLossPct,
    });

  it("多單浮虧達 6% → 觸發硬止損", () => {
    const rm = makeRm(6);
    const result = rm.checkHardStopLoss({
      isLong: true,
      avgPrice: 50000,
      currentPrice: 46900, // (50000-46900)/50000 = 6.2%
      totalSize: 0.1,
      lastLayerPrice: 46900,
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("硬止損");
    // 估算虧損 = 6.2% × 總成本 5000 = 310 USDT
    expect(result.estimatedLoss).toBeCloseTo(310, 0);
  });

  it("多單浮虧未達 6% → 不觸發", () => {
    const rm = makeRm(6);
    const result = rm.checkHardStopLoss({
      isLong: true,
      avgPrice: 50000,
      currentPrice: 47500, // (50000-47500)/50000 = 5%
      totalSize: 0.1,
      lastLayerPrice: 47500,
    });
    expect(result.triggered).toBe(false);
  });

  it("空單浮虧達 6% → 觸發硬止損", () => {
    const rm = makeRm(6);
    const result = rm.checkHardStopLoss({
      isLong: false,
      avgPrice: 50000,
      currentPrice: 53100, // (53100-50000)/50000 = 6.2%
      totalSize: 0.1,
      lastLayerPrice: 53100,
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("硬止損");
  });

  it("空單浮虧未達 → 不觸發", () => {
    const rm = makeRm(6);
    const result = rm.checkHardStopLoss({
      isLong: false,
      avgPrice: 50000,
      currentPrice: 52000, // 4%
      totalSize: 0.1,
      lastLayerPrice: 52000,
    });
    expect(result.triggered).toBe(false);
  });

  it("Max_Loss_Pct = 0 → 功能停用", () => {
    const rm = makeRm(0);
    const result = rm.checkHardStopLoss({
      isLong: true,
      avgPrice: 50000,
      currentPrice: 40000, // 20% loss
      totalSize: 0.1,
      lastLayerPrice: 40000,
    });
    expect(result.triggered).toBe(false);
    expect(result.reason).toContain("未啟用");
  });

  it("多單盈利時 → 不觸發", () => {
    const rm = makeRm(6);
    const result = rm.checkHardStopLoss({
      isLong: true,
      avgPrice: 50000,
      currentPrice: 55000, // profit
      totalSize: 0.1,
      lastLayerPrice: 55000,
    });
    expect(result.triggered).toBe(false);
  });
});

describe("V3.7 策略預設值驗證", () => {
  const cfg = strategyKama3kV35.defaultConfig;

  it("B2 預設 Max_Loss_Pct = 5.0", () => {
    expect(cfg.Max_Loss_Pct).toBe(5.0);
  });

  it("V4.0 預設 Callback_Pct = 0.1", () => {
    expect(cfg.Callback_Pct).toBe(0.1);
  });

  it("V3.7 預設 K_Line_Period = 15", () => {
    expect(cfg.K_Line_Period).toBe(15);
  });

  it("V4.0 預設 Target_TP_Pct = 1.0", () => {
    expect(cfg.Target_TP_Pct).toBe(1.0);
  });

  it("V4.0 預設 Martin_Step_Pct = 2.0", () => {
    expect(cfg.Martin_Step_Pct).toBe(2.0);
  });

  it("V3.7 已移除 Kama_Reversal_Min_Layer", () => {
    expect((cfg as any).Kama_Reversal_Min_Layer).toBeUndefined();
  });

  it("V4.0 Martin_Layers 分層 1.5/1.1/1.0（固定金本位階梯式）", () => {
    const layers = JSON.parse(cfg.Martin_Layers as string);
    expect(layers).toHaveLength(3);
    expect(layers[0].multiplier).toBe(1.5);
    expect(layers[0].start).toBe(1);
    expect(layers[0].end).toBe(4);
    expect(layers[1].multiplier).toBe(1.1);
    expect(layers[1].start).toBe(5);
    expect(layers[1].end).toBe(9);
    expect(layers[2].multiplier).toBe(1.0);
    expect(layers[2].start).toBe(10);
    expect(layers[2].end).toBe(11);
  });
});
