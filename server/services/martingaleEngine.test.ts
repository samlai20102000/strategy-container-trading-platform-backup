import { describe, it, expect } from "vitest";
import {
  getFirstOrderValue,
  getMaxLossAmount,
  getLayerValue,
  getLayerSize,
  getLayerMultipliers,
  shouldAddLayer,
  calculateUnrealizedLoss,
  calculateUnrealizedLossPct,
  shouldTriggerLimitStop,
  V4Config,
  parseMartinLayers,
  StrategyState,
} from "./martingaleEngine";

const mockConfig: V4Config = {
  Initial_Capital: 1000,
  First_Order_Pct: 0.5,
  Max_Loss_Pct: 6,
  Martin_Step_Pct: 1.5,
  Martin_Layers: [
    { start: 1, end: 3, multiplier: 1.5 },
    { start: 4, end: 5, multiplier: 2.0 },
  ],
  Max_Layers: 5,
  Target_TP_Pct: 1.0,
  Callback_Pct: 0.1,
  K_Line_Period: 15,
};

describe("MartingaleEngine V4.0 Core Functions", () => {
  it("should calculate first order value correctly", () => {
    expect(getFirstOrderValue(mockConfig)).toBe(5); // 1000 * 0.5 / 100
  });

  it("should calculate max loss amount correctly", () => {
    expect(getMaxLossAmount(mockConfig)).toBe(60); // 1000 * 6 / 100
  });

  it("should calculate layer value correctly for layer 1", () => {
    expect(getLayerValue(1, mockConfig)).toBe(7.5); // First order value * multiplier for layer 1 (1.5)
  });

  it("should calculate layer value correctly for layer 2", () => {
    // Layer 1 value * multiplier for layer 2 (1.5)
    expect(getLayerValue(2, mockConfig)).toBe(11.25); // 11.25
  });

  it("should calculate layer value correctly for layer 4", () => {
    // Layer 1 value * multiplier for layer 2 (1.5) * multiplier for layer 3 (1.5) * multiplier for layer 4 (2.0)
    expect(getLayerValue(4, mockConfig)).toBeCloseTo(33.75);
  });

  it("should calculate layer size correctly", () => {
    const currentPrice = 50000;
    const layer1Size = getLayerValue(1, mockConfig) / currentPrice;
    expect(getLayerSize(1, currentPrice, mockConfig)).toBe(layer1Size);
  });

  it("should generate layer multipliers correctly", () => {
    const entryPrice = 50000;
    const layers = getLayerMultipliers(mockConfig, entryPrice);

    expect(layers.length).toBe(mockConfig.Max_Layers);

    // Layer 1
    expect(layers[0].layer).toBe(1);
    expect(layers[0].multiplier).toBe(1.5); // First layer in Martin_Layers has multiplier 1.5
    expect(layers[0].cumulativeX).toBeCloseTo(1.5);
    expect(layers[0].lotSize).toBeCloseTo(0.00015);
    expect(layers[0].estimatedCost).toBeCloseTo(7.5);
    expect(layers[1].triggerPrice).toBeCloseTo(49250);

    // Layer 2
    expect(layers[1].layer).toBe(2);
    expect(layers[1].multiplier).toBe(1.5);
    expect(layers[1].cumulativeX).toBeCloseTo(2.25);
    // (5 * 1.5) / 50000
    expect(layers[1].lotSize).toBeCloseTo(0.0002284263959390863);
    expect(layers[1].estimatedCost).toBeCloseTo(18.75);
    // (5 + 7.5) / (5/50000 + 7.5/50000) = 12.5 / (12.5/50000) = 50000
    expect(layers[1].avgPrice).toBeCloseTo(49547.28370221328);

    // Layer 4
    expect(layers[3].layer).toBe(4);
    expect(layers[3].multiplier).toBe(2.0);
    expect(layers[3].cumulativeX).toBeCloseTo(6.75);
  });

  it("should correctly parse martin layers", () => {
    const rawLayers = [
      { start: 1, end: 2, multiplier: 1.2 },
      { start: 3, end: 5, multiplier: 1.8 },
    ];
    const parsed = parseMartinLayers(rawLayers);
    expect(parsed).toEqual(rawLayers);
  });

  it("should return null for invalid martin layers", () => {
    const invalidLayers = [
      { start: 1, end: 2, multiplier: 1.2 },
      { start: 3, end: "five", multiplier: 1.8 }, // Invalid end type
    ];
    expect(parseMartinLayers(invalidLayers)).toBeNull();
  });
});

