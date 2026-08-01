import { and, desc, eq, inArray } from "drizzle-orm";
import {
  hedgeRelationships,
  positionLegs,
  type PositionLeg,
  type Strategy,
} from "../../drizzle/schema";
import {
  normalizeExecutionModePolicy,
  type CandidateIntent,
} from "../../shared/executionModes";
import { getDb } from "../db";
import type { ExchangeAdapter } from "../exchanges/types";
import type { ExecutionModeRuntimeContext } from "./advancedExecutionModeEngine";
import {
  canExecuteModeDecision,
  evaluateStrategyMode,
  type ModeSignalInput,
  type StrategyModeEnvelope,
} from "./executionModeEngine";
import { recordModeDecision } from "./threeModeLedger";
import { loadCanonicalRuntimeDeployment } from "./canonicalRuntimeDeployment";

const ACTIVE_LEG_STATES = [
  "PENDING",
  "OPEN",
  "REDUCING",
  "RECONCILIATION_REQUIRED",
  "BLOCKED",
] as const;

export interface RuntimeModeGuardInput {
  strategy: Pick<Strategy,
    | "id"
    | "userId"
    | "apiKeyId"
    | "deploymentKey"
    | "executionMode"
    | "executionPolicy"
    | "activationState"
    | "symbol"
  >;
  adapter: ExchangeAdapter;
  signal: ModeSignalInput;
  signalId: number;
  cycleId?: string | null;
  legId?: string | null;
}

export interface RuntimeModeAuthorization {
  allowed: boolean;
  envelope: StrategyModeEnvelope;
  persistenceError?: string;
}

