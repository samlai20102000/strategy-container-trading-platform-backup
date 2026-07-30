import {
  V41_CONFIG_VERSION,
  V41_STRATEGY_KEY,
  getV41ConfigHash,
  countEnabledV41EntryConditions,
  type NormalizedV41Config,
} from "../../../shared/strategies/kama3kMartinV41";
import type {
  V41ConditionId,
  V41EntryEvaluationResult,
  V41ReasonCode,
  V41ReentryEvaluationResult,
  V41VoteStatus,
} from "../../strategies/v41/entryConditions";

type VoteCounters = Record<V41VoteStatus, number>;

export interface V41BacktestEntryDiagnostics {
  strategyKey: typeof V41_STRATEGY_KEY;
  configVersion: typeof V41_CONFIG_VERSION;
  configHash: string;
  entryConditionLogic: NormalizedV41Config["entryConditionLogic"];
  enabledConditionCount: number;
  evaluatedBars: number;
  openedSignals: number;
  reentryEvaluations: number;
  reentryOpened: number;
  holdReasonCounts: Partial<Record<V41ReasonCode, number>>;
  voteStatusCounts: Record<V41ConditionId, VoteCounters>;
}

function createVoteCounters(): VoteCounters {
  return {
    disabled: 0,
    long: 0,
    short: 0,
    no_signal: 0,
    data_unavailable: 0,
  };
}

export function createV41BacktestEntryDiagnostics(
  config: NormalizedV41Config,
): V41BacktestEntryDiagnostics {
  return {
    strategyKey: V41_STRATEGY_KEY,
    configVersion: V41_CONFIG_VERSION,
    configHash: getV41ConfigHash(config),
    entryConditionLogic: config.entryConditionLogic,
    enabledConditionCount: countEnabledV41EntryConditions(config),
    evaluatedBars: 0,
    openedSignals: 0,
    reentryEvaluations: 0,
    reentryOpened: 0,
    holdReasonCounts: {},
    voteStatusCounts: {
      three_k: createVoteCounters(),
      kama_fast_slow: createVoteCounters(),
      price_vs_slow: createVoteCounters(),
    },
  };
}

function incrementReason(
  diagnostics: V41BacktestEntryDiagnostics,
  reasonCode: V41ReasonCode,
): void {
  diagnostics.holdReasonCounts[reasonCode] = (diagnostics.holdReasonCounts[reasonCode] ?? 0) + 1;
}

function incrementVotes(
  diagnostics: V41BacktestEntryDiagnostics,
  result: V41EntryEvaluationResult,
): void {
  for (const vote of result.votes) {
    diagnostics.voteStatusCounts[vote.condition][vote.status] += 1;
  }
}

export function recordV41BacktestEntryEvaluation(
  diagnostics: V41BacktestEntryDiagnostics,
  result: V41EntryEvaluationResult,
): void {
  diagnostics.evaluatedBars += 1;
  incrementVotes(diagnostics, result);
  if (result.passed) {
    diagnostics.openedSignals += 1;
  } else {
    incrementReason(diagnostics, result.primaryReasonCode);
  }
}

export function recordV41BacktestReentryEvaluation(
  diagnostics: V41BacktestEntryDiagnostics,
  result: V41ReentryEvaluationResult,
): void {
  diagnostics.reentryEvaluations += 1;
  if (result.continuousDecision) incrementVotes(diagnostics, result.continuousDecision);
  if (result.allowed) {
    diagnostics.reentryOpened += 1;
  } else {
    incrementReason(diagnostics, result.reasonCode);
  }
}
