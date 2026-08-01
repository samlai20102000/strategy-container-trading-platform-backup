/**
 * 回測模塊測試（pasted_content_4.txt 任務 13）
 * 覆蓋：時間框架解析器、績效計算器、SQLite 數據層、參數組合生成、KAMA 一致性
 */

import { describe, expect, it } from "vitest";
import {
  parseTimeframe,
  isValidTimeframe,
  getSupportedTimeframes,
  convertToOKXFormat,
  convertToBybitFormat,
} from "./services/backtest/timeframeParser";
import {
  calculatePerformance,
  type TradeRecord,
  type EquityPoint,
} from "./services/backtest/performanceCalculator";
import { generateCombinations } from "./services/backtest/optimizer";
import { calculateKAMASeries, calculateKAMA } from "./services/backtest/kama";
import { getBacktestDatabase } from "./services/backtest/backtestDatabase";

/* ==================== 時間框架解析器 ==================== */
describe("timeframeParser", () => {
  it("解析標準時間框架", () => {
    expect(parseTimeframe("1m").totalSeconds).toBe(60);
    expect(parseTimeframe("15m").totalSeconds).toBe(15 * 60);
    expect(parseTimeframe("1h").totalSeconds).toBe(3600);
    expect(parseTimeframe("4h").totalSeconds).toBe(4 * 3600);
    expect(parseTimeframe("1d").totalSeconds).toBe(86400);
  });

  it("拒絕無效格式", () => {
    expect(isValidTimeframe("abc")).toBe(false);
    expect(isValidTimeframe("0m")).toBe(false);
    expect(isValidTimeframe("")).toBe(false);
    expect(isValidTimeframe("1x")).toBe(false);
  });

  it("支援清單包含常用時間框架", () => {
    const tfs = getSupportedTimeframes();
    expect(tfs.minutes).toContain(15);
    expect(tfs.hours).toContain(4);
    expect(tfs.days).toContain(1);
  });

  it("轉換為 OKX / Bybit API 格式", () => {
    expect(convertToOKXFormat("15m")).toBe("15m");
    expect(convertToOKXFormat("1h")).toBe("1H");
    expect(convertToOKXFormat("1d")).toBe("1D");
    expect(convertToBybitFormat("15m")).toBe("15");
    expect(convertToBybitFormat("1h")).toBe("60");
    expect(convertToBybitFormat("1d")).toBe("D");
  });
});

/* ==================== 績效計算器 ==================== */
describe("performanceCalculator", () => {
  const mkTrade = (pnl: number, i: number, martinLayer = 0): TradeRecord => ({
    entryTime: 1700000000000 + i * 3600_000,
    exitTime: 1700000000000 + (i + 1) * 3600_000,
    side: "long",
    entryPrice: 100,
    exitPrice: 100 + pnl,
    size: 1,
    pnl,
    pnlPct: pnl,
    exitReason: "trailing_tp",
    martinLayer,
  });

  it("計算基本指標（勝率/總回報/利潤因子）", () => {
    const trades = [mkTrade(10, 0), mkTrade(-5, 1), mkTrade(20, 2), mkTrade(-10, 3)];
    const equity: EquityPoint[] = [
      { timestamp: 1700000000000, equity: 10000, price: 100 },
      { timestamp: 1700003600000, equity: 10010, price: 110 },
      { timestamp: 1700007200000, equity: 10005, price: 95 },
      { timestamp: 1700010800000, equity: 10025, price: 120 },
      { timestamp: 1700014400000, equity: 10015, price: 90 },
    ];
    const m = calculatePerformance(trades, equity, 10000);
    expect(m.totalTrades).toBe(4);
    expect(m.winningTrades).toBe(2);
    expect(m.losingTrades).toBe(2);
    expect(m.winRate).toBe(50);
    expect(m.totalReturnUSDT).toBeCloseTo(15, 1);
    expect(m.profitFactor).toBeCloseTo(30 / 15, 1);
  });

  it("計算最大回撤", () => {
    const equity: EquityPoint[] = [
      { timestamp: 1, equity: 10000, price: 1 },
      { timestamp: 2, equity: 12000, price: 1 },
      { timestamp: 3, equity: 9000, price: 1 }, // 從 12000 回撤 25%
      { timestamp: 4, equity: 11000, price: 1 },
    ];
    const m = calculatePerformance([mkTrade(1000, 0)], equity, 10000);
    expect(m.maxDrawdown).toBeCloseTo(25, 0);
    expect(m.maxDrawdownUSDT).toBeCloseTo(3000, 0);
  });

  it("有限責任回測遇到負權益輸入時，總報酬與最大回撤分別下限／上限為 100%", () => {
    const equity: EquityPoint[] = [
      { timestamp: 1, equity: 10_000, price: 100 },
      { timestamp: 2, equity: -2_500, price: 1 },
    ];
    const m = calculatePerformance([mkTrade(-12_500, 0)], equity, 10_000);

    expect(m.totalReturn).toBe(-100);
    expect(m.totalReturnUSDT).toBe(-10_000);
    expect(m.maxDrawdown).toBe(100);
    expect(m.maxDrawdownUSDT).toBe(10_000);
  });

  it("空交易清單不拋錯", () => {
    const m = calculatePerformance([], [], 10000);
    expect(m.totalTrades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.sharpeRatio).toBe(0);
  });

  it("統計馬丁觸發次數與最大層數", () => {
    const trades = [mkTrade(5, 0, 2), mkTrade(5, 1, 0), mkTrade(-5, 2, 4)];
    const m = calculatePerformance(trades, [], 10000);
    expect(m.martinTriggerCount).toBe(2);
    expect(m.maxMartinLayer).toBe(4);
  });
});

