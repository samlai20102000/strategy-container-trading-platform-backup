import type {
  BacktestReentryDiagnostics,
  BacktestReentryEvidenceEvent,
  BacktestReentryTrigger,
} from "./backtestContracts";

export const BACKTEST_REENTRY_EVIDENCE_LIMIT = 2_000;

export interface BacktestReentryCycleDescriptor {
  cycleId: string;
  cycleNumber: number;
  side: "long" | "short";
  sameDirectionSequence: number;
  isReentry: boolean;
  sameDirectionAsPrevious: boolean | null;
  trigger: BacktestReentryTrigger;
  entryReasonCode: string;
  entryReason: string;
}

export interface BacktestReentryTracker {
  diagnostics: BacktestReentryDiagnostics;
  lastCloseTimestamp: number | null;
  lastCloseReason: string | null;
}

function appendEvidence(
  tracker: BacktestReentryTracker,
  event: Omit<BacktestReentryEvidenceEvent, "eventId">,
): void {
  const diagnostics = tracker.diagnostics;
  diagnostics.totalEvidenceEventCount += 1;
  const eventWithId: BacktestReentryEvidenceEvent = {
    ...event,
    eventId: `${diagnostics.strategyKey}:${event.eventType.toLowerCase()}:${event.cycleNumber}:${event.timestamp}:${diagnostics.totalEvidenceEventCount}`,
  };
  if (diagnostics.events.length >= diagnostics.evidenceEventLimit) {
    diagnostics.events.shift();
    diagnostics.evidenceTruncated = true;
  }
  diagnostics.events.push(eventWithId);
}

export function createBacktestReentryTracker(
  strategyKey: string,
  enabled: boolean,
  evidenceEventLimit = BACKTEST_REENTRY_EVIDENCE_LIMIT,
): BacktestReentryTracker {
  return {
    diagnostics: {
      version: "backtest-reentry-diagnostics-v1",
      strategyKey,
      enabled,
      cycleCount: 0,
      reentryCount: 0,
      sameDirectionReentryCount: 0,
      oppositeDirectionReentryCount: 0,
      currentCycleId: null,
      currentSide: null,
      currentSameDirectionSequence: null,
      lastEntrySide: null,
      lastSameDirectionSequence: null,
      totalEvidenceEventCount: 0,
      evidenceEventLimit: Math.max(1, Math.trunc(evidenceEventLimit)),
      evidenceTruncated: false,
      events: [],
    },
    lastCloseTimestamp: null,
    lastCloseReason: null,
  };
}

export function recordBacktestCycleEntry(
  tracker: BacktestReentryTracker,
  input: {
    timestamp: number;
    side: "long" | "short";
    price: number;
    reasonCode: string;
    reason: string;
  },
): BacktestReentryCycleDescriptor {
  const diagnostics = tracker.diagnostics;
  const previousSide = diagnostics.lastEntrySide;
  const isReentry = diagnostics.cycleCount > 0;
  const sameDirectionAsPrevious = isReentry ? previousSide === input.side : null;
  const sameDirectionSequence = sameDirectionAsPrevious
    ? (diagnostics.lastSameDirectionSequence ?? 1) + 1
    : 1;
  const cycleNumber = diagnostics.cycleCount + 1;
  const cycleId = `cycle:${diagnostics.strategyKey}:${cycleNumber}`;
  const trigger: BacktestReentryTrigger = !isReentry
    ? "INITIAL_ENTRY"
    : tracker.lastCloseTimestamp === input.timestamp
      ? "SAME_BAR_REENTRY"
      : "LATER_BAR_REENTRY";

  diagnostics.cycleCount = cycleNumber;
  if (isReentry) {
    diagnostics.reentryCount += 1;
    if (sameDirectionAsPrevious) diagnostics.sameDirectionReentryCount += 1;
    else diagnostics.oppositeDirectionReentryCount += 1;
  }
  diagnostics.currentCycleId = cycleId;
  diagnostics.currentSide = input.side;
  diagnostics.currentSameDirectionSequence = sameDirectionSequence;
  diagnostics.lastEntrySide = input.side;
  diagnostics.lastSameDirectionSequence = sameDirectionSequence;

  const descriptor: BacktestReentryCycleDescriptor = {
    cycleId,
    cycleNumber,
    side: input.side,
    sameDirectionSequence,
    isReentry,
    sameDirectionAsPrevious,
    trigger,
    entryReasonCode: input.reasonCode,
    entryReason: input.reason,
  };
  appendEvidence(tracker, {
    eventType: "ENTRY",
    timestamp: input.timestamp,
    cycleId,
    cycleNumber,
    side: input.side,
    sameDirectionSequence,
    isReentry,
    sameDirectionAsPrevious,
    trigger,
    price: input.price,
    reasonCode: input.reasonCode,
    reason: input.reason,
    ...(tracker.lastCloseReason ? { closeReason: tracker.lastCloseReason } : {}),
  });
  return descriptor;
}

export function recordBacktestCycleClose(
  tracker: BacktestReentryTracker,
  input: {
    cycle: BacktestReentryCycleDescriptor;
    timestamp: number;
    price: number;
    reasonCode: string;
    reason: string;
    closeReason: string;
  },
): void {
  appendEvidence(tracker, {
    eventType: "CLOSE",
    timestamp: input.timestamp,
    cycleId: input.cycle.cycleId,
    cycleNumber: input.cycle.cycleNumber,
    side: input.cycle.side,
    sameDirectionSequence: input.cycle.sameDirectionSequence,
    isReentry: input.cycle.isReentry,
    sameDirectionAsPrevious: input.cycle.sameDirectionAsPrevious,
    price: input.price,
    reasonCode: input.reasonCode,
    reason: input.reason,
    closeReason: input.closeReason,
  });
  tracker.lastCloseTimestamp = input.timestamp;
  tracker.lastCloseReason = input.closeReason;
  tracker.diagnostics.currentCycleId = null;
  tracker.diagnostics.currentSide = null;
  tracker.diagnostics.currentSameDirectionSequence = null;
}

export function snapshotBacktestReentryDiagnostics(
  tracker: BacktestReentryTracker,
): BacktestReentryDiagnostics {
  return {
    ...tracker.diagnostics,
    events: tracker.diagnostics.events.map(event => ({ ...event })),
  };
}
