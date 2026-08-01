import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  accountPositionSnapshots,
  apiKeys,
  executionOrderIntents,
  executionReconciliationCases,
  executionRiskReservations,
  hedgeRelationships,
  modeTransitions,
  positionLegs,
  strategies,
  type ApiKey,
  type InsertStrategy,
  type ModeTransition,
  type Strategy,
} from "../../drizzle/schema";
import {
  EXECUTION_POLICY_VERSION,
  createDefaultExecutionPolicy,
  normalizeExecutionModePolicy,
  type DeploymentActivationState,
  type ExecutionMode,
  type ExecutionPolicy,
} from "../../shared/executionModes";
import {
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  createKamaRainbowMartinDefaultConfig,
} from "../../shared/strategies/kamaRainbowMartin";
import { normalizeStrategyExecutionPolicy } from "../../shared/strategies/kamaRainbowMartinExecutionPolicy";
import type { ExchangeAdapter, Position } from "../exchanges/types";
import { getDb } from "../db";
import { generateWebhookSecret } from "../lib/crypto";
import {
  assertDeploymentTransitionAllowed,
  assertFreshPassingPreflight,
  lifecycleTargetForAction,
  type DeploymentDescriptor,
  type DeploymentLifecycleAction,
  type DeploymentPreflightFacts,
  type DeploymentPreflightReport,
} from "./deploymentLifecycle";
import {
  buildExecutionPolicyHash,
  capabilityManifestSupportsMode,
  type VersionedStrategyCapabilityManifest,
} from "./strategyArtifacts";
import {
  attachSnapshotConfig,
  getBoundStrategyConfig,
  pickStrategyConfigState,
} from "./strategySnapshotConfig";

type DeploymentDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type DeploymentTransaction = Parameters<Parameters<DeploymentDb["transaction"]>[0]>[0];
type DeploymentQueryExecutor = Pick<DeploymentDb | DeploymentTransaction, "select">;

const PENDING_INTENT_STATUSES = [
  "CREATED",
  "SUBMITTING",
  "SUBMITTED",
  "PARTIALLY_FILLED",
  "RECONCILIATION_REQUIRED",
] as const;
const UNRESOLVED_RECONCILIATION_STATUSES = ["OPEN", "ACKNOWLEDGED"] as const;
const MODE_SWITCH_SOURCE_STATES: readonly DeploymentActivationState[] = [
  "DRAFT",
  "DISABLED",
  "PREFLIGHT_FAILED",
  "READY_DISABLED",
  "PAUSED",
  "BLOCKED",
];

export interface DeploymentLedgerCounts {
  openLegCount: number;
  pendingIntentCount: number;
  unresolvedReconciliationCount: number;
  activeHedgeRelationshipCount: number;
  activeReservationCount: number;
}

export interface DeploymentPreflightProbeErrors {
  capability?: string;
  instrument?: string;
  balance?: string;
  positions?: string;
}

export interface GatheredDeploymentPreflightFacts extends DeploymentPreflightFacts {
  probeErrors: DeploymentPreflightProbeErrors;
  accountSnapshot: Awaited<ReturnType<typeof getLatestAccountPositionSnapshot>>;
}

export interface LifecycleMutationResult {
  deployment: Strategy;
  transition: ModeTransition;
  deduplicated: boolean;
}

export interface SavePreflightReportInput {
  deploymentId: number;
  userId: number;
  expectedRevision: number;
  transitionKey: string;
  report: DeploymentPreflightReport;
  reasonCode?: string;
  reason?: string;
  now?: Date;
}

export interface ApplyLifecycleTransitionInput {
  deploymentId: number;
  userId: number;
  expectedRevision: number;
  transitionKey: string;
  action: DeploymentLifecycleAction;
  reasonCode: string;
  reason: string;
  now?: Date;
}

export interface SwitchDeploymentModeInput {
  deploymentId: number;
  userId: number;
  expectedRevision: number;
  transitionKey: string;
  executionMode: ExecutionMode;
  executionPolicy: unknown;
  preflightReport: DeploymentPreflightReport;
  reasonCode: string;
  reason: string;
  now?: Date;
}

export interface CreateDeploymentInput {
  userId: number;
  name: string;
  description?: string | null;
  apiKeyId: number;
  symbol: string;
  strategyKey: string;
  executionMode: ExecutionMode;
  executionPolicy: unknown;
  capabilityManifest: VersionedStrategyCapabilityManifest;
  positionSize?: number;
  positionMode?: "quantity" | "usdt";
  leverage?: number;
  direction?: "long" | "short" | "both";
  orderType?: "market" | "limit";
  maxPositionPct?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  maxDailyLoss?: number;
  martinMultiplier?: number;
  maxMartinLevel?: number;
  martinSpacingPct?: number;
  reentryEnabled?: boolean;
  reentryCooldownBars?: number;
  tradeMode?: "webhook" | "auto";
  kLinePeriod?: number;
}

export interface CopyDeploymentInput {
  sourceDeploymentId: number;
  userId: number;
  name: string;
  description?: string | null;
  executionMode?: ExecutionMode;
  executionPolicy?: unknown;
  capabilityManifest: VersionedStrategyCapabilityManifest;
}

export interface UpdateDeploymentPolicyInput {
  deploymentId: number;
  userId: number;
  expectedRevision: number;
  transitionKey: string;
  executionPolicy: unknown;
  reasonCode: string;
  reason: string;
  now?: Date;
}

