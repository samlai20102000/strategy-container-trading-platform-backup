import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultExecutionPolicy } from "../shared/executionModes";
import { KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG } from "../shared/strategies/kamaRainbowMartin";
import { createKamaRainbowMartinRuntimeState } from "./strategies/kamaRainbowMartin/core";

const mocks = vi.hoisted(() => ({
  fetchClosedCandles: vi.fn(),
  fetchFreshQuote: vi.fn(),
  listActivePositionLegs: vi.fn(),
  hasPositionLegRoleInCycle: vi.fn(),
  updatePositionLegRuntime: vi.fn(),
  saveStrategyState: vi.fn(),
}));

vi.mock("./services/kamaRainbowMartinMarketData", () => ({
  fetchKamaRainbowMartinClosedCandles: mocks.fetchClosedCandles,
  fetchKamaRainbowMartinFreshQuote: mocks.fetchFreshQuote,
}));

vi.mock("./services/threeModeLedger", () => ({
  listActivePositionLegs: mocks.listActivePositionLegs,
  hasPositionLegRoleInCycle: mocks.hasPositionLegRoleInCycle,
  updatePositionLegRuntime: mocks.updatePositionLegRuntime,
}));

vi.mock("./services/strategyStateManager", () => ({
  saveStrategyState: mocks.saveStrategyState,
}));

import { generateKamaRainbowMartinAdvancedSignal } from "./services/kamaRainbowMartinAdvancedSignal";

function strategy(mode: "MULTI_POSITION" | "HEDGE_GUARDED" = "HEDGE_GUARDED") {
  const policy = createDefaultExecutionPolicy(mode);
  return {
    id: 52,
    userId: 8,
    strategyKey: "KAMA_RAINBOW_MARTIN_V1",
    exchange: "bybit",
    symbol: "BTCUSDT",
    direction: "both",
    executionMode: mode,
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
  role: "PRIMARY" | "INDEPENDENT" | "HEDGE";
  cycleId?: string;
  status?: "OPEN" | "CLOSING" | "CLOSED" | "BLOCKED";
  avgEntryPrice?: number;
  quantity?: number;
  openedAt?: Date;
}) {
  const quantity = input.quantity ?? 0.01;
  const avgPrice = input.avgEntryPrice ?? 100;
  return {
    legId: input.legId,
    cycleId: input.cycleId ?? "cycle-h3-signal",
    side: input.side,
    role: input.role,
    status: input.status ?? "OPEN",
    quantity: quantity.toFixed(8),
    avgEntryPrice: avgPrice.toFixed(8),
    openedAt: input.openedAt ?? new Date(1_899_999_000_000),
    martinState: createKamaRainbowMartinRuntimeState({
      isLong: input.side === "LONG",
      currentLayer: 1,
      totalSize: quantity,
      avgPrice,
    }),
  } as any;
}

function input(mode: "MULTI_POSITION" | "HEDGE_GUARDED" = "HEDGE_GUARDED") {
  return {
    strategy: strategy(mode),
    config: KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
    globalState: createKamaRainbowMartinRuntimeState(),
    mode,
  };
}

