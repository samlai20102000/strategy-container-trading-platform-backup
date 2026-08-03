import { describe, expect, it } from "vitest";

import {
  createBacktestReentryTracker,
  recordBacktestCycleClose,
  recordBacktestCycleEntry,
  snapshotBacktestReentryDiagnostics,
} from "./backtestReentryDiagnostics";

describe("backtest reentry diagnostics", () => {
  it("separates cycles from Martin adds and preserves same-direction reentry order", () => {
    const tracker = createBacktestReentryTracker("KAMA_RAINBOW_MARTIN_V1", true);
    const first = recordBacktestCycleEntry(tracker, {
      timestamp: 1_000,
      side: "long",
      price: 100,
      reasonCode: "KRM_ENTRY_LONG",
      reason: "初次多單",
    });
    recordBacktestCycleClose(tracker, {
      cycle: first,
      timestamp: 2_000,
      price: 105,
      reasonCode: "KRM_TRAILING_EXIT",
      reason: "追蹤止盈",
      closeReason: "TRAILING_TAKE_PROFIT",
    });
    const second = recordBacktestCycleEntry(tracker, {
      timestamp: 2_000,
      side: "long",
      price: 105,
      reasonCode: "KRM_ENTRY_LONG",
      reason: "同 K 棒順勢重入",
    });
    recordBacktestCycleClose(tracker, {
      cycle: second,
      timestamp: 3_000,
      price: 99,
      reasonCode: "KRM_HARD_STOP",
      reason: "極限止損",
      closeReason: "HARD_STOP",
    });
    const third = recordBacktestCycleEntry(tracker, {
      timestamp: 4_000,
      side: "short",
      price: 98,
      reasonCode: "KRM_ENTRY_SHORT",
      reason: "下一根反向重入",
    });

    expect(first).toMatchObject({ cycleNumber: 1, sameDirectionSequence: 1, isReentry: false });
    expect(second).toMatchObject({
      cycleNumber: 2,
      sameDirectionSequence: 2,
      isReentry: true,
      sameDirectionAsPrevious: true,
      trigger: "SAME_BAR_REENTRY",
    });
    expect(third).toMatchObject({
      cycleNumber: 3,
      sameDirectionSequence: 1,
      isReentry: true,
      sameDirectionAsPrevious: false,
      trigger: "LATER_BAR_REENTRY",
    });
    expect(snapshotBacktestReentryDiagnostics(tracker)).toMatchObject({
      enabled: true,
      cycleCount: 3,
      reentryCount: 2,
      sameDirectionReentryCount: 1,
      oppositeDirectionReentryCount: 1,
      currentCycleId: third.cycleId,
      currentSide: "short",
      currentSameDirectionSequence: 1,
      totalEvidenceEventCount: 5,
      evidenceTruncated: false,
    });
  });

  it("caps evidence without changing authoritative counters", () => {
    const tracker = createBacktestReentryTracker("KRM", false, 2);
    const first = recordBacktestCycleEntry(tracker, {
      timestamp: 10,
      side: "long",
      price: 1,
      reasonCode: "OPEN",
      reason: "open",
    });
    recordBacktestCycleClose(tracker, {
      cycle: first,
      timestamp: 20,
      price: 2,
      reasonCode: "CLOSE",
      reason: "close",
      closeReason: "OTHER",
    });
    recordBacktestCycleEntry(tracker, {
      timestamp: 30,
      side: "long",
      price: 3,
      reasonCode: "OPEN",
      reason: "reopen",
    });

    const diagnostics = snapshotBacktestReentryDiagnostics(tracker);
    expect(diagnostics).toMatchObject({
      enabled: false,
      cycleCount: 2,
      reentryCount: 1,
      totalEvidenceEventCount: 3,
      evidenceEventLimit: 2,
      evidenceTruncated: true,
    });
    expect(diagnostics.events).toHaveLength(2);
  });
});
