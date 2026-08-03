/**
 * 績效計算器（pasted_content_4.txt 任務 5）
 * 計算總回報、勝率、最大回撤、夏普比率、利潤因子、卡瑪比率等指標
 */

import {
  BACKTEST_PERFORMANCE_METRIC_SPEC,
  type BacktestPerformanceMetricSpec,
  type BacktestProfitFactorState,
} from "../../../shared/backtest/performanceMetricSpec";

export interface TradeRecord {
  id: number;
  legId?: string;
  cycleId?: string;
  role?: "PRIMARY" | "INDEPENDENT" | "HEDGE";
  deploymentMode?: "S1" | "M2" | "H3";
  triggerSource?: "AUTO" | "MANUAL" | "RISK" | "WEBHOOK" | "RECONCILIATION";
  entryReason?: string;
  entryTime: number;
  exitTime: number;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPct: number;
  exitReason: string;
  martinLayer: number;
}

export interface EquityPoint {
  timestamp: number;
  equity: number;
  price: number;
}

export interface PerformanceMetrics {
  totalReturn: number;
  totalReturnUSDT: number;
  winRate: number;
  maxDrawdown: number;
  maxDrawdownUSDT: number;
  sharpeRatio: number;
  profitFactor: number;
  calmarRatio: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;
  invalidTradeCount: number;
  invalidEquityPointCount: number;
  avgWin: number;
  avgLoss: number;
  avgWinPct: number;
  avgLossPct: number;
  maxWin: number;
  maxLoss: number;
  martinTriggerCount: number;
  maxMartinLayer: number;
  startTime: number;
  endTime: number;
  totalDays: number;
  avgDailyReturn: number;
  annualizationPeriodsPerYear: number;
  profitFactorState: BacktestProfitFactorState;
  metricSpec: BacktestPerformanceMetricSpec;
}

const RISK_FREE_RATE = 0.02; // 年化無風險利率 2%
const CALENDAR_DAYS_PER_YEAR = 365;

