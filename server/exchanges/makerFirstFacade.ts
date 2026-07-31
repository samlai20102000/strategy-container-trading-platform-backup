import { randomBytes } from "node:crypto";
import type { InsertOrderPolicyEvent } from "../../drizzle/schema";
import { recordOrderPolicyEvent } from "../db";
import type {
  CloseExecutionOptions,
  ExchangeAdapter,
  OrderParams,
  OrderResult,
} from "./types";

export const MAKER_FIRST_POLICY_VERSION = "GLOBAL_MAKER_FIRST_B_V1" as const;

export type EmergencyReason = NonNullable<OrderParams["emergencyReason"]>;
export type ExecutionClass = NonNullable<OrderParams["executionClass"]>;

export interface MakerFirstAuditIdentity {
  userId: number;
  apiKeyId: number;
}

/**
 * 策略／router 只描述交易意圖；exchange order type 由本 facade 單獨決定。
 */
export interface MakerFirstOrderIntent {
  symbol: string;
  side: "buy" | "sell";
  size: number;
  /** 策略可接受的價格界線；買單為最高價，賣單為最低價。 */
  targetPrice?: number;
  reduceOnly?: boolean;
  leverage?: number;
  posSide?: "long" | "short" | "net";
  executionClass?: ExecutionClass;
  emergencyReason?: EmergencyReason;
  policyContext?: OrderParams["policyContext"];
}

export interface MakerFirstPolicyConfig {
  /** 開倉、加倉與正常平倉每次 post-only 掛單的 TTL。 */
  standardTtlMs: number;
  /** 標準流程最多 post-only 提交次數（包括第一次）。 */
  standardMaxAttempts: number;
  /** 緊急流程每次 maker-only 等待時間。 */
  emergencyTtlMs: number;
  /** 緊急 taker 前必須完成的 maker-only 提交次數。 */
  emergencyMakerAttempts: number;
  /** 三種既有緊急 taker fallback 可被使用者縮窄關閉，但不得新增其他原因。 */
  allowStopLossTaker: boolean;
  allowDailyLossTaker: boolean;
  allowKillSwitchTaker: boolean;
  /** 單次 request 內的查單間隔；不建立 setInterval 或背景 timer。 */
  pollIntervalMs: number;
}

export const DEFAULT_MAKER_FIRST_POLICY: Readonly<MakerFirstPolicyConfig> = Object.freeze({
  standardTtlMs: 30_000,
  standardMaxAttempts: 3,
  emergencyTtlMs: 2_000,
  emergencyMakerAttempts: 2,
  allowStopLossTaker: true,
  allowDailyLossTaker: true,
  allowKillSwitchTaker: true,
  pollIntervalMs: 500,
});

type AuditWriter = (event: InsertOrderPolicyEvent) => Promise<boolean>;

export interface MakerFirstDependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  createClientOrderId?: (attempt: number, emergencyMarket: boolean) => string;
  recordEvent?: AuditWriter;
  /** 僅供持久化 recovery：以同一 policyRunId 接續未終結狀態機。 */
  resumeState?: {
    policyRunId: string;
    initialFilledSize: number;
    completedMakerAttempts: number;
  };
}

const APPROVED_EMERGENCY_REASONS = new Set<EmergencyReason>([
  "STOP_LOSS",
  "DAILY_LOSS_LIMIT",
  "KILL_SWITCH",
]);

function emergencyTakerEnabled(
  config: Readonly<MakerFirstPolicyConfig>,
  reason: EmergencyReason | undefined,
): boolean {
  if (reason === "STOP_LOSS") return config.allowStopLossTaker;
  if (reason === "DAILY_LOSS_LIMIT") return config.allowDailyLossTaker;
  if (reason === "KILL_SWITCH") return config.allowKillSwitchTaker;
  return false;
}

