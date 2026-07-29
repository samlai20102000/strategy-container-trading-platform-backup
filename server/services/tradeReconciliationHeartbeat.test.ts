import { describe, expect, it, vi } from "vitest";
import {
  ensureTradeReconciliationHeartbeat,
  TRADE_RECONCILIATION_HEARTBEAT,
  type TradeReconciliationHeartbeatDependencies,
} from "./tradeReconciliationHeartbeat";

function dependencies(jobs: any[]): TradeReconciliationHeartbeatDependencies {
  return {
    list: vi.fn(async () => ({ total: jobs.length, actorUserId: "owner", jobs })) as any,
    create: vi.fn(async () => ({ taskUid: "task-new" })),
    update: vi.fn(async () => ({})),
  };
}

describe("tradeReconciliationHeartbeat", () => {
  it("使用平台允許的六欄 cron 每分鐘執行一次", () => {
    expect(TRADE_RECONCILIATION_HEARTBEAT.cron).toBe("0 * * * * *");
    expect(TRADE_RECONCILIATION_HEARTBEAT.path).toBe("/api/scheduled/trade-reconciliation");
  });

  it("任務不存在時以 project owner 身分建立", async () => {
    const deps = dependencies([]);
    const result = await ensureTradeReconciliationHeartbeat(deps);

    expect(result).toEqual({ taskUid: "task-new", action: "created" });
    expect(deps.create).toHaveBeenCalledWith(TRADE_RECONCILIATION_HEARTBEAT, "");
    expect(deps.update).not.toHaveBeenCalled();
  });

  it("設定完全一致且啟用時保持冪等，不重複更新", async () => {
    const deps = dependencies([{
      taskUid: "task-existing",
      name: TRADE_RECONCILIATION_HEARTBEAT.name,
      cronExpression: TRADE_RECONCILIATION_HEARTBEAT.cron,
      callbackPath: TRADE_RECONCILIATION_HEARTBEAT.path,
      callbackMethod: "POST",
      description: TRADE_RECONCILIATION_HEARTBEAT.description,
      isEnable: true,
    }]);

    const result = await ensureTradeReconciliationHeartbeat(deps);

    expect(result).toEqual({ taskUid: "task-existing", action: "unchanged" });
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.update).not.toHaveBeenCalled();
  });

  it("舊設定或停用任務會被修正並恢復", async () => {
    const deps = dependencies([{
      taskUid: "task-existing",
      name: TRADE_RECONCILIATION_HEARTBEAT.name,
      cronExpression: "0 */5 * * * *",
      callbackPath: "/api/scheduled/old",
      callbackMethod: "POST",
      description: "舊設定",
      isEnable: false,
    }]);

    const result = await ensureTradeReconciliationHeartbeat(deps);

    expect(result).toEqual({ taskUid: "task-existing", action: "updated" });
    expect(deps.update).toHaveBeenCalledWith("task-existing", expect.objectContaining({
      cron: "0 * * * * *",
      path: "/api/scheduled/trade-reconciliation",
      enable: true,
    }), "");
  });
});