function downtrendCandles(count = 40) {
  return Array.from({ length: count }, (_, index) => {
    const close = 200 - index;
    return {
      timestamp: 1_700_000_000_000 + index * 1_800_000,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updatePositionLegRuntime.mockResolvedValue(undefined);
  mocks.saveStrategyState.mockResolvedValue(undefined);
  mocks.hasPositionLegRoleInCycle.mockResolvedValue(false);
  mocks.fetchFreshQuote.mockResolvedValue({
    exchange: "bybit",
    symbol: "BTCUSDT",
    bid: 96,
    ask: 96.1,
    capturedAt: 1_900_000_000_000,
  });
  mocks.fetchClosedCandles.mockResolvedValue({ candles: [], lastClosedBarIdentity: null });
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
      kamaRainbowMartinRoleHint: "HEDGE",
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

  it("closes an H3 hedge on primary recovery only after the canonical minimum hold", async () => {
    const advancedInput = input();
    advancedInput.strategy.executionPolicy = {
      ...advancedInput.strategy.executionPolicy,
      unwindPolicy: "CLOSE_HEDGE_ON_RECOVERY",
      minimumHedgeHoldSeconds: 60,
    };
    mocks.fetchFreshQuote.mockResolvedValue({
      exchange: "bybit",
      symbol: "BTCUSDT",
      bid: 99,
      ask: 99.1,
      capturedAt: 1_900_000_000_000,
    });
    mocks.listActivePositionLegs.mockResolvedValue([
      leg({ legId: "primary-long", side: "LONG", role: "PRIMARY" }),
      leg({
        legId: "hedge-short",
        side: "SHORT",
        role: "HEDGE",
        avgEntryPrice: 96,
        quantity: 0.005,
        openedAt: new Date(1_899_999_900_000),
      }),
    ]);

    const result = await generateKamaRainbowMartinAdvancedSignal(advancedInput);

    expect(result.signal).toEqual(expect.objectContaining({
      action: "close",
      kamaRainbowMartinAction: "CLOSE",
      kamaRainbowMartinReasonCode: "KRM_H3_RECOVERY_UNWIND",
      kamaRainbowMartinLegId: "hedge-short",
    }));
    expect(mocks.fetchClosedCandles).not.toHaveBeenCalled();
  });

  it("does not unwind a recovering H3 hedge before the canonical minimum hold", async () => {
    const advancedInput = input();
    advancedInput.strategy.executionPolicy = {
      ...advancedInput.strategy.executionPolicy,
      unwindPolicy: "CLOSE_HEDGE_ON_RECOVERY",
      minimumHedgeHoldSeconds: 60,
    };
    mocks.fetchFreshQuote.mockResolvedValue({
      exchange: "bybit",
      symbol: "BTCUSDT",
      bid: 99,
      ask: 99.1,
      capturedAt: 1_900_000_000_000,
    });
    mocks.listActivePositionLegs.mockResolvedValue([
      leg({ legId: "primary-long", side: "LONG", role: "PRIMARY" }),
      leg({
        legId: "hedge-short",
        side: "SHORT",
        role: "HEDGE",
        avgEntryPrice: 96,
        quantity: 0.005,
        openedAt: new Date(1_899_999_970_000),
      }),
    ]);

    const result = await generateKamaRainbowMartinAdvancedSignal(advancedInput);

    expect(result.signal).toBeNull();
    expect(result.holdReason?.type).toBe("no_data");
    expect(mocks.fetchClosedCandles).toHaveBeenCalledTimes(1);
  });

  it("M2 seals one opposite INDEPENDENT leg only while S1 is losing and never reopens it in the same cycle", async () => {
    const primary = leg({
      legId: "primary-m2",
      cycleId: "cycle-m2-once",
      side: "LONG",
      role: "PRIMARY",
      avgEntryPrice: 100,
    });
    const candles = downtrendCandles();
    mocks.fetchFreshQuote.mockResolvedValue({
      exchange: "bybit",
      symbol: "BTCUSDT",
      bid: 99.8,
      ask: 99.9,
      capturedAt: 1_900_000_000_000,
    });
    mocks.fetchClosedCandles.mockResolvedValue({
      candles,
      lastClosedBarIdentity: "bybit:BTCUSDT:M30:1700070200000",
    });
    mocks.listActivePositionLegs.mockResolvedValue([primary]);
    mocks.hasPositionLegRoleInCycle.mockResolvedValue(false);

    const first = await generateKamaRainbowMartinAdvancedSignal(input("MULTI_POSITION"));

    expect(first.signal).toEqual(expect.objectContaining({
      action: "sell",
      kamaRainbowMartinAction: "OPEN_SHORT",
      kamaRainbowMartinReasonCode: "KRM_ALL_DOWN",
      kamaRainbowMartinExecutionMode: "MULTI_POSITION",
      kamaRainbowMartinCycleId: "cycle-m2-once",
      kamaRainbowMartinRoleHint: "INDEPENDENT",
    }));
    expect(mocks.hasPositionLegRoleInCycle).toHaveBeenCalledWith({
      userId: 8,
      strategyId: 52,
      cycleId: "cycle-m2-once",
      role: "INDEPENDENT",
    });

    const closedM2 = leg({
      legId: "independent-m2-closed",
      cycleId: "cycle-m2-once",
      side: "SHORT",
      role: "INDEPENDENT",
      status: "CLOSED",
      avgEntryPrice: 99.8,
    });
    mocks.hasPositionLegRoleInCycle.mockResolvedValue(true);
    const repeated = await generateKamaRainbowMartinAdvancedSignal(input("MULTI_POSITION"));

    expect(repeated.signal).toBeNull();
    expect(repeated.holdReason?.detail).toContain("本 S1 cycle 已使用過 M2 資格");
  });
});
