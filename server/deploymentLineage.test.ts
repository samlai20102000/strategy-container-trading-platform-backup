import { describe, expect, it } from "vitest";
import { buildDeploymentLineage } from "../client/src/lib/deploymentLineage";

describe("deployment version lineage", () => {
  it("prefers sealed artifact metadata and preserves the source snapshot identity", () => {
    const lineage = buildDeploymentLineage({
      strategyVersion: "row-v1",
      executionPolicyVersion: "row-policy-v1",
      martinState: {
        __snapshotMeta: {
          sourceKind: "PARAMETER_SNAPSHOT",
          sourceStrategyId: 73,
          snapshotId: 41,
          snapshotName: "KRM H3 audited",
          importedAt: 1_785_600_000_000,
        },
        __strategyArtifact: {
          contractVersion: "STRATEGY_EXECUTION_PROFILE_V1",
          strategyVersion: "sealed-v2",
          executionPolicyVersion: "sealed-policy-v2",
          artifactHash: "abcdef1234567890fedcba",
          source: {
            origin: "PARAMETER_SNAPSHOT",
            sourceSnapshotId: 42,
          },
        },
      },
    });

    expect(lineage).toMatchObject({
      sourceKind: "PARAMETER_SNAPSHOT",
      sourceStrategyId: "73",
      sourceSnapshotId: "42",
      snapshotName: "KRM H3 audited",
      artifactOrigin: "PARAMETER_SNAPSHOT",
      artifactContractVersion: "STRATEGY_EXECUTION_PROFILE_V1",
      strategyVersion: "sealed-v2",
      executionPolicyVersion: "sealed-policy-v2",
      parameterSetVersion: "snapshot-42@abcdef123456",
    });
  });

  it("labels legacy migration provenance without inventing an actor or time", () => {
    const lineage = buildDeploymentLineage({
      martinState: {
        __snapshotMeta: { importedAt: 1_785_600_000_000 },
        __strategyArtifact: {
          source: { origin: "LEGACY_MIGRATION" },
        },
      },
    });

    expect(lineage.migratedBy).toBe("system · canonical legacy S1 migration");
    expect(lineage.migratedAt).toBe(1_785_600_000_000);
  });

  it("renders missing lineage fields explicitly instead of inferring data", () => {
    const lineage = buildDeploymentLineage(null);

    expect(lineage.sourceKind).toBe("—");
    expect(lineage.sourceSnapshotId).toBe("—");
    expect(lineage.artifactHash).toBe("—");
    expect(lineage.parameterSetVersion).toBe("artifact@unsealed");
    expect(lineage.migratedAt).toBeNull();
  });
});
