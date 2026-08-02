import { describe, expect, it, vi } from "vitest";
import {
  DURABLE_BACKTEST_HEARTBEAT,
  ensureDurableBacktestHeartbeat,
} from "./services/backtest/backtestWorkerHeartbeat";

function existingHeartbeat(overrides: Record<string, unknown> = {}) {
  return {
    taskUid: "task-existing",
    name: DURABLE_BACKTEST_HEARTBEAT.name,
    userId: "owner",
    description: DURABLE_BACKTEST_HEARTBEAT.description,
    cronExpression: DURABLE_BACKTEST_HEARTBEAT.cron,
    callbackPath: DURABLE_BACKTEST_HEARTBEAT.path,
    callbackMethod: DURABLE_BACKTEST_HEARTBEAT.method,
    callbackPayload: "{}",
    isEnable: true,
    createdAt: null,
    lastExecutedAt: null,
    nextExecutionAt: null,
    ...overrides,
  };
}

describe("durable backtest project Heartbeat bootstrap", () => {
  it("缺少任務時建立每分鐘 Heartbeat，並在回傳前保存 taskUid registry", async () => {
    const list = vi.fn(async () => ({ total: 0, actorUserId: "owner", jobs: [] }));
    const create = vi.fn(async () => ({ taskUid: "task-created", nextExecutionAt: null }));
    const update = vi.fn(async () => ({ nextExecutionAt: null }));
    const persistRegistry = vi.fn(async () => undefined);

    const result = await ensureDurableBacktestHeartbeat({ list, create, update, persistRegistry });

    expect(result).toEqual({ taskUid: "task-created", action: "created" });
    expect(create).toHaveBeenCalledWith(DURABLE_BACKTEST_HEARTBEAT, "");
    expect(update).not.toHaveBeenCalled();
    expect(persistRegistry).toHaveBeenCalledWith("task-created", true);
  });

  it("設定已完全一致時不重建排程，但仍修復 registry", async () => {
    const list = vi.fn(async () => ({
      total: 1,
      actorUserId: "owner",
      jobs: [existingHeartbeat()],
    }));
    const create = vi.fn(async () => ({ taskUid: "unused", nextExecutionAt: null }));
    const update = vi.fn(async () => ({ nextExecutionAt: null }));
    const persistRegistry = vi.fn(async () => undefined);

    const result = await ensureDurableBacktestHeartbeat({ list, create, update, persistRegistry });

    expect(result).toEqual({ taskUid: "task-existing", action: "unchanged" });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(persistRegistry).toHaveBeenCalledWith("task-existing", true);
  });

  it("排程停用或 callback 漂移時就地修正同一 taskUid", async () => {
    const list = vi.fn(async () => ({
      total: 1,
      actorUserId: "owner",
      jobs: [existingHeartbeat({ isEnable: false, callbackPath: "/api/scheduled/old" })],
    }));
    const create = vi.fn(async () => ({ taskUid: "unused", nextExecutionAt: null }));
    const update = vi.fn(async () => ({ nextExecutionAt: null }));
    const persistRegistry = vi.fn(async () => undefined);

    const result = await ensureDurableBacktestHeartbeat({ list, create, update, persistRegistry });

    expect(result).toEqual({ taskUid: "task-existing", action: "updated" });
    expect(update).toHaveBeenCalledWith("task-existing", expect.objectContaining({
      cron: "0 * * * * *",
      path: "/api/scheduled/backtest-worker",
      enable: true,
    }), "");
    expect(persistRegistry).toHaveBeenCalledWith("task-existing", true);
  });
});
