import { describe, expect, it } from "vitest";
import { createDefaultExecutionPolicy } from "../../shared/executionModes";
import {
  assertDeploymentTransitionAllowed,
  assertFreshPassingPreflight,
  buildDeploymentPreflightReport,
  lifecycleTargetForAction,
  type DeploymentDescriptor,
  type DeploymentPreflightFacts,
} from "./deploymentLifecycle";
import {
  buildStrategyLogicHash,
  createVersionedCapabilityManifest,
} from "./strategyArtifacts";

const NOW = 1_900_000_000_000;

function manifest() {
  const strategyLogicHash = buildStrategyLogicHash({
    strategyKey: "PHASE8_TEST_STRATEGY",
    strategyVersion: 3,
    logicSource: "phase8-test-logic-v3",
  });
  return createVersionedCapabilityManifest({
    strategyKey: "PHASE8_TEST_STRATEGY",
    strategyVersion: 3,
    strategyLogicHash,
    certification: "CERTIFIED",
    capabilities: {
      supportedModes: ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"],
      martingaleLayers: true,
      independentLegState: true,
      hedgeGuard: true,
      preciseLegClose: true,
      reason: "phase8-test-certified",
    },
  });
}

function deployment(overrides: Partial<DeploymentDescriptor> = {}): DeploymentDescriptor {
  const currentManifest = manifest();
  return {
    id: 88,
    userId: 7,
    deploymentKey: "deployment-phase8-88",
    strategyKey: currentManifest.strategyKey,
    strategyVersion: currentManifest.strategyVersion,
    executionMode: "MULTI_POSITION",
    executionPolicy: createDefaultExecutionPolicy("MULTI_POSITION"),
    capabilitySnapshot: currentManifest,
    activationState: "DISABLED",
    deploymentRevision: 4,
    enabled: false,
    apiKeyId: 12,
    exchange: "bybit",
    symbol: "BTCUSDT",
    ...overrides,
  };
}

function facts(overrides: Partial<DeploymentPreflightFacts> = {}): DeploymentPreflightFacts {
  return {
    now: NOW,
    currentManifest: manifest(),
    account: {
      exists: true,
      ownerMatches: true,
      exchangeMatches: true,
      lastTestStatus: "success",
      lastTestAt: NOW - 1_000,
    },
    exchangeCapability: {
      exchange: "bybit",
      symbol: "BTCUSDT",
      positionMode: "HEDGE",
      preciseLegClose: true,
      observedAt: NOW - 1_000,
      source: "readonly-test-fixture",
    },
    instrument: {
      exchange: "bybit",
      symbol: "BTCUSDT",
      exists: true,
      active: true,
      minOrderSize: 0.001,
      quantityStep: 0.001,
      observedAt: NOW - 1_000,
      source: "readonly-test-fixture",
    },
    balance: { free: 9_000, total: 10_000, usedMargin: 100 },
    positions: [],
    openLegCount: 0,
    pendingIntentCount: 0,
    unresolvedReconciliationCount: 0,
    activeHedgeRelationshipCount: 0,
    activeReservationCount: 0,
    requireFlat: true,
    ...overrides,
  };
}

