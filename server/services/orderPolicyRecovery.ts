import type { InsertOrderPolicyEvent, orderPolicyEvents } from "../../drizzle/schema";
import {
  getApiKeyById,
  listOrderPolicyEventsForRun,
  listStaleOrderPolicyRunHeads,
  recordOrderPolicyEvent,
} from "../db";
import { createNativeAdapterForOrderPolicyRecovery } from "../exchanges/factory";
import {
  DEFAULT_MAKER_FIRST_POLICY,
  executeMakerFirst,
  type MakerFirstOrderIntent,
  type MakerFirstPolicyConfig,
} from "../exchanges/makerFirstFacade";
import type { ExchangeAdapter, OrderResult } from "../exchanges/types";
import { acquireProcessLease, releaseProcessLease } from "./barLock";

type OrderPolicyEventRow = typeof orderPolicyEvents.$inferSelect;
type JsonObject = Record<string, unknown>;

const TERMINAL_EVENTS = new Set<OrderPolicyEventRow["eventType"]>([
  "MAKER_FILLED",
  "MAKER_EXPIRED",
  "EMERGENCY_FILLED",
  "FAILED",
]);

const DEFAULT_STALE_AFTER_MS = 210_000;
const RECOVERY_LEASE_MS = 175_000;

export interface OrderPolicyRecoverySummary {
  scanned: number;
  recovered: number;
  resumed: number;
  skipped: number;
  failed: number;
  runs: Array<{
    policyRunId: string;
    status: "recovered" | "resumed" | "skipped" | "failed";
    message: string;
  }>;
}

