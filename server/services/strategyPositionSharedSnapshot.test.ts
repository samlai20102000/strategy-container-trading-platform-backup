import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKey } from "../../drizzle/schema";
import type { Position } from "../exchanges/types";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getPositions: vi.fn(),
  acquireLease: vi.fn(),
  releaseLease: vi.fn(),
}));

vi.mock("../db", () => ({
  getDb: mocks.getDb,
  listApiKeys: vi.fn(),
  listStrategies: vi.fn(),
}));

vi.mock("../exchanges/factory", () => ({
  createAdapter: () => ({ getPositions: mocks.getPositions }),
}));

vi.mock("./barLock", () => ({
  acquireProcessLease: mocks.acquireLease,
  releaseProcessLease: mocks.releaseLease,
}));

import {
  getSharedAccountPositionSnapshot,
  invalidateAccountPositionSnapshotCache,
  MARTINGALE_POSITION_REFRESH_MS,
} from "./strategyPositionSnapshot";

interface SnapshotRow {
  id: number;
  snapshotKey: string;
  userId: number;
  apiKeyId: number;
  exchange: string;
  status: "available" | "error";
  positions: Position[];
  sanitizedError: string | null;
  capturedAt: Date;
  expiresAt: Date;
}

function createDbHarness() {
  let row: SnapshotRow | null = null;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => row ? [row] : [],
        }),
      }),
    }),
    insert: () => ({
      values: (values: Omit<SnapshotRow, "id">) => ({
        onDuplicateKeyUpdate: async () => {
          row = { id: row?.id ?? 1, ...(row ?? {}), ...values } as SnapshotRow;
        },
      }),
    }),
    update: () => ({
      set: (values: Partial<SnapshotRow>) => ({
        where: async () => {
          if (row) row = { ...row, ...values };
        },
      }),
    }),
  };
  return {
    db,
    get row() {
      return row;
    },
  };
}

function apiKey(): ApiKey {
  return {
    id: 7,
    userId: 1,
    exchange: "okx",
    apiKey: "must-not-persist",
    apiSecret: "must-not-persist",
    passphrase: "must-not-persist",
    updatedAt: new Date(1),
  } as ApiKey;
}

function position(markPrice = 101): Position {
  return {
    symbol: "BTC-USDT-SWAP",
    side: "long",
    size: 1,
    entryPrice: 100,
    markPrice,
    unrealizedPnl: markPrice - 100,
    leverage: 10,
    updatedAt: 1_000_000,
  } as Position;
}

describe("strategyPositionSharedSnapshot", () => {
  let now = 1_000_000;
  let harness: ReturnType<typeof createDbHarness>;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    invalidateAccountPositionSnapshotCache();
    harness = createDbHarness();
    mocks.getDb.mockReset().mockResolvedValue(harness.db);
    mocks.getPositions.mockReset();
    mocks.acquireLease.mockReset().mockResolvedValue({ ownerToken: "lease" });
    mocks.releaseLease.mockReset().mockResolvedValue(undefined);
  });

  it("同一帳戶 60 秒內跨 instance 只刷新交易所一次", async () => {
    mocks.getPositions.mockResolvedValue([position()]);
    const first = await getSharedAccountPositionSnapshot(1, apiKey());
    invalidateAccountPositionSnapshotCache();
    now += MARTINGALE_POSITION_REFRESH_MS - 1;
    const second = await getSharedAccountPositionSnapshot(1, apiKey());

    expect(mocks.getPositions).toHaveBeenCalledTimes(1);
    expect(first.positions).toEqual(second.positions);
    expect(mocks.acquireLease).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(harness.row)).not.toContain("must-not-persist");
  });

  it("刷新失敗時保留最後成功快照並附脫敏警告", async () => {
    mocks.getPositions.mockResolvedValueOnce([position(101)]);
    await getSharedAccountPositionSnapshot(1, apiKey());
    invalidateAccountPositionSnapshotCache();
    now += MARTINGALE_POSITION_REFRESH_MS + 1;
    mocks.getPositions.mockRejectedValueOnce(new Error(
      "timeout\napiKey=abc123&secret=def456 Bearer ghijk token=qwerty",
    ));

    const result = await getSharedAccountPositionSnapshot(1, apiKey());

    expect(result.positions[0].markPrice).toBe(101);
    expect(result.refreshError).toContain("[REDACTED]");
    expect(result.refreshError).not.toMatch(/abc123|def456|ghijk|qwerty/);
    expect(harness.row?.status).toBe("available");
    expect(harness.row?.sanitizedError).toBe(result.refreshError);
  });

  it("另一 instance 持有租約時只讀已存快照，不建立第二個交易所請求", async () => {
    mocks.getPositions.mockResolvedValueOnce([position(101)]);
    await getSharedAccountPositionSnapshot(1, apiKey());
    invalidateAccountPositionSnapshotCache();
    now += MARTINGALE_POSITION_REFRESH_MS + 1;
    mocks.acquireLease.mockResolvedValueOnce(null);

    const result = await getSharedAccountPositionSnapshot(1, apiKey());

    expect(result.positions[0].markPrice).toBe(101);
    expect(mocks.getPositions).toHaveBeenCalledTimes(1);
  });
});
