import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultExecutionPolicy } from "../shared/executionModes";
import { KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG } from "../shared/strategies/kamaRainbowMartin";
import { createKamaRainbowMartinRuntimeState } from "./strategies/kamaRainbowMartin/core";

const mocks = vi.hoisted(() => ({
  fetchClosedCandles: vi.fn(),
  fetchFreshQuote: vi.fn(),
  listActivePositionLegs: vi.fn(),
  updatePositionLegRuntime: vi.fn(),
  saveStrategyState: vi.fn(),
}));

vi.mock("./services/kamaRainbowMartinMarketData", () => ({
  fetchKamaRainbowMartinClosedCandles: mocks.fetchClosedCandles,
  fetchKamaRainbowMartinFreshQuote: mocks.fetchFreshQuote,
}));

vi.mock("./services/threeModeLedger", () => ({
  listActivePositionLegs: mocks.listActivePositionLegs,
  updatePositionLegRuntime: mocks.updatePositionLegRuntime,
}));

vi.mock("./services/strategyStateManager", () => ({
  saveStrategyState: mocks.saveStrategyState,
}));

import { generateKamaRainbowMartinAdvancedSignal } from "./services/kamaRainbowMartinAdvancedSignal";

function strategy() {
  const policy = createDefaultExecutionPolicy("HEDGE_GUARDED");
  return {
    id: 52,
    userId: 8,
    strategyKey: "KAMA_RAINBOW_MARTIN_V1",
    exchange: "bybit",
    symbol: "BTCUSDT",
    direction: "both",
    executionMode: "HEDGE_GUARDED",
    executionPolicy: {
      ...policy,
      primaryLossTriggerPct: 4,
      hedgeRatio: 0.5,
      hedgeMartinEnabled: false,
    },
  } as any;
}

function leg(input: {
  legId: string;
  side: "LONG" | "SHORT";
  role: "PRIMARY" | "HEDGE";
  avgEntryPrice?: number;
  quantity?: number;
}) {
  const quantity = input.quantity ?? 0.01;
  const avgPrice = input.avgEntryPrice ?? 100;
  return {
    legId: input.legId,
    cycleId: "cycle-h3-signal",
    side: input.side,
    role: input.role,
    status: "OPEN",
    quantity: quantity.toFixed(8),
    avgEntryPrice: avgPrice.toFixed(8),
    martinState: createKamaRainbowMartinRuntimeState({
      isLong: input.side === "LONG",
      currentLayer: 1,
      totalSize: quantity,
      avgPrice,
    }),
  } as any;
}

function input() {
  return {
    strategy: strategy(),
    config: KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
    globalState: createKamaRainbowMartinRuntimeState(),
    mode: "HEDGE_GUARDED" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updatePositionLegRuntime.mockResolvedValue(undefined);
  mocks.saveStrategyState.mockResolvedValue(undefined);
  mocks.fetchFreshQuote.mockResolvedValue({
    exchange: "bybit",
    symbol: "BTCUSDT",
    bid: 96,
    ask: 96.1,
    capturedAt: 1_900_000_000_000,
  });
});

describe("KamaRainbowMartin advanced signal", () => {
  it("emits a direct opposite H3 protection candidate when the primary loss reaches 4%", async () => {
    mocks.listActivePositionLegs.mockResolvedValue([
      leg({ legId: "primary-long", side: "LONG", role: "PRIMARY" }),
    ]);

    const result = await generateKamaRainbowMartinAdvancedSignal(input());

    expect(result.signal).toEqual(expect.objectContaining({
      action: "sell",
      kamaRainbowMartinAction: "OPEN_SHORT",
      kamaRainbowMartinReasonCode: "KRM_H3_PROTECTION_TRIGGER",
      kamaRainbowMartinExecutionMode: "HEDGE_GUARDED",
      kamaRainbowMartinCycleId: "cycle-h3-signal",
    }));
    expect(result.signal?.kamaRainbowMartinLegId).toBeUndefined();
    expect(mocks.fetchClosedCandles).not.toHaveBeenCalled();
    expect(mocks.saveStrategyState).not.toHaveBeenCalled();
  });

  it("unwinds the H3 hedge before a primary hard-stop instead of opening another hedge", async () => {
    mocks.fetchFreshQuote.mockResolvedValue({
      exchange: "bybit",
      symbol: "BTCUSDT",
      bid: 94,
      ask: 94.1,
      capturedAt: 1_900_000_000_100,
    });
    mocks.listActivePositionLegs.mockResolvedValue([
      leg({ legId: "primary-long", side: "LONG", role: "PRIMARY" }),
      leg({ legId: "hedge-short", side: "SHORT", role: "HEDGE", avgEntryPrice: 96, quantity: 0.005 }),
    ]);

    const result = await generateKamaRainbowMartinAdvancedSignal(input());

    expect(result.signal).toEqual(expect.objectContaining({
      action: "close",
      kamaRainbowMartinAction: "CLOSE",
      kamaRainbowMartinReasonCode: "KRM_H3_UNWIND_HEDGE_FIRST",
      kamaRainbowMartinExecutionMode: "HEDGE_GUARDED",
      kamaRainbowMartinLegId: "hedge-short",
    }));
    expect(mocks.fetchClosedCandles).not.toHaveBeenCalled();
  });

  it("fails closed on an orphan hedge without reading market data or mutating leg state", async () => {
    mocks.listActivePositionLegs.mockResolvedValue([
      leg({ legId: "orphan-hedge", side: "SHORT", role: "HEDGE", quantity: 0.005 }),
    ]);

    const result = await generateKamaRainbowMartinAdvancedSignal(input());

    expect(result.signal).toBeNull();
    expect(result.holdReason?.detail).toContain("orphan hedge");
    expect(mocks.fetchFreshQuote).not.toHaveBeenCalled();
    expect(mocks.fetchClosedCandles).not.toHaveBeenCalled();
    expect(mocks.updatePositionLegRuntime).not.toHaveBeenCalled();
  });
});
