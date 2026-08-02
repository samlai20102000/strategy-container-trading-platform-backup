import { createHash } from "node:crypto";
import type { Strategy } from "../../drizzle/schema";
import type { CandidateIntent, ModeDecision } from "../../shared/executionModes";
import {
  authorizeRuntimeModeAction,
  runtimeModeRejectionMessage,
  type RuntimeModeAuthorization,
  type RuntimeModeGuardInput,
} from "../services/runtimeModeGuard";
import type {
  CloseExecutionOptions,
  ExchangeAdapter,
  OrderParams,
  OrderResult,
} from "./types";

export interface RuntimeGuardedAdapterContext {
  strategy: Pick<Strategy,
    | "id"
    | "userId"
    | "apiKeyId"
    | "deploymentKey"
    | "executionMode"
    | "executionPolicy"
    | "activationState"
    | "symbol"
  >;
  source: CandidateIntent["source"];
  /** 同一外部事件重試必須維持相同值。 */
  eventKey: string;
  signalId?: number;
  barTimestamp?: number;
  reason?: string;
  cycleId?: string | null;
  legId?: string | null;
  signalPrice?: number;
}

export type RuntimeAuthorizer = (
  input: RuntimeModeGuardInput,
) => Promise<RuntimeModeAuthorization>;

function stableOperationKey(
  context: RuntimeGuardedAdapterContext,
  operation: string,
  details: unknown,
  externalEventKey?: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ operation, details }))
    .digest("hex")
    .slice(0, 20);
  const eventKey = externalEventKey?.trim() || context.eventKey;
  return `${eventKey}:${operation}:${digest}`.slice(0, 180);
}

function rejectedResult(message: string, decision?: ModeDecision): OrderResult {
  return {
    success: false,
    errorMessage: message,
    rawResponse: JSON.stringify({
      blockedBy: "THREE_MODE_RUNTIME_GATE",
      reasonCode: decision?.reasonCode,
      outcome: decision?.outcome,
      decisionId: decision?.decisionId,
    }),
    executionStatus: "cancelled",
  };
}

function approvedPositionSide(decision: ModeDecision, fallback?: "long" | "short") {
  if (decision.targetSide === "LONG") return "long" as const;
  if (decision.targetSide === "SHORT") return "short" as const;
  return fallback;
}

function closeLegs(decision: ModeDecision): Array<{ legId?: string; side: "long" | "short"; quantity: number }> {
  const raw = decision.contextSnapshot.closeLegs;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (row.side !== "LONG" && row.side !== "SHORT") return [];
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return [];
    return [{
      legId: typeof row.legId === "string" ? row.legId : undefined,
      side: row.side === "LONG" ? "long" as const : "short" as const,
      quantity,
    }];
  });
}

async function authorize(
  adapter: ExchangeAdapter,
  context: RuntimeGuardedAdapterContext,
  authorizer: RuntimeAuthorizer,
  input: {
    operation: string;
    action: "buy" | "sell" | "close";
    details: unknown;
    externalEventKey?: string;
    requestedQuantity?: number;
    positionSide?: "long" | "short";
    price?: number;
  },
): Promise<RuntimeModeAuthorization> {
  return authorizer({
    strategy: context.strategy,
    adapter,
    signal: {
      action: input.action,
      price: input.price ?? context.signalPrice,
      barTimestamp: context.barTimestamp,
      reason: context.reason,
      requestedQuantity: input.requestedQuantity,
      positionSide: input.positionSide,
      source: context.source,
      eventKey: stableOperationKey(context, input.operation, input.details, input.externalEventKey),
    },
    signalId: context.signalId ?? 0,
    cycleId: context.cycleId,
    legId: context.legId,
  });
}

function combineCloseResults(results: OrderResult[]): OrderResult {
  const failed = results.find(result => !result.success);
  if (failed) {
    return {
      ...failed,
      childResults: results,
      rawResponse: JSON.stringify({ childResults: results.map(result => result.rawResponse) }),
    };
  }
  return {
    success: true,
    orderId: results.map(result => result.orderId).filter(Boolean).join(",") || undefined,
    rawResponse: JSON.stringify({ childResults: results.map(result => result.rawResponse) }),
    childResults: results,
    executionStatus: results.every(result => result.executionStatus === "filled") ? "filled" : "unknown",
    executedReduceOnly: true,
  };
}

/**
 * 將所有會改變交易所狀態的下單／平倉方法置於 canonical mode Gate 後。
 * probe、balance、positions、cancel 與其他 readonly/helper 方法保持原 adapter 行為。
 */