export interface RuntimeModeGuardDependencies {
  loadCanonicalStrategy: (
    strategy: RuntimeModeGuardInput["strategy"],
  ) => Promise<RuntimeModeGuardInput["strategy"]>;
  loadRuntimeContext: (
    strategy: RuntimeModeGuardInput["strategy"],
    adapter: ExchangeAdapter,
  ) => Promise<ExecutionModeRuntimeContext | undefined>;
  recordDecision: typeof recordModeDecision;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function unrealizedPnlPct(leg: PositionLeg): number | undefined {
  const quantity = Math.abs(Number(leg.quantity));
  const entry = Number(leg.avgEntryPrice);
  const pnl = Number(leg.unrealizedPnl);
  const notional = quantity * entry;
  if (!Number.isFinite(pnl) || !Number.isFinite(notional) || notional <= 0) return undefined;
  return (pnl / notional) * 100;
}

export function positionLegToRuntimeLeg(leg: PositionLeg): ExecutionModeRuntimeContext["openLegs"][number] {
  return {
    legId: leg.legId,
    side: leg.side,
    role: leg.role,
    status: leg.status === "CLOSED" ? "BLOCKED" : leg.status,
    quantity: finiteNumber(leg.quantity) ?? 0,
    unrealizedPnlPct: unrealizedPnlPct(leg),
    openedAt: leg.openedAt?.getTime(),
  };
}

export async function loadRuntimeModeContext(
  strategy: RuntimeModeGuardInput["strategy"],
  adapter: ExchangeAdapter,
): Promise<ExecutionModeRuntimeContext | undefined> {
  const policy = normalizeExecutionModePolicy(
    strategy.executionPolicy ?? { mode: strategy.executionMode || "SINGLE_EXCLUSIVE" },
  );
  if (policy.mode === "SINGLE_EXCLUSIVE") {
    return { runtimeReady: true, openLegs: [], now: Date.now() };
  }

  const db = await getDb();
  if (!db) return { runtimeReady: false, openLegs: [], now: Date.now() };
  const rows = await db.select().from(positionLegs).where(and(
    eq(positionLegs.userId, strategy.userId),
    eq(positionLegs.strategyId, strategy.id),
    inArray(positionLegs.status, [...ACTIVE_LEG_STATES]),
  ));
  const closedHedge = await db.select({ closedAt: hedgeRelationships.closedAt })
    .from(hedgeRelationships)
    .where(and(
      eq(hedgeRelationships.userId, strategy.userId),
      eq(hedgeRelationships.strategyId, strategy.id),
      eq(hedgeRelationships.status, "CLOSED"),
    ))
    .orderBy(desc(hedgeRelationships.closedAt))
    .limit(1);

  const now = Date.now();
  try {
    const capability = await adapter.probeCapabilities(strategy.symbol);
    const ttlMs = policy.riskBudget.capabilityTtlSeconds * 1_000;
    const supportsIndependentLongShort = capability.positionMode === "HEDGE";
    return {
      runtimeReady: true,
      openLegs: rows.map(positionLegToRuntimeLeg),
      capabilities: {
        supportsIndependentLongShort,
        canPreciselyCloseLeg: capability.preciseLegClose,
        capturedAt: capability.observedAt,
        expiresAt: capability.observedAt + ttlMs,
        blockerCodes: [
          ...(!supportsIndependentLongShort ? ["ACCOUNT_POSITION_MODE_INCOMPATIBLE"] : []),
          ...(!capability.preciseLegClose ? ["PRECISE_LEG_CLOSE_UNAVAILABLE"] : []),
        ],
      },
      lastHedgeClosedAt: closedHedge[0]?.closedAt?.getTime(),
      now,
    };
  } catch {
    return {
      runtimeReady: true,
      openLegs: rows.map(positionLegToRuntimeLeg),
      now,
    };
  }
}

const defaultDependencies: RuntimeModeGuardDependencies = {
  loadCanonicalStrategy: async strategy => (
    await loadCanonicalRuntimeDeployment(strategy.id, strategy.userId)
  ).strategy,
  loadRuntimeContext: loadRuntimeModeContext,
  recordDecision: recordModeDecision,
};

function persistenceFailureEnvelope(
  envelope: StrategyModeEnvelope,
  error: unknown,
): RuntimeModeAuthorization {
  const sanitized = error instanceof Error ? error.message.slice(0, 160) : "unknown persistence error";
  return {
    allowed: false,
    persistenceError: sanitized,
    envelope: {
      ...envelope,
      decision: {
        ...envelope.decision,
        outcome: "REJECTED",
        reasonCode: "DECISION_PERSISTENCE_FAILED",
        contextSnapshot: {
          ...envelope.decision.contextSnapshot,
          persistenceRequired: true,
        },
      },
    },
  };
}

export async function authorizeRuntimeModeAction(
  input: RuntimeModeGuardInput,
  dependencies: RuntimeModeGuardDependencies = defaultDependencies,
): Promise<RuntimeModeAuthorization> {
  let strategy: RuntimeModeGuardInput["strategy"];
  try {
    strategy = await dependencies.loadCanonicalStrategy(input.strategy);
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : "unknown canonical runtime error";
    const base = evaluateStrategyMode(input.strategy, input.signal, input.signalId, undefined);
    const envelope: StrategyModeEnvelope = {
      ...base,
      decision: {
        ...base.decision,
        outcome: "REJECTED",
        reasonCode: "CANONICAL_RUNTIME_CONTEXT_INVALID",
        contextSnapshot: {
          ...base.decision.contextSnapshot,
          canonicalRuntimeError: detail,
          failClosed: true,
        },
      },
    };
    try {
      await dependencies.recordDecision({
        userId: input.strategy.userId,
        strategyId: input.strategy.id,
        deploymentKey: input.strategy.deploymentKey,
        cycleId: input.cycleId ?? null,
        legId: input.legId ?? null,
        source: envelope.candidate.source,
        candidateIntent: envelope.candidate as unknown as Record<string, unknown>,
        decision: envelope.decision,
      });
    } catch (persistenceError) {
      return persistenceFailureEnvelope(envelope, persistenceError);
    }
    return { allowed: false, envelope };
  }
  const runtime = await dependencies.loadRuntimeContext(strategy, input.adapter);
  const envelope = evaluateStrategyMode(strategy, input.signal, input.signalId, runtime);
  try {
    const inserted = await dependencies.recordDecision({
      userId: strategy.userId,
      strategyId: strategy.id,
      deploymentKey: strategy.deploymentKey,
      cycleId: input.cycleId ?? null,
      legId: input.legId ?? envelope.decision.targetLegId ?? null,
      source: envelope.candidate.source,
      candidateIntent: envelope.candidate as unknown as Record<string, unknown>,
      decision: envelope.decision,
    });
    if (!inserted) {
      return {
        allowed: false,
        envelope: {
          ...envelope,
          decision: {
            ...envelope.decision,
            outcome: "REJECTED",
            reasonCode: "DUPLICATE_RUNTIME_EVENT",
            contextSnapshot: {
              ...envelope.decision.contextSnapshot,
              deduplicated: true,
            },
          },
        },
      };
    }
  } catch (error) {
    return persistenceFailureEnvelope(envelope, error);
  }
  return {
    allowed: canExecuteModeDecision(envelope.decision),
    envelope,
  };
}

export function runtimeModeRejectionMessage(result: RuntimeModeAuthorization): string {
  const { decision } = result.envelope;
  return `三模式執行 Gate 拒絕：${decision.reasonCode}（${decision.outcome}）`;
}

export function runtimeSourceForSignal(source: CandidateIntent["source"] | undefined): CandidateIntent["source"] {
  return source ?? "WEBHOOK";
}
