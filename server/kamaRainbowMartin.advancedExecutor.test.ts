import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultExecutionPolicy } from "../shared/executionModes";
import { KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG } from "../shared/strategies/kamaRainbowMartin";
import { createKamaRainbowMartinRuntimeState } from "./strategies/kamaRainbowMartin/core";

const mocks = vi.hoisted(() => ({
  acquireBarLock: vi.fn(),
  releaseAllLocks: vi.fn(),
  resolveDeploymentPosition: vi.fn(),
  fetchFreshQuote: vi.fn(),
  authorizeRuntimeModeAction: vi.fn(),
  normalizeQtyForSymbol: vi.fn(),
  appendExecutionFill: vi.fn(),
  createOrderIntent: vi.fn(),
  createOrGetHedgeRelationship: vi.fn(),
  createOrGetPositionLeg: vi.fn(),
  getOwnedPositionLeg: vi.fn(),
  listActiveHedgeRelationshipsForLeg: vi.fn(),
  listActivePositionLegs: vi.fn(),
  transitionHedgeRelationship: vi.fn(),
  transitionOrderIntent: vi.fn(),
  transitionPositionLeg: vi.fn(),
  updatePositionLegRuntime: vi.fn(),
  tradeFillRecordFields: vi.fn(),
  createTrade: vi.fn(),
}));

vi.mock("./services/barLock", () => ({
  acquireBarLock: mocks.acquireBarLock,
  releaseAllLocks: mocks.releaseAllLocks,
}));

vi.mock("./services/deploymentPosition", () => ({
  resolveDeploymentPosition: mocks.resolveDeploymentPosition,
}));

vi.mock("./services/kamaRainbowMartinMarketData", () => ({
  fetchKamaRainbowMartinFreshQuote: mocks.fetchFreshQuote,
}));

vi.mock("./services/runtimeModeGuard", () => ({
  authorizeRuntimeModeAction: mocks.authorizeRuntimeModeAction,
  runtimeModeRejectionMessage: () => "runtime rejected",
}));

vi.mock("./services/symbolSpecs", () => ({
  normalizeQtyForSymbol: mocks.normalizeQtyForSymbol,
}));

vi.mock("./services/threeModeLedger", () => ({
  appendExecutionFill: mocks.appendExecutionFill,
  createOrderIntent: mocks.createOrderIntent,
  createOrGetHedgeRelationship: mocks.createOrGetHedgeRelationship,
  createOrGetPositionLeg: mocks.createOrGetPositionLeg,
  getOwnedPositionLeg: mocks.getOwnedPositionLeg,
  listActiveHedgeRelationshipsForLeg: mocks.listActiveHedgeRelationshipsForLeg,
  listActivePositionLegs: mocks.listActivePositionLegs,
  transitionHedgeRelationship: mocks.transitionHedgeRelationship,
  transitionOrderIntent: mocks.transitionOrderIntent,
  transitionPositionLeg: mocks.transitionPositionLeg,
  updatePositionLegRuntime: mocks.updatePositionLegRuntime,
}));

vi.mock("./services/tradeFillTruth", () => ({
  tradeFillRecordFields: mocks.tradeFillRecordFields,
}));

vi.mock("./services/tradeExecutionLedger", () => ({
  recordExistingTradeExecution: mocks.createTrade,
}));

import { executeKamaRainbowMartinAdvancedSignal } from "./services/kamaRainbowMartinAdvancedExecutor";

function strategy(mode: "MULTI_POSITION" | "HEDGE_GUARDED") {
  const policy = createDefaultExecutionPolicy(mode);
  return {
    id: 41,
    userId: 7,
    name: "Kama 彩虹馬丁測試",
    strategyKey: "KAMA_RAINBOW_MARTIN_V1",
    strategyVersion: 1,
    deploymentKey: "krm-deployment-41",
    apiKeyId: 12,
    exchange: "bybit",
    symbol: "BTCUSDT",
    direction: "both",
    leverage: 2,
    maxPositionPct: 0,
    executionMode: mode,
    executionPolicy: mode === "HEDGE_GUARDED"
      ? { ...policy, primaryLossTriggerPct: 4, hedgeRatio: 0.5, hedgeMartinEnabled: false }
      : policy,
  } as any;
}

