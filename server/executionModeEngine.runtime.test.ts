import { describe, expect, it } from "vitest";
import {
  buildCandidateIntent,
  evaluateStrategyMode,
} from "./services/executionModeEngine";

const strategy = {
  id: 42,
  deploymentKey: "deployment-runtime-contract",
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
};

describe("execution mode runtime candidate contract", () => {
  it("同一 source/event key 產生穩定 candidate id，不同 source 不碰撞", () => {
    const first = buildCandidateIntent(strategy, {
      action: "buy",
      source: "MANUAL",
      eventKey: "signal-77",
      requestedQuantity: 0.25,
    }, 77);
    const retry = buildCandidateIntent(strategy, {
      action: "buy",
      source: "MANUAL",
      eventKey: "signal-77",
      requestedQuantity: 0.25,
    }, 77);
    const webhook = buildCandidateIntent(strategy, {
      action: "buy",
      source: "WEBHOOK",
      eventKey: "signal-77",
      requestedQuantity: 0.25,
    }, 77);

    expect(retry.candidateId).toBe(first.candidateId);
    expect(webhook.candidateId).not.toBe(first.candidateId);
    expect(first.source).toBe("MANUAL");
    expect(first.requestedQuantity).toBe(0.25);
    expect(first.candidateId.length).toBeLessThanOrEqual(128);
  });

  it("advanced mode decision receives requested quantity", () => {
    const envelope = evaluateStrategyMode(strategy, {
      action: "sell",
      source: "AUTO",
      eventKey: "bar-1700000000000",
      requestedQuantity: 0.4,
    }, 0, {
      runtimeReady: true,
      openLegs: [],
      capabilities: {
        supportsIndependentLongShort: true,
        canPreciselyCloseLeg: true,
        capturedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_600_000,
      },
      now: 1_700_000_100_000,
    });

    expect(envelope.candidate.source).toBe("AUTO");
    expect(envelope.decision.outcome).toBe("APPROVED");
    expect(envelope.decision.approvedQuantity).toBe(0.4);
  });

  it("非法或非正 requested quantity 不進入 candidate", () => {
    expect(buildCandidateIntent(strategy, {
      action: "buy",
      requestedQuantity: -1,
    }, 9).requestedQuantity).toBeUndefined();
  });

  it("單腿 close 產生 CLOSE_LONG intent，並將核准數量鎖定於 ledger leg 上限", () => {
    const envelope = evaluateStrategyMode(strategy, {
      action: "close",
      positionSide: "long",
      source: "RISK",
      eventKey: "risk-close-long-1",
      requestedQuantity: 2,
    }, 0, {
      runtimeReady: true,
      openLegs: [{
        legId: "long-leg",
        side: "LONG",
        role: "INDEPENDENT",
        status: "OPEN",
        quantity: 0.45,
      }, {
        legId: "short-leg",
        side: "SHORT",
        role: "INDEPENDENT",
        status: "OPEN",
        quantity: 0.2,
      }],
      capabilities: {
        supportsIndependentLongShort: true,
        canPreciselyCloseLeg: true,
        capturedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_600_000,
      },
      now: 1_700_000_100_000,
    });

    expect(envelope.candidate.action).toBe("CLOSE_LONG");
    expect(envelope.candidate.side).toBe("LONG");
    expect(envelope.decision.targetLegId).toBe("long-leg");
    expect(envelope.decision.targetSide).toBe("LONG");
    expect(envelope.decision.approvedQuantity).toBe(0.45);
    expect(envelope.decision.contextSnapshot.closeLegIds).toEqual(["long-leg"]);
  });
});
