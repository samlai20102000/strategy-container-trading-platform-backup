import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PositionCycle,
  PositionLayerCloseAllocation,
  PositionLayerEvent,
  Strategy,
} from "../../drizzle/schema";
import type { Position } from "../exchanges/types";
import type { AccountPositionResult } from "./strategyPositionSnapshot";

const { capabilityMock } = vi.hoisted(() => ({
  capabilityMock: vi.fn(),
}));

vi.mock("./martingaleCapability", () => ({
  evaluateMartingaleStrategyInstance: capabilityMock,
}));

import { buildMartingaleLayerSnapshots } from "./martingaleLayerSnapshot";
import {
  MARTINGALE_POSITION_HIDE_PNL_MS,
  MARTINGALE_POSITION_STALE_MS,
} from "./strategyPositionSnapshot";

const NOW = 1_000_000;

function strategy(id: number, overrides: Partial<Strategy> = {}): Strategy {
  return {
    id,
    userId: 1,
    apiKeyId: 7,
    exchange: "okx",
    symbol: "BTC-USDT-SWAP",
    strategyKey: "MARTIN",
    ...overrides,
  } as Strategy;
}

function cycle(
  strategyId: number,
  id: string,
  overrides: Partial<PositionCycle> = {},
): PositionCycle {
  return {
    id: strategyId,
    cycleId: id,
    userId: 1,
    strategyId,
    apiKeyId: 7,
    exchange: "okx",
    symbol: "BTC-USDT-SWAP",
    side: "long",
    status: "open",
    dataQuality: "live_exact",
    openedAt: new Date(NOW - 60_000),
    ...overrides,
  } as PositionCycle;
}

function event(
  id: number,
  cycleId: string,
  layerIndex: number,
  quantity: number,
  entryPrice: number,
  overrides: Partial<PositionLayerEvent> = {},
): PositionLayerEvent {
  return {
    id,
    userId: 1,
    strategyId: 1,
    apiKeyId: 7,
    cycleId,
    layerIndex,
    executionId: `exec-${id}`,
    layerIntentId: `exec-${id}`,
    side: "buy",
    quantity: String(quantity),
    entryPrice: String(entryPrice),
    source: "live_execution",
    dataQuality: "live_exact",
    filledAt: new Date(NOW - 50_000 + id),
    ...overrides,
  } as PositionLayerEvent;
}

function allocation(
  id: number,
  layerEventId: number,
  quantity: number,
  overrides: Partial<PositionLayerCloseAllocation> = {},
): PositionLayerCloseAllocation {
  return {
    id,
    allocationKey: `allocation-${id}`,
    userId: 1,
    strategyId: 1,
    cycleId: "cycle-1",
    layerEventId,
    layerIndex: layerEventId,
    closeExecutionId: `close-${id}`,
    allocatedQuantity: String(quantity),
    allocationPolicy: "fifo",
    dataQuality: "live_exact",
    allocatedAt: new Date(NOW - 10_000),
    ...overrides,
  } as PositionLayerCloseAllocation;
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: "BTC-USDT-SWAP",
    side: "long",
    size: 2.5,
    entryPrice: 108,
    markPrice: 120,
    unrealizedPnl: 30,
    leverage: 10,
    updatedAt: NOW,
    ...overrides,
  } as Position;
}

function accounts(
  positions: Position[],
  capturedAt = NOW - 1_000,
  overrides: Partial<AccountPositionResult> = {},
): ReadonlyMap<number, AccountPositionResult> {
  return new Map([[7, {
    contractVersion: "exchange-position-v2",
    positions,
    capturedAt,
    ...overrides,
  } as AccountPositionResult]]);
}

