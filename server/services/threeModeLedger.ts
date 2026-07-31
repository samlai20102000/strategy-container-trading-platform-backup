import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  executionDecisions,
  executionFills,
  executionOrderIntents,
  executionRiskReservations,
  hedgeRelationships,
  positionLegs,
  type ExecutionOrderIntent,
  type HedgeRelationship,
  type InsertExecutionDecisionRow,
  type InsertExecutionFill,
  type InsertExecutionOrderIntent,
  type InsertExecutionRiskReservation,
  type InsertHedgeRelationship,
  type InsertPositionLeg,
  type PositionLeg,
} from "../../drizzle/schema";
import type { ModeDecision } from "../../shared/executionModes";
import { getDb } from "../db";

const DECIMAL_SCALE = 8;

function boundedId(value: string): string {
  return value.replace(/\s+/g, "_").slice(0, 128);
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new Error("數值必須為有限數");
  return value.toFixed(DECIMAL_SCALE);
}

function positive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} 必須大於 0`);
  return value;
}

function extractInsertId(result: unknown): number {
  const raw = result as [{ insertId?: number }, ...unknown[]] | { insertId?: number };
  const header = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(header?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("資料庫未回傳有效 insertId");
  return id;
}

export type PositionLegStatus = NonNullable<InsertPositionLeg["status"]>;
export type OrderIntentStatus = NonNullable<InsertExecutionOrderIntent["status"]>;
export type HedgeRelationshipStatus = NonNullable<InsertHedgeRelationship["status"]>;

const LEG_TRANSITIONS: Readonly<Record<PositionLegStatus, readonly PositionLegStatus[]>> = {
  PENDING: ["OPEN", "BLOCKED", "RECONCILIATION_REQUIRED", "CLOSED"],
  OPEN: ["REDUCING", "CLOSED", "BLOCKED", "RECONCILIATION_REQUIRED"],
  REDUCING: ["OPEN", "CLOSED", "BLOCKED", "RECONCILIATION_REQUIRED"],
  CLOSED: [],
  RECONCILIATION_REQUIRED: ["OPEN", "REDUCING", "CLOSED", "BLOCKED"],
  BLOCKED: ["OPEN", "CLOSED", "RECONCILIATION_REQUIRED"],
};

const INTENT_TRANSITIONS: Readonly<Record<OrderIntentStatus, readonly OrderIntentStatus[]>> = {
  CREATED: ["SUBMITTING", "CANCELLED", "FAILED"],
  SUBMITTING: ["SUBMITTED", "FAILED", "RECONCILIATION_REQUIRED"],
  SUBMITTED: ["PARTIALLY_FILLED", "FILLED", "FAILED", "CANCELLED", "RECONCILIATION_REQUIRED"],
  PARTIALLY_FILLED: ["FILLED", "CANCELLED", "RECONCILIATION_REQUIRED"],
  FILLED: [],
  FAILED: ["RECONCILIATION_REQUIRED"],
  CANCELLED: [],
  RECONCILIATION_REQUIRED: ["SUBMITTED", "PARTIALLY_FILLED", "FILLED", "FAILED", "CANCELLED"],
};

const HEDGE_RELATIONSHIP_TRANSITIONS: Readonly<
  Record<HedgeRelationshipStatus, readonly HedgeRelationshipStatus[]>
> = {
  ARMING: ["ACTIVE", "BLOCKED", "CLOSED"],
  ACTIVE: ["UNWINDING", "BLOCKED", "CLOSED"],
  UNWINDING: ["ACTIVE", "BLOCKED", "CLOSED"],
  CLOSED: [],
  BLOCKED: ["ACTIVE", "UNWINDING", "CLOSED"],
};

export function canTransitionPositionLeg(from: PositionLegStatus, to: PositionLegStatus): boolean {
  return from === to || LEG_TRANSITIONS[from].includes(to);
}

export function canTransitionOrderIntent(from: OrderIntentStatus, to: OrderIntentStatus): boolean {
  return from === to || INTENT_TRANSITIONS[from].includes(to);
}

export function canTransitionHedgeRelationship(
  from: HedgeRelationshipStatus,
  to: HedgeRelationshipStatus,
): boolean {
  return from === to || HEDGE_RELATIONSHIP_TRANSITIONS[from].includes(to);
}

export interface RiskReservationEvaluationInput {
  equity: number;
  currentGrossNotional: number;
  currentMargin: number;
  outstandingReservedGross: number;
  outstandingReservedMargin: number;
  requestedGrossNotional: number;
  requestedMargin: number;
  maxGrossNotionalPct: number;
  maxMarginUsagePct: number;
  capabilityExpiresAt: number;
  now?: number;
}

export interface RiskReservationEvaluation {
  approved: boolean;
  reasonCode: string;
  projectedGrossNotional: number;
  projectedMargin: number;
  maximumGrossNotional: number;
  maximumMargin: number;
}

export function evaluateRiskReservation(input: RiskReservationEvaluationInput): RiskReservationEvaluation {
  const now = input.now ?? Date.now();
  const finite = Object.values(input).every(value => value === undefined || Number.isFinite(value));
  const maximumGrossNotional = input.equity * input.maxGrossNotionalPct / 100;
  const maximumMargin = input.equity * input.maxMarginUsagePct / 100;
  const projectedGrossNotional = input.currentGrossNotional
    + input.outstandingReservedGross
    + input.requestedGrossNotional;
  const projectedMargin = input.currentMargin
    + input.outstandingReservedMargin
    + input.requestedMargin;

  if (!finite || input.equity <= 0 || input.requestedGrossNotional <= 0 || input.requestedMargin < 0) {
    return {
      approved: false,
      reasonCode: "RISK_INPUT_INVALID",
      projectedGrossNotional,
      projectedMargin,
      maximumGrossNotional,
      maximumMargin,
    };
  }
  if (input.capabilityExpiresAt <= now) {
    return {
      approved: false,
      reasonCode: "CAPABILITY_STALE",
      projectedGrossNotional,
      projectedMargin,
      maximumGrossNotional,
      maximumMargin,
    };
  }
  if (projectedGrossNotional > maximumGrossNotional + 1e-8) {
    return {
      approved: false,
      reasonCode: "GROSS_BUDGET_EXCEEDED",
      projectedGrossNotional,
      projectedMargin,
      maximumGrossNotional,
      maximumMargin,
    };
  }
  if (projectedMargin > maximumMargin + 1e-8) {
    return {
      approved: false,
      reasonCode: "MARGIN_BUDGET_EXCEEDED",
      projectedGrossNotional,
      projectedMargin,
      maximumGrossNotional,
      maximumMargin,
    };
  }
  return {
    approved: true,
    reasonCode: "RISK_RESERVED",
    projectedGrossNotional,
    projectedMargin,
    maximumGrossNotional,
    maximumMargin,
  };
}

export interface CreatePositionLegInput extends Omit<InsertPositionLeg, "id" | "createdAt" | "updatedAt"> {}

export async function createOrGetPositionLeg(input: CreatePositionLegInput): Promise<{
  leg: PositionLeg;
  deduplicated: boolean;
}> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");

  const existing = await db.select().from(positionLegs).where(eq(positionLegs.legId, input.legId)).limit(1);
  if (existing[0]) return { leg: existing[0], deduplicated: true };

  try {
    await db.insert(positionLegs).values(input);
  } catch (error) {
    const raced = await db.select().from(positionLegs).where(eq(positionLegs.legId, input.legId)).limit(1);
    if (raced[0]) return { leg: raced[0], deduplicated: true };
    throw error;
  }
  const created = await db.select().from(positionLegs).where(eq(positionLegs.legId, input.legId)).limit(1);
  if (!created[0]) throw new Error("position leg 建立後無法讀回");
  return { leg: created[0], deduplicated: false };
}

export async function transitionPositionLeg(
  legId: string,
  nextStatus: PositionLegStatus,
  patch: Partial<Pick<InsertPositionLeg,
    "quantity" | "avgEntryPrice" | "realizedPnl" | "unrealizedPnl" | "martinState" | "riskState" | "openedAt" | "closedAt"
  >> = {},
): Promise<PositionLeg> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM position_legs WHERE legId = ${legId} FOR UPDATE`);
    const current = await tx.select().from(positionLegs).where(eq(positionLegs.legId, legId)).limit(1);
    if (!current[0]) throw new Error("position leg 不存在");
    if (!canTransitionPositionLeg(current[0].status, nextStatus)) {
      throw new Error(`非法 leg 狀態轉移：${current[0].status} → ${nextStatus}`);
    }
    await tx.update(positionLegs).set({ ...patch, status: nextStatus }).where(eq(positionLegs.legId, legId));
    const updated = await tx.select().from(positionLegs).where(eq(positionLegs.legId, legId)).limit(1);
    if (!updated[0]) throw new Error("position leg 更新後無法讀回");
    return updated[0];
  });
}

