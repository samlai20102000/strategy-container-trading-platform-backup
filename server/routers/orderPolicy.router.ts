import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  ORDER_POLICY_SETTING_LIMITS,
  getOrderPolicySettings,
  listOrderPolicySettingEvents,
  resetOrderPolicySettings,
  updateOrderPolicySettings,
} from "../services/orderPolicySettings";

const configSchema = z.object({
  standardTtlMs: z.number().int()
    .min(ORDER_POLICY_SETTING_LIMITS.standardTtlMs.min)
    .max(ORDER_POLICY_SETTING_LIMITS.standardTtlMs.max),
  standardMaxAttempts: z.number().int()
    .min(ORDER_POLICY_SETTING_LIMITS.standardMaxAttempts.min)
    .max(ORDER_POLICY_SETTING_LIMITS.standardMaxAttempts.max),
  emergencyTtlMs: z.number().int()
    .min(ORDER_POLICY_SETTING_LIMITS.emergencyTtlMs.min)
    .max(ORDER_POLICY_SETTING_LIMITS.emergencyTtlMs.max),
  emergencyMakerAttempts: z.number().int()
    .min(ORDER_POLICY_SETTING_LIMITS.emergencyMakerAttempts.min)
    .max(ORDER_POLICY_SETTING_LIMITS.emergencyMakerAttempts.max),
  allowStopLossTaker: z.boolean(),
  allowDailyLossTaker: z.boolean(),
  allowKillSwitchTaker: z.boolean(),
}).strict();

function policyError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (message === "ORDER_POLICY_REVISION_CONFLICT") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "訂單政策版本已變更，請重新載入最新設定後再儲存。",
      cause: error,
    });
  }
  if (message === "ORDER_POLICY_SETTINGS_UNAVAILABLE") {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "訂單政策設定暫時不可用；交易執行會 fail-closed，不會使用未確認設定送單。",
      cause: error,
    });
  }
  throw new TRPCError({ code: "BAD_REQUEST", message, cause: error });
}

export const orderPolicyRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    try {
      const settings = await getOrderPolicySettings(ctx.user.id);
      return {
        ...settings,
        limits: ORDER_POLICY_SETTING_LIMITS,
        immutableRules: {
          standardFlow: "ENTRY_ADD_NORMAL_CLOSE_ALWAYS_POST_ONLY",
          emergencyFlow: "REDUCE_ONLY_APPROVED_REASONS_ONLY",
          auditFailure: "FAIL_CLOSED",
          priceSource: "FRESH_BEST_BID_ASK_PER_ATTEMPT",
          passivePriceOffsetTicks: 0,
          partialFill: "CANCEL_AND_REPRICE_REMAINDER_ONLY",
          cancelConfirmationRequired: true,
          allowedEmergencyReasons: ["STOP_LOSS", "DAILY_LOSS_LIMIT", "KILL_SWITCH"] as const,
        },
      };
    } catch (error) {
      policyError(error);
    }
  }),

  update: protectedProcedure
    .input(z.object({
      expectedRevision: z.number().int().nonnegative(),
      config: configSchema,
      reason: z.string().trim().min(1).max(500).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await updateOrderPolicySettings({
          userId: ctx.user.id,
          actorUserId: ctx.user.id,
          expectedRevision: input.expectedRevision,
          config: input.config,
          reason: input.reason,
        });
      } catch (error) {
        policyError(error);
      }
    }),

  reset: protectedProcedure
    .input(z.object({
      expectedRevision: z.number().int().nonnegative(),
      reason: z.string().trim().min(1).max(500).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await resetOrderPolicySettings({
          userId: ctx.user.id,
          actorUserId: ctx.user.id,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
        });
      } catch (error) {
        policyError(error);
      }
    }),

  history: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }).default({ limit: 20 }))
    .query(async ({ ctx, input }) => {
      try {
        return await listOrderPolicySettingEvents(ctx.user.id, input.limit);
      } catch (error) {
        policyError(error);
      }
    }),
});