interface RecoveryDependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  recordEvent?: (event: InsertOrderPolicyEvent) => Promise<boolean>;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function positive(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function decimal(value: number): string {
  return Number.isFinite(value) ? value.toFixed(12) : "0";
}

function terminal(events: OrderPolicyEventRow[]): boolean {
  return events.length > 0 && TERMINAL_EVENTS.has(events[events.length - 1].eventType);
}

function parseSnapshot(events: OrderPolicyEventRow[]): {
  origin: OrderPolicyEventRow;
  intent: MakerFirstOrderIntent;
  config: Readonly<MakerFirstPolicyConfig>;
} {
  const origin = events.find(event => {
    const details = object(event.details);
    return event.eventType === "INTENT_RECEIVED" && Object.keys(object(details.recoverableIntent)).length > 0;
  });
  if (!origin) throw new Error("RECOVERY_INTENT_SNAPSHOT_MISSING");

  const details = object(origin.details);
  const raw = object(details.recoverableIntent);
  const side = raw.side === "buy" || raw.side === "sell" ? raw.side : undefined;
  const size = positive(raw.size);
  if (!side || !size || typeof raw.symbol !== "string" || !raw.symbol.trim()) {
    throw new Error("RECOVERY_INTENT_SNAPSHOT_INVALID");
  }

  const executionClass = raw.executionClass === "EMERGENCY_EXIT" ? "EMERGENCY_EXIT" : "MAKER_ONLY";
  const emergencyReason = raw.emergencyReason === "STOP_LOSS"
    || raw.emergencyReason === "DAILY_LOSS_LIMIT"
    || raw.emergencyReason === "KILL_SWITCH"
    ? raw.emergencyReason
    : undefined;
  const posSide = raw.posSide === "long" || raw.posSide === "short" || raw.posSide === "net"
    ? raw.posSide
    : undefined;
  const policyContext = object(raw.policyContext) as MakerFirstOrderIntent["policyContext"];
  const intent: MakerFirstOrderIntent = {
    symbol: raw.symbol,
    side,
    size,
    targetPrice: positive(raw.targetPrice),
    reduceOnly: raw.reduceOnly === true,
    leverage: positive(raw.leverage),
    posSide,
    executionClass,
    emergencyReason,
    policyContext,
  };

  const rawConfig = object(details.policyConfig);
  const config: MakerFirstPolicyConfig = {
    standardTtlMs: positive(rawConfig.standardTtlMs) ?? DEFAULT_MAKER_FIRST_POLICY.standardTtlMs,
    standardMaxAttempts: Math.max(1, Math.trunc(positive(rawConfig.standardMaxAttempts) ?? DEFAULT_MAKER_FIRST_POLICY.standardMaxAttempts)),
    emergencyTtlMs: positive(rawConfig.emergencyTtlMs) ?? DEFAULT_MAKER_FIRST_POLICY.emergencyTtlMs,
    emergencyMakerAttempts: Math.max(1, Math.trunc(positive(rawConfig.emergencyMakerAttempts) ?? DEFAULT_MAKER_FIRST_POLICY.emergencyMakerAttempts)),
    pollIntervalMs: positive(rawConfig.pollIntervalMs) ?? DEFAULT_MAKER_FIRST_POLICY.pollIntervalMs,
  };
  return { origin, intent, config };
}

function maxFilled(events: OrderPolicyEventRow[]): number {
  return events.reduce((max, event) => Math.max(max, nonNegative(event.filledSize)), 0);
}

function maxSubmittedAttempt(events: OrderPolicyEventRow[]): number {
  return events
    .filter(event => event.eventType === "MAKER_SUBMIT")
    .reduce((max, event) => Math.max(max, event.attempt ?? 0), 0);
}

function unresolvedSubmission(events: OrderPolicyEventRow[]): OrderPolicyEventRow | undefined {
  const submissions = events.filter(event => event.eventType === "MAKER_SUBMIT" || event.eventType === "EMERGENCY_FALLBACK");
  for (let index = submissions.length - 1; index >= 0; index--) {
    const submission = submissions[index];
    const later = events.filter(event => event.id > submission.id && event.clientOrderId === submission.clientOrderId);
    const resolved = later.some(event => event.eventType === "MAKER_CANCELLED"
      || event.eventType === "MAKER_REJECTED"
      || event.eventType === "MAKER_FILLED"
      || event.eventType === "EMERGENCY_FILLED"
      || event.eventType === "FAILED");
    if (!resolved) return submission;
  }
  return undefined;
}

function knownChildFilled(events: OrderPolicyEventRow[], candidate: OrderPolicyEventRow): number {
  return events
    .filter(event => event.clientOrderId === candidate.clientOrderId)
    .reduce((max, event) => {
      const child = nonNegative(object(event.details).childFilled);
      return Math.max(max, child);
    }, 0);
}

async function appendRecoveryEvent(
  base: OrderPolicyEventRow,
  eventType: InsertOrderPolicyEvent["eventType"],
  input: {
    intent: MakerFirstOrderIntent;
    filledSize: number;
    clientOrderId?: string | null;
    exchangeOrderId?: string | null;
    attempt?: number | null;
    reasonCode: string;
    message: string;
    details?: JsonObject;
  },
  dependencies: RecoveryDependencies = {},
): Promise<void> {
  const requested = input.intent.size;
  const ok = await (dependencies.recordEvent ?? recordOrderPolicyEvent)({
    policyRunId: base.policyRunId,
    userId: base.userId,
    apiKeyId: base.apiKeyId,
    strategyId: base.strategyId,
    signalId: base.signalId,
    exchange: base.exchange,
    eventType,
    executionClass: input.intent.executionClass ?? "MAKER_ONLY",
    emergencyReason: input.intent.emergencyReason,
    clientOrderId: input.clientOrderId ?? base.clientOrderId,
    exchangeOrderId: input.exchangeOrderId,
    symbol: input.intent.symbol,
    side: input.intent.side,
    reduceOnly: input.intent.reduceOnly ?? false,
    attempt: input.attempt ?? 0,
    requestedSize: decimal(requested),
    filledSize: decimal(input.filledSize),
    remainingSize: decimal(Math.max(0, requested - input.filledSize)),
    reasonCode: input.reasonCode,
    message: input.message,
    details: { recovery: true, ...input.details },
    eventAt: (dependencies.now ?? Date.now)(),
  });
  if (!ok) throw new Error("ORDER_POLICY_AUDIT_UNAVAILABLE");
}

function deterministicRecoveryId(
  policyRunId: string,
  attempt: number,
  emergencyMarket: boolean,
  reuse: Map<string, string>,
): string {
  if (attempt === 0 && !emergencyMarket) return policyRunId;
  const key = `${attempt}:${emergencyMarket ? "market" : "maker"}`;
  const existing = reuse.get(key);
  if (existing) return existing;
  const safeBase = policyRunId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20) || "mfrecovery";
  return `${safeBase}r${emergencyMarket ? "e" : "p"}${attempt.toString(36)}`.slice(0, 30);
}

