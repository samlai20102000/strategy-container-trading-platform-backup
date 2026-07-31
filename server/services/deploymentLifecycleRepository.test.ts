import { beforeEach, describe, expect, it, vi } from "vitest";
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
  type ModeTransition,
  type Strategy,
} from "../../drizzle/schema";
import { createDefaultExecutionPolicy } from "../../shared/executionModes";
import {
  buildDeploymentPreflightReport,
  type DeploymentDescriptor,
  type DeploymentPreflightFacts,
  type DeploymentPreflightReport,
} from "./deploymentLifecycle";
import {
  buildStrategyLogicHash,
  createVersionedCapabilityManifest,
} from "./strategyArtifacts";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("../db", () => ({
  getDb: mocks.getDb,
  listApiKeys: vi.fn(),
  listStrategies: vi.fn(),
}));

import {
  applyLifecycleTransition,
  copyCanonicalDeployment,
  createCanonicalDeployment,
  getDeploymentStatus,
  switchDeploymentMode,
  updateDeploymentPolicy,
} from "./deploymentLifecycleRepository";

const NOW = 1_900_000_000_000;
const OWNER_ID = 7;

function currentManifest() {
  const strategyLogicHash = buildStrategyLogicHash({
    strategyKey: "PHASE8_REPOSITORY_TEST",
    strategyVersion: 2,
    logicSource: "phase8-repository-test-v2",
  });
  return createVersionedCapabilityManifest({
    strategyKey: "PHASE8_REPOSITORY_TEST",
    strategyVersion: 2,
    strategyLogicHash,
    certification: "CERTIFIED",
    capabilities: {
      supportedModes: ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"],
      martingaleLayers: true,
      independentLegState: true,
      hedgeGuard: true,
      preciseLegClose: true,
      reason: "phase8-repository-test-certified",
    },
  });
}

function strategyRow(overrides: Partial<Strategy> = {}): Strategy {
  const manifest = currentManifest();
  return {
    id: 88,
    userId: OWNER_ID,
    deploymentKey: "deployment-repository-88",
    strategyKey: manifest.strategyKey,
    strategyVersion: manifest.strategyVersion,
    executionMode: "MULTI_POSITION",
    executionPolicy: createDefaultExecutionPolicy("MULTI_POSITION"),
    capabilitySnapshot: manifest,
    activationState: "READY_DISABLED",
    deploymentRevision: 4,
    enabled: false,
    apiKeyId: 12,
    exchange: "bybit",
    symbol: "BTCUSDT",
    preflightStatus: "PASSED",
    preflightReport: null,
    preflightHash: null,
    ...overrides,
  } as Strategy;
}

function passingReport(
  row: Strategy,
  target: {
    executionMode?: DeploymentDescriptor["executionMode"];
    executionPolicy?: unknown;
    deploymentRevision?: number;
  } = {},
): DeploymentPreflightReport {
  const manifest = currentManifest();
  const executionMode = target.executionMode ?? row.executionMode;
  const executionPolicy = target.executionPolicy ?? row.executionPolicy;
  const descriptor: DeploymentDescriptor = {
    id: row.id,
    userId: row.userId,
    deploymentKey: row.deploymentKey,
    strategyKey: row.strategyKey,
    strategyVersion: row.strategyVersion,
    executionMode,
    executionPolicy,
    capabilitySnapshot: row.capabilitySnapshot,
    activationState: row.activationState,
    deploymentRevision: target.deploymentRevision ?? row.deploymentRevision,
    enabled: row.enabled,
    apiKeyId: row.apiKeyId,
    exchange: row.exchange,
    symbol: row.symbol,
  };
  const facts: DeploymentPreflightFacts = {
    now: NOW,
    currentManifest: manifest,
    account: {
      exists: true,
      ownerMatches: true,
      exchangeMatches: true,
      lastTestStatus: "success",
      lastTestAt: NOW - 1_000,
    },
    exchangeCapability: {
      exchange: row.exchange,
      symbol: row.symbol,
      positionMode: "HEDGE",
      preciseLegClose: true,
      observedAt: NOW - 1_000,
      source: "repository-test",
    },
    instrument: {
      exchange: row.exchange,
      symbol: row.symbol,
      exists: true,
      active: true,
      minOrderSize: 0.001,
      quantityStep: 0.001,
      observedAt: NOW - 1_000,
      source: "repository-test",
    },
    balance: { free: 9_000, total: 10_000, usedMargin: 100 },
    positions: [],
    openLegCount: 0,
    pendingIntentCount: 0,
    unresolvedReconciliationCount: 0,
    activeHedgeRelationshipCount: 0,
    activeReservationCount: 0,
    requireFlat: true,
  };
  const report = buildDeploymentPreflightReport(descriptor, facts);
  expect(report.eligible).toBe(true);
  return report;
}