function signal(action: "OPEN_LONG" | "OPEN_SHORT" | "ADD_LONG" | "ADD_SHORT" | "CLOSE", overrides: Record<string, unknown> = {}) {
  return {
    action: action === "OPEN_LONG" || action === "ADD_LONG" ? "buy" : action === "CLOSE" ? "close" : "sell",
    symbol: "BTCUSDT",
    price: 100,
    reason: "KRM advanced acceptance fixture",
    confidence: 1,
    kamaRainbowMartinDecision: true,
    kamaRainbowMartinAction: action,
    kamaRainbowMartinReasonCode: "KRM_TEST",
    kamaRainbowMartinEventKey: `event:${action}`,
    kamaRainbowMartinConfigRevision: KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG.version,
    ...overrides,
  } as any;
}

function adapter() {
  return {
    setLeverage: vi.fn().mockResolvedValue(undefined),
    placeOrder: vi.fn().mockResolvedValue({
      success: true,
      orderId: "order-1",
      tradeId: "trade-1",
      filledSize: 0.005,
      filledPrice: 100,
      filledAt: 1_900_000_000_000,
      rawResponse: { test: true },
    }),
    getOrderExecutionTruth: vi.fn(),
    getBalance: vi.fn(),
    getPositions: vi.fn(),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveDeploymentPosition.mockReturnValue({ mode: "quantity", value: 0.01 });
  mocks.fetchFreshQuote.mockResolvedValue({
    exchange: "bybit",
    symbol: "BTCUSDT",
    bid: 99.9,
    ask: 100,
    capturedAt: 1_900_000_000_000,
  });
  mocks.normalizeQtyForSymbol.mockImplementation(async (_exchange, _symbol, qty) => ({
    qty,
    rejected: false,
  }));
  mocks.createOrderIntent.mockResolvedValue({
    deduplicated: false,
    intent: { intentId: "intent-1", status: "CREATED" },
  });
  mocks.createOrGetPositionLeg.mockResolvedValue({ deduplicated: false, leg: { legId: "created-leg" } });
  mocks.createOrGetHedgeRelationship.mockResolvedValue({ deduplicated: false });
  mocks.listActiveHedgeRelationshipsForLeg.mockResolvedValue([]);
  mocks.listActivePositionLegs.mockResolvedValue([]);
  mocks.tradeFillRecordFields.mockReturnValue({
    filledSize: "0.00500000",
    filledPrice: "100.00000000",
  });
});

