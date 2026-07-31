import { afterEach, describe, expect, it, vi } from "vitest";
import { BybitAdapter } from "./bybit";
import { OKXAdapter } from "./okx";

function stubOkxInstrumentSpec() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: [{
        instId: "BTC-USDT-SWAP",
        state: "live",
        ctVal: "1",
        lotSz: "1",
        minSz: "1",
        tickSz: "0.1",
      }],
    }),
  }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("交易所 Maker-First payload 契約", () => {
  it("Bybit 將正常與平倉限價單送為 PostOnly，保留 reduce-only 與 client id", async () => {
    const adapter = new BybitAdapter("key", "secret", true);
    const request = vi.fn().mockResolvedValue({
      retCode: 0,
      result: { orderId: "bybit-order-1" },
    });
    (adapter as any).request = request;
    (adapter as any).queryOrderFillDetails = vi.fn().mockResolvedValue({});

    const clientOrderId = "mf_b_1234567890123456789012345678901234567890";
    const result = await adapter.placeOrder({
      symbol: "BTC-USDT",
      side: "sell",
      orderType: "limit",
      size: 2,
      price: 63_000,
      postOnly: true,
      reduceOnly: true,
      posSide: "long",
      clientOrderId,
    });

    expect(result.success).toBe(true);
    expect(request).toHaveBeenCalledWith("POST", "/v5/order/create", {
      category: "linear",
      symbol: "BTCUSDT",
      side: "Sell",
      orderType: "Limit",
      qty: "2",
      price: "63000",
      timeInForce: "PostOnly",
      orderLinkId: clientOrderId.slice(0, 36),
      reduceOnly: true,
      positionIdx: 1,
    });
  });

  it("OKX 將正常與平倉限價單送為 post_only，保留 reduce-only、posSide 與 client id", async () => {
    stubOkxInstrumentSpec();
    const adapter = new OKXAdapter("key", "secret", "passphrase", true);
    const request = vi.fn().mockResolvedValue({
      code: "0",
      data: [{ sCode: "0", ordId: "okx-order-1" }],
    });
    (adapter as any).request = request;
    (adapter as any).getPositionMode = vi.fn().mockResolvedValue("long_short_mode");

    const clientOrderId = "mf_o_1234567890123456789012345678901234567890";
    const result = await adapter.placeOrder({
      symbol: "BTC-USDT-SWAP",
      side: "sell",
      orderType: "limit",
      size: 2,
      price: 63_000,
      postOnly: true,
      reduceOnly: true,
      posSide: "long",
      clientOrderId,
    });

    expect(result.success).toBe(true);
    expect(request).toHaveBeenCalledWith("POST", "/api/v5/trade/order", {
      instId: "BTC-USDT-SWAP",
      tdMode: "cross",
      side: "sell",
      ordType: "post_only",
      sz: "2",
      posSide: "long",
      px: "63000",
      reduceOnly: true,
      clOrdId: clientOrderId.slice(0, 32),
    });
  });

  it("兩個 adapter 都會在 post-only 缺少有效限價時 fail-closed，且不送 mutation", async () => {
    const bybit = new BybitAdapter("key", "secret", true);
    const okx = new OKXAdapter("key", "secret", "passphrase", true);
    const bybitRequest = vi.fn();
    const okxRequest = vi.fn();
    (bybit as any).request = bybitRequest;
    (okx as any).request = okxRequest;

    const input = {
      symbol: "BTC-USDT-SWAP",
      side: "buy" as const,
      orderType: "market" as const,
      size: 1,
      postOnly: true,
    };
    const [bybitResult, okxResult] = await Promise.all([
      bybit.placeOrder(input),
      okx.placeOrder(input),
    ]);

    expect(bybitResult.success).toBe(false);
    expect(okxResult.success).toBe(false);
    expect(bybitResult.errorMessage).toContain("fail-closed");
    expect(okxResult.errorMessage).toContain("fail-closed");
    expect(bybitRequest).not.toHaveBeenCalled();
    expect(okxRequest).not.toHaveBeenCalled();
  });

  it("Bybit 可用 orderLinkId 找回送單後崩潰的部分成交訂單", async () => {
    vi.useFakeTimers();
    const adapter = new BybitAdapter("key", "secret", true);
    const request = vi.fn().mockResolvedValue({
      result: {
        list: [{
          orderId: "bybit-recovered-1",
          orderLinkId: "mf-recovery-bybit",
          orderStatus: "PartiallyFilled",
          avgPrice: "63000",
          cumExecQty: "0.4",
          side: "Sell",
          reduceOnly: true,
          updatedTime: "1760000000000",
        }],
      },
    });
    (adapter as any).request = request;

    const truthPromise = adapter.getOrderExecutionTruth(
      "BTC-USDT",
      undefined,
      false,
      "mf-recovery-bybit",
    );
    await vi.advanceTimersByTimeAsync(300);
    const truth = await truthPromise;

    expect(request).toHaveBeenCalledWith("GET", "/v5/order/realtime", {
      category: "linear",
      symbol: "BTCUSDT",
      orderLinkId: "mf-recovery-bybit",
    });
    expect(truth).toMatchObject({
      orderId: "bybit-recovered-1",
      executionStatus: "partially_filled",
      filledSize: 0.4,
      executedReduceOnly: true,
    });
  });

  it("OKX 可用 clOrdId 找回送單後崩潰的部分成交訂單", async () => {
    vi.useFakeTimers();
    stubOkxInstrumentSpec();
    const adapter = new OKXAdapter("key", "secret", "passphrase", true);
    const request = vi.fn().mockResolvedValue({
      code: "0",
      data: [{
        ordId: "okx-recovered-1",
        state: "partially_filled",
        avgPx: "63000",
        accFillSz: "1",
        side: "sell",
        reduceOnly: true,
        uTime: "1760000000000",
      }],
    });
    (adapter as any).request = request;

    const truthPromise = adapter.getOrderExecutionTruth(
      "BTC-USDT-SWAP",
      undefined,
      false,
      "mf-recovery-okx",
    );
    await vi.advanceTimersByTimeAsync(800);
    const truth = await truthPromise;

    expect(request).toHaveBeenCalledWith("GET", "/api/v5/trade/order", {
      instId: "BTC-USDT-SWAP",
      clOrdId: "mf-recovery-okx",
    });
    expect(truth).toMatchObject({
      orderId: "okx-recovered-1",
      executionStatus: "partially_filled",
      filledSize: 1,
      executedReduceOnly: true,
    });
  });
});
