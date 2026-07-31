import { describe, expect, it, vi } from "vitest";
import type { InsertOrderPolicyEvent } from "../../drizzle/schema";
import { __tradeExecutionLedgerTestUtils } from "../services/tradeExecutionLedger";
import {
  createMakerFirstAdapter,
  executeMakerFirst,
  type MakerFirstDependencies,
  type MakerFirstPolicyConfig,
} from "./makerFirstFacade";
import type {
  ExchangeAdapter,
  OrderParams,
  OrderResult,
} from "./types";

const FAST_POLICY: Readonly<MakerFirstPolicyConfig> = Object.freeze({
  standardTtlMs: 10,
  standardMaxAttempts: 3,
  emergencyTtlMs: 4,
  emergencyMakerAttempts: 2,
  pollIntervalMs: 2,
  allowStopLossTaker: true,
  allowDailyLossTaker: true,
  allowKillSwitchTaker: true,
});

function ok(orderId?: string, extra: Partial<OrderResult> = {}): OrderResult {
  return { success: true, orderId, rawResponse: "{}", ...extra };
}

function makeAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    exchange: "bybit",
    testConnection: vi.fn(async () => ({ success: true, message: "ok" })),
    setLeverage: vi.fn(async () => undefined),
    placeOrder: vi.fn(async () => ok("maker-1")),
    getBalance: vi.fn(async () => ({ asset: "USDT", free: 1_000, total: 1_000, unrealizedPnl: 0 })),
    getPositions: vi.fn(async () => []),
    probeCapabilities: vi.fn(async symbol => ({
      exchange: "bybit",
      symbol,
      positionMode: "ONE_WAY",
      preciseLegClose: true,
      observedAt: 0,
      source: "test",
    })),
    probeInstrument: vi.fn(async symbol => ({
      exchange: "bybit",
      symbol,
      exists: true,
      active: true,
      minOrderSize: 0.001,
      quantityStep: 0.001,
      priceStep: 0.1,
      observedAt: 0,
      source: "test",
    })),
    getBestBidAsk: vi.fn(async symbol => ({ symbol, bid: 100, ask: 100.5, observedAt: 0, source: "test" })),
    cancelOrder: vi.fn(async (_symbol, orderId) => ok(orderId, { executionStatus: "cancelled" })),
    closePosition: vi.fn(async () => ok()),
    closePositionSmart: vi.fn(async () => ok()),
    getClosedPnl: vi.fn(async () => []),
    getOrderExecutionTruth: vi.fn(async () => ({ executionStatus: "filled", filledSize: 1 })),
    ...overrides,
  } as ExchangeAdapter;
}

function harness(recordResult = true) {
  let clock = 0;
  let id = 0;
  const events: InsertOrderPolicyEvent[] = [];
  const dependencies: MakerFirstDependencies = {
    now: () => clock,
    sleep: async ms => {
      clock += Math.max(1, ms);
    },
    createClientOrderId: (attempt, emergencyMarket) => `test-${emergencyMarket ? "market" : "maker"}-${attempt}-${++id}`,
    recordEvent: async event => {
      events.push(event);
      return recordResult;
    },
  };
  return { dependencies, events };
}

