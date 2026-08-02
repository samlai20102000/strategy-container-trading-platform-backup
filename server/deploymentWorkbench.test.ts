import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEPLOYMENT_MODE_META,
  DEPLOYMENT_SAFETY_COPY,
  buildDeploymentTransitionKey,
  canSwitchDeploymentMode,
  getWorkbenchLifecycleActions,
  isFreshEligiblePreflight,
} from "../client/src/lib/deploymentWorkbench";

const workbenchSource = readFileSync(
  new URL("../client/src/pages/DeploymentWorkbench.tsx", import.meta.url),
  "utf8",
);

describe("deploymentWorkbench safety model", () => {
  it("保留後端相容的三種 canonical execution mode 安全模型", () => {
    expect(Object.values(DEPLOYMENT_MODE_META).map(item => item.code)).toEqual(["S1", "M2", "H3"]);
  });

  it("never offers direct activation outside ready states", () => {
    expect(getWorkbenchLifecycleActions("DRAFT")).not.toContain("ACTIVATE");
    expect(getWorkbenchLifecycleActions("PREFLIGHT_FAILED")).not.toContain("ACTIVATE");
    expect(getWorkbenchLifecycleActions("ACTIVE")).not.toContain("ACTIVATE");
    expect(getWorkbenchLifecycleActions("READY_DISABLED")).toContain("ACTIVATE");
    expect(getWorkbenchLifecycleActions("ARMED")).toContain("ACTIVATE");
  });

  it("exposes reduce-only maintenance actions for active and blocked deployments", () => {
    expect(getWorkbenchLifecycleActions("ACTIVE")).toEqual(["PAUSE", "DRAIN", "BLOCK"]);
    expect(getWorkbenchLifecycleActions("BLOCKED")).toContain("DRAIN");
    expect(getWorkbenchLifecycleActions("ARCHIVED")).toEqual([]);
  });

  it("保留後端模式切換的 disabled flat-source safety helper", () => {
    expect(canSwitchDeploymentMode("READY_DISABLED", false)).toBe(true);
    expect(canSwitchDeploymentMode("PAUSED", false)).toBe(true);
    expect(canSwitchDeploymentMode("ACTIVE", true)).toBe(false);
    expect(canSwitchDeploymentMode("DRAINING", false)).toBe(false);
    expect(canSwitchDeploymentMode("DISABLED", true)).toBe(false);
  });

  it("treats eligible preflight as fresh only until its expiry", () => {
    expect(isFreshEligiblePreflight({ eligible: true, expiresAt: 10_000 }, 9_999)).toBe(true);
    expect(isFreshEligiblePreflight({ eligible: true, expiresAt: 10_000 }, 10_001)).toBe(false);
    expect(isFreshEligiblePreflight({ eligible: false, expiresAt: 20_000 }, 1)).toBe(false);
  });

  it("builds bounded deterministic retry keys when uuid is injected", () => {
    const key = buildDeploymentTransitionKey("Run Preflight", 42, "fixed-uuid");
    expect(key).toBe("run-preflight-42-fixed-uuid");
    expect(key.length).toBeLessThanOrEqual(96);
  });

  it("keeps explicit no-auto-enable and readonly-preflight safety copy", () => {
    expect(DEPLOYMENT_SAFETY_COPY.defaultDisabled).toContain("不會自動啟用實盤");
    expect(DEPLOYMENT_SAFETY_COPY.readonlyPreflight).toContain("不送單");
    expect(DEPLOYMENT_SAFETY_COPY.closeOnly).toContain("僅允許 reduce／close");
  });
});

describe("deploymentWorkbench S1-only quick start contract", () => {
  it("keeps deployment management and quick start as explicit peer panels", () => {
    expect(workbenchSource).toContain('data-testid="deployment-workbench-panels"');
    expect(workbenchSource).toContain('value="manage"');
    expect(workbenchSource).toContain('value="quick-start"');
    expect(workbenchSource).toContain("部署管理");
    expect(workbenchSource).toContain("快速啟動");
  });

  it("supports strategy instance, parameter snapshot and registry definition sources", () => {
    expect(workbenchSource).toContain('"STRATEGY_INSTANCE"');
    expect(workbenchSource).toContain('"PARAMETER_SNAPSHOT"');
    expect(workbenchSource).toContain('"STRATEGY_DEFINITION"');
    expect(workbenchSource).toContain("<InstanceSelector");
    expect(workbenchSource).toContain("quickSnapshotsQuery");
    expect(workbenchSource).toContain("registryQuery.data?.map");
  });

  it("reuses exchange symbol specifications and the S1 canonical execution profile UI", () => {
    expect(workbenchSource).toContain("<SymbolCombobox");
    expect(workbenchSource).toContain("Min qty");
    expect(workbenchSource).toContain("Qty step");
    expect(workbenchSource).toContain("<ExecutionProfileSummary");
    expect(workbenchSource).toContain("<PolicyEditor");
    expect(workbenchSource).not.toContain("EXECUTION_MODES.map(mode");
    expect(workbenchSource).not.toContain("trpc.deployments.switchMode.useMutation");
    expect(workbenchSource).not.toContain("MULTI_POSITION");
    expect(workbenchSource).not.toContain("HEDGE_GUARDED");
  });

  it("creates a disabled draft, runs readonly preflight and exposes one explicit enable control", () => {
    expect(workbenchSource).toContain("trpc.deployments.create.useMutation");
    expect(workbenchSource).toContain('buildDeploymentTransitionKey("quick-preflight", deployment.id)');
    expect(workbenchSource).toContain("建立停用草稿並執行 Preflight");
    expect(workbenchSource).toContain("Preflight 只讀取");
    expect(workbenchSource).toContain('setPendingAction("ACTIVATE")');
    expect(workbenchSource.match(/明確啟用此部署/g)).toHaveLength(1);
  });

  it("exposes immutable version lineage evidence from the canonical deployment state", () => {
    expect(workbenchSource).toContain('data-testid="deployment-version-lineage"');
    expect(workbenchSource).toContain("Source snapshot ID");
    expect(workbenchSource).toContain("Parameter-set version");
    expect(workbenchSource).toContain("Artifact hash");
    expect(workbenchSource).toContain("Migrated by");
    expect(workbenchSource).toContain("buildDeploymentLineage(activeDeployment)");
    expect(workbenchSource).toContain("statusQuery.isLoading && !activeDeployment");
  });
});
