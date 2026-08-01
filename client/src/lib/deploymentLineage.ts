export interface DeploymentLineageView {
  sourceKind: string;
  sourceStrategyId: string;
  sourceSnapshotId: string;
  snapshotName: string;
  importedAt: number | null;
  artifactOrigin: string;
  artifactContractVersion: string;
  artifactHash: string;
  parameterSetVersion: string;
  strategyVersion: string;
  executionPolicyVersion: string;
  migratedBy: string;
  migratedAt: number | null;
}

export interface DeploymentLineageSource {
  strategyVersion?: unknown;
  executionPolicyVersion?: unknown;
  martinState?: unknown;
}

function asRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asDisplayText(value: unknown): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function asTimestamp(value: unknown): number | null {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function buildDeploymentLineage(
  deployment: DeploymentLineageSource | null,
): DeploymentLineageView {
  const state = asRecordValue(deployment?.martinState);
  const metadata = asRecordValue(state.__snapshotMeta);
  const artifact = asRecordValue(state.__strategyArtifact);
  const artifactSource = asRecordValue(artifact.source);
  const sourceSnapshotId = artifactSource.sourceSnapshotId ?? metadata.snapshotId;
  const artifactHash = asDisplayText(artifact.artifactHash);
  const hashVersion = artifactHash === "—" ? "unsealed" : artifactHash.slice(0, 12);
  const parameterSetVersion = sourceSnapshotId === null || sourceSnapshotId === undefined
    ? `artifact@${hashVersion}`
    : `snapshot-${String(sourceSnapshotId)}@${hashVersion}`;
  const artifactOrigin = asDisplayText(artifactSource.origin);
  const migrated = artifactOrigin === "LEGACY_MIGRATION";
  const importedAt = asTimestamp(metadata.importedAt);

  return {
    sourceKind: asDisplayText(metadata.sourceKind),
    sourceStrategyId: asDisplayText(metadata.sourceStrategyId),
    sourceSnapshotId: asDisplayText(sourceSnapshotId),
    snapshotName: asDisplayText(metadata.snapshotName),
    importedAt,
    artifactOrigin,
    artifactContractVersion: asDisplayText(artifact.contractVersion),
    artifactHash,
    parameterSetVersion,
    strategyVersion: asDisplayText(artifact.strategyVersion ?? deployment?.strategyVersion),
    executionPolicyVersion: asDisplayText(artifact.executionPolicyVersion ?? deployment?.executionPolicyVersion),
    migratedBy: migrated ? "system · canonical legacy S1 migration" : "—（非 legacy migration）",
    migratedAt: migrated ? importedAt : null,
  };
}
