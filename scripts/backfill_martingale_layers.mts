import { asc } from "drizzle-orm";
import { strategies } from "../drizzle/schema";
import { getDb, listApiKeys } from "../server/db";
import { createAdapter } from "../server/exchanges/factory";
import type { ExchangeAdapter } from "../server/exchanges/types";
import { backfillMartingaleLayersForUser } from "../server/services/martingaleLayerBackfill";
import { initStrategyStudio } from "../server/services/strategyStudio";
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const confirmed = args.has("--confirm-c1");
const exchangeTruth = args.has("--exchange-truth");
const userIdArg = process.argv.find(arg => arg.startsWith("--user-id="));
const requestedUserId = userIdArg ? Number(userIdArg.split("=")[1]) : null;

if (apply && !confirmed) {
  throw new Error("寫入模式必須同時提供 --apply --confirm-c1");
}
if (requestedUserId !== null && (!Number.isInteger(requestedUserId) || requestedUserId <= 0)) {
  throw new Error("--user-id 必須是正整數");
}

const db = await getDb();
if (!db) throw new Error("資料庫不可用");

// 一次性 CLI 必須與正式 server 使用相同 registry bootstrap；初始化日誌改送 stderr，
// 使 stdout 保持為可機器審核的單一 JSON 文件。
const originalConsoleLog = console.log;
console.log = (...values: unknown[]) => console.error(...values);
await initStrategyStudio();

const userRows = requestedUserId === null
  ? await db.selectDistinct({ userId: strategies.userId })
      .from(strategies)
      .orderBy(asc(strategies.userId))
  : [{ userId: requestedUserId }];

const reports = [];
for (const { userId } of userRows) {
  const apiKeyById = new Map(
    exchangeTruth
      ? (await listApiKeys(userId)).map(apiKey => [apiKey.id, apiKey] as const)
      : [],
  );
  const adapterByApiKeyId = new Map<number, ExchangeAdapter>();
  reports.push(await backfillMartingaleLayersForUser(userId, {
    apply,
    resolveOrderTruth: exchangeTruth
      ? async (strategy, trade) => {
          const apiKey = apiKeyById.get(strategy.apiKeyId);
          if (!apiKey || !trade.orderId || apiKey.exchange !== trade.exchange) return {};
          let adapter = adapterByApiKeyId.get(apiKey.id);
          if (!adapter) {
            adapter = createAdapter(apiKey);
            adapterByApiKeyId.set(apiKey.id, adapter);
          }
          return adapter.getOrderExecutionTruth(strategy.symbol, trade.orderId, false);
        }
      : undefined,
  }));
}

const aggregate = reports.reduce((sum, report) => ({
  scannedMartingaleStrategies: sum.scannedMartingaleStrategies + report.scannedMartingaleStrategies,
  eligibleStrategies: sum.eligibleStrategies + report.eligibleStrategies,
  writtenStrategies: sum.writtenStrategies + report.writtenStrategies,
  skippedStrategies: sum.skippedStrategies + report.skippedStrategies,
}), {
  scannedMartingaleStrategies: 0,
  eligibleStrategies: 0,
  writtenStrategies: 0,
  skippedStrategies: 0,
});

const output = JSON.stringify({
  contractVersion: "martin-layer-backfill-cli-v1",
  mode: apply ? "apply" : "dry-run",
  exchangeTruth,
  generatedAt: new Date().toISOString(),
  userCount: userRows.length,
  aggregate,
  reports,
}, null, 2);
console.log = originalConsoleLog;
process.stdout.write(`${output}\n`, () => process.exit(0));
