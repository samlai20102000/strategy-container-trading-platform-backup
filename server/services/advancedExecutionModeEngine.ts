import type {
  CandidateIntent,
  ExecutionMode,
  ExecutionPolicy,
  HedgeGuardedPolicy,
  ModeDecision,
  PositionLegRole,
  PositionSide,
} from "../../shared/executionModes";

export interface ActiveModeLeg {
  legId: string;
  side: PositionSide;
  role: PositionLegRole;
  status: "PENDING" | "OPEN" | "REDUCING" | "RECONCILIATION_REQUIRED" | "BLOCKED";
  quantity: number;
  unrealizedPnlPct?: number;
  openedAt?: number;
}

export interface ModeRuntimeCapabilities {
  supportsIndependentLongShort: boolean;
  canPreciselyCloseLeg: boolean;
  capturedAt: number;
  expiresAt: number;
  blockerCodes?: string[];
}

export interface ExecutionModeRuntimeContext {
  runtimeReady: boolean;
  openLegs: ActiveModeLeg[];
  capabilities?: ModeRuntimeCapabilities;
  lastHedgeClosedAt?: number;
  now?: number;
}

function newDecision(
  candidate: CandidateIntent,
  mode: ExecutionMode,
  input: Omit<ModeDecision, "decisionId" | "candidateId" | "deploymentId" | "executionMode" | "createdAt">,
): ModeDecision {
  return {
    decisionId: `decision:${candidate.candidateId}`.slice(0, 128),
    candidateId: candidate.candidateId,
    deploymentId: candidate.deploymentId,
    executionMode: mode,
    ...input,
    createdAt: Date.now(),
  };
}

function generatedLegId(candidate: CandidateIntent, role: PositionLegRole): string {
  return `leg:${candidate.candidateId}:${role}`.slice(0, 128);
}

function isCloseAction(action: CandidateIntent["action"]): boolean {
  return action === "CLOSE_ALL" || action.startsWith("CLOSE_") || action.startsWith("REDUCE_");
}

function runtimeBlocker(
  mode: Exclude<ExecutionMode, "SINGLE_EXCLUSIVE">,
  runtime: ExecutionModeRuntimeContext | undefined,
): { reasonCode: string; context: Record<string, unknown> } | null {
  if (!runtime?.runtimeReady) {
    return { reasonCode: "MODE_RUNTIME_NOT_READY", context: { runtimeReady: false } };
  }
  if (!runtime.capabilities) {
    return { reasonCode: "CAPABILITY_UNKNOWN", context: { runtimeReady: true } };
  }
  const now = runtime.now ?? Date.now();
  if (runtime.capabilities.expiresAt <= now) {
    return {
      reasonCode: "CAPABILITY_STALE",
      context: {
        capturedAt: runtime.capabilities.capturedAt,
        expiresAt: runtime.capabilities.expiresAt,
        now,
      },
    };
  }
  if (!runtime.capabilities.supportsIndependentLongShort || !runtime.capabilities.canPreciselyCloseLeg) {
    return {
      reasonCode: "CAPABILITY_INCOMPATIBLE",
      context: {
        mode,
        supportsIndependentLongShort: runtime.capabilities.supportsIndependentLongShort,
        canPreciselyCloseLeg: runtime.capabilities.canPreciselyCloseLeg,
        blockerCodes: runtime.capabilities.blockerCodes ?? [],
      },
    };
  }
  return null;
}

function invalidLegStructure(
  candidate: CandidateIntent,
  mode: ExecutionMode,
  legs: ActiveModeLeg[],
): ModeDecision | null {
  const hasInvalidQuantity = legs.some(leg => !Number.isFinite(leg.quantity) || leg.quantity <= 0);
  const duplicatedSide = new Set(legs.map(leg => leg.side)).size !== legs.length;
  const needsReconciliation = legs.some(leg => leg.status === "RECONCILIATION_REQUIRED");
  if (!hasInvalidQuantity && !duplicatedSide && !needsReconciliation && legs.length <= 2) return null;
  return newDecision(candidate, mode, {
    outcome: "RECONCILIATION_REQUIRED",
    reasonCode: "LEG_STRUCTURE_INVALID",
    contextSnapshot: {
      legCount: legs.length,
      legIds: legs.map(leg => leg.legId),
      hasInvalidQuantity,
      duplicatedSide,
      needsReconciliation,
    },
  });
}

