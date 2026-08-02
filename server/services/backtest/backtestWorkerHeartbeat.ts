import {
  createHeartbeatJob,
  listHeartbeatJobs,
  updateHeartbeatJob,
} from "../../_core/heartbeat";
import {
  BACKTEST_WORKER_NAME,
  upsertBacktestWorkerRegistry,
} from "./durableBacktestRepository";

export const DURABLE_BACKTEST_HEARTBEAT = {
  name: BACKTEST_WORKER_NAME,
  cron: "0 * * * * *",
  path: "/api/scheduled/backtest-worker",
  method: "POST" as const,
  description: "每分鐘接管 durable 回測佇列，以 DB lease、心跳與持久化取消執行 S1／M2／H3",
};

export interface DurableBacktestHeartbeatDependencies {
  list: typeof listHeartbeatJobs;
  create: typeof createHeartbeatJob;
  update: typeof updateHeartbeatJob;
  persistRegistry: typeof upsertBacktestWorkerRegistry;
}

const defaultDependencies: DurableBacktestHeartbeatDependencies = {
  list: listHeartbeatJobs,
  create: createHeartbeatJob,
  update: updateHeartbeatJob,
  persistRegistry: upsertBacktestWorkerRegistry,
};

/**
 * 以 project owner 身分冪等建立或修正唯一 durable 回測 Heartbeat，
 * 並在回傳前保存 taskUid，避免 callback 已觸發卻被 registry 當成 orphan。
 */
export async function ensureDurableBacktestHeartbeat(
  dependencies: DurableBacktestHeartbeatDependencies = defaultDependencies,
): Promise<{
  taskUid: string;
  action: "created" | "updated" | "unchanged";
}> {
  const listed = await dependencies.list("", { page: 1, pageSize: 100 });
  const existing = listed.jobs.find(job => job.name === DURABLE_BACKTEST_HEARTBEAT.name);
  let taskUid: string;
  let action: "created" | "updated" | "unchanged";

  if (!existing) {
    const created = await dependencies.create(DURABLE_BACKTEST_HEARTBEAT, "");
    taskUid = created.taskUid;
    action = "created";
  } else {
    taskUid = existing.taskUid;
    const needsUpdate = existing.cronExpression !== DURABLE_BACKTEST_HEARTBEAT.cron
      || existing.callbackPath !== DURABLE_BACKTEST_HEARTBEAT.path
      || existing.callbackMethod.toUpperCase() !== DURABLE_BACKTEST_HEARTBEAT.method
      || existing.description !== DURABLE_BACKTEST_HEARTBEAT.description
      || !existing.isEnable;
    if (needsUpdate) {
      await dependencies.update(existing.taskUid, {
        cron: DURABLE_BACKTEST_HEARTBEAT.cron,
        path: DURABLE_BACKTEST_HEARTBEAT.path,
        method: DURABLE_BACKTEST_HEARTBEAT.method,
        description: DURABLE_BACKTEST_HEARTBEAT.description,
        enable: true,
      }, "");
      action = "updated";
    } else {
      action = "unchanged";
    }
  }

  await dependencies.persistRegistry(taskUid, true);
  return { taskUid, action };
}
