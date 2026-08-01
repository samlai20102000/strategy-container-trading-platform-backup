import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Strategy } from "../../drizzle/schema";
import {
  EXECUTION_MODES,
  type DeploymentActivationState,
  type ExecutionMode,
  type ExecutionPolicy,
} from "../../shared/executionModes";
import {
  createDefaultStrategyExecutionPolicy,
  normalizeStrategyExecutionPolicy,
} from "../../shared/strategies/kamaRainbowMartinExecutionPolicy";
import { protectedProcedure, router } from "../_core/trpc";
import { createAdapter } from "../exchanges/factory";
import {
  buildDeploymentPreflightReport,
  type DeploymentDescriptor,
  type DeploymentLifecycleAction,
  type DeploymentPreflightReport,
} from "../services/deploymentLifecycle";
import {
  applyLifecycleTransition,
  copyCanonicalDeployment,
  createCanonicalDeployment,
  gatherPreflightFacts,
  getDeploymentForPreflight,
  getDeploymentStatus,
  getLifecycleHistory,
  getOwnedDeploymentApiKey,
  getOwnedDeploymentRecord,
  getOwnedTransitionByKey,
  listOwnedDeployments,
  savePreflightReport,
  switchDeploymentMode,
  type LifecycleMutationResult,
  updateDeploymentPolicy,
} from "../services/deploymentLifecycleRepository";
import { requireStrategyCapabilityManifest } from "../services/strategyCapabilityRegistry";
import { buildExecutionPolicyHash } from "../services/strategyArtifacts";
import { listRecentModeDecisions } from "../services/threeModeLedger";

const executionModeSchema = z.enum(EXECUTION_MODES);
const deploymentIdSchema = z.number().int().positive();
const revisionSchema = z.number().int().nonnegative();
const transitionKeySchema = z.string().trim().min(8).max(96);
const activationStateSchema = z.enum([
  "LEGACY",
  "DRAFT",
  "DISABLED",
  "PREFLIGHT_FAILED",
  "READY_DISABLED",
  "ARMED",
  "ACTIVE",
  "PAUSED",
  "DRAINING",
  "BLOCKED",
  "ARCHIVED",
]);
const policySchema = z.record(z.string(), z.unknown());

const revisionedMutationSchema = z.object({
  deploymentId: deploymentIdSchema,
  expectedRevision: revisionSchema,
  transitionKey: transitionKeySchema,
  reasonCode: z.string().trim().min(1).max(80).optional(),
  reason: z.string().trim().min(1).max(2_000).optional(),
});

const lifecycleDefaults: Record<
  "activate" | "pause" | "drain" | "disable" | "block" | "archive",
  { action: DeploymentLifecycleAction; reasonCode: string; reason: string }
