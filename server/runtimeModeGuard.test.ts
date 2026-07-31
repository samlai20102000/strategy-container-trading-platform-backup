import { describe, expect, it, vi } from "vitest";
import type { ExchangeAdapter } from "./exchanges/types";
import {
  authorizeRuntimeModeAction,
  runtimeModeRejectionMessage,
  type RuntimeModeGuardDependencies,
} from "./services/runtimeModeGuard";

const adapter = {} as ExchangeAdapter;
const strategy = {
  id: 77,
  userId: 9,
  apiKeyId: 3,
  deploymentKey: "runtime-guard-test",
  executionMode: "MULTI_POSITION" as const,
  executionPolicy: {
    contractVersion: "execution-policy-v1" as const,
    mode: "MULTI_POSITION" as const,
    maxOpenLegs: 2 as const,
    independentLegState: true as const,
    legScopedMartin: true as const,
    riskBudget: {
      maxGrossNotionalPct: 100,
      maxMarginUsagePct: 50,
      maxMarginPerLegPct: 25,
      capabilityTtlSeconds: 300,
      instrumentTtlSeconds: 300,
    },
  },
  activationState: "ACTIVE" as const,
  symbol: "BTCUSDT",
};

function dependencies(overrides: Partial<RuntimeModeGuardDependencies> = {}): RuntimeModeGuardDependencies {
  return {
    loadRuntimeContext: vi.fn(async () => ({
      runtimeReady: true,
      openLegs: [],
      capabilities: {
        supportsIndependentLongShort: true,
        canPreciselyCloseLeg: true,
        capturedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_600_000,
      },
      now: 1_700_000_100_000,
    })),
    recordDecision: vi.fn(async () => true),
    ...overrides,
  };
}

describe("runtime mode guard", () => {
  it("核准並先持久化 M2 runtime decision", async () => {
    const deps = dependencies();
    const result = await authorizeRuntimeModeAction({
      strategy,
      adapter,
      signal: {
        action: "buy",
        requestedQuantity: 0.2,
        source: "MANUAL",
        eventKey: "manual-55",
      },
      signalId: 55,
    }, deps);

    expect(result.allowed).toBe(true);
    expect(result.envelope.decision.outcome).toBe("APPROVED");
    expect(result.envelope.decision.approvedQuantity).toBe(0.2);
    expect(deps.recordDecision).toHaveBeenCalledOnce();
  });

  it("PAUSED 新曝險 fail closed，但仍記錄拒絕決策", async () => {
    const deps = dependencies();
    const result = await authorizeRuntimeModeAction({
      strategy: { ...strategy, activationState: "PAUSED" },
      adapter,
      signal: { action: "sell", source: "AUTO", eventKey: "bar-1" },
      signalId: 0,
    }, deps);

    expect(result.allowed).toBe(false);
    expect(result.envelope.decision.reasonCode).toBe("ACTIVATION_PAUSED");
    expect(runtimeModeRejectionMessage(result)).toContain("ACTIVATION_PAUSED");
    expect(deps.recordDecision).toHaveBeenCalledOnce();
  });

  it("decision ledger 寫入失敗時禁止觸達交易所", async () => {
    const result = await authorizeRuntimeModeAction({
      strategy,
      adapter,
      signal: { action: "buy", source: "WEBHOOK", eventKey: "webhook-99" },
      signalId: 99,
    }, dependencies({
      recordDecision: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    }));

    expect(result.allowed).toBe(false);
    expect(result.envelope.decision.reasonCode).toBe("DECISION_PERSISTENCE_FAILED");
    expect(result.persistenceError).toBe("database unavailable");
  });

  it("相同 decision 已存在時禁止重複送單", async () => {
    const result = await authorizeRuntimeModeAction({
      strategy,
      adapter,
      signal: { action: "buy", source: "AUTO", eventKey: "bar-duplicate" },
      signalId: 0,
    }, dependencies({
      recordDecision: vi.fn(async () => false),
    }));

    expect(result.allowed).toBe(false);
    expect(result.envelope.decision.reasonCode).toBe("DUPLICATE_RUNTIME_EVENT");
    expect(result.envelope.decision.contextSnapshot.deduplicated).toBe(true);
  });
});
