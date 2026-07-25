/**
 * 20415 七彩虹同源回測結果驗證
 *
 * 此檔原本綁定已被原位取代的 SMA v3.00／金額止損語義。測試覆蓋保留，
 * 但改為驗證現在真正可執行的七線入場、盲人模式、百分比止盈、三道鐵幕
 * 與動態階梯層級上限。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { BacktestEngine } from "./services/backtest/backtestEngine";
import {
  getBacktestDatabase,
  type OHLCVRow,
} from "./services/backtest/backtestDatabase";
import { initStrategyStudio } from "./services/strategyStudio";

const TEST_SYMBOL = "RAINBOW-E2E-USDT";
const TEST_TF = "1m";
const START_DATE = Date.UTC(2025, 0, 1);
const CANDLE_COUNT = 7000;
const END_DATE = START_DATE + CANDLE_COUNT * 60_000;

function buildRainbowCandles(): OHLCVRow[] {
  const candles: OHLCVRow[] = [];
  const turningPoint = 4400;
  let previousClose = 1000;
  for (let index = 0; index < CANDLE_COUNT; index += 1) {
    const trend =
      index < turningPoint
        ? index * 0.08
        : turningPoint * 0.08 - (index - turningPoint) * 0.12;
    const close = 1000 + trend + Math.sin(index / 19) * 0.18;
    const open = previousClose;
    candles.push({
      symbol: TEST_SYMBOL,
      timeframe: TEST_TF,
      timestamp: START_DATE + index * 60_000,
      open,
      high: Math.max(open, close) + 0.12,
      low: Math.min(open, close) - 0.12,
      close,
      volume: 100 + Math.abs(Math.sin(index / 13)) * 25,
    });
    previousClose = close;
  }
  return candles;
}

async function runRainbow(config: Record<string, unknown> = {}) {
  return new BacktestEngine().runBacktest({
    strategyKey: "strategy_20415",
    symbol: TEST_SYMBOL,
    timeframe: TEST_TF,
    startDate: START_DATE,
    endDate: END_DATE,
    initialCapital: 10_000,
    config,
  });
}

describe("20415 七彩虹同源回測結果驗證", () => {
  beforeAll(async () => {
    await initStrategyStudio();
    getBacktestDatabase().insertOHLCV(buildRainbowCandles());
  });

  it("七線同向且排名不變時能在已收盤 M30 產生交易", async () => {
    const result = await runRainbow();
    expect(result.strategyKey).toBe("strategy_20415");
    expect(result.strategyName).toBe("20415七彩虹馬丁策略");
    expect(result.trades.length).toBeGreaterThan(0);
  }, 120_000);

  it("平均成本百分比止盈能正確觸發", async () => {
    const result = await runRainbow({
      Take_Profit_Pct: 0.05,
      Reentry_Enabled: false,
    });
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades.some((trade) => trade.exitReason.includes("止盈"))).toBe(true);
  }, 120_000);

  it("Max_Hold_Hours 持倉時間鐵幕能正確觸發", async () => {
    const result = await runRainbow({
      Take_Profit_Pct: 20,
      Max_Hold_Hours: 1,
      Reentry_Enabled: false,
    });
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades.some((trade) => trade.exitReason.includes("持倉超時"))).toBe(true);
  }, 120_000);

  it("盲人模式持倉期間不因七線交叉或方向變化平倉轉向", async () => {
    const result = await runRainbow({
      Take_Profit_Pct: 20,
      Max_Hold_Hours: 168,
      Reentry_Enabled: false,
    });
    expect(result.trades.length).toBeGreaterThan(0);
    expect(
      result.trades.some((trade) => /七線|交叉|反向/.test(trade.exitReason)),
    ).toBe(false);
  }, 120_000);

  it("動態階梯的最終層限制不會被回測引擎突破", async () => {
    const result = await runRainbow({
      Take_Profit_Pct: 20,
      Max_Hold_Hours: 168,
      Max_Margin_Usage_Pct: 100,
      Max_Account_Loss_Pct: 100,
      Reentry_Enabled: false,
      Martin_Ranges: [
        {
          id: "test-range-1-2",
          startLayer: 1,
          endLayer: 2,
          multiplier: 1.2,
          useGlobalSpacing: false,
          spacingPct: 0.05,
          enabled: true,
        },
      ],
    });

    expect(result.trades.length).toBeGreaterThan(0);
    expect(Math.max(...result.trades.map((trade) => trade.martinLayer))).toBeLessThanOrEqual(1);
  }, 120_000);
});