class AuditUnavailableError extends Error {
  constructor() {
    super("ORDER_POLICY_AUDIT_UNAVAILABLE");
  }
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function decimalPlaces(step: number): number {
  const text = String(step).toLowerCase();
  if (text.includes("e-")) return Math.min(12, Number(text.split("e-")[1]) || 0);
  return Math.min(12, text.includes(".") ? text.split(".")[1].length : 0);
}

function quantize(value: number, step: number, direction: "floor" | "ceil"): number {
  const scaled = value / step;
  const units = direction === "floor"
    ? Math.floor(scaled + Number.EPSILON * 8)
    : Math.ceil(scaled - Number.EPSILON * 8);
  return Number((units * step).toFixed(decimalPlaces(step)));
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(12);
}

function clampFilled(value: number, requested: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(requested, value);
}

function defaultClientOrderId(attempt: number, emergencyMarket: boolean): string {
  const timestamp = Date.now().toString(36);
  const nonce = randomBytes(4).toString("hex");
  return `mf${emergencyMarket ? "e" : "p"}${timestamp}${attempt.toString(36)}${nonce}`.slice(0, 30);
}

function makerSafePrice(
  side: "buy" | "sell",
  bid: number,
  ask: number,
  tick: number,
  targetPrice?: number,
): number {
  if (!finitePositive(bid) || !finitePositive(ask) || ask <= bid || !finitePositive(tick)) {
    throw new Error("INVALID_ORDER_BOOK_OR_TICK_SIZE");
  }

  let price = side === "buy"
    ? quantize(ask - tick, tick, "floor")
    : quantize(bid + tick, tick, "ceil");

  if (finitePositive(targetPrice)) {
    price = side === "buy"
      ? quantize(Math.min(price, targetPrice), tick, "floor")
      : quantize(Math.max(price, targetPrice), tick, "ceil");
  }

  // 浮點量化後再次 fail-closed 檢查；不得把普通 limit 當作 fallback。
  if (!finitePositive(price) || (side === "buy" ? price >= ask : price <= bid)) {
    throw new Error("POST_ONLY_PRICE_WOULD_CROSS_BOOK");
  }
  return price;
}

function rejectedResult(message: string, intent: MakerFirstOrderIntent): OrderResult {
  return {
    success: false,
    rawResponse: JSON.stringify({
      policy: MAKER_FIRST_POLICY_VERSION,
      rejected: message,
    }),
    errorMessage: message,
    executionStatus: "cancelled",
    policyAudit: {
      policyVersion: MAKER_FIRST_POLICY_VERSION,
      executionClass: intent.executionClass ?? "MAKER_ONLY",
      emergencyReason: intent.emergencyReason,
      attempts: 0,
      fallbackUsed: false,
      requestedSize: intent.size,
      filledSize: 0,
      remainingSize: intent.size,
      finalOrderType: "none",
      clientOrderIds: [],
    },
  };
}

function aggregateCloseResults(results: OrderResult[]): OrderResult {
  if (results.length === 0) {
    return {
      success: true,
      rawResponse: JSON.stringify({ policy: MAKER_FIRST_POLICY_VERSION, skipped: "NO_OPEN_POSITION" }),
      executionStatus: "filled",
      executedReduceOnly: true,
      childResults: [],
    };
  }
  return {
    success: results.every(result => result.success),
    orderId: results.map(result => result.orderId).filter(Boolean).join(",") || undefined,
    rawResponse: JSON.stringify({ childResults: results.map(result => result.rawResponse) }),
    errorMessage: results.find(result => !result.success)?.errorMessage,
    filledSize: results.reduce((sum, result) => sum + (result.filledSize ?? 0), 0),
    childResults: results,
    executionStatus: results.every(result => result.executionStatus === "filled") ? "filled" : "unknown",
    executedReduceOnly: true,
  };
}

/**
 * 方案 B 的唯一 mutation 核心。
 *
 * 注意：這裡只有 request-scoped、可注入的 bounded sleep，沒有 setInterval／背景 timer。
 * Autoscale 重啟恢復與跨 request 掃描由持久化 Heartbeat worker 負責；本函式不承諾
 * process-lifetime 計時器。所有 exchange mutation 前必須先成功寫入 append-only 稽核。
 */
export async function executeMakerFirst(
  adapter: ExchangeAdapter,
  identity: MakerFirstAuditIdentity,
  intent: MakerFirstOrderIntent,
  config: Readonly<MakerFirstPolicyConfig> = DEFAULT_MAKER_FIRST_POLICY,
  dependencies: MakerFirstDependencies = {},
): Promise<OrderResult> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const createClientOrderId = dependencies.createClientOrderId ?? defaultClientOrderId;
  const writeAudit = dependencies.recordEvent ?? recordOrderPolicyEvent;
  const executionClass = intent.executionClass ?? "MAKER_ONLY";
  const emergencyReason = intent.emergencyReason;
  const requestedSize = intent.size;
  const resumeState = dependencies.resumeState;
  const policyRunId = resumeState?.policyRunId ?? createClientOrderId(0, false);

