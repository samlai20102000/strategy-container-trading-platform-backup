import { describe, expect, it } from "vitest";
import { resolveTradeFill, tradeFillRecordFields } from "./tradeFillTruth";

describe("tradeFillTruth", () => {
  it("優先採用交易所實際成交價量", () => {
    expect(resolveTradeFill(
      { filledPrice: 117_437.6, filledSize: 0.00017 },
      117_455.8,
      0.0002,
    )).toEqual({
      price: 117_437.6,
      size: 0.00017,
      priceSource: "exchange_fill",
      sizeSource: "exchange_fill",
    });
  });

  it("adapter 缺少 fill 時才使用下單請求值並明確標示來源", () => {
    expect(tradeFillRecordFields({}, 117_455.8, 0.0002)).toEqual({
      price: "117455.8",
      size: "0.0002",
      priceSource: "order_request",
      sizeSource: "order_request",
    });
  });

  it("無有效價量時不捏造成交價，數量以 0 與歷史未知標示", () => {
    expect(resolveTradeFill({ filledPrice: 0, filledSize: Number.NaN })).toEqual({
      price: undefined,
      size: 0,
      priceSource: "legacy_unknown",
      sizeSource: "legacy_unknown",
    });
  });
});
