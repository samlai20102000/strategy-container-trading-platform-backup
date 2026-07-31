import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_MODE_META,
  DEPLOYMENT_SAFETY_COPY,
  buildDeploymentTransitionKey,
  canSwitchDeploymentMode,
  getWorkbenchLifecycleActions,
  isFreshEligiblePreflight,
} from "../client/src/lib/deploymentWorkbench";

describe("deploymentWorkbench safety model", () => {
  it("exposes all three canonical execution modes", () => {
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

  it("allows mode changes only from disabled flat-source states", () => {
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
