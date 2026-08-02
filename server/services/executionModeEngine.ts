import type { Strategy } from "../../drizzle/schema";
import { createHash } from "node:crypto";
import {
  normalizeExecutionModePolicy,
  type CandidateIntent,
  type CandidateIntentAction,
  type DeploymentActivationState,
  type ExecutionMode,
  type ExecutionPolicy,
  type ModeDecision,
} from "../../shared/executionModes";
import {
  evaluateAdvancedMode,
  type ExecutionModeRuntimeContext,
} from "./advancedExecutionModeEngine";

export interface ModeSignalInput {
  action: "buy" | "sell" | "close";
  /** 關倉時指定 canonical position leg；net/未指定代表 CLOSE_ALL。 */
  positionSide?: "long" | "short" | "net";
  price?: number;
  barTimestamp?: number;
  reason?: string;
  requestedQuantity?: number;
  source?: CandidateIntent["source"];
  /** 策略語義要求的腿角色；必須由 mode engine 再驗證。 */
  roleHint?: CandidateIntent["roleHint"];
  /** 同一 runtime 事件重試必須提供相同識別，供 decision ledger 去重。 */
  eventKey?: string;
}

export interface StrategyModeEnvelope {
  candidate: CandidateIntent;
  decision: ModeDecision;
  policy: ExecutionPolicy;
  activationState: DeploymentActivationState;
}

function candidateAction(signal: ModeSignalInput): CandidateIntentAction {
  if (signal.action === "buy") return "OPEN_LONG";
  if (signal.action === "sell") return "OPEN_SHORT";
  if (signal.positionSide === "long") return "CLOSE_LONG";
  if (signal.positionSide === "short") return "CLOSE_SHORT";
  return "CLOSE_ALL";
}

function sourceFromSignalId(signalId: number): CandidateIntent["source"] {
  return signalId > 0 ? "WEBHOOK" : "AUTO";
}

function boundedEventHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

function normalizeActivationState(value: unknown): DeploymentActivationState {
  return value === "LEGACY"
    || value === "DRAFT"
    || value === "DISABLED"
    || value === "PREFLIGHT_FAILED"
    || value === "READY_DISABLED"
    || value === "ARMED"
    || value === "ACTIVE"
    || value === "PAUSED"
    || value === "DRAINING"
    || value === "BLOCKED"
    || value === "ARCHIVED"
    ? value
    : "BLOCKED";
}

function deploymentIdentity(strategy: Pick<Strategy, "id" | "deploymentKey">): string {
  return strategy.deploymentKey || `strategy-${strategy.id}`;
}

function decisionId(candidateId: string): string {
  return `decision:${candidateId}`.slice(0, 128);
}

export function buildCandidateIntent(
  strategy: Pick<Strategy, "id" | "deploymentKey">,
  signal: ModeSignalInput,
  signalId: number,
): CandidateIntent {
  const action = candidateAction(signal);
  const deploymentId = strategy.id;
  const source = signal.source ?? sourceFromSignalId(signalId);
  const eventKey = signal.eventKey?.trim() || String(signalId);
  const identity = deploymentIdentity(strategy);
  const eventHash = boundedEventHash(`${identity}|${source}|${action}|${eventKey}`);
  const candidateId = `candidate:${eventHash}:${identity}`.slice(0, 128);
  const requestedQuantity = Number(signal.requestedQuantity);
  return {
    candidateId,
    deploymentId,
    action,
    side: action.includes("LONG") ? "LONG" : action.includes("SHORT") ? "SHORT" : undefined,
    roleHint: signal.roleHint,
    requestedQuantity: Number.isFinite(requestedQuantity) && requestedQuantity > 0
      ? requestedQuantity
      : undefined,
    signalPrice: signal.price,
    barTimestamp: signal.barTimestamp,
    source,
    reasonCode: signal.reason ? "STRATEGY_SIGNAL" : "RAW_SIGNAL",
    reason: signal.reason || `${signal.action.toUpperCase()} signal`,
    createdAt: Date.now(),
  };
}

function modeNotReadyDecision(
  candidate: CandidateIntent,
  mode: ExecutionMode,
): ModeDecision {
  return {
    decisionId: decisionId(candidate.candidateId),
    candidateId: candidate.candidateId,
    deploymentId: candidate.deploymentId,
    executionMode: mode,
    outcome: "REJECTED",
    reasonCode: "MODE_RUNTIME_NOT_READY",
    contextSnapshot: { runtimeReady: false },
    createdAt: Date.now(),
  };
}

/**
 * Canonical runtime mode Gate。LEGACY 僅保留既有 S1 相容；所有新 deployment 必須完成
 * preflight 並進入 ACTIVE，才可增加曝險。任何未知、未就緒、暫停、drain 或封存狀態
 * 都只允許 reduce／close，以 fail-closed 防止 lifecycle schema 被繞過。
 */
export function evaluateStrategyMode(
  strategy: Pick<Strategy, "id" | "deploymentKey" | "executionMode" | "executionPolicy" | "activationState">,
  signal: ModeSignalInput,
  signalId: number,
  runtime?: ExecutionModeRuntimeContext,
): StrategyModeEnvelope {
  const policy = normalizeExecutionModePolicy(
    strategy.executionPolicy ?? { mode: strategy.executionMode || "SINGLE_EXCLUSIVE" },
  );
  const activationState = normalizeActivationState(strategy.activationState);
  const candidate = buildCandidateIntent(strategy, signal, signalId);

  const closeAction = candidate.action === "CLOSE_ALL"
    || candidate.action.startsWith("CLOSE_")
    || candidate.action.startsWith("REDUCE_");
  const exposureBlocked = activationState !== "LEGACY" && activationState !== "ACTIVE";

  if (policy.mode !== "SINGLE_EXCLUSIVE" && exposureBlocked && !closeAction) {
    return {
      candidate,
      policy,
      activationState,
      decision: {
        decisionId: decisionId(candidate.candidateId),
        candidateId: candidate.candidateId,
        deploymentId: candidate.deploymentId,
        executionMode: policy.mode,
        outcome: "REJECTED",
        reasonCode: `ACTIVATION_${activationState}`,
        contextSnapshot: { activationState },
        createdAt: Date.now(),
      },
    };
  }

  if (policy.mode !== "SINGLE_EXCLUSIVE") {
    return {
      candidate,
      policy,
      activationState,
      decision: evaluateAdvancedMode(candidate, policy, runtime),
    };
  }

  const outcome = exposureBlocked
    ? closeAction ? "CLOSE_ONLY" : "REJECTED"
    : "APPROVED";
  const reasonCode = exposureBlocked
    ? closeAction ? "ACTIVATION_CLOSE_ONLY" : `ACTIVATION_${activationState}`
    : "S1_LEGACY_PIPELINE_APPROVED";

  return {
    candidate,
    policy,
    activationState,
    decision: {
      decisionId: decisionId(candidate.candidateId),
      candidateId: candidate.candidateId,
      deploymentId: candidate.deploymentId,
      executionMode: policy.mode,
      outcome,
      reasonCode,
      targetSide: candidate.side,
      targetRole: "PRIMARY",
      reduceOnly: closeAction,
      contextSnapshot: {
        activationState,
        compatibilityPath: "legacy-s1",
      },
      createdAt: Date.now(),
    },
  };
}

export function canExecuteModeDecision(decision: ModeDecision): boolean {
  return decision.outcome === "APPROVED" || decision.outcome === "CLOSE_ONLY";
}