function closeDecision(candidate: CandidateIntent, mode: ExecutionMode, legs: ActiveModeLeg[]): ModeDecision {
  const selectedLegs = candidate.side
    ? legs.filter(leg => leg.side === candidate.side)
    : legs;
  if (selectedLegs.length === 0) {
    return newDecision(candidate, mode, {
      outcome: "HOLD",
      reasonCode: "NO_OPEN_LEG",
      reduceOnly: true,
      targetSide: candidate.side,
      contextSnapshot: {
        openLegCount: legs.length,
        requestedSide: candidate.side,
      },
    });
  }
  const onlyLeg = selectedLegs.length === 1 ? selectedLegs[0] : undefined;
  const requestedQuantity = candidate.requestedQuantity;
  const approvedQuantity = onlyLeg
    ? requestedQuantity === undefined
      ? onlyLeg.quantity
      : Math.min(requestedQuantity, onlyLeg.quantity)
    : undefined;
  return newDecision(candidate, mode, {
    outcome: "CLOSE_ONLY",
    reasonCode: "LEG_SCOPED_CLOSE_REQUIRED",
    targetLegId: onlyLeg?.legId,
    targetSide: onlyLeg?.side,
    targetRole: onlyLeg?.role,
    approvedQuantity,
    reduceOnly: true,
    contextSnapshot: {
      closeLegIds: selectedLegs.map(leg => leg.legId),
      closeLegs: selectedLegs.map(leg => ({
        legId: leg.legId,
        side: leg.side,
        quantity: onlyLeg && approvedQuantity !== undefined ? approvedQuantity : leg.quantity,
      })),
    },
  });
}

function evaluateM2(candidate: CandidateIntent, policy: ExecutionPolicy, runtime: ExecutionModeRuntimeContext): ModeDecision {
  const legs = runtime.openLegs.filter(leg => leg.status !== "BLOCKED");
  const invalid = invalidLegStructure(candidate, "MULTI_POSITION", legs);
  if (invalid) return invalid;
  if (isCloseAction(candidate.action)) return closeDecision(candidate, "MULTI_POSITION", legs);
  if (!candidate.side) {
    return newDecision(candidate, "MULTI_POSITION", {
      outcome: "REJECTED",
      reasonCode: "TARGET_SIDE_REQUIRED",
      contextSnapshot: {},
    });
  }
  const existing = legs.find(leg => leg.side === candidate.side);
  if (existing) {
    return newDecision(candidate, "MULTI_POSITION", {
      outcome: "APPROVED",
      reasonCode: "M2_EXISTING_LEG_ADD",
      targetLegId: existing.legId,
      targetSide: existing.side,
      targetRole: "INDEPENDENT",
      approvedQuantity: candidate.requestedQuantity,
      reduceOnly: false,
      contextSnapshot: { openLegCount: legs.length, martinScope: existing.legId },
    });
  }
  if (candidate.action === "ADD_LONG" || candidate.action === "ADD_SHORT") {
    return newDecision(candidate, "MULTI_POSITION", {
      outcome: "HOLD",
      reasonCode: "M2_ADD_TARGET_LEG_NOT_OPEN",
      targetSide: candidate.side,
      reduceOnly: false,
      contextSnapshot: { openLegCount: legs.length, eventInvalidatedByEarlierExit: true },
    });
  }
  if (legs.length >= policy.maxOpenLegs) {
    return newDecision(candidate, "MULTI_POSITION", {
      outcome: "REJECTED",
      reasonCode: "M2_MAX_LEGS_REACHED",
      contextSnapshot: { openLegCount: legs.length, maxOpenLegs: policy.maxOpenLegs },
    });
  }
  return newDecision(candidate, "MULTI_POSITION", {
    outcome: "APPROVED",
    reasonCode: "M2_NEW_INDEPENDENT_LEG",
    targetLegId: generatedLegId(candidate, "INDEPENDENT"),
    targetSide: candidate.side,
    targetRole: "INDEPENDENT",
    approvedQuantity: candidate.requestedQuantity,
    reduceOnly: false,
    contextSnapshot: { openLegCount: legs.length, isolation: "LEG_SCOPED" },
  });
}