async function recoverRunWithAdapter(
  events: OrderPolicyEventRow[],
  adapter: ExchangeAdapter,
  dependencies: RecoveryDependencies = {},
): Promise<{ status: "recovered" | "resumed" | "skipped"; message: string }> {
  if (terminal(events)) return { status: "skipped", message: "run 已由其他 instance 終結" };
  const { origin, intent, config } = parseSnapshot(events);
  const append = (
    eventType: InsertOrderPolicyEvent["eventType"],
    input: Parameters<typeof appendRecoveryEvent>[2],
  ) => appendRecoveryEvent(origin, eventType, input, dependencies);
  let filled = maxFilled(events);
  let completedAttempts = maxSubmittedAttempt(events);
  const candidate = unresolvedSubmission(events);
  const reuse = new Map<string, string>();

  if (candidate) {
    const isEmergencyMarket = candidate.eventType === "EMERGENCY_FALLBACK";
    const candidateAttempt = Math.max(1, candidate.attempt ?? (isEmergencyMarket ? config.emergencyMakerAttempts + 1 : completedAttempts));
    reuse.set(`${candidateAttempt}:${isEmergencyMarket ? "market" : "maker"}`, candidate.clientOrderId);
    const accepted = events
      .filter(event => event.clientOrderId === candidate.clientOrderId && event.eventType === "MAKER_ACCEPTED")
      .at(-1);
    const knownOrderId = accepted?.exchangeOrderId ?? candidate.exchangeOrderId ?? undefined;
    const truth = await adapter.getOrderExecutionTruth(
      intent.symbol,
      knownOrderId,
      Boolean(intent.reduceOnly),
      candidate.clientOrderId,
    );
    const discoveredOrderId = truth.orderId ?? knownOrderId;
    const priorChild = knownChildFilled(events, candidate);
    const reportedChild = nonNegative(truth.filledSize);
    filled = Math.min(intent.size, filled + Math.max(0, reportedChild - priorChild));

    if (truth.executionStatus === "filled" || filled >= intent.size - 1e-12) {
      await append(isEmergencyMarket ? "EMERGENCY_FILLED" : "MAKER_FILLED", {
        intent,
        filledSize: intent.size,
        clientOrderId: candidate.clientOrderId,
        exchangeOrderId: discoveredOrderId,
        attempt: candidateAttempt,
        reasonCode: "RECOVERY_EXCHANGE_FILLED",
        message: "Heartbeat 已從交易所權威訂單真相確認成交並終結 policy run",
        details: { executionStatus: truth.executionStatus },
      });
      return { status: "recovered", message: "已由交易所真相確認成交" };
    }

    if (isEmergencyMarket && discoveredOrderId) {
      await append("FAILED", {
        intent,
        filledSize: filled,
        clientOrderId: candidate.clientOrderId,
        exchangeOrderId: discoveredOrderId,
        attempt: candidateAttempt,
        reasonCode: "RECOVERY_EMERGENCY_TAKER_UNCERTAIN",
        message: "緊急 taker 狀態未能確認完全成交；為避免重複市價單已 fail-closed",
        details: { executionStatus: truth.executionStatus, reportedChild },
      });
      return { status: "recovered", message: "緊急 taker 不確定，已 fail-closed" };
    }

    if (discoveredOrderId) {
      await append("INTENT_RECEIVED", {
        intent,
        filledSize: filled,
        clientOrderId: candidate.clientOrderId,
        exchangeOrderId: discoveredOrderId,
        attempt: candidateAttempt,
        reasonCode: "RECOVERY_CANCEL_REQUEST",
        message: "Heartbeat 對未終結 maker 子單執行先稽核後撤單",
      });
      const cancelled = await adapter.cancelOrder(intent.symbol, discoveredOrderId);
      const cancelChild = nonNegative(cancelled.filledSize);
      filled = Math.min(intent.size, filled + Math.max(0, cancelChild - Math.max(priorChild, reportedChild)));
      if (!cancelled.success && cancelled.executionStatus !== "cancelled") {
        await append("FAILED", {
          intent,
          filledSize: filled,
          clientOrderId: candidate.clientOrderId,
          exchangeOrderId: discoveredOrderId,
          attempt: candidateAttempt,
          reasonCode: "RECOVERY_CANCEL_UNCONFIRMED",
          message: "Heartbeat 無法確認舊 maker 子單已撤銷；禁止建立第二張 live 訂單",
          details: { errorMessage: cancelled.errorMessage },
        });
        return { status: "recovered", message: "撤單未確認，已 fail-closed" };
      }
      await append("MAKER_CANCELLED", {
        intent,
        filledSize: filled,
        clientOrderId: candidate.clientOrderId,
        exchangeOrderId: discoveredOrderId,
        attempt: candidateAttempt,
        reasonCode: "RECOVERY_CANCELLED",
        message: "Heartbeat 已確認舊 maker 子單撤銷，可安全接續剩餘量",
      });
      completedAttempts = Math.max(completedAttempts, candidateAttempt);
    } else {
      // 送單前／送單後崩潰但交易所無此 client id：以同一 client id 重試同一 attempt。
      completedAttempts = Math.max(0, candidateAttempt - 1);
    }
  }

  if (filled >= intent.size - 1e-12) {
    await append("MAKER_FILLED", {
      intent,
      filledSize: intent.size,
      reasonCode: "RECOVERY_HISTORY_FILLED",
      message: "Heartbeat 由 append-only 歷史重建後確認 intent 已完全成交",
    });
    return { status: "recovered", message: "事件歷史已確認完全成交" };
  }

  const result = await executeMakerFirst(adapter, {
    userId: origin.userId,
    apiKeyId: origin.apiKeyId,
  }, intent, config, {
    now: dependencies.now,
    sleep: dependencies.sleep,
    recordEvent: dependencies.recordEvent,
    resumeState: {
      policyRunId: origin.policyRunId,
      initialFilledSize: filled,
      completedMakerAttempts: completedAttempts,
    },
    createClientOrderId: (attempt, emergencyMarket) => deterministicRecoveryId(
      origin.policyRunId,
      attempt,
      emergencyMarket,
      reuse,
    ),
  });
  return {
    status: "resumed",
    message: result.success ? "已接續並完成剩餘量" : result.errorMessage ?? "已接續但尚未完成",
  };
}

