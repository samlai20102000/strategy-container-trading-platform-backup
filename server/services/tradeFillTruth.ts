import type { ExchangeTruthSource, OrderResult, SettlementStatus } from "../exchanges/types";

export type TradeFillSource = "exchange_fill" | "order_request" | "legacy_unknown";

export interface ResolvedTradeFill {
  price?: number;
  size: number;
  priceSource: TradeFillSource;
  sizeSource: TradeFillSource;
}

export interface ResolvedExecutionTruth extends ResolvedTradeFill {
  grossRealizedPnl?: number;
  netRealizedPnl?: number;
  fee?: number;
  fundingFee?: number;
  pnlSource: ExchangeTruthSource;
  feeSource: ExchangeTruthSource;
  settlementStatus: SettlementStatus;
  tradeId?: string;
  filledAt?: number;
}

function positiveFinite(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function finite(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 交易所 fill 是第一優先；只有 adapter 未能取得 fill 時，才回退至下單請求值。
 * 回退不是「實際成交」，所以來源欄位必須一併落庫，供 UI 與稽核明確標示。
 */
export function resolveTradeFill(
  result: Pick<OrderResult, "filledPrice" | "filledSize">,
  requestedPrice?: number,
  requestedSize?: number,
): ResolvedTradeFill {
  const exchangePrice = positiveFinite(result.filledPrice);
  const exchangeSize = positiveFinite(result.filledSize);
  const fallbackPrice = positiveFinite(requestedPrice);
  const fallbackSize = positiveFinite(requestedSize);

  return {
    price: exchangePrice ?? fallbackPrice,
    size: exchangeSize ?? fallbackSize ?? 0,
    priceSource: exchangePrice ? "exchange_fill" : fallbackPrice ? "order_request" : "legacy_unknown",
    sizeSource: exchangeSize ? "exchange_fill" : fallbackSize ? "order_request" : "legacy_unknown",
  };
}

/**
 * 把 adapter 的跨交易所回應正規化為唯一交易真相契約。
 * realizedPnl 保留為毛值；列表與報告應優先使用 netRealizedPnl。
 */
export function resolveExecutionTruth(
  result: OrderResult,
  requestedPrice?: number,
  requestedSize?: number,
): ResolvedExecutionTruth {
  const fill = resolveTradeFill(result, requestedPrice, requestedSize);
  const gross = finite(result.grossRealizedPnl ?? result.realizedPnl);
  const fee = finite(result.fee);
  const fundingFee = finite(result.fundingFee);
  const explicitNet = finite(result.netRealizedPnl);
  const net = explicitNet ?? (gross !== undefined
    ? gross - (fee ?? 0) - (fundingFee ?? 0)
    : undefined);

  return {
    ...fill,
    grossRealizedPnl: gross,
    netRealizedPnl: net,
    fee,
    fundingFee,
    pnlSource: result.pnlSource ?? "unavailable",
    feeSource: result.feeSource ?? "unavailable",
    settlementStatus: result.settlementStatus ?? "not_applicable",
    tradeId: result.tradeId,
    filledAt: result.filledAt,
  };
}

/** 直接展開到 createTrade payload，避免各策略版本各自重寫優先序。 */
export function tradeFillRecordFields(
  result: Pick<OrderResult, "filledPrice" | "filledSize">,
  requestedPrice?: number,
  requestedSize?: number,
): {
  price?: string;
  size: string;
  priceSource: TradeFillSource;
  sizeSource: TradeFillSource;
} {
  const fill = resolveTradeFill(result, requestedPrice, requestedSize);
  return {
    price: fill.price !== undefined ? String(fill.price) : undefined,
    size: String(fill.size),
    priceSource: fill.priceSource,
    sizeSource: fill.sizeSource,
  };
}
