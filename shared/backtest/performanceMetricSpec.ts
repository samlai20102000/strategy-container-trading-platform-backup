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

export interface BacktestPerformanceMetricDescription {
  metric: string;
  description: string;
}

export const BACKTEST_PERFORMANCE_METRIC_DESCRIPTIONS_ZH_TW: readonly BacktestPerformanceMetricDescription[] = Object.freeze([
  { metric: "總回報", description: "以套用終點持倉政策後的最終權益計算，已包含 runner 支援的手續費、滑價與資金費用。" },
  { metric: "最大回撤", description: "以權益曲線由歷史高點至後續低點的正百分比幅度表示。" },
  { metric: "勝率", description: "獲利平倉筆數除以所有有效平倉筆數；損益為零的交易仍列入分母。" },
  { metric: "Profit Factor", description: "正淨已平倉損益總和除以負淨已平倉損益絕對值；無虧損與無平倉交易以獨立語義狀態呈現。" },
  { metric: "夏普比率", description: `使用相鄰權益點的簡單報酬率，依正時間間隔推導年化期數，年化無風險利率為 ${BACKTEST_PERFORMANCE_METRIC_SPEC.riskFreeRateAnnualPct}%。` },
  { metric: "Calmar 比率", description: "以每經過一日的算術總回報乘以 365 年化，再除以最大回撤。" },
  { metric: "未平倉", description: "依全域終點持倉政策選擇按市價估值或終點強制平倉，不在資料分段邊界製造合成交易。" },
  { metric: "成本", description: "手續費與滑價納入 runner 權益；資金費用僅在該策略 runner 明確支援時納入。" },
]);
