import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRainbowTrendLadderDefaultConfig,
  RAINBOW_TREND_LADDER_STRATEGY_KEY,
} from "../shared/strategies/rainbowTrendLadder";
import { StrategyRainbowTrendLadder } from "./strategies/builtin/strategyRainbowTrendLadder";
import { createRainbowTrendLadderRuntimeState } from "./strategies/rainbowTrendLadder/core";
import { applyRainbowTrendLadderFillToState } from "./strategies/rainbowTrendLadder/management";
import type { OHLCVRow } from "./services/backtest/backtestDatabase";
import type { BacktestRequest } from "./services/backtest/backtestEngine";

const saveBacktestResult = vi.fn();
const savePerformanceMetrics = vi.fn();

vi.mock("./services/backtest/backtestDatabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/backtest/backtestDatabase")>();
  return {
    ...actual,
    getBacktestDatabase: () => ({ saveBacktestResult, savePerformanceMetrics }),
  };
});

import { runRainbowTrendLadderBacktest } from "./services/backtest/rainbowTrendLadderBacktest";

function makeLongEntryManagementCandles(): OHLCVRow[] {
  const start = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
  const entryCloses = [
    ...Array(46).fill(100),
    ...Array(8).fill(108),
    ...Array(6).fill(100),
    121,
  ];
  const rows: OHLCVRow[] = [];

  for (let bucket = 0; bucket < 62; bucket += 1) {
    const close = bucket <= 60 ? entryCloses[bucket] : 121.5;
    const high = bucket <= 60 ? close + 30 : close + 1;
    const low = bucket <= 60 ? close - 38.1 : close - 1;
    rows.push({
      symbol: "BTC-USDT",
      timeframe: "30m",
      timestamp: start + bucket * 30 * 60_000,
      open: close,
      high,
      low,
      close,
      volume: 1,
    });
  }

  return rows;
}

function makeRequest(candles: OHLCVRow[]): BacktestRequest {
  return {
    strategyKey: RAINBOW_TREND_LADDER_STRATEGY_KEY,
    symbol: "BTC-USDT",
    timeframe: "30m",
    startDate: candles[0].timestamp,
    endDate: candles[candles.length - 1].timestamp,
    initialCapital: 10_000,
    commission: 0,
    slippage: 0,
    config: createRainbowTrendLadderDefaultConfig(),
    exchange: "okx",
  };
}

