import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Strategy } from "../../drizzle/schema";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  listStrategies: vi.fn(),
  evaluateMartingaleStrategyInstance: vi.fn(),
}));

vi.mock("../db", () => ({
  getDb: mocks.getDb,
  listStrategies: mocks.listStrategies,
}));

vi.mock("./martingaleCapability", () => ({
  evaluateMartingaleStrategyInstance: mocks.evaluateMartingaleStrategyInstance,
}));

import { backfillMartingaleLayersForUser } from "./martingaleLayerBackfill";

function strategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: 41,
    userId: 1,
    name: "KAMA 3K V6.1 高頻掃射 - 導入",
    strategyKey: "KAMA_3K_HF_V61",
    maxMartinLevel: 11,
    martinState: { totalSize: 2, avgPrice: 110, isLong: false },
    ...overrides,
  } as Strategy;
}

describe("backfillMartingaleLayersForUser safety gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.evaluateMartingaleStrategyInstance.mockImplementation((instance: Strategy) => ({
      isMartingale: instance.strategyKey === "KAMA_3K_HF_V61",
      supportsMartingale: instance.strategyKey === "KAMA_3K_HF_V61",
      enabled: instance.strategyKey === "KAMA_3K_HF_V61",
      maxLayers: instance.strategyKey === "KAMA_3K_HF_V61" ? 11 : 0,
      reason: instance.strategyKey === "KAMA_3K_HF_V61" ? "enabled" : "strategy_not_registered",
    }));
  });

  it("已有活躍 cycle 時冪等跳過，且不解析任何歷史訂單真值", async () => {
    const db = {
      select: vi.fn()
        .mockImplementationOnce(() => ({
          from: () => ({
            where: () => ({ orderBy: vi.fn().mockResolvedValue([]) }),
          }),
        }))
        .mockImplementationOnce(() => ({
          from: () => ({
            where: vi.fn().mockResolvedValue([{ strategyId: 41 }]),
          }),
        })),
    };
    mocks.getDb.mockResolvedValue(db);
    mocks.listStrategies.mockResolvedValue([strategy()]);
    const resolveOrderTruth = vi.fn();

    const report = await backfillMartingaleLayersForUser(1, { resolveOrderTruth });

    expect(report).toMatchObject({
      scannedMartingaleStrategies: 1,
      eligibleStrategies: 0,
      writtenStrategies: 0,
      skippedStrategies: 1,
    });
    expect(report.decisions).toEqual([
      expect.objectContaining({ strategyId: 41, reason: "existing_active_cycle", written: false }),
    ]);
    expect(resolveOrderTruth).not.toHaveBeenCalled();
  });

  it("非馬丁策略零接入：不查 trades、cycles 或交易所真值", async () => {
    const db = { select: vi.fn() };
    mocks.getDb.mockResolvedValue(db);
    mocks.listStrategies.mockResolvedValue([
      strategy({ strategyKey: "UNKNOWN_NON_MARTINGALE", parameters: {} }),
    ]);
    const resolveOrderTruth = vi.fn();

    const report = await backfillMartingaleLayersForUser(1, { resolveOrderTruth });

    expect(report).toMatchObject({
      scannedMartingaleStrategies: 0,
      eligibleStrategies: 0,
      writtenStrategies: 0,
      skippedStrategies: 0,
      decisions: [],
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(resolveOrderTruth).not.toHaveBeenCalled();
  });
});