describe("deployment deterministic preflight", () => {
  it("produces the same passing hash from the same immutable evidence", () => {
    const target = deployment();
    const evidence = facts();
    const first = buildDeploymentPreflightReport(target, evidence);
    const second = buildDeploymentPreflightReport(target, evidence);

    expect(first.eligible).toBe(true);
    expect(first.blockerCodes).toEqual([]);
    expect(first.preflightHash).toBe(second.preflightHash);
    expect(first.executionPolicy.mode).toBe("MULTI_POSITION");
    expect(first.deploymentRevision).toBe(4);
  });

  it("aggregates independent account, capability, instrument, ledger, artifact and risk blockers", () => {
    const report = buildDeploymentPreflightReport(deployment(), facts({
      account: {
        exists: false,
        ownerMatches: false,
        exchangeMatches: false,
        lastTestStatus: "failed",
      },
      exchangeCapability: {
        exchange: "bybit",
        symbol: "BTCUSDT",
        positionMode: "ONE_WAY",
        preciseLegClose: false,
        observedAt: NOW - 10_000_000,
        source: "stale-readonly-test-fixture",
      },
      instrument: {
        exchange: "bybit",
        symbol: "BTCUSDT",
        exists: true,
        active: false,
        minOrderSize: 0,
        quantityStep: 0,
        observedAt: NOW - 10_000_000,
        source: "stale-readonly-test-fixture",
      },
      balance: { free: 1, total: 100, usedMargin: 99 },
      positions: [{
        symbol: "BTCUSDT",
        side: "long",
        size: 10,
        entryPrice: 100,
        markPrice: 100,
        unrealizedPnl: 0,
        leverage: 1,
      }],
      openLegCount: 1,
      pendingIntentCount: 2,
      unresolvedReconciliationCount: 1,
      activeHedgeRelationshipCount: 1,
      activeReservationCount: 1,
      artifactCompatibilityBlockers: ["STRATEGY_VERSION_MISMATCH"],
    }));

    expect(report.eligible).toBe(false);
    expect(report.blockerCodes).toEqual(expect.arrayContaining([
      "ARTIFACT_STRATEGY_VERSION_MISMATCH",
      "ACCOUNT_OWNED",
      "ACCOUNT_EXCHANGE_MATCH",
      "ACCOUNT_CONNECTION_HEALTHY",
      "EXCHANGE_CAPABILITY_FRESH",
      "ACCOUNT_POSITION_MODE_COMPATIBLE",
      "PRECISE_LEG_CLOSE_AVAILABLE",
      "INSTRUMENT_TRADABLE",
      "INSTRUMENT_SPEC_FRESH",
      "INSTRUMENT_SIZE_VALID",
      "LEDGER_FLAT",
      "NO_PENDING_ORDER_INTENTS",
      "NO_UNRESOLVED_RECONCILIATION",
      "NO_ACTIVE_HEDGE_RELATIONSHIP",
      "NO_ACTIVE_RISK_RESERVATION",
      "GROSS_NOTIONAL_WITHIN_BUDGET",
      "MARGIN_USAGE_WITHIN_BUDGET",
    ]));
  });

  it("records only sanitized readonly probe diagnostics as evidence and fails closed", () => {
    const error = "adapter unavailable; apiKey=[REDACTED]";
    const report = buildDeploymentPreflightReport(deployment(), facts({
      exchangeCapability: undefined,
      instrument: undefined,
      balance: undefined,
      positions: undefined,
      probeErrors: {
        capability: error,
        instrument: error,
        balance: error,
        positions: error,
      },
    }));

    expect(report.eligible).toBe(false);
    expect(report.blockerCodes).toEqual(expect.arrayContaining([
      "EXCHANGE_CAPABILITY_AVAILABLE",
      "INSTRUMENT_TRADABLE",
      "ACCOUNT_EQUITY_POSITIVE",
    ]));
    expect(report.checks.find(check => check.code === "EXCHANGE_CAPABILITY_AVAILABLE")?.evidence)
      .toMatchObject({ sanitizedError: error });
    expect(report.checks.find(check => check.code === "ACCOUNT_EQUITY_POSITIVE")?.evidence)
      .toMatchObject({ sanitizedBalanceError: error, sanitizedPositionsError: error });
  });

  it("requires flat ledger by default but supports an explicit non-switch inspection", () => {
    const blocked = buildDeploymentPreflightReport(deployment(), facts({ openLegCount: 1 }));
    const inspection = buildDeploymentPreflightReport(
      deployment(),
      facts({ openLegCount: 1, activeHedgeRelationshipCount: 1, requireFlat: false }),
    );

    expect(blocked.blockerCodes).toContain("LEDGER_FLAT");
    expect(inspection.blockerCodes).not.toContain("LEDGER_FLAT");
    expect(inspection.blockerCodes).not.toContain("NO_ACTIVE_HEDGE_RELATIONSHIP");
  });
});

describe("deployment lifecycle safety contract", () => {
  it("accepts only a fresh report for the same deployment revision, mode and policy", () => {
    const target = deployment();
    const report = buildDeploymentPreflightReport(target, facts());

    expect(() => assertFreshPassingPreflight(report, {
      deploymentId: target.id,
      deploymentRevision: target.deploymentRevision,
      executionMode: target.executionMode,
      executionPolicy: target.executionPolicy,
      now: NOW,
    })).not.toThrow();
    expect(() => assertFreshPassingPreflight(report, {
      deploymentId: target.id,
      deploymentRevision: target.deploymentRevision + 1,
      executionMode: target.executionMode,
      executionPolicy: target.executionPolicy,
      now: NOW,
    })).toThrow("PREFLIGHT_REVISION_STALE");
    expect(() => assertFreshPassingPreflight(report, {
      deploymentId: target.id,
      deploymentRevision: target.deploymentRevision,
      executionMode: "HEDGE_GUARDED",
      executionPolicy: createDefaultExecutionPolicy("HEDGE_GUARDED"),
      now: NOW,
    })).toThrow("PREFLIGHT_POLICY_STALE");
    expect(() => assertFreshPassingPreflight(report, {
      deploymentId: target.id,
      deploymentRevision: target.deploymentRevision,
      executionMode: target.executionMode,
      executionPolicy: target.executionPolicy,
      now: report.expiresAt + 1,
    })).toThrow("PREFLIGHT_EXPIRED");
  });

  it("rejects unsafe transitions including direct activation of ACTIVE or DISABLED state", () => {
    expect(() => assertDeploymentTransitionAllowed("ACTIVE", "ACTIVATE"))
      .toThrow("ILLEGAL_DEPLOYMENT_TRANSITION:ACTIVE:ACTIVATE");
    expect(() => assertDeploymentTransitionAllowed("DISABLED", "ACTIVATE"))
      .toThrow("ILLEGAL_DEPLOYMENT_TRANSITION:DISABLED:ACTIVATE");
    expect(() => assertDeploymentTransitionAllowed("ACTIVE", "ARCHIVE"))
      .toThrow("ILLEGAL_DEPLOYMENT_TRANSITION:ACTIVE:ARCHIVE");
    expect(() => assertDeploymentTransitionAllowed("READY_DISABLED", "ACTIVATE"))
      .not.toThrow();
  });

  it("maps lifecycle actions to explicit persisted states", () => {
    expect(lifecycleTargetForAction("PREFLIGHT_PASS")).toBe("READY_DISABLED");
    expect(lifecycleTargetForAction("PREFLIGHT_FAIL")).toBe("PREFLIGHT_FAILED");
    expect(lifecycleTargetForAction("DRAIN")).toBe("DRAINING");
    expect(lifecycleTargetForAction("DISABLE")).toBe("DISABLED");
    expect(lifecycleTargetForAction("ARCHIVE")).toBe("ARCHIVED");
  });
});
