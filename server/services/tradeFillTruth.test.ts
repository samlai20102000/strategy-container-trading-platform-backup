import { describe, expect, it } from "vitest";
import { resolveTradeFill, resolveTradePnl, tradeFillRecordFields } from "./tradeFillTruth";

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

  it("交易所毛盈虧優先於本地估算，並以負費用計算淨盈虧", () => {
    expect(resolveTradePnl({
      realizedPnl: -0.024,
      fee: -0.0128,
      pnlSource: "exchange",
    }, 999)).toEqual({
      realizedPnl: -0.024,
      fee: -0.0128,
      netRealizedPnl: -0.0368,
      pnlSource: "exchange",
    });
  });

  it("0 毛盈虧是有效交易所真值，不可被本地估算覆蓋", () => {
    expect(resolveTradePnl({
      realizedPnl: 0,
      fee: -0.01,
      pnlSource: "exchange",
    }, 1.25)).toEqual({
      realizedPnl: 0,
      fee: -0.01,
      netRealizedPnl: -0.01,
      pnlSource: "exchange",
    });
  });

  it("交易所未回傳 PnL 時才使用本地估算並明示來源", () => {
    expect(tradeFillRecordFields({
      filledPrice: 64_130,
      filledSize: 0.0004,
      fee: -0.012826,
    }, undefined, undefined, -0.0006)).toEqual({
      price: "64130",
      size: "0.0004",
      priceSource: "exchange_fill",
      sizeSource: "exchange_fill",
      realizedPnl: "-0.0006",
      fee: "-0.012826",
      netRealizedPnl: "-0.013426",
      pnlSource: "local_estimate",
    });
  });

  it("交易所提供顯式淨盈虧時不重算", () => {
    expect(resolveTradePnl({
      realizedPnl: 0.05,
      fee: -0.01,
      netRealizedPnl: 0.037,
      pnlSource: "exchange",
    })).toEqual({
      realizedPnl: 0.05,
      fee: -0.01,
      netRealizedPnl: 0.037,
      pnlSource: "exchange",
    });
  });
});
