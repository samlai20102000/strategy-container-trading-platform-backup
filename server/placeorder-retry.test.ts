import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 測試 OKX placeOrder 的 50001 重試機制
 * 驗證：
 * 1. 50001 暫時性錯誤會自動重試（最多 3 次）
 * 2. 重試成功後正確返回結果
 * 3. 非暫時性錯誤不會重試
 * 4. 網路超時也會重試
 */

const originalFetch = global.fetch;
let orderCallCount = 0;
let orderResponses: any[] = [];
let orderBodies: Record<string, unknown>[] = [];
let leverageBodies: Record<string, unknown>[] = [];
let accountConfigHeaders: Record<string, string>[] = [];

beforeEach(() => {
  orderCallCount = 0;
  orderResponses = [];
  orderBodies = [];
  leverageBodies = [];
  accountConfigHeaders = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

/**
 * Setup mock that routes by URL pattern:
 * - /api/v5/trade/order (POST) → uses orderResponses queue
 * - Everything else → returns generic success
 */
function setupMock(responses: any[], positionMode: string = "long_short_mode") {
  orderResponses = [...responses];
  orderCallCount = 0;

  global.fetch = vi.fn(async (url: string | URL, init?: any) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const method = init?.method || "GET";

    // Route /trade/order POST calls through the response queue
    if (urlStr.includes("/api/v5/trade/order") && method === "POST") {
      orderBodies.push(JSON.parse(init?.body || "{}"));
      const idx = orderCallCount++;
      const resp = orderResponses[idx] || orderResponses[orderResponses.length - 1];

      if (resp?.error) {
        throw resp.error;
      }
      return { ok: true, json: async () => resp.data, status: 200 } as Response;
    }

    if (urlStr.includes("/api/v5/account/config")) {
      accountConfigHeaders.push(init?.headers || {});
      return {
        ok: true,
        json: async () => ({ code: "0", data: [{ acctLv: "2", posMode: positionMode, uid: "demo-sub-account" }] }),
        status: 200,
      } as Response;
    }

    if (urlStr.includes("/api/v5/account/set-leverage") && method === "POST") {
      leverageBodies.push(JSON.parse(init?.body || "{}"));
      return {
        ok: true,
        json: async () => ({ code: "0", data: [] }),
        status: 200,
      } as Response;
    }

    // /api/v5/public/instruments → contract specs
    if (urlStr.includes("/api/v5/public/instruments")) {
      return {
        ok: true,
        json: async () => ({
          code: "0",
          data: [{ instId: "BTC-USDT-SWAP", state: "live", ctVal: "0.01", lotSz: "1", minSz: "1" }],
        }),
        status: 200,
      } as Response;
    }

    // Everything else (setLeverage, getAccountConfig, etc.) → success
    return {
      ok: true,
      json: async () => ({ code: "0", data: [] }),
      status: 200,
    } as Response;
  }) as any;
}

describe("OKX placeOrder 重試機制", () => {
  it("50001 錯誤應自動重試並在成功後返回正確結果", async () => {
    setupMock([
      // attempt 0: 50001 error
      { data: { code: "1", data: [{ sCode: "50001", sMsg: "Service temporarily unavailable" }] } },
      // attempt 1: success
      { data: { code: "0", data: [{ sCode: "0", ordId: "test-order-123" }] } },
    ]);

    const { OKXAdapter } = await import("./exchanges/okx");
    const adapter = new OKXAdapter("key1", "secret1", "pass1", true);

    const result = await adapter.placeOrder({
      symbol: "BTCUSDT",
      side: "sell",
      orderType: "limit",
      size: 0.01,
      price: 65000,
      leverage: 5,
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("test-order-123");
    expect(orderCallCount).toBe(2); // 1 failed + 1 success
  });

  it("非暫時性錯誤（如 51008 資金不足）不應重試", async () => {
    setupMock([
      // attempt 0: 51008 (NOT retryable)
      { data: { code: "1", data: [{ sCode: "51008", sMsg: "Order failed. Insufficient balance" }] } },
    ]);

    const { OKXAdapter } = await import("./exchanges/okx");
    const adapter = new OKXAdapter("key2", "secret2", "pass2", true);

    const result = await adapter.placeOrder({
      symbol: "BTCUSDT",
      side: "buy",
      orderType: "market",
      size: 0.01,
      leverage: 5,
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBeDefined();
    // Should only have ONE placeOrder call (no retry for non-retryable errors)
    expect(orderCallCount).toBe(1);
  });

  it("網路超時應重試並最終成功", async () => {
    setupMock([
      // attempt 0: network timeout
      { error: new Error("連線逾時（10 秒），請檢查網路或防火牆設定") },
      // attempt 1: success
      { data: { code: "0", data: [{ sCode: "0", ordId: "retry-success-456" }] } },
    ]);

    const { OKXAdapter } = await import("./exchanges/okx");
    const adapter = new OKXAdapter("key3", "secret3", "pass3", true);

    const result = await adapter.placeOrder({
      symbol: "BTCUSDT",
      side: "buy",
      orderType: "market",
      size: 0.01,
      leverage: 5,
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("retry-success-456");
    expect(orderCallCount).toBe(2); // 1 failed + 1 success
  });

  it("所有重試用完後應返回失敗", async () => {
    setupMock([
      // All attempts fail with 50001
      { data: { code: "1", data: [{ sCode: "50001", sMsg: "Service temporarily unavailable" }] } },
      { data: { code: "1", data: [{ sCode: "50001", sMsg: "Service temporarily unavailable" }] } },
      { data: { code: "1", data: [{ sCode: "50001", sMsg: "Service temporarily unavailable" }] } },
      { data: { code: "1", data: [{ sCode: "50001", sMsg: "Service temporarily unavailable" }] } },
    ]);

    const { OKXAdapter } = await import("./exchanges/okx");
    const adapter = new OKXAdapter("key4", "secret4", "pass4", true);

    const result = await adapter.placeOrder({
      symbol: "BTCUSDT",
      side: "sell",
      orderType: "limit",
      size: 0.01,
      price: 65000,
      leverage: 5,
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBeDefined();
    expect(result.errorMessage!.length).toBeGreaterThan(0);
    // Should have multiple attempts (at least 2 before circuit breaker kicks in)
    expect(orderCallCount).toBeGreaterThanOrEqual(2);
  }, 30000);
});

describe("OKX placeOrder posMode 契約", () => {
  const success = { data: { code: "0", data: [{ sCode: "0", ordId: "mode-order-1" }] } };

  it("long_short_mode 開多應送 posSide=long，槓桿亦使用 long", async () => {
    setupMock([success], "long_short_mode");
    const { OKXAdapter } = await import("./exchanges/okx");
    const adapter = new OKXAdapter("key-dual-long", "secret", "pass", true);

    const result = await adapter.placeOrder({
      symbol: "BTCUSDT",
      side: "buy",
      orderType: "limit",
      price: 65000,
      size: 0.01,
      leverage: 5,
    });

    expect(result.success).toBe(true);
    expect(orderBodies[0]?.posSide).toBe("long");
    expect(leverageBodies[0]?.posSide).toBe("long");
    expect(accountConfigHeaders[0]?.["x-simulated-trading"]).toBe("1");
  });

  it("long_short_mode 開空應送 posSide=short", async () => {
    setupMock([success], "long_short_mode");
    const { OKXAdapter } = await import("./exchanges/okx");
    const adapter = new OKXAdapter("key-dual-short", "secret", "pass", true);

    const result = await adapter.placeOrder({
      symbol: "BTCUSDT",
      side: "sell",
      orderType: "limit",
      price: 65000,
      size: 0.01,
      leverage: 5,
    });

    expect(result.success).toBe(true);
    expect(orderBodies[0]?.posSide).toBe("short");
    expect(leverageBodies[0]?.posSide).toBe("short");
  });

  it("net_mode 開倉與設定槓桿都應省略 posSide", async () => {
    setupMock([success], "net_mode");
    const { OKXAdapter } = await import("./exchanges/okx");
    const adapter = new OKXAdapter("key-net", "secret", "pass", true);

    const result = await adapter.placeOrder({
      symbol: "BTCUSDT",
      side: "buy",
      orderType: "limit",
      price: 65000,
      size: 0.01,
      leverage: 5,
      posSide: "net",
    });

    expect(result.success).toBe(true);
    expect(orderBodies[0]).not.toHaveProperty("posSide");
    expect(leverageBodies[0]).not.toHaveProperty("posSide");
  });

  it("未知 posMode 應 fail-closed，且不得送出交易訂單", async () => {
    setupMock([success], "unknown");
    const { OKXAdapter } = await import("./exchanges/okx");
    const adapter = new OKXAdapter("key-unknown", "secret", "pass", true);

    const result = await adapter.placeOrder({
      symbol: "BTCUSDT",
      side: "buy",
      orderType: "limit",
      price: 65000,
      size: 0.01,
      leverage: 5,
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("為避免 51010 已取消下單");
    expect(orderCallCount).toBe(0);
    expect(orderBodies).toHaveLength(0);
  });
});