function evaluateH3(
  candidate: CandidateIntent,
  policy: HedgeGuardedPolicy,
  runtime: ExecutionModeRuntimeContext,
): ModeDecision {
  const legs = runtime.openLegs.filter(leg => leg.status !== "BLOCKED");
  const invalid = invalidLegStructure(candidate, "HEDGE_GUARDED", legs);
  if (invalid) return invalid;
  if (isCloseAction(candidate.action)) return closeDecision(candidate, "HEDGE_GUARDED", legs);

  const primary = legs.find(leg => leg.role === "PRIMARY");
  const hedge = legs.find(leg => leg.role === "HEDGE");
  if (!primary && hedge) {
    return newDecision(candidate, "HEDGE_GUARDED", {
      outcome: "RECONCILIATION_REQUIRED",
      reasonCode: "H3_ORPHAN_HEDGE",
      contextSnapshot: { hedgeLegId: hedge.legId },
    });
  }
  if (!candidate.side) {
    return newDecision(candidate, "HEDGE_GUARDED", {
      outcome: "REJECTED",
      reasonCode: "TARGET_SIDE_REQUIRED",
      contextSnapshot: {},
    });
  }
  if (!primary) {
    if (candidate.action === "ADD_LONG" || candidate.action === "ADD_SHORT") {
      return newDecision(candidate, "HEDGE_GUARDED", {
        outcome: "HOLD",
        reasonCode: "H3_ADD_TARGET_PRIMARY_NOT_OPEN",
        targetSide: candidate.side,
        reduceOnly: false,
        contextSnapshot: { eventInvalidatedByEarlierExit: true },
      });
    }
    return newDecision(candidate, "HEDGE_GUARDED", {
      outcome: "APPROVED",
      reasonCode: "H3_NEW_PRIMARY",
      targetLegId: generatedLegId(candidate, "PRIMARY"),
      targetSide: candidate.side,
      targetRole: "PRIMARY",
      approvedQuantity: candidate.requestedQuantity,
      reduceOnly: false,
      contextSnapshot: { hedgeMartinEnabled: false },
    });
  }
  if (candidate.side === primary.side) {
    if (hedge) {
      return newDecision(candidate, "HEDGE_GUARDED", {
        outcome: "HOLD",
        reasonCode: "H3_ACTIVE_RATIO_LOCKED",
        targetLegId: primary.legId,
        targetSide: primary.side,
        targetRole: "PRIMARY",
        contextSnapshot: { hedgeLegId: hedge.legId },
      });
    }
    return newDecision(candidate, "HEDGE_GUARDED", {
      outcome: "APPROVED",
      reasonCode: "H3_PRIMARY_ADD",
      targetLegId: primary.legId,
      targetSide: primary.side,
      targetRole: "PRIMARY",
      approvedQuantity: candidate.requestedQuantity,
      reduceOnly: false,
      contextSnapshot: { martinScope: primary.legId },
    });
  }
  if (hedge) {
    return newDecision(candidate, "HEDGE_GUARDED", {
      outcome: "HOLD",
      reasonCode: "H3_HEDGE_ALREADY_ACTIVE",
      targetLegId: hedge.legId,
      targetSide: hedge.side,
      targetRole: "HEDGE",
      contextSnapshot: { primaryLegId: primary.legId },
    });
  }

  const primaryLossPct = primary.unrealizedPnlPct;
  if (primaryLossPct === undefined || !Number.isFinite(primaryLossPct)) {
    return newDecision(candidate, "HEDGE_GUARDED", {
      outcome: "REJECTED",
      reasonCode: "H3_PRIMARY_PNL_UNKNOWN",
      targetLegId: primary.legId,
      targetSide: primary.side,
      targetRole: "PRIMARY",
      contextSnapshot: {},
    });
  }
  if (primaryLossPct > -policy.primaryLossTriggerPct) {
    return newDecision(candidate, "HEDGE_GUARDED", {
      outcome: "HOLD",
      reasonCode: "H3_LOSS_THRESHOLD_NOT_MET",
      targetLegId: primary.legId,
      targetSide: primary.side,
      targetRole: "PRIMARY",
      contextSnapshot: {
        primaryLossPct,
        triggerLossPct: policy.primaryLossTriggerPct,
        reverseSignal: true,
      },
    });
  }

  const now = runtime.now ?? Date.now();
  const cooldownRemainingMs = runtime.lastHedgeClosedAt
    ? Math.max(0, policy.hedgeCooldownSeconds * 1000 - (now - runtime.lastHedgeClosedAt))
    : 0;
  if (cooldownRemainingMs > 0) {
    return newDecision(candidate, "HEDGE_GUARDED", {
      outcome: "HOLD",
      reasonCode: "H3_COOLDOWN_ACTIVE",
      targetLegId: primary.legId,
      targetSide: primary.side,
      targetRole: "PRIMARY",
      contextSnapshot: { cooldownRemainingMs },
    });
  }

  const hedgeQuantity = Number((Math.abs(primary.quantity) * policy.hedgeRatio).toFixed(8));
  if (!Number.isFinite(hedgeQuantity) || hedgeQuantity <= 0) {
    return newDecision(candidate, "HEDGE_GUARDED", {
      outcome: "REJECTED",
      reasonCode: "H3_HEDGE_QUANTITY_INVALID",
      contextSnapshot: { primaryQuantity: primary.quantity, hedgeRatio: policy.hedgeRatio },
    });
  }
  return newDecision(candidate, "HEDGE_GUARDED", {
    outcome: "APPROVED",
    reasonCode: "H3_HEDGE_ARMED",
    targetLegId: generatedLegId(candidate, "HEDGE"),
    targetSide: candidate.side,
    targetRole: "HEDGE",
    approvedQuantity: hedgeQuantity,
    reduceOnly: false,
    contextSnapshot: {
      primaryLegId: primary.legId,
      primaryLossPct,
      reverseSignal: true,
      hedgeRatio: policy.hedgeRatio,
      hedgeMartinEnabled: false,
    },
  });
}

export function evaluateAdvancedMode(
  candidate: CandidateIntent,
  policy: ExecutionPolicy,
  runtime: ExecutionModeRuntimeContext | undefined,
): ModeDecision {
  if (policy.mode === "SINGLE_EXCLUSIVE") {
    return newDecision(candidate, policy.mode, {
      outcome: "REJECTED",
      reasonCode: "ADVANCED_MODE_REQUIRED",
      contextSnapshot: {},
    });
  }
  const blocker = runtimeBlocker(policy.mode, runtime);
  if (blocker || !runtime) {
    return newDecision(candidate, policy.mode, {
      outcome: "REJECTED",
      reasonCode: blocker?.reasonCode ?? "MODE_RUNTIME_NOT_READY",
      contextSnapshot: blocker?.context ?? { runtimeReady: false },
    });
  }
  return policy.mode === "MULTI_POSITION"
    ? evaluateM2(candidate, policy, runtime)
    : evaluateH3(candidate, policy, runtime);
}