export interface CreateHedgeRelationshipInput extends Omit<
  InsertHedgeRelationship,
  "id" | "createdAt" | "updatedAt"
> {}

function assertMatchingHedgeRelationship(
  existing: HedgeRelationship,
  input: CreateHedgeRelationshipInput,
): void {
  const ratio = Number(input.targetRatio);
  const sameIdentity = existing.userId === input.userId
    && existing.strategyId === input.strategyId
    && existing.cycleId === input.cycleId
    && existing.primaryLegId === input.primaryLegId
    && existing.hedgeLegId === input.hedgeLegId
    && Math.abs(Number(existing.targetRatio) - ratio) <= 1e-6;
  if (!sameIdentity) {
    throw new Error("hedge relationship 冪等鍵衝突：relationshipId 已綁定不同腿或比例");
  }
}

function assertValidHedgeLegPair(
  legs: PositionLeg[],
  input: CreateHedgeRelationshipInput,
): void {
  const primary = legs.find(leg => leg.legId === input.primaryLegId);
  const hedge = legs.find(leg => leg.legId === input.hedgeLegId);
  if (!primary || !hedge) throw new Error("建立 hedge relationship 前，PRIMARY 與 HEDGE 腿必須已存在");
  if (primary.role !== "PRIMARY" || hedge.role !== "HEDGE") {
    throw new Error("hedge relationship 只允許 PRIMARY → HEDGE 角色配對");
  }
  if (primary.executionMode !== "HEDGE_GUARDED" || hedge.executionMode !== "HEDGE_GUARDED") {
    throw new Error("hedge relationship 只允許 H3 腿");
  }
  if (primary.side === hedge.side) throw new Error("PRIMARY 與 HEDGE 必須為相反方向");
  if (
    primary.userId !== input.userId
    || hedge.userId !== input.userId
    || primary.strategyId !== input.strategyId
    || hedge.strategyId !== input.strategyId
    || primary.cycleId !== input.cycleId
    || hedge.cycleId !== input.cycleId
  ) {
    throw new Error("PRIMARY 與 HEDGE 必須屬於同一使用者、策略與循環");
  }
  if (
    primary.apiKeyId !== hedge.apiKeyId
    || primary.exchange !== hedge.exchange
    || primary.symbol !== hedge.symbol
  ) {
    throw new Error("PRIMARY 與 HEDGE 必須屬於同一交易帳戶、交易所與交易對");
  }
  if (primary.status === "CLOSED" || hedge.status === "CLOSED") {
    throw new Error("已關閉腿不可建立 hedge relationship");
  }
}

