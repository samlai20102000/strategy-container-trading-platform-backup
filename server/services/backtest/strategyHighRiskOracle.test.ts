import { describe, expect, it } from "vitest";

import { createDefaultExecutionPolicy } from "../../../shared/executionModes";
import { createV41DefaultConfig } from "../../../shared/strategies/kama3kMartinV41";
import { calculatePartialTPRatio } from "../../services/indicators";
import { createInitialStrategyState } from "../../strategies/base";
import {
  evaluateV41EntryConditions,
  evaluateV41SameDirectionReentry,
} from "../../strategies/v41/entryConditions";
import { StrategyKama3kV50 } from "../../strategies/v50/strategy_kama_3k_v50";
import {
  calculateV61PrecomputedBarSeries,
  StrategyKama3kV61,
} from "../../strategies/v61/strategy_kama_3k_v61";
import { StrategyKama3kV70 } from "../../strategies/v70/strategy_kama_3k_v70";
import type { BacktestOpenLegSnapshot } from "./backtestContracts";
import type { OHLCVRow } from "./backtestDatabase";
import { ensureBuiltInPortfolioRuntimeFactoriesRegistered } from "./builtInPortfolioRuntimeFactories";
import {
  createPortfolioStrategyRuntimeAdapter,
  resolvePortfolioStrategyAdapter,
} from "./portfolioStrategyAdapterRegistry";

function candle(index: number, open: number, close: number): OHLCVRow {
  return {
    symbol: "BTC-USDT-SWAP",
    timeframe: "15m",
    timestamp: Date.UTC(2025, 0, 1, 0, index * 15),
    open,
    high: Math.max(open, close) + 0.5,
    low: Math.min(open, close) - 0.5,
    close,
    volume: 100 + index,
  };
}

function openLongLeg(overrides: Partial<BacktestOpenLegSnapshot> = {}): BacktestOpenLegSnapshot {
  return {
    side: "long",
    sideCode: "LONG",
    entryTime: Date.UTC(2025, 0, 1),
    averageEntryPrice: 100,
    size: 1,
    markPrice: 100,
    entryNotional: 100,
    entryFees: 0.05,
    unrealizedGrossPnl: 0,
    unrealizedPnl: -0.05,
    legId: "leg-long-1",
    cycleId: "cycle-1",
    role: "PRIMARY",
    martinLayer: 0,
    lastEntryPrice: 100,
    openedAt: Date.UTC(2025, 0, 1),
    mfePct: 0,
    maePct: 0,
    ...overrides,
  };
}

function createV50Runtime(candles: readonly OHLCVRow[], config: Record<string, unknown>) {
  ensureBuiltInPortfolioRuntimeFactoriesRegistered();
  const executionPolicy = createDefaultExecutionPolicy("SINGLE_EXCLUSIVE");
  const strategy = new StrategyKama3kV50();
  const resolved = resolvePortfolioStrategyAdapter(strategy.key, executionPolicy.mode);
  const runtime = createPortfolioStrategyRuntimeAdapter(resolved, {
    strategy,
    config,
    candles,
    executionPolicy,
    initialCapital: 10_000,
    baseLotUsdt: 100,
  });
  return { runtime, executionPolicy, strategy };
}

function evaluateV50(input: {
  candles: readonly OHLCVRow[];
  config: Record<string, unknown>;
  openLegs?: readonly BacktestOpenLegSnapshot[];
  kamaFast?: number;
  kamaSlow?: number;
  atr?: number;
}) {
  const { candles, config } = input;
  const index = candles.length - 1;
  const { runtime, executionPolicy, strategy } = createV50Runtime(candles, config);
  return runtime.evaluateBar({
    index,
    timestamp: candles[index].timestamp,
    candle: candles[index],
    previousCandle: offset => candles[index - offset],
    config,
    strategy,
    executionMode: executionPolicy.mode,
    executionPolicy,
    initialCapital: 10_000,
    baseLotUsdt: 100,
    openLegs: input.openLegs ?? [],
    indicators: {
      kamaFast: input.kamaFast ?? 110,
      kamaSlow: input.kamaSlow ?? 100,
      atr: input.atr ?? 1,
      atrAverage: 1,
    },
    consecutiveLosses: 0,
    closedTradeCount: 0,
  });
}

