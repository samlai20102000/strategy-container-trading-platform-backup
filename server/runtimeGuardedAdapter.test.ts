import { describe, expect, it, vi } from "vitest";
import type { ModeDecision } from "../shared/executionModes";
import type { ExchangeAdapter, OrderResult } from "./exchanges/types";
import { createRuntimeGuardedAdapter } from "./exchanges/runtimeGuardedAdapter";
import type { RuntimeAuthorizer } from "./exchanges/runtimeGuardedAdapter";

const baseDecision: ModeDecision = {
  decisionId: "decision:1",
  candidateId: "candidate:1",
  deploymentId: 1,
  executionMode: "MULTI_POSITION",
  outcome: "APPROVED",
  reasonCode: "M2_NEW_INDEPENDENT_LEG",
  targetLegId: "leg:1",
  targetSide: "LONG",
  targetRole: "INDEPENDENT",
  approvedQuantity: 0.3,
  reduceOnly: false,
  contextSnapshot: {},
  createdAt: 1,
};

function adapter() {
  const success: OrderResult = { success: true, orderId: "order-1", rawResponse: "{}", executionStatus: "filled" };
  return {
    exchange: "okx" as const,
    placeOrder: vi.fn(async () => success),
    closePosition: vi.fn(async () => success),
    closePositionSmart: vi.fn(async () => success),
  } as unknown as ExchangeAdapter;
}

function authorizer(decision: ModeDecision, allowed = true): RuntimeAuthorizer {
  return vi.fn(async input => ({
    allowed,
    envelope: {
      candidate: {
        candidateId: decision.candidateId,
        deploymentId: 1,
        action: input.signal.action === "close" ? "CLOSE_ALL" : input.signal.action === "buy" ? "OPEN_LONG" : "OPEN_SHORT",
        source: input.signal.source ?? "WEBHOOK",
        reasonCode: "TEST",
        reason: "test",
        createdAt: 1,
      },
      decision,
      policy: {
        contractVersion: "execution-policy-v1",
        mode: "MULTI_POSITION",
        maxOpenLegs: 2,
        independentLegState: true,
        legScopedMartin: true,
        riskBudget: {
          maxGrossNotionalPct: 100,
          maxMarginUsagePct: 50,
          maxMarginPerLegPct: 25,
          capabilityTtlSeconds: 300,
          instrumentTtlSeconds: 300,
        },
      },
      activationState: "ACTIVE",
    },
  }));
}

const context = {
  strategy: {
    id: 1,
    userId: 2,
    apiKeyId: 3,
    deploymentKey: "guarded-adapter",
    executionMode: "MULTI_POSITION" as const,
    executionPolicy: null,
    activationState: "ACTIVE" as const,
    symbol: "BTCUSDT",
  },
  source: "AUTO" as const,
  eventKey: "bar-100",
};

