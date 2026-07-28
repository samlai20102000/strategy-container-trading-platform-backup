import type { OrderResult } from "../exchanges/types";

export type TradeFillSource = "exchange_fill" | "order_request" | "legacy_unknown";
export type TradePnlSource = "exchange" | "local_estimate" | "legacy" | "unavailable";

export interface ResolvedTradeFill {
  price?: number;
  size: number;
  priceSource: TradeFillSource;
  sizeSource: TradeFillSource;
}

function positiveFinite(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveTradePnl(
  result: Pick<OrderResult, "realizedPnl" | "fee" | "netRealizedPnl" | "pnlSource">,
  localEstimate?: number,
): {
  realizedPnl?: number;
  fee?: number;
  netRealizedPnl?: number;
  pnlSource?: TradePnlSource;
} {
  const exchangeRealizedPnl = finiteNumber(result.realizedPnl);
  const estimatedRealizedPnl = finiteNumber(localEstimate);
  const realizedPnl = exchangeRealizedPnl ?? estimatedRealizedPnl;
  const fee = finiteNumber(result.fee);
  const explicitNet = finiteNumber(result.netRealizedPnl);
  const netRealizedPnl = explicitNet ?? (
    realizedPnl !== undefined ? realizedPnl + (fee ?? 0) : undefined
  );

  return {
    realizedPnl,
    fee,
    netRealizedPnl,
    pnlSource: exchangeRealizedPnl !== undefined
      ? (result.pnlSource ?? "exchange")
      : estimatedRealizedPnl !== undefined
        ? "local_estimate"
        : undefined,
  };
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

/** 直接展開到 createTrade payload，避免各策略版本各自重寫優先序。 */
export function tradeFillRecordFields(
  result: Pick<OrderResult, "filledPrice" | "filledSize" | "realizedPnl" | "fee" | "netRealizedPnl" | "pnlSource">,
  requestedPrice?: number,
  requestedSize?: number,
  localPnlEstimate?: number,
): {
  price?: string;
  size: string;
  priceSource: TradeFillSource;
  sizeSource: TradeFillSource;
  realizedPnl?: string;
  fee?: string;
  netRealizedPnl?: string;
  pnlSource?: TradePnlSource;
} {
  const fill = resolveTradeFill(result, requestedPrice, requestedSize);
  const pnl = resolveTradePnl(result, localPnlEstimate);
  return {
    price: fill.price !== undefined ? String(fill.price) : undefined,
    size: String(fill.size),
    priceSource: fill.priceSource,
    sizeSource: fill.sizeSource,
    realizedPnl: pnl.realizedPnl !== undefined ? String(pnl.realizedPnl) : undefined,
    fee: pnl.fee !== undefined ? String(pnl.fee) : undefined,
    netRealizedPnl: pnl.netRealizedPnl !== undefined ? String(pnl.netRealizedPnl) : undefined,
    pnlSource: pnl.pnlSource,
  };
}
