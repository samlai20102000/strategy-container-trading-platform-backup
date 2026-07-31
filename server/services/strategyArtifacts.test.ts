import { describe, expect, it } from "vitest";
import { createDefaultExecutionPolicy } from "../../shared/executionModes";
import {
  assessStrategyArtifactCompatibility,
  buildDisabledSnapshotDeploymentFields,
  buildStrategyArtifactEnvelope,
  buildStrategyLogicHash,
  createVersionedCapabilityManifest,
  hydrateStrategyArtifactFromSnapshotRow,
} from "./strategyArtifacts";

function certifiedManifest(strategyKey = "TEST_ADVANCED", strategyVersion = 1) {
  const strategyLogicHash = buildStrategyLogicHash({
    strategyKey,
    strategyVersion,
    logicSource: `logic-${strategyKey}-v${strategyVersion}`,
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
      reason: "test-certified",
    },
  });
}

function s1Manifest(strategyKey = "TEST_S1", strategyVersion = 1) {
  const strategyLogicHash = buildStrategyLogicHash({
    strategyKey,
    strategyVersion,
    logicSource: `logic-${strategyKey}-v${strategyVersion}`,
  });
  return createVersionedCapabilityManifest({
    strategyKey,
    strategyVersion,
    strategyLogicHash,
    certification: "S1_ONLY",
    capabilities: {
      supportedModes: ["SINGLE_EXCLUSIVE"],
      martingaleLayers: true,
      independentLegState: false,
      hedgeGuard: false,
      preciseLegClose: false,
      reason: "test-s1-only",
    },
  });
}

