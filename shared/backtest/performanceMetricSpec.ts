export const BACKTEST_PERFORMANCE_SPEC_VERSION = "backtest-performance-v2" as const;

export type BacktestProfitFactorState = "finite" | "no_losses" | "no_closed_trades";

/**
 * 所有 runner 共用的績效數學契約。此物件會隨結果保存，讓歷史結果可稽核，
 * 而不是依目前 UI 的說明反推當時採用的公式。
 */
export interface BacktestPerformanceMetricSpec {
  version: typeof BACKTEST_PERFORMANCE_SPEC_VERSION;
  totalReturnBasis: "final_equity_after_costs_and_end_policy";
  drawdownConvention: "positive_peak_to_trough_percentage";
  winRateDenominator: "all_valid_closed_trades_including_breakeven";
  profitFactorBasis: "positive_net_closed_trade_pnl_over_absolute_negative_net_closed_trade_pnl";
  sharpeReturnSeries: "simple_returns_between_equity_points";
  sharpeAnnualization: "calendar_time_inferred_from_positive_equity_timestamp_intervals";
  riskFreeRateAnnualPct: number;
  calmarAnnualization: "arithmetic_total_return_per_elapsed_day_times_365";
  openPositionTreatment: "controlled_by_end_position_policy";
  costTreatment: "fees_and_slippage_in_runner_equity_funding_when_supported";
}

export const BACKTEST_PERFORMANCE_METRIC_SPEC: BacktestPerformanceMetricSpec = Object.freeze({
  version: BACKTEST_PERFORMANCE_SPEC_VERSION,
  totalReturnBasis: "final_equity_after_costs_and_end_policy",
  drawdownConvention: "positive_peak_to_trough_percentage",
  winRateDenominator: "all_valid_closed_trades_including_breakeven",
  profitFactorBasis: "positive_net_closed_trade_pnl_over_absolute_negative_net_closed_trade_pnl",
  sharpeReturnSeries: "simple_returns_between_equity_points",
  sharpeAnnualization: "calendar_time_inferred_from_positive_equity_timestamp_intervals",
  riskFreeRateAnnualPct: 2,
  calmarAnnualization: "arithmetic_total_return_per_elapsed_day_times_365",
  openPositionTreatment: "controlled_by_end_position_policy",
  costTreatment: "fees_and_slippage_in_runner_equity_funding_when_supported",
});
