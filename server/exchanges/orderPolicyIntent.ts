import type { CloseExecutionOptions, OrderParams } from "./types";

export type ApprovedEmergencyReason = NonNullable<OrderParams["emergencyReason"]>;
export type OrderPolicyContext = NonNullable<OrderParams["policyContext"]>;

/**
 * 將策略結構化 close reason 映射到方案 B 唯一允許的緊急退出原因。
 * 未明列的理由一律維持 maker-only，禁止以模糊訊息或自由文字授權 taker。
 */
export function approvedEmergencyReasonFromCloseReason(
  closeReason: unknown,
): ApprovedEmergencyReason | undefined {
  if (closeReason === "HARD_STOP" || closeReason === "SL") return "STOP_LOSS";
  if (closeReason === "KILL") return "KILL_SWITCH";
  return undefined;
}

export function orderPolicyFields(
  policyContext: OrderPolicyContext,
  emergencyReason?: ApprovedEmergencyReason,
): Pick<OrderParams, "executionClass" | "emergencyReason" | "policyContext"> {
  return {
    executionClass: emergencyReason ? "EMERGENCY_EXIT" : "MAKER_ONLY",
    emergencyReason,
    policyContext,
  };
}

export function closePolicyOptions(
  policyContext: OrderPolicyContext,
  emergencyReason?: ApprovedEmergencyReason,
  requestedSize?: number,
): CloseExecutionOptions {
  return {
    executionClass: emergencyReason ? "EMERGENCY_EXIT" : "MAKER_ONLY",
    emergencyReason,
    policyContext,
    requestedSize,
  };
}
