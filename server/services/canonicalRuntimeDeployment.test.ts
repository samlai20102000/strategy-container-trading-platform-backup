import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Strategy } from "../../drizzle/schema";
import { createDefaultExecutionPolicy } from "../../shared/executionModes";
import {
  buildStrategyArtifactEnvelope,
  buildStrategyLogicHash,
  createVersionedCapabilityManifest,
  type VersionedStrategyCapabilityManifest,
} from "./strategyArtifacts";
import { attachSnapshotConfig, getBoundStrategyArtifact } from "./strategySnapshotConfig";

const mocks = vi.hoisted(() => ({
  getStrategyById: vi.fn(),
  requireStrategyCapabilityManifest: vi.fn(),
}));

vi.mock("../db", () => ({
  getStrategyById: mocks.getStrategyById,
}));

vi.mock("./strategyCapabilityRegistry", () => ({
  requireStrategyCapabilityManifest: mocks.requireStrategyCapabilityManifest,
}));

import {
  CanonicalRuntimeDeploymentError,
  hydrateCanonicalRuntimeDeployment,
  hydrateCanonicalRuntimeDeploymentForReduceOnlyExit,
  loadCanonicalRuntimeDeployment,
} from "./canonicalRuntimeDeployment";

function certifiedManifest(
  strategyKey = "TEST_RUNTIME_ADVANCED",
  strategyVersion = 1,
): VersionedStrategyCapabilityManifest {
  const strategyLogicHash = buildStrategyLogicHash({
    strategyKey,
    strategyVersion,
    logicSource: `runtime-${strategyKey}-v${strategyVersion}`,
  });
  return createVersionedCapabilityManifest({
    strategyKey,
    strategyVersion,
    strategyLogicHash,
    certification: "CERTIFIED",
    capabilities: {
      supportedModes: ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"],
      martingaleLayers: true,
      independentLegState: true,
      hedgeGuard: true,
      preciseLegClose: true,
      reason: "canonical-runtime-test",
    },
  });
}

function s1ManifestFrom(
  source: VersionedStrategyCapabilityManifest,
): VersionedStrategyCapabilityManifest {
  return createVersionedCapabilityManifest({
    strategyKey: source.strategyKey,
    strategyVersion: source.strategyVersion,
    strategyLogicHash: source.strategyLogicHash,
    certification: "CERTIFIED",
    capabilities: {
      supportedModes: ["SINGLE_EXCLUSIVE"],
      martingaleLayers: true,
      independentLegState: false,
      hedgeGuard: false,
      preciseLegClose: false,
      reason: "方案 B：KRM S1-only",
    },
  });
}

function canonicalStrategy(input: {
  manifest?: VersionedStrategyCapabilityManifest;
  mode?: "SINGLE_EXCLUSIVE" | "MULTI_POSITION" | "HEDGE_GUARDED";
  activationState?: Strategy["activationState"];
  includeArtifact?: boolean;
} = {}): Strategy {
  const manifest = input.manifest ?? certifiedManifest();
  const mode = input.mode ?? "MULTI_POSITION";
  const policy = createDefaultExecutionPolicy(mode);
  const config = { Base_Lot_Size: 25, Max_Layers: 3 };
  const artifact = buildStrategyArtifactEnvelope({
    artifactScope: "EXECUTION_PROFILE",
    strategyKey: manifest.strategyKey,
    strategyVersion: manifest.strategyVersion,
    strategyLogicHash: manifest.strategyLogicHash,
    config,
    executionMode: mode,
    executionPolicy: policy,
    capabilityManifest: manifest,
    source: { origin: "IMPORT" },
  });
  return {
    id: 91,
    userId: 7,
    name: "Canonical Runtime",
    strategyKey: manifest.strategyKey,
    deploymentKey: "dep-runtime-91",
    executionMode: mode,
    executionPolicy: policy,
    executionPolicyVersion: artifact.executionPolicyVersion,
    strategyVersion: manifest.strategyVersion,
    capabilitySnapshot: manifest,
    activationState: input.activationState ?? "ACTIVE",
    enabled: true,
    martinState: input.includeArtifact === false
      ? attachSnapshotConfig({}, manifest.strategyKey, config)
      : attachSnapshotConfig({}, manifest.strategyKey, config, { artifact }),
  } as Strategy;
}

