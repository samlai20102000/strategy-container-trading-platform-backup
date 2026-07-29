import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { backtestJobs } from "../drizzle/schema";
import {
  backtestRequestSchema,
  backtestSettingsSchema,
} from "./routers/backtest.router";
import {
  BacktestEngine,
  type BacktestRequest,
  type BacktestResult,
} from "./services/backtest/backtestEngine";
import type { OHLCVRow } from "./services/backtest/backtestDatabase";
import {
  BACKTEST_ENGINE_VERSION,
  V25_END_OF_DATA_EXIT_REASON,
  buildAccountingSnapshot,
  buildBacktestAccountingSnapshot,
  buildOpenPositionSnapshot,
  normalizeBacktestEndPositionPolicy,
  normalizeOHLCVData,
  type BacktestDataQuality,
} from "./services/backtest/backtestContracts";
import { buildBacktestResultPersistence } from "./services/backtest/backtestJobManager";

const START = 1_700_000_000_000;
const MINUTE = 60_000;

function candle(timestamp: number, close = 100): OHLCVRow {
  return {
    symbol: "V25-CONTRACT-USDT",
    timeframe: "1m",
    timestamp,
    open: close - 0.2,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 100,
  };
}

function qualityFixture(): BacktestDataQuality {
  return normalizeOHLCVData([candle(START)], {
    startMs: START,
    endMs: START + MINUTE,
    timeframeMs: MINUTE,
    nowMs: START + 2 * MINUTE,
  }).quality;
}

const requestFixture: BacktestRequest = {
  strategyKey: "20415_KAMA_MARTIN_V35",
  symbol: "V25-CONTRACT-USDT",
  timeframe: "1m",
  startDate: START,
  endDate: START + MINUTE,
  initialCapital: 1_000,
  config: {},
  exchange: "okx",
};

type V25Finalizer = {
  finalizeV25Result: (
    result: BacktestResult,
    request: BacktestRequest,
    startMs: number,
    endMs: number,
    quality: BacktestDataQuality,
  ) => BacktestResult;
};

function finalize(result: BacktestResult, request: BacktestRequest = requestFixture) {
  return (new BacktestEngine() as unknown as V25Finalizer).finalizeV25Result(
    result,
    request,
    START,
    START + MINUTE,
    qualityFixture(),
  );
}

function resultFixture(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    runId: "run_v25_contract",
    strategyKey: requestFixture.strategyKey,
    strategyName: "V2.5 契約測試",
    trades: [],
    metrics: {} as BacktestResult["metrics"],
    equityCurve: [{ timestamp: START, equity: 1_000, price: 100 }],
    config: {},
    summary: "完成",
    candleCount: 1,
    ...overrides,
  };
}

describe("回測 V2.5｜半開區間與資料品質", () => {
  it("統一 [start,end) 並排序、去重、排除無效與未收盤 K 棒", () => {
    const duplicateOriginal = candle(START, 100);
    const duplicateReplacement = candle(START, 101);
    const invalid = { ...candle(START + MINUTE), high: 1 };
    const unclosed = candle(START + 2 * MINUTE, 102);
    const endBoundary = candle(START + 3 * MINUTE, 103);
    const beforeStart = candle(START - MINUTE, 99);

    const normalized = normalizeOHLCVData(
      [endBoundary, unclosed, invalid, duplicateOriginal, beforeStart, duplicateReplacement],
      {
        startMs: START,
        endMs: START + 3 * MINUTE,
        timeframeMs: MINUTE,
        nowMs: START + 2.5 * MINUTE,
      },
    );

    expect(normalized.candles).toHaveLength(1);
    expect(normalized.candles[0]).toMatchObject({ timestamp: START, close: 101 });
    expect(normalized.quality).toMatchObject({
      intervalContract: "[start,end)",
      inputCandles: 6,
      returnedCandles: 1,
      candleCount: 1,
      duplicateCandlesRemoved: 1,
      outOfRangeCandlesRemoved: 2,
      invalidCandlesRemoved: 1,
      unclosedCandlesRemoved: 1,
      firstTimestamp: START,
      lastTimestamp: START,
      sortedAscending: true,
    });
  });
});