type LedgerCounts = {
  openLegCount: number;
  pendingIntentCount: number;
  unresolvedReconciliationCount: number;
  activeHedgeRelationshipCount: number;
  activeReservationCount: number;
  accountPositionCount: number;
};

function queryResult<T>(rows: T[]) {
  const base = Promise.resolve(rows);
  return Object.assign(base, {
    limit: async (limit: number) => rows.slice(0, limit),
    orderBy: () => Object.assign(Promise.resolve(rows), {
      limit: async (limit: number) => rows.slice(0, limit),
    }),
  });
}

function createDbHarness(initial: Strategy | null) {
  let strategy = initial;
  let nextStrategyId = (initial?.id ?? 0) + 100;
  const apiKey = {
    id: 12,
    userId: OWNER_ID,
    exchange: "bybit",
    apiKey: "encrypted-key",
    apiSecret: "encrypted-secret",
    passphrase: null,
    updatedAt: new Date(NOW),
  } as ApiKey;
  const transitions: ModeTransition[] = [];
  let forceStrategyConflict = false;
  let hideStrategy = false;
  const ledger: LedgerCounts = {
    openLegCount: 0,
    pendingIntentCount: 0,
    unresolvedReconciliationCount: 0,
    activeHedgeRelationshipCount: 0,
    activeReservationCount: 0,
    accountPositionCount: 0,
  };

  function rowsFor(table: unknown): unknown[] {
    if (table === strategies) return strategy && !hideStrategy ? [strategy] : [];
    if (table === apiKeys) return [apiKey];
    if (table === modeTransitions) return transitions;
    if (table === positionLegs) return [{ count: ledger.openLegCount }];
    if (table === executionOrderIntents) return [{ count: ledger.pendingIntentCount }];
    if (table === executionReconciliationCases) {
      return [{ count: ledger.unresolvedReconciliationCount }];
    }
    if (table === hedgeRelationships) return [{ count: ledger.activeHedgeRelationshipCount }];
    if (table === executionRiskReservations) return [{ count: ledger.activeReservationCount }];
    if (table === accountPositionSnapshots) return [{ count: ledger.accountPositionCount }];
    return [];
  }

  const db = {
    execute: async () => [],
    select: () => ({
      from: (table: unknown) => ({
        where: () => queryResult(rowsFor(table)),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table === strategies) {
          const insertId = nextStrategyId++;
          strategy = {
            id: insertId,
            createdAt: new Date(NOW),
            updatedAt: new Date(NOW),
            ...values,
          } as Strategy;
          return [{ insertId, affectedRows: 1 }];
        }
        if (table === modeTransitions) {
          transitions.push({
            id: transitions.length + 1,
            createdAt: new Date(NOW),
            updatedAt: new Date(NOW),
            ...values,
          } as ModeTransition);
        }
        return { affectedRows: 1 };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (table === strategies) {
            if (forceStrategyConflict) {
              forceStrategyConflict = false;
              return { affectedRows: 0 };
            }
            if (!strategy) return { affectedRows: 0 };
            const next = { ...strategy, ...values } as Strategy;
            if ("deploymentRevision" in values) {
              next.deploymentRevision = strategy.deploymentRevision + 1;
            }
            strategy = next;
          }
          if (table === modeTransitions) {
            const pending = transitions.findLast(item => item.status === "PENDING");
            if (pending) Object.assign(pending, values);
          }
          return { affectedRows: 1 };
        },
      }),
    }),
    transaction: async <T>(run: (tx: unknown) => Promise<T>) => run(db),
  };

  return {
    db,
    transitions,
    ledger,
    get strategy() { return strategy; },
    forceConflict() { forceStrategyConflict = true; },
    hideStrategy() { hideStrategy = true; },
  };
}

