import type { DeploymentActivationState } from "../../shared/executionModes";

export type ScheduledRuntimeAdmission = "FULL" | "CLOSE_ONLY" | "BLOCKED";

export interface DeploymentRuntimeAdmissionInput {
  enabled: boolean;
  activationState?: DeploymentActivationState | string | null;
}

/**
 * 排程入口只決定是否允許 pipeline 被喚醒；每個 exchange mutation 仍必須通過
 * runtimeModeGuard。這可讓 PAUSED／DRAINING／BLOCKED 執行 reduce-only 維運，
 * 又不讓 DRAFT／READY_DISABLED 因 legacy enabled 欄位誤觸達 runtime。
 */
export function scheduledRuntimeAdmission(
  deployment: DeploymentRuntimeAdmissionInput,
): ScheduledRuntimeAdmission {
  const state = deployment.activationState ?? "LEGACY";
  if (state === "LEGACY") return deployment.enabled ? "FULL" : "BLOCKED";
  if (state === "ACTIVE") return "FULL";
  if (state === "PAUSED" || state === "DRAINING" || state === "BLOCKED") {
    return "CLOSE_ONLY";
  }
  return "BLOCKED";
}

export function runtimeAdmissionReason(admission: ScheduledRuntimeAdmission): string {
  if (admission === "FULL") return "canonical active/full runtime";
  if (admission === "CLOSE_ONLY") return "canonical close-only maintenance";
  return "deployment lifecycle blocks scheduled runtime";
}