export function createRuntimeGuardedAdapter(
  adapter: ExchangeAdapter,
  context: RuntimeGuardedAdapterContext,
  authorizer: RuntimeAuthorizer = authorizeRuntimeModeAction,
): ExchangeAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "placeOrder") {
        return async (params: OrderParams): Promise<OrderResult> => {
          const isClose = params.reduceOnly === true;
          const externalEventKey = params.policyContext?.intentKey
            ?? (isClose ? params.clientOrderId : undefined);
          const intentKey = stableOperationKey(context, "placeOrder", {
            symbol: params.symbol,
            side: params.side,
            size: params.size,
            posSide: params.posSide,
            reduceOnly: isClose,
          }, externalEventKey);
          const gate = await authorize(target, context, authorizer, {
            operation: "placeOrder",
            action: isClose ? "close" : params.side,
            details: params,
            externalEventKey,
            requestedQuantity: params.size,
            positionSide: params.posSide as "long" | "short" | undefined,
            price: params.price,
          });
          if (!gate.allowed) {
            return rejectedResult(runtimeModeRejectionMessage(gate), gate.envelope.decision);
          }
          const decision = gate.envelope.decision;
          const advanced = decision.executionMode !== "SINGLE_EXCLUSIVE";
          const approvedLegs = closeLegs(decision);
          const approvedQuantity = Number(decision.approvedQuantity);
          const size = Number.isFinite(approvedQuantity) && approvedQuantity > 0
            ? approvedQuantity
            : params.size;
          const posSide = approvedPositionSide(decision, params.posSide);
          if (advanced && !posSide) {
            return rejectedResult("三模式執行 Gate 拒絕：ADVANCED_POSITION_SIDE_REQUIRED", decision);
          }
          if (advanced && isClose) {
            const approvedLeg = approvedLegs.find(leg => leg.side === posSide);
            if (!approvedLeg || !Number.isFinite(size) || size <= 0 || size > approvedLeg.quantity) {
              return rejectedResult("三模式執行 Gate 拒絕：LEG_SCOPED_CLOSE_MISMATCH", decision);
            }
            const expectedSide = posSide === "long" ? "sell" : "buy";
            if (params.side !== expectedSide) {
              return rejectedResult("三模式執行 Gate 拒絕：ADVANCED_CLOSE_SIDE_MISMATCH", decision);
            }
          }
          return target.placeOrder({
            ...params,
            size,
            posSide,
            reduceOnly: isClose || decision.reduceOnly === true,
            policyContext: {
              strategyId: context.strategy.id,
              signalId: context.signalId,
              source: context.source,
              reasonCode: context.reason,
              ...params.policyContext,
              intentKey,
            },
          });
        };
      }

      if (property === "closePosition" || property === "closePositionSmart") {
        return async (
          symbol: string,
          posSide?: "long" | "short",
          timeoutMsOrOptions?: number | CloseExecutionOptions,
          priceOffsetPct?: number,
          clientOrderIdFromCaller?: string,
          smartOptions?: CloseExecutionOptions,
        ): Promise<OrderResult> => {
          const options = property === "closePosition"
            ? (typeof timeoutMsOrOptions === "object" ? timeoutMsOrOptions : undefined)
            : smartOptions;
          const externalEventKey = options?.policyContext?.intentKey ?? clientOrderIdFromCaller;
          const intentKey = stableOperationKey(
            context,
            String(property),
            { symbol, posSide },
            externalEventKey,
          );
          const policyContext = {
            strategyId: context.strategy.id,
            signalId: context.signalId,
            source: context.source,
            reasonCode: context.reason,
            ...options?.policyContext,
            intentKey,
          };
          const gate = await authorize(target, context, authorizer, {
            operation: String(property),
            action: "close",
            details: { symbol, posSide, options: { ...options, policyContext } },
            externalEventKey,
            positionSide: posSide,
          });
          if (!gate.allowed) {
            return rejectedResult(runtimeModeRejectionMessage(gate), gate.envelope.decision);
          }
          const advanced = gate.envelope.decision.executionMode !== "SINGLE_EXCLUSIVE";
          const legs = closeLegs(gate.envelope.decision);
          if (!advanced) {
            return property === "closePosition"
              ? target.closePosition(symbol, posSide, { ...options, policyContext })
              : target.closePositionSmart(
                symbol,
                posSide,
                typeof timeoutMsOrOptions === "number" ? timeoutMsOrOptions : undefined,
                priceOffsetPct,
                // clientOrderId 應由調用者提供，這裡不自動生成
                clientOrderIdFromCaller,
                { ...options, policyContext },
              );
          }
          if (legs.length === 0) {
            return rejectedResult("三模式執行 Gate 拒絕：LEG_SCOPED_CLOSE_REQUIRED", gate.envelope.decision);
          }
          if (posSide && !legs.some(leg => leg.side === posSide)) {
            return rejectedResult("三模式執行 Gate 拒絕：LEG_SCOPED_CLOSE_MISMATCH", gate.envelope.decision);
          }
          const results: OrderResult[] = [];
          for (const leg of legs) {
            const legIntentKey = stableOperationKey(context, "advancedLegClose", {
              symbol,
              legId: leg.legId,
              side: leg.side,
              quantity: leg.quantity,
            }, intentKey);
            results.push(await target.placeOrder({
              symbol,
              side: leg.side === "long" ? "sell" : "buy",
              // Exchange order type 由 factory 層的中央政策決定；此處只表達腿級平倉意圖。
              orderType: "limit",
              size: leg.quantity,
              reduceOnly: true,
              posSide: leg.side,
              clientOrderId: `clOrdId_RUNTIME_LEG_CLOSE_${context.strategy.id}_${leg.legId || leg.side}`,
              executionClass: options?.executionClass,
              emergencyReason: options?.emergencyReason,
              policyContext: { ...policyContext, intentKey: legIntentKey },
            }));
          }
          return combineCloseResults(results);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