describe("回測 V2.5｜單一權益帳本與終點政策", () => {
  it("終點政策預設為 mark_to_market，且只接受明確 force_close 別名", () => {
    expect(normalizeBacktestEndPositionPolicy(undefined)).toBe("mark_to_market");
    expect(normalizeBacktestEndPositionPolicy("unknown")).toBe("mark_to_market");
    expect(normalizeBacktestEndPositionPolicy("force-close")).toBe("force_close");
    expect(normalizeBacktestEndPositionPolicy("force close")).toBe("force_close");
  });

  it("按市價估值保留未平倉與未實現損益，帳本精確對平", () => {
    const openPosition = buildOpenPositionSnapshot({
      side: "long",
      entryTime: START,
      avgPrice: 100,
      totalSize: 2,
      layers: [{ price: 100, size: 2, time: START }],
    }, 110, 0.001);
    const accounting = buildBacktestAccountingSnapshot({
      initialCapital: 1_000,
      tradePnls: [-5],
      openPosition,
    });

    expect(openPosition).toMatchObject({
      entryNotional: 200,
      entryFees: 0.2,
      unrealizedGrossPnl: 20,
      unrealizedPnl: 19.8,
    });
    expect(accounting).toMatchObject({
      realizedPnl: -5,
      unrealizedPnl: 19.8,
      finalEquity: 1_014.8,
      expectedFinalEquity: 1_014.8,
      reconciliationDifference: 0,
      openPositionCount: 1,
      syntheticForceCloseCount: 0,
      reconciled: true,
    });
  });

  it("mark_to_market 經共同守門器保留未平倉，並附加連續 Session 語意", () => {
    const accounting = buildAccountingSnapshot({
      initialCapital: 1_000,
      trades: [],
      unrealizedPnl: 10,
      finalEquity: 1_010,
      openPositionCount: 1,
      syntheticForceCloseCount: 0,
    });
    const result = finalize(resultFixture({
      endPositionPolicy: "mark_to_market",
      accounting,
      equityCurve: [{ timestamp: START, equity: 1_010, price: 110 }],
    }));

    expect(result.endPositionPolicy).toBe("mark_to_market");
    expect(result.accounting).toMatchObject({
      openPositionCount: 1,
      unrealizedPnl: 10,
      syntheticForceCloseCount: 0,
      reconciled: true,
    });
    expect(result.engineSemantics).toEqual({
      version: BACKTEST_ENGINE_VERSION,
      sessionMode: "continuous",
      dataSlicing: "half_open",
      finalizationScope: "global_end_only",
      defaultEndPositionPolicy: "mark_to_market",
    });
    expect(result.dataQuality?.intervalContract).toBe("[start,end)");
  });

  it("force_close 只接受一筆標準全域終點合成平倉，完成後不得留未實現損益", () => {
    const forceCloseTrade = {
      entryTime: START,
      exitTime: START + MINUTE - 1,
      side: "long" as const,
      entryPrice: 100,
      exitPrice: 110,
      size: 1,
      pnl: 10,
      pnlPct: 10,
      exitReason: V25_END_OF_DATA_EXIT_REASON,
      martinLayer: 0,
    };
    const accounting = buildAccountingSnapshot({
      initialCapital: 1_000,
      trades: [forceCloseTrade],
      unrealizedPnl: 0,
      finalEquity: 1_010,
      openPositionCount: 0,
      syntheticForceCloseCount: 1,
    });
    const result = finalize(resultFixture({
      endPositionPolicy: "force_close",
      trades: [forceCloseTrade],
      accounting,
      equityCurve: [{ timestamp: START, equity: 1_010, price: 110 }],
    }), { ...requestFixture, endPositionPolicy: "force_close" });

    expect(result.endPositionPolicy).toBe("force_close");
    expect(result.accounting).toMatchObject({
      openPositionCount: 0,
      unrealizedPnl: 0,
      syntheticForceCloseCount: 1,
      reconciled: true,
    });
  });

  it("共同守門器阻擋政策與帳本不一致", () => {
    const syntheticTrade = {
      entryTime: START,
      exitTime: START + MINUTE - 1,
      side: "long" as const,
      entryPrice: 100,
      exitPrice: 100,
      size: 1,
      pnl: 0,
      pnlPct: 0,
      exitReason: V25_END_OF_DATA_EXIT_REASON,
      martinLayer: 0,
    };
    expect(() => finalize(resultFixture({
      endPositionPolicy: "mark_to_market",
      trades: [syntheticTrade],
      accounting: buildAccountingSnapshot({
        initialCapital: 1_000,
        trades: [syntheticTrade],
        unrealizedPnl: 0,
        finalEquity: 1_000,
        openPositionCount: 0,
        syntheticForceCloseCount: 1,
      }),
    }))).toThrow("mark_to_market");

    expect(() => finalize(resultFixture({
      endPositionPolicy: "force_close",
      accounting: buildAccountingSnapshot({
        initialCapital: 1_000,
        trades: [],
        unrealizedPnl: 10,
        finalEquity: 1_010,
        openPositionCount: 1,
        syntheticForceCloseCount: 0,
      }),
      equityCurve: [{ timestamp: START, equity: 1_010, price: 110 }],
    }), { ...requestFixture, endPositionPolicy: "force_close" })).toThrow("不得保留未平倉");
  });

  it.each([
    "strategy_20415",
    "RAINBOW_TREND_LADDER_V1",
    "KAMA_3K_BREAKOUT_V25",
    "20415_KAMA_MARTIN_V35",
    "KAMA_3K_ULTIMATE_V50",
    "KAMA_3K_HF_V61",
    "KAMA_3K_TORNADO_V70",
  ])("%s 共用連續 Session 與單一對平帳本", (strategyKey) => {
    const accounting = buildAccountingSnapshot({
      initialCapital: 1_000,
      trades: [],
      unrealizedPnl: 0,
      finalEquity: 1_000,
      openPositionCount: 0,
      syntheticForceCloseCount: 0,
    });
    const result = finalize(
      resultFixture({ strategyKey, accounting, endPositionPolicy: "mark_to_market" }),
      { ...requestFixture, strategyKey },
    );

    expect(result.accounting?.reconciled).toBe(true);
    expect(result.accounting?.reconciliationDifference).toBe(0);
    expect(result.engineSemantics?.sessionMode).toBe("continuous");
    expect(result.engineSemantics?.finalizationScope).toBe("global_end_only");
  });
});