function boundedText(value: string, maximum: number, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不可為空`);
  if (normalized.length > maximum) throw new Error(`${field} 長度不可超過 ${maximum}`);
  return normalized;
}

function sanitizeProbeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(api[-_ ]?key|secret|passphrase|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

export function extractAffectedRows(result: unknown): number {
  const raw = result as
    | { affectedRows?: number; rowsAffected?: number }
    | [{ affectedRows?: number; rowsAffected?: number }, ...unknown[]];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return Number(header?.affectedRows ?? header?.rowsAffected ?? 0);
}

function countValue(rows: Array<{ value: unknown }>): number {
  const value = Number(rows[0]?.value ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizePositions(value: unknown): Position[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const positions = value.filter((item): item is Position => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<Position>;
    return typeof candidate.symbol === "string"
      && (candidate.side === "long" || candidate.side === "short")
      && Number.isFinite(Number(candidate.size))
      && Number.isFinite(Number(candidate.markPrice));
  });
  return positions;
}

function toDescriptor(row: Strategy): DeploymentDescriptor {
  return {
    id: row.id,
    userId: row.userId,
    deploymentKey: row.deploymentKey,
    strategyKey: row.strategyKey,
    strategyVersion: row.strategyVersion,
    executionMode: row.executionMode,
    executionPolicy: row.executionPolicy,
    capabilitySnapshot: row.capabilitySnapshot,
    activationState: row.activationState,
    deploymentRevision: row.deploymentRevision,
    enabled: row.enabled,
    apiKeyId: row.apiKeyId,
    exchange: row.exchange,
    symbol: row.symbol,
    strategyConfig: row.strategyKey
      ? getBoundStrategyConfig(row.martinState, row.strategyKey)
      : undefined,
  };
}

async function requireDb(): Promise<DeploymentDb> {
  const db = await getDb();
  if (!db) throw new Error("資料庫不可用");
  return db;
}

async function lockOwnedDeployment(
  tx: DeploymentTransaction,
  deploymentId: number,
  userId: number,
): Promise<Strategy> {
  await tx.execute(sql`
    SELECT id
    FROM strategies
    WHERE id = ${deploymentId} AND userId = ${userId}
    FOR UPDATE
  `);
  const rows = await tx
    .select()
    .from(strategies)
    .where(and(eq(strategies.id, deploymentId), eq(strategies.userId, userId)))
    .limit(1);
  if (!rows[0]) throw new Error("DEPLOYMENT_NOT_FOUND");
  return rows[0];
}

function assertExpectedRevision(current: Strategy, expectedRevision: number): void {
  if (current.deploymentRevision !== expectedRevision) {
    throw new Error(
      `DEPLOYMENT_REVISION_CONFLICT:${expectedRevision}:${current.deploymentRevision}`,
    );
  }
}

function assertTransitionIdentity(
  existing: ModeTransition,
  expected: {
    deploymentId: number;
    userId: number;
    expectedRevision: number;
    toState: DeploymentActivationState;
    toMode?: ExecutionMode;
    toPolicyHash?: string | null;
  },
): void {
  if (
    existing.deploymentId !== expected.deploymentId
    || existing.userId !== expected.userId
    || existing.expectedRevision !== expected.expectedRevision
    || existing.toState !== expected.toState
    || (expected.toMode !== undefined && existing.toMode !== expected.toMode)
    || (expected.toPolicyHash !== undefined && existing.toPolicyHash !== expected.toPolicyHash)
  ) {
    throw new Error("TRANSITION_KEY_CONFLICT");
  }
}

async function findTransition(
  executor: DeploymentQueryExecutor,
  transitionKey: string,
): Promise<ModeTransition | undefined> {
  const rows = await executor
    .select()
    .from(modeTransitions)
    .where(eq(modeTransitions.transitionKey, transitionKey))
    .limit(1);
  return rows[0];
}

async function requireAppliedTransition(
  tx: DeploymentTransaction,
  transitionKey: string,
): Promise<ModeTransition> {
  const transition = await findTransition(tx, transitionKey);
  if (!transition || transition.status !== "APPLIED") {
    throw new Error("TRANSITION_JOURNAL_NOT_APPLIED");
  }
  return transition;
}

async function readOwnedDeployment(
  executor: DeploymentQueryExecutor,
  deploymentId: number,
  userId: number,
): Promise<Strategy> {
  const rows = await executor
    .select()
    .from(strategies)
    .where(and(eq(strategies.id, deploymentId), eq(strategies.userId, userId)))
    .limit(1);
  if (!rows[0]) throw new Error("DEPLOYMENT_NOT_FOUND");
  return rows[0];
}

async function collectLedgerCounts(
  executor: DeploymentQueryExecutor,
  deploymentId: number,
  userId: number,
): Promise<DeploymentLedgerCounts> {
  const [legs, intents, reconciliation, hedges, reservations] = await Promise.all([
    executor
      .select({ value: count() })
      .from(positionLegs)
      .where(and(
        eq(positionLegs.strategyId, deploymentId),
        eq(positionLegs.userId, userId),
        ne(positionLegs.status, "CLOSED"),
      )),
    executor
      .select({ value: count() })
      .from(executionOrderIntents)
      .where(and(
        eq(executionOrderIntents.strategyId, deploymentId),
        eq(executionOrderIntents.userId, userId),
        inArray(executionOrderIntents.status, [...PENDING_INTENT_STATUSES]),
      )),
    executor
      .select({ value: count() })
      .from(executionReconciliationCases)
      .where(and(
        eq(executionReconciliationCases.strategyId, deploymentId),
        eq(executionReconciliationCases.userId, userId),
        inArray(
          executionReconciliationCases.status,
          [...UNRESOLVED_RECONCILIATION_STATUSES],
        ),
      )),
    executor
      .select({ value: count() })
      .from(hedgeRelationships)
      .where(and(
        eq(hedgeRelationships.strategyId, deploymentId),
        eq(hedgeRelationships.userId, userId),
        ne(hedgeRelationships.status, "CLOSED"),
      )),
    executor
      .select({ value: count() })
      .from(executionRiskReservations)
      .where(and(
        eq(executionRiskReservations.strategyId, deploymentId),
        eq(executionRiskReservations.userId, userId),
        eq(executionRiskReservations.status, "RESERVED"),
      )),
  ]);
  return {
    openLegCount: countValue(legs),
    pendingIntentCount: countValue(intents),
    unresolvedReconciliationCount: countValue(reconciliation),
    activeHedgeRelationshipCount: countValue(hedges),
    activeReservationCount: countValue(reservations),
  };
}

function assertFlatForModeSwitch(counts: DeploymentLedgerCounts): void {
  const blockers = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([key]) => key);
  if (blockers.length > 0) {
    throw new Error(`MODE_SWITCH_REQUIRES_FLAT:${blockers.join(",")}`);
  }
}

function extractInsertId(result: unknown): number {
  const raw = result as [{ insertId?: number }, ...unknown[]] | { insertId?: number };
  const header = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(header?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("DEPLOYMENT_INSERT_ID_MISSING");
  return id;
}

function canonicalDeploymentKey(userId: number): string {
  return `deployment:${userId}:${randomUUID()}`;
}

function assertCertifiedPolicy(
  strategyKey: string,
  manifest: VersionedStrategyCapabilityManifest,
  executionMode: ExecutionMode,
  executionPolicy: unknown,
): ExecutionPolicy {
  if (manifest.strategyKey !== strategyKey) throw new Error("CAPABILITY_STRATEGY_KEY_MISMATCH");
  const policy = normalizeStrategyExecutionPolicy(strategyKey, executionPolicy);
  if (policy.mode !== executionMode) throw new Error("POLICY_MODE_MISMATCH");
  if (!capabilityManifestSupportsMode(manifest, executionMode)) {
    throw new Error(`EXECUTION_MODE_NOT_CERTIFIED:${executionMode}`);
  }
  return policy;
}

function resetCopiedMartinState(source: unknown, initialLot: unknown): Record<string, unknown> {
  const preserved = source && typeof source === "object"
    ? pickStrategyConfigState(source as Record<string, unknown>)
    : {};
  const parsedLot = Number(initialLot);
  return {
    ...preserved,
    avgPrice: 0,
    capital: 0,
    cooldownUntil: 0,
    currentLayer: 0,
    currentLot: Number.isFinite(parsedLot) && parsedLot >= 0 ? parsedLot : 0,
    entryTrendBull: false,
    hasTriggeredKamaReversal: false,
    highestPrice: 0,
    isCooldown: false,
    isLong: false,
    isTrailingActivated: false,
    lastEntryPrice: 0,
    lastLayerPrice: 0,
    lockedBarTimestamp: 0,
    lossCount: 0,
    lowestPrice: 0,
    totalCost: 0,
    totalSize: 0,
  };
}

async function requireOwnedApiKeyRecord(
  db: DeploymentDb,
  apiKeyId: number,
  userId: number,
): Promise<ApiKey> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.userId, userId)))
    .limit(1);
  if (!rows[0]) throw new Error("API_KEY_NOT_FOUND");
  return rows[0];
}

export async function listOwnedDeployments(
  userId: number,
  filters: {
    executionMode?: ExecutionMode;
    activationState?: DeploymentActivationState;
    includeArchived?: boolean;
  } = {},
): Promise<Strategy[]> {
  const db = await requireDb();
  const conditions = [eq(strategies.userId, userId)];
  if (filters.executionMode) conditions.push(eq(strategies.executionMode, filters.executionMode));
  if (filters.activationState) {
    conditions.push(eq(strategies.activationState, filters.activationState));
  } else if (!filters.includeArchived) {
    conditions.push(ne(strategies.activationState, "ARCHIVED"));
  }
  return db
    .select()
    .from(strategies)
    .where(and(...conditions))
    .orderBy(desc(strategies.createdAt));
}

export async function createCanonicalDeployment(
  input: CreateDeploymentInput,
): Promise<Strategy> {
  const db = await requireDb();
  const name = boundedText(input.name, 100, "name");
  const strategyKey = boundedText(input.strategyKey, 100, "strategyKey");
  const symbol = boundedText(input.symbol.toUpperCase(), 32, "symbol");
  const apiKey = await requireOwnedApiKeyRecord(db, input.apiKeyId, input.userId);
  const policy = assertCertifiedPolicy(
    strategyKey,
    input.capabilityManifest,
    input.executionMode,
    input.executionPolicy,
  );
  const positionSize = input.positionSize ?? 0;
  const positionMode = input.positionMode ?? "quantity";
  const resetState = resetCopiedMartinState(null, positionSize);
  const martinState = strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY
    ? attachSnapshotConfig(
      resetState,
      strategyKey,
      createKamaRainbowMartinDefaultConfig() as unknown as Record<string, unknown>,
    )
    : resetState;
  const insert: InsertStrategy = {
    userId: input.userId,
    name,
    description: input.description?.trim() || null,
    apiKeyId: apiKey.id,
    exchange: apiKey.exchange,
    symbol,
    positionSize: String(positionSize),
    positionSizeObject: { value: positionSize, mode: positionMode },
    positionMode,
    leverage: input.leverage ?? 1,
    direction: input.direction ?? "both",
    orderType: input.orderType ?? "market",
    enabled: false,
    webhookSecret: generateWebhookSecret(),
    maxPositionPct: String(input.maxPositionPct ?? 0),
    stopLossPct: String(input.stopLossPct ?? 0),
    takeProfitPct: String(input.takeProfitPct ?? 0),
    maxDailyLoss: String(input.maxDailyLoss ?? 0),
    martinMultiplier: String(input.martinMultiplier ?? 1),
    maxMartinLevel: input.maxMartinLevel ?? 1,
    martinSpacingPct: String(input.martinSpacingPct ?? 0),
    martinState,
    reentryEnabled: input.reentryEnabled ?? true,
    reentryCooldownBars: input.reentryCooldownBars ?? 1,
    strategyKey,
    tradeMode: input.tradeMode ?? "webhook",
    kLinePeriod: input.kLinePeriod ?? 15,
    heartbeatTaskUid: null,
    deploymentKey: canonicalDeploymentKey(input.userId),
    executionMode: input.executionMode,
    executionPolicy: policy,
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    capabilitySnapshot: input.capabilityManifest,
    strategyVersion: input.capabilityManifest.strategyVersion,
    activationState: "DRAFT",
    deploymentRevision: 1,
    preflightStatus: "NOT_RUN",
    preflightReport: null,
    preflightHash: null,
    preflightCheckedAt: null,
    disabledReason: "新 canonical deployment 預設停用；必須通過 fresh preflight 後另行啟用",
    lifecycleReasonCode: "DEPLOYMENT_CREATED",
    lifecycleReason: "Canonical deployment created in DRAFT state.",
    modeActivatedAt: null,
    archivedAt: null,
  };
  const id = extractInsertId(await db.insert(strategies).values(insert));
  return readOwnedDeployment(db, id, input.userId);
}

export async function copyCanonicalDeployment(
  input: CopyDeploymentInput,
): Promise<Strategy> {
  const db = await requireDb();
  const source = await readOwnedDeployment(db, input.sourceDeploymentId, input.userId);
  if (!source.strategyKey) throw new Error("STRATEGY_KEY_MISSING");
  await requireOwnedApiKeyRecord(db, source.apiKeyId, input.userId);
  const executionMode = input.executionMode ?? source.executionMode;
  const executionPolicy = assertCertifiedPolicy(
    source.strategyKey,
    input.capabilityManifest,
    executionMode,
    input.executionPolicy ?? (
      executionMode === source.executionMode
        ? source.executionPolicy ?? createDefaultExecutionPolicy(executionMode)
        : createDefaultExecutionPolicy(executionMode)
    ),
  );
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deploymentKey: _deploymentKey,
    webhookSecret: _webhookSecret,
    heartbeatTaskUid: _heartbeatTaskUid,
    enabled: _enabled,
    activationState: _activationState,
    deploymentRevision: _deploymentRevision,
    preflightStatus: _preflightStatus,
    preflightReport: _preflightReport,
    preflightHash: _preflightHash,
    preflightCheckedAt: _preflightCheckedAt,
    lifecycleReasonCode: _lifecycleReasonCode,
    lifecycleReason: _lifecycleReason,
    modeActivatedAt: _modeActivatedAt,
    archivedAt: _archivedAt,
    disabledReason: _disabledReason,
    ...copyable
  } = source;
  const insert: InsertStrategy = {
    ...copyable,
    userId: input.userId,
    name: boundedText(input.name, 100, "name"),
    description: input.description === undefined
      ? source.description
      : input.description?.trim() || null,
    deploymentKey: canonicalDeploymentKey(input.userId),
    webhookSecret: generateWebhookSecret(),
    heartbeatTaskUid: null,
    martinState: resetCopiedMartinState(source.martinState, source.positionSize),
    executionMode,
    executionPolicy,
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    capabilitySnapshot: input.capabilityManifest,
    strategyVersion: input.capabilityManifest.strategyVersion,
    enabled: false,
    activationState: "DRAFT",
    deploymentRevision: 1,
    preflightStatus: "NOT_RUN",
    preflightReport: null,
    preflightHash: null,
    preflightCheckedAt: null,
    disabledReason: "複製部署預設停用；runtime state 未複製，必須通過 fresh preflight 後另行啟用",
    lifecycleReasonCode: "DEPLOYMENT_COPIED",
    lifecycleReason: `Copied from deployment ${source.id} without runtime state.`,
    modeActivatedAt: null,
    archivedAt: null,
  };
  const id = extractInsertId(await db.insert(strategies).values(insert));
  return readOwnedDeployment(db, id, input.userId);
}

export async function updateDeploymentPolicy(
  input: UpdateDeploymentPolicyInput,
): Promise<LifecycleMutationResult> {
  const db = await requireDb();
  const transitionKey = boundedText(input.transitionKey, 128, "transitionKey");
  const reasonCode = boundedText(input.reasonCode, 80, "reasonCode");
  const reason = boundedText(input.reason, 2_000, "reason");
  const now = input.now ?? new Date();

  return db.transaction(async tx => {
    const current = await lockOwnedDeployment(tx, input.deploymentId, input.userId);
    const policy = normalizeStrategyExecutionPolicy(current.strategyKey, input.executionPolicy);
    const targetPolicyHash = buildExecutionPolicyHash(policy);
    if (policy.mode !== current.executionMode) throw new Error("POLICY_MODE_MISMATCH");
    const existing = await findTransition(tx, transitionKey);
    if (existing) {
      assertTransitionIdentity(existing, {
        deploymentId: input.deploymentId,
        userId: input.userId,
        expectedRevision: input.expectedRevision,
        toState: "DISABLED",
        toMode: current.executionMode,
        toPolicyHash: targetPolicyHash,
      });
      if (existing.status !== "APPLIED") throw new Error("TRANSITION_RETRY_NOT_APPLIED");
      return { deployment: current, transition: existing, deduplicated: true };
    }

    assertExpectedRevision(current, input.expectedRevision);
    if (!["DRAFT", "DISABLED", "PREFLIGHT_FAILED", "READY_DISABLED", "BLOCKED"].includes(
      current.activationState,
    ) || current.enabled) {
      throw new Error(`POLICY_UPDATE_STATE_BLOCKED:${current.activationState}`);
    }
    assertFlatForModeSwitch(await collectLedgerCounts(tx, current.id, current.userId));
    const fromPolicyHash = buildExecutionPolicyHash(
      normalizeStrategyExecutionPolicy(
        current.strategyKey,
        current.executionPolicy ?? { mode: current.executionMode },
      ),
    );
    await tx.insert(modeTransitions).values({
      transitionKey,
      deploymentId: current.id,
      userId: current.userId,
      fromState: current.activationState,
      toState: "DISABLED",
      fromMode: current.executionMode,
      toMode: current.executionMode,
      fromPolicyHash,
      toPolicyHash: targetPolicyHash,
      expectedRevision: input.expectedRevision,
      status: "PENDING",
      reasonCode,
      reason,
      blockerCodes: [],
      requestedAt: now,
    });
    const result = await tx
      .update(strategies)
      .set({
        executionPolicy: policy,
        executionPolicyVersion: EXECUTION_POLICY_VERSION,
        activationState: "DISABLED",
        enabled: false,
        deploymentRevision: sql`${strategies.deploymentRevision} + 1` as unknown as number,
        preflightStatus: "STALE",
        disabledReason: reason,
        lifecycleReasonCode: reasonCode,
        lifecycleReason: reason,
      })
      .where(and(
        eq(strategies.id, current.id),
        eq(strategies.userId, current.userId),
        eq(strategies.deploymentRevision, input.expectedRevision),
      ));
    if (extractAffectedRows(result) !== 1) throw new Error("DEPLOYMENT_REVISION_CONFLICT");
    await tx
      .update(modeTransitions)
      .set({
        status: "APPLIED",
        resultingRevision: input.expectedRevision + 1,
        completedAt: now,
      })
      .where(and(
        eq(modeTransitions.transitionKey, transitionKey),
        eq(modeTransitions.status, "PENDING"),
      ));
    return {
      deployment: await readOwnedDeployment(tx, current.id, current.userId),
      transition: await requireAppliedTransition(tx, transitionKey),
      deduplicated: false,
    };
  });
}

export async function getOwnedDeploymentRecord(
  deploymentId: number,
  userId: number,
): Promise<Strategy> {
  const db = await requireDb();
  return readOwnedDeployment(db, deploymentId, userId);
}

export async function getOwnedTransitionByKey(input: {
  deploymentId: number;
  userId: number;
  transitionKey: string;
}): Promise<ModeTransition | undefined> {
  const db = await requireDb();
  const transition = await findTransition(db, input.transitionKey);
  if (!transition) return undefined;
  if (transition.deploymentId !== input.deploymentId || transition.userId !== input.userId) {
    throw new Error("TRANSITION_KEY_CONFLICT");
  }
  return transition;
}

export async function getDeploymentForPreflight(
  deploymentId: number,
  userId: number,
): Promise<DeploymentDescriptor> {
  return toDescriptor(await getOwnedDeploymentRecord(deploymentId, userId));
}

export async function getOwnedDeploymentApiKey(
  deployment: Pick<DeploymentDescriptor, "apiKeyId" | "userId">,
): Promise<ApiKey | undefined> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(
      eq(apiKeys.id, deployment.apiKeyId),
      eq(apiKeys.userId, deployment.userId),
    ))
    .limit(1);
  return rows[0];
}

export async function getLatestAccountPositionSnapshot(
  userId: number,
  apiKeyId: number,
) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(accountPositionSnapshots)
    .where(and(
      eq(accountPositionSnapshots.userId, userId),
      eq(accountPositionSnapshots.apiKeyId, apiKeyId),
    ))
    .orderBy(desc(accountPositionSnapshots.capturedAt), desc(accountPositionSnapshots.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getDeploymentLedgerCounts(
  deploymentId: number,
  userId: number,
): Promise<DeploymentLedgerCounts> {
  const db = await requireDb();
  await readOwnedDeployment(db, deploymentId, userId);
  return collectLedgerCounts(db, deploymentId, userId);
}

/**
 * 聚合 DB 真相與交易所只讀探測。此函式只呼叫 adapter 的 probe/get 方法，永不觸碰
 * placeOrder、cancelOrder、closePosition、setLeverage 或任何帳戶設定 mutation。
 */
export async function gatherPreflightFacts(input: {
  deployment: DeploymentDescriptor;
  currentManifest: VersionedStrategyCapabilityManifest;
  adapter?: Pick<
    ExchangeAdapter,
    "probeCapabilities" | "probeInstrument" | "getBalance" | "getPositions"
  >;
  now?: number;
  requireFlat?: boolean;
  artifactCompatibilityBlockers?: string[];
  adapterCreationError?: string;
}): Promise<GatheredDeploymentPreflightFacts> {
  const db = await requireDb();
  const now = input.now ?? Date.now();
  const [accountRows, counts, accountSnapshot] = await Promise.all([
    db
      .select()
      .from(apiKeys)
      .where(and(
        eq(apiKeys.id, input.deployment.apiKeyId),
        eq(apiKeys.userId, input.deployment.userId),
      ))
      .limit(1),
    collectLedgerCounts(db, input.deployment.id, input.deployment.userId),
    getLatestAccountPositionSnapshot(
      input.deployment.userId,
      input.deployment.apiKeyId,
    ),
  ]);
  const account = accountRows[0];
  const probeErrors: DeploymentPreflightProbeErrors = input.adapterCreationError
    ? {
      capability: sanitizeProbeError(input.adapterCreationError),
      instrument: sanitizeProbeError(input.adapterCreationError),
      balance: sanitizeProbeError(input.adapterCreationError),
      positions: sanitizeProbeError(input.adapterCreationError),
    }
    : {};
  const probeResults = input.adapter
    ? await Promise.allSettled([
      input.adapter.probeCapabilities(input.deployment.symbol),
      input.adapter.probeInstrument(input.deployment.symbol),
      input.adapter.getBalance(),
      input.adapter.getPositions(input.deployment.symbol),
    ])
    : null;

  let exchangeCapability: DeploymentPreflightFacts["exchangeCapability"];
  let instrument: DeploymentPreflightFacts["instrument"];
  let balance: DeploymentPreflightFacts["balance"];
  let positions: Position[] | undefined;
  if (probeResults) {
    const [capabilityResult, instrumentResult, balanceResult, positionResult] = probeResults;
    if (capabilityResult.status === "fulfilled") exchangeCapability = capabilityResult.value;
    else probeErrors.capability = sanitizeProbeError(capabilityResult.reason);
    if (instrumentResult.status === "fulfilled") instrument = instrumentResult.value;
    else probeErrors.instrument = sanitizeProbeError(instrumentResult.reason);
    if (balanceResult.status === "fulfilled") {
      balance = {
        free: balanceResult.value.free,
        total: balanceResult.value.total,
        usedMargin: balanceResult.value.usedMargin ?? 0,
      };
    } else probeErrors.balance = sanitizeProbeError(balanceResult.reason);
    if (positionResult.status === "fulfilled") positions = positionResult.value;
    else probeErrors.positions = sanitizeProbeError(positionResult.reason);
  }

  if (!positions && accountSnapshot?.status === "available") {
    const capturedAt = accountSnapshot.capturedAt.getTime();
    const expiresAt = accountSnapshot.expiresAt.getTime();
    if (capturedAt <= now && expiresAt >= now) {
      positions = normalizePositions(accountSnapshot.positions);
    }
  }

  return {
    now,
    currentManifest: input.currentManifest,
    account: {
      exists: Boolean(account),
      ownerMatches: Boolean(account),
      exchangeMatches: account?.exchange === input.deployment.exchange,
      lastTestStatus: account?.lastTestStatus ?? "missing",
      lastTestAt: account?.lastTestAt?.getTime(),
    },
    exchangeCapability,
    instrument,
    balance,
    positions,
    ...counts,
    artifactCompatibilityBlockers: input.artifactCompatibilityBlockers,
    requireFlat: input.requireFlat,
    probeErrors,
    accountSnapshot,
  };
}

export async function savePreflightReport(
  input: SavePreflightReportInput,
): Promise<LifecycleMutationResult> {
  const db = await requireDb();
  const transitionKey = boundedText(input.transitionKey, 128, "transitionKey");
  const now = input.now ?? new Date();
  const targetState = lifecycleTargetForAction(
    input.report.eligible ? "PREFLIGHT_PASS" : "PREFLIGHT_FAIL",
  );
  const action: DeploymentLifecycleAction = input.report.eligible
    ? "PREFLIGHT_PASS"
    : "PREFLIGHT_FAIL";
  const reasonCode = boundedText(
    input.reasonCode ?? (input.report.eligible ? "PREFLIGHT_PASSED" : "PREFLIGHT_BLOCKED"),
    80,
    "reasonCode",
  );
  const reason = boundedText(
    input.reason ?? (
      input.report.eligible
        ? "Deterministic deployment preflight passed; deployment remains disabled."
        : `Deterministic deployment preflight blocked: ${input.report.blockerCodes.join(",")}`
    ),
    2_000,
    "reason",
  );

  return db.transaction(async tx => {
    const current = await lockOwnedDeployment(tx, input.deploymentId, input.userId);
    const existing = await findTransition(tx, transitionKey);
    if (existing) {
      assertTransitionIdentity(existing, {
        deploymentId: input.deploymentId,
        userId: input.userId,
        expectedRevision: input.expectedRevision,
        toState: targetState,
        toMode: input.report.executionMode,
      });
      if (existing.status !== "APPLIED") throw new Error("TRANSITION_RETRY_NOT_APPLIED");
      return {
        deployment: current,
        transition: existing,
        deduplicated: true,
      };
    }

    assertExpectedRevision(current, input.expectedRevision);
    assertDeploymentTransitionAllowed(current.activationState, action);
    if (input.report.deploymentId !== current.id) throw new Error("PREFLIGHT_DEPLOYMENT_MISMATCH");
    if (input.report.deploymentRevision !== input.expectedRevision + 1) {
      throw new Error("PREFLIGHT_RESULTING_REVISION_MISMATCH");
    }

    await tx.insert(modeTransitions).values({
      transitionKey,
      deploymentId: current.id,
      userId: current.userId,
      fromState: current.activationState,
      toState: targetState,
      fromMode: current.executionMode,
      toMode: input.report.executionMode,
      fromPolicyHash: buildExecutionPolicyHash(
        normalizeExecutionModePolicy(current.executionPolicy ?? { mode: current.executionMode }),
      ),
      toPolicyHash: input.report.executionPolicyHash,
      expectedRevision: input.expectedRevision,
      status: "PENDING",
      reasonCode,
      reason,
      blockerCodes: input.report.blockerCodes,
      preflightReport: input.report,
      requestedAt: now,
    });

    const updateResult = await tx
      .update(strategies)
      .set({
        activationState: targetState,
        enabled: false,
        deploymentRevision: sql`${strategies.deploymentRevision} + 1`,
        preflightStatus: input.report.eligible ? "PASSED" : "FAILED",
        preflightReport: input.report,
        preflightHash: input.report.preflightHash,
        preflightCheckedAt: new Date(input.report.checkedAt),
        lifecycleReasonCode: reasonCode,
        lifecycleReason: reason,
      })
      .where(and(
        eq(strategies.id, input.deploymentId),
        eq(strategies.userId, input.userId),
        eq(strategies.deploymentRevision, input.expectedRevision),
      ));
    if (extractAffectedRows(updateResult) !== 1) {
      throw new Error("DEPLOYMENT_REVISION_CONFLICT");
    }

    await tx
      .update(modeTransitions)
      .set({
        status: "APPLIED",
        resultingRevision: input.expectedRevision + 1,
        completedAt: now,
      })
      .where(and(
        eq(modeTransitions.transitionKey, transitionKey),
        eq(modeTransitions.status, "PENDING"),
      ));

    const deployment = await readOwnedDeployment(tx, input.deploymentId, input.userId);
    return {
      deployment,
      transition: await requireAppliedTransition(tx, transitionKey),
      deduplicated: false,
    };
  });
}

export async function applyLifecycleTransition(
  input: ApplyLifecycleTransitionInput,
): Promise<LifecycleMutationResult> {
  const db = await requireDb();
  const transitionKey = boundedText(input.transitionKey, 128, "transitionKey");
  const reasonCode = boundedText(input.reasonCode, 80, "reasonCode");
  const reason = boundedText(input.reason, 2_000, "reason");
  const now = input.now ?? new Date();
  const targetState = lifecycleTargetForAction(input.action);

  return db.transaction(async tx => {
    const current = await lockOwnedDeployment(tx, input.deploymentId, input.userId);
    const existing = await findTransition(tx, transitionKey);
    if (existing) {
      assertTransitionIdentity(existing, {
        deploymentId: input.deploymentId,
        userId: input.userId,
        expectedRevision: input.expectedRevision,
        toState: targetState,
      });
      if (existing.status !== "APPLIED") throw new Error("TRANSITION_RETRY_NOT_APPLIED");
      return {
        deployment: current,
        transition: existing,
        deduplicated: true,
      };
    }

    assertExpectedRevision(current, input.expectedRevision);
    assertDeploymentTransitionAllowed(current.activationState, input.action);
    if (input.action === "ACTIVATE") {
      assertFreshPassingPreflight(
        current.preflightReport as DeploymentPreflightReport | null,
        {
          deploymentId: current.id,
          deploymentRevision: current.deploymentRevision,
          executionMode: current.executionMode,
          executionPolicy: current.executionPolicy ?? { mode: current.executionMode },
          now: now.getTime(),
        },
      );
    }
    if (input.action === "ARCHIVE") {
      assertFlatForModeSwitch(await collectLedgerCounts(tx, current.id, current.userId));
    }

    const policyHash = buildExecutionPolicyHash(
      normalizeExecutionModePolicy(current.executionPolicy ?? { mode: current.executionMode }),
    );
    const blockerCodes = (
      current.preflightReport as DeploymentPreflightReport | null
    )?.blockerCodes ?? [];
    await tx.insert(modeTransitions).values({
      transitionKey,
      deploymentId: current.id,
      userId: current.userId,
      fromState: current.activationState,
      toState: targetState,
      fromMode: current.executionMode,
      toMode: current.executionMode,
      fromPolicyHash: policyHash,
      toPolicyHash: policyHash,
      expectedRevision: input.expectedRevision,
      status: "PENDING",
      reasonCode,
      reason,
      blockerCodes,
      preflightReport: current.preflightReport,
      requestedAt: now,
    });

    const updateValues: Partial<typeof strategies.$inferInsert> = {
      activationState: targetState,
      enabled: targetState === "ACTIVE",
      deploymentRevision: sql`${strategies.deploymentRevision} + 1` as unknown as number,
      preflightStatus: "STALE",
      lifecycleReasonCode: reasonCode,
      lifecycleReason: reason,
    };
    if (targetState === "ACTIVE") updateValues.modeActivatedAt = now;
    if (targetState === "ARCHIVED") updateValues.archivedAt = now;
    if (targetState !== "ACTIVE") updateValues.disabledReason = reason;

    const updateResult = await tx
      .update(strategies)
      .set(updateValues)
      .where(and(
        eq(strategies.id, input.deploymentId),
        eq(strategies.userId, input.userId),
        eq(strategies.deploymentRevision, input.expectedRevision),
      ));
    if (extractAffectedRows(updateResult) !== 1) {
      throw new Error("DEPLOYMENT_REVISION_CONFLICT");
    }

    await tx
      .update(modeTransitions)
      .set({
        status: "APPLIED",
        resultingRevision: input.expectedRevision + 1,
        completedAt: now,
      })
      .where(and(
        eq(modeTransitions.transitionKey, transitionKey),
        eq(modeTransitions.status, "PENDING"),
      ));
    const deployment = await readOwnedDeployment(tx, input.deploymentId, input.userId);
    return {
      deployment,
      transition: await requireAppliedTransition(tx, transitionKey),
      deduplicated: false,
    };
  });
}

export async function switchDeploymentMode(
  input: SwitchDeploymentModeInput,
): Promise<LifecycleMutationResult> {
  const db = await requireDb();
  const transitionKey = boundedText(input.transitionKey, 128, "transitionKey");
  const reasonCode = boundedText(input.reasonCode, 80, "reasonCode");
  const reason = boundedText(input.reason, 2_000, "reason");
  const now = input.now ?? new Date();

  return db.transaction(async tx => {
    const current = await lockOwnedDeployment(tx, input.deploymentId, input.userId);
    const targetPolicy = normalizeStrategyExecutionPolicy(
      current.strategyKey,
      input.executionPolicy,
    );
    if (targetPolicy.mode !== input.executionMode) throw new Error("POLICY_MODE_MISMATCH");
    const toPolicyHash = buildExecutionPolicyHash(targetPolicy);
    const existing = await findTransition(tx, transitionKey);
    if (existing) {
      assertTransitionIdentity(existing, {
        deploymentId: input.deploymentId,
        userId: input.userId,
        expectedRevision: input.expectedRevision,
        toState: "READY_DISABLED",
        toMode: input.executionMode,
        toPolicyHash,
      });
      if (existing.status !== "APPLIED") throw new Error("TRANSITION_RETRY_NOT_APPLIED");
      return {
        deployment: current,
        transition: existing,
        deduplicated: true,
      };
    }

    assertExpectedRevision(current, input.expectedRevision);
    if (!MODE_SWITCH_SOURCE_STATES.includes(current.activationState) || current.enabled) {
      throw new Error(`MODE_SWITCH_STATE_BLOCKED:${current.activationState}`);
    }
    assertFreshPassingPreflight(
      input.preflightReport,
      {
        deploymentId: current.id,
        deploymentRevision: current.deploymentRevision + 1,
        executionMode: input.executionMode,
        executionPolicy: targetPolicy,
        now: now.getTime(),
      },
    );
    assertFlatForModeSwitch(await collectLedgerCounts(tx, current.id, current.userId));

    const fromPolicyHash = buildExecutionPolicyHash(
      normalizeStrategyExecutionPolicy(
        current.strategyKey,
        current.executionPolicy ?? { mode: current.executionMode },
      ),
    );
    const preflightReport = input.preflightReport;
    await tx.insert(modeTransitions).values({
      transitionKey,
      deploymentId: current.id,
      userId: current.userId,
      fromState: current.activationState,
      toState: "READY_DISABLED",
      fromMode: current.executionMode,
      toMode: input.executionMode,
      fromPolicyHash,
      toPolicyHash,
      expectedRevision: input.expectedRevision,
      status: "PENDING",
      reasonCode,
      reason,
      blockerCodes: preflightReport.blockerCodes,
      preflightReport,
      requestedAt: now,
    });

    const updateResult = await tx
      .update(strategies)
      .set({
        executionMode: input.executionMode,
        executionPolicy: targetPolicy,
        executionPolicyVersion: EXECUTION_POLICY_VERSION,
        activationState: "READY_DISABLED",
        enabled: false,
        deploymentRevision: sql`${strategies.deploymentRevision} + 1`,
        preflightStatus: "PASSED",
        preflightReport,
        preflightHash: preflightReport.preflightHash,
        preflightCheckedAt: new Date(preflightReport.checkedAt),
        lifecycleReasonCode: reasonCode,
        lifecycleReason: reason,
        disabledReason: reason,
      })
      .where(and(
        eq(strategies.id, input.deploymentId),
        eq(strategies.userId, input.userId),
        eq(strategies.deploymentRevision, input.expectedRevision),
      ));
    if (extractAffectedRows(updateResult) !== 1) {
      throw new Error("DEPLOYMENT_REVISION_CONFLICT");
    }

    await tx
      .update(modeTransitions)
      .set({
        status: "APPLIED",
        resultingRevision: input.expectedRevision + 1,
        completedAt: now,
      })
      .where(and(
        eq(modeTransitions.transitionKey, transitionKey),
        eq(modeTransitions.status, "PENDING"),
      ));
    const deployment = await readOwnedDeployment(tx, input.deploymentId, input.userId);
    return {
      deployment,
      transition: await requireAppliedTransition(tx, transitionKey),
      deduplicated: false,
    };
  });
}

export async function getLifecycleHistory(
  deploymentId: number,
  userId: number,
  limit = 100,
): Promise<ModeTransition[]> {
  const db = await requireDb();
  await readOwnedDeployment(db, deploymentId, userId);
  return db
    .select()
    .from(modeTransitions)
    .where(and(
      eq(modeTransitions.deploymentId, deploymentId),
      eq(modeTransitions.userId, userId),
    ))
    .orderBy(desc(modeTransitions.createdAt), desc(modeTransitions.id))
    .limit(Math.min(Math.max(limit, 1), 500));
}

export async function getDeploymentStatus(deploymentId: number, userId: number) {
  const db = await requireDb();
  const deployment = await readOwnedDeployment(db, deploymentId, userId);
  const [ledger, accountSnapshot, latestTransitions] = await Promise.all([
    collectLedgerCounts(db, deploymentId, userId),
    getLatestAccountPositionSnapshot(userId, deployment.apiKeyId),
    db
      .select()
      .from(modeTransitions)
      .where(and(
        eq(modeTransitions.deploymentId, deploymentId),
        eq(modeTransitions.userId, userId),
      ))
      .orderBy(desc(modeTransitions.createdAt), desc(modeTransitions.id))
      .limit(10),
  ]);
  return {
    deployment,
    descriptor: toDescriptor(deployment),
    ledger,
    accountSnapshot,
    latestTransitions,
  };
}
