import type { OrderResult } from "../exchanges/types";

export type TradeFillSource = "exchange_fill" | "order_request" | "legacy_unknown";

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
