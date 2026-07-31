import { orderPolicyEvents, type InsertOrderPolicyEvent } from "../../drizzle/schema";
import { describe, expect, it, vi } from "vitest";
import type { ExchangeAdapter, OrderParams, OrderResult } from "../exchanges/types";
import { __orderPolicyRecoveryTestUtils } from "./orderPolicyRecovery";

type EventRow = typeof orderPolicyEvents.$inferSelect;

const POLICY_CONFIG = {
  standardTtlMs: 10,
  standardMaxAttempts: 3,
  emergencyTtlMs: 4,
  emergencyMakerAttempts: 2,
  pollIntervalMs: 2,
};

function ok(orderId?: string, extra: Partial<OrderResult> = {}): OrderResult {
  return { success: true, orderId, rawResponse: "{}", ...extra };
}

function makeAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    exchange: "bybit",
    testConnection: vi.fn(async () => ({ success: true, message: "ok" })),
    setLeverage: vi.fn(async () => undefined),
    placeOrder: vi.fn(async params => ok(params.clientOrderId, {
      executionStatus: "filled",
      filledSize: params.size,
      filledPrice: 100.4,
    })),
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
    getOrderExecutionTruth: vi.fn(async () => ({ executionStatus: "unknown" })),
    ...overrides,
  } as ExchangeAdapter;
}

function event(
  id: number,
  eventType: EventRow["eventType"],
  overrides: Partial<EventRow> = {},
): EventRow {
  return {
    id,
    policyRunId: "run-recovery-1",
    userId: 7,
    apiKeyId: 9,
    strategyId: 11,
    signalId: 13,
    exchange: "bybit",
    eventType,
    executionClass: "MAKER_ONLY",
    emergencyReason: null,
    clientOrderId: "run-recovery-1",
    exchangeOrderId: null,
    symbol: "BTCUSDT",
    side: "buy",
    reduceOnly: false,
    attempt: 0,
    requestedSize: "1.000000000000",
    filledSize: "0.000000000000",
    remainingSize: "1.000000000000",
    price: null,
    reasonCode: "TEST",
    message: null,
    details: null,
    eventAt: id * 1_000,
    createdAt: new Date(id * 1_000),
    ...overrides,
  } as EventRow;
}

function intentEvent(overrides: Partial<EventRow> = {}): EventRow {
  return event(1, "INTENT_RECEIVED", {
    details: {
      recoverableIntent: {
        symbol: "BTCUSDT",
        side: "buy",
        size: 1,
        reduceOnly: false,
        executionClass: "MAKER_ONLY",
        policyContext: { strategyId: 11, signalId: 13, reasonCode: "ENTRY" },
      },
      policyConfig: POLICY_CONFIG,
    },
    ...overrides,
  });
}

function harness() {
  let clock = 100_000;
  const emitted: InsertOrderPolicyEvent[] = [];
  return {
    emitted,
    dependencies: {
      now: () => clock,
      sleep: async (ms: number) => { clock += Math.max(1, ms); },
      recordEvent: async (audit: InsertOrderPolicyEvent) => {
        emitted.push(audit);
        return true;
      },
    },
  };
}