export async function createOrGetHedgeRelationship(
  input: CreateHedgeRelationshipInput,
): Promise<{ relationship: HedgeRelationship; deduplicated: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  if (input.primaryLegId === input.hedgeLegId) throw new Error("PRIMARY 與 HEDGE 不可為同一腿");
  const targetRatio = Number(input.targetRatio);
  if (!Number.isFinite(targetRatio) || targetRatio <= 0 || targetRatio > 1) {
    throw new Error("targetRatio 必須大於 0 且不超過 1");
  }

  const normalizedInput: CreateHedgeRelationshipInput = {
    ...input,
    relationshipId: boundedId(input.relationshipId),
    primaryLegId: boundedId(input.primaryLegId),
    hedgeLegId: boundedId(input.hedgeLegId),
    cycleId: boundedId(input.cycleId),
    targetRatio: targetRatio.toFixed(6),
  };

  const existing = await db.select().from(hedgeRelationships)
    .where(eq(hedgeRelationships.relationshipId, normalizedInput.relationshipId))
    .limit(1);
  if (existing[0]) {
    assertMatchingHedgeRelationship(existing[0], normalizedInput);
    return { relationship: existing[0], deduplicated: true };
  }

  return db.transaction(async tx => {
    await tx.execute(sql`
      SELECT id FROM position_legs
      WHERE legId IN (${normalizedInput.primaryLegId}, ${normalizedInput.hedgeLegId})
      FOR UPDATE
    `);
    const legs = await tx.select().from(positionLegs)
      .where(inArray(positionLegs.legId, [normalizedInput.primaryLegId, normalizedInput.hedgeLegId]));
    assertValidHedgeLegPair(legs, normalizedInput);

    try {
      await tx.insert(hedgeRelationships).values(normalizedInput);
    } catch (error) {
      const raced = await tx.select().from(hedgeRelationships)
        .where(eq(hedgeRelationships.relationshipId, normalizedInput.relationshipId))
        .limit(1);
      if (!raced[0]) throw error;
      assertMatchingHedgeRelationship(raced[0], normalizedInput);
      return { relationship: raced[0], deduplicated: true };
    }
    const created = await tx.select().from(hedgeRelationships)
      .where(eq(hedgeRelationships.relationshipId, normalizedInput.relationshipId))
      .limit(1);
    if (!created[0]) throw new Error("hedge relationship 建立後無法讀回");
    return { relationship: created[0], deduplicated: false };
  });
}

