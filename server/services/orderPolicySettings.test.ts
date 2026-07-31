import { beforeEach, describe, expect, it, vi } from "vitest";
import { orderPolicySettingEvents, orderPolicySettings } from "../../drizzle/schema";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../db", () => ({ getDb: mocks.getDb }));

import {
  assertSafeOrderPolicyConfig,
  getOrderPolicySettings,
  resetOrderPolicySettings,
  updateOrderPolicySettings,
  type EditableOrderPolicyConfig,
} from "./orderPolicySettings";

const DEFAULT_CONFIG: EditableOrderPolicyConfig = {
  standardTtlMs: 30_000,
  standardMaxAttempts: 3,
  emergencyTtlMs: 2_000,
  emergencyMakerAttempts: 2,
  allowStopLossTaker: true,
  allowDailyLossTaker: true,
  allowKillSwitchTaker: true,
};

function fakeDatabase(initialRow: Record<string, unknown> | null = null) {
  const state: {
    row: Record<string, unknown> | null;
    events: Array<Record<string, unknown>>;
    updateAffectedRows: number;
  } = { row: initialRow, events: [], updateAffectedRows: 1 };

  const select = () => ({
    from: (_table: unknown) => ({
      where: (_condition: unknown) => ({
        limit: async (_limit: number) => state.row ? [state.row] : [],
      }),
    }),
  });

  const tx = {
    select,
    update: (table: unknown) => {
      expect(table).toBe(orderPolicySettings);
      return {
        set: (values: Record<string, unknown>) => ({
          where: async (_condition: unknown) => {
            if (state.updateAffectedRows === 1 && state.row) {
              state.row = { ...state.row, ...values, updatedAt: new Date(1_900_000_000_000) };
            }
            return { affectedRows: state.updateAffectedRows };
          },
        }),
      };
    },
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table === orderPolicySettings) {
          if (state.row) throw new Error("Duplicate primary key");
          state.row = {
            id: 1,
            createdAt: new Date(1_900_000_000_000),
            updatedAt: new Date(1_900_000_000_000),
            ...values,
          };
          return { affectedRows: 1 };
        }
        expect(table).toBe(orderPolicySettingEvents);
        state.events.push({ id: state.events.length + 1, ...values });
        return { affectedRows: 1 };
      },
    }),
  };

  return {
    state,
    db: {
      select,
      transaction: async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx),
    },
  };
}

describe("Maker-First order policy settings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("在沒有自訂列時回傳封印的方案 B 安全預設，而非自行建立可變資料", async () => {
    const fake = fakeDatabase();
    mocks.getDb.mockResolvedValue(fake.db);

    await expect(getOrderPolicySettings(7)).resolves.toMatchObject({
      source: "default",
      revision: 0,
      config: DEFAULT_CONFIG,
      updatedAt: null,
    });
    expect(fake.state.events).toHaveLength(0);
  });

  it("在進入資料庫前拒絕超出安全範圍與非布林 fallback", () => {
    expect(() => assertSafeOrderPolicyConfig({ ...DEFAULT_CONFIG, standardTtlMs: 4_999 }))
      .toThrow("ORDER_POLICY_SETTING_OUT_OF_RANGE:standardTtlMs");
    expect(() => assertSafeOrderPolicyConfig({ ...DEFAULT_CONFIG, emergencyMakerAttempts: 1 }))
      .toThrow("ORDER_POLICY_SETTING_OUT_OF_RANGE:emergencyMakerAttempts");
    expect(() => assertSafeOrderPolicyConfig({ ...DEFAULT_CONFIG, allowKillSwitchTaker: 1 as unknown as boolean }))
      .toThrow("ORDER_POLICY_SETTING_INVALID_BOOLEAN");
  });

  it("首次更新建立 revision 1 並在同一 transaction 寫入 append-only CREATED 事件", async () => {
    const fake = fakeDatabase();
    mocks.getDb.mockResolvedValue(fake.db);
    const next = { ...DEFAULT_CONFIG, allowDailyLossTaker: false };

    const result = await updateOrderPolicySettings({
      userId: 7,
      actorUserId: 7,
      expectedRevision: 0,
      config: next,
      reason: "關閉日虧 taker",
      now: 1_900_000_000_000,
    });

    expect(result).toMatchObject({ source: "custom", revision: 1, config: next });
    expect(fake.state.events).toEqual([expect.objectContaining({
      userId: 7,
      revision: 1,
      eventType: "CREATED",
      previousConfig: null,
      nextConfig: next,
      reason: "關閉日虧 taker",
      eventAt: 1_900_000_000_000,
    })]);
  });

  it("拒絕 stale revision，且不新增事件或覆蓋較新的政策", async () => {
    const current = {
      id: 1,
      userId: 7,
      revision: 3,
      ...DEFAULT_CONFIG,
      updatedAt: new Date(),
    };
    const fake = fakeDatabase(current);
    mocks.getDb.mockResolvedValue(fake.db);

    await expect(updateOrderPolicySettings({
      userId: 7,
      actorUserId: 7,
      expectedRevision: 2,
      config: { ...DEFAULT_CONFIG, allowStopLossTaker: false },
    })).rejects.toThrow("ORDER_POLICY_REVISION_CONFLICT");

    expect(fake.state.row).toBe(current);
    expect(fake.state.events).toHaveLength(0);
  });

  it("既有政策更新遞增 revision、保存前後快照，reset 也只回復封印預設", async () => {
    const previous = {
      id: 1,
      userId: 7,
      revision: 1,
      ...DEFAULT_CONFIG,
      allowStopLossTaker: false,
      updatedAt: new Date(),
    };
    const fake = fakeDatabase(previous);
    mocks.getDb.mockResolvedValue(fake.db);

    const result = await resetOrderPolicySettings({
      userId: 7,
      actorUserId: 7,
      expectedRevision: 1,
      reason: "安全重設",
    });

    expect(result).toMatchObject({ revision: 2, config: DEFAULT_CONFIG });
    expect(fake.state.events).toEqual([expect.objectContaining({
      revision: 2,
      eventType: "RESET",
      previousConfig: expect.objectContaining({ allowStopLossTaker: false }),
      nextConfig: DEFAULT_CONFIG,
    })]);
  });

  it("設定資料庫不可用時 fail-closed，不退回可能過期的記憶體設定", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(getOrderPolicySettings(7)).rejects.toThrow("ORDER_POLICY_SETTINGS_UNAVAILABLE");
  });
});

