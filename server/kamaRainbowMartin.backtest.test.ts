import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  createKamaRainbowMartinDefaultConfig,
  createKamaRainbowMartinLineSetReceipt,
  type KamaRainbowMartinBacktestEndPositionPolicy,
} from "../shared/strategies/kamaRainbowMartin";
import { V25_END_OF_DATA_EXIT_REASON } from "./services/backtest/backtestContracts";
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

import { runKamaRainbowMartinBacktest } from "./services/backtest/kamaRainbowMartinBacktest";

function makeTrendingCandles(count = 42): OHLCVRow[] {
  const start = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    return {
      symbol: "BTC-USDT",
      timeframe: "30m",
      timestamp: start + index * 30 * 60_000,
      open: close - 0.25,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1,
    };
  });
}

function makeTrailingReentryCandles(): OHLCVRow[] {
  const candles = makeTrendingCandles(21);
  const start = candles[0].timestamp;
  for (const [offset, close] of [130, 127.5].entries()) {
    candles.push({
      symbol: "BTC-USDT",
      timeframe: "30m",
      timestamp: start + (21 + offset) * 30 * 60_000,
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1,
    });
  }
  return candles;
}

function makeConfig(policy: KamaRainbowMartinBacktestEndPositionPolicy) {
  return {
    ...createKamaRainbowMartinDefaultConfig(),
    backtestEndPositionPolicy: policy,
    Position_Size_Value: 100,
    Position_Size_Mode: "usdt",
  };
}

function makeRequest(candles: OHLCVRow[], policy: KamaRainbowMartinBacktestEndPositionPolicy): BacktestRequest {
  return {
    strategyKey: KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
    symbol: "BTC-USDT",
    timeframe: "30m",
    startDate: candles[0].timestamp,
    endDate: candles.at(-1)!.timestamp,
    initialCapital: 10_000,
    commission: 0,
    slippage: 0,
    config: makeConfig(policy),
    exchange: "okx",
  };
}

function makeSixLineRequest(candles: OHLCVRow[]): BacktestRequest {
  const request = makeRequest(candles, "mark_to_market");
  const config = makeConfig("mark_to_market");
  config.kamaLines = Array.from({ length: 6 }, (_, index) => ({
    id: `KAMA_${index + 1}`,
    name: `KAMA ${index + 1}`,
    enabled: true,
    erPeriod: 5 + index * 2,
    fastEma: 2,
    slowEma: 30 + index,
    color: `#${(index + 1).toString(16).padStart(6, "0")}`,
  }));
  request.config = config;
  return request;
}