  const rejectPreflight = async (reasonCode: string): Promise<OrderResult> => {
    const clientOrderId = policyRunId;
    try {
      const ok = await writeAudit({
        policyRunId,
        userId: identity.userId,
        apiKeyId: identity.apiKeyId,
        strategyId: intent.policyContext?.strategyId,
        signalId: intent.policyContext?.signalId,
        exchange: adapter.exchange,
        eventType: "FAILED",
        executionClass,
        emergencyReason,
        clientOrderId,
        symbol: intent.symbol,
        side: intent.side,
        reduceOnly: intent.reduceOnly ?? false,
        attempt: 0,
        requestedSize: decimal(Number.isFinite(requestedSize) ? requestedSize : 0),
        filledSize: "0.000000000000",
        remainingSize: decimal(Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : 0),
        reasonCode,
        message: "Maker-First preflight fail-closed",
        details: {
          policyVersion: MAKER_FIRST_POLICY_VERSION,
          source: intent.policyContext?.source,
        },
        eventAt: now(),
      });
      if (!ok) return rejectedResult("ORDER_POLICY_AUDIT_UNAVAILABLE", intent);
    } catch {
      return rejectedResult("ORDER_POLICY_AUDIT_UNAVAILABLE", intent);
    }
    return rejectedResult(reasonCode, intent);
  };

  if (!Number.isInteger(identity.userId) || identity.userId <= 0 || !Number.isInteger(identity.apiKeyId) || identity.apiKeyId <= 0) {
    return rejectedResult("ORDER_POLICY_AUDIT_IDENTITY_MISSING", intent);
  }
  if (!finitePositive(requestedSize)) return rejectPreflight("INVALID_ORDER_SIZE");
  if (executionClass === "EMERGENCY_EXIT" && (!intent.reduceOnly || !emergencyReason || !APPROVED_EMERGENCY_REASONS.has(emergencyReason))) {
    return rejectPreflight("UNAUTHORIZED_EMERGENCY_EXIT");
  }
  if (executionClass === "MAKER_ONLY" && emergencyReason) {
    return rejectPreflight("EMERGENCY_REASON_WITHOUT_EMERGENCY_CLASS");
  }

  const maxAttempts = executionClass === "EMERGENCY_EXIT"
    ? config.emergencyMakerAttempts
    : config.standardMaxAttempts;
  const ttlMs = executionClass === "EMERGENCY_EXIT"
    ? config.emergencyTtlMs
    : config.standardTtlMs;
  const baseClientOrderId = policyRunId;
  const clientOrderIds: string[] = [];
  let totalFilled = clampFilled(resumeState?.initialFilledSize ?? 0, requestedSize);
  let attempts = Math.max(0, Math.trunc(resumeState?.completedMakerAttempts ?? 0));
  let activeOrder: { orderId: string; clientOrderId: string } | undefined;
  let lastRawResponse = "{}";
  let lastTruth: Partial<OrderResult> = {};