describe("KamaRainbowMartin advanced executor", () => {
  it("persists an H3 protection fill as an independent HEDGE leg linked to its PRIMARY leg", async () => {
    const exchange = adapter();
    mocks.getOwnedPositionLeg.mockResolvedValue(null);
    mocks.authorizeRuntimeModeAction.mockResolvedValue({
      allowed: true,
      envelope: {
        decision: {
          outcome: "EXECUTE",
          decisionId: "decision-h3-1",
          reasonCode: "HEDGE_TRIGGERED",
          targetLegId: "hedge-leg-1",
          targetRole: "HEDGE",
          targetSide: "SHORT",
          approvedQuantity: 0.005,
          contextSnapshot: { primaryLegId: "primary-leg-1", primaryLossPct: 4.2 },
        },
      },
    });

    const result = await executeKamaRainbowMartinAdvancedSignal({
      strategy: strategy("HEDGE_GUARDED"),
      signal: signal("OPEN_SHORT", {
        barTimestamp: 1_900_000_000_000,
        kamaRainbowMartinCycleId: "cycle-h3-1",
        kamaRainbowMartinRoleHint: "HEDGE",
      }),
      signalId: 91,
      adapter: exchange,
      options: { source: "AUTO", cycleId: "cycle-h3-1", eventKey: "event-h3-1" },
      config: KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
    });

    expect(result.status).toBe("executed");
    expect(mocks.authorizeRuntimeModeAction).toHaveBeenCalledWith(expect.objectContaining({
      cycleId: "cycle-h3-1",
      signal: expect.objectContaining({ roleHint: "HEDGE" }),
    }));
    expect(exchange.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      side: "sell",
      posSide: "short",
      size: 0.005,
      reduceOnly: false,
    }));
    expect(mocks.createOrGetPositionLeg).toHaveBeenCalledWith(expect.objectContaining({
      legId: "hedge-leg-1",
      cycleId: "cycle-h3-1",
      role: "HEDGE",
      side: "SHORT",
      executionMode: "HEDGE_GUARDED",
    }));
    expect(mocks.createOrGetHedgeRelationship).toHaveBeenCalledWith(expect.objectContaining({
      primaryLegId: "primary-leg-1",
      hedgeLegId: "hedge-leg-1",
      targetRatio: "0.500000",
      triggerSnapshot: expect.objectContaining({ hedgeMartinEnabled: false, triggerLossPct: 4 }),
    }));
    expect(mocks.createTrade).toHaveBeenCalledWith(expect.objectContaining({
      legId: "hedge-leg-1",
      executionMode: "HEDGE_GUARDED",
    }));
  });

  it("persists a sealed M2 open as a fresh layer-1 INDEPENDENT leg in the S1 cycle", async () => {
    const exchange = adapter();
    mocks.getOwnedPositionLeg.mockResolvedValue(null);
    mocks.authorizeRuntimeModeAction.mockResolvedValue({
      allowed: true,
      envelope: {
        decision: {
          outcome: "EXECUTE",
          decisionId: "decision-m2-open",
          reasonCode: "M2_INDEPENDENT_OPEN_APPROVED",
          targetLegId: "m2-short-1",
          targetRole: "INDEPENDENT",
          targetSide: "SHORT",
          approvedQuantity: 0.005,
          contextSnapshot: {},
        },
      },
    });

    const result = await executeKamaRainbowMartinAdvancedSignal({
      strategy: strategy("MULTI_POSITION"),
      signal: signal("OPEN_SHORT", {
        kamaRainbowMartinCycleId: "cycle-m2-1",
        kamaRainbowMartinRoleHint: "INDEPENDENT",
      }),
      signalId: 94,
      adapter: exchange,
      options: { source: "AUTO", cycleId: "cycle-m2-1", eventKey: "event-m2-open" },
      config: KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
    });

    expect(result.status).toBe("executed");
    expect(mocks.authorizeRuntimeModeAction).toHaveBeenCalledWith(expect.objectContaining({
      cycleId: "cycle-m2-1",
      signal: expect.objectContaining({ roleHint: "INDEPENDENT" }),
    }));
    expect(mocks.createOrGetPositionLeg).toHaveBeenCalledWith(expect.objectContaining({
      legId: "m2-short-1",
      cycleId: "cycle-m2-1",
      role: "INDEPENDENT",
      side: "SHORT",
      executionMode: "MULTI_POSITION",
      martinState: expect.objectContaining({ currentLayer: 1 }),
    }));
  });

  it("rejects conflicting sealed and options cycle identities before quote or mode authorization", async () => {
    const exchange = adapter();
    const result = await executeKamaRainbowMartinAdvancedSignal({
      strategy: strategy("MULTI_POSITION"),
      signal: signal("OPEN_SHORT", {
        kamaRainbowMartinCycleId: "cycle-sealed",
        kamaRainbowMartinRoleHint: "INDEPENDENT",
      }),
      signalId: 95,
      adapter: exchange,
      options: { source: "AUTO", cycleId: "cycle-options", eventKey: "event-cycle-conflict" },
      config: KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
    });

    expect(result).toMatchObject({ status: "rejected" });
    expect(result.message).toContain("sealed cycleId");
    expect(mocks.fetchFreshQuote).not.toHaveBeenCalled();
    expect(mocks.authorizeRuntimeModeAction).not.toHaveBeenCalled();
    expect(exchange.placeOrder).not.toHaveBeenCalled();
  });

  it("updates only the sealed M2 target leg when applying a martingale add", async () => {
    const exchange = adapter();
    const existingState = createKamaRainbowMartinRuntimeState({
      isLong: true,
      currentLayer: 1,
      totalSize: 0.01,
      avgPrice: 100,
      positionSizeAtOpen: { mode: "quantity", value: 0.01 },
    });
    mocks.getOwnedPositionLeg.mockResolvedValue({
      legId: "m2-long-1",
      cycleId: "cycle-m2-1",
      side: "LONG",
      role: "PRIMARY",
      quantity: "0.01000000",
      avgEntryPrice: "100.00000000",
      martinState: existingState,
    });
    mocks.authorizeRuntimeModeAction.mockResolvedValue({
      allowed: true,
      envelope: {
        decision: {
          outcome: "EXECUTE",
          decisionId: "decision-m2-add",
          reasonCode: "M2_ADD_APPROVED",
          targetLegId: "m2-long-1",
          targetRole: "PRIMARY",
          targetSide: "LONG",
          approvedQuantity: 0.005,
          contextSnapshot: {},
        },
      },
    });

    const result = await executeKamaRainbowMartinAdvancedSignal({
      strategy: strategy("MULTI_POSITION"),
      signal: signal("ADD_LONG", {
        kamaRainbowMartinLayerNum: 2,
        kamaRainbowMartinOrderSize: { mode: "quantity", value: 0.005 },
      }),
      signalId: 92,
      adapter: exchange,
      options: { source: "RISK", cycleId: "cycle-m2-1", legId: "m2-long-1", eventKey: "event-m2-add" },
      config: KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
    });

    expect(result.status).toBe("executed");
    expect(mocks.updatePositionLegRuntime).toHaveBeenCalledWith(
      "m2-long-1",
      expect.objectContaining({ quantity: "0.01500000", avgEntryPrice: "100.00000000" }),
    );
    expect(mocks.createOrGetPositionLeg).not.toHaveBeenCalled();
    expect(mocks.createTrade).toHaveBeenCalledWith(expect.objectContaining({
      cycleId: "cycle-m2-1",
      legId: "m2-long-1",
      executionMode: "MULTI_POSITION",
    }));
  });

  it("rejects martingale adds to an H3 protection leg before quote, authorization or order submission", async () => {
    const exchange = adapter();
    mocks.getOwnedPositionLeg.mockResolvedValue({
      legId: "hedge-leg-1",
      cycleId: "cycle-h3-1",
      side: "SHORT",
      role: "HEDGE",
      quantity: "0.00500000",
      avgEntryPrice: "100.00000000",
      martinState: createKamaRainbowMartinRuntimeState({
        isLong: false,
        currentLayer: 1,
        totalSize: 0.005,
        avgPrice: 100,
      }),
    });

    const result = await executeKamaRainbowMartinAdvancedSignal({
      strategy: strategy("HEDGE_GUARDED"),
      signal: signal("ADD_SHORT", {
        kamaRainbowMartinLayerNum: 2,
        kamaRainbowMartinOrderSize: { mode: "quantity", value: 0.01 },
      }),
      signalId: 93,
      adapter: exchange,
      options: { source: "RISK", cycleId: "cycle-h3-1", legId: "hedge-leg-1" },
      config: KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
    });

    expect(result.status).toBe("rejected");
    expect(result.message).toContain("保護腿禁止馬丁加倉");
    expect(mocks.fetchFreshQuote).not.toHaveBeenCalled();
    expect(mocks.authorizeRuntimeModeAction).not.toHaveBeenCalled();
    expect(exchange.placeOrder).not.toHaveBeenCalled();
  });
});
