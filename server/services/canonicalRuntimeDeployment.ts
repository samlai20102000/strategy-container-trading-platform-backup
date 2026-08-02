import type { Strategy } from "../../drizzle/schema";
import {
  EXECUTION_POLICY_VERSION,
  createDefaultExecutionPolicy,
  type ExecutionMode,
  type ExecutionPolicy,
} from "../../shared/executionModes";
import { normalizeStrategyExecutionPolicy } from "../../shared/strategies/kamaRainbowMartinExecutionPolicy";
import { getStrategyById } from "../db";
import { buildBacktestHash } from "./backtest/backtestContracts";
import { requireStrategyCapabilityManifest } from "./strategyCapabilityRegistry";
import {
  assessStrategyArtifactCompatibility,
  buildExecutionPolicyHash,
  buildStrategyArtifactEnvelope,
  type StrategyArtifactEnvelope,
  type VersionedStrategyCapabilityManifest,
} from "./strategyArtifacts";
import {
  getBoundStrategyArtifact,
  getBoundStrategyConfig,
  replaceBoundStrategyArtifact,
} from "./strategySnapshotConfig";

export const CANONICAL_RUNTIME_ERROR_CODES = [
  "RUNTIME_DEPLOYMENT_NOT_FOUND",
  "RUNTIME_STRATEGY_KEY_MISSING",
  "RUNTIME_ARTIFACT_MISSING",
  "RUNTIME_ARTIFACT_SCOPE_INVALID",
  "RUNTIME_ARTIFACT_INCOMPATIBLE",
  "RUNTIME_ARTIFACT_HASH_MISMATCH",
  "RUNTIME_CONFIG_HASH_MISMATCH",
  "RUNTIME_EXECUTION_MODE_MISMATCH",
  "RUNTIME_EXECUTION_POLICY_MISMATCH",
  "RUNTIME_EXECUTION_POLICY_VERSION_MISMATCH",
  "RUNTIME_STRATEGY_VERSION_MISMATCH",
  "RUNTIME_CAPABILITY_SNAPSHOT_MISMATCH",
] as const;

export type CanonicalRuntimeErrorCode = (typeof CANONICAL_RUNTIME_ERROR_CODES)[number];

export class CanonicalRuntimeDeploymentError extends Error {
  constructor(
    public readonly code: CanonicalRuntimeErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "CanonicalRuntimeDeploymentError";
  }
}

export interface CanonicalRuntimeDeployment {
  strategy: Strategy;
  artifact: StrategyArtifactEnvelope;
  manifest: VersionedStrategyCapabilityManifest;
  executionMode: ExecutionMode;
  executionPolicy: ExecutionPolicy;
  provenance:
    | "SEALED_EXECUTION_PROFILE"
    | "LEGACY_S1_MEMORY_MIGRATION"
    | "REDUCE_ONLY_DRIFT_COMPATIBILITY";
  compatibilityWarnings?: string[];
}