describe("回測 V2.5｜API 與主資料庫持久化契約", () => {
  const apiBase = {
    strategyKey: "20415_KAMA_MARTIN_V35",
    symbol: "BTC-USDT-SWAP",
    timeframe: "15m",
    startDate: START,
    endDate: START + 10 * MINUTE,
  };
  const settingsBase = {
    exchange: "okx",
    symbol: "BTC-USDT-SWAP",
    timeframe: "15m",
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    initialCapital: 10_000,
  };

  it("任務與快照 API 皆安全預設 mark_to_market，並無損保留 force_close", () => {
    expect(backtestRequestSchema.parse(apiBase).endPositionPolicy).toBe("mark_to_market");
    expect(backtestRequestSchema.parse({ ...apiBase, endPositionPolicy: "force_close" }).endPositionPolicy).toBe("force_close");
    expect(backtestSettingsSchema.parse(settingsBase).endPositionPolicy).toBe("mark_to_market");
    expect(backtestSettingsSchema.parse({ ...settingsBase, endPositionPolicy: "force_close" }).endPositionPolicy).toBe("force_close");
    expect(() => backtestRequestSchema.parse({ ...apiBase, endPositionPolicy: "invalid" })).toThrow();
  });

  it("backtest_jobs Drizzle 映射包含完整六個 V2.5 欄位", () => {
    const columns = getTableColumns(backtestJobs);
    expect(Object.keys(columns)).toEqual(expect.arrayContaining([
      "endPositionPolicy",
      "candleCount",
      "accounting",
      "dataQuality",
      "engineSemantics",
      "environment",
    ]));
  });

  it("完成任務時一次寫入政策、帳本、品質、語意與環境快照", () => {
    const quality = qualityFixture();
    const accounting = buildAccountingSnapshot({
      initialCapital: 1_000,
      trades: [],
      unrealizedPnl: 0,
      finalEquity: 1_000,
      openPositionCount: 0,
      syntheticForceCloseCount: 0,
    });
    const completedAt = new Date("2026-07-29T00:00:00.000Z");
    const result = resultFixture({
      endPositionPolicy: "force_close",
      candleCount: 1,
      accounting,
      dataQuality: quality,
      engineSemantics: {
        version: BACKTEST_ENGINE_VERSION,
        sessionMode: "continuous",
        dataSlicing: "half_open",
        finalizationScope: "global_end_only",
        defaultEndPositionPolicy: "mark_to_market",
      },
      environment: {
        dataHash: "sha256:test",
        engineVersion: BACKTEST_ENGINE_VERSION,
        leverage: 1,
        commission: 0.0004,
        slippage: 0.0001,
        startDate: START,
        endDate: START + MINUTE,
        candleCount: 1,
      },
    });
    const persisted = buildBacktestResultPersistence(
      result,
      { ...requestFixture, endPositionPolicy: "force_close" },
      START,
      completedAt,
    );

    expect(persisted).toMatchObject({
      status: "completed",
      progress: 100,
      endPositionPolicy: "force_close",
      candleCount: 1,
      accounting,
      dataQuality: quality,
      engineSemantics: result.engineSemantics,
      environment: result.environment,
      startedAt: new Date(START),
      completedAt,
    });
  });
});