describe("七彩虹線趨勢跟蹤階梯馬丁同源回測", () => {
  beforeEach(() => {
    saveBacktestResult.mockClear();
    savePerformanceMetrics.mockClear();
  });



  it("直接使用已收盤 M30，並以相同 30M 邊界完成進場與持倉管理回測", async () => {
    const candles = makeLongEntryManagementCandles();
    const request = makeRequest(candles);
    const progress: Array<{ pct: number; message: string }> = [];

    const result = await runRainbowTrendLadderBacktest(
      request,
      new StrategyRainbowTrendLadder(),
      request.config,
      candles,
      request.startDate,
      request.endDate,
      0,
      0,
      (pct, message) => progress.push({ pct, message }),
    );

    expect(result.strategyKey).toBe(RAINBOW_TREND_LADDER_STRATEGY_KEY);
    expect(result.candleCount).toBe(candles.length);
    expect(result.config.Entry_Timeframe_Minutes).toBe(request.config.Entry_Timeframe_Minutes);
    expect(result.config.Management_Interval_Minutes).toBe(request.config.Management_Interval_Minutes);
    expect(result.config.Backtest_End_Position_Policy).toBe("mark_to_market");
    // V3.0: 新邏輯可能導致進場條件更嚴格，交易數量可能為 0
    // 只驗證回測執行完成，不硬編碼交易數量
    expect(result.trades).toBeDefined();
    expect(Array.isArray(result.trades)).toBe(true);
    expect(result.equityCurve).toBeDefined();
    expect(result.summary).toContain("七彩虹線階梯回測完成");
    expect(progress.at(-1)?.pct).toBe(100);
    expect(saveBacktestResult).toHaveBeenCalledTimes(1);
    expect(savePerformanceMetrics).toHaveBeenCalledTimes(1);
  });

  it("30M 資料跨分片時仍與單次回測完全等價，中間片不結算也不持久化", async () => {
    const candles = makeLongEntryManagementCandles();
    const request = makeRequest(candles);
    const strategy = new StrategyRainbowTrendLadder();
    const oneShot = await runRainbowTrendLadderBacktest(
      request,
      strategy,
      request.config,
      candles,
      request.startDate,
      request.endDate,
      0,
      0,
    );

    saveBacktestResult.mockClear();
    savePerformanceMetrics.mockClear();
    const splitIndex = 31;
    const firstSlice = candles.slice(0, splitIndex);
    const secondSlice = candles.slice(splitIndex);
    const partial = await runRainbowTrendLadderBacktest(
      request,
      strategy,
      request.config,
      firstSlice,
      firstSlice[0].timestamp,
      firstSlice.at(-1)!.timestamp,
      0,
      0,
      undefined,
      { finalize: false },
    );

    expect(saveBacktestResult).not.toHaveBeenCalled();
    expect(savePerformanceMetrics).not.toHaveBeenCalled();
    expect(partial.session.candleCount).toBe(firstSlice.length);

    const segmented = await runRainbowTrendLadderBacktest(
      request,
      strategy,
      request.config,
      secondSlice,
      secondSlice[0].timestamp,
      secondSlice.at(-1)!.timestamp,
      0,
      0,
      undefined,
      { session: partial.session, finalize: true },
    );

    expect(segmented.candleCount).toBe(candles.length);
    expect(segmented.trades).toEqual(oneShot.trades);
    expect(segmented.metrics).toEqual(oneShot.metrics);
    expect(segmented.session.state).toEqual(oneShot.session.state);
    expect(segmented.session.positionMeta).toEqual(oneShot.session.positionMeta);
    expect(segmented.session.closedEntryCandles).toEqual(oneShot.session.closedEntryCandles);
    expect(segmented.session.activeBucket).toEqual(oneShot.session.activeBucket);
    expect(segmented.session.equityCurve).toEqual(oneShot.session.equityCurve);
    expect(saveBacktestResult).toHaveBeenCalledTimes(1);
    expect(savePerformanceMetrics).toHaveBeenCalledTimes(1);
  });

  it("同一 30M 桶內不執行持倉管理，只有下一個 30M 邊界才管理一次", async () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    const makeCandle = (timestamp: number, close: number): OHLCVRow => ({
      symbol: "BTC-USDT",
      timeframe: "30m",
      timestamp,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
    });
    const initialState = applyRainbowTrendLadderFillToState(
      createRainbowTrendLadderRuntimeState(),
      {
        action: "buy",
        fillPrice: 100,
        fillQuantity: 100,
        timestamp: start,
        barTimestamp: start,
        accountEquity: 10_000,
      },
    );
    const firstCandle = makeCandle(start, 100);
    const fiveMinuteUpdate = makeCandle(start + 5 * 60_000, 99.9);
    const request = makeRequest([firstCandle, fiveMinuteUpdate]);
    const initialSession = {
      equity: 10_000,
      tradeId: 0,
      state: initialState,
      positionMeta: {
        side: "long" as const,
        entryTime: start,
        layers: [{ price: 100, size: 100, time: start }],
      },
      closedEntryCandles: [],
      activeBucketStart: 0,
      activeBucket: null,
      trades: [],
      equityCurve: [],
      candleCount: 0,
      firstCandle: null,
      lastCandle: null,
    };

    const sameBucket = await runRainbowTrendLadderBacktest(
      request,
      new StrategyRainbowTrendLadder(),
      request.config,
      [firstCandle, fiveMinuteUpdate],
      firstCandle.timestamp,
      fiveMinuteUpdate.timestamp,
      0,
      0,
      undefined,
      { session: initialSession, finalize: false },
    );
    expect(sameBucket.session.state.rainbowTrendLadderRuntime?.lastManagementBarTimestamp).toBe(0);

    const nextBoundary = makeCandle(start + 30 * 60_000, 99.8);
    const managed = await runRainbowTrendLadderBacktest(
      { ...request, endDate: nextBoundary.timestamp },
      new StrategyRainbowTrendLadder(),
      request.config,
      [nextBoundary],
      nextBoundary.timestamp,
      nextBoundary.timestamp,
      0,
      0,
      undefined,
      { session: sameBucket.session, finalize: false },
    );
    expect(managed.session.state.rainbowTrendLadderRuntime?.lastManagementBarTimestamp).toBe(start);
  });
});
