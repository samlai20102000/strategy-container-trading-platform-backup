import { and, asc, eq, inArray } from "drizzle-orm";
import { positionLegs, type PositionLeg } from "../../drizzle/schema";
import type {
  KamaRainbowMartinEntryEvent,
  KamaRainbowMartinEntryKind,
  KamaRainbowMartinReentryObservation,
} from "../../shared/observability/kamaRainbowMartinReentry";
import { getDb } from "../db";

interface StrategyObservationInput {
  id: number;
  martinState: unknown;
  reentryEnabled: boolean;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function sideValue(value: unknown): "long" | "short" | null {
  return value === "long" || value === "LONG"
    ? "long"
    : value === "short" || value === "SHORT"
      ? "short"
      : null;
}

function timestampValue(value: Date | string | number | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === "number" ? value : value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function closeReasonFromState(value: unknown): string | null {
  const runtime = objectValue(objectValue(value).kamaRainbowMartinRuntime);
  const reason = runtime.lastCloseReason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

function observationState(input: {
  enabled: boolean;
  killed: boolean;
  hasActivePosition: boolean;
  cycleNumber: number;
}): KamaRainbowMartinReentryObservation["state"] {
  if (!input.enabled) return "disabled";
  if (input.killed) return "killed";
  if (input.hasActivePosition) return "position_open";
  return input.cycleNumber > 0 ? "awaiting_reentry" : "awaiting_initial_entry";
}

export function summarizeKamaRainbowMartinRuntimeObservation(
  strategy: StrategyObservationInput,
): KamaRainbowMartinReentryObservation {
  const state = objectValue(strategy.martinState);
  const runtime = objectValue(state.kamaRainbowMartinRuntime);
  const cycleNumber = positiveInteger(runtime.cycleNumber);
  const sameDirectionEntrySequence = positiveInteger(runtime.sameDirectionEntrySequence);
  const lastEntrySide = sideValue(runtime.lastEntrySide);
  const rawEvent = objectValue(runtime.lastEntryEvent);
  const eventSide = sideValue(rawEvent.side);
  const eventKind = rawEvent.kind;
  const lastEntryEvent: KamaRainbowMartinEntryEvent | null = eventSide && (
    eventKind === "initial"
    || eventKind === "same_direction_reentry"
    || eventKind === "reverse_direction_reentry"
  ) ? {
    kind: eventKind,
    cycleNumber: positiveInteger(rawEvent.cycleNumber),
    sameDirectionEntrySequence: positiveInteger(rawEvent.sameDirectionEntrySequence),
    side: eventSide,
    previousCloseReason: typeof rawEvent.previousCloseReason === "string" ? rawEvent.previousCloseReason : null,
    occurredAt: Number(rawEvent.occurredAt) || 0,
    fillId: typeof rawEvent.fillId === "string" ? rawEvent.fillId : "",
    orderId: typeof rawEvent.orderId === "string" ? rawEvent.orderId : null,
  } : null;
  const hasActivePosition = Number(state.currentLayer) > 0
    && Number(state.totalSize) > 0
    && Number(state.avgPrice) > 0;
  const killed = runtime.killed === true;

  return {
    strategyId: strategy.id,
    enabled: strategy.reentryEnabled,
    state: observationState({ enabled: strategy.reentryEnabled, killed, hasActivePosition, cycleNumber }),
    cycleNumber,
    sameDirectionEntrySequence,
    lastEntrySide,
    lastCloseReason: typeof runtime.lastCloseReason === "string" ? runtime.lastCloseReason : null,
    lastEntryEvent,
    source: cycleNumber > 0 || lastEntryEvent ? "s1_runtime" : "no_execution_evidence",
  };
}

export function summarizeKamaRainbowMartinLedgerObservation(
  strategy: StrategyObservationInput,
  rows: readonly PositionLeg[],
): KamaRainbowMartinReentryObservation | null {
  const cycleRows = [...rows]
    .filter(row => row.role !== "HEDGE")
    .sort((left, right) => {
      const timeDelta = timestampValue(left.openedAt ?? left.createdAt) - timestampValue(right.openedAt ?? right.createdAt);
      return timeDelta || left.id - right.id;
    });
  const firstByCycle = new Map<string, PositionLeg>();
  for (const row of cycleRows) {
    if (!firstByCycle.has(row.cycleId)) firstByCycle.set(row.cycleId, row);
  }
  const cycles = [...firstByCycle.values()];
  if (cycles.length === 0) return null;

  let previousSide: "long" | "short" | null = null;
  let sameDirectionEntrySequence = 0;
  let previousCycleRow: PositionLeg | null = null;
  let lastEntryEvent: KamaRainbowMartinEntryEvent | null = null;

  cycles.forEach((row, index) => {
    const side = sideValue(row.side) ?? "long";
    const kind: KamaRainbowMartinEntryKind = index === 0
      ? "initial"
      : previousSide === side
        ? "same_direction_reentry"
        : "reverse_direction_reentry";
    sameDirectionEntrySequence = index > 0 && previousSide === side
      ? sameDirectionEntrySequence + 1
      : 1;
    const runtime = objectValue(objectValue(row.martinState).kamaRainbowMartinRuntime);
    const fills = Array.isArray(runtime.fills) ? runtime.fills.map(objectValue) : [];
    const firstFill = fills.find(fill => positiveInteger(fill.layer) === 1) ?? {};
    lastEntryEvent = {
      kind,
      cycleNumber: index + 1,
      sameDirectionEntrySequence,
      side,
      previousCloseReason: previousCycleRow ? closeReasonFromState(previousCycleRow.martinState) : null,
      occurredAt: Number(firstFill.timestamp) || timestampValue(row.openedAt ?? row.createdAt),
      fillId: typeof firstFill.fillId === "string" ? firstFill.fillId : row.legId,
      orderId: typeof firstFill.orderId === "string" ? firstFill.orderId : null,
    };
    previousSide = side;
    previousCycleRow = row;
  });

  const latest = cycles.at(-1)!;
  const latestRuntime = objectValue(objectValue(latest.martinState).kamaRainbowMartinRuntime);
  const hasActivePosition = rows.some(row => row.status !== "CLOSED" && row.status !== "BLOCKED");
  return {
    strategyId: strategy.id,
    enabled: strategy.reentryEnabled,
    state: observationState({
      enabled: strategy.reentryEnabled,
      killed: latestRuntime.killed === true,
      hasActivePosition,
      cycleNumber: cycles.length,
    }),
    cycleNumber: cycles.length,
    sameDirectionEntrySequence,
    lastEntrySide: previousSide,
    lastCloseReason: closeReasonFromState(latest.martinState),
    lastEntryEvent,
    source: "position_ledger",
  };
}

export async function listKamaRainbowMartinReentryObservations(input: {
  userId: number;
  strategies: readonly StrategyObservationInput[];
}): Promise<KamaRainbowMartinReentryObservation[]> {
  if (input.strategies.length === 0) return [];
  const db = await getDb();
  const strategyIds = input.strategies.map(strategy => strategy.id);
  const rows = db
    ? await db.select().from(positionLegs).where(and(
        eq(positionLegs.userId, input.userId),
        inArray(positionLegs.strategyId, strategyIds),
      )).orderBy(asc(positionLegs.openedAt), asc(positionLegs.createdAt), asc(positionLegs.id))
    : [];
  const rowsByStrategy = new Map<number, PositionLeg[]>();
  for (const row of rows) {
    const grouped = rowsByStrategy.get(row.strategyId) ?? [];
    grouped.push(row);
    rowsByStrategy.set(row.strategyId, grouped);
  }
  return input.strategies.map(strategy => (
    summarizeKamaRainbowMartinLedgerObservation(strategy, rowsByStrategy.get(strategy.id) ?? [])
    ?? summarizeKamaRainbowMartinRuntimeObservation(strategy)
  ));
}
