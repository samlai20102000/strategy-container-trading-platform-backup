import { and, desc, eq } from "drizzle-orm";
import {
  orderPolicySettingEvents,
  orderPolicySettings,
  type OrderPolicySetting,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  DEFAULT_MAKER_FIRST_POLICY,
  MAKER_FIRST_POLICY_VERSION,
  type MakerFirstPolicyConfig,
} from "../exchanges/makerFirstFacade";

export const ORDER_POLICY_SETTING_LIMITS = Object.freeze({
  standardTtlMs: { min: 5_000, max: 120_000 },
  standardMaxAttempts: { min: 1, max: 5 },
  emergencyTtlMs: { min: 2_000, max: 10_000 },
  emergencyMakerAttempts: { min: 2, max: 3 },
});

export type EditableOrderPolicyConfig = Omit<MakerFirstPolicyConfig, "pollIntervalMs">;

export interface OrderPolicySettingsView {
  policyVersion: typeof MAKER_FIRST_POLICY_VERSION;
  revision: number;
  source: "default" | "custom";
  config: EditableOrderPolicyConfig;
  updatedAt: Date | null;
}

const DEFAULT_EDITABLE_CONFIG: Readonly<EditableOrderPolicyConfig> = Object.freeze({
  standardTtlMs: DEFAULT_MAKER_FIRST_POLICY.standardTtlMs,
  standardMaxAttempts: DEFAULT_MAKER_FIRST_POLICY.standardMaxAttempts,
  emergencyTtlMs: DEFAULT_MAKER_FIRST_POLICY.emergencyTtlMs,
  emergencyMakerAttempts: DEFAULT_MAKER_FIRST_POLICY.emergencyMakerAttempts,
  allowStopLossTaker: DEFAULT_MAKER_FIRST_POLICY.allowStopLossTaker,
  allowDailyLossTaker: DEFAULT_MAKER_FIRST_POLICY.allowDailyLossTaker,
  allowKillSwitchTaker: DEFAULT_MAKER_FIRST_POLICY.allowKillSwitchTaker,
});

function editableFromRow(row: OrderPolicySetting): EditableOrderPolicyConfig {
  return {
    standardTtlMs: row.standardTtlMs,
    standardMaxAttempts: row.standardMaxAttempts,
    emergencyTtlMs: row.emergencyTtlMs,
    emergencyMakerAttempts: row.emergencyMakerAttempts,
    allowStopLossTaker: row.allowStopLossTaker,
    allowDailyLossTaker: row.allowDailyLossTaker,
    allowKillSwitchTaker: row.allowKillSwitchTaker,
  };
}

function assertIntegerRange(
  field: keyof typeof ORDER_POLICY_SETTING_LIMITS,
  value: number,
): void {
  const range = ORDER_POLICY_SETTING_LIMITS[field];
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`ORDER_POLICY_SETTING_OUT_OF_RANGE:${field}:${range.min}-${range.max}`);
  }
}

export function assertSafeOrderPolicyConfig(config: EditableOrderPolicyConfig): void {
  assertIntegerRange("standardTtlMs", config.standardTtlMs);
  assertIntegerRange("standardMaxAttempts", config.standardMaxAttempts);
  assertIntegerRange("emergencyTtlMs", config.emergencyTtlMs);
  assertIntegerRange("emergencyMakerAttempts", config.emergencyMakerAttempts);
  for (const value of [
    config.allowStopLossTaker,
    config.allowDailyLossTaker,
    config.allowKillSwitchTaker,
  ]) {
    if (typeof value !== "boolean") throw new Error("ORDER_POLICY_SETTING_INVALID_BOOLEAN");
  }
}

function extractAffectedRows(result: unknown): number {
  const raw = result as
    | { affectedRows?: number; rowsAffected?: number }
    | [{ affectedRows?: number; rowsAffected?: number }, ...unknown[]];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return Number(header?.affectedRows ?? header?.rowsAffected ?? 0);
}

