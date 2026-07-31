import { describe, expect, it } from "vitest";
import { scheduledRuntimeAdmission } from "./services/deploymentRuntimeAdmission";

describe("scheduled deployment runtime admission", () => {
  it("保留 LEGACY enabled 相容語義", () => {
    expect(scheduledRuntimeAdmission({ enabled: true, activationState: "LEGACY" })).toBe("FULL");
    expect(scheduledRuntimeAdmission({ enabled: false, activationState: "LEGACY" })).toBe("BLOCKED");
  });

  it("只有 ACTIVE 可完整執行", () => {
    expect(scheduledRuntimeAdmission({ enabled: false, activationState: "ACTIVE" })).toBe("FULL");
    expect(scheduledRuntimeAdmission({ enabled: true, activationState: "READY_DISABLED" })).toBe("BLOCKED");
    expect(scheduledRuntimeAdmission({ enabled: true, activationState: "DRAFT" })).toBe("BLOCKED");
  });

  it.each(["PAUSED", "DRAINING", "BLOCKED"])("%s 仍可進 close-only 維運", activationState => {
    expect(scheduledRuntimeAdmission({ enabled: false, activationState })).toBe("CLOSE_ONLY");
  });
});