  const remaining = () => Math.max(0, requestedSize - totalFilled);
  const audit = async (
    eventType: InsertOrderPolicyEvent["eventType"],
    input: {
      clientOrderId?: string;
      exchangeOrderId?: string;
      attempt?: number;
      price?: number;
      reasonCode?: string;
      message?: string;
      details?: Record<string, unknown>;
    } = {},
  ) => {
    const ok = await writeAudit({
      policyRunId,
      userId: identity.userId,
      apiKeyId: identity.apiKeyId,
      strategyId: intent.policyContext?.strategyId,
      signalId: intent.policyContext?.signalId,
      exchange: adapter.exchange,
      eventType,
      executionClass,
      emergencyReason,
      clientOrderId: input.clientOrderId ?? baseClientOrderId,
      exchangeOrderId: input.exchangeOrderId,
      symbol: intent.symbol,
      side: intent.side,
      reduceOnly: intent.reduceOnly ?? false,
      attempt: input.attempt ?? attempts,
      requestedSize: decimal(requestedSize),
      filledSize: decimal(totalFilled),
      remainingSize: decimal(remaining()),
      price: input.price === undefined ? undefined : decimal(input.price),
      reasonCode: input.reasonCode ?? intent.policyContext?.reasonCode,
      message: input.message,
      details: {
        policyVersion: MAKER_FIRST_POLICY_VERSION,
        source: intent.policyContext?.source,
        ...input.details,
      },
      eventAt: now(),
    });
    if (!ok) throw new AuditUnavailableError();
  };

  const applyTruth = async (
    truth: Partial<OrderResult>,
    childRequested: number,
    childPreviouslyFilled: number,
    clientOrderId: string,
    orderId: string,
    attempt: number,
    price: number,
  ): Promise<{ childFilled: number; complete: boolean }> => {
    lastTruth = { ...lastTruth, ...truth };
    const reported = truth.executionStatus === "filled" && !finitePositive(truth.filledSize)
      ? childRequested
      : clampFilled(truth.filledSize ?? 0, childRequested);
    const childFilled = Math.max(childPreviouslyFilled, reported);
    const delta = Math.max(0, childFilled - childPreviouslyFilled);
    if (delta > 0) {
      totalFilled = Math.min(requestedSize, totalFilled + delta);
      await audit(remaining() <= 1e-12 ? "MAKER_FILLED" : "MAKER_PARTIAL", {
        clientOrderId,
        exchangeOrderId: orderId,
        attempt,
        price,
        details: { executionStatus: truth.executionStatus, childFilled },
      });
    }
    return {
      childFilled,
      complete: remaining() <= 1e-12 || truth.executionStatus === "filled",
    };
  };