/* ==================== KAMA 一致性 ==================== */
describe("kama (與 V3.5 實盤邏輯一致)", () => {
  it("計算 KAMA 序列（長度一致，趨勢跟隨）", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
    const series = calculateKAMASeries(closes, 10, 2, 30);
    expect(series.length).toBe(closes.length);
    expect(series[5]).toBeNull(); // 前 length 根無值
    const k20 = series[20] as number;
    const k59 = series[59] as number;
    expect(k59).toBeGreaterThan(k20); // 上升趨勢跟隨
    expect(k59).toBeLessThanOrEqual(closes[59]);
  });

  it("價格橫盤時 KAMA 變化平緩", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 0.1 : -0.1));
    const series = calculateKAMASeries(closes, 10, 2, 30);
    const delta = Math.abs((series[59] as number) - (series[30] as number));
    expect(delta).toBeLessThan(1);
  });

  it("calculateKAMA 便利函數回傳最後值", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
    const last = calculateKAMA(closes, 10, 2, 30);
    const series = calculateKAMASeries(closes, 10, 2, 30);
    expect(last).toBe(series[series.length - 1]);
  });
});

/* ==================== SQLite 數據層 ==================== */
describe("backtestDatabase (SQLite)", () => {
  const runTs = Date.now();
  const testSymbol = `TEST-${runTs}`;

  it("插入與讀取 OHLCV 數據（去重）", () => {
    const db = getBacktestDatabase();
    const rows = Array.from({ length: 5 }, (_, i) => ({
      symbol: testSymbol,
      timeframe: "1m",
      timestamp: runTs + i * 60_000,
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 10,
    }));
    const inserted = db.insertOHLCV(rows);
    expect(inserted).toBe(5);
    // 重複插入被 INSERT OR REPLACE 去重
    db.insertOHLCV(rows);
    const read = db.getOHLCV(testSymbol, "1m", runTs, runTs + 10 * 60_000);
    expect(read.length).toBe(5);
    expect(read[0].close).toBe(105);
    expect(db.countOHLCV(testSymbol, "1m", runTs, runTs + 10 * 60_000)).toBe(5);
  });

  it("保存與讀取回測記錄（含交易明細與績效）", () => {
    const db = getBacktestDatabase();
    const runId = `test_run_${runTs}`;
    db.saveBacktestResult(
      {
        run_id: runId,
        strategy_key: "20415_KAMA_MARTIN_V35",
        symbol: testSymbol,
        timeframe: "1h",
        start_date: runTs,
        end_date: runTs + 86400000,
        initial_capital: 10000,
        config: JSON.stringify({ Fast_Period: 8 }),
        status: "completed",
        created_at: Date.now(),
      },
      [
        {
          entryTime: runTs,
          exitTime: runTs + 3600_000,
          side: "long",
          entryPrice: 100,
          exitPrice: 105,
          size: 1,
          pnl: 5,
          pnlPct: 5,
          exitReason: "trailing_tp",
          martinLayer: 0,
        },
      ],
    );
    db.savePerformanceMetrics(runId, { totalReturn: 5 }, [
      { timestamp: runTs, equity: 10000, price: 100 },
    ]);

    const run = db.getBacktestRun(runId);
    expect(run).toBeTruthy();
    expect(run!.strategy_key).toBe("20415_KAMA_MARTIN_V35");
    expect((JSON.parse(run!.config) as Record<string, unknown>).Fast_Period).toBe(8);

    const trades = db.getBacktestTrades(runId);
    expect(trades.length).toBe(1);
    expect(trades[0].pnl).toBe(5);

    const perf = db.getPerformanceMetrics(runId);
    expect(perf).not.toBeNull();
    expect((perf!.metrics as Record<string, unknown>).totalReturn).toBe(5);
  });

  it("保存 finalized 三模式 artifact 並可完整讀回", () => {
    const db = getBacktestDatabase();
    const runId = `test_three_mode_run_${runTs}`;
    const executionContext = {
      executionMode: "HEDGE_GUARDED",
      executionPolicyVersion: "execution-policy-v1",
      strategyLogicHash: "sha256:test-strategy",
      comparisonGroupId: "comparison:test",
      engineVersion: "backtest-engine-v3",
    };
    const modeResults = {
      executionMode: "HEDGE_GUARDED",
      fairComparisonEligible: true,
      hedgeCost: 1.25,
    };
    const legAccounting = {
      executionMode: "HEDGE_GUARDED",
      legs: [{ legId: "primary-1", role: "PRIMARY", realizedPnl: 12.5 }],
      hedgeRelationships: [{ relationshipId: "hedge-1", pairPnl: 11.25 }],
    };

    db.saveFinalizedBacktestResult({
      run: {
        run_id: runId,
        strategy_key: "KAMA_3K_HF_V61",
        symbol: testSymbol,
        timeframe: "15m",
        start_date: runTs,
        end_date: runTs + 86_400_000,
        initial_capital: 10_000,
        config: JSON.stringify({ KAMA_Fast_Length: 21 }),
        status: "completed",
        created_at: Date.now(),
        execution_context: JSON.stringify(executionContext),
        mode_results: JSON.stringify(modeResults),
        leg_accounting: JSON.stringify(legAccounting),
      },
      trades: [],
      metrics: { totalReturn: 0.1125 },
      equityCurve: [{ timestamp: runTs, equity: 10_011.25, price: 100 }],
    });

    const run = db.getBacktestRun(runId);
    expect(JSON.parse(run!.execution_context!)).toEqual(executionContext);
    expect(JSON.parse(run!.mode_results!)).toEqual(modeResults);
    expect(JSON.parse(run!.leg_accounting!)).toEqual(legAccounting);
    expect(db.getPerformanceMetrics(runId)?.metrics).toEqual({ totalReturn: 0.1125 });
  });

  it("可用交易對清單包含測試交易對", () => {
    const db = getBacktestDatabase();
    expect(db.getAvailableSymbols()).toContain(testSymbol);
    expect(db.getAvailableTimeframes(testSymbol)).toContain("1m");
  });
});

/* ==================== 參數組合生成 ==================== */
describe("optimizer.generateCombinations", () => {
  it("單參數範圍", () => {
    const combos = generateCombinations([{ name: "Fast_Period", min: 6, max: 10, step: 2 }]);
    expect(combos.length).toBe(3);
    expect(combos[0].Fast_Period).toBe(6);
    expect(combos[2].Fast_Period).toBe(10);
  });

  it("雙參數笛卡爾積", () => {
    const combos = generateCombinations([
      { name: "a", min: 1, max: 2, step: 1 },
      { name: "b", min: 10, max: 30, step: 10 },
    ]);
    expect(combos.length).toBe(6);
    expect(combos.some((c) => c.a === 2 && c.b === 30)).toBe(true);
  });

  it("浮點步長無誤差", () => {
    const combos = generateCombinations([{ name: "x", min: 0.1, max: 0.3, step: 0.1 }]);
    expect(combos.length).toBe(3);
    expect(combos[1].x).toBeCloseTo(0.2, 10);
  });

  it("空範圍回傳空", () => {
    expect(generateCombinations([]).length).toBe(0);
  });
});
