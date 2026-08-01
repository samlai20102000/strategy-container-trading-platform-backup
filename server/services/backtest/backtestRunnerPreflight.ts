import { normalizeExecutionModePolicy, type ExecutionPolicy } from "../../../shared/executionModes";
import { getStrategy } from "../strategyStudio";
import { getStrategyRunnerDescriptor } from "../strategyRunnerDescriptors";
import { ensureBuiltInPortfolioRuntimeFactoriesRegistered } from "./builtInPortfolioRuntimeFactories";
import type { BacktestRequest } from "./backtestEngine";
import {
  assertExecutablePortfolioStrategyAdapter,
  PortfolioAdapterResolutionError,
  resolvePortfolioStrategyAdapter,
  type ResolvedPortfolioStrategyAdapter,
} from "./portfolioStrategyAdapterRegistry";
import type { BacktestRunnerIdentity } from "./backtestContracts";

export type BacktestRunnerPreflightErrorCode =
  | "STRATEGY_NOT_REGISTERED"
  | "BACKTEST_MODE_POLICY_MISMATCH"
  | "BACKTEST_MODE_CAPABILITY_NOT_CERTIFIED"
  | "RUNNER_DESCRIPTOR_MISSING"
  | "BACKTEST_CHANNEL_NOT_CERTIFIED"
  | "BACKTEST_MODE_NOT_CERTIFIED"
  | "PORTFOLIO_ADAPTER_MISSING"
  | "PORTFOLIO_ADAPTER_IMPLEMENTATION_MISSING"
  | "PORTFOLIO_ADAPTER_VERSION_MISMATCH"
  | "PORTFOLIO_ADAPTER_MODE_MISMATCH"
  | "RUNNER_PREFLIGHT_FAILED";

export interface BacktestRunnerPreflightResult {
  executionPolicy: ExecutionPolicy;
  runner: BacktestRunnerIdentity;
  resolvedPortfolioAdapter: ResolvedPortfolioStrategyAdapter | null;
}

export interface BacktestFailureMetadata {
  stage: "RUNNER_PREFLIGHT" | "DATA_LOAD" | "EXECUTION" | "QUEUE";
  errorCode: string;
  details?: Record<string, unknown>;
}

export class BacktestRunnerPreflightError extends Error {
  constructor(
    readonly code: BacktestRunnerPreflightErrorCode,
    readonly strategyKey: string,
    readonly executionMode: ExecutionPolicy["mode"],
    readonly details: Record<string, unknown> = {},
    message?: string,
  ) {
    super(`${code}: ${message ?? `${strategyKey} / ${executionMode}`}`);
    this.name = "BacktestRunnerPreflightError";
  }
}

function normalizePolicy(request: BacktestRequest): ExecutionPolicy {
  const policy = normalizeExecutionModePolicy(
    request.executionPolicy ?? { mode: request.executionMode ?? "SINGLE_EXCLUSIVE" },
  );
  if (request.executionMode && request.executionMode !== policy.mode) {
    throw new BacktestRunnerPreflightError(
      "BACKTEST_MODE_POLICY_MISMATCH",
      request.strategyKey,
      policy.mode,
      { executionMode: request.executionMode, policyMode: policy.mode },
      "executionMode 與 executionPolicy.mode 不一致",
    );
  }
  request.executionMode = policy.mode;
  request.executionPolicy = policy;
  return policy;
}

function assertRequestedCapabilities(request: BacktestRequest, policy: ExecutionPolicy): void {
  if (policy.mode === "SINGLE_EXCLUSIVE") return;
  const capabilities = request.strategyModeCapabilities;
  const blockers: string[] = [];
  if (!capabilities || capabilities.contractVersion !== "strategy-mode-capabilities-v1") {
    blockers.push("STRATEGY_MODE_CAPABILITIES_MISSING");
  } else {
    if (!capabilities.supportedModes.includes(policy.mode)) blockers.push("MODE_NOT_DECLARED_SUPPORTED");
    if (!capabilities.independentLegState) blockers.push("INDEPENDENT_LEG_STATE_NOT_CERTIFIED");
    if (!capabilities.preciseLegClose) blockers.push("PRECISE_LEG_CLOSE_NOT_CERTIFIED");
    if (policy.mode === "HEDGE_GUARDED" && !capabilities.hedgeGuard) {
      blockers.push("HEDGE_GUARD_NOT_CERTIFIED");
    }
  }
  if (!request.strategyVersion?.trim()) blockers.push("STRATEGY_VERSION_REQUIRED");
  if (!request.strategyLogicHash?.trim()) blockers.push("STRATEGY_LOGIC_HASH_REQUIRED");
  if (blockers.length > 0) {
    throw new BacktestRunnerPreflightError(
      "BACKTEST_MODE_CAPABILITY_NOT_CERTIFIED",
      request.strategyKey,
      policy.mode,
      { blockers },
      blockers.join(","),
    );
  }
}