  try {
    await audit("INTENT_RECEIVED", {
      reasonCode: resumeState ? "RECOVERY_RESUMED" : intent.policyContext?.reasonCode ?? "MAKER_FIRST_INTENT",
      details: {
        recoveryResume: resumeState ? {
          initialFilledSize: totalFilled,
          completedMakerAttempts: attempts,
        } : undefined,
        recoverableIntent: {
          symbol: intent.symbol,
          side: intent.side,
          size: intent.size,
          targetPrice: intent.targetPrice,
          reduceOnly: intent.reduceOnly ?? false,
          leverage: intent.leverage,
          posSide: intent.posSide,
          executionClass,
          emergencyReason,
          policyContext: intent.policyContext,
        },
        policyConfig: config,
      },
    });

    const instrument = await adapter.probeInstrument(intent.symbol);
    const tick = instrument.priceStep;
    if (!instrument.exists || !instrument.active || !finitePositive(tick)) {
      await audit("FAILED", {
        reasonCode: "PRICE_STEP_UNAVAILABLE",
        message: "無有效 tick size，已拒絕送單",
        details: { instrument },
      });
      return rejectedResult("PRICE_STEP_UNAVAILABLE", intent);
    }

    for (let attempt = attempts + 1; attempt <= maxAttempts && remaining() > 1e-12; attempt++) {
      attempts = attempt;
      const quote = await adapter.getBestBidAsk(intent.symbol);
      const price = makerSafePrice(intent.side, quote.bid, quote.ask, tick, intent.targetPrice);
      const clientOrderId = createClientOrderId(attempt, false);
      clientOrderIds.push(clientOrderId);
      const childRequested = remaining();

      await audit("MAKER_SUBMIT", {
        clientOrderId,
        attempt,
        price,
        reasonCode: "POST_ONLY_SUBMIT",
        details: { quote, tick, childRequested },
      });

      const submitted = await adapter.placeOrder({
        symbol: intent.symbol,
        side: intent.side,
        orderType: "limit",
        size: childRequested,
        price,
        reduceOnly: intent.reduceOnly,
        leverage: intent.leverage,
        posSide: intent.posSide,
        postOnly: true,
        clientOrderId,
        executionClass,
        emergencyReason,
        policyContext: intent.policyContext,
      });
      lastRawResponse = submitted.rawResponse;

      if (!submitted.success || !submitted.orderId) {
        await audit("MAKER_REJECTED", {
          clientOrderId,
          attempt,
          price,
          reasonCode: "POST_ONLY_REJECTED",
          message: submitted.errorMessage,
          details: { rawResponse: submitted.rawResponse },
        });
        if (attempt < maxAttempts) await sleep(Math.min(config.pollIntervalMs, ttlMs));
        continue;
      }

      const orderId = submitted.orderId;
      activeOrder = { orderId, clientOrderId };
      await audit("MAKER_ACCEPTED", {
        clientOrderId,
        exchangeOrderId: orderId,
        attempt,
        price,
      });

      let childFilled = 0;
      if (finitePositive(submitted.filledSize) || submitted.executionStatus === "filled") {
        const applied = await applyTruth(submitted, childRequested, childFilled, clientOrderId, orderId, attempt, price);
        childFilled = applied.childFilled;
        if (applied.complete) {
          activeOrder = undefined;
          break;
        }
      }

      const deadline = now() + ttlMs;
      const maxPolls = Math.max(1, Math.ceil(ttlMs / Math.max(1, config.pollIntervalMs)) + 2);
      let polls = 0;
      let exchangeCancelled = false;
      while (now() < deadline && polls < maxPolls && remaining() > 1e-12) {
        polls += 1;
        const truth = await adapter.getOrderExecutionTruth(intent.symbol, orderId, Boolean(intent.reduceOnly));
        const applied = await applyTruth(truth, childRequested, childFilled, clientOrderId, orderId, attempt, price);
        childFilled = applied.childFilled;
        if (applied.complete) {
          activeOrder = undefined;
          break;
        }
        if (truth.executionStatus === "cancelled") {
          exchangeCancelled = true;
          activeOrder = undefined;
          await audit("MAKER_REJECTED", {
            clientOrderId,
            exchangeOrderId: orderId,
            attempt,
            price,
            reasonCode: "POST_ONLY_CANCELLED_BY_EXCHANGE",
          });
          break;
        }
        await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadline - now())));
      }

      if (remaining() <= 1e-12) break;
      if (exchangeCancelled) continue;

      await audit("MAKER_CANCEL_REQUESTED", {
        clientOrderId,
        exchangeOrderId: orderId,
        attempt,
        price,
        reasonCode: "MAKER_TTL_EXPIRED",
      });
      const cancelled = await adapter.cancelOrder(intent.symbol, orderId);
      const finalTruth = await adapter.getOrderExecutionTruth(intent.symbol, orderId, Boolean(intent.reduceOnly));
      const applied = await applyTruth(finalTruth, childRequested, childFilled, clientOrderId, orderId, attempt, price);
      childFilled = applied.childFilled;
      if (applied.complete) {
        activeOrder = undefined;
        break;
      }
      if (!cancelled.success && finalTruth.executionStatus !== "cancelled") {
        await audit("FAILED", {
          clientOrderId,
          exchangeOrderId: orderId,
          attempt,
          price,
          reasonCode: "CANCEL_NOT_CONFIRMED",
          message: cancelled.errorMessage,
          details: { cancelRawResponse: cancelled.rawResponse, finalTruth },
        });
        return {
          success: false,
          orderId,
          rawResponse: cancelled.rawResponse,
          errorMessage: "撤單未確認，為避免同一 intent 同時存在兩張 live 訂單，已 fail-closed",
          filledSize: totalFilled || undefined,
          ...lastTruth,
          policyAudit: {
            policyVersion: MAKER_FIRST_POLICY_VERSION,
            executionClass,
            emergencyReason,
            attempts,
            fallbackUsed: false,
            requestedSize,
            filledSize: totalFilled,
            remainingSize: remaining(),
            finalOrderType: "post_only",
            clientOrderIds,
          },
        };
      }
      activeOrder = undefined;
      await audit("MAKER_CANCELLED", {
        clientOrderId,
        exchangeOrderId: orderId,
        attempt,
        price,
        details: { childFilled },
      });
    }

    if (remaining() <= 1e-12) {
      return {
        success: true,
        rawResponse: lastRawResponse,
        filledSize: totalFilled,
        executionStatus: "filled",
        executedSide: intent.side,
        executedReduceOnly: intent.reduceOnly ?? false,
        ...lastTruth,
        policyAudit: {
          policyVersion: MAKER_FIRST_POLICY_VERSION,
          executionClass,
          emergencyReason,
          attempts,
          fallbackUsed: false,
          requestedSize,
          filledSize: totalFilled,
          remainingSize: 0,
          finalOrderType: "post_only",
          clientOrderIds,
        },
      };
    }

    if (executionClass === "EMERGENCY_EXIT" && !emergencyTakerEnabled(config, emergencyReason)) {
      await audit("MAKER_EXPIRED", {
        attempt: attempts,
        reasonCode: "EMERGENCY_TAKER_DISABLED",
        message: `${emergencyReason ?? "UNKNOWN"} 的 taker fallback 已由使用者政策關閉；剩餘量不轉市價`,
      });
      return {
        success: false,
        rawResponse: lastRawResponse,
        errorMessage: "緊急 maker-only 嘗試已達上限；此原因的 taker fallback 已關閉",
        filledSize: totalFilled || undefined,
        executionStatus: totalFilled > 0 ? "partially_filled" : "cancelled",
        executedSide: intent.side,
        executedReduceOnly: true,
        policyAudit: {
          policyVersion: MAKER_FIRST_POLICY_VERSION,
          executionClass,
          emergencyReason,
          attempts,
          fallbackUsed: false,
          requestedSize,
          filledSize: totalFilled,
          remainingSize: remaining(),
          finalOrderType: "post_only",
          clientOrderIds,
        },
      };
    }

    if (executionClass === "EMERGENCY_EXIT") {
      const emergencyClientOrderId = createClientOrderId(attempts + 1, true);
      clientOrderIds.push(emergencyClientOrderId);
      await audit("EMERGENCY_FALLBACK", {
        clientOrderId: emergencyClientOrderId,
        attempt: attempts + 1,
        reasonCode: emergencyReason,
        message: `${config.emergencyTtlMs}ms × ${config.emergencyMakerAttempts} 次 maker-only 後，對剩餘量啟用已批准 taker 緊急退出`,
      });
      const marketRequested = remaining();
      const market = await adapter.placeOrder({
        symbol: intent.symbol,
        side: intent.side,
        orderType: "market",
        size: marketRequested,
        reduceOnly: true,
        leverage: intent.leverage,
        posSide: intent.posSide,
        clientOrderId: emergencyClientOrderId,
        executionClass,
        emergencyReason,
        policyContext: intent.policyContext,
      });
      lastRawResponse = market.rawResponse;
      if (!market.success) {
        await audit("FAILED", {
          clientOrderId: emergencyClientOrderId,
          exchangeOrderId: market.orderId,
          attempt: attempts + 1,
          reasonCode: "EMERGENCY_TAKER_REJECTED",
          message: market.errorMessage,
        });
        return {
          ...market,
          filledSize: totalFilled || market.filledSize,
          policyAudit: {
            policyVersion: MAKER_FIRST_POLICY_VERSION,
            executionClass,
            emergencyReason,
            attempts,
            fallbackUsed: true,
            requestedSize,
            filledSize: totalFilled,
            remainingSize: remaining(),
            finalOrderType: "market",
            clientOrderIds,
          },
        };
      }

      let marketTruth: Partial<OrderResult> = market;
      if (market.orderId && !finitePositive(market.filledSize)) {
        marketTruth = {
          ...market,
          ...await adapter.getOrderExecutionTruth(intent.symbol, market.orderId, true),
        };
      }
      const marketFilled = marketTruth.executionStatus === "filled" && !finitePositive(marketTruth.filledSize)
        ? marketRequested
        : clampFilled(marketTruth.filledSize ?? marketRequested, marketRequested);
      totalFilled = Math.min(requestedSize, totalFilled + marketFilled);
      await audit("EMERGENCY_FILLED", {
        clientOrderId: emergencyClientOrderId,
        exchangeOrderId: market.orderId,
        attempt: attempts + 1,
        reasonCode: emergencyReason,
        details: { marketFilled, executionStatus: marketTruth.executionStatus },
      });
      return {
        ...market,
        ...marketTruth,
        success: remaining() <= 1e-12,
        filledSize: totalFilled,
        errorMessage: remaining() <= 1e-12 ? undefined : "緊急 taker 仍有未成交剩餘量",
        policyAudit: {
          policyVersion: MAKER_FIRST_POLICY_VERSION,
          executionClass,
          emergencyReason,
          attempts,
          fallbackUsed: true,
          requestedSize,
          filledSize: totalFilled,
          remainingSize: remaining(),
          finalOrderType: "market",
          clientOrderIds,
        },
      };
    }

    await audit("MAKER_EXPIRED", {
      attempt: attempts,
      reasonCode: intent.reduceOnly ? "NORMAL_CLOSE_PENDING" : "ENTRY_EXPIRED",
      message: "Maker-only 嘗試已達上限；剩餘量不允許轉市價",
    });
    return {
      success: false,
      rawResponse: lastRawResponse,
      errorMessage: intent.reduceOnly
        ? "正常平倉 maker-only 尚未完全成交；剩餘量維持待處理，絕不自動轉市價"
        : "開倉／加倉 maker-only 已逾期；剩餘量已取消，絕不轉市價",
      filledSize: totalFilled || undefined,
      executionStatus: totalFilled > 0 ? "partially_filled" : "cancelled",
      executedSide: intent.side,
      executedReduceOnly: intent.reduceOnly ?? false,
      policyAudit: {
        policyVersion: MAKER_FIRST_POLICY_VERSION,
        executionClass,
        emergencyReason,
        attempts,
        fallbackUsed: false,
        requestedSize,
        filledSize: totalFilled,
        remainingSize: remaining(),
        finalOrderType: "post_only",
        clientOrderIds,
      },
    };
  } catch (error) {
    if (activeOrder) {
      try {
        await adapter.cancelOrder(intent.symbol, activeOrder.orderId);
      } catch {
        // 稽核不可用時只能 best-effort 撤單；不得再建立第二張訂單。
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      rawResponse: JSON.stringify({ policy: MAKER_FIRST_POLICY_VERSION, error: message }),
      errorMessage: message === "ORDER_POLICY_AUDIT_UNAVAILABLE"
        ? "訂單政策稽核不可用，已 fail-closed 拒絕／停止送單"
        : `Maker-First 執行失敗：${message}`,
      filledSize: totalFilled || undefined,
      executionStatus: totalFilled > 0 ? "partially_filled" : "cancelled",
      policyAudit: {
        policyVersion: MAKER_FIRST_POLICY_VERSION,
        executionClass,
        emergencyReason,
        attempts,
        fallbackUsed: false,
        requestedSize,
        filledSize: totalFilled,
        remainingSize: remaining(),
        finalOrderType: attempts > 0 ? "post_only" : "none",
        clientOrderIds,
      },
    };
  }
}

