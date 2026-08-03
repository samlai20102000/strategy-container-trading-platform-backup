import { describe, expect, it } from "vitest";
import { calculatePerformance, type EquityPoint, type TradeRecord } from "./performanceCalculator";
import {
  BACKTEST_PERFORMANCE_METRIC_DESCRIPTIONS_ZH_TW,
  BACKTEST_PERFORMANCE_METRIC_SPEC,
} from "../../../shared/backtest/performanceMetricSpec";

const DAY_MS = 86_400_000;

function trade(id: number, pnl: number, martinLayer = 0): TradeRecord {
  return {
    id,
    entryTime: id * DAY_MS,
    exitTime: (id + 1) * DAY_MS,
    side: "long",
    entryPrice: 100,
    exitPrice: 100 + pnl,
    size: 1,
    pnl,
    pnlPct: pnl,
    exitReason: "ORACLE",
    martinLayer,
  };
}

function curve(values: number[], intervalMs = DAY_MS): EquityPoint[] {
  return values.map((equity, index) => ({
    timestamp: index * intervalMs,
    equity,
    price: 100,
  }));
}

describe("calculatePerformance metric spec v2", () => {
  it("uses valid closed trades including breakeven as the win-rate denominator", () => {
    const metrics = calculatePerformance(
      [trade(1, 100, 1), trade(2, -50), trade(3, 0), trade(4, Number.NaN)],
      [
        ...curve([1_000, 1_100, 1_050]),
        { timestamp: 3 * DAY_MS, equity: Number.NaN, price: 100 },
      ],
      1_000,
    );

    expect(metrics.totalReturn).toBe(5);
    expect(metrics.totalTrades).toBe(3);
    expect(metrics.winningTrades).toBe(1);
    expect(metrics.losingTrades).toBe(1);
    expect(metrics.breakEvenTrades).toBe(1);
    expect(metrics.winRate).toBe(33.33);
    expect(metrics.profitFactor).toBe(2);
    expect(metrics.profitFactorState).toBe("finite");
    expect(metrics.invalidTradeCount).toBe(1);
    expect(metrics.invalidEquityPointCount).toBe(1);
    expect(metrics.maxMartinLayer).toBe(1);
  });

  it("reports maximum drawdown as a positive peak-to-trough magnitude", () => {
    const metrics = calculatePerformance([], curve([100, 120, 90, 110]), 100);

    expect(metrics.maxDrawdown).toBe(25);
    expect(metrics.maxDrawdownUSDT).toBe(30);
  });

  it("keeps no-loss profit factor machine-safe while preserving its semantic state", () => {
    const metrics = calculatePerformance(
      [trade(1, 10), trade(2, 5)],
      curve([100, 110, 115]),
      100,
    );

    expect(metrics.profitFactor).toBe(999);
    expect(metrics.profitFactorState).toBe("no_losses");
  });

  it("distinguishes no closed trades from a finite zero profit factor", () => {
    const metrics = calculatePerformance([], curve([100, 100]), 100);

    expect(metrics.profitFactor).toBe(0);
    expect(metrics.profitFactorState).toBe("no_closed_trades");
  });

  it("infers Sharpe annualization from median positive equity timestamps", () => {
    const daily = calculatePerformance([], curve([100, 101, 100.495, 102.5049]), 100);
    const hourly = calculatePerformance([], curve([100, 101, 100.495, 102.5049], 3_600_000), 100);

    expect(daily.annualizationPeriodsPerYear).toBe(365);
    expect(hourly.annualizationPeriodsPerYear).toBe(8_760);
    expect(Number.isFinite(daily.sharpeRatio)).toBe(true);
    expect(Number.isFinite(hourly.sharpeRatio)).toBe(true);
    expect(hourly.sharpeRatio).not.toBe(daily.sharpeRatio);
  });

  it("does not invent one elapsed day for an empty or zero-duration curve", () => {
    const empty = calculatePerformance([], [], 1_000);
    const onePoint = calculatePerformance([], curve([1_000]), 1_000);

    expect(empty.totalDays).toBe(0);
    expect(empty.avgDailyReturn).toBe(0);
    expect(empty.calmarRatio).toBe(0);
    expect(onePoint.totalDays).toBe(0);
  });

  it("stamps every result with the auditable mathematical contract", () => {
    const metrics = calculatePerformance([], curve([100, 101]), 100);

    expect(metrics.metricSpec).toMatchObject({
      version: "backtest-performance-v2",
      drawdownConvention: "positive_peak_to_trough_percentage",
      winRateDenominator: "all_valid_closed_trades_including_breakeven",
      riskFreeRateAnnualPct: 2,
    });
  });

  it("publishes a complete Traditional Chinese UI explanation from the same v2 contract", () => {
    expect(BACKTEST_PERFORMANCE_METRIC_DESCRIPTIONS_ZH_TW).toHaveLength(8);
    expect(BACKTEST_PERFORMANCE_METRIC_DESCRIPTIONS_ZH_TW.every(item => item.metric && item.description)).toBe(true);
    expect(BACKTEST_PERFORMANCE_METRIC_DESCRIPTIONS_ZH_TW.find(item => item.metric === "夏普比率")?.description)
      .toContain(`${BACKTEST_PERFORMANCE_METRIC_SPEC.riskFreeRateAnnualPct}%`);
  });
});