export async function getOrderPolicySettings(userId: number): Promise<OrderPolicySettingsView> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("ORDER_POLICY_OWNER_INVALID");
  const db = await getDb();
  if (!db) throw new Error("ORDER_POLICY_SETTINGS_UNAVAILABLE");
  const rows = await db
    .select()
    .from(orderPolicySettings)
    .where(eq(orderPolicySettings.userId, userId))
    .limit(1);
  const row = rows[0];
  return {
    policyVersion: MAKER_FIRST_POLICY_VERSION,
    revision: row?.revision ?? 0,
    source: row ? "custom" : "default",
    config: row ? editableFromRow(row) : { ...DEFAULT_EDITABLE_CONFIG },
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function getOrderPolicyRuntimeConfig(userId: number): Promise<Readonly<MakerFirstPolicyConfig>> {
  const settings = await getOrderPolicySettings(userId);
  return {
    ...settings.config,
    pollIntervalMs: DEFAULT_MAKER_FIRST_POLICY.pollIntervalMs,
  };
}

export async function updateOrderPolicySettings(input: {
  userId: number;
  actorUserId: number;
  expectedRevision: number;
  config: EditableOrderPolicyConfig;
  reason?: string;
  eventType?: "CREATED" | "UPDATED" | "RESET";
  now?: number;
}): Promise<OrderPolicySettingsView> {
  if (!Number.isInteger(input.userId) || input.userId <= 0 || input.actorUserId !== input.userId) {
    throw new Error("ORDER_POLICY_OWNER_INVALID");
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("ORDER_POLICY_REVISION_INVALID");
  }
  assertSafeOrderPolicyConfig(input.config);
  const db = await getDb();
  if (!db) throw new Error("ORDER_POLICY_SETTINGS_UNAVAILABLE");

  await db.transaction(async tx => {
    const rows = await tx
      .select()
      .from(orderPolicySettings)
      .where(eq(orderPolicySettings.userId, input.userId))
      .limit(1);
    const current = rows[0];
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) throw new Error("ORDER_POLICY_REVISION_CONFLICT");
    const nextRevision = currentRevision + 1;
    const values = {
      ...input.config,
      revision: nextRevision,
      updatedByUserId: input.actorUserId,
    };

    if (current) {
      const result = await tx
        .update(orderPolicySettings)
        .set(values)
        .where(and(
          eq(orderPolicySettings.userId, input.userId),
          eq(orderPolicySettings.revision, input.expectedRevision),
        ));
      if (extractAffectedRows(result) !== 1) throw new Error("ORDER_POLICY_REVISION_CONFLICT");
    } else {
      try {
        await tx.insert(orderPolicySettings).values({ userId: input.userId, ...values });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/duplicate|primary/i.test(message)) throw new Error("ORDER_POLICY_REVISION_CONFLICT");
        throw error;
      }
    }

    await tx.insert(orderPolicySettingEvents).values({
      userId: input.userId,
      revision: nextRevision,
      eventType: input.eventType ?? (current ? "UPDATED" : "CREATED"),
      previousConfig: current ? editableFromRow(current) : null,
      nextConfig: input.config,
      reason: input.reason?.trim().slice(0, 500) || null,
      eventAt: input.now ?? Date.now(),
    });
  });

  return getOrderPolicySettings(input.userId);
}

export async function resetOrderPolicySettings(input: {
  userId: number;
  actorUserId: number;
  expectedRevision: number;
  reason?: string;
}): Promise<OrderPolicySettingsView> {
  return updateOrderPolicySettings({
    ...input,
    config: { ...DEFAULT_EDITABLE_CONFIG },
    eventType: "RESET",
  });
}

export async function listOrderPolicySettingEvents(userId: number, limit = 20) {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("ORDER_POLICY_OWNER_INVALID");
  const db = await getDb();
  if (!db) throw new Error("ORDER_POLICY_SETTINGS_UNAVAILABLE");
  return db
    .select()
    .from(orderPolicySettingEvents)
    .where(eq(orderPolicySettingEvents.userId, userId))
    .orderBy(desc(orderPolicySettingEvents.eventAt), desc(orderPolicySettingEvents.id))
    .limit(Math.max(1, Math.min(50, Math.trunc(limit))));
}