async function executeClosePositions(
  adapter: ExchangeAdapter,
  identity: MakerFirstAuditIdentity,
  symbol: string,
  posSide: "long" | "short" | "net" | undefined,
  options: CloseExecutionOptions | undefined,
  config: Readonly<MakerFirstPolicyConfig>,
  dependencies: MakerFirstDependencies,
): Promise<OrderResult> {
  const positions = (await adapter.getPositions(symbol)).filter(position => {
    if (position.symbol.replace(/[-_/]/g, "").toUpperCase() !== symbol.replace(/[-_/]/g, "").toUpperCase()) return false;
    return !posSide || posSide === "net" || position.side === posSide;
  });
  const results: OrderResult[] = [];
  for (const position of positions) {
    results.push(await executeMakerFirst(adapter, identity, {
      symbol,
      side: position.side === "long" ? "sell" : "buy",
      size: position.size,
      reduceOnly: true,
      posSide: position.side,
      executionClass: options?.executionClass,
      emergencyReason: options?.emergencyReason,
      policyContext: options?.policyContext,
    }, config, dependencies));
  }
  return aggregateCloseResults(results);
}

/**
 * Factory 層強制套用的 Proxy：攔截所有 mutation；readonly 方法仍綁定原 adapter。
 */
export type MakerFirstPolicySource = Readonly<MakerFirstPolicyConfig>
  | (() => Promise<Readonly<MakerFirstPolicyConfig>>);

