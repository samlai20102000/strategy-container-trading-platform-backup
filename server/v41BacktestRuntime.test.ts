import { describe, expect, it, vi } from "vitest";

vi.mock("./services/symbolMiddleware", () => ({
  prepareSymbolForExecution: vi.fn(async (symbol: string) => ({
    valid: true,
    normalized: symbol,
  })),
}));

vi.mock("./services/backtest/backtestDatabase", () => ({
  getBacktestDatabase: vi.fn(() => ({
    saveBacktestResult: vi.fn(),
    savePerformanceMetrics: vi.fn(),
  })),
}));

vi.mock("./db", () => ({
  listAllActiveStrategyDefinitions: vi.fn(async () => []),
}));

import {
  BacktestEngine,
  type BacktestRequest,
} from "./services/backtest/backtestEngine";
import { initStrategyStudio } from "./services/strategyStudio";
import {
  assertValidV41Config,
  createV41DefaultConfig,
  V41_STRATEGY_KEY,
} from "../shared/strategies/kama3kMartinV41";
import type { BacktestDataQuality } from "./services/backtest/backtestContracts";

function makeCandles(count: number, startMs: number, timeframeMs: number) {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index * 0.2;
    const close = open + 0.15;
    return {
      timestamp: startMs + index * timeframeMs,
      open,
      high: close + 0.1,
      low: open - 0.1,
      close,
      volume: 1000 + index,
    };
  });
}

function qualityFor(candles: ReturnType<typeof makeCandles>, startMs: number, endMs: number): BacktestDataQuality {
  return {
    intervalContract: "[start,end)",
    requestedStartMs: startMs,
    requestedEndMs: endMs,
    inputCandles: candles.length,
    returnedCandles: candles.length,
    candleCount: candles.length,
    duplicateCandlesRemoved: 0,
    duplicateTimestampCount: 0,
    outOfRangeCandlesRemoved: 0,
    outOfRangeCount: 0,
    invalidCandlesRemoved: 0,
    invalidCandleCount: 0,
    unclosedCandlesRemoved: 0,
    unclosedCandleCount: 0,
    firstTimestamp: candles[0]?.timestamp ?? null,
    lastTimestamp: candles.at(-1)?.timestamp ?? null,
    sortedAscending: true,
  };
}

describe("V4.1 主回測引擎 runtime", () => {
  it("以合成已收盤行情執行 V4.1 專屬路徑並輸出三票診斷", async () => {
    await initStrategyStudio();
    const timeframeMs = 30 * 60 * 1000;
    const startMs = 1_700_000_000_000;
    const candles = makeCandles(160, startMs, timeframeMs);
    const endMs = startMs + candles.length * timeframeMs;
    const config = assertValidV41Config({
      ...createV41DefaultConfig(),
      enableKamaFastSlowCross: false,
      enableKamaPriceVsSlow: true,
      KAMA_Fast_Length: 5,
      KAMA_Slow_Length: 10,
      Target_TP_Pct: 20,
      Max_Loss_Pct: 20,
      enableSameDirectionReentry: false,
    });
    const engine = new BacktestEngine();
    vi.spyOn(engine as any, "loadContinuousCandles").mockResolvedValue({
      candles,
      quality: qualityFor(candles, startMs, endMs),
    });
    const request: BacktestRequest = {
      strategyKey: V41_STRATEGY_KEY,
      symbol: "BTC-USDT-SWAP",
      timeframe: "30m",
      startDate: startMs,
      endDate: endMs,
      initialCapital: 10_000,
      config,
      exchange: "okx",
      endPositionPolicy: "mark_to_market",
    };

    const result = await engine.runBacktest(request);
    const diagnostics = result.environment?.v41EntryDiagnostics;

    expect(result.strategyKey).toBe(V41_STRATEGY_KEY);
    expect(result.config).toEqual(config);
    expect(result.candleCount).toBe(candles.length);
    expect(result.dataQuality?.unclosedCandlesRemoved).toBe(0);
    expect(result.accounting?.balanced).toBe(true);
    expect(diagnostics?.strategyKey).toBe(V41_STRATEGY_KEY);
    expect(diagnostics?.entryConditionLogic).toBe("and");
    expect(diagnostics?.enabledConditionCount).toBe(1);
    expect(diagnostics?.evaluatedBars).toBeGreaterThan(0);
    expect(diagnostics?.voteStatusCounts.price_vs_slow.long).toBeGreaterThan(0);
    expect(diagnostics?.openedSignals).toBeGreaterThan(0);
  });
});
