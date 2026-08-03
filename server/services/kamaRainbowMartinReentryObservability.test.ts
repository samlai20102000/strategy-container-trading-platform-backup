import { describe, expect, it } from "vitest";
import type { PositionLeg } from "../../drizzle/schema";
import { createKamaRainbowMartinDefaultConfig } from "../../shared/strategies/kamaRainbowMartin";
import {
  createKamaRainbowMartinRuntimeState,
} from "../strategies/kamaRainbowMartin/core";
import {
  applyKamaRainbowMartinCloseToState,
  applyKamaRainbowMartinFillToState,
} from "../strategies/kamaRainbowMartin/management";
import {
  summarizeKamaRainbowMartinLedgerObservation,
  summarizeKamaRainbowMartinRuntimeObservation,
} from "./kamaRainbowMartinReentryObservability";

const config = createKamaRainbowMartinDefaultConfig();

function openCycle(
  state: ReturnType<typeof createKamaRainbowMartinRuntimeState>,
  action: "OPEN_LONG" | "OPEN_SHORT",
  fillId: string,
  timestamp: number,
) {
  return applyKamaRainbowMartinFillToState(state, {
    action,
    fillId,
    orderId: `order-${fillId}`,
    fillPrice: action === "OPEN_LONG" ? 100 : 99,
    fillQuantity: 1,
    timestamp,
    rawConfig: config,
    configRevision: config.version,
  });
}

function ledgerLeg(input: {
  id: number;
  cycleId: string;
  side: "LONG" | "SHORT";
  status: "OPEN" | "CLOSED";
  openedAt: number;
  closeReason?: string;
}): PositionLeg {
  return {
    id: input.id,
    legId: `leg-${input.id}`,
    userId: 7,
    strategyId: 42,
    deploymentKey: null,
    apiKeyId: 3,
    cycleId: input.cycleId,
    exchange: "okx",
    symbol: "BTC-USDT-SWAP",
    executionMode: "MULTI_POSITION",
    side: input.side,
    role: "PRIMARY",
    status: input.status,
    quantity: "1.00000000",
    avgEntryPrice: "100.00000000",
    realizedPnl: "0.00000000",
    unrealizedPnl: "0.00000000",
    martinState: {
      kamaRainbowMartinRuntime: {
        lastCloseReason: input.closeReason ?? null,
        fills: [{
          fillId: `fill-${input.id}`,
          orderId: `order-${input.id}`,
          layer: 1,
          side: input.side === "LONG" ? "long" : "short",
          price: 100,
          quantity: 1,
          timestamp: input.openedAt,
        }],
      },
    },
    riskState: null,
    openedAt: new Date(input.openedAt),
    closedAt: input.status === "CLOSED" ? new Date(input.openedAt + 500) : null,
    createdAt: new Date(input.openedAt),
    updatedAt: new Date(input.openedAt),
  };
}

describe("Kama 彩虹馬丁重入可觀測性", () => {
  it("只在確認 L1 成交後遞增 cycle，並區分同向與反向重入", () => {
    const initial = openCycle(createKamaRainbowMartinRuntimeState(), "OPEN_LONG", "initial", 1_000);
    expect(initial.kamaRainbowMartinRuntime).toMatchObject({
      cycleNumber: 1,
      sameDirectionEntrySequence: 1,
      lastEntrySide: "long",
      currentEntryKind: "initial",
      lastEntryEvent: {
        kind: "initial",
        cycleNumber: 1,
        sameDirectionEntrySequence: 1,
        previousCloseReason: null,
      },
    });

    const afterHardStop = applyKamaRainbowMartinCloseToState(initial, "HARD_STOP", 2_000);
    const sameDirection = openCycle(afterHardStop, "OPEN_LONG", "same", 3_000);
    expect(sameDirection.kamaRainbowMartinRuntime).toMatchObject({
      cycleNumber: 2,
      sameDirectionEntrySequence: 2,
      lastEntrySide: "long",
      currentEntryKind: "same_direction_reentry",
      lastEntryEvent: {
        kind: "same_direction_reentry",
        cycleNumber: 2,
        sameDirectionEntrySequence: 2,
        previousCloseReason: "HARD_STOP",
      },
    });

    const afterTrailing = applyKamaRainbowMartinCloseToState(sameDirection, "TRAILING_TAKE_PROFIT", 4_000);
    const reverseDirection = openCycle(afterTrailing, "OPEN_SHORT", "reverse", 5_000);
    expect(reverseDirection.kamaRainbowMartinRuntime).toMatchObject({
      cycleNumber: 3,
      sameDirectionEntrySequence: 1,
      lastEntrySide: "short",
      currentEntryKind: "reverse_direction_reentry",
      lastEntryEvent: {
        kind: "reverse_direction_reentry",
        cycleNumber: 3,
        sameDirectionEntrySequence: 1,
        previousCloseReason: "TRAILING_TAKE_PROFIT",
      },
    });
  });

  it("從 S1 runtime 輸出成交證據而非候選訊號推測", () => {
    const state = openCycle(createKamaRainbowMartinRuntimeState(), "OPEN_LONG", "s1", 10_000);
    const summary = summarizeKamaRainbowMartinRuntimeObservation({
      id: 42,
      martinState: state,
      reentryEnabled: true,
    });
    expect(summary).toMatchObject({
      strategyId: 42,
      enabled: true,
      state: "position_open",
      cycleNumber: 1,
      sameDirectionEntrySequence: 1,
      source: "s1_runtime",
      lastEntryEvent: { kind: "initial", fillId: "s1" },
    });
  });

  it("從 M2/H3 歷史 position ledger 彙整 cycle 與同方向序號", () => {
    const summary = summarizeKamaRainbowMartinLedgerObservation(
      { id: 42, martinState: {}, reentryEnabled: true },
      [
        ledgerLeg({ id: 1, cycleId: "cycle-a", side: "LONG", status: "CLOSED", openedAt: 1_000, closeReason: "HARD_STOP" }),
        ledgerLeg({ id: 2, cycleId: "cycle-b", side: "LONG", status: "CLOSED", openedAt: 2_000, closeReason: "TRAILING_TAKE_PROFIT" }),
        ledgerLeg({ id: 3, cycleId: "cycle-c", side: "SHORT", status: "OPEN", openedAt: 3_000 }),
      ],
    );
    expect(summary).toMatchObject({
      state: "position_open",
      cycleNumber: 3,
      sameDirectionEntrySequence: 1,
      lastEntrySide: "short",
      source: "position_ledger",
      lastEntryEvent: {
        kind: "reverse_direction_reentry",
        cycleNumber: 3,
        sameDirectionEntrySequence: 1,
        previousCloseReason: "TRAILING_TAKE_PROFIT",
      },
    });
  });
});