describe("runtime guarded exchange adapter", () => {
  it("拒絕 decision 不觸達 placeOrder", async () => {
    const raw = adapter();
    const guarded = createRuntimeGuardedAdapter(raw, context, authorizer({
      ...baseDecision,
      outcome: "REJECTED",
      reasonCode: "ACTIVATION_PAUSED",
    }, false));
    const result = await guarded.placeOrder({
      symbol: "BTCUSDT",
      side: "buy",
      orderType: "market",
      size: 1,
    });

    expect(result.success).toBe(false);
    expect(raw.placeOrder).not.toHaveBeenCalled();
    expect(result.rawResponse).toContain("ACTIVATION_PAUSED");
  });

  it("以 canonical approved quantity 與 target posSide 送 advanced-mode order", async () => {
    const raw = adapter();
    const guarded = createRuntimeGuardedAdapter(raw, context, authorizer(baseDecision));
    await guarded.placeOrder({ symbol: "BTCUSDT", side: "buy", orderType: "market", size: 1 });

    expect(raw.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      size: 0.3,
      posSide: "long",
      reduceOnly: false,
    }));
  });

  it("advanced close-all 依 decision closeLegs 拆成逐腿精確平倉", async () => {
    const raw = adapter();
    const decision: ModeDecision = {
      ...baseDecision,
      outcome: "CLOSE_ONLY",
      reasonCode: "LEG_SCOPED_CLOSE_REQUIRED",
      reduceOnly: true,
      targetSide: undefined,
      contextSnapshot: {
        closeLegs: [
          { legId: "long-leg", side: "LONG", quantity: 0.2 },
          { legId: "short-leg", side: "SHORT", quantity: 0.1 },
        ],
      },
    };
    const guarded = createRuntimeGuardedAdapter(raw, context, authorizer(decision));
    const result = await guarded.closePositionSmart("BTCUSDT");

    expect(result.success).toBe(true);
    expect(raw.closePositionSmart).not.toHaveBeenCalled();
    expect(raw.placeOrder).toHaveBeenNthCalledWith(1, expect.objectContaining({
      symbol: "BTCUSDT",
      side: "sell",
      size: 0.2,
      posSide: "long",
      reduceOnly: true,
    }));
    expect(raw.placeOrder).toHaveBeenNthCalledWith(2, expect.objectContaining({
      symbol: "BTCUSDT",
      side: "buy",
      size: 0.1,
      posSide: "short",
      reduceOnly: true,
    }));
  });

  it("single-exclusive closePositionSmart 完整轉送六參數與結構化政策上下文", async () => {
    const raw = adapter();
    const decision: ModeDecision = {
      ...baseDecision,
      executionMode: "SINGLE_EXCLUSIVE",
      outcome: "CLOSE_ONLY",
      reasonCode: "M1_CLOSE_EXISTING_POSITION",
      reduceOnly: true,
      targetSide: "LONG",
    };
    const singleContext = {
      ...context,
      strategy: { ...context.strategy, executionMode: "SINGLE_EXCLUSIVE" as const },
    };
    const guarded = createRuntimeGuardedAdapter(raw, singleContext, authorizer(decision));
    const callerId = "clOrdId_V35_FULL_CLOSE_120011_1775031500000";

    const result = await guarded.closePositionSmart(
      "BTCUSDT",
      "long",
      3_000,
      0.02,
      callerId,
      {
        executionClass: "MAKER_ONLY",
        policyContext: { signalId: 88, reasonCode: "v35_trailing_take_profit" },
      },
    );

    expect(result.success).toBe(true);
    expect(raw.closePositionSmart).toHaveBeenCalledTimes(1);
    expect(raw.closePositionSmart).toHaveBeenCalledWith(
      "BTCUSDT",
      "long",
      3_000,
      0.02,
      callerId,
      expect.objectContaining({
        executionClass: "MAKER_ONLY",
        policyContext: expect.objectContaining({
          strategyId: 1,
          signalId: 88,
          source: "AUTO",
          reasonCode: "v35_trailing_take_profit",
        }),
      }),
    );
  });

  it("相同穩定 closeIntentId 跨監控輪詢 eventKey 變動仍下沉同一 intentKey", async () => {
    const raw = adapter();
    const decision: ModeDecision = {
      ...baseDecision,
      executionMode: "SINGLE_EXCLUSIVE",
      outcome: "CLOSE_ONLY",
      reasonCode: "M1_CLOSE_EXISTING_POSITION",
      reduceOnly: true,
      targetSide: "SHORT",
    };
    const firstContext = {
      ...context,
      strategy: { ...context.strategy, executionMode: "SINGLE_EXCLUSIVE" as const },
      eventKey: "risk-monitor:1:cycle-100",
    };
    const secondContext = {
      ...firstContext,
      eventKey: "risk-monitor:1:cycle-101",
    };
    const firstGuarded = createRuntimeGuardedAdapter(raw, firstContext, authorizer(decision));
    const secondGuarded = createRuntimeGuardedAdapter(raw, secondContext, authorizer(decision));
    const stableCloseIntentId = "close-intent-risk-strategy-1-short-position-a";

    await firstGuarded.closePositionSmart("BTCUSDT", "short", 3_000, 0.02, stableCloseIntentId, {
      policyContext: { reasonCode: "trailing_take_profit" },
    });
    await secondGuarded.closePositionSmart("BTCUSDT", "short", 3_000, 0.02, stableCloseIntentId, {
      policyContext: { reasonCode: "trailing_take_profit" },
    });

    const firstOptions = raw.closePositionSmart.mock.calls[0][5];
    const secondOptions = raw.closePositionSmart.mock.calls[1][5];
    expect(firstOptions?.policyContext?.intentKey).toBeTruthy();
    expect(secondOptions?.policyContext?.intentKey).toBe(firstOptions?.policyContext?.intentKey);
  });

  it("advanced reduce-only order 使用 decision 核准腿與數量，不採信超額 caller quantity", async () => {
    const raw = adapter();
    const decision: ModeDecision = {
      ...baseDecision,
      outcome: "CLOSE_ONLY",
      reasonCode: "LEG_SCOPED_CLOSE_REQUIRED",
      approvedQuantity: 0.2,
      reduceOnly: true,
      targetSide: "LONG",
      contextSnapshot: {
        closeLegs: [{ legId: "long-leg", side: "LONG", quantity: 0.2 }],
      },
    };
    const guarded = createRuntimeGuardedAdapter(raw, context, authorizer(decision));
    const result = await guarded.placeOrder({
      symbol: "BTCUSDT",
      side: "sell",
      orderType: "market",
      size: 5,
      posSide: "long",
      reduceOnly: true,
    });

    expect(result.success).toBe(true);
    expect(raw.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      size: 0.2,
      side: "sell",
      posSide: "long",
      reduceOnly: true,
    }));
  });

  it("advanced close scope/side 不符時 fail closed 且不觸達交易所", async () => {
    const raw = adapter();
    const decision: ModeDecision = {
      ...baseDecision,
      outcome: "CLOSE_ONLY",
      reasonCode: "LEG_SCOPED_CLOSE_REQUIRED",
      approvedQuantity: 0.2,
      reduceOnly: true,
      targetSide: "LONG",
      contextSnapshot: {
        closeLegs: [{ legId: "long-leg", side: "LONG", quantity: 0.2 }],
      },
    };
    const guarded = createRuntimeGuardedAdapter(raw, context, authorizer(decision));
    const result = await guarded.placeOrder({
      symbol: "BTCUSDT",
      side: "buy",
      orderType: "market",
      size: 0.2,
      posSide: "long",
      reduceOnly: true,
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("ADVANCED_CLOSE_SIDE_MISMATCH");
    expect(raw.placeOrder).not.toHaveBeenCalled();
  });
});