describe("GLOBAL_MAKER_FIRST_B_V1", () => {
  it("在 factory facade 邊界把 legacy market 開倉改為具唯一 client id 的 post-only limit", async () => {
    const rawPlaceOrder = vi.fn(async (_params: OrderParams) => ok("maker-accepted"));
    const raw = makeAdapter({
      placeOrder: rawPlaceOrder,
      getOrderExecutionTruth: vi.fn(async () => ({
        executionStatus: "filled",
        filledSize: 1,
        filledPrice: 100.4,
      })),
    });
    const { dependencies, events } = harness();
    const guarded = createMakerFirstAdapter(raw, { userId: 7, apiKeyId: 9 }, FAST_POLICY, dependencies);

    const result = await guarded.placeOrder({
      symbol: "BTCUSDT",
      side: "buy",
      orderType: "market",
      size: 1,
    });

    expect(result.success).toBe(true);
    expect(result.policyAudit).toMatchObject({
      executionClass: "MAKER_ONLY",
      fallbackUsed: false,
      finalOrderType: "post_only",
      remainingSize: 0,
    });
    expect(rawPlaceOrder).toHaveBeenCalledTimes(1);
    expect(rawPlaceOrder.mock.calls[0][0]).toMatchObject({
      orderType: "limit",
      postOnly: true,
      price: 100.4,
    });
    expect(rawPlaceOrder.mock.calls[0][0].clientOrderId).toMatch(/^test-maker-1-/);
    expect(events.map(event => event.eventType)).toEqual([
      "INTENT_RECEIVED",
      "MAKER_SUBMIT",
      "MAKER_ACCEPTED",
      "MAKER_FILLED",
    ]);
  });

  it("一般開倉逾期只撤單重掛三次，永遠不送 market", async () => {
    let order = 0;
    const rawPlaceOrder = vi.fn(async () => ok(`maker-${++order}`));
    const cancelOrder = vi.fn(async (_symbol: string, orderId: string) => ok(orderId, { executionStatus: "cancelled" }));
    const adapter = makeAdapter({
      placeOrder: rawPlaceOrder,
      cancelOrder,
      getOrderExecutionTruth: vi.fn(async () => ({ executionStatus: "unknown" })),
    });
    const { dependencies, events } = harness();

    const result = await executeMakerFirst(adapter, { userId: 1, apiKeyId: 2 }, {
      symbol: "BTCUSDT",
      side: "buy",
      size: 1,
    }, FAST_POLICY, dependencies);

    expect(result.success).toBe(false);
    expect(result.policyAudit).toMatchObject({ attempts: 3, fallbackUsed: false, finalOrderType: "post_only" });
    expect(rawPlaceOrder).toHaveBeenCalledTimes(3);
    expect(rawPlaceOrder.mock.calls.every(call => call[0].orderType === "limit" && call[0].postOnly === true)).toBe(true);
    expect(cancelOrder).toHaveBeenCalledTimes(3);
    expect(events.at(-1)?.eventType).toBe("MAKER_EXPIRED");
  });

  it("部分成交只對剩餘量重掛，緊急類別完成兩次 maker 後才可 market fallback", async () => {
    let makerOrders = 0;
    const rawPlaceOrder = vi.fn(async (params: OrderParams) => {
      if (params.orderType === "market") {
        return ok("emergency-market", { executionStatus: "filled", filledSize: params.size, filledPrice: 100.6 });
      }
      return ok(`maker-${++makerOrders}`);
    });
    const truthCalls = new Map<string, number>();
    const adapter = makeAdapter({
      placeOrder: rawPlaceOrder,
      getOrderExecutionTruth: vi.fn(async (_symbol, orderId) => {
        const call = (truthCalls.get(orderId) ?? 0) + 1;
        truthCalls.set(orderId, call);
        if (orderId === "maker-1") {
          return { executionStatus: call >= 4 ? "cancelled" : "partially_filled", filledSize: 0.4 };
        }
        return { executionStatus: call >= 4 ? "cancelled" : "unknown" };
      }),
    });
    const { dependencies, events } = harness();

    const result = await executeMakerFirst(adapter, { userId: 1, apiKeyId: 2 }, {
      symbol: "BTCUSDT",
      side: "sell",
      size: 1,
      reduceOnly: true,
      executionClass: "EMERGENCY_EXIT",
      emergencyReason: "STOP_LOSS",
    }, FAST_POLICY, dependencies);

    expect(result.success).toBe(true);
    expect(result.filledSize).toBeCloseTo(1);
    expect(result.policyAudit).toMatchObject({
      attempts: 2,
      fallbackUsed: true,
      finalOrderType: "market",
      filledSize: 1,
      remainingSize: 0,
    });
    expect(rawPlaceOrder).toHaveBeenCalledTimes(3);
    expect(rawPlaceOrder.mock.calls.map(call => call[0].orderType)).toEqual(["limit", "limit", "market"]);
    expect(rawPlaceOrder.mock.calls[1][0].size).toBeCloseTo(0.6);
    expect(rawPlaceOrder.mock.calls[2][0]).toMatchObject({
      size: 0.6,
      reduceOnly: true,
      executionClass: "EMERGENCY_EXIT",
      emergencyReason: "STOP_LOSS",
    });
    expect(events.map(event => event.eventType)).toContain("MAKER_PARTIAL");
    expect(events.map(event => event.eventType)).toContain("EMERGENCY_FALLBACK");
    expect(events.at(-1)?.eventType).toBe("EMERGENCY_FILLED");
  });

  it("未授權的 emergency 或非 reduce-only 緊急單會先稽核 FAILED，再零 mutation 拒絕", async () => {
    const rawPlaceOrder = vi.fn(async () => ok("must-not-run"));
    const probeInstrument = vi.fn(async () => {
      throw new Error("must-not-run");
    });
    const adapter = makeAdapter({ placeOrder: rawPlaceOrder, probeInstrument });
    const { dependencies, events } = harness();

    const result = await executeMakerFirst(adapter, { userId: 1, apiKeyId: 2 }, {
      symbol: "BTCUSDT",
      side: "sell",
      size: 1,
      reduceOnly: false,
      executionClass: "EMERGENCY_EXIT",
      emergencyReason: "KILL_SWITCH",
    }, FAST_POLICY, dependencies);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("UNAUTHORIZED_EMERGENCY_EXIT");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "FAILED", reasonCode: "UNAUTHORIZED_EMERGENCY_EXIT" });
    expect(probeInstrument).not.toHaveBeenCalled();
    expect(rawPlaceOrder).not.toHaveBeenCalled();
  });

  it("append-only 稽核不可用時 fail-closed，不讀行情也不送單", async () => {
    const rawPlaceOrder = vi.fn(async () => ok("must-not-run"));
    const getBestBidAsk = vi.fn(async () => ({ symbol: "BTCUSDT", bid: 100, ask: 101, observedAt: 0, source: "test" }));
    const adapter = makeAdapter({ placeOrder: rawPlaceOrder, getBestBidAsk });
    const { dependencies } = harness(false);

    const result = await executeMakerFirst(adapter, { userId: 1, apiKeyId: 2 }, {
      symbol: "BTCUSDT",
      side: "buy",
      size: 1,
    }, FAST_POLICY, dependencies);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("稽核不可用");
    expect(getBestBidAsk).not.toHaveBeenCalled();
    expect(rawPlaceOrder).not.toHaveBeenCalled();
  });

  it("撤單未確認時停止整個 intent，避免同時存在第二張 live order", async () => {
    const rawPlaceOrder = vi.fn(async () => ok("maker-live"));
    const adapter = makeAdapter({
      placeOrder: rawPlaceOrder,
      cancelOrder: vi.fn(async () => ({ success: false, rawResponse: "{}", errorMessage: "timeout" })),
      getOrderExecutionTruth: vi.fn(async () => ({ executionStatus: "unknown" })),
    });
    const { dependencies, events } = harness();

    const result = await executeMakerFirst(adapter, { userId: 1, apiKeyId: 2 }, {
      symbol: "BTCUSDT",
      side: "buy",
      size: 1,
    }, FAST_POLICY, dependencies);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("撤單未確認");
    expect(rawPlaceOrder).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ eventType: "FAILED", reasonCode: "CANCEL_NOT_CONFIRMED" });
  });

  it("ledger 依 policyAudit 記錄實際 post-only，而非 legacy market 標籤", () => {
    const makerResult: OrderResult = {
      success: true,
      rawResponse: "{}",
      policyAudit: {
        policyVersion: "GLOBAL_MAKER_FIRST_B_V1",
        executionClass: "MAKER_ONLY",
        attempts: 1,
        fallbackUsed: false,
        requestedSize: 1,
        filledSize: 1,
        remainingSize: 0,
        finalOrderType: "post_only",
        clientOrderIds: ["maker-1"],
      },
    };
    expect(__tradeExecutionLedgerTestUtils.resolveRecordedOrderType("market", makerResult)).toBe("limit");
    expect(__tradeExecutionLedgerTestUtils.resolveRecordedOrderType("limit", {
      ...makerResult,
      policyAudit: { ...makerResult.policyAudit!, finalOrderType: "market" },
    })).toBe("market");
  });
});