export async function transitionHedgeRelationship(
  relationshipId: string,
  nextStatus: HedgeRelationshipStatus,
  patch: Partial<Pick<InsertHedgeRelationship, "unwindSnapshot" | "openedAt" | "closedAt">> = {},
): Promise<HedgeRelationship> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db.transaction(async tx => {
    await tx.execute(sql`
      SELECT id FROM hedge_relationships
      WHERE relationshipId = ${relationshipId}
      FOR UPDATE
    `);
    const current = await tx.select().from(hedgeRelationships)
      .where(eq(hedgeRelationships.relationshipId, relationshipId))
      .limit(1);
    if (!current[0]) throw new Error("hedge relationship 不存在");
    if (!canTransitionHedgeRelationship(current[0].status, nextStatus)) {
      throw new Error(`非法 hedge relationship 狀態轉移：${current[0].status} → ${nextStatus}`);
    }
    if (nextStatus === "UNWINDING" && !patch.unwindSnapshot && !current[0].unwindSnapshot) {
      throw new Error("進入 UNWINDING 前必須記錄 unwindSnapshot");
    }

    const auditedPatch: typeof patch = { ...patch };
    if (nextStatus === "ACTIVE" && !current[0].openedAt && !auditedPatch.openedAt) {
      auditedPatch.openedAt = new Date();
    }
    if (nextStatus === "CLOSED" && !current[0].closedAt && !auditedPatch.closedAt) {
      auditedPatch.closedAt = new Date();
    }
    await tx.update(hedgeRelationships)
      .set({ ...auditedPatch, status: nextStatus })
      .where(eq(hedgeRelationships.relationshipId, relationshipId));
    const updated = await tx.select().from(hedgeRelationships)
      .where(eq(hedgeRelationships.relationshipId, relationshipId))
      .limit(1);
    if (!updated[0]) throw new Error("hedge relationship 更新後無法讀回");
    return updated[0];
  });
}

export interface RecordModeDecisionInput {
  userId: number;
  strategyId: number;
  deploymentKey?: string | null;
  cycleId?: string | null;
  legId?: string | null;
  source: InsertExecutionDecisionRow["source"];
  candidateIntent: Record<string, unknown>;
  decision: ModeDecision;
}

export async function recordModeDecision(input: RecordModeDecisionInput): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  const existing = await db.select({ id: executionDecisions.id })
    .from(executionDecisions)
    .where(eq(executionDecisions.decisionId, input.decision.decisionId))
    .limit(1);
  if (existing[0]) return false;
  await db.insert(executionDecisions).values({
    decisionId: boundedId(input.decision.decisionId),
    candidateId: boundedId(input.decision.candidateId),
    userId: input.userId,
    strategyId: input.strategyId,
    deploymentKey: input.deploymentKey ?? null,
    cycleId: input.cycleId ?? null,
    legId: input.legId ?? input.decision.targetLegId ?? null,
    executionMode: input.decision.executionMode,
    source: input.source,
    outcome: input.decision.outcome,
    reasonCode: input.decision.reasonCode,
    candidateIntent: input.candidateIntent,
    contextSnapshot: input.decision.contextSnapshot,
    decision: input.decision,
  });
  return true;
}

