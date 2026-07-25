export interface PerformanceTradeInput {
  realizedPnl: string | number | null | undefined;
  createdAt: Date | string | number;
}

export interface StrategyPerformanceSummary {
  closedTradeCount: number;
  wins: number;
  totalPnl: number;
  maxDrawdown: number;
}

/**
 * 將具有可信 realizedPnl 的交易聚合成策略績效。
 * 非有限或不可解析的舊資料不納入，避免一筆 NaN 污染整個總盈虧。
 */
export function summarizeStrategyPerformance(
  trades: PerformanceTradeInput[],
): StrategyPerformanceSummary {
  const closedTrades = trades
    .map((trade) => ({
      createdAt: trade.createdAt,
      pnl: typeof trade.realizedPnl === "number"
        ? trade.realizedPnl
        : Number.parseFloat(String(trade.realizedPnl ?? "")),
    }))
    .filter((trade) => Number.isFinite(trade.pnl));

  const wins = closedTrades.filter((trade) => trade.pnl > 0).length;
  const totalPnl = closedTrades.reduce((sum, trade) => sum + trade.pnl, 0);

  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  const sorted = [...closedTrades].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  for (const trade of sorted) {
    cumulative += trade.pnl;
    if (cumulative > peak) peak = cumulative;
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  return {
    closedTradeCount: closedTrades.length,
    wins,
    totalPnl,
    maxDrawdown,
  };
}
