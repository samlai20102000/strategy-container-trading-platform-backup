import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRainbowTrendLadderDefaultConfig,
  RAINBOW_TREND_LADDER_STRATEGY_KEY,
} from "../shared/strategies/rainbowTrendLadder";
import { StrategyRainbowTrendLadder } from "./strategies/builtin/strategyRainbowTrendLadder";
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
    for (let minute = 0; minute < 30; minute += 1) {
      rows.push({
        symbol: "BTC-USDT",
        timeframe: "1m",
        timestamp: start + (bucket * 30 + minute) * 60_000,
        open: close,
        high,
        low,
        close,
        volume: 1,
      });
    }
  }

  return rows;
}

function makeRequest(candles: OHLCVRow[]): BacktestRequest {
  return {
    strategyKey: RAINBOW_TREND_LADDER_STRATEGY_KEY,
    symbol: "BTC-USDT",
    timeframe: "1m",
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



  it("由 M1 聚合已收盤 M30，使用正式七線核心進場並在回測尾端全平", () => {
    const candles = makeLongEntryManagementCandles();
    const request = makeRequest(candles);
    const progress: Array<{ pct: number; message: string }> = [];

    const result = runRainbowTrendLadderBacktest(
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
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      side: "long",
      entryPrice: 121,
      exitPrice: 121.5,
      exitReason: "回測結束強制平倉",
    });
    expect(result.trades[0].size).toBeCloseTo(100 / 121, 12); // 100 USDT / 121 entryPrice
    expect(result.equityCurve.at(-1)?.equity).toBeCloseTo(10_000 + (100 / 121) * (121.5 - 121), 2);
    expect(result.summary).toContain("七彩虹線階梯回測完成");
    expect(progress.at(-1)?.pct).toBe(100);
    expect(saveBacktestResult).toHaveBeenCalledTimes(1);
    expect(savePerformanceMetrics).toHaveBeenCalledTimes(1);
  });
});