export interface RecentModeDecision {
  decisionId: string;
  candidateId: string;
  deploymentKey: string | null;
  cycleId: string | null;
  legId: string | null;
  executionMode: InsertExecutionDecisionRow["executionMode"];
  source: InsertExecutionDecisionRow["source"];
  outcome: InsertExecutionDecisionRow["outcome"];
  reasonCode: string;
  createdAt: Date;
}

export async function listRecentModeDecisions(input: {
  userId: number;
  strategyId: number;
  limit?: number;
}): Promise<RecentModeDecision[]> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  return db.select({
    decisionId: executionDecisions.decisionId,
    candidateId: executionDecisions.candidateId,
    deploymentKey: executionDecisions.deploymentKey,
    cycleId: executionDecisions.cycleId,
    legId: executionDecisions.legId,
    executionMode: executionDecisions.executionMode,
    source: executionDecisions.source,
    outcome: executionDecisions.outcome,
    reasonCode: executionDecisions.reasonCode,
    createdAt: executionDecisions.createdAt,
  })
    .from(executionDecisions)
    .where(and(
      eq(executionDecisions.userId, input.userId),
      eq(executionDecisions.strategyId, input.strategyId),
    ))
    .orderBy(desc(executionDecisions.createdAt), desc(executionDecisions.id))
    .limit(limit);
}

export interface CreateOrderIntentInput {
  intentId?: string;
  idempotencyKey: string;
  decisionId: string;
  userId: number;
  strategyId: number;
  cycleId?: string | null;
  legId?: string | null;
  action: InsertExecutionOrderIntent["action"];
  side: InsertExecutionOrderIntent["side"];
  positionSide: InsertExecutionOrderIntent["positionSide"];
  reduceOnly: boolean;
  requestedQuantity: number;
  requestedPrice?: number | null;
  reasonCode: string;
}