describe("RiskManager V4.0 Core Functions", () => {
  const mockState = {
    currentLayer: 1,
    totalSize: 0.01, // 500 USDT / 50000
    avgPrice: 50000,
    totalCost: 500,
    lastLayerPrice: 50000,
    capital: 500,
    highestPrice: 50000,
    lowestPrice: 50000,
    isTrailingActivated: false,
    isCooldown: false,
    cooldownUntil: 0,
    isLong: true,
    lockedBarTimestamp: 0,
    entryTrendBull: true,
    hasTriggeredKamaReversal: false,
  };

  it("should calculate unrealized loss correctly", () => {
    const currentPrice = 49000;
    const loss = calculateUnrealizedLoss(mockState, currentPrice);
    expect(loss).toBeCloseTo(mockState.totalSize * (mockState.avgPrice - currentPrice));
  });

  it("should calculate unrealized loss percentage correctly", () => {
    const currentPrice = 49000;
    const loss = calculateUnrealizedLoss(mockState, currentPrice);
    const lossPct = (loss / mockConfig.Initial_Capital) * 100;
    expect(calculateUnrealizedLossPct(mockState, currentPrice, mockConfig)).toBeCloseTo(lossPct);
  });

  it("should trigger limit stop when max loss percentage is reached", () => {
    const currentPrice = 44000; // Simulate a 12% drop from 50000, loss = 50000 * 0.01 - 44000 * 0.01 = 500 - 440 = 60. lossPct = 60/1000 * 100 = 6%
    const loss = calculateUnrealizedLoss(mockState, currentPrice);
    const lossPct = (loss / mockConfig.Initial_Capital) * 100;
    console.log(`Simulated loss: ${loss}, lossPct: ${lossPct}`);
    const { triggered, reason } = shouldTriggerLimitStop(mockState, currentPrice, mockConfig);
    expect(triggered).toBe(true);
    expect(reason).toContain("总浮亏");
  });

  it("should not trigger limit stop when max loss percentage is not reached", () => {
    const currentPrice = 49900; // Small drop
    const { triggered } = shouldTriggerLimitStop(mockState, currentPrice, mockConfig);
    expect(triggered).toBe(false);
  });

  it("should add layer when deviation is met (basePrice = lastLayerPrice)", () => {
    // lastLayerPrice = 50000, currentPrice = 49250 => deviation = (50000 - 49250) / 50000 * 100 = 1.5% >= 1.5%
    const currentPrice = 49250;
    const { shouldAdd, nextLayer } = shouldAddLayer(mockState, currentPrice, mockConfig);
    expect(shouldAdd).toBe(true);
    expect(nextLayer).toBe(2);
  });

  it("should not add layer when deviation is not met", () => {
    const currentPrice = 49500; // deviation = (50000 - 49500) / 50000 * 100 = 1% < 1.5%
    const { shouldAdd } = shouldAddLayer(mockState, currentPrice, mockConfig);
    expect(shouldAdd).toBe(false);
  });

  it("should not add layer if max layers reached", () => {
    const stateMaxLayers = { ...mockState, currentLayer: mockConfig.Max_Layers };
    const currentPrice = 40000;
    const { shouldAdd } = shouldAddLayer(stateMaxLayers, currentPrice, mockConfig);
    expect(shouldAdd).toBe(false);
  });

  // 🔥 Short 方向測試：確保做空時價格上漲觸發加倉
  it("should add layer for SHORT position when price rises above threshold", () => {
    const shortState = { ...mockState, isLong: false };
    // Short: avgPrice=50000, currentPrice=50800 => deviation = (50800-50000)/50000*100 = 1.6% >= 1.5%
    const currentPrice = 50800;
    const { shouldAdd, stepPctUsed } = shouldAddLayer(shortState, currentPrice, mockConfig);
    expect(shouldAdd).toBe(true);
    expect(stepPctUsed).toBe(1.5);
  });

  it("should NOT add layer for SHORT position when price rise is below threshold", () => {
    const shortState = { ...mockState, isLong: false };
    // Short: avgPrice=50000, currentPrice=50500 => deviation = (50500-50000)/50000*100 = 1.0% < 1.5%
    const currentPrice = 50500;
    const { shouldAdd } = shouldAddLayer(shortState, currentPrice, mockConfig);
    expect(shouldAdd).toBe(false);
  });

  it("should NOT add layer for SHORT position when price drops (profit direction)", () => {
    const shortState = { ...mockState, isLong: false };
    // Short: avgPrice=50000, currentPrice=49000 => deviation = (49000-50000)/50000*100 = -2% < 1.5%
    const currentPrice = 49000;
    const { shouldAdd } = shouldAddLayer(shortState, currentPrice, mockConfig);
    expect(shouldAdd).toBe(false);
  });

  it("should add layer for LONG position when price drops (original behavior preserved)", () => {
    const longState = { ...mockState, isLong: true };
    // Long: avgPrice=50000, currentPrice=49250 => deviation = (50000-49250)/50000*100 = 1.5% >= 1.5%
    const currentPrice = 49250;
    const { shouldAdd } = shouldAddLayer(longState, currentPrice, mockConfig);
    expect(shouldAdd).toBe(true);
  });

  it("should NOT add layer for LONG position when price rises (profit direction)", () => {
    const longState = { ...mockState, isLong: true };
    // Long: avgPrice=50000, currentPrice=51000 => deviation = (50000-51000)/50000*100 = -2% < 1.5%
    const currentPrice = 51000;
    const { shouldAdd } = shouldAddLayer(longState, currentPrice, mockConfig);
    expect(shouldAdd).toBe(false);
  });
});
