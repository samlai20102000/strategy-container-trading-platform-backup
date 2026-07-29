import type { InsertTrade } from "../../drizzle/schema";
import {
  claimTradeReconciliation,
  completeTradeReconciliation,
  getApiKeyById,
  getStrategyById,
  listPendingTradeReconciliations,
  markTradeReconciliationIncomplete,
} from "../db";
import { createAdapter } from "../exchanges/factory";
import type { ExchangeAdapter, OrderResult } from "../exchanges/types";

const DEFAULT_BATCH_SIZE = 20;
const RECONCILIATION_LEASE_MS = 55_000;
const MAX_RECONCILIATION_ATTEMPTS = 30;

type Candidate = Awaited<ReturnType<typeof listPendingTradeReconciliations>>[number];
export type ReconciliationCandidate = Candidate;
type TruthReader = Pick<ExchangeAdapter, "getOrderExecutionTruth">;

export interface ReconciliationSummary {
  scanned: number;
  claimed: number;
  confirmed: number;
  pending: number;
  unresolved: number;
  skipped: number;
  errors: number;
  ranAt: string;
}

export interface ReconciliationDependencies {
  listCandidates: typeof listPendingTradeReconciliations;
  claim: typeof claimTradeReconciliation;
  getStrategy: typeof getStrategyById;
  getApiKey: typeof getApiKeyById;
  createTruthReader: (apiKey: Parameters<typeof createAdapter>[0]) => TruthReader;
  complete: typeof completeTradeReconciliation;
  markIncomplete: typeof markTradeReconciliationIncomplete;
}

const defaultDependencies: ReconciliationDependencies = {
  listCandidates: listPendingTradeReconciliations,
  claim: claimTradeReconciliation,
  getStrategy: getStrategyById,
  getApiKey: getApiKeyById,
  createTruthReader: createAdapter,
  complete: completeTradeReconciliation,
  markIncomplete: markTradeReconciliationIncomplete,
};