> = {
  activate: {
    action: "ACTIVATE",
    reasonCode: "OPERATOR_ACTIVATE",
    reason: "Operator activated deployment after fresh passing preflight.",
  },
  pause: {
    action: "PAUSE",
    reasonCode: "OPERATOR_PAUSE",
    reason: "Operator paused new exposure; reduce-only lifecycle remains available.",
  },
  drain: {
    action: "DRAIN",
    reasonCode: "OPERATOR_DRAIN",
    reason: "Operator stopped new exposure and entered reduce-only draining mode.",
  },
  disable: {
    action: "DISABLE",
    reasonCode: "OPERATOR_DISABLE",
    reason: "Operator disabled deployment.",
  },
  block: {
    action: "BLOCK",
    reasonCode: "OPERATOR_BLOCK",
    reason: "Operator fail-closed the deployment pending investigation.",
  },
  archive: {
    action: "ARCHIVE",
    reasonCode: "OPERATOR_ARCHIVE",
    reason: "Operator archived a flat and fully reconciled deployment.",
  },
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizedAdapterError(error: unknown): string {
  return messageOf(error)
    .replace(/(api[-_ ]?key|secret|passphrase|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

function safeDeployment(row: Strategy) {
  const { webhookSecret: _webhookSecret, ...safe } = row;
  return safe;
}

function safeMutation<T extends { deployment: Strategy }>(mutation: T) {
  return { ...mutation, deployment: safeDeployment(mutation.deployment) };
}

function lifecycleError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const message = messageOf(error);
  if (message === "DEPLOYMENT_NOT_FOUND") {
    throw new TRPCError({ code: "NOT_FOUND", message: "部署不存在" });
  }
  if (message === "API_KEY_NOT_FOUND") {
    throw new TRPCError({ code: "NOT_FOUND", message: "API 金鑰不存在" });
  }
  if (
    message.startsWith("DEPLOYMENT_REVISION_CONFLICT")
    || message === "TRANSITION_KEY_CONFLICT"
    || message === "TRANSITION_RETRY_NOT_APPLIED"
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "部署版本或冪等鍵已變更，請重新載入最新狀態後再操作。",
      cause: error,
    });
  }
  if (
    message.startsWith("PREFLIGHT_")
    || message.startsWith("MODE_SWITCH_")
    || message.startsWith("POLICY_UPDATE_STATE_BLOCKED")
    || message.startsWith("EXECUTION_MODE_NOT_CERTIFIED")
    || message.startsWith("CAPABILITY_")
    || message.startsWith("生命週期狀態")
    || message.startsWith("preflight ")
    || message === "POLICY_MODE_MISMATCH"
    || message === "STRATEGY_KEY_MISSING"
    || message.startsWith("ILLEGAL_DEPLOYMENT_TRANSITION")
  ) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message, cause: error });
  }
  throw new TRPCError({ code: "BAD_REQUEST", message, cause: error });
}

async function buildReadOnlyPreflight(input: {
  deployment: DeploymentDescriptor;
  targetMode?: ExecutionMode;
  targetPolicy?: ExecutionPolicy;
  resultingRevision: number;
  requireFlat?: boolean;
}) {
  if (!input.deployment.strategyKey) throw new Error("STRATEGY_KEY_MISSING");
  const manifest = await requireStrategyCapabilityManifest(input.deployment.strategyKey);
  const apiKey = await getOwnedDeploymentApiKey(input.deployment);
  let adapter: ReturnType<typeof createAdapter> | undefined;
  let adapterCreationError: string | undefined;
  if (!apiKey) {
    adapterCreationError = "Owned API key record is unavailable.";
  } else {
    try {
      adapter = createAdapter(apiKey);
    } catch (error) {
      adapterCreationError = sanitizedAdapterError(error);
    }
  }

  const descriptor: DeploymentDescriptor = {
    ...input.deployment,
    executionMode: input.targetMode ?? input.deployment.executionMode,
    executionPolicy: input.targetPolicy ?? input.deployment.executionPolicy,
    deploymentRevision: input.resultingRevision,
  };
  const facts = await gatherPreflightFacts({
    deployment: descriptor,
    currentManifest: manifest,
    adapter,
    adapterCreationError,
    requireFlat: input.requireFlat,
  });
  return buildDeploymentPreflightReport(descriptor, facts);
}

async function getAppliedRetry(input: {
  deploymentId: number;
  userId: number;
  expectedRevision: number;
  transitionKey: string;
  allowedToStates: readonly DeploymentActivationState[];
  toMode?: ExecutionMode;
  toPolicyHash?: string;
}) {
  const transition = await getOwnedTransitionByKey(input);
  if (!transition) return undefined;
  if (
    transition.expectedRevision !== input.expectedRevision
    || !input.allowedToStates.includes(transition.toState as DeploymentActivationState)
    || (input.toMode !== undefined && transition.toMode !== input.toMode)
    || (input.toPolicyHash !== undefined && transition.toPolicyHash !== input.toPolicyHash)
  ) {
    throw new Error("TRANSITION_KEY_CONFLICT");
  }
  if (transition.status !== "APPLIED") throw new Error("TRANSITION_RETRY_NOT_APPLIED");
  return {
    deployment: await getOwnedDeploymentRecord(input.deploymentId, input.userId),
    transition,
    deduplicated: true as const,
  };
}

