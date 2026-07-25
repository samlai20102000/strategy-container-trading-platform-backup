import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db";
import { acquireProcessLease, releaseProcessLease } from "./barLock";

vi.mock("../db", () => ({ getDb: vi.fn() }));

type LeaseRow = {
  lockKey: string;
  strategyId: number;
  barTimestamp: number;
  expiresAt: Date;
};

describe("V4 跨實例 ProcessLease", () => {
  let now = 1_000;
  let rows: Map<string, LeaseRow>;
  let fakeDb: any;

  beforeEach(() => {
    rows = new Map<string, LeaseRow>();
    now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Math, "random").mockReturnValue(0.123);

    fakeDb = {
      insert: vi.fn(() => ({
        values: vi.fn(async (row: LeaseRow) => {
          if (rows.has(row.lockKey)) throw new Error("duplicate key");
          rows.set(row.lockKey, row);
        }),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => Array.from(rows.values())),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => {
          rows.clear();
        }),
      })),
    };

    vi.mocked(getDb).mockResolvedValue(fakeDb);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("同一策略的第二個並行請求必須被有效租約攔截", async () => {
    const first = await acquireProcessLease("v35-auto-trade", 42, 5_000);
    const second = await acquireProcessLease("v35-auto-trade", 42, 5_000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(rows).toHaveLength(1);
    expect(Array.from(rows.values())[0]?.strategyId).toBe(-42);
  });

  it("租約過期後可由新實例安全接手", async () => {
    const first = await acquireProcessLease("v35-auto-trade", 42, 100);
    now = 1_500;
    const replacement = await acquireProcessLease("v35-auto-trade", 42, 100);

    expect(first).not.toBeNull();
    expect(replacement).not.toBeNull();
    expect(replacement?.ownerToken).not.toBe(first?.ownerToken);
    expect(Array.from(rows.values())[0]?.barTimestamp).toBe(replacement?.ownerToken);
  });

  it("舊實例不得釋放新實例已接手的租約", async () => {
    const stale = await acquireProcessLease("v35-auto-trade", 42, 100);
    now = 1_500;
    const current = await acquireProcessLease("v35-auto-trade", 42, 100);

    await releaseProcessLease(stale!);
    expect(rows).toHaveLength(1);
    expect(Array.from(rows.values())[0]?.barTimestamp).toBe(current?.ownerToken);

    await releaseProcessLease(current!);
    expect(rows).toHaveLength(0);
  });

  it("DB 不可用時採 fail-closed，不允許重複交易流程", async () => {
    vi.mocked(getDb).mockResolvedValueOnce(null);
    await expect(acquireProcessLease("v35-auto-trade", 42, 5_000)).resolves.toBeNull();
  });

  it.each([
    ["", 42, 5_000],
    ["v35-auto-trade", 0, 5_000],
    ["v35-auto-trade", -1, 5_000],
    ["v35-auto-trade", 42, 0],
  ] as const)("非法參數 scope=%s strategyId=%s ttlMs=%s 必須拒絕", async (scope, strategyId, ttlMs) => {
    await expect(acquireProcessLease(scope, strategyId, ttlMs)).resolves.toBeNull();
  });
});
