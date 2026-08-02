/**
 * 績效計算器（pasted_content_4.txt 任務 5）
 * 計算總回報、勝率、最大回撤、夏普比率、利潤因子、卡瑪比率等指標
 */

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
}

const RISK_FREE_RATE = 0.02; // 年化無風險利率 2%
const TRADING_DAYS_PER_YEAR = 252;

export function calculatePerformance(
  trades: TradeRecord[],
  equityCurve: EquityPoint[],
  initialCapital: number,
): PerformanceMetrics {
  // 有限責任回測的權益不得低於零；底層 runner 仍應輸出 liquidation／bankruptcy 明細。
  const finalEquity = Math.max(
    0,
    equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapital,
  );
  const totalReturnUSDT = finalEquity - initialCapital;
  const totalReturn = initialCapital > 0 ? (totalReturnUSDT / initialCapital) * 100 : 0;

  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl < 0);
  const winRate = trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0;

  // 最大回撤
  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownUSDT = 0;
  for (const point of equityCurve) {
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
  if (equityCurve.length > 2) {
    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1].equity;
      if (prev > 0) returns.push((equityCurve[i].equity - prev) / prev);
    }
    if (returns.length > 1) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance =
        returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
      const std = Math.sqrt(variance);
      if (std > 0) {
        const periodsPerYear = estimatePeriodsPerYear(equityCurve);
        const annualizedReturn = mean * periodsPerYear;
        const annualizedStd = std * Math.sqrt(periodsPerYear);
        sharpeRatio = (annualizedReturn - RISK_FREE_RATE) / annualizedStd;
      }
    }
  }

  // 利潤因子
  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // 時間統計
  const startTime = equityCurve.length > 0 ? equityCurve[0].timestamp : 0;
  const endTime = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].timestamp : 0;
  const totalDays = Math.max((endTime - startTime) / 86400000, 1);
  const avgDailyReturn = totalReturn / totalDays;

  // 卡瑪比率（年化收益 / 最大回撤）
  const annualizedReturnPct = (totalReturn / totalDays) * 365;
  const calmarRatio = maxDrawdown > 0 ? annualizedReturnPct / maxDrawdown : 0;

  const martinTrades = trades.filter((t) => t.martinLayer > 0);

  return {
    totalReturn: round2(totalReturn),
    totalReturnUSDT: round2(totalReturnUSDT),
    winRate: round2(winRate),
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownUSDT: round2(maxDrawdownUSDT),
    sharpeRatio: round3(isFinite(sharpeRatio) ? sharpeRatio : 0),
    profitFactor: round3(isFinite(profitFactor) ? profitFactor : 999),
    calmarRatio: round3(isFinite(calmarRatio) ? calmarRatio : 0),
    totalTrades: trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
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
    maxMartinLayer: trades.length > 0 ? Math.max(...trades.map((t) => t.martinLayer), 0) : 0,
    startTime,
    endTime,
    totalDays: round2(totalDays),
    avgDailyReturn: round3(avgDailyReturn),
  };
}

/** 依權益曲線點間距估算每年期數（用於年化） */
function estimatePeriodsPerYear(equityCurve: EquityPoint[]): number {
  if (equityCurve.length < 2) return TRADING_DAYS_PER_YEAR;
  const totalMs = equityCurve[equityCurve.length - 1].timestamp - equityCurve[0].timestamp;
  const avgIntervalMs = totalMs / (equityCurve.length - 1);
  if (avgIntervalMs <= 0) return TRADING_DAYS_PER_YEAR;
  return (365 * 86400000) / avgIntervalMs;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