export async function createOrderIntent(input: CreateOrderIntentInput): Promise<{
  intent: ExecutionOrderIntent;
  deduplicated: boolean;
}> {
  positive(input.requestedQuantity, "requestedQuantity");
  if ((input.action === "REDUCE" || input.action === "CLOSE") && !input.reduceOnly) {
    throw new Error("REDUCE／CLOSE intent 必須 reduceOnly");
  }
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  const existing = await db.select().from(executionOrderIntents)
    .where(eq(executionOrderIntents.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing[0]) return { intent: existing[0], deduplicated: true };

  const intentId = boundedId(input.intentId ?? `intent:${randomUUID()}`);
  try {
    await db.insert(executionOrderIntents).values({
      intentId,
      idempotencyKey: input.idempotencyKey.slice(0, 180),
      decisionId: boundedId(input.decisionId),
      userId: input.userId,
      strategyId: input.strategyId,
      cycleId: input.cycleId ?? null,
      legId: input.legId ?? null,
      action: input.action,
      side: input.side,
      positionSide: input.positionSide,
      reduceOnly: input.reduceOnly,
      requestedQuantity: decimal(input.requestedQuantity),
      requestedPrice: input.requestedPrice == null ? null : decimal(input.requestedPrice),
      reasonCode: input.reasonCode,
    });
  } catch (error) {
    const raced = await db.select().from(executionOrderIntents)
      .where(eq(executionOrderIntents.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (raced[0]) return { intent: raced[0], deduplicated: true };
    throw error;
  }
  const created = await db.select().from(executionOrderIntents)
    .where(eq(executionOrderIntents.intentId, intentId))
    .limit(1);
  if (!created[0]) throw new Error("order intent 建立後無法讀回");
  return { intent: created[0], deduplicated: false };
}

export async function transitionOrderIntent(
  intentId: string,
  nextStatus: OrderIntentStatus,
  patch: Partial<Pick<InsertExecutionOrderIntent, "exchangeOrderId" | "error">> = {},
): Promise<ExecutionOrderIntent> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM execution_order_intents WHERE intentId = ${intentId} FOR UPDATE`);
    const current = await tx.select().from(executionOrderIntents)
      .where(eq(executionOrderIntents.intentId, intentId))
      .limit(1);
    if (!current[0]) throw new Error("order intent 不存在");
    if (!canTransitionOrderIntent(current[0].status, nextStatus)) {
      throw new Error(`非法 order intent 狀態轉移：${current[0].status} → ${nextStatus}`);
    }
    await tx.update(executionOrderIntents).set({ ...patch, status: nextStatus })
      .where(eq(executionOrderIntents.intentId, intentId));
    const updated = await tx.select().from(executionOrderIntents)
      .where(eq(executionOrderIntents.intentId, intentId))
      .limit(1);
    if (!updated[0]) throw new Error("order intent 更新後無法讀回");
    return updated[0];
  });
}

export interface AppendExecutionFillInput extends Omit<InsertExecutionFill, "id" | "quantity" | "price" | "fee" | "filledAt" | "createdAt"> {
  quantity: number;
  price: number;
  fee?: number | null;
  filledAt: number | Date;
}

export async function appendExecutionFill(input: AppendExecutionFillInput): Promise<boolean> {
  positive(input.quantity, "quantity");
  positive(input.price, "price");
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  const existing = await db.select({ id: executionFills.id }).from(executionFills)
    .where(eq(executionFills.fillKey, input.fillKey))
    .limit(1);
  if (existing[0]) return false;
  await db.insert(executionFills).values({
    ...input,
    fillKey: input.fillKey.slice(0, 180),
    quantity: decimal(input.quantity),
    price: decimal(input.price),
    fee: input.fee == null ? null : decimal(input.fee),
    filledAt: input.filledAt instanceof Date ? input.filledAt : new Date(input.filledAt),
  });
  return true;
}

export interface ReserveRiskBudgetInput extends Omit<RiskReservationEvaluationInput,
  "outstandingReservedGross" | "outstandingReservedMargin" | "now"
> {
  reservationId?: string;
  decisionId: string;
  userId: number;
  strategyId: number;
  apiKeyId: number;
  symbol: string;
  ttlMs?: number;
}

export async function reserveRiskBudget(input: ReserveRiskBudgetInput): Promise<{
  reservationId?: string;
  evaluation: RiskReservationEvaluation;
}> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  const now = new Date();
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM api_keys WHERE id = ${input.apiKeyId} FOR UPDATE`);
    await tx.update(executionRiskReservations)
      .set({ status: "EXPIRED" })
      .where(and(
        eq(executionRiskReservations.apiKeyId, input.apiKeyId),
        eq(executionRiskReservations.status, "RESERVED"),
        lt(executionRiskReservations.expiresAt, now),
      ));
    const outstanding = await tx.select({
      gross: sql<string>`COALESCE(SUM(${executionRiskReservations.grossNotional}), 0)`,
      margin: sql<string>`COALESCE(SUM(${executionRiskReservations.estimatedMargin}), 0)`,
    }).from(executionRiskReservations).where(and(
      eq(executionRiskReservations.apiKeyId, input.apiKeyId),
      inArray(executionRiskReservations.status, ["RESERVED"]),
    ));
    const evaluation = evaluateRiskReservation({
      ...input,
      outstandingReservedGross: Number(outstanding[0]?.gross ?? 0),
      outstandingReservedMargin: Number(outstanding[0]?.margin ?? 0),
      now: now.getTime(),
    });
    if (!evaluation.approved) return { evaluation };

    const reservationId = boundedId(input.reservationId ?? `reservation:${randomUUID()}`);
    await tx.insert(executionRiskReservations).values({
      reservationId,
      decisionId: boundedId(input.decisionId),
      userId: input.userId,
      strategyId: input.strategyId,
      apiKeyId: input.apiKeyId,
      symbol: input.symbol,
      grossNotional: decimal(input.requestedGrossNotional),
      estimatedMargin: decimal(input.requestedMargin),
      status: "RESERVED",
      expiresAt: new Date(now.getTime() + Math.max(5_000, input.ttlMs ?? 30_000)),
    } satisfies InsertExecutionRiskReservation);
    return { reservationId, evaluation };
  });
}

export async function settleRiskReservation(
  reservationId: string,
  status: "COMMITTED" | "RELEASED" | "EXPIRED",
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  await db.update(executionRiskReservations).set({ status })
    .where(and(
      eq(executionRiskReservations.reservationId, reservationId),
      inArray(executionRiskReservations.status, ["RESERVED", "COMMITTED"]),
    ));
}