describe("deploymentLifecycleRepository", () => {
  beforeEach(() => {
    mocks.getDb.mockReset();
  });

  it("atomically activates once and deduplicates an identical transition retry", async () => {
    const row = strategyRow();
    const report = passingReport(row);
    row.preflightReport = report;
    row.preflightHash = report.preflightHash;
    const harness = createDbHarness(row);
    mocks.getDb.mockResolvedValue(harness.db);
    const input = {
      deploymentId: row.id,
      userId: OWNER_ID,
      expectedRevision: row.deploymentRevision,
      transitionKey: "activate-idempotency-key",
      action: "ACTIVATE" as const,
      reasonCode: "TEST_ACTIVATE",
      reason: "Repository activation test.",
      now: new Date(NOW),
    };

    const first = await applyLifecycleTransition(input);
    const retry = await applyLifecycleTransition(input);

    expect(first.deduplicated).toBe(false);
    expect(retry.deduplicated).toBe(true);
    expect(harness.strategy).toMatchObject({
      activationState: "ACTIVE",
      enabled: true,
      deploymentRevision: 5,
      preflightStatus: "STALE",
    });
    expect(harness.transitions).toHaveLength(1);
    expect(harness.transitions[0]).toMatchObject({
      status: "APPLIED",
      expectedRevision: 4,
      resultingRevision: 5,
      toState: "ACTIVE",
    });
  });

  it("rejects stale revisions, concurrent update loss and transition-key reuse", async () => {
    const row = strategyRow();
    const report = passingReport(row);
    row.preflightReport = report;
    const harness = createDbHarness(row);
    mocks.getDb.mockResolvedValue(harness.db);
    const base = {
      deploymentId: row.id,
      userId: OWNER_ID,
      expectedRevision: 4,
      transitionKey: "phase8-conflict-key",
      action: "ACTIVATE" as const,
      reasonCode: "TEST",
      reason: "Test transition.",
      now: new Date(NOW),
    };

    await applyLifecycleTransition(base);
    await expect(applyLifecycleTransition({
      ...base,
      action: "DISABLE",
    })).rejects.toThrow("TRANSITION_KEY_CONFLICT");
    harness.transitions.length = 0;
    await expect(applyLifecycleTransition({
      ...base,
      transitionKey: "different-stale-key",
    })).rejects.toThrow("DEPLOYMENT_REVISION_CONFLICT");

    const secondRow = strategyRow({ id: 99 });
    secondRow.preflightReport = passingReport(secondRow);
    const concurrent = createDbHarness(secondRow);
    concurrent.forceConflict();
    mocks.getDb.mockResolvedValue(concurrent.db);
    await expect(applyLifecycleTransition({
      ...base,
      deploymentId: 99,
      transitionKey: "concurrent-update-key",
    })).rejects.toThrow("DEPLOYMENT_REVISION_CONFLICT");
  });

  it("fails owner-scoped reads closed when no owned deployment row is visible", async () => {
    const harness = createDbHarness(strategyRow());
    harness.hideStrategy();
    mocks.getDb.mockResolvedValue(harness.db);

    await expect(getDeploymentStatus(88, 999)).rejects.toThrow("DEPLOYMENT_NOT_FOUND");
  });

  it("rejects mode switching from ACTIVE before any policy write", async () => {
    const row = strategyRow({ activationState: "ACTIVE", enabled: true });
    const harness = createDbHarness(row);
    mocks.getDb.mockResolvedValue(harness.db);
    const targetPolicy = createDefaultExecutionPolicy("HEDGE_GUARDED");
    const report = passingReport({
      ...row,
      activationState: "PAUSED",
      enabled: false,
    }, {
      executionMode: "HEDGE_GUARDED",
      executionPolicy: targetPolicy,
      deploymentRevision: row.deploymentRevision + 1,
    });

    await expect(switchDeploymentMode({
      deploymentId: row.id,
      userId: OWNER_ID,
      expectedRevision: row.deploymentRevision,
      transitionKey: "active-mode-switch-key",
      executionMode: "HEDGE_GUARDED",
      executionPolicy: targetPolicy,
      preflightReport: report,
      reasonCode: "TEST_MODE_SWITCH",
      reason: "Must remain blocked while ACTIVE.",
      now: new Date(NOW),
    })).rejects.toThrow("MODE_SWITCH_STATE_BLOCKED:ACTIVE");
    expect(harness.strategy?.executionMode).toBe("MULTI_POSITION");
    expect(harness.transitions).toHaveLength(0);
  });

  it("allows ACTIVE deployments with open legs to enter DRAINING", async () => {
    const row = strategyRow({ activationState: "ACTIVE", enabled: true });
    const harness = createDbHarness(row);
    harness.ledger.openLegCount = 2;
    harness.ledger.pendingIntentCount = 1;
    mocks.getDb.mockResolvedValue(harness.db);

    const result = await applyLifecycleTransition({
      deploymentId: row.id,
      userId: OWNER_ID,
      expectedRevision: row.deploymentRevision,
      transitionKey: "open-leg-drain-key",
      action: "DRAIN",
      reasonCode: "TEST_OPEN_LEG_DRAIN",
      reason: "Stop new exposure while existing legs drain.",
      now: new Date(NOW),
    });

    expect(result.deduplicated).toBe(false);
    expect(harness.strategy).toMatchObject({
      activationState: "DRAINING",
      enabled: false,
      deploymentRevision: 5,
    });
    expect(harness.transitions[0]).toMatchObject({
      fromState: "ACTIVE",
      toState: "DRAINING",
      expectedRevision: 4,
      resultingRevision: 5,
      status: "APPLIED",
    });
  });

  it("creates a certified canonical deployment in DRAFT and disabled state", async () => {
    const harness = createDbHarness(null);
    mocks.getDb.mockResolvedValue(harness.db);
    const manifest = currentManifest();

    const created = await createCanonicalDeployment({
      userId: OWNER_ID,
      name: "Canonical V2 deployment",
      description: "Created through the deployment lifecycle repository.",
      apiKeyId: 12,
      symbol: "btcusdt",
      strategyKey: manifest.strategyKey,
      executionMode: "MULTI_POSITION",
      executionPolicy: createDefaultExecutionPolicy("MULTI_POSITION"),
      capabilityManifest: manifest,
      positionSize: 150,
      positionMode: "usdt",
      leverage: 3,
    });

    expect(created).toMatchObject({
      userId: OWNER_ID,
      apiKeyId: 12,
      exchange: "bybit",
      symbol: "BTCUSDT",
      enabled: false,
      activationState: "DRAFT",
      deploymentRevision: 1,
      preflightStatus: "NOT_RUN",
      executionMode: "MULTI_POSITION",
      strategyVersion: manifest.strategyVersion,
      heartbeatTaskUid: null,
    });
    expect(created.deploymentKey).toMatch(/^deployment:7:/);
    expect(created.webhookSecret).toHaveLength(48);
    expect(created.preflightReport).toBeNull();
  });

  it("copies configuration into a fresh disabled deployment without runtime state", async () => {
    const source = strategyRow({
      enabled: true,
      activationState: "ACTIVE",
      heartbeatTaskUid: "must-not-copy",
      webhookSecret: "must-not-copy-secret",
      martinState: {
        __v50Config: { alpha: 1 },
        currentLayer: 7,
        lossCount: 11,
        totalSize: 42,
      },
      positionSize: "25",
    });
    const harness = createDbHarness(source);
    mocks.getDb.mockResolvedValue(harness.db);

    const copied = await copyCanonicalDeployment({
      sourceDeploymentId: source.id,
      userId: OWNER_ID,
      name: "Fresh H3 copy",
      executionMode: "HEDGE_GUARDED",
      capabilityManifest: currentManifest(),
    });

    expect(copied.id).not.toBe(source.id);
    expect(copied).toMatchObject({
      name: "Fresh H3 copy",
      enabled: false,
      activationState: "DRAFT",
      deploymentRevision: 1,
      preflightStatus: "NOT_RUN",
      executionMode: "HEDGE_GUARDED",
      heartbeatTaskUid: null,
    });
    expect(copied.executionPolicy).toMatchObject({ mode: "HEDGE_GUARDED" });
    expect(copied.webhookSecret).not.toBe(source.webhookSecret);
    expect(copied.martinState).toMatchObject({
      __v50Config: { alpha: 1 },
      currentLayer: 0,
      lossCount: 0,
      totalSize: 0,
    });
  });

  it("updates a flat disabled policy with optimistic lock and policy-hash idempotency", async () => {
    const row = strategyRow();
    const harness = createDbHarness(row);
    mocks.getDb.mockResolvedValue(harness.db);
    const targetPolicy = {
      ...createDefaultExecutionPolicy("MULTI_POSITION"),
      riskBudget: {
        maxGrossNotionalPct: 125,
        maxMarginUsagePct: 35,
        capabilityTtlSeconds: 90,
      },
    };
    const input = {
      deploymentId: row.id,
      userId: OWNER_ID,
      expectedRevision: row.deploymentRevision,
      transitionKey: "policy-update-idempotency-key",
      executionPolicy: targetPolicy,
      reasonCode: "TEST_POLICY_UPDATE",
      reason: "Update max open legs while flat and disabled.",
      now: new Date(NOW),
    };

    const first = await updateDeploymentPolicy(input);
    const retry = await updateDeploymentPolicy(input);

    expect(first.deduplicated).toBe(false);
    expect(retry.deduplicated).toBe(true);
    expect(harness.strategy).toMatchObject({
      activationState: "DISABLED",
      enabled: false,
      deploymentRevision: 5,
      preflightStatus: "STALE",
      executionPolicy: targetPolicy,
    });
    expect(harness.transitions).toHaveLength(1);
    expect(harness.transitions[0]).toMatchObject({
      status: "APPLIED",
      expectedRevision: 4,
      resultingRevision: 5,
      toState: "DISABLED",
    });

    await expect(updateDeploymentPolicy({
      ...input,
      executionPolicy: {
        ...targetPolicy,
        riskBudget: {
          ...targetPolicy.riskBudget,
          maxMarginUsagePct: 30,
        },
      },
    })).rejects.toThrow("TRANSITION_KEY_CONFLICT");
  });
});