function leaseStrategyId(run: OrderPolicyEventRow): number {
  return Math.max(1, Number(run.apiKeyId) || Number(run.strategyId) || 1);
}

export async function runOrderPolicyRecovery(options: {
  nowMs?: number;
  staleAfterMs?: number;
  limit?: number;
} = {}): Promise<OrderPolicyRecoverySummary> {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = Math.max(30_000, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const heads = await listStaleOrderPolicyRunHeads(nowMs - staleAfterMs, options.limit ?? 1);
  const summary: OrderPolicyRecoverySummary = {
    scanned: heads.length,
    recovered: 0,
    resumed: 0,
    skipped: 0,
    failed: 0,
    runs: [],
  };

  for (const head of heads) {
    const lease = await acquireProcessLease(
      `maker-first-recovery:${head.policyRunId}`,
      leaseStrategyId(head),
      RECOVERY_LEASE_MS,
    );
    if (!lease) {
      summary.skipped += 1;
      summary.runs.push({ policyRunId: head.policyRunId, status: "skipped", message: "另一個 instance 已取得 recovery lease" });
      continue;
    }

    try {
      const events = await listOrderPolicyEventsForRun(head.policyRunId);
      if (terminal(events)) {
        summary.skipped += 1;
        summary.runs.push({ policyRunId: head.policyRunId, status: "skipped", message: "run 已終結" });
        continue;
      }
      const origin = events[0];
      const apiKey = await getApiKeyById(origin.apiKeyId, origin.userId);
      if (!apiKey) throw new Error("RECOVERY_API_KEY_NOT_FOUND");
      if (apiKey.exchange !== origin.exchange) throw new Error("RECOVERY_EXCHANGE_MISMATCH");
      const adapter = createNativeAdapterForOrderPolicyRecovery(apiKey);
      const result = await recoverRunWithAdapter(events, adapter);
      summary[result.status] += 1;
      summary.runs.push({ policyRunId: head.policyRunId, ...result });
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      summary.runs.push({ policyRunId: head.policyRunId, status: "failed", message });
      console.error(`[MakerFirst/Recovery] ${head.policyRunId} 恢復失敗:`, error);
    } finally {
      await releaseProcessLease(lease);
    }
  }
  return summary;
}

export const __orderPolicyRecoveryTestUtils = {
  parseSnapshot,
  unresolvedSubmission,
  recoverRunWithAdapter,
};
