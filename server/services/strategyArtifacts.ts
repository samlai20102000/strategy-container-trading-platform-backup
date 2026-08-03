import {
  EXECUTION_POLICY_VERSION,
  createDefaultExecutionPolicy,
  getSupportedModeCapabilities,
  isExecutionMode,
  normalizeExecutionModePolicy,
  type ExecutionMode,
  type ExecutionPolicy,
  type StrategyModeCapabilities,
} from "../../shared/executionModes";
import { buildBacktestHash } from "./backtest/backtestContracts";

export const STRATEGY_ARTIFACT_CONTRACT_VERSION = "strategy-artifact-v1" as const;
export const STRATEGY_CAPABILITY_MANIFEST_VERSION = "strategy-capability-manifest-v1" as const;

export const STRATEGY_ARTIFACT_SCOPES = ["PARAMETERS_ONLY", "EXECUTION_PROFILE"] as const;
export type StrategyArtifactScope = (typeof STRATEGY_ARTIFACT_SCOPES)[number];
export type StrategyCapabilityCertification = "CERTIFIED" | "S1_ONLY" | "REVOKED";

export interface VersionedStrategyCapabilityManifest {
  contractVersion: typeof STRATEGY_CAPABILITY_MANIFEST_VERSION;
  strategyKey: string;
  strategyVersion: number;
  strategyLogicHash: string;
  certification: StrategyCapabilityCertification;
  capabilities: StrategyModeCapabilities;
  manifestHash: string;
}

export interface StrategyArtifactSource {
  origin: "BACKTEST_RUN" | "PARAMETER_SNAPSHOT" | "COPY" | "IMPORT" | "MANUAL" | "LEGACY_MIGRATION";
  sourceRunId?: string;
  sourceSnapshotId?: number;
  parentArtifactHash?: string;
  comparisonGroupId?: string;
}

export interface StrategyArtifactEnvelope {
  contractVersion: typeof STRATEGY_ARTIFACT_CONTRACT_VERSION;
  artifactScope: StrategyArtifactScope;
  strategyKey: string;
  strategyVersion: number;
  strategyLogicHash: string;
  configHash: string;
  executionMode: ExecutionMode;
  executionPolicy: ExecutionPolicy;
  executionPolicyVersion: typeof EXECUTION_POLICY_VERSION;
  executionPolicyHash: string;
  capabilityManifest: VersionedStrategyCapabilityManifest;
  source: StrategyArtifactSource;
  artifactHash: string;
}

export interface DisabledSnapshotDeploymentFields {
  enabled: false;
  activationState: "LEGACY";
  disabledReason: string;
  strategyVersion: number;
  executionMode: ExecutionMode;
  executionPolicy: ExecutionPolicy;
  executionPolicyVersion: typeof EXECUTION_POLICY_VERSION;
  capabilitySnapshot: VersionedStrategyCapabilityManifest;
}

/**
 * 從快照建立一般策略實例的安全投影。實例一律預設停用，
 * 但維持 LEGACY 卡片控制契約，可在人工核對參數、API 與風控後直接啟用。
 * Canonical deployment 仍由 deployments 專用生命週期與 preflight 管理。
 */
export function buildDisabledSnapshotDeploymentFields(
  artifact: StrategyArtifactEnvelope,
  reason = "快照導入後預設停用；請確認參數、API 與風控設定後，由策略卡片直接啟用",
): DisabledSnapshotDeploymentFields {
  return {
    enabled: false,
    activationState: "LEGACY",
    disabledReason: reason,
    strategyVersion: artifact.strategyVersion,
    executionMode: artifact.executionMode,
    executionPolicy: artifact.executionPolicy,
    executionPolicyVersion: artifact.executionPolicyVersion,
    capabilitySnapshot: artifact.capabilityManifest,
  };
}

export interface StrategyArtifactCompatibilityDiff {
  field: string;
  artifactValue: unknown;
  targetValue: unknown;
  severity: "BLOCKER" | "WARNING" | "MATCH";
  code: string;
}

export interface StrategyArtifactCompatibilityReport {
  compatible: boolean;
  blockers: string[];
  warnings: string[];
  diffs: StrategyArtifactCompatibilityDiff[];
  artifactHash: string;
  targetManifestHash: string;
}