function wrapResolutionError(
  error: unknown,
  request: BacktestRequest,
  policy: ExecutionPolicy,
): never {
  if (error instanceof BacktestRunnerPreflightError) throw error;
  if (error instanceof PortfolioAdapterResolutionError) {
    throw new BacktestRunnerPreflightError(
      error.code,
      request.strategyKey,
      policy.mode,
      error.details,
      error.message,
    );
  }
  throw new BacktestRunnerPreflightError(
    "RUNNER_PREFLIGHT_FAILED",
    request.strategyKey,
    policy.mode,
    {},
    error instanceof Error ? error.message : String(error),
  );
}

export function preflightBacktestRunner(request: BacktestRequest): BacktestRunnerPreflightResult {
  const policy = normalizePolicy(request);
  try {
    const strategy = getStrategy(request.strategyKey);
    if (!strategy) {
      throw new BacktestRunnerPreflightError(
        "STRATEGY_NOT_REGISTERED",
        request.strategyKey,
        policy.mode,
        {},
        `策略「${request.strategyKey}」未註冊`,
      );
    }
    assertRequestedCapabilities(request, policy);

    if (policy.mode === "SINGLE_EXCLUSIVE") {
      const descriptor = getStrategyRunnerDescriptor(request.strategyKey);
      return {
        executionPolicy: policy,
        resolvedPortfolioAdapter: null,
        runner: descriptor
          ? {
              runnerId: descriptor.adapterId,
              runnerVersion: descriptor.adapterVersion,
              descriptorVersion: descriptor.contractVersion,
              strategyVersion: descriptor.strategyVersion,
              logicRevision: descriptor.logicRevision,
              executionPath: "S1_STRATEGY_ENGINE",
            }
          : {
              runnerId: `strategy-instance:${request.strategyKey}`,
              runnerVersion: 1,
              descriptorVersion: "s1-compatible-unregistered-descriptor",
              strategyVersion: request.strategyVersion?.trim() || "unversioned",
              logicRevision: request.strategyLogicHash?.trim() || "unhashed",
              executionPath: "S1_STRATEGY_ENGINE",
            },
      };
    }

    ensureBuiltInPortfolioRuntimeFactoriesRegistered();
    const resolvedPortfolioAdapter = resolvePortfolioStrategyAdapter(request.strategyKey, policy.mode);
    assertExecutablePortfolioStrategyAdapter(resolvedPortfolioAdapter, policy.mode);
    return {
      executionPolicy: policy,
      resolvedPortfolioAdapter,
      runner: {
        runnerId: resolvedPortfolioAdapter.adapter.adapterId,
        runnerVersion: resolvedPortfolioAdapter.adapter.adapterVersion,
        descriptorVersion: resolvedPortfolioAdapter.descriptor.contractVersion,
        strategyVersion: resolvedPortfolioAdapter.descriptor.strategyVersion,
        logicRevision: resolvedPortfolioAdapter.descriptor.logicRevision,
        executionPath: "PORTFOLIO_RUNTIME_ADAPTER",
      },
    };
  } catch (error) {
    return wrapResolutionError(error, request, policy);
  }
}

export function classifyBacktestFailure(error: unknown): BacktestFailureMetadata {
  if (error instanceof BacktestRunnerPreflightError) {
    return { stage: "RUNNER_PREFLIGHT", errorCode: error.code, details: error.details };
  }
  if (error instanceof PortfolioAdapterResolutionError) {
    return { stage: "RUNNER_PREFLIGHT", errorCode: error.code, details: error.details };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/歷史數據|K 線|candle|data|fetch|network|econnreset/i.test(message)) {
    return { stage: "DATA_LOAD", errorCode: "BACKTEST_DATA_LOAD_FAILED" };
  }
  return { stage: "EXECUTION", errorCode: "BACKTEST_EXECUTION_FAILED" };
}
