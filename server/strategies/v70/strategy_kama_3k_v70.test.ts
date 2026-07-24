import { describe, it, expect } from "vitest";
import { StrategyKama3kV70 } from "./strategy_kama_3k_v70";

describe("StrategyKama3kV70", () => {
  const strategy = new StrategyKama3kV70();

  it("should have correct key and name", () => {
    expect(strategy.key).toBe("KAMA_3K_TORNADO_V70");
    expect(strategy.name).toContain("V7.0");
  });

  it("should have defaultConfig with all required fields", () => {
    const cfg = strategy.defaultConfig;
    // 基礎參數
    expect(cfg.base_lot_size_usdt).toBe(150);
    expect(cfg.leverage).toBe(5);
    expect(cfg.timeframe).toBe("5m");
    // MA200 宏觀趨勢錨
    expect(cfg.ma200_enabled).toBe(true);
    expect(cfg.ma200_period).toBe(200);
    expect(cfg.ma200_type).toBe("SMA");
    expect(cfg.ma200_oscillation_filter_pct).toBe(0.015);
    // KAMA 快線
    expect(cfg.kama_fast_er_period).toBe(50);
    expect(cfg.kama_fast_fast_const).toBe(10);
    expect(cfg.kama_fast_slow_const).toBe(2);
    // KAMA 慢線
    expect(cfg.kama_slow_er_period).toBe(50);
    expect(cfg.kama_slow_fast_const).toBe(10);
    expect(cfg.kama_slow_slow_const).toBe(6);
    // 方向模式
    expect(cfg.cross_mode).toBe("both");
    // 風控
    expect(cfg.risk_hard_stop_pct).toBe(4.5);
    expect(cfg.risk_ma_force_liq).toBe(true);
    expect(cfg.risk_reverse_cross_close).toBe(true);
    expect(cfg.risk_reverse_cross_profit_limit).toBe(1.5);
    // 追蹤止盈
    expect(cfg.trailing_enabled).toBe(true);
    expect(cfg.trailing_activation_pct).toBe(3.0);
    expect(cfg.trailing_retracement_pct).toBe(1.5);
    // 馬丁
    expect(cfg.martin_enabled).toBe(true);
    expect(cfg.martin_max_layers).toBe(11);
    expect(cfg.martin_layer_tp_long).toBe(0.30);
    expect(cfg.martin_layer_tp_short).toBe(0.20);
  });

  it("should have martin_layers as valid JSON array", () => {
    const cfg = strategy.defaultConfig;
    const layers = typeof cfg.martin_layers === "string"
      ? JSON.parse(cfg.martin_layers)
      : cfg.martin_layers;
    expect(Array.isArray(layers)).toBe(true);
    expect(layers.length).toBe(3);
    // 第一段：1-4 層
    expect(layers[0].start).toBe(1);
    expect(layers[0].end).toBe(4);
    expect(layers[0].multiplier).toBe(1.5);
    expect(layers[0].gap_long).toBe(0.60);
    expect(layers[0].gap_short).toBe(0.40);
    // 第二段：5-9 層
    expect(layers[1].start).toBe(5);
    expect(layers[1].end).toBe(9);
    expect(layers[1].multiplier).toBe(1.1);
    // 第三段：10-11 層
    expect(layers[2].start).toBe(10);
    expect(layers[2].end).toBe(11);
    expect(layers[2].multiplier).toBe(1.0);
  });

  it("generateActions should return HOLD without valid price", () => {
    const result = strategy.generateActions(
      { action: "BUY", symbol: "BTC-USDT-SWAP", price: 0 },
      { id: 1, symbol: "BTC-USDT-SWAP", direction: "both", positionSize: 0.01, leverage: 5, config: strategy.defaultConfig },
      null,
      { lossCount: 0, currentLot: 0.01, lastEntryPrice: 0 },
    );
    expect(result.action).toBe("HOLD");
    expect(result.reason).toContain("無有效價格");
  });

  it("generateActions should return OPEN_LONG for BUY signal", () => {
    const result = strategy.generateActions(
      { action: "BUY", symbol: "BTC-USDT-SWAP", price: 100000 },
      { id: 1, symbol: "BTC-USDT-SWAP", direction: "both", positionSize: 0.01, leverage: 5, config: strategy.defaultConfig },
      null,
      { lossCount: 0, currentLot: 0.01, lastEntryPrice: 0 },
    );
    expect(result.action).toBe("OPEN_LONG");
    expect(result.lotSize).toBeGreaterThan(0);
    expect(result.reason).toContain("底倉開倉");
  });

  it("generateActions should return OPEN_SHORT for SELL signal", () => {
    const result = strategy.generateActions(
      { action: "SELL", symbol: "BTC-USDT-SWAP", price: 100000 },
      { id: 1, symbol: "BTC-USDT-SWAP", direction: "both", positionSize: 0.01, leverage: 5, config: strategy.defaultConfig },
      null,
      { lossCount: 0, currentLot: 0.01, lastEntryPrice: 0 },
    );
    expect(result.action).toBe("OPEN_SHORT");
    expect(result.lotSize).toBeGreaterThan(0);
  });

  it("generateActions should return CLOSE_ALL for CLOSE signal", () => {
    const result = strategy.generateActions(
      { action: "CLOSE", symbol: "BTC-USDT-SWAP", price: 100000 },
      { id: 1, symbol: "BTC-USDT-SWAP", direction: "both", positionSize: 0.01, leverage: 5, config: strategy.defaultConfig },
      null,
      { lossCount: 0, currentLot: 0.01, lastEntryPrice: 0 },
    );
    expect(result.action).toBe("CLOSE_ALL");
  });

  it("generateActionsV35 (async) should return HOLD without valid price", async () => {
    const result = await strategy.generateActionsV35(
      { action: "BUY", symbol: "BTC-USDT-SWAP", price: 0 },
      { id: 1, symbol: "BTC-USDT-SWAP", direction: "both", positionSize: 0.01, leverage: 5, config: strategy.defaultConfig },
      null,
      { currentLayer: 0, totalSize: 0, avgPrice: 0, totalCost: 0, lastLayerPrice: 0, capital: 0, highestPrice: 0, lowestPrice: 0, isLong: true, isTrailingActivated: false, isCooldown: false, cooldownUntil: 0, lockedBarTimestamp: 0, entryTrendBull: undefined, hasTriggeredKamaReversal: false },
    );
    expect(result.action).toBe("HOLD");
    expect(result.reason).toContain("無有效價格");
  });

  it("generateActionsV35 (async) should return OPEN_LONG for BUY signal with no position", async () => {
    const result = await strategy.generateActionsV35(
      { action: "BUY", symbol: "BTC-USDT-SWAP", price: 100000 },
      { id: 1, symbol: "BTC-USDT-SWAP", direction: "both", positionSize: 0.01, leverage: 5, config: strategy.defaultConfig },
      null,
      { currentLayer: 0, totalSize: 0, avgPrice: 0, totalCost: 0, lastLayerPrice: 0, capital: 0, highestPrice: 0, lowestPrice: 0, isLong: true, isTrailingActivated: false, isCooldown: false, cooldownUntil: 0, lockedBarTimestamp: 0, entryTrendBull: undefined, hasTriggeredKamaReversal: false },
    );
    expect(result.action).toBe("OPEN_LONG");
    expect(result.lotSize).toBeGreaterThan(0);
  });

  it("generateActionsV35 (async) should HOLD when already in position", async () => {
    const result = await strategy.generateActionsV35(
      { action: "BUY", symbol: "BTC-USDT-SWAP", price: 100000 },
      { id: 1, symbol: "BTC-USDT-SWAP", direction: "both", positionSize: 0.01, leverage: 5, config: strategy.defaultConfig },
      null,
      { currentLayer: 2, totalSize: 0.03, avgPrice: 99000, totalCost: 2970, lastLayerPrice: 98500, capital: 10000, highestPrice: 100500, lowestPrice: 98000, isLong: true, isTrailingActivated: false, isCooldown: false, cooldownUntil: 0, lockedBarTimestamp: 0, entryTrendBull: undefined, hasTriggeredKamaReversal: false },
    );
    expect(result.action).toBe("HOLD");
    expect(result.reason).toContain("已有持倉");
  });

  it("lot size should be calculated correctly based on base_lot_size_usdt and price", () => {
    const result = strategy.generateActions(
      { action: "BUY", symbol: "BTC-USDT-SWAP", price: 50000 },
      { id: 1, symbol: "BTC-USDT-SWAP", direction: "both", positionSize: 0.01, leverage: 5, config: { ...strategy.defaultConfig, base_lot_size_usdt: 300 } },
      null,
      { lossCount: 0, currentLot: 0.01, lastEntryPrice: 0 },
    );
    // 300 / 50000 = 0.006
    expect(result.lotSize).toBeCloseTo(0.006, 5);
  });
});