const REDUCE_ONLY_COMPATIBLE_ARTIFACT_BLOCKERS = new Set([
  "STRATEGY_VERSION_MISMATCH",
  "STRATEGY_LOGIC_HASH_MISMATCH",
  "STALE_CAPABILITY_MANIFEST",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function manifestHash(value: unknown): string | undefined {
  const hash = asRecord(value).manifestHash;
  return typeof hash === "string" && hash.length > 0 ? hash : undefined;
}

function runtimeError(code: CanonicalRuntimeErrorCode, detail?: string): never {
  throw new CanonicalRuntimeDeploymentError(code, detail);
}

function legacyS1Migration(
  strategy: Strategy,
  strategyKey: string,
  manifest: VersionedStrategyCapabilityManifest,
): CanonicalRuntimeDeployment {
  const config = getBoundStrategyConfig(strategy.martinState, strategyKey) ?? {};
  const executionPolicy = normalizeStrategyExecutionPolicy(
    strategyKey,
    createDefaultExecutionPolicy("SINGLE_EXCLUSIVE"),
  );
  const artifact = buildStrategyArtifactEnvelope({
    artifactScope: "EXECUTION_PROFILE",
    strategyKey,
    strategyVersion: manifest.strategyVersion,
    strategyLogicHash: manifest.strategyLogicHash,
    config,
    executionMode: "SINGLE_EXCLUSIVE",
    executionPolicy,
    capabilityManifest: manifest,
    source: { origin: "LEGACY_MIGRATION" },
  });
  const martinState = replaceBoundStrategyArtifact(
    asRecord(strategy.martinState),
    strategyKey,
    artifact,
  );
  return {
    strategy: {
      ...strategy,
      martinState,
      executionMode: "SINGLE_EXCLUSIVE",
      executionPolicy,
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      strategyVersion: manifest.strategyVersion,
      capabilitySnapshot: manifest,
    },
    artifact,
    manifest,
    executionMode: "SINGLE_EXCLUSIVE",
    executionPolicy,
    provenance: "LEGACY_S1_MEMORY_MIGRATION",
  };
}

async function hydrateCanonicalRuntimeDeploymentInternal(
  strategy: Strategy,
  options: { allowReduceOnlyVersionDrift?: boolean } = {},
): Promise<CanonicalRuntimeDeployment> {
  const strategyKey = strategy.strategyKey?.trim();
  if (!strategyKey) runtimeError("RUNTIME_STRATEGY_KEY_MISSING");
  const manifest = await requireStrategyCapabilityManifest(strategyKey);
  const artifact = getBoundStrategyArtifact(strategy.martinState, strategyKey);

  if (!artifact && strategy.activationState === "LEGACY") {
    return legacyS1Migration(strategy, strategyKey, manifest);
  }
  if (!artifact) runtimeError("RUNTIME_ARTIFACT_MISSING");
  if (artifact.artifactScope !== "EXECUTION_PROFILE") {
    runtimeError("RUNTIME_ARTIFACT_SCOPE_INVALID", artifact.artifactScope);
  }

  const config = getBoundStrategyConfig(strategy.martinState, strategyKey);
  if (!config || buildBacktestHash(config) !== artifact.configHash) {
    runtimeError("RUNTIME_CONFIG_HASH_MISMATCH");
  }

  let rebuilt: StrategyArtifactEnvelope;
  try {
    rebuilt = buildStrategyArtifactEnvelope({
      artifactScope: "EXECUTION_PROFILE",
      strategyKey: artifact.strategyKey,
      strategyVersion: artifact.strategyVersion,
      strategyLogicHash: artifact.strategyLogicHash,
      config,
      executionMode: artifact.executionMode,
      executionPolicy: artifact.executionPolicy,
      capabilityManifest: artifact.capabilityManifest,
      source: artifact.source,
    });
  } catch (error) {
    runtimeError(
      "RUNTIME_ARTIFACT_INCOMPATIBLE",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (rebuilt.artifactHash !== artifact.artifactHash) {
    runtimeError("RUNTIME_ARTIFACT_HASH_MISMATCH");
  }

  const compatibility = assessStrategyArtifactCompatibility({
    artifact,
    targetManifest: manifest,
    integrityValid: true,
  });
  const compatibilityWarnings: string[] = [];
  if (!compatibility.compatible) {
    const reduceOnlyCompatible = options.allowReduceOnlyVersionDrift === true
      && compatibility.blockers.length > 0
      && compatibility.blockers.every(blocker => REDUCE_ONLY_COMPATIBLE_ARTIFACT_BLOCKERS.has(blocker));
    if (!reduceOnlyCompatible) {
      runtimeError("RUNTIME_ARTIFACT_INCOMPATIBLE", compatibility.blockers.join(","));
    }
    compatibilityWarnings.push(...compatibility.blockers);
  }

  const rowMode = strategy.executionMode as ExecutionMode;
  if (rowMode !== artifact.executionMode) {
    runtimeError("RUNTIME_EXECUTION_MODE_MISMATCH", `${rowMode}:${artifact.executionMode}`);
  }
  const rowPolicy = normalizeStrategyExecutionPolicy(
    strategyKey,
    strategy.executionPolicy ?? { mode: rowMode },
  );
  if (buildExecutionPolicyHash(rowPolicy) !== artifact.executionPolicyHash) {
    runtimeError("RUNTIME_EXECUTION_POLICY_MISMATCH");
  }
  if (strategy.executionPolicyVersion !== EXECUTION_POLICY_VERSION) {
    runtimeError("RUNTIME_EXECUTION_POLICY_VERSION_MISMATCH");
  }
  if (strategy.strategyVersion !== artifact.strategyVersion) {
    runtimeError("RUNTIME_STRATEGY_VERSION_MISMATCH");
  }
  const rowManifestHash = manifestHash(strategy.capabilitySnapshot);
  if (
    !rowManifestHash
    || rowManifestHash !== artifact.capabilityManifest.manifestHash
    || rowManifestHash !== manifest.manifestHash
  ) {
    if (options.allowReduceOnlyVersionDrift !== true) {
      runtimeError("RUNTIME_CAPABILITY_SNAPSHOT_MISMATCH");
    }
    compatibilityWarnings.push("RUNTIME_CAPABILITY_SNAPSHOT_MISMATCH");
  }

  return {
    strategy: {
      ...strategy,
      executionMode: artifact.executionMode,
      executionPolicy: artifact.executionPolicy,
      executionPolicyVersion: artifact.executionPolicyVersion,
      strategyVersion: artifact.strategyVersion,
      capabilitySnapshot: artifact.capabilityManifest,
    },
    artifact,
    manifest,
    executionMode: artifact.executionMode,
    executionPolicy: artifact.executionPolicy,
    provenance: compatibilityWarnings.length > 0
      ? "REDUCE_ONLY_DRIFT_COMPATIBILITY"
      : "SEALED_EXECUTION_PROFILE",
    compatibilityWarnings: Array.from(new Set(compatibilityWarnings)),
  };
}

export async function hydrateCanonicalRuntimeDeployment(
  strategy: Strategy,
): Promise<CanonicalRuntimeDeployment> {
  return hydrateCanonicalRuntimeDeploymentInternal(strategy);
}

/**
 * 僅供明確 reduce-only／close 操作使用。完整性、config、key、mode、policy、
 * capability revoke 等安全條件仍維持 fail-closed；只容許程式升版造成的 manifest 漂移退出既有風險。
 */
export async function hydrateCanonicalRuntimeDeploymentForReduceOnlyExit(
  strategy: Strategy,
): Promise<CanonicalRuntimeDeployment> {
  return hydrateCanonicalRuntimeDeploymentInternal(strategy, { allowReduceOnlyVersionDrift: true });
}

export async function loadCanonicalRuntimeDeployment(
  deploymentId: number,
  userId?: number,
): Promise<CanonicalRuntimeDeployment> {
  const strategy = await getStrategyById(deploymentId, userId);
  if (!strategy) runtimeError("RUNTIME_DEPLOYMENT_NOT_FOUND", String(deploymentId));
  if (userId !== undefined && strategy.userId !== userId) {
    runtimeError("RUNTIME_DEPLOYMENT_NOT_FOUND", String(deploymentId));
  }
  return hydrateCanonicalRuntimeDeployment(strategy);
}

export async function loadCanonicalRuntimeDeploymentForReduceOnlyExit(
  deploymentId: number,
  userId?: number,
): Promise<CanonicalRuntimeDeployment> {
  const strategy = await getStrategyById(deploymentId, userId);
  if (!strategy) runtimeError("RUNTIME_DEPLOYMENT_NOT_FOUND", String(deploymentId));
  if (userId !== undefined && strategy.userId !== userId) {
    runtimeError("RUNTIME_DEPLOYMENT_NOT_FOUND", String(deploymentId));
  }
  return hydrateCanonicalRuntimeDeploymentForReduceOnlyExit(strategy);
}
