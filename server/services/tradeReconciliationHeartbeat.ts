import {
  createHeartbeatJob,
  listHeartbeatJobs,
  updateHeartbeatJob,
} from "../_core/heartbeat";

export const TRADE_RECONCILIATION_HEARTBEAT = {
  name: "trade-pnl-reconciliation",
  cron: "0 * * * * *",
  path: "/api/scheduled/trade-reconciliation",
  method: "POST" as const,
  description: "每分鐘只讀查詢交易所，補齊待結算平倉的權威已實現盈虧與費用",
};

export interface TradeReconciliationHeartbeatDependencies {
  list: typeof listHeartbeatJobs;
  create: typeof createHeartbeatJob;
  update: typeof updateHeartbeatJob;
}

const defaultDependencies: TradeReconciliationHeartbeatDependencies = {
  list: listHeartbeatJobs,
  create: createHeartbeatJob,
  update: updateHeartbeatJob,
};

/** 以 project owner 身分冪等建立或修正全域每分鐘對帳任務。 */
export async function ensureTradeReconciliationHeartbeat(
  dependencies: TradeReconciliationHeartbeatDependencies = defaultDependencies,
): Promise<{
  taskUid: string;
  action: "created" | "updated" | "unchanged";
}> {
  const listed = await dependencies.list("", { page: 1, pageSize: 100 });
  const existing = listed.jobs.find(job => job.name === TRADE_RECONCILIATION_HEARTBEAT.name);
  if (!existing) {
    const created = await dependencies.create(TRADE_RECONCILIATION_HEARTBEAT, "");
    return { taskUid: created.taskUid, action: "created" };
  }

  const needsUpdate = existing.cronExpression !== TRADE_RECONCILIATION_HEARTBEAT.cron
    || existing.callbackPath !== TRADE_RECONCILIATION_HEARTBEAT.path
    || existing.callbackMethod.toUpperCase() !== TRADE_RECONCILIATION_HEARTBEAT.method
    || existing.description !== TRADE_RECONCILIATION_HEARTBEAT.description
    || !existing.isEnable;
  if (!needsUpdate) return { taskUid: existing.taskUid, action: "unchanged" };

  await dependencies.update(existing.taskUid, {
    cron: TRADE_RECONCILIATION_HEARTBEAT.cron,
    path: TRADE_RECONCILIATION_HEARTBEAT.path,
    method: TRADE_RECONCILIATION_HEARTBEAT.method,
    description: TRADE_RECONCILIATION_HEARTBEAT.description,
    enable: true,
  }, "");
  return { taskUid: existing.taskUid, action: "updated" };
}
