export interface PerformanceTradeInput {
  id?: number | string | null;
  executionId?: string | null;
  exchangeTradeId?: string | null;
  orderId?: string | null;
  reduceOnly: boolean | null | undefined;
  status: string | null | undefined;
  realizedPnl: string | number | null | undefined;
  netRealizedPnl?: string | number | null | undefined;
  reconciliationStatus?: string | null;
  dataQuality?: string | null;
  createdAt: Date | string | number;
}

export interface StrategyPerformanceSummary {
  /** 已成交、已知淨 PnL 且完成去重的平倉結果，包含持平。 */
  closedTradeCount: number;
  /** 有方向結果的分母：wins + losses，不包含持平。 */
  decisiveTradeCount: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  pendingPnlCount: number;
  unresolvedPnlCount: number;
  excludedEntryCount: number;
  excludedNonFilledCloseCount: number;
  duplicateExcludedCount: number;
}

type RealizedClose = {
  key: string;
  pnl: number;
  createdAt: PerformanceTradeInput["createdAt"];
  sourceIndex: number;
  trustScore: number;
};

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 以交易所 fill／order 優先去重；沒有交易所識別時才退回內部 execution／trade id。
 * cycleId 不作主要去重鍵：歷史策略曾跨多個獨立平倉重用同一 cycleId。
 */
function realizedCloseKey(trade: PerformanceTradeInput, index: number): string {
  const exchangeTradeId = identifier(trade.exchangeTradeId);
  if (exchangeTradeId) return `fill:${exchangeTradeId}`;
  const orderId = identifier(trade.orderId);
  if (orderId) return `order:${orderId}`;
  const executionId = identifier(trade.executionId);
  if (executionId) return `execution:${executionId}`;
  const tradeId = identifier(trade.id);
  if (tradeId) return `trade:${tradeId}`;
  return `row:${index}`;
}

function tradeTrustScore(trade: PerformanceTradeInput): number {
  let score = 0;
  if (finiteNumber(trade.netRealizedPnl) !== null) score += 8;
  if (trade.reconciliationStatus === "confirmed") score += 4;
  if (trade.dataQuality === "exchange_confirmed") score += 2;
  if (identifier(trade.exchangeTradeId)) score += 1;
  return score;
}

function timeValue(value: PerformanceTradeInput["createdAt"]): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 統一的實盤勝率口徑：
 * - 只計入 filled + reduceOnly + 已知淨已實現 PnL 的平倉結果；
 * - 優先採 netRealizedPnl，舊資料才回退 realizedPnl；
 * - 以穩定 fill／order／execution／trade 識別去重；
 * - PnL > 0 為勝、< 0 為負、= 0 為持平；持平不進勝率分母；
 * - 開倉、加倉、失敗、取消、pending 與 unresolved 不得偽裝成負場。
 */
export function summarizeStrategyPerformance(
  trades: PerformanceTradeInput[],
): StrategyPerformanceSummary {
  const outcomes = new Map<string, RealizedClose>();
  let pendingPnlCount = 0;
  let unresolvedPnlCount = 0;
  let excludedEntryCount = 0;
  let excludedNonFilledCloseCount = 0;
  let duplicateExcludedCount = 0;

  trades.forEach((trade, sourceIndex) => {
    if (trade.reduceOnly !== true) {
      excludedEntryCount += 1;
      return;
    }
    if (trade.status !== "filled") {
      excludedNonFilledCloseCount += 1;
      return;
    }

    const pnl = finiteNumber(trade.netRealizedPnl) ?? finiteNumber(trade.realizedPnl);
    if (pnl === null) {
      if (trade.reconciliationStatus === "pending") pendingPnlCount += 1;
      else unresolvedPnlCount += 1;
      return;
    }

    const candidate: RealizedClose = {
      key: realizedCloseKey(trade, sourceIndex),
      pnl,
      createdAt: trade.createdAt,
      sourceIndex,
      trustScore: tradeTrustScore(trade),
    };
    const existing = outcomes.get(candidate.key);
    if (!existing) {
      outcomes.set(candidate.key, candidate);
      return;
    }

    duplicateExcludedCount += 1;
    const shouldReplace = candidate.trustScore > existing.trustScore
      || (candidate.trustScore === existing.trustScore
        && timeValue(candidate.createdAt) > timeValue(existing.createdAt));
    if (shouldReplace) outcomes.set(candidate.key, candidate);
  });

  const closedTrades = Array.from(outcomes.values());
  const wins = closedTrades.filter((trade) => trade.pnl > 0).length;
  const losses = closedTrades.filter((trade) => trade.pnl < 0).length;
  const breakevens = closedTrades.length - wins - losses;
  const decisiveTradeCount = wins + losses;
  const totalPnl = closedTrades.reduce((sum, trade) => sum + trade.pnl, 0);

  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  const sorted = [...closedTrades].sort((a, b) => {
    const timeDelta = timeValue(a.createdAt) - timeValue(b.createdAt);
    return timeDelta !== 0 ? timeDelta : a.sourceIndex - b.sourceIndex;
  });
  for (const trade of sorted) {
    cumulative += trade.pnl;
    if (cumulative > peak) peak = cumulative;
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  return {
    closedTradeCount: closedTrades.length,
    decisiveTradeCount,
    wins,
    losses,
    breakevens,
    winRate: decisiveTradeCount > 0 ? (wins / decisiveTradeCount) * 100 : 0,
    totalPnl,
    maxDrawdown,
    pendingPnlCount,
    unresolvedPnlCount,
    excludedEntryCount,
    excludedNonFilledCloseCount,
    duplicateExcludedCount,
  };
}
