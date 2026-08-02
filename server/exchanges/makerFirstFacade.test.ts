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

  it("closePositionSmart 相容 OKX BTC-USDT-SWAP，且指定 long 時只送 reduce-only 賣單並保留 short", async () => {
    const longPosition = {
      symbol: "BTC-USDT-SWAP",
      side: "long" as const,
      size: 0.0079,
      entryPrice: 113_000,
      markPrice: 112_000,
      unrealizedPnl: -7.9,
      leverage: 10,
    };
    const shortPosition = {
      symbol: "BTC-USDT-SWAP",
      side: "short" as const,
      size: 0.1159,
      entryPrice: 115_000,
      markPrice: 112_000,
      unrealizedPnl: 347.7,
      leverage: 10,
    };
    const getPositions = vi.fn()
      .mockResolvedValueOnce([longPosition, shortPosition])
      .mockResolvedValueOnce([shortPosition]);
    const rawPlaceOrder = vi.fn(async (params: OrderParams) => ok("close-long", {
      executionStatus: "filled",
      filledSize: params.size,
    }));
    const raw = makeAdapter({ getPositions, placeOrder: rawPlaceOrder });
    const { dependencies } = harness();
    const guarded = createMakerFirstAdapter(raw, { userId: 7, apiKeyId: 9 }, FAST_POLICY, dependencies);

    const result = await guarded.closePositionSmart(
      "BTCUSDT",
      "long",
      3_000,
      0.02,
      "clOrdId_V35_FULL_CLOSE_120011_1775031500000",
      { executionClass: "MAKER_ONLY", policyContext: { strategyId: 120011, reasonCode: "v35_trailing_take_profit" } },
    );

    expect(result.success).toBe(true);
    expect(getPositions).toHaveBeenCalledTimes(2);
    expect(rawPlaceOrder).toHaveBeenCalledTimes(1);
    expect(rawPlaceOrder.mock.calls[0][0]).toMatchObject({
      symbol: "BTCUSDT",
      side: "sell",
      size: 0.0079,
      reduceOnly: true,
      posSide: "long",
      orderType: "limit",
      postOnly: true,
    });
  });

  it("同帳戶同商品共享 short 腿時只平策略 requestedSize，並允許交易所聚合腿保留其他策略數量", async () => {
    const aggregateShort = {
      symbol: "BTC-USDT-SWAP",
      side: "short" as const,
      size: 0.0424,
      entryPrice: 113_000,
      markPrice: 112_000,
      unrealizedPnl: 42.4,
      leverage: 10,
    };
    const remainingShort = { ...aggregateShort, size: 0.0377 };
    const getPositions = vi.fn()
      .mockResolvedValueOnce([aggregateShort])
      .mockResolvedValueOnce([remainingShort]);
    const rawPlaceOrder = vi.fn(async (params: OrderParams) => ok("close-owned-short", {
      executionStatus: "filled",
      filledSize: params.size,
    }));
    const { dependencies } = harness();
    const guarded = createMakerFirstAdapter(
      makeAdapter({ getPositions, placeOrder: rawPlaceOrder }),
      { userId: 7, apiKeyId: 3 },
      FAST_POLICY,
      dependencies,
    );

    const result = await guarded.closePositionSmart(
      "BTCUSDT",
      "short",
      undefined,
      undefined,
      "strategy-90003-close-short",
      {
        executionClass: "MAKER_ONLY",
        requestedSize: 0.0047,
        policyContext: { strategyId: 90003, reasonCode: "strategy_owned_close" },
      },
    );

    expect(result.success).toBe(true);
    expect(result.policyAudit).toMatchObject({ requestedSize: 0.0047, filledSize: 0.0047 });
    expect(rawPlaceOrder).toHaveBeenCalledTimes(1);
    expect(rawPlaceOrder.mock.calls[0][0]).toMatchObject({
      side: "buy",
      size: 0.0047,
      reduceOnly: true,
      posSide: "short",
      orderType: "limit",
      postOnly: true,
    });
  });

  it("策略 requestedSize 超過交易所指定腿時零 mutation 拒絕，不會退化為整腿平倉", async () => {
    const getPositions = vi.fn(async () => [{
      symbol: "BTC-USDT-SWAP",
      side: "short" as const,
      size: 0.004,
      entryPrice: 113_000,
      markPrice: 112_000,
      unrealizedPnl: 4,
      leverage: 10,
    }]);
    const rawPlaceOrder = vi.fn(async () => ok("must-not-run"));
    const { dependencies } = harness();
    const guarded = createMakerFirstAdapter(
      makeAdapter({ getPositions, placeOrder: rawPlaceOrder }),
      { userId: 7, apiKeyId: 3 },
      FAST_POLICY,
      dependencies,
    );

    const result = await guarded.closePositionSmart(
      "BTCUSDT",
      "short",
      undefined,
      undefined,
      "strategy-90003-close-too-large",
      {
        requestedSize: 0.0047,
        policyContext: { strategyId: 90003, reasonCode: "strategy_owned_close" },
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("交易所 short 腿只有 0.004");
    expect(result.policyAudit).toMatchObject({ attempts: 0, requestedSize: 0.0047, filledSize: 0 });
    expect(rawPlaceOrder).not.toHaveBeenCalled();
  });

  it("closePositionSmart 第五與第六參數不再錯位，長 caller ID 穩定壓縮且完整保留緊急政策上下文", async () => {
    const longPosition = {
      symbol: "BTC-USDT-SWAP",
      side: "long" as const,
      size: 0.01,
      entryPrice: 100,
      markPrice: 100,
      unrealizedPnl: 0,
      leverage: 10,
    };
    const getPositions = vi.fn()
      .mockResolvedValueOnce([longPosition])
      .mockResolvedValueOnce([]);
    const rawPlaceOrder = vi.fn(async (params: OrderParams) => ok("close-emergency", {
      executionStatus: "filled",
      filledSize: params.size,
    }));
    const { dependencies, events } = harness();
    const guarded = createMakerFirstAdapter(
      makeAdapter({ getPositions, placeOrder: rawPlaceOrder }),
      { userId: 7, apiKeyId: 9 },
      FAST_POLICY,
      dependencies,
    );
    const callerId = "clOrdId_V35_FULL_CLOSE_120011_1775031500000";

    const result = await guarded.closePositionSmart(
      "BTCUSDT",
      "long",
      3_000,
      0.02,
      callerId,
      {
        executionClass: "EMERGENCY_EXIT",
        emergencyReason: "STOP_LOSS",
        policyContext: { strategyId: 120011, signalId: 88, source: "V35_MONITOR", reasonCode: "v35_stop_loss" },
      },
    );

    expect(result.success).toBe(true);
    expect(result.policyAudit).toMatchObject({ executionClass: "EMERGENCY_EXIT", emergencyReason: "STOP_LOSS" });
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map(event => event.policyRunId)).size).toBe(1);
    expect(events[0].policyRunId.length).toBeLessThanOrEqual(40);
    expect(events[0]).toMatchObject({
      executionClass: "EMERGENCY_EXIT",
      emergencyReason: "STOP_LOSS",
      strategyId: 120011,
      signalId: 88,
    });
    expect(rawPlaceOrder.mock.calls[0][0]).toMatchObject({
      reduceOnly: true,
      posSide: "long",
      executionClass: "EMERGENCY_EXIT",
      emergencyReason: "STOP_LOSS",
      policyContext: { strategyId: 120011, signalId: 88, reasonCode: "v35_stop_loss" },
    });
  });

  it("相同 policyRunId 已在執行時由冪等鎖零 mutation 拒絕", async () => {
    const rawPlaceOrder = vi.fn(async () => ok("must-not-run"));
    const raw = makeAdapter({ placeOrder: rawPlaceOrder });
    const { dependencies } = harness();
    dependencies.checkActivePolicyRun = vi.fn(async () => true);

    const result = await executeMakerFirst(raw, { userId: 7, apiKeyId: 9 }, {
      symbol: "BTCUSDT",
      side: "sell",
      size: 0.0079,
      reduceOnly: true,
      posSide: "long",
      clientOrderId: "clOrdId_V35_FULL_CLOSE_120011_1775031500000",
      policyContext: { strategyId: 120011, reasonCode: "v35_trailing_take_profit" },
    }, FAST_POLICY, dependencies);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("INTENT_ALREADY_ACTIVE");
    expect(dependencies.checkActivePolicyRun).toHaveBeenCalledTimes(1);
    expect(rawPlaceOrder).not.toHaveBeenCalled();
  });

  it("Runtime intentKey 優先於不穩定 caller ID 作為中央 policyRunId", async () => {
    const rawPlaceOrder = vi.fn(async () => ok("must-not-run"));
    const raw = makeAdapter({ placeOrder: rawPlaceOrder });
    const { dependencies } = harness();
    dependencies.checkActivePolicyRun = vi.fn(async () => true);

    await executeMakerFirst(raw, { userId: 7, apiKeyId: 9 }, {
      symbol: "BTCUSDT",
      side: "buy",
      size: 0.1238,
      reduceOnly: true,
      posSide: "short",
      clientOrderId: "close-with-changing-timestamp-1700000009999",
      policyContext: {
        strategyId: 120011,
        reasonCode: "trailing_take_profit",
        intentKey: "runtime-event-120011-short-close",
      },
    }, FAST_POLICY, dependencies);

    expect(dependencies.checkActivePolicyRun).toHaveBeenCalledWith("runtime-event-120011-short-close");
    expect(rawPlaceOrder).not.toHaveBeenCalled();
  });

  it("Maker 聲稱成交但指定 long 腿仍存在時 fail-closed，不把策略本地狀態誤重置", async () => {
    const longPosition = {
      symbol: "BTC-USDT-SWAP",
      side: "long" as const,
      size: 0.0079,
      entryPrice: 113_000,
      markPrice: 112_000,
      unrealizedPnl: -7.9,
      leverage: 10,
    };
    const shortPosition = {
      symbol: "BTC-USDT-SWAP",
      side: "short" as const,
      size: 0.1159,
      entryPrice: 115_000,
      markPrice: 112_000,
      unrealizedPnl: 347.7,
      leverage: 10,
    };
    const getPositions = vi.fn()
      .mockResolvedValueOnce([longPosition, shortPosition])
      .mockResolvedValueOnce([longPosition, shortPosition]);
    const rawPlaceOrder = vi.fn(async (params: OrderParams) => ok("close-not-confirmed", {
      executionStatus: "filled",
      filledSize: params.size,
    }));
    const { dependencies } = harness();
    const guarded = createMakerFirstAdapter(
      makeAdapter({ getPositions, placeOrder: rawPlaceOrder }),
      { userId: 7, apiKeyId: 9 },
      FAST_POLICY,
      dependencies,
    );

    const result = await guarded.closePositionSmart(
      "BTCUSDT",
      "long",
      3_000,
      0.02,
      "v35-close-not-confirmed",
      { policyContext: { strategyId: 120011, reasonCode: "v35_trailing_take_profit" } },
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("持倉仍存在");
    expect(result.policyAudit).toMatchObject({ requestedSize: 0.0079, filledSize: 0.0079 });
    expect(getPositions).toHaveBeenCalledTimes(2);
    expect(rawPlaceOrder).toHaveBeenCalledTimes(1);
    expect(rawPlaceOrder.mock.calls[0][0]).toMatchObject({
      side: "sell",
      posSide: "long",
      reduceOnly: true,
    });
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