async function resolvePolicyConfig(source: MakerFirstPolicySource): Promise<Readonly<MakerFirstPolicyConfig>> {
  return typeof source === "function" ? source() : source;
}

export function createMakerFirstAdapter(
  adapter: ExchangeAdapter,
  identity: MakerFirstAuditIdentity,
  config: MakerFirstPolicySource = DEFAULT_MAKER_FIRST_POLICY,
  dependencies: MakerFirstDependencies = {},
): ExchangeAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "placeOrder") {
        return async (params: OrderParams): Promise<OrderResult> => executeMakerFirst(
          target,
          identity,
          {
            symbol: params.symbol,
            side: params.side,
            size: params.size,
            targetPrice: params.price,
            reduceOnly: params.reduceOnly,
            leverage: params.leverage,
            posSide: params.posSide,
            executionClass: params.executionClass,
            emergencyReason: params.emergencyReason,
            policyContext: params.policyContext,
          },
          await resolvePolicyConfig(config),
          dependencies,
        );
      }
      if (property === "closePosition") {
        return async (
          symbol: string,
          posSide?: "long" | "short" | "net",
          options?: CloseExecutionOptions,
        ): Promise<OrderResult> => executeClosePositions(
          target,
          identity,
          symbol,
          posSide,
          options,
          await resolvePolicyConfig(config),
          dependencies,
        );
      }
      if (property === "closePositionSmart") {
        return async (
          symbol: string,
          posSide?: "long" | "short" | "net",
          _timeoutMs?: number,
          _priceOffsetPct?: number,
          options?: CloseExecutionOptions,
        ): Promise<OrderResult> => executeClosePositions(
          target,
          identity,
          symbol,
          posSide,
          options,
          await resolvePolicyConfig(config),
          dependencies,
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
