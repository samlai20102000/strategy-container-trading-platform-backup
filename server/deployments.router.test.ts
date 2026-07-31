import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Strategy } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  getStrategyById: vi.fn(),
  updateStrategy: vi.fn(),
  getDeploymentStatus: vi.fn(),
  applyLifecycleTransition: vi.fn(),
  listOwnedDeployments: vi.fn(),
  createCanonicalDeployment: vi.fn(),
  updateDeploymentPolicy: vi.fn(),
  requireStrategyCapabilityManifest: vi.fn(),
  listRecentModeDecisions: vi.fn(),
}));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  getStrategyById: mocks.getStrategyById,
  updateStrategy: mocks.updateStrategy,
}));

vi.mock("./services/deploymentLifecycleRepository", async importOriginal => ({
  ...(await importOriginal<typeof import("./services/deploymentLifecycleRepository")>()),
  getDeploymentStatus: mocks.getDeploymentStatus,
  applyLifecycleTransition: mocks.applyLifecycleTransition,
  listOwnedDeployments: mocks.listOwnedDeployments,
  createCanonicalDeployment: mocks.createCanonicalDeployment,
  updateDeploymentPolicy: mocks.updateDeploymentPolicy,
}));

vi.mock("./services/strategyCapabilityRegistry", async importOriginal => ({
  ...(await importOriginal<typeof import("./services/strategyCapabilityRegistry")>()),
  requireStrategyCapabilityManifest: mocks.requireStrategyCapabilityManifest,
}));

vi.mock("./services/threeModeLedger", async importOriginal => ({
  ...(await importOriginal<typeof import("./services/threeModeLedger")>()),
  listRecentModeDecisions: mocks.listRecentModeDecisions,
}));

import { appRouter } from "./routers";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createContext(userId = 41): TrpcContext {
  const user: AuthenticatedUser = {
    id: userId,
    openId: `phase8-user-${userId}`,
    email: `phase8-${userId}@example.com`,
    name: "Phase 8 User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(1),
    updatedAt: new Date(1),
    lastSignedIn: new Date(1),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function strategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: 88,
    userId: 41,
    name: "Phase 8 deployment",
    enabled: false,
    activationState: "DISABLED",
    deploymentRevision: 3,
    executionMode: "MULTI_POSITION",
    ...overrides,
  } as Strategy;
}