export function calculatePerformance(
  trades: TradeRecord[],
  equityCurve: EquityPoint[],
  initialCapital: number,
): PerformanceMetrics {
  const validTrades = trades.filter((trade) => Number.isFinite(trade.pnl));
  const validEquityCurve = equityCurve.filter(
    (point) => Number.isFinite(point.timestamp) && Number.isFinite(point.equity),
  );

  // 有限責任回測的權益不得低於零；底層 runner 仍應輸出 liquidation／bankruptcy 明細。
  const finalEquity = Math.max(
    0,
    validEquityCurve.length > 0
      ? validEquityCurve[validEquityCurve.length - 1].equity
      : initialCapital,
  );
  const totalReturnUSDT = finalEquity - initialCapital;
  const totalReturn = initialCapital > 0 ? (totalReturnUSDT / initialCapital) * 100 : 0;

  const winningTrades = validTrades.filter((trade) => trade.pnl > 0);
  const losingTrades = validTrades.filter((trade) => trade.pnl < 0);
  const breakEvenTrades = validTrades.filter((trade) => trade.pnl === 0);
  const winRate = validTrades.length > 0
    ? (winningTrades.length / validTrades.length) * 100
    : 0;

  // 最大回撤
  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownUSDT = 0;
  for (const point of validEquityCurve) {
    const boundedEquity = Math.max(0, point.equity);
    if (boundedEquity > peak) peak = boundedEquity;
    const ddUSDT = Math.max(0, peak - boundedEquity);
    const dd = peak > 0 ? Math.min(100, (ddUSDT / peak) * 100) : 0;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownUSDT = ddUSDT;
    }
  }

  // 夏普比率（依權益曲線的期間收益率年化）
  let sharpeRatio = 0;
  const periodsPerYear = estimatePeriodsPerYear(validEquityCurve);
  if (validEquityCurve.length > 2) {
    const returns: number[] = [];
    for (let i = 1; i < validEquityCurve.length; i++) {
      const previousEquity = validEquityCurve[i - 1].equity;
      const currentEquity = validEquityCurve[i].equity;
      if (previousEquity > 0) {
        const periodReturn = (currentEquity - previousEquity) / previousEquity;
        if (Number.isFinite(periodReturn)) returns.push(periodReturn);
      }
    }
    if (returns.length > 1) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance =
        returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
      const std = Math.sqrt(variance);
      if (std > 0) {
        const riskFreeRatePerPeriod = Math.pow(1 + RISK_FREE_RATE, 1 / periodsPerYear) - 1;
        sharpeRatio = ((mean - riskFreeRatePerPeriod) / std) * Math.sqrt(periodsPerYear);
      }
    }
  }

  // 利潤因子
  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactorState: BacktestProfitFactorState = validTrades.length === 0
    ? "no_closed_trades"
    : grossLoss === 0 && grossProfit > 0
      ? "no_losses"
      : "finite";
  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0
      ? 999
      : 0;

  // 時間統計
  const startTime = validEquityCurve.length > 0 ? validEquityCurve[0].timestamp : 0;
  const endTime = validEquityCurve.length > 0
    ? validEquityCurve[validEquityCurve.length - 1].timestamp
    : 0;
  const totalDays = Math.max((endTime - startTime) / 86_400_000, 0);
  const avgDailyReturn = totalDays > 0 ? totalReturn / totalDays : 0;

  // 卡瑪比率（年化收益 / 最大回撤）
  const annualizedReturnPct = totalDays > 0
    ? (totalReturn / totalDays) * CALENDAR_DAYS_PER_YEAR
    : 0;
  const calmarRatio = maxDrawdown > 0 ? annualizedReturnPct / maxDrawdown : 0;

  const martinTrades = validTrades.filter((trade) => trade.martinLayer > 0);

  return {
    totalReturn: round2(totalReturn),
    totalReturnUSDT: round2(totalReturnUSDT),
    winRate: round2(winRate),
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownUSDT: round2(maxDrawdownUSDT),
    sharpeRatio: round3(isFinite(sharpeRatio) ? sharpeRatio : 0),
    profitFactor: round3(profitFactor),
    calmarRatio: round3(isFinite(calmarRatio) ? calmarRatio : 0),
    totalTrades: validTrades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    breakEvenTrades: breakEvenTrades.length,
    invalidTradeCount: trades.length - validTrades.length,
    invalidEquityPointCount: equityCurve.length - validEquityCurve.length,
    avgWin: round2(winningTrades.length > 0 ? grossProfit / winningTrades.length : 0),
    avgLoss: round2(losingTrades.length > 0 ? -grossLoss / losingTrades.length : 0),
    avgWinPct: round2(
      winningTrades.length > 0
        ? winningTrades.reduce((s, t) => s + t.pnlPct, 0) / winningTrades.length
        : 0,
    ),
    avgLossPct: round2(
      losingTrades.length > 0
        ? losingTrades.reduce((s, t) => s + t.pnlPct, 0) / losingTrades.length
        : 0,
    ),
    maxWin: round2(winningTrades.length > 0 ? Math.max(...winningTrades.map((t) => t.pnl)) : 0),
    maxLoss: round2(losingTrades.length > 0 ? Math.min(...losingTrades.map((t) => t.pnl)) : 0),
    martinTriggerCount: martinTrades.length,
    maxMartinLayer: validTrades.length > 0
      ? Math.max(...validTrades.map((trade) => trade.martinLayer), 0)
      : 0,
    startTime,
    endTime,
    totalDays: round2(totalDays),
    avgDailyReturn: round3(avgDailyReturn),
    annualizationPeriodsPerYear: round3(periodsPerYear),
    profitFactorState,
    metricSpec: { ...BACKTEST_PERFORMANCE_METRIC_SPEC },
  };
}

/** 依正時間間隔中位數估算每年期數，避免重複點或單一巨大缺口扭曲 Sharpe。 */
function estimatePeriodsPerYear(equityCurve: EquityPoint[]): number {
  if (equityCurve.length < 2) return CALENDAR_DAYS_PER_YEAR;
  const positiveIntervals = equityCurve
    .slice(1)
    .map((point, index) => point.timestamp - equityCurve[index].timestamp)
    .filter((interval) => Number.isFinite(interval) && interval > 0)
    .sort((left, right) => left - right);
  if (positiveIntervals.length === 0) return CALENDAR_DAYS_PER_YEAR;
  const middle = Math.floor(positiveIntervals.length / 2);
  const medianIntervalMs = positiveIntervals.length % 2 === 0
    ? (positiveIntervals[middle - 1] + positiveIntervals[middle]) / 2
    : positiveIntervals[middle];
  return (CALENDAR_DAYS_PER_YEAR * 86_400_000) / medianIntervalMs;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
