import type { ExecutionMode, ExecutionPolicy } from "./executionModes";
import {
  createDefaultStrategyExecutionPolicy,
  normalizeStrategyExecutionPolicy,
} from "./strategies/kamaRainbowMartinExecutionPolicy";

/**
 * 跨回測、快照、策略與部署 UI 的編排契約。
 *
 * 此 profile 不是另一份交易真相：
 * - 策略邏輯／配置仍由 StrategyArtifactEnvelope 封印；
 * - API 金鑰只保存 owned record id，絕不包含 credential；
 * - 實盤狀態仍由 canonical deployment + revision + policy hash 決定。
 */
export const EXECUTION_PROFILE_CONTRACT_VERSION = "execution-profile-v1" as const;

export const EXECUTION_PROFILE_SOURCE_KINDS = [
  "STRATEGY_DEFINITION",
  "STRATEGY_INSTANCE",
  "PARAMETER_SNAPSHOT",
  "BACKTEST_RUN",
] as const;

export type ExecutionProfileSourceKind = (typeof EXECUTION_PROFILE_SOURCE_KINDS)[number];
export type ExecutionProfilePositionMode = "quantity" | "usdt";
export type ExecutionProfileTradeMode = "webhook" | "auto";

export interface ExecutionProfileSource {
  kind: ExecutionProfileSourceKind;
  sourceStrategyId?: number;
  sourceSnapshotId?: number;
  sourceBacktestRunId?: string;
  sourceLabel?: string;
}

export interface CanonicalExecutionProfile {
  contractVersion: typeof EXECUTION_PROFILE_CONTRACT_VERSION;
  source: ExecutionProfileSource;
  strategy: {
    key: string;
    version: number;
    logicHash?: string;
    config: Record<string, unknown>;
  };
  market: {
    exchange?: string;
    symbol: string;
    timeframe: string;
  };
  account: {
    apiKeyId?: number;
  };
  execution: {
    mode: ExecutionMode;
    policy: ExecutionPolicy;
  };
  deployment: {
    name: string;
    positionSize: number;
    positionMode: ExecutionProfilePositionMode;
    leverage: number;
    direction: "long" | "short" | "both";
    orderType: "market" | "limit";
    tradeMode: ExecutionProfileTradeMode;
  };
}

export interface CanonicalExecutionProfileInput {
  source: ExecutionProfileSource;
  strategyKey: string;
  strategyVersion?: number;
  strategyLogicHash?: string;
  strategyConfig?: Record<string, unknown>;
  exchange?: string;
  symbol: string;
  timeframe?: string;
  apiKeyId?: number;
  executionMode?: ExecutionMode;
  executionPolicy?: unknown;
  deploymentName?: string;
  positionSize?: number;
  positionMode?: ExecutionProfilePositionMode;
  leverage?: number;
  direction?: "long" | "short" | "both";
  orderType?: "market" | "limit";
  tradeMode?: ExecutionProfileTradeMode;
}

function requireText(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} 不可為空`);
  return normalized;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return structuredClone(value as Record<string, unknown>);
}

function normalizeSource(source: ExecutionProfileSource): ExecutionProfileSource {
  if (!EXECUTION_PROFILE_SOURCE_KINDS.includes(source.kind)) {
    throw new Error("execution profile source kind 無效");
  }
  const normalized: ExecutionProfileSource = {
    kind: source.kind,
    ...(source.sourceLabel?.trim() ? { sourceLabel: source.sourceLabel.trim() } : {}),
  };

  if (source.kind === "STRATEGY_INSTANCE") {
    normalized.sourceStrategyId = positiveInteger(source.sourceStrategyId, 0);
    if (!normalized.sourceStrategyId) throw new Error("STRATEGY_INSTANCE 缺少 sourceStrategyId");
  }
  if (source.kind === "PARAMETER_SNAPSHOT") {
    normalized.sourceSnapshotId = positiveInteger(source.sourceSnapshotId, 0);
    if (!normalized.sourceSnapshotId) throw new Error("PARAMETER_SNAPSHOT 缺少 sourceSnapshotId");
  }
  if (source.kind === "BACKTEST_RUN") {
    normalized.sourceBacktestRunId = requireText(source.sourceBacktestRunId, "sourceBacktestRunId");
  }
  return normalized;
}

export function createCanonicalExecutionProfile(
  input: CanonicalExecutionProfileInput,
): CanonicalExecutionProfile {
  const strategyKey = requireText(input.strategyKey, "strategyKey");
  const mode = input.executionMode ?? "SINGLE_EXCLUSIVE";
  const policy = input.executionPolicy === undefined
    ? createDefaultStrategyExecutionPolicy(strategyKey, mode)
    : normalizeStrategyExecutionPolicy(strategyKey, {
      ...(input.executionPolicy && typeof input.executionPolicy === "object"
        ? input.executionPolicy as Record<string, unknown>
        : {}),
      mode,
    });
  const symbol = requireText(input.symbol, "symbol").toUpperCase();

  return {
    contractVersion: EXECUTION_PROFILE_CONTRACT_VERSION,
    source: normalizeSource(input.source),
    strategy: {
      key: strategyKey,
      version: positiveInteger(input.strategyVersion, 1),
      ...(input.strategyLogicHash?.trim()
        ? { logicHash: input.strategyLogicHash.trim() }
        : {}),
      config: cloneRecord(input.strategyConfig),
    },
    market: {
      ...(input.exchange?.trim() ? { exchange: input.exchange.trim().toLowerCase() } : {}),
      symbol,
      timeframe: input.timeframe?.trim() || "15m",
    },
    account: {
      ...(positiveInteger(input.apiKeyId, 0) > 0
        ? { apiKeyId: positiveInteger(input.apiKeyId, 0) }
        : {}),
    },
    execution: { mode, policy },
    deployment: {
      name: input.deploymentName?.trim() || `${strategyKey} · ${symbol}`,
      positionSize: nonNegativeNumber(input.positionSize, 0),
      positionMode: input.positionMode === "quantity" ? "quantity" : "usdt",
      leverage: Math.min(125, positiveInteger(input.leverage, 1)),
      direction: input.direction ?? "both",
      orderType: input.orderType ?? "market",
      tradeMode: input.tradeMode ?? "webhook",
    },
  };
}

export function withExecutionProfileMode(
  profile: CanonicalExecutionProfile,
  mode: ExecutionMode,
  policy?: unknown,
): CanonicalExecutionProfile {
  return createCanonicalExecutionProfile({
    source: profile.source,
    strategyKey: profile.strategy.key,
    strategyVersion: profile.strategy.version,
    strategyLogicHash: profile.strategy.logicHash,
    strategyConfig: profile.strategy.config,
    exchange: profile.market.exchange,
    symbol: profile.market.symbol,
    timeframe: profile.market.timeframe,
    apiKeyId: profile.account.apiKeyId,
    executionMode: mode,
    executionPolicy: policy,
    deploymentName: profile.deployment.name,
    positionSize: profile.deployment.positionSize,
    positionMode: profile.deployment.positionMode,
    leverage: profile.deployment.leverage,
    direction: profile.deployment.direction,
    orderType: profile.deployment.orderType,
    tradeMode: profile.deployment.tradeMode,
  });
}