describe("deployments protected router", () => {
  beforeEach(() => {
    mocks.getStrategyById.mockReset();
    mocks.updateStrategy.mockReset().mockResolvedValue(undefined);
    mocks.getDeploymentStatus.mockReset();
    mocks.listOwnedDeployments.mockReset();
    mocks.createCanonicalDeployment.mockReset();
    mocks.updateDeploymentPolicy.mockReset();
    mocks.listRecentModeDecisions.mockReset().mockResolvedValue([]);
    mocks.requireStrategyCapabilityManifest.mockReset().mockResolvedValue({
      strategyKey: "PHASE8_TEST",
      strategyVersion: 1,
      strategyLogicHash: "logic-hash",
      manifestHash: "manifest-hash",
      certification: "CERTIFIED",
      capabilities: { supportedModes: ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"] },
    });
    mocks.applyLifecycleTransition.mockReset().mockResolvedValue({
      deployment: strategy(),
      transition: { transitionKey: "test" },
      deduplicated: false,
    });
  });

  it("forwards the authenticated owner id to the owner-scoped status repository", async () => {
    const status = {
      deployment: strategy({ webhookSecret: "server-only-webhook-secret" }),
      transitions: [],
    };
    mocks.getDeploymentStatus.mockResolvedValue(status);
    const caller = appRouter.createCaller(createContext(41));

    const result = await caller.deployments.getStatus({ deploymentId: 88 });
    expect(result).toEqual({ deployment: strategy(), transitions: [], recentDecisions: [] });
    expect(result.deployment).not.toHaveProperty("webhookSecret");
    expect(mocks.getDeploymentStatus).toHaveBeenCalledWith(88, 41);
    expect(mocks.listRecentModeDecisions).toHaveBeenCalledWith({
      userId: 41,
      strategyId: 88,
      limit: 20,
    });
  });

  it("lists only the authenticated owner's deployments and redacts webhook secrets", async () => {
    mocks.listOwnedDeployments.mockResolvedValue([
      strategy({ webhookSecret: "list-secret" }),
    ]);
    const caller = appRouter.createCaller(createContext(73));

    const result = await caller.deployments.list({
      executionMode: "MULTI_POSITION",
      includeArchived: false,
    });

    expect(mocks.listOwnedDeployments).toHaveBeenCalledWith(73, {
      executionMode: "MULTI_POSITION",
      includeArchived: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("webhookSecret");
  });

  it("creates through the canonical repository with the authenticated owner and safe DTO", async () => {
    mocks.createCanonicalDeployment.mockResolvedValue(strategy({
      userId: 52,
      webhookSecret: "create-secret",
      activationState: "DRAFT",
      deploymentRevision: 1,
    }));
    const caller = appRouter.createCaller(createContext(52));

    const result = await caller.deployments.create({
      name: "Safe deployment",
      apiKeyId: 12,
      symbol: "BTCUSDT",
      strategyKey: "PHASE8_TEST",
      executionMode: "MULTI_POSITION",
    });

    expect(mocks.createCanonicalDeployment).toHaveBeenCalledWith(expect.objectContaining({
      userId: 52,
      name: "Safe deployment",
      executionMode: "MULTI_POSITION",
      positionSize: 1,
      positionMode: "usdt",
    }));
    expect(result).not.toHaveProperty("webhookSecret");
  });

  it.each([
    ["drain", "DRAIN"],
    ["block", "BLOCK"],
  ] as const)("maps %s to the canonical lifecycle action", async (procedure, action) => {
    const caller = appRouter.createCaller(createContext(41));
    await caller.deployments[procedure]({
      deploymentId: 88,
      expectedRevision: 3,
      transitionKey: `phase8-${procedure}-key`,
    });

    expect(mocks.applyLifecycleTransition).toHaveBeenLastCalledWith(expect.objectContaining({
      deploymentId: 88,
      userId: 41,
      expectedRevision: 3,
      action,
    }));
  });

  it("forwards policy mutation owner, revision and idempotency key", async () => {
    mocks.updateDeploymentPolicy.mockResolvedValue({
      deployment: strategy({ webhookSecret: "policy-secret" }),
      transition: { transitionKey: "policy-update-key" },
      deduplicated: false,
    });
    const caller = appRouter.createCaller(createContext(41));

    const result = await caller.deployments.updatePolicy({
      deploymentId: 88,
      expectedRevision: 3,
      transitionKey: "policy-update-key",
      executionPolicy: {
        mode: "MULTI_POSITION",
        riskBudget: { maxGrossNotionalPct: 90 },
      },
    });

    expect(mocks.updateDeploymentPolicy).toHaveBeenCalledWith(expect.objectContaining({
      deploymentId: 88,
      userId: 41,
      expectedRevision: 3,
      transitionKey: "policy-update-key",
    }));
    expect(result.deployment).not.toHaveProperty("webhookSecret");
  });

  it("maps an invisible or foreign deployment to NOT_FOUND without leaking ownership", async () => {
    mocks.getDeploymentStatus.mockRejectedValue(new Error("DEPLOYMENT_NOT_FOUND"));
    const caller = appRouter.createCaller(createContext(999));

    await expect(caller.deployments.getStatus({ deploymentId: 88 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "部署不存在",
    });
    expect(mocks.getDeploymentStatus).toHaveBeenCalledWith(88, 999);
  });
});

describe("legacy strategy controls cannot bypass canonical activation", () => {
  beforeEach(() => {
    mocks.getStrategyById.mockReset();
    mocks.updateStrategy.mockReset().mockResolvedValue(undefined);
    mocks.applyLifecycleTransition.mockReset().mockResolvedValue({
      deployment: strategy(),
      transition: { transitionKey: "test" },
      deduplicated: false,
    });
  });

  it("rejects canonical enabled=true before any DB write or lifecycle mutation", async () => {
    mocks.getStrategyById.mockResolvedValue(strategy());
    const caller = appRouter.createCaller(createContext());

    await expect(caller.strategies.toggle({ id: 88, enabled: true })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(mocks.updateStrategy).not.toHaveBeenCalled();
    expect(mocks.applyLifecycleTransition).not.toHaveBeenCalled();
  });

  it("rejects canonical legacy setStatus running before any state mutation", async () => {
    mocks.getStrategyById.mockResolvedValue(strategy());
    const caller = appRouter.createCaller(createContext());

    await expect(caller.strategies.setStatus({ id: 88, status: "running" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.updateStrategy).not.toHaveBeenCalled();
    expect(mocks.applyLifecycleTransition).not.toHaveBeenCalled();
  });

  it("routes canonical disable through the revisioned lifecycle repository", async () => {
    mocks.getStrategyById.mockResolvedValue(strategy({
      enabled: true,
      activationState: "ACTIVE",
      deploymentRevision: 9,
    }));
    const caller = appRouter.createCaller(createContext());

    await expect(caller.strategies.toggle({ id: 88, enabled: false }))
      .resolves.toEqual({ success: true });
    expect(mocks.applyLifecycleTransition).toHaveBeenCalledWith(expect.objectContaining({
      deploymentId: 88,
      userId: 41,
      expectedRevision: 9,
      action: "DISABLE",
      reasonCode: "LEGACY_TOGGLE_DISABLE",
    }));
    expect(mocks.updateStrategy).not.toHaveBeenCalled();
  });

  it("preserves the explicitly LEGACY S1 toggle compatibility path", async () => {
    mocks.getStrategyById.mockResolvedValue(strategy({
      activationState: "LEGACY",
      executionMode: "SINGLE_EXCLUSIVE",
      deploymentRevision: 0,
    }));
    const caller = appRouter.createCaller(createContext());

    await expect(caller.strategies.toggle({ id: 88, enabled: true }))
      .resolves.toEqual({ success: true });
    expect(mocks.updateStrategy).toHaveBeenCalledWith(88, 41, expect.objectContaining({
      enabled: true,
      disabledReason: null,
    }));
    expect(mocks.applyLifecycleTransition).not.toHaveBeenCalled();
  });
});
