import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function collectProductionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectProductionTypeScriptFiles(absolutePath);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [absolutePath]
      : [];
  });
}

describe("durable backtest architecture guard", () => {
  const repository = readFileSync(
    resolve(process.cwd(), "server/services/backtest/durableBacktestRepository.ts"),
    "utf8",
  );
  const manager = readFileSync(
    resolve(process.cwd(), "server/services/backtest/backtestJobManager.ts"),
    "utf8",
  );
  const heartbeat = readFileSync(
    resolve(process.cwd(), "server/services/backtest/backtestWorkerHeartbeat.ts"),
    "utf8",
  );
  const server = readFileSync(resolve(process.cwd(), "server/_core/index.ts"), "utf8");
  const backtestProductionFiles = [
    resolve(process.cwd(), "server/routers/backtest.router.ts"),
    ...collectProductionTypeScriptFiles(resolve(process.cwd(), "server/services/backtest")),
  ];

  it("checkpoint 的百分比、processed bars 與 total bars 均保持資料庫單調遞增", () => {
    expect(repository).toMatch(/progress:\s*sql`GREATEST\(/);
    expect(repository).toMatch(/processedBars:\s*sql`GREATEST\(/);
    expect(repository).toMatch(/totalBars:\s*sql`GREATEST\(/);
  });

  it("完成結果與 completed 終態由同一 lease token 條件更新保存", () => {
    expect(repository).toMatch(/function persistCompletedBacktest[\s\S]*status:\s*"completed"[\s\S]*eq\(backtestJobs\.leaseToken, input\.leaseToken\)/);
  });

  it("所有 production backtest 執行都經 DB lease 且每 250 棒 checkpoint", () => {
    expect(manager).toContain("acquireNextBacktestLease");
    expect(manager).toContain("const CHECKPOINT_BAR_INTERVAL = 250");
    expect(manager).toContain("checkpointBacktestLease");
  });

  it("Heartbeat endpoint 必須 cron-only、驗證 taskUid 並使用 durable worker", () => {
    const endpoint = server.split('app.post("/api/scheduled/backtest-worker"')[1]?.split("// 24/7 自動交易")[0] ?? "";
    expect(endpoint).toContain("user?.isCron");
    expect(endpoint).toContain("verifyBacktestWorkerTask(taskUid)");
    expect(endpoint).toContain("runDurableWorkerTick()");
    expect(endpoint).toContain("recordBacktestWorkerRun");
  });

  it("production 必須冪等建立 project Heartbeat 並在 callback 前保存 taskUid registry", () => {
    expect(heartbeat).toContain('cron: "0 * * * * *"');
    expect(heartbeat).toContain('path: "/api/scheduled/backtest-worker"');
    expect(heartbeat).toContain("dependencies.persistRegistry(taskUid, true)");
    expect(server).toContain("ensureDurableBacktestHeartbeat");
  });

  it("回測 submit／cancel／progress／result 與所有 runner 不得觸發實盤交易 mutation", () => {
    const forbiddenPatterns = [
      { label: "placeOrder", pattern: /\.placeOrder\s*\(/ },
      { label: "cancelOrder", pattern: /\.cancelOrder\s*\(/ },
      { label: "closePositionSmart", pattern: /\.closePositionSmart\s*\(/ },
      { label: "createOrderIntent", pattern: /\bcreateOrderIntent\s*\(/ },
      {
        label: "live execution dependency",
        pattern: /from\s+["'][^"']*(?:\/executor|orderPolicy|kamaRainbowMartin(?:Advanced)?Executor|positionManager|riskMonitor)["']/,
      },
    ];

    for (const filePath of backtestProductionFiles) {
      const source = readFileSync(filePath, "utf8");
      for (const { label, pattern } of forbiddenPatterns) {
        expect(source, `${filePath} must not contain ${label}`).not.toMatch(pattern);
      }
    }
  });
});