export interface HydratedStrategyArtifact {
  artifact: StrategyArtifactEnvelope;
  migratedLegacy: boolean;
  integrityValid: boolean;
  persistedArtifactHash?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInteger(value: unknown, fallback = 1): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeCertification(value: unknown): StrategyCapabilityCertification {
  return value === "CERTIFIED" || value === "REVOKED" || value === "S1_ONLY"
    ? value
    : "S1_ONLY";
}

function s1OnlyCapabilities(input?: Partial<StrategyModeCapabilities>): StrategyModeCapabilities {
  return getSupportedModeCapabilities({
    supportedModes: ["SINGLE_EXCLUSIVE"],
    martingaleLayers: input?.martingaleLayers === true,
    independentLegState: false,
    hedgeGuard: false,
    preciseLegClose: false,
    reason: input?.reason ?? "尚未完成進階模式認證，僅允許 S1",
  });
}

function assertCertifiedCapabilities(capabilities: StrategyModeCapabilities): void {
  const supportsM2 = capabilities.supportedModes.includes("MULTI_POSITION");
  const supportsH3 = capabilities.supportedModes.includes("HEDGE_GUARDED");
  if ((supportsM2 || supportsH3) && (!capabilities.independentLegState || !capabilities.preciseLegClose)) {
    throw new Error("進階模式 capability manifest 必須同時認證 independentLegState 與 preciseLegClose");
  }
  if (supportsH3 && !capabilities.hedgeGuard) {
    throw new Error("H3 capability manifest 必須認證 hedgeGuard");
  }
}

export function buildStrategyLogicHash(input: {
  strategyKey: string;
  strategyVersion: number;
  logicSource: unknown;
}): string {
  return buildBacktestHash({
    strategyKey: input.strategyKey,
    strategyVersion: positiveInteger(input.strategyVersion),
    logicSource: input.logicSource,
  });
}

export function buildExecutionPolicyHash(policy: ExecutionPolicy | Record<string, unknown>): string {
  return buildBacktestHash(normalizeExecutionModePolicy(policy));
}

export function createVersionedCapabilityManifest(input: {
  strategyKey: string;
  strategyVersion: number;
  strategyLogicHash: string;
  certification?: StrategyCapabilityCertification;
  capabilities?: Partial<StrategyModeCapabilities>;
}): VersionedStrategyCapabilityManifest {
  const certification = input.certification ?? "S1_ONLY";
  const requested = getSupportedModeCapabilities(input.capabilities);
  const capabilities = certification === "CERTIFIED" ? requested : s1OnlyCapabilities(requested);
  if (certification === "CERTIFIED") assertCertifiedCapabilities(capabilities);

  const core = {
    contractVersion: STRATEGY_CAPABILITY_MANIFEST_VERSION,
    strategyKey: nonEmptyString(input.strategyKey, "UNKNOWN_STRATEGY"),
    strategyVersion: positiveInteger(input.strategyVersion),
    strategyLogicHash: nonEmptyString(input.strategyLogicHash, "UNKNOWN_LOGIC_HASH"),
    certification,
    capabilities,
  } as const;
  return {
    ...core,
    manifestHash: buildBacktestHash(core),
  };
}

export function normalizeVersionedCapabilityManifest(
  value: unknown,
  fallback: Omit<VersionedStrategyCapabilityManifest, "manifestHash"> | VersionedStrategyCapabilityManifest,
): VersionedStrategyCapabilityManifest {
  const raw = asRecord(value);
  const rawCapabilities = asRecord(raw.capabilities) as Partial<StrategyModeCapabilities>;
  const candidate = createVersionedCapabilityManifest({
    strategyKey: nonEmptyString(raw.strategyKey, fallback.strategyKey),
    strategyVersion: positiveInteger(raw.strategyVersion, fallback.strategyVersion),
    strategyLogicHash: nonEmptyString(raw.strategyLogicHash, fallback.strategyLogicHash),
    certification: normalizeCertification(raw.certification ?? fallback.certification),
    capabilities: Object.keys(rawCapabilities).length > 0 ? rawCapabilities : fallback.capabilities,
  });
  if (typeof raw.manifestHash === "string" && raw.manifestHash !== candidate.manifestHash) {
    return createVersionedCapabilityManifest({
      strategyKey: candidate.strategyKey,
      strategyVersion: candidate.strategyVersion,
      strategyLogicHash: candidate.strategyLogicHash,
      certification: "REVOKED",
      capabilities: {
        ...candidate.capabilities,
        reason: "CAPABILITY_MANIFEST_HASH_MISMATCH",
      },
    });
  }
  return candidate;
}

export function capabilityManifestSupportsMode(
  manifest: VersionedStrategyCapabilityManifest,
  mode: ExecutionMode,
): boolean {
  if (manifest.certification === "REVOKED") return false;
  if (!manifest.capabilities.supportedModes.includes(mode)) return false;
  if (mode === "SINGLE_EXCLUSIVE") return true;
  if (!manifest.capabilities.independentLegState || !manifest.capabilities.preciseLegClose) return false;
  return mode !== "HEDGE_GUARDED" || manifest.capabilities.hedgeGuard;
}

function normalizeArtifactSource(value: unknown): StrategyArtifactSource {
  const raw = asRecord(value);
  const allowedOrigins: StrategyArtifactSource["origin"][] = [
    "BACKTEST_RUN",
    "PARAMETER_SNAPSHOT",
    "COPY",
    "IMPORT",
    "MANUAL",
    "LEGACY_MIGRATION",
  ];
  const origin = allowedOrigins.includes(raw.origin as StrategyArtifactSource["origin"])
    ? (raw.origin as StrategyArtifactSource["origin"])
    : "MANUAL";
  return {
    origin,
    ...(typeof raw.sourceRunId === "string" ? { sourceRunId: raw.sourceRunId } : {}),
    ...(Number.isInteger(raw.sourceSnapshotId) ? { sourceSnapshotId: Number(raw.sourceSnapshotId) } : {}),
    ...(typeof raw.parentArtifactHash === "string" ? { parentArtifactHash: raw.parentArtifactHash } : {}),
    ...(typeof raw.comparisonGroupId === "string" ? { comparisonGroupId: raw.comparisonGroupId } : {}),
  };
}

function artifactHashCore(artifact: Omit<StrategyArtifactEnvelope, "artifactHash">): string {
  return buildBacktestHash({
    contractVersion: artifact.contractVersion,
    artifactScope: artifact.artifactScope,
    strategyKey: artifact.strategyKey,
    strategyVersion: artifact.strategyVersion,
    strategyLogicHash: artifact.strategyLogicHash,
    configHash: artifact.configHash,
    executionMode: artifact.executionMode,
    executionPolicyVersion: artifact.executionPolicyVersion,
    executionPolicyHash: artifact.executionPolicyHash,
    capabilityManifestHash: artifact.capabilityManifest.manifestHash,
    source: artifact.source,
  });
}

export function buildStrategyArtifactEnvelope(input: {
  artifactScope: StrategyArtifactScope;
  strategyKey: string;
  strategyVersion: number;
  strategyLogicHash: string;
  config: Record<string, unknown>;
  executionMode?: ExecutionMode;
  executionPolicy?: ExecutionPolicy | Record<string, unknown>;
  capabilityManifest: VersionedStrategyCapabilityManifest;
  source?: StrategyArtifactSource;
}): StrategyArtifactEnvelope {
  const requestedPolicy = normalizeExecutionModePolicy(
    input.executionPolicy ?? createDefaultExecutionPolicy(input.executionMode ?? "SINGLE_EXCLUSIVE"),
  );
  if (input.executionMode && requestedPolicy.mode !== input.executionMode) {
    throw new Error("artifact executionMode 與 executionPolicy.mode 不一致");
  }
  const policy = input.artifactScope === "EXECUTION_PROFILE"
    ? requestedPolicy
    : createDefaultExecutionPolicy("SINGLE_EXCLUSIVE");
  if (
    input.artifactScope === "EXECUTION_PROFILE"
    && !capabilityManifestSupportsMode(input.capabilityManifest, policy.mode)
  ) {
    throw new Error(`策略 capability manifest 未認證 ${policy.mode}`);
  }

  const core: Omit<StrategyArtifactEnvelope, "artifactHash"> = {
    contractVersion: STRATEGY_ARTIFACT_CONTRACT_VERSION,
    artifactScope: input.artifactScope,
    strategyKey: input.strategyKey,
    strategyVersion: positiveInteger(input.strategyVersion),
    strategyLogicHash: input.strategyLogicHash,
    configHash: buildBacktestHash(input.config),
    executionMode: policy.mode,
    executionPolicy: policy,
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    executionPolicyHash: buildExecutionPolicyHash(policy),
    capabilityManifest: input.capabilityManifest,
    source: normalizeArtifactSource(input.source ?? { origin: "MANUAL" }),
  };
  return { ...core, artifactHash: artifactHashCore(core) };
}

export function hydrateStrategyArtifactFromSnapshotRow(
  row: Record<string, unknown>,
  currentManifest: VersionedStrategyCapabilityManifest,
): HydratedStrategyArtifact {
  const migratedLegacy = row.artifactContractVersion !== STRATEGY_ARTIFACT_CONTRACT_VERSION;
  const artifactScope = row.artifactScope === "EXECUTION_PROFILE"
    ? "EXECUTION_PROFILE"
    : "PARAMETERS_ONLY";
  const manifest = migratedLegacy
    ? currentManifest
    : normalizeVersionedCapabilityManifest(row.capabilityManifest, currentManifest);
  const mode = isExecutionMode(row.executionMode) ? row.executionMode : "SINGLE_EXCLUSIVE";
  const source = migratedLegacy
    ? { origin: "LEGACY_MIGRATION" as const, sourceSnapshotId: positiveInteger(row.id, 1) }
    : normalizeArtifactSource(row.artifactSource);
  const artifact = buildStrategyArtifactEnvelope({
    artifactScope: migratedLegacy ? "PARAMETERS_ONLY" : artifactScope,
    strategyKey: nonEmptyString(row.strategyKey, currentManifest.strategyKey),
    strategyVersion: migratedLegacy
      ? currentManifest.strategyVersion
      : positiveInteger(row.strategyVersion, currentManifest.strategyVersion),
    strategyLogicHash: migratedLegacy
      ? currentManifest.strategyLogicHash
      : nonEmptyString(row.strategyLogicHash, currentManifest.strategyLogicHash),
    config: asRecord(row.config),
    executionMode: migratedLegacy ? "SINGLE_EXCLUSIVE" : mode,
    executionPolicy: migratedLegacy
      ? createDefaultExecutionPolicy("SINGLE_EXCLUSIVE")
      : asRecord(row.executionPolicy),
    capabilityManifest: manifest,
    source,
  });
  const persistedArtifactHash = typeof row.artifactHash === "string" ? row.artifactHash : undefined;
  return {
    artifact,
    migratedLegacy,
    integrityValid: persistedArtifactHash === undefined || persistedArtifactHash === artifact.artifactHash,
    persistedArtifactHash,
  };
}

export function assessStrategyArtifactCompatibility(input: {
  artifact: StrategyArtifactEnvelope;
  targetManifest: VersionedStrategyCapabilityManifest;
  integrityValid?: boolean;
}): StrategyArtifactCompatibilityReport {
  const { artifact, targetManifest } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const diffs: StrategyArtifactCompatibilityDiff[] = [];
  const compare = (
    field: string,
    artifactValue: unknown,
    targetValue: unknown,
    code: string,
    blocker = true,
  ) => {
    const match = artifactValue === targetValue;
    diffs.push({
      field,
      artifactValue,
      targetValue,
      severity: match ? "MATCH" : blocker ? "BLOCKER" : "WARNING",
      code: match ? `${code}_MATCH` : code,
    });
    if (!match) (blocker ? blockers : warnings).push(code);
  };

  if (input.integrityValid === false) blockers.push("ARTIFACT_HASH_MISMATCH");
  compare("strategyKey", artifact.strategyKey, targetManifest.strategyKey, "STRATEGY_KEY_MISMATCH");
  compare("strategyVersion", artifact.strategyVersion, targetManifest.strategyVersion, "STRATEGY_VERSION_MISMATCH");
  compare("strategyLogicHash", artifact.strategyLogicHash, targetManifest.strategyLogicHash, "STRATEGY_LOGIC_HASH_MISMATCH");
  compare(
    "capabilityManifest.manifestHash",
    artifact.capabilityManifest.manifestHash,
    targetManifest.manifestHash,
    "STALE_CAPABILITY_MANIFEST",
  );

  if (targetManifest.certification === "REVOKED") blockers.push("TARGET_CAPABILITY_REVOKED");
  if (
    artifact.artifactScope === "EXECUTION_PROFILE"
    && !capabilityManifestSupportsMode(targetManifest, artifact.executionMode)
  ) {
    blockers.push("EXECUTION_MODE_NOT_CERTIFIED");
  }
  if (artifact.artifactScope === "PARAMETERS_ONLY") {
    warnings.push("PARAMETERS_ONLY_NO_EXECUTION_PROFILE");
  }

  return {
    compatible: blockers.length === 0,
    blockers: Array.from(new Set(blockers)),
    warnings: Array.from(new Set(warnings)),
    diffs,
    artifactHash: artifact.artifactHash,
    targetManifestHash: targetManifest.manifestHash,
  };
}

export function assertStrategyArtifactCompatible(report: StrategyArtifactCompatibilityReport): void {
  if (!report.compatible) {
    throw new Error(`策略 artifact 不相容：${report.blockers.join(", ")}`);
  }
}