describe("Maker-First durable recovery", () => {
  it("以 clientOrderId 找回送單成功但 accepted 尚未落庫的成交，不重複下單", async () => {
    const placeOrder = vi.fn(async () => ok("must-not-run"));
    const truth = vi.fn(async () => ({
      success: true,
      orderId: "exchange-1",
      rawResponse: "{}",
      executionStatus: "filled" as const,
      filledSize: 1,
    }));
    const adapter = makeAdapter({ placeOrder, getOrderExecutionTruth: truth });
    const { emitted, dependencies } = harness();
    const events = [
      intentEvent(),
      event(2, "MAKER_SUBMIT", { clientOrderId: "maker-client-1", attempt: 1 }),
    ];

    const result = await __orderPolicyRecoveryTestUtils.recoverRunWithAdapter(events, adapter, dependencies);

    expect(result.status).toBe("recovered");
    expect(placeOrder).not.toHaveBeenCalled();
    expect(truth).toHaveBeenCalledWith("BTCUSDT", undefined, false, "maker-client-1");
    expect(emitted.at(-1)).toMatchObject({
      policyRunId: "run-recovery-1",
      eventType: "MAKER_FILLED",
      exchangeOrderId: "exchange-1",
      reasonCode: "RECOVERY_EXCHANGE_FILLED",
    });
  });

  it("交易所查無送單時以同一 clientOrderId 重試同一 attempt，維持 post-only", async () => {
    const placeOrder = vi.fn(async (params: OrderParams) => ok("exchange-retry", {
      executionStatus: "filled",
      filledSize: params.size,
      filledPrice: 100.4,
    }));
    const adapter = makeAdapter({ placeOrder });
    const { emitted, dependencies } = harness();
    const events = [
      intentEvent(),
      event(2, "MAKER_SUBMIT", { clientOrderId: "maker-client-1", attempt: 1 }),
    ];

    const result = await __orderPolicyRecoveryTestUtils.recoverRunWithAdapter(events, adapter, dependencies);

    expect(result.status).toBe("resumed");
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0]).toMatchObject({
      clientOrderId: "maker-client-1",
      orderType: "limit",
      postOnly: true,
      size: 1,
    });
    expect(emitted.some(audit => audit.eventType === "EMERGENCY_FALLBACK")).toBe(false);
  });

  it("先撤銷未決部分成交子單，再從下一 attempt 只重掛剩餘量", async () => {
    const placeOrder = vi.fn(async (params: OrderParams) => ok("exchange-2", {
      executionStatus: "filled",
      filledSize: params.size,
      filledPrice: 100.4,
    }));
    const cancelOrder = vi.fn(async (_symbol: string, orderId: string) => ok(orderId, {
      executionStatus: "cancelled",
      filledSize: 0.5,
    }));
    const adapter = makeAdapter({
      placeOrder,
      cancelOrder,
      getOrderExecutionTruth: vi.fn(async () => ok("exchange-1", {
        executionStatus: "partially_filled",
        filledSize: 0.5,
      })),
    });
    const { emitted, dependencies } = harness();
    const events = [
      intentEvent(),
      event(2, "MAKER_SUBMIT", { clientOrderId: "maker-client-1", attempt: 1 }),
      event(3, "MAKER_ACCEPTED", { clientOrderId: "maker-client-1", exchangeOrderId: "exchange-1", attempt: 1 }),
      event(4, "MAKER_PARTIAL", {
        clientOrderId: "maker-client-1",
        exchangeOrderId: "exchange-1",
        attempt: 1,
        filledSize: "0.400000000000",
        remainingSize: "0.600000000000",
        details: { childFilled: 0.4 },
      }),
    ];

    const result = await __orderPolicyRecoveryTestUtils.recoverRunWithAdapter(events, adapter, dependencies);

    expect(result.status).toBe("resumed");
    expect(cancelOrder).toHaveBeenCalledWith("BTCUSDT", "exchange-1");
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0]).toMatchObject({
      orderType: "limit",
      postOnly: true,
      size: 0.5,
    });
    expect(emitted.map(audit => audit.reasonCode)).toContain("RECOVERY_CANCEL_REQUEST");
    expect(emitted.map(audit => audit.eventType)).toContain("MAKER_CANCELLED");
  });

  it("緊急 taker 已送出但狀態不確定時 fail-closed，絕不補送第二張市價單", async () => {
    const placeOrder = vi.fn(async () => ok("must-not-run"));
    const adapter = makeAdapter({
      placeOrder,
      getOrderExecutionTruth: vi.fn(async () => ok("emergency-market-1", { executionStatus: "unknown" })),
    });
    const { emitted, dependencies } = harness();
    const emergencyOrigin = intentEvent({
      executionClass: "EMERGENCY_EXIT",
      emergencyReason: "STOP_LOSS",
      side: "sell",
      reduceOnly: true,
      details: {
        recoverableIntent: {
          symbol: "BTCUSDT",
          side: "sell",
          size: 1,
          reduceOnly: true,
          executionClass: "EMERGENCY_EXIT",
          emergencyReason: "STOP_LOSS",
          policyContext: { reasonCode: "HARD_STOP" },
        },
        policyConfig: POLICY_CONFIG,
      },
    });
    const events = [
      emergencyOrigin,
      event(2, "MAKER_SUBMIT", { executionClass: "EMERGENCY_EXIT", emergencyReason: "STOP_LOSS", side: "sell", reduceOnly: true, clientOrderId: "maker-1", attempt: 1 }),
      event(3, "MAKER_CANCELLED", { executionClass: "EMERGENCY_EXIT", emergencyReason: "STOP_LOSS", side: "sell", reduceOnly: true, clientOrderId: "maker-1", attempt: 1 }),
      event(4, "MAKER_SUBMIT", { executionClass: "EMERGENCY_EXIT", emergencyReason: "STOP_LOSS", side: "sell", reduceOnly: true, clientOrderId: "maker-2", attempt: 2 }),
      event(5, "MAKER_CANCELLED", { executionClass: "EMERGENCY_EXIT", emergencyReason: "STOP_LOSS", side: "sell", reduceOnly: true, clientOrderId: "maker-2", attempt: 2 }),
      event(6, "EMERGENCY_FALLBACK", {
        executionClass: "EMERGENCY_EXIT",
        emergencyReason: "STOP_LOSS",
        side: "sell",
        reduceOnly: true,
        clientOrderId: "emergency-client-1",
        attempt: 3,
      }),
    ];

    const result = await __orderPolicyRecoveryTestUtils.recoverRunWithAdapter(events, adapter, dependencies);

    expect(result.status).toBe("recovered");
    expect(placeOrder).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({
      eventType: "FAILED",
      reasonCode: "RECOVERY_EMERGENCY_TAKER_UNCERTAIN",
    });
  });
});
