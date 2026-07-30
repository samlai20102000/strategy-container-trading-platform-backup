import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const { getSnapshotsMock } = vi.hoisted(() => ({
  getSnapshotsMock: vi.fn(),
}));

vi.mock("./services/martingaleLayerSnapshot", () => ({
  getMartingaleLayerSnapshotsForUser: getSnapshotsMock,
}));

import { appRouter } from "./routers";

function createContext(userId: number | null): TrpcContext {
  const user = userId === null
    ? null
    : {
        id: userId,
        openId: `user-${userId}`,
        email: `user-${userId}@example.com`,
        name: `User ${userId}`,
        loginMethod: "manus",
        role: "user" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("strategies.martingaleLayerSnapshots", () => {
  beforeEach(() => {
    getSnapshotsMock.mockReset();
    getSnapshotsMock.mockResolvedValue([]);
  });

  it("未登入時拒絕請求，且不觸發任何快照服務", async () => {
    const caller = appRouter.createCaller(createContext(null));

    await expect(caller.strategies.martingaleLayerSnapshots({
      strategyIds: [11],
      forceRefresh: false,
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(getSnapshotsMock).not.toHaveBeenCalled();
  });

  it("只以登入者 userId 查詢，並在路由邊界去除重複策略 ID", async () => {
    const caller = appRouter.createCaller(createContext(42));

    await caller.strategies.martingaleLayerSnapshots({
      strategyIds: [11, 11, 27],
      forceRefresh: true,
    });

    expect(getSnapshotsMock).toHaveBeenCalledTimes(1);
    expect(getSnapshotsMock).toHaveBeenCalledWith(
      42,
      [11, 27],
      { forceRefresh: true, includeMarketData: true },
    );
  });
});

describe("strategies.martingaleLayerSummaries", () => {
  it("摘要端點不要求市場資料，不會觸發交易所刷新", async () => {
    getSnapshotsMock.mockResolvedValue([{
      strategyId: 11,
      activeCycleCount: 1,
      openLayerCount: 3,
      availability: "ready",
      availabilityReason: null,
    }]);
    const caller = appRouter.createCaller(createContext(42));

    const result = await caller.strategies.martingaleLayerSummaries({
      strategyIds: [11],
    });

    expect(result).toEqual([{
      strategyId: 11,
      activeCycleCount: 1,
      openLayerCount: 3,
      availability: "ready",
      availabilityReason: null,
    }]);
    expect(getSnapshotsMock).toHaveBeenCalledWith(
      42,
      [11],
      { forceRefresh: false, includeMarketData: false },
    );
  });
});