function reportFromRetry(
  retry: LifecycleMutationResult | undefined,
): DeploymentPreflightReport {
  if (!retry) throw new Error("PREFLIGHT_NOT_RUN");
  const report = (retry.transition.preflightReport
    ?? retry.deployment.preflightReport) as DeploymentPreflightReport | null;
  if (!report) throw new Error("PREFLIGHT_NOT_RUN");
  return report;
}

async function mutateLifecycle(
  userId: number,
  input: z.infer<typeof revisionedMutationSchema>,
  kind: keyof typeof lifecycleDefaults,
) {
  const defaults = lifecycleDefaults[kind];
  try {
    return safeMutation(await applyLifecycleTransition({
      deploymentId: input.deploymentId,
      userId,
      expectedRevision: input.expectedRevision,
      transitionKey: input.transitionKey,
      action: defaults.action,
      reasonCode: input.reasonCode ?? defaults.reasonCode,
      reason: input.reason ?? defaults.reason,
    }));
  } catch (error) {
    return lifecycleError(error);
  }
}

export const deploymentsRouter = router({
  list: protectedProcedure
    .input(z.object({
      executionMode: executionModeSchema.optional(),
      activationState: activationStateSchema.optional(),
      includeArchived: z.boolean().default(false),
    }).default({ includeArchived: false }))
    .query(async ({ ctx, input }) => {
      try {
        const deployments = await listOwnedDeployments(ctx.user.id, input);
        return deployments.map(safeDeployment);
      } catch (error) {
        return lifecycleError(error);
      }
    }),

  create: protectedProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(5_000).nullable().optional(),
      apiKeyId: z.number().int().positive(),
      symbol: z.string().trim().min(1).max(32),
      strategyKey: z.string().trim().min(1).max(100),
      executionMode: executionModeSchema.default("SINGLE_EXCLUSIVE"),
      executionPolicy: policySchema.optional(),
      positionSize: z.number().positive().max(1_000_000_000).default(1),
      positionMode: z.enum(["quantity", "usdt"]).default("usdt"),
      leverage: z.number().int().min(1).max(125).default(1),
      direction: z.enum(["long", "short", "both"]).default("both"),
      orderType: z.enum(["market", "limit"]).default("market"),
      maxPositionPct: z.number().min(0).max(100).default(0),
      stopLossPct: z.number().min(0).max(100).default(0),
      takeProfitPct: z.number().min(0).max(10_000).default(0),
      maxDailyLoss: z.number().min(0).default(0),
      martinMultiplier: z.number().min(1).max(100).default(1),
      maxMartinLevel: z.number().int().min(1).max(100).default(1),
      martinSpacingPct: z.number().min(0).max(100).default(0),
      reentryEnabled: z.boolean().default(true),
      reentryCooldownBars: z.number().int().min(0).max(10_000).default(1),
      tradeMode: z.enum(["webhook", "auto"]).default("webhook"),
      kLinePeriod: z.number().int().min(1).max(43_200).default(15),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const manifest = await requireStrategyCapabilityManifest(input.strategyKey);
        const executionPolicy = input.executionPolicy
          ? normalizeStrategyExecutionPolicy(input.strategyKey, input.executionPolicy)
          : createDefaultStrategyExecutionPolicy(input.strategyKey, input.executionMode);
        return safeDeployment(await createCanonicalDeployment({
          ...input,
          userId: ctx.user.id,
          executionPolicy,
          capabilityManifest: manifest,
        }));
      } catch (error) {
        return lifecycleError(error);
      }
    }),

  copy: protectedProcedure
    .input(z.object({
      sourceDeploymentId: deploymentIdSchema,
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(5_000).nullable().optional(),
      executionMode: executionModeSchema.optional(),
      executionPolicy: policySchema.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const source = await getDeploymentForPreflight(input.sourceDeploymentId, ctx.user.id);
        if (!source.strategyKey) throw new Error("STRATEGY_KEY_MISSING");
        const manifest = await requireStrategyCapabilityManifest(source.strategyKey);
        return safeDeployment(await copyCanonicalDeployment({
          ...input,
          userId: ctx.user.id,
          capabilityManifest: manifest,
        }));
      } catch (error) {
        return lifecycleError(error);
      }
    }),

  getStatus: protectedProcedure
    .input(z.object({ deploymentId: deploymentIdSchema }))
    .query(async ({ ctx, input }) => {
      try {
        const status = await getDeploymentStatus(input.deploymentId, ctx.user.id);
        const recentDecisions = await listRecentModeDecisions({
          userId: ctx.user.id,
          strategyId: status.deployment.id,
          limit: 20,
        });
        return { ...status, deployment: safeDeployment(status.deployment), recentDecisions };
      } catch (error) {
        return lifecycleError(error);
      }
    }),

  getHistory: protectedProcedure
    .input(z.object({
      deploymentId: deploymentIdSchema,
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await getLifecycleHistory(input.deploymentId, ctx.user.id, input.limit);
      } catch (error) {
        return lifecycleError(error);
      }
    }),

  runPreflight: protectedProcedure
    .input(revisionedMutationSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const retry = await getAppliedRetry({
          ...input,
          userId: ctx.user.id,
          allowedToStates: ["READY_DISABLED", "PREFLIGHT_FAILED"],
        });
        if (retry) return { report: reportFromRetry(retry), ...safeMutation(retry) };

        const deployment = await getDeploymentForPreflight(input.deploymentId, ctx.user.id);
        const report = await buildReadOnlyPreflight({
          deployment,
          resultingRevision: input.expectedRevision + 1,
        });
        const mutation = await savePreflightReport({
          deploymentId: input.deploymentId,
          userId: ctx.user.id,
          expectedRevision: input.expectedRevision,
          transitionKey: input.transitionKey,
          report,
          reasonCode: input.reasonCode,
          reason: input.reason,
        });
        const effectiveReport = mutation.deduplicated
          ? mutation.transition.preflightReport ?? mutation.deployment.preflightReport
          : report;
        return { report: effectiveReport, ...safeMutation(mutation) };
      } catch (error) {
        return lifecycleError(error);
      }
    }),

  activate: protectedProcedure
    .input(revisionedMutationSchema)
    .mutation(({ ctx, input }) => mutateLifecycle(ctx.user.id, input, "activate")),

  pause: protectedProcedure
    .input(revisionedMutationSchema)
    .mutation(({ ctx, input }) => mutateLifecycle(ctx.user.id, input, "pause")),

  drain: protectedProcedure
    .input(revisionedMutationSchema)
    .mutation(({ ctx, input }) => mutateLifecycle(ctx.user.id, input, "drain")),

  /**
   * Resume is never an enabled=true toggle. It persists a fresh readonly preflight and then
   * activates at the resulting revision. Both journal steps are independently retry-safe.
   */
  resume: protectedProcedure
    .input(revisionedMutationSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const preflightKey = `${input.transitionKey}:preflight`.slice(0, 128);
        let preflight: Awaited<ReturnType<typeof savePreflightReport>> | undefined
          = await getAppliedRetry({
          deploymentId: input.deploymentId,
          userId: ctx.user.id,
          expectedRevision: input.expectedRevision,
          transitionKey: preflightKey,
          allowedToStates: ["READY_DISABLED", "PREFLIGHT_FAILED"],
        });
        let report: DeploymentPreflightReport;
        if (preflight) {
          report = reportFromRetry(preflight);
        } else {
          const deployment = await getDeploymentForPreflight(input.deploymentId, ctx.user.id);
          if (deployment.deploymentRevision !== input.expectedRevision) {
            throw new Error("DEPLOYMENT_REVISION_CONFLICT");
          }
          report = await buildReadOnlyPreflight({
            deployment,
            resultingRevision: input.expectedRevision + 1,
          });
          preflight = await savePreflightReport({
            deploymentId: input.deploymentId,
            userId: ctx.user.id,
            expectedRevision: input.expectedRevision,
            transitionKey: preflightKey,
            report,
            reasonCode: "RESUME_PREFLIGHT",
            reason: input.reason ?? "Fresh readonly preflight requested before resume.",
          });
        }
        if (!report.eligible) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `部署未通過恢復前 preflight：${report.blockerCodes.join(", ")}`,
          });
        }

        const activationKey = `${input.transitionKey}:activate`.slice(0, 128);
        let activation: Awaited<ReturnType<typeof applyLifecycleTransition>> | undefined
          = await getAppliedRetry({
          deploymentId: input.deploymentId,
          userId: ctx.user.id,
          expectedRevision: input.expectedRevision + 1,
          transitionKey: activationKey,
          allowedToStates: ["ACTIVE"],
        });
        activation ??= await applyLifecycleTransition({
          deploymentId: input.deploymentId,
          userId: ctx.user.id,
          expectedRevision: input.expectedRevision + 1,
          transitionKey: activationKey,
          action: "ACTIVATE",
          reasonCode: input.reasonCode ?? "OPERATOR_RESUME",
          reason: input.reason ?? "Operator resumed deployment after fresh passing preflight.",
        });
        return {
          report,
          preflight: safeMutation(preflight),
          activation: safeMutation(activation),
        };
      } catch (error) {
        return lifecycleError(error);
      }
    }),

  disable: protectedProcedure
    .input(revisionedMutationSchema)
    .mutation(({ ctx, input }) => mutateLifecycle(ctx.user.id, input, "disable")),

  block: protectedProcedure
    .input(revisionedMutationSchema)
    .mutation(({ ctx, input }) => mutateLifecycle(ctx.user.id, input, "block")),

  archive: protectedProcedure
    .input(revisionedMutationSchema)
    .mutation(({ ctx, input }) => mutateLifecycle(ctx.user.id, input, "archive")),

  updatePolicy: protectedProcedure
    .input(revisionedMutationSchema.extend({ executionPolicy: policySchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return safeMutation(await updateDeploymentPolicy({
          deploymentId: input.deploymentId,
          userId: ctx.user.id,
          expectedRevision: input.expectedRevision,
          transitionKey: input.transitionKey,
          executionPolicy: input.executionPolicy,
          reasonCode: input.reasonCode ?? "OPERATOR_POLICY_UPDATE",
          reason: input.reason
            ?? "Operator updated execution policy while deployment was flat and disabled.",
        }));
      } catch (error) {
        return lifecycleError(error);
      }
    }),

  switchMode: protectedProcedure
    .input(revisionedMutationSchema.extend({
      executionMode: executionModeSchema,
      executionPolicy: policySchema,
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const deployment = await getDeploymentForPreflight(input.deploymentId, ctx.user.id);
        const targetPolicy = normalizeStrategyExecutionPolicy(
          deployment.strategyKey,
          input.executionPolicy,
        );
        if (targetPolicy.mode !== input.executionMode) throw new Error("POLICY_MODE_MISMATCH");
        const retry = await getAppliedRetry({
          deploymentId: input.deploymentId,
          userId: ctx.user.id,
          expectedRevision: input.expectedRevision,
          transitionKey: input.transitionKey,
          allowedToStates: ["READY_DISABLED"],
          toMode: input.executionMode,
          toPolicyHash: buildExecutionPolicyHash(targetPolicy),
        });
        if (retry) return { report: reportFromRetry(retry), ...safeMutation(retry) };

        const report = await buildReadOnlyPreflight({
          deployment,
          targetMode: input.executionMode,
          targetPolicy,
          resultingRevision: input.expectedRevision + 1,
          requireFlat: true,
        });
        if (!report.eligible) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `模式切換 preflight 未通過：${report.blockerCodes.join(", ")}`,
          });
        }
        const mutation = await switchDeploymentMode({
          deploymentId: input.deploymentId,
          userId: ctx.user.id,
          expectedRevision: input.expectedRevision,
          transitionKey: input.transitionKey,
          executionMode: input.executionMode,
          executionPolicy: targetPolicy,
          preflightReport: report,
          reasonCode: input.reasonCode ?? "OPERATOR_MODE_SWITCH",
          reason: input.reason ?? "Operator changed execution mode after flat and fresh preflight.",
        });
        const effectiveReport = mutation.deduplicated
          ? mutation.transition.preflightReport ?? mutation.deployment.preflightReport
          : report;
        return { report: effectiveReport, ...safeMutation(mutation) };
      } catch (error) {
        return lifecycleError(error);
      }
    }),
});