describe("advanced built-in strategy deterministic oracle", () => {
  it("V41_ENTRY_OPEN：AND 三票一致時只輸出 canonical long entry", () => {
    const result = evaluateV41EntryConditions({
      config: {
        ...createV41DefaultConfig(),
        enableThreeKFilter: true,
        enableKamaFastSlowCross: true,
        enableKamaPriceVsSlow: true,
        entryConditionLogic: "and",
      },
      closedBars: [
        { open: 100, high: 101.5, low: 99.5, close: 101 },
        { open: 101, high: 102.5, low: 100.5, close: 102 },
        { open: 102, high: 104, low: 101.5, close: 103 },
      ],
      decisionBarTimestamp: Date.UTC(2025, 0, 1),
      decisionClose: 103,
      fastKama: 102,
      slowKama: 101,
      allowedDirection: "both",
    });

    expect(result).toMatchObject({
      decision: "open",
      direction: "long",
      primaryReasonCode: "V41_ENTRY_OPEN",
      enabledConditionCount: 3,
    });
    expect(result.votes.every(vote => vote.status === "long")).toBe(true);
  });

  it("V41_NO_PATTERN / V41_FAST_SLOW_EQUAL / V41_PRICE_EQUALS_SLOW / V41_DIRECTION_CONFLICT / V41_AND_WAITING_FOR_ALL / V41_OR_NO_DIRECTION：拒絕理由逐分支固定", () => {
    const baseInput = {
      closedBars: [
        { open: 100, high: 101, low: 99, close: 100.5 },
        { open: 100.5, high: 101, low: 99.5, close: 100 },
        { open: 100, high: 101, low: 99.5, close: 100.2 },
      ],
      decisionBarTimestamp: Date.UTC(2025, 0, 1),
      decisionClose: 100,
      fastKama: 100,
      slowKama: 100,
      allowedDirection: "both" as const,
    };
    const voteReasons = evaluateV41EntryConditions({
      ...baseInput,
      config: {
        ...createV41DefaultConfig(),
        enableThreeKFilter: true,
        enableKamaFastSlowCross: true,
        enableKamaPriceVsSlow: true,
        entryConditionLogic: "or",
      },
    }).votes.map(vote => vote.reasonCode);
    expect(voteReasons).toEqual([
      "V41_THREE_K_NO_PATTERN",
      "V41_FAST_SLOW_EQUAL",
      "V41_PRICE_EQUALS_SLOW",
    ]);

    const conflict = evaluateV41EntryConditions({
      ...baseInput,
      config: {
        ...createV41DefaultConfig(),
        enableThreeKFilter: false,
        enableKamaFastSlowCross: true,
        enableKamaPriceVsSlow: true,
        entryConditionLogic: "or",
      },
      decisionClose: 99,
      fastKama: 101,
      slowKama: 100,
    });
    expect(conflict.primaryReasonCode).toBe("V41_DIRECTION_CONFLICT");

    const waiting = evaluateV41EntryConditions({
      ...baseInput,
      config: {
        ...createV41DefaultConfig(),
        enableThreeKFilter: false,
        enableKamaFastSlowCross: true,
        enableKamaPriceVsSlow: true,
        entryConditionLogic: "and",
      },
      decisionClose: 100,
      fastKama: 101,
      slowKama: 100,
    });
    expect(waiting.primaryReasonCode).toBe("V41_AND_WAITING_FOR_ALL");

    const noDirection = evaluateV41EntryConditions({
      ...baseInput,
      config: {
        ...createV41DefaultConfig(),
        enableThreeKFilter: false,
        enableKamaFastSlowCross: true,
        enableKamaPriceVsSlow: false,
        entryConditionLogic: "or",
      },
    });
    expect(noDirection.primaryReasonCode).toBe("V41_OR_NO_DIRECTION");
  });

  it("V41_REENTRY：啟用後只在持續 KAMA 方向仍支持原方向時原地重入", () => {
    const baseInput = {
      config: {
        ...createV41DefaultConfig(),
        enableThreeKFilter: true,
        enableKamaFastSlowCross: true,
        enableKamaPriceVsSlow: true,
        entryConditionLogic: "and" as const,
        enableSameDirectionReentry: true,
      },
      closedBars: [] as const,
      decisionBarTimestamp: Date.UTC(2025, 0, 1),
      decisionClose: 103,
      fastKama: 102,
      slowKama: 101,
      allowedDirection: "both" as const,
      originalDirection: "long" as const,
    };

    expect(evaluateV41SameDirectionReentry(baseInput)).toMatchObject({
      allowed: true,
      reasonCode: "V41_ENTRY_OPEN",
      direction: "long",
    });
    expect(evaluateV41SameDirectionReentry({
      ...baseInput,
      fastKama: 100,
      decisionClose: 100,
    })).toMatchObject({
      allowed: false,
      reasonCode: "V41_REENTRY_DIRECTION_NOT_SUPPORTED",
    });
  });

  it("V50_ENTRY：兩根陽 K 加當前破高且 fast > slow 只產生 canonical LONG entry", async () => {
    const candles = [candle(0, 100, 101), candle(1, 101, 102), candle(2, 102, 103)];
    const result = await evaluateV50({
      candles,
      config: { enable_ai_filter: false, enable_vol_position: false },
    });

    expect(result.management).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ action: "OPEN_LONG", reasonCode: "V50_KAMA_3K_ENTRY" });
    expect(result.entries[0].quantity).toBeCloseTo(100 / 103, 10);
  });

  it("V50_TRAILING_EXIT：MFE 達標後回撤只產生逐腿 reduce-only 平倉候選", async () => {
    const candles = [candle(0, 100, 100), candle(1, 100, 100.5), candle(2, 100.5, 101)];
    const result = await evaluateV50({
      candles,
      config: { Target_TP_Pct: 1, Callback_Pct: 0.5, Max_Layers: 5 },
      openLegs: [openLongLeg({ markPrice: 101, unrealizedGrossPnl: 1, unrealizedPnl: 0.95, mfePct: 2 })],
    });

    expect(result.management).toContainEqual(expect.objectContaining({
      action: "CLOSE_LONG",
      reasonCode: "V50_TRAILING_EXIT",
      quantity: 1,
      eventKind: "REGULAR_EXIT",
    }));
  });

  it("V50_DYNAMIC_MARTIN：逆向偏離達下一層門檻時以 canonical base lot 產生加倉", async () => {
    const candles = [candle(0, 100, 100), candle(1, 100, 99), candle(2, 99, 98)];
    const result = await evaluateV50({
      candles,
      config: {
        Target_TP_Pct: 10,
        Callback_Pct: 1,
        Max_Layers: 5,
        Martin_Step_Pct: 1.5,
        Martin_Multiplier: 1.5,
      },
      openLegs: [openLongLeg({ markPrice: 98, unrealizedGrossPnl: -2, unrealizedPnl: -2.05, maePct: 2 })],
    });

    expect(result.management).toContainEqual(expect.objectContaining({
      action: "ADD_LONG",
      reasonCode: "V50_MARTIN_DISTANCE_TRIGGER",
      eventKind: "MARTIN_ADD",
    }));
    expect(result.management[0].quantity).toBeCloseTo(150 / 98, 10);
  });

  it("V50_F1_REGIME / V50_PARTIAL_TP：F1 分區與 F2 分批止盈維持固定輸出", () => {
    const strategy = new StrategyKama3kV50();
    expect(strategy.getMarketRegime(35, strategy.defaultConfig)).toBe("strong_trend");
    expect(strategy.getMarketRegime(15, strategy.defaultConfig)).toBe("ranging");
    expect(calculatePartialTPRatio(8, 1, {
      enable_partial_tp: true,
      partial_tp_layer_4: 0.3,
      partial_tp_layer_6: 0.3,
      partial_tp_layer_8: 0.2,
      partial_tp_trigger_pct: 0.5,
    })).toBe(0.2);
  });

  it("V61_LIVE_ORACLE / V61_BACKTEST_ORACLE：完整 candles 與 precomputed 路徑輸出相同", () => {
    const candles = Array.from({ length: 90 }, (_, index) => {
      const close = 100 + index * 0.2 + Math.sin(index / 4) * 0.3;
      return candle(index, close - 0.1, close);
    });
    const config = {
      entry_zone_mode: "breakout" as const,
      direction_mode: "both" as const,
      enable_bar_lock: false,
      min_atr_ratio: 0,
    };
    const direct = new StrategyKama3kV61(config).generateSignalV61(candles, false);
    const bars = calculateV61PrecomputedBarSeries(candles, config);
    const precomputed = new StrategyKama3kV61(config).generateSignalV61(
      [], false, undefined, undefined, undefined, undefined, bars.at(-1),
    );

    expect(precomputed).toEqual(direct);
  });

  it("V61_ZONE_TRIGGER_PARITY：breakout 與 inside 都依相同 ATR zone 產生確定方向", () => {
    const breakout = new StrategyKama3kV61({
      entry_zone_mode: "breakout",
      direction_mode: "both",
      enable_bar_lock: false,
      min_atr_ratio: 0,
    }).generateSignalV61([], false, undefined, undefined, undefined, undefined, {
      index: 68,
      availableBars: 69,
      timestamp: Date.UTC(2025, 0, 1),
      currentPrice: 102,
      regime: "weak_trend",
      atr: 1,
      atrAverage: 1,
      kamaFast: 101,
      kamaSlow: 100,
    });
    const inside = new StrategyKama3kV61({
      entry_zone_mode: "inside",
      direction_mode: "both",
      enable_bar_lock: false,
      min_atr_ratio: 0,
    }).generateSignalV61([], false, undefined, undefined, undefined, undefined, {
      index: 68,
      availableBars: 69,
      timestamp: Date.UTC(2025, 0, 1),
      currentPrice: 100.2,
      regime: "ranging",
      atr: 1,
      atrAverage: 1,
      kamaFast: 99,
      kamaSlow: 100,
    });

    expect(breakout.action).toBe("buy");
    expect(inside.action).toBe("buy");
    expect(breakout.reason).toContain("breakout模式");
    expect(inside.reason).toContain("inside模式");
  });

  it("V61_DIRECTION_MODE_PARITY：trend 拒絕逆勢，hybrid ranging 與 both 接受同一 zone", () => {
    const precomputed = {
      index: 68,
      availableBars: 69,
      timestamp: Date.UTC(2025, 0, 1),
      currentPrice: 102,
      regime: "ranging" as const,
      atr: 1,
      atrAverage: 1,
      kamaFast: 99,
      kamaSlow: 100,
    };
    const signal = (direction_mode: "trend" | "hybrid" | "both") => new StrategyKama3kV61({
      entry_zone_mode: "breakout",
      direction_mode,
      enable_bar_lock: false,
      min_atr_ratio: 0,
    }).generateSignalV61([], false, undefined, undefined, undefined, undefined, precomputed);

    expect(signal("trend")).toMatchObject({ action: "wait", reason: "方向模式過濾" });
    expect(signal("hybrid").action).toBe("buy");
    expect(signal("both").action).toBe("buy");
  });

  it("V70_MA200 / V70_KAMA_CROSS：SMA/EMA 與金叉死叉輸出固定", () => {
    const strategy = new StrategyKama3kV70();
    expect(strategy.calculateMA200([1, 2, 3, 4], 2, "SMA")).toEqual([null, 1.5, 2.5, 3.5]);
    expect(strategy.calculateMA200([1, 2, 3], 2, "EMA")).toEqual([1, 1.6666666666666665, 2.5555555555555554]);
    expect(strategy.detectKAMACross([1, 3], [2, 2], 1)).toBe(1);
    expect(strategy.detectKAMACross([3, 1], [2, 2], 1)).toBe(-1);
  });

  it("V70_S_CURVE_LAYER / V70_MARTIN_TRIGGER：層乘數累積且多空間距分離", () => {
    const strategy = new StrategyKama3kV70();
    const cfg = strategy.parseConfig(strategy.defaultConfig);
    const longPosition = {
      side: "LONG" as const,
      layers: [{ price: 100, size: 1 }],
      entryPriceAvg: 100,
      currentLayer: 1,
      totalQty: 1,
      maxProfitRate: 0,
    };
    const layer2 = strategy.getLayerConfig(cfg, 2)!;
    const triggerPrice = 100 * (1 - layer2.gap_long / 100);

    expect(strategy.calculateLayerSize(cfg, 2, 100)).toBeCloseTo(
      (cfg.base_lot_size_usdt / 100) * layer2.multiplier,
      10,
    );
    expect(strategy.checkMartinTrigger(cfg, longPosition, triggerPrice, 90)).toMatchObject({
      triggered: true,
      layerNum: 2,
    });
  });

  it("V70_HARD_STOP / V70_REVERSE_CROSS_CLOSE / V70_LAYER_TP：出場優先級與層級止盈固定", () => {
    const strategy = new StrategyKama3kV70();
    const cfg = strategy.parseConfig({
      ...strategy.defaultConfig,
      risk_hard_stop_pct: 2,
      risk_ma_force_liq: false,
      risk_reverse_cross_close: true,
      risk_reverse_cross_profit_limit: 5,
      trailing_enabled: false,
      martin_layer_tp_long: 0.5,
    });
    const position = {
      side: "LONG" as const,
      layers: [{ price: 100, size: 1 }],
      entryPriceAvg: 100,
      currentLayer: 1,
      totalQty: 1,
      maxProfitRate: 0,
    };

    expect(strategy.checkExitConditions(cfg, position, 97, null, -1).reason).toContain("硬止損");
    expect(strategy.checkExitConditions(cfg, position, 101, null, -1).reason).toContain("反向交叉平倉");
    expect(strategy.checkLayerTP(cfg, { ...position, currentLayer: 2 }, 100.5)).toMatchObject({
      shouldExit: true,
    });
  });

  it("V70_PATH_PARITY：precomputed path 以同一 MA200/KAMA 核心產生 canonical entry", () => {
    const strategy = new StrategyKama3kV70();
    const state = createInitialStrategyState();
    const result = strategy.generateTradingSignal([], state, {
      ...strategy.defaultConfig,
      ma200_oscillation_filter_pct: 0,
    }, {
      availableBars: 220,
      currentPrice: 101,
      ma200Value: 100,
      ma200Slope: 1,
      cross: 1,
    });

    expect(result).toMatchObject({
      action: "buy",
      price: 101,
      lotUsdt: strategy.defaultConfig.base_lot_size_usdt,
    });
    expect(result.reason).toContain("V7.0 金叉開倉");
  });
});
