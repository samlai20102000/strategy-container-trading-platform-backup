import { createHash } from "node:crypto";
import type { OrderResult } from "../exchanges/types";

export interface CloseRetryState {
  closeIntentId: string;
  failureCount: number;
  nextRetryAt: number;
  lastError?: string;
  reasonCode?: string;
}

export interface StableCloseIntentInput {
  strategyId: number;
  side: "long" | "short";
  size?: number;
  entryPrice?: number;
  scope: string;
}

export const CLOSE_RETRY_BASE_MS = 60_000;
export const CLOSE_RETRY_MAX_MS = 60 * 60_000;

function finiteNonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function computeCloseRetryDelayMs(failureCount: number): number {
  const safeCount = Math.max(1, Math.floor(failureCount));
  return Math.min(CLOSE_RETRY_BASE_MS * (2 ** (safeCount - 1)), CLOSE_RETRY_MAX_MS);
}

export function readCloseRetryState(value: unknown): CloseRetryState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<CloseRetryState>;
  if (typeof candidate.closeIntentId !== "string" || !candidate.closeIntentId) return undefined;
  const failureCount = Number(candidate.failureCount);
  const nextRetryAt = Number(candidate.nextRetryAt);
  if (!Number.isFinite(failureCount) || failureCount < 1 || !Number.isFinite(nextRetryAt)) return undefined;
  return {
    closeIntentId: candidate.closeIntentId,
    failureCount,
    nextRetryAt,
    lastError: typeof candidate.lastError === "string" ? candidate.lastError : undefined,
    reasonCode: typeof candidate.reasonCode === "string" ? candidate.reasonCode : undefined,
  };
}

/**
 * 同一策略、同一持倉腿、同一倉位事實在跨輪詢／跨 instance 下產生相同 intent。
 * 只使用不可逆摘要，避免 clientOrderId 長度限制及將策略內容寫入交易所欄位。
 */
export function buildStableCloseIntentId(input: StableCloseIntentInput): string {
  const payload = [
    input.strategyId,
    input.side,
    input.scope.trim().toLowerCase(),
    Math.round(finiteNonNegative(input.size) * 100_000_000),
    Math.round(finiteNonNegative(input.entryPrice) * 100),
  ].join(":");
  const digest = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  return `cls${input.strategyId}${input.side === "long" ? "l" : "s"}${digest}`;
}

function resultEvidence(result: Pick<OrderResult, "errorMessage" | "rawResponse"> | undefined): string {
  if (!result) return "";
  let raw = "";
  try {
    raw = typeof result.rawResponse === "string"
      ? result.rawResponse
      : JSON.stringify(result.rawResponse ?? {});
  } catch {
    raw = "";
  }
  return `${result.errorMessage ?? ""} ${raw}`.toUpperCase();
}

export function classifyCloseExecutionFailure(
  result: Pick<OrderResult, "errorMessage" | "rawResponse"> | undefined,
): string {
  const evidence = resultEvidence(result);
  if (evidence.includes("RUNTIME_CAPABILITY_SNAPSHOT_MISMATCH")) return "CLOSE_CAPABILITY_SNAPSHOT_MISMATCH";
  if (evidence.includes("STRATEGY_LOGIC_HASH_MISMATCH")) return "CLOSE_STRATEGY_LOGIC_DRIFT";
  if (evidence.includes("STALE_CAPABILITY_MANIFEST")) return "CLOSE_CAPABILITY_MANIFEST_STALE";
  if (evidence.includes("CANONICAL_RUNTIME_CONTEXT_INVALID")) return "CLOSE_RUNTIME_CONTEXT_INVALID";
  if (evidence.includes("INTENT_ALREADY_ACTIVE")) return "CLOSE_INTENT_ACTIVE";
  if (evidence.includes("NO_MATCHING_POSITION")) return "CLOSE_NO_MATCHING_LEG";
  if (evidence.includes("POSITION_STILL_OPEN") || evidence.includes("持倉仍存在")) return "CLOSE_POSITION_STILL_OPEN";
  if (evidence.includes("DECISION_PERSISTENCE_FAILED") || evidence.includes("AUDIT")) return "CLOSE_AUDIT_UNAVAILABLE";
  if (evidence.includes("TIMEOUT") || evidence.includes("逾時")) return "CLOSE_TIMEOUT";
  return "CLOSE_EXECUTION_FAILED";
}

export function closeExecutionErrorMessage(result: Pick<OrderResult, "errorMessage"> | undefined): string {
  const message = result?.errorMessage?.replace(/[\r\n]+/g, " ").trim();
  return (message || "未取得交易所／政策層錯誤").slice(0, 300);
}

export function nextCloseRetryState(input: {
  previous?: CloseRetryState;
  closeIntentId: string;
  result?: Pick<OrderResult, "errorMessage" | "rawResponse">;
  now?: number;
}): CloseRetryState {
  const failureCount = input.previous?.closeIntentId === input.closeIntentId
    ? input.previous.failureCount + 1
    : 1;
  const now = input.now ?? Date.now();
  return {
    closeIntentId: input.closeIntentId,
    failureCount,
    nextRetryAt: now + computeCloseRetryDelayMs(failureCount),
    lastError: closeExecutionErrorMessage(input.result),
    reasonCode: classifyCloseExecutionFailure(input.result),
  };
}

export function closeRetryRemainingMs(state: CloseRetryState | undefined, now = Date.now()): number {
  return state ? Math.max(0, state.nextRetryAt - now) : 0;
}