describe("StrategyArtifact canonical contract", () => {
  it("對等配置的 hash 不受物件鍵順序影響", () => {
    const manifest = certifiedManifest();
    const first = buildStrategyArtifactEnvelope({
      artifactScope: "EXECUTION_PROFILE",
      strategyKey: manifest.strategyKey,
      strategyVersion: manifest.strategyVersion,
      strategyLogicHash: manifest.strategyLogicHash,
      config: { z: 3, nested: { b: 2, a: 1 }, a: 1 },
      executionMode: "MULTI_POSITION",
      executionPolicy: createDefaultExecutionPolicy("MULTI_POSITION"),
      capabilityManifest: manifest,
      source: { origin: "BACKTEST_RUN", sourceRunId: "run-1" },
    });
    const second = buildStrategyArtifactEnvelope({
      artifactScope: "EXECUTION_PROFILE",
      strategyKey: manifest.strategyKey,
      strategyVersion: manifest.strategyVersion,
      strategyLogicHash: manifest.strategyLogicHash,
      config: { a: 1, nested: { a: 1, b: 2 }, z: 3 },
      executionMode: "MULTI_POSITION",
      executionPolicy: createDefaultExecutionPolicy("MULTI_POSITION"),
      capabilityManifest: manifest,
      source: { sourceRunId: "run-1", origin: "BACKTEST_RUN" },
    });

    expect(second.configHash).toBe(first.configHash);
    expect(second.executionPolicyHash).toBe(first.executionPolicyHash);
    expect(second.artifactHash).toBe(first.artifactHash);
  });

  it("三模式 execution profile 可從資料庫列完整 round-trip", () => {
    const config = { Base_Lot_Size: 30, Martin_Step_Pct: 2 };
    const manifest = certifiedManifest();
    const artifact = buildStrategyArtifactEnvelope({
      artifactScope: "EXECUTION_PROFILE",
      strategyKey: manifest.strategyKey,
      strategyVersion: manifest.strategyVersion,
      strategyLogicHash: manifest.strategyLogicHash,
      config,
      executionMode: "HEDGE_GUARDED",
      executionPolicy: createDefaultExecutionPolicy("HEDGE_GUARDED"),
      capabilityManifest: manifest,
      source: { origin: "PARAMETER_SNAPSHOT", sourceSnapshotId: 42 },
    });

    const hydrated = hydrateStrategyArtifactFromSnapshotRow({
      id: 42,
      config,
      strategyKey: artifact.strategyKey,
      strategyVersion: artifact.strategyVersion,
      artifactContractVersion: artifact.contractVersion,
      artifactScope: artifact.artifactScope,
      artifactHash: artifact.artifactHash,
      strategyLogicHash: artifact.strategyLogicHash,
      executionMode: artifact.executionMode,
      executionPolicy: artifact.executionPolicy,
      executionPolicyVersion: artifact.executionPolicyVersion,
      executionPolicyHash: artifact.executionPolicyHash,
      capabilityManifest: artifact.capabilityManifest,
      artifactSource: artifact.source,
    }, manifest);

    expect(hydrated.migratedLegacy).toBe(false);
    expect(hydrated.integrityValid).toBe(true);
    expect(hydrated.artifact).toEqual(artifact);
    expect(assessStrategyArtifactCompatibility({
      artifact: hydrated.artifact,
      targetManifest: manifest,
      integrityValid: hydrated.integrityValid,
    })).toMatchObject({ compatible: true, blockers: [] });
  });

  it("舊快照只遷移成 PARAMETERS_ONLY S1，且明示 execution profile 警告", () => {
    const manifest = certifiedManifest();
    const hydrated = hydrateStrategyArtifactFromSnapshotRow({
      id: 7,
      strategyKey: manifest.strategyKey,
      config: { Initial_Capital: 10_000 },
    }, manifest);
    const report = assessStrategyArtifactCompatibility({
      artifact: hydrated.artifact,
      targetManifest: manifest,
      integrityValid: hydrated.integrityValid,
    });

    expect(hydrated.migratedLegacy).toBe(true);
    expect(hydrated.artifact.artifactScope).toBe("PARAMETERS_ONLY");
    expect(hydrated.artifact.executionMode).toBe("SINGLE_EXCLUSIVE");
    expect(hydrated.artifact.source.origin).toBe("LEGACY_MIGRATION");
    expect(report.compatible).toBe(true);
    expect(report.warnings).toContain("PARAMETERS_ONLY_NO_EXECUTION_PROFILE");
  });

  it("跨策略 artifact 被 compatibility Gate 拒絕", () => {
    const sourceManifest = certifiedManifest("SOURCE_STRATEGY");
    const targetManifest = certifiedManifest("TARGET_STRATEGY");
    const artifact = buildStrategyArtifactEnvelope({
      artifactScope: "PARAMETERS_ONLY",
      strategyKey: sourceManifest.strategyKey,
      strategyVersion: sourceManifest.strategyVersion,
      strategyLogicHash: sourceManifest.strategyLogicHash,
      config: { value: 1 },
      capabilityManifest: sourceManifest,
    });
    const report = assessStrategyArtifactCompatibility({ artifact, targetManifest });

    expect(report.compatible).toBe(false);
    expect(report.blockers).toContain("STRATEGY_KEY_MISMATCH");
  });

  it("策略版本或 logic hash 改變時拒絕過期 capability manifest", () => {
    const oldManifest = certifiedManifest("VERSIONED_STRATEGY", 1);
    const currentManifest = certifiedManifest("VERSIONED_STRATEGY", 2);
    const artifact = buildStrategyArtifactEnvelope({
      artifactScope: "EXECUTION_PROFILE",
      strategyKey: oldManifest.strategyKey,
      strategyVersion: oldManifest.strategyVersion,
      strategyLogicHash: oldManifest.strategyLogicHash,
      config: { value: 1 },
      executionMode: "MULTI_POSITION",
      capabilityManifest: oldManifest,
    });
    const report = assessStrategyArtifactCompatibility({ artifact, targetManifest: currentManifest });

    expect(report.compatible).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining([
      "STRATEGY_VERSION_MISMATCH",
      "STRATEGY_LOGIC_HASH_MISMATCH",
      "STALE_CAPABILITY_MANIFEST",
    ]));
  });

  it("持久化 artifactHash 被竄改時 fail closed", () => {
    const manifest = certifiedManifest();
    const config = { value: 1 };
    const artifact = buildStrategyArtifactEnvelope({
      artifactScope: "PARAMETERS_ONLY",
      strategyKey: manifest.strategyKey,
      strategyVersion: manifest.strategyVersion,
      strategyLogicHash: manifest.strategyLogicHash,
      config,
      capabilityManifest: manifest,
    });
    const hydrated = hydrateStrategyArtifactFromSnapshotRow({
      config,
      strategyKey: artifact.strategyKey,
      strategyVersion: artifact.strategyVersion,
      artifactContractVersion: artifact.contractVersion,
      artifactScope: artifact.artifactScope,
      artifactHash: "tampered",
      strategyLogicHash: artifact.strategyLogicHash,
      executionMode: artifact.executionMode,
      executionPolicy: artifact.executionPolicy,
      capabilityManifest: artifact.capabilityManifest,
      artifactSource: artifact.source,
    }, manifest);
    const report = assessStrategyArtifactCompatibility({
      artifact: hydrated.artifact,
      targetManifest: manifest,
      integrityValid: hydrated.integrityValid,
    });

    expect(hydrated.integrityValid).toBe(false);
    expect(report.compatible).toBe(false);
    expect(report.blockers).toContain("ARTIFACT_HASH_MISMATCH");
  });

  it("未認證策略不能建立 M2／H3 execution profile", () => {
    const manifest = s1Manifest();
    expect(() => buildStrategyArtifactEnvelope({
      artifactScope: "EXECUTION_PROFILE",
      strategyKey: manifest.strategyKey,
      strategyVersion: manifest.strategyVersion,
      strategyLogicHash: manifest.strategyLogicHash,
      config: {},
      executionMode: "HEDGE_GUARDED",
      capabilityManifest: manifest,
    })).toThrow(/未認證 HEDGE_GUARDED/);
  });

  it("從 execution profile 建立 deployment 時保留模式身份但永遠預設停用", () => {
    const manifest = certifiedManifest();
    const artifact = buildStrategyArtifactEnvelope({
      artifactScope: "EXECUTION_PROFILE",
      strategyKey: manifest.strategyKey,
      strategyVersion: manifest.strategyVersion,
      strategyLogicHash: manifest.strategyLogicHash,
      config: { value: 1 },
      executionMode: "HEDGE_GUARDED",
      capabilityManifest: manifest,
      source: { origin: "IMPORT" },
    });

    expect(buildDisabledSnapshotDeploymentFields(artifact)).toEqual({
      enabled: false,
      activationState: "DISABLED",
      disabledReason: "快照導入後預設停用；必須通過部署 preflight 後才可啟用",
      strategyVersion: artifact.strategyVersion,
      executionMode: "HEDGE_GUARDED",
      executionPolicy: artifact.executionPolicy,
      executionPolicyVersion: artifact.executionPolicyVersion,
      capabilitySnapshot: manifest,
    });
  });
});