describe("canonical runtime deployment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("以 owner scope 載入並驗證完整 sealed execution profile", async () => {
    const strategy = canonicalStrategy();
    mocks.getStrategyById.mockResolvedValue(strategy);
    mocks.requireStrategyCapabilityManifest.mockResolvedValue(strategy.capabilitySnapshot);

    const runtime = await loadCanonicalRuntimeDeployment(strategy.id, strategy.userId);

    expect(mocks.getStrategyById).toHaveBeenCalledWith(strategy.id, strategy.userId);
    expect(runtime.provenance).toBe("SEALED_EXECUTION_PROFILE");
    expect(runtime.executionMode).toBe("MULTI_POSITION");
    expect(runtime.strategy.executionPolicy).toEqual(runtime.artifact.executionPolicy);
  });

  it("artifact hash 被竄改時 fail closed", async () => {
    const strategy = canonicalStrategy();
    const state = strategy.martinState as Record<string, unknown>;
    const artifact = getBoundStrategyArtifact(state, strategy.strategyKey!);
    strategy.martinState = {
      ...state,
      __strategyArtifact: { ...artifact, artifactHash: "tampered" },
    };
    mocks.requireStrategyCapabilityManifest.mockResolvedValue(strategy.capabilitySnapshot);

    await expect(hydrateCanonicalRuntimeDeployment(strategy)).rejects.toMatchObject({
      code: "RUNTIME_ARTIFACT_HASH_MISMATCH",
    } satisfies Partial<CanonicalRuntimeDeploymentError>);
  });

  it("row policy 與 sealed policy 漂移時拒絕執行", async () => {
    const strategy = canonicalStrategy();
    const currentPolicy = createDefaultExecutionPolicy("MULTI_POSITION");
    strategy.executionPolicy = {
      ...currentPolicy,
      riskBudget: {
        ...currentPolicy.riskBudget,
        maxMarginUsagePct: 35,
      },
    };
    mocks.requireStrategyCapabilityManifest.mockResolvedValue(strategy.capabilitySnapshot);

    await expect(hydrateCanonicalRuntimeDeployment(strategy)).rejects.toMatchObject({
      code: "RUNTIME_EXECUTION_POLICY_MISMATCH",
    } satisfies Partial<CanonicalRuntimeDeploymentError>);
  });

  it("canonical deployment 缺少 execution profile artifact 時拒絕執行", async () => {
    const strategy = canonicalStrategy({ includeArtifact: false });
    mocks.requireStrategyCapabilityManifest.mockResolvedValue(strategy.capabilitySnapshot);

    await expect(hydrateCanonicalRuntimeDeployment(strategy)).rejects.toMatchObject({
      code: "RUNTIME_ARTIFACT_MISSING",
    } satisfies Partial<CanonicalRuntimeDeploymentError>);
  });

  it("目前 capability manifest 改版時拒絕過期 sealed profile", async () => {
    const strategy = canonicalStrategy();
    mocks.requireStrategyCapabilityManifest.mockResolvedValue(
      certifiedManifest(strategy.strategyKey!, 2),
    );

    await expect(hydrateCanonicalRuntimeDeployment(strategy)).rejects.toMatchObject({
      code: "RUNTIME_ARTIFACT_INCOMPATIBLE",
    } satisfies Partial<CanonicalRuntimeDeploymentError>);
  });

  it("舊 sealed profile 僅可用 reduce-only 相容路徑退出既有風險", async () => {
    const strategy = canonicalStrategy();
    mocks.requireStrategyCapabilityManifest.mockResolvedValue(
      certifiedManifest(strategy.strategyKey!, 2),
    );

    const runtime = await hydrateCanonicalRuntimeDeploymentForReduceOnlyExit(strategy);

    expect(runtime.provenance).toBe("REDUCE_ONLY_DRIFT_COMPATIBILITY");
    expect(runtime.compatibilityWarnings).toEqual(expect.arrayContaining([
      "STRATEGY_VERSION_MISMATCH",
      "STRATEGY_LOGIC_HASH_MISMATCH",
      "STALE_CAPABILITY_MANIFEST",
      "RUNTIME_CAPABILITY_SNAPSHOT_MISMATCH",
    ]));
    await expect(hydrateCanonicalRuntimeDeployment(strategy)).rejects.toMatchObject({
      code: "RUNTIME_ARTIFACT_INCOMPATIBLE",
    } satisfies Partial<CanonicalRuntimeDeploymentError>);
  });

  it("reduce-only 相容路徑不接受 artifact 完整性或 policy 漂移", async () => {
    const tampered = canonicalStrategy();
    const tamperedState = tampered.martinState as Record<string, unknown>;
    const artifact = getBoundStrategyArtifact(tamperedState, tampered.strategyKey!);
    tampered.martinState = {
      ...tamperedState,
      __strategyArtifact: { ...artifact, artifactHash: "tampered" },
    };
    mocks.requireStrategyCapabilityManifest.mockResolvedValue(tampered.capabilitySnapshot);
    await expect(hydrateCanonicalRuntimeDeploymentForReduceOnlyExit(tampered)).rejects.toMatchObject({
      code: "RUNTIME_ARTIFACT_HASH_MISMATCH",
    } satisfies Partial<CanonicalRuntimeDeploymentError>);

    const policyDrift = canonicalStrategy();
    const currentPolicy = createDefaultExecutionPolicy("MULTI_POSITION");
    policyDrift.executionPolicy = {
      ...currentPolicy,
      riskBudget: { ...currentPolicy.riskBudget, maxMarginUsagePct: 35 },
    };
    mocks.requireStrategyCapabilityManifest.mockResolvedValue(policyDrift.capabilitySnapshot);
    await expect(hydrateCanonicalRuntimeDeploymentForReduceOnlyExit(policyDrift)).rejects.toMatchObject({
      code: "RUNTIME_EXECUTION_POLICY_MISMATCH",
    } satisfies Partial<CanonicalRuntimeDeploymentError>);
  });

  it("LEGACY 缺封印資料僅在記憶體安全遷移為 S1，不回寫也不升級為 M2／H3", async () => {
    const manifest = certifiedManifest("TEST_LEGACY", 3);
    const strategy = canonicalStrategy({
      manifest,
      mode: "SINGLE_EXCLUSIVE",
      activationState: "LEGACY",
      includeArtifact: false,
    });
    strategy.deploymentKey = null;
    mocks.requireStrategyCapabilityManifest.mockResolvedValue(manifest);

    const runtime = await hydrateCanonicalRuntimeDeployment(strategy);

    expect(runtime.provenance).toBe("LEGACY_S1_MEMORY_MIGRATION");
    expect(runtime.executionMode).toBe("SINGLE_EXCLUSIVE");
    expect(runtime.artifact.source.origin).toBe("LEGACY_MIGRATION");
    expect(getBoundStrategyArtifact(strategy.martinState, manifest.strategyKey)).toBeUndefined();
    expect(getBoundStrategyArtifact(runtime.strategy.martinState, manifest.strategyKey)?.artifactScope)
      .toBe("EXECUTION_PROFILE");
  });

  it("舊 KRM S1 sealed profile 對方案 B manifest 只在記憶體 reseal，保留 S1 且不回寫原 row", async () => {
    const legacyManifest = certifiedManifest("KAMA_RAINBOW_MARTIN_V1");
    const currentManifest = s1ManifestFrom(legacyManifest);
    const strategy = canonicalStrategy({ manifest: legacyManifest, mode: "SINGLE_EXCLUSIVE" });
    const persistedArtifactHash = getBoundStrategyArtifact(
      strategy.martinState,
      legacyManifest.strategyKey,
    )!.artifactHash;
    mocks.requireStrategyCapabilityManifest.mockResolvedValue(currentManifest);

    const runtime = await hydrateCanonicalRuntimeDeployment(strategy);

    expect(runtime.provenance).toBe("KRM_S1_CAPABILITY_RESEAL");
    expect(runtime.executionMode).toBe("SINGLE_EXCLUSIVE");
    expect(runtime.artifact.capabilityManifest.manifestHash).toBe(currentManifest.manifestHash);
    expect(runtime.strategy.capabilitySnapshot).toEqual(currentManifest);
    expect(runtime.compatibilityWarnings).toEqual(expect.arrayContaining([
      "STALE_CAPABILITY_MANIFEST",
      "RUNTIME_CAPABILITY_SNAPSHOT_MISMATCH",
    ]));
    expect(getBoundStrategyArtifact(strategy.martinState, legacyManifest.strategyKey)?.artifactHash)
      .toBe(persistedArtifactHash);
  });

  it("KRM S1 reseal 不接受 row capabilitySnapshot 與 sealed artifact 不一致", async () => {
    const legacyManifest = certifiedManifest("KAMA_RAINBOW_MARTIN_V1");
    const currentManifest = s1ManifestFrom(legacyManifest);
    const strategy = canonicalStrategy({ manifest: legacyManifest, mode: "SINGLE_EXCLUSIVE" });
    strategy.capabilitySnapshot = currentManifest;
    mocks.requireStrategyCapabilityManifest.mockResolvedValue(currentManifest);

    await expect(hydrateCanonicalRuntimeDeployment(strategy)).rejects.toMatchObject({
      code: "RUNTIME_CAPABILITY_SNAPSHOT_MISMATCH",
    } satisfies Partial<CanonicalRuntimeDeploymentError>);
  });

  it.each(["MULTI_POSITION", "HEDGE_GUARDED"] as const)(
    "舊 KRM %s sealed profile 在方案 B manifest 下不得啟動或恢復",
    async (mode) => {
      const legacyManifest = certifiedManifest("KAMA_RAINBOW_MARTIN_V1");
      const strategy = canonicalStrategy({ manifest: legacyManifest, mode });
      mocks.requireStrategyCapabilityManifest.mockResolvedValue(s1ManifestFrom(legacyManifest));

      await expect(hydrateCanonicalRuntimeDeployment(strategy)).rejects.toMatchObject({
        code: "RUNTIME_ARTIFACT_INCOMPATIBLE",
      } satisfies Partial<CanonicalRuntimeDeploymentError>);
    },
  );
});