function finite(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decimal(value: unknown): string | undefined {
  const parsed = finite(value);
  return parsed === undefined ? undefined : parsed.toFixed(8);
}

function signedPnlMessage(netPnl: number, currency: string): string {
  const formatted = netPnl >= 0 ? `+${netPnl.toFixed(8)}` : netPnl.toFixed(8);
  return `✅ 平倉已執行｜已實現盈虧 ${formatted} ${currency}`;
}

function buildConfirmedValues(candidate: Candidate, truth: Partial<OrderResult>): {
  netPnl: number;
  currency: string;
  values: Partial<InsertTrade>;
} | null {
  const netPnl = finite(truth.netRealizedPnl ?? truth.realizedPnl);
  if (netPnl === undefined || truth.settlementStatus !== "final") return null;

  const fee = finite(truth.fee);
  const fundingFee = finite(truth.fundingFee);
  const grossPnl = finite(truth.grossRealizedPnl)
    ?? netPnl + (fee ?? 0) + (fundingFee ?? 0);
  const filledPrice = finite(truth.filledPrice);
  const filledSize = finite(truth.filledSize);
  const currency = candidate.pnlCurrency || "USDT";

  return {
    netPnl,
    currency,
    values: {
      ...(filledPrice !== undefined && filledPrice > 0
        ? { price: decimal(filledPrice), priceSource: "exchange_fill" as const }
        : {}),
      ...(filledSize !== undefined && filledSize > 0
        ? { size: decimal(filledSize), sizeSource: "exchange_fill" as const }
        : {}),
      ...(truth.tradeId ? { exchangeTradeId: String(truth.tradeId).slice(0, 128) } : {}),
      ...(truth.filledAt ? { filledAt: new Date(truth.filledAt) } : {}),
      grossPnl: decimal(grossPnl),
      fee: decimal(fee),
      fundingFee: decimal(fundingFee),
      realizedPnl: decimal(netPnl),
      netRealizedPnl: decimal(netPnl),
      pnlCurrency: currency,
      pnlSource: "exchange_settlement",
      dataQuality: "exchange_confirmed",
      status: "filled",
    },
  };
}

async function markNotReady(
  candidate: Candidate,
  message: string,
  dependencies: ReconciliationDependencies,
): Promise<"pending" | "unresolved"> {
  const attempt = candidate.reconciliationAttempts + 1;
  const terminal = attempt >= MAX_RECONCILIATION_ATTEMPTS;
  await dependencies.markIncomplete({ tradeId: candidate.id, error: message, terminal });
  return terminal ? "unresolved" : "pending";
}

export async function reconcileTradeCandidate(
  candidate: Candidate,
  reader: TruthReader,
  dependencies: ReconciliationDependencies = defaultDependencies,
): Promise<"confirmed" | "pending" | "unresolved"> {
  if (!candidate.orderId) {
    await dependencies.markIncomplete({
      tradeId: candidate.id,
      error: "缺少交易所 orderId，無法進行權威對帳",
      terminal: true,
    });
    return "unresolved";
  }

  try {
    const truth = await reader.getOrderExecutionTruth(candidate.symbol, candidate.orderId, true);
    const confirmed = buildConfirmedValues(candidate, truth);
    if (!confirmed) {
      return markNotReady(
        candidate,
        truth.settlementStatus === "pending"
          ? "交易所已接受查詢，但已實現盈虧尚未完成結算"
          : "交易所尚未回傳可驗證的已實現盈虧",
        dependencies,
      );
    }

    await dependencies.complete({
      tradeId: candidate.id,
      signalId: candidate.signalId,
      values: confirmed.values,
      message: signedPnlMessage(confirmed.netPnl, confirmed.currency),
    });
    return "confirmed";
  } catch (error) {
    return markNotReady(
      candidate,
      `交易所對帳查詢失敗：${(error as Error)?.message || String(error)}`,
      dependencies,
    );
  }
}

/**
 * 每分鐘 Heartbeat 執行的全域批次。
 * 只讀取交易所成交真相並更新既有 ledger，不會呼叫任何下單、撤單或平倉方法。
 */
export async function runTradePnlReconciliation(
  options: { limit?: number; now?: Date } = {},
  dependencies: ReconciliationDependencies = defaultDependencies,
): Promise<ReconciliationSummary> {
  const now = options.now ?? new Date();
  const summary: ReconciliationSummary = {
    scanned: 0,
    claimed: 0,
    confirmed: 0,
    pending: 0,
    unresolved: 0,
    skipped: 0,
    errors: 0,
    ranAt: now.toISOString(),
  };
  const candidates = await dependencies.listCandidates({
    limit: options.limit ?? DEFAULT_BATCH_SIZE,
    minimumAgeMs: 20_000,
    leaseMs: RECONCILIATION_LEASE_MS,
    now,
  });
  summary.scanned = candidates.length;

  const strategyCache = new Map<number, Awaited<ReturnType<typeof getStrategyById>>>();
  const readerCache = new Map<number, TruthReader>();
  for (const candidate of candidates) {
    const claimed = await dependencies.claim(
      candidate.id,
      new Date(now.getTime() - RECONCILIATION_LEASE_MS),
      now,
    );
    if (!claimed) {
      summary.skipped += 1;
      continue;
    }
    summary.claimed += 1;

    try {
      let strategy = strategyCache.get(candidate.strategyId);
      if (!strategyCache.has(candidate.strategyId)) {
        strategy = await dependencies.getStrategy(candidate.strategyId);
        strategyCache.set(candidate.strategyId, strategy);
      }
      if (!strategy) {
        const state = await markNotReady(candidate, "策略已不存在，無法定位原交易所金鑰", dependencies);
        summary[state] += 1;
        continue;
      }

      let reader = readerCache.get(strategy.apiKeyId);
      if (!reader) {
        const apiKey = await dependencies.getApiKey(strategy.apiKeyId);
        if (!apiKey || apiKey.exchange !== candidate.exchange) {
          const state = await markNotReady(candidate, "策略目前的 API 金鑰不存在或交易所不相符", dependencies);
          summary[state] += 1;
          continue;
        }
        reader = dependencies.createTruthReader(apiKey);
        readerCache.set(strategy.apiKeyId, reader);
      }

      const state = await reconcileTradeCandidate(candidate, reader, dependencies);
      summary[state] += 1;
    } catch (error) {
      summary.errors += 1;
      const state = await markNotReady(
        candidate,
        `對帳流程失敗：${(error as Error)?.message || String(error)}`,
        dependencies,
      );
      summary[state] += 1;
    }
  }

  return summary;
}

export const __tradePnlReconciliationTestUtils = {
  buildConfirmedValues,
  signedPnlMessage,
  MAX_RECONCILIATION_ATTEMPTS,
};
