import { and, eq } from "drizzle-orm";
import { parameterSnapshots } from "../../drizzle/schema";
import type { ExecutionMode, ExecutionPolicy } from "../../shared/executionModes";
import { getDb, getStrategyById } from "../db";
import { registryManager } from "./registryManager";
import {
  assessStrategyArtifactCompatibility,
  assertStrategyArtifactCompatible,
  hydrateStrategyArtifactFromSnapshotRow,
  type StrategyArtifactEnvelope,
  type StrategyArtifactSource,
  type VersionedStrategyCapabilityManifest,
} from "./strategyArtifacts";
import {
  getBoundStrategyArtifact,
  getBoundStrategyConfig,
  type SnapshotAttachMetadata,
} from "./strategySnapshotConfig";

export type DeploymentSourceSelection = {
  strategyKey: string;
  sourceStrategyId?: number;
  sourceSnapshotId?: number;
};

export interface ResolvedDeploymentSource {
  strategyKey: string;
  config: Record<string, unknown>;
  manifest: VersionedStrategyCapabilityManifest;
  suggestedMode?: ExecutionMode;
  suggestedPolicy?: ExecutionPolicy;
  artifactSource: StrategyArtifactSource;
  attachMetadata: Omit<SnapshotAttachMetadata, "artifact">;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value as Record<string, unknown>)
    : {};
}

function assertRequestedKey(requested: string, resolved: string): void {
  if (requested !== resolved) {
    throw new Error(`DEPLOYMENT_SOURCE_STRATEGY_MISMATCH:${requested}:${resolved}`);
  }
}

function assertCompatibleArtifact(
  artifact: StrategyArtifactEnvelope,
  manifest: VersionedStrategyCapabilityManifest,
  integrityValid = true,
): void {
  assertStrategyArtifactCompatible(assessStrategyArtifactCompatibility({
    artifact,
    targetManifest: manifest,
    integrityValid,
  }));
}

export async function resolveDeploymentSource(
  userId: number,
  selection: DeploymentSourceSelection,
): Promise<ResolvedDeploymentSource> {
  if (selection.sourceStrategyId && selection.sourceSnapshotId) {
    throw new Error("DEPLOYMENT_SOURCE_AMBIGUOUS");
  }

  if (selection.sourceSnapshotId) {
    const db = await getDb();
    if (!db) throw new Error("資料庫不可用");
    const [snapshot] = await db
      .select()
      .from(parameterSnapshots)
      .where(and(
        eq(parameterSnapshots.id, selection.sourceSnapshotId),
        eq(parameterSnapshots.userId, userId),
      ))
      .limit(1);
    if (!snapshot) throw new Error("DEPLOYMENT_SOURCE_SNAPSHOT_NOT_FOUND");
    assertRequestedKey(selection.strategyKey, snapshot.strategyKey);
    const definition = await registryManager.getStrategyDefinition(snapshot.strategyKey);
    if (!definition) throw new Error("DEPLOYMENT_SOURCE_STRATEGY_UNREGISTERED");
    const hydrated = hydrateStrategyArtifactFromSnapshotRow(
      snapshot as unknown as Record<string, unknown>,
      definition.capabilityManifest,
    );
    assertCompatibleArtifact(hydrated.artifact, definition.capabilityManifest, hydrated.integrityValid);
    const carriesExecution = hydrated.artifact.artifactScope === "EXECUTION_PROFILE";
    return {
      strategyKey: snapshot.strategyKey,
      config: asRecord(snapshot.config),
      manifest: definition.capabilityManifest,
      ...(carriesExecution ? {
        suggestedMode: hydrated.artifact.executionMode,
        suggestedPolicy: hydrated.artifact.executionPolicy,
      } : {}),
      artifactSource: {
        origin: "PARAMETER_SNAPSHOT",
        sourceSnapshotId: snapshot.id,
        parentArtifactHash: hydrated.artifact.artifactHash,
      },
      attachMetadata: {
        sourceKind: "PARAMETER_SNAPSHOT",
        snapshotId: snapshot.id,
        snapshotName: snapshot.snapshotName,
      },
    };
  }

  if (selection.sourceStrategyId) {
    const strategy = await getStrategyById(selection.sourceStrategyId, userId);
    if (!strategy?.strategyKey) throw new Error("DEPLOYMENT_SOURCE_STRATEGY_NOT_FOUND");
    assertRequestedKey(selection.strategyKey, strategy.strategyKey);
    const definition = await registryManager.getStrategyDefinition(strategy.strategyKey);
    if (!definition) throw new Error("DEPLOYMENT_SOURCE_STRATEGY_UNREGISTERED");
    const artifact = getBoundStrategyArtifact(strategy.martinState, strategy.strategyKey);
    if (artifact) assertCompatibleArtifact(artifact, definition.capabilityManifest);
    return {
      strategyKey: strategy.strategyKey,
      config: asRecord(
        getBoundStrategyConfig(strategy.martinState, strategy.strategyKey)
          ?? definition.defaultConfig,
      ),
      manifest: definition.capabilityManifest,
      ...(artifact?.artifactScope === "EXECUTION_PROFILE" ? {
        suggestedMode: artifact.executionMode,
        suggestedPolicy: artifact.executionPolicy,
      } : strategy.executionMode ? {
        suggestedMode: strategy.executionMode as ExecutionMode,
        suggestedPolicy: strategy.executionPolicy as ExecutionPolicy,
      } : {}),
      artifactSource: {
        origin: "IMPORT",
        ...(artifact ? { parentArtifactHash: artifact.artifactHash } : {}),
      },
      attachMetadata: {
        sourceKind: "STRATEGY_INSTANCE",
        sourceStrategyId: strategy.id,
        snapshotName: strategy.name,
      },
    };
  }

  const definition = await registryManager.getStrategyDefinition(selection.strategyKey);
  if (!definition) throw new Error("DEPLOYMENT_SOURCE_STRATEGY_UNREGISTERED");
  return {
    strategyKey: definition.key,
    config: asRecord(definition.defaultConfig),
    manifest: definition.capabilityManifest,
    artifactSource: { origin: "MANUAL" },
    attachMetadata: {
      sourceKind: "STRATEGY_DEFINITION",
      snapshotName: definition.name,
    },
  };
}