describe("martingaleLayerSnapshot", () => {
  beforeEach(() => {
    capabilityMock.mockReset();
    capabilityMock.mockImplementation((row: Strategy) => ({
      isMartingale: row.strategyKey === "MARTIN",
      supportsMartingale: row.strategyKey === "MARTIN",
      enabled: row.strategyKey === "MARTIN",
      maxLayers: row.strategyKey === "MARTIN" ? 7 : 0,
      reason: row.strategyKey === "MARTIN" ? "enabled" : "capability_not_declared",
    }));
  });

  it("long 部分平倉後以每層剩餘數量計算毛浮盈虧", () => {
    const [snapshot] = buildMartingaleLayerSnapshots({
      strategies: [strategy(1)],
      cycles: [cycle(1, "cycle-1")],
      events: [
        event(1, "cycle-1", 1, 1, 100),
        event(2, "cycle-1", 2, 2, 110),
      ],
      allocations: [allocation(1, 1, 0.5)],
      accounts: accounts([position()]),
      now: NOW,
    });

    expect(snapshot).toMatchObject({
      strategyId: 1,
      openLayerCount: 2,
      quality: "exact",
      pnlHidden: false,
    });
    expect(snapshot.cycles[0].totalOpenQuantity).toBe(2.5);
    expect(snapshot.cycles[0].totalGrossUnrealizedPnl).toBe(30);
    expect(snapshot.cycles[0].layers.map(layer => ({
      layer: layer.layerIndex,
      remaining: layer.remainingQuantity,
      pnl: layer.grossUnrealizedPnl,
    }))).toEqual([
      { layer: 1, remaining: 0.5, pnl: 10 },
      { layer: 2, remaining: 2, pnl: 20 },
    ]);
  });

  it("short 使用相反價格方向計算逐層毛浮盈虧", () => {
    const [snapshot] = buildMartingaleLayerSnapshots({
      strategies: [strategy(1)],
      cycles: [cycle(1, "short-cycle", { side: "short" })],
      events: [event(1, "short-cycle", 1, 1, 100, { side: "sell" })],
      allocations: [],
      accounts: accounts([position({ side: "short", size: 1, markPrice: 80 })]),
      now: NOW,
    });

    expect(snapshot.quality).toBe("exact");
    expect(snapshot.cycles[0].layers[0].grossUnrealizedPnl).toBe(20);
  });

  it("逐層數量與交易所持倉差逾 1% 時標記 mismatch 並隱藏 PnL", () => {
    const [snapshot] = buildMartingaleLayerSnapshots({
      strategies: [strategy(1)],
      cycles: [cycle(1, "cycle-1")],
      events: [event(1, "cycle-1", 1, 1, 100)],
      allocations: [],
      accounts: accounts([position({ size: 9, markPrice: 120 })]),
      now: NOW,
    });

    expect(snapshot).toMatchObject({ quality: "mismatch", pnlHidden: true });
    expect(snapshot.cycles[0].layers[0].grossUnrealizedPnl).toBeNull();
  });

  it("超過 120 秒標記 stale 但五分鐘內仍保留可識別的毛 PnL", () => {
    const [snapshot] = buildMartingaleLayerSnapshots({
      strategies: [strategy(1)],
      cycles: [cycle(1, "cycle-1")],
      events: [event(1, "cycle-1", 1, 1, 100)],
      allocations: [],
      accounts: accounts([position({ size: 1 })], NOW - MARTINGALE_POSITION_STALE_MS - 1),
      now: NOW,
    });

    expect(snapshot).toMatchObject({ quality: "stale", stale: true, pnlHidden: false });
    expect(snapshot.cycles[0].layers[0].grossUnrealizedPnl).toBe(20);
  });

  it("超過五分鐘停止顯示偽精確 PnL", () => {
    const [snapshot] = buildMartingaleLayerSnapshots({
      strategies: [strategy(1)],
      cycles: [cycle(1, "cycle-1")],
      events: [event(1, "cycle-1", 1, 1, 100)],
      allocations: [],
      accounts: accounts([position({ size: 1 })], NOW - MARTINGALE_POSITION_HIDE_PNL_MS - 1),
      now: NOW,
    });

    expect(snapshot).toMatchObject({ quality: "stale", stale: true, pnlHidden: true });
    expect(snapshot.cycles[0].layers[0].grossUnrealizedPnl).toBeNull();
  });

  it("多個馬丁策略共享同帳戶、交易對及方向時只按 ledger 分配毛 PnL", () => {
    const snapshots = buildMartingaleLayerSnapshots({
      strategies: [strategy(1), strategy(2)],
      cycles: [cycle(1, "cycle-1"), cycle(2, "cycle-2", { id: 2 })],
      events: [
        event(1, "cycle-1", 1, 1, 100),
        event(2, "cycle-2", 1, 2, 110, { strategyId: 2 }),
      ],
      allocations: [],
      accounts: accounts([position({ size: 3 })]),
      now: NOW,
    });

    expect(snapshots.map(item => item.quality)).toEqual(["account_aggregate", "account_aggregate"]);
    expect(snapshots.map(item => item.cycles[0].totalGrossUnrealizedPnl)).toEqual([20, 20]);
  });

  it("非馬丁策略完全不出現在逐層結果", () => {
    expect(buildMartingaleLayerSnapshots({
      strategies: [strategy(1, { strategyKey: "PLAIN" })],
      cycles: [cycle(1, "cycle-1")],
      events: [event(1, "cycle-1", 1, 1, 100)],
      allocations: [],
      accounts: accounts([position({ size: 1 })]),
      now: NOW,
    })).toEqual([]);
  });
});