describe("Kama 彩虹馬丁同源回測", () => {
  beforeEach(() => {
    saveBacktestResult.mockClear();
    savePerformanceMetrics.mockClear();
  });

  it("只使用已收盤 canonical timeframe，mark-to-market 保留終點持倉並完成單一帳本對帳", async () => {
    const candles = makeTrendingCandles();
    const request = makeRequest(candles, "mark_to_market");
    const progress: Array<{ pct: number; message: string }> = [];

    const result = await runKamaRainbowMartinBacktest(
      request,
      "Kama彩虹馬丁策略",
      request.config,
      candles,
      request.startDate,
      request.endDate,
      0,
      0,
      (pct, message) => progress.push({ pct, message }),
    );

    expect(result.strategyKey).toBe(KAMA_RAINBOW_MARTIN_STRATEGY_KEY);
    expect(result.candleCount).toBe(candles.length);
    expect(result.config.timeframe).toBe("M30");
    expect(result.endPositionPolicy).toBe("mark_to_market");
    expect(result.session.closedCandles).toHaveLength(candles.length);
    expect(result.session.positionMeta?.layers).toHaveLength(1);
    expect(result.accounting.openPositionCount).toBe(1);
    expect(result.accounting.syntheticForceCloseCount).toBe(0);
    expect(result.accounting.reconciled).toBe(true);
    expect(result.equityCurve.at(-1)?.timestamp).toBe(candles.at(-1)?.timestamp);
    expect(progress.at(-1)?.pct).toBe(100);
    expect(saveBacktestResult).toHaveBeenCalledTimes(1);
    expect(savePerformanceMetrics).toHaveBeenCalledTimes(1);
  });

  it("六線回測完整保留第 3–6 條，receipt 與 live-binding canonical hash 一致", async () => {
    const candles = makeTrendingCandles(80);
    const request = makeSixLineRequest(candles);
    const expectedLiveReceipt = createKamaRainbowMartinLineSetReceipt(request.config, "live-binding");

    const result = await runKamaRainbowMartinBacktest(
      request,
      "Kama彩虹馬丁策略",
      request.config,
      candles,
      request.startDate,
      request.endDate,
      0,
      0,
    );

    expect((result.config.kamaLines as Array<{ id: string }>).map(line => line.id)).toEqual([
      "KAMA_1",
      "KAMA_2",
      "KAMA_3",
      "KAMA_4",
      "KAMA_5",
      "KAMA_6",
    ]);
    expect(result.lineSetReceipt).toMatchObject({
      source: "backtest-input",
      totalLineCount: 6,
      enabledLineCount: 6,
      enabledLineIds: expectedLiveReceipt.enabledLineIds,
      lineSetHash: expectedLiveReceipt.lineSetHash,
      configHash: expectedLiveReceipt.configHash,
    });
  });

  it("force-close 只在全域資料終點產生一筆合成平倉，且不保留未平倉部位", async () => {
    const candles = makeTrendingCandles();
    const request = makeRequest(candles, "force_close");

    const result = await runKamaRainbowMartinBacktest(
      request,
      "Kama彩虹馬丁策略",
      request.config,
      candles,
      request.startDate,
      request.endDate,
      0,
      0,
    );

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe(V25_END_OF_DATA_EXIT_REASON);
    expect(result.trades[0].exitTime).toBe(candles.at(-1)?.timestamp);
    expect(result.accounting.openPositionCount).toBe(0);
    expect(result.accounting.openPosition).toBeNull();
    expect(result.accounting.syntheticForceCloseCount).toBe(1);
    expect(result.accounting.reconciled).toBe(true);
    expect(result.session.positionMeta).toBeNull();
  });

  it("追蹤止盈平倉後，開啟自動重入會在同棒條件仍成立時重開，關閉則保持空倉", async () => {
    const candles = makeTrailingReentryCandles();
    const enabledRequest = makeRequest(candles, "mark_to_market");
    enabledRequest.config = { ...enabledRequest.config, reentryEnabled: true };
    const enabled = await runKamaRainbowMartinBacktest(
      enabledRequest,
      "Kama彩虹馬丁策略",
      enabledRequest.config,
      candles,
      enabledRequest.startDate,
      enabledRequest.endDate,
      0,
      0,
    );

    const disabledRequest = makeRequest(candles, "mark_to_market");
    const disabled = await runKamaRainbowMartinBacktest(
      disabledRequest,
      "Kama彩虹馬丁策略",
      disabledRequest.config,
      candles,
      disabledRequest.startDate,
      disabledRequest.endDate,
      0,
      0,
    );

    expect(enabled.trades).toHaveLength(1);
    expect(enabled.session.positionMeta).not.toBeNull();
    expect(enabled.accounting.openPositionCount).toBe(1);
    expect(disabled.trades).toHaveLength(1);
    expect(disabled.session.positionMeta).toBeNull();
    expect(disabled.accounting.openPositionCount).toBe(0);
  });

  it("跨分片續跑與單次回測完全等價，中間片不結算也不持久化", async () => {
    const candles = makeTrendingCandles();
    const request = makeRequest(candles, "force_close");
    const oneShot = await runKamaRainbowMartinBacktest(
      request,
      "Kama彩虹馬丁策略",
      request.config,
      candles,
      request.startDate,
      request.endDate,
      0,
      0,
    );

    saveBacktestResult.mockClear();
    savePerformanceMetrics.mockClear();
    const splitIndex = 21;
    const firstSlice = candles.slice(0, splitIndex);
    const secondSlice = candles.slice(splitIndex);
    const partial = await runKamaRainbowMartinBacktest(
      request,
      "Kama彩虹馬丁策略",
      request.config,
      firstSlice,
      firstSlice[0].timestamp,
      firstSlice.at(-1)!.timestamp,
      0,
      0,
      undefined,
      { finalize: false },
    );

    expect(partial.session.candleCount).toBe(firstSlice.length);
    expect(saveBacktestResult).not.toHaveBeenCalled();
    expect(savePerformanceMetrics).not.toHaveBeenCalled();

    const segmented = await runKamaRainbowMartinBacktest(
      request,
      "Kama彩虹馬丁策略",
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
    expect(segmented.accounting).toEqual(oneShot.accounting);
    expect(segmented.session.state).toEqual(oneShot.session.state);
    expect(segmented.session.positionMeta).toEqual(oneShot.session.positionMeta);
    expect(segmented.session.closedCandles).toEqual(oneShot.session.closedCandles);
    expect(segmented.session.equityCurve).toEqual(oneShot.session.equityCurve);
    expect(saveBacktestResult).toHaveBeenCalledTimes(1);
    expect(savePerformanceMetrics).toHaveBeenCalledTimes(1);
  });
});
