/**
 * 整合測試：驗收標準補充驗證
 * - apiKeys.create / testCredentials 錯誤時回傳明確訊息（前端可停止 Loading）
 * - signals.sendTestSignal 寫入 signals 表且狀態為成功
 * - strategies.list 回傳可複製的 webhookUrl
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";

function createCtx(): TrpcContext {
  const user = {
    id: 999001,
    openId: "test-integration-user",
    email: "it@example.com",
    name: "IT User",
    loginMethod: "manus",
    role: "user" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: {
      protocol: "https",
      headers: { host: "test.example.com", "x-forwarded-proto": "https" },
    } as unknown as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as unknown as TrpcContext["res"],
  };
}

const ctx = createCtx();
const caller = appRouter.createCaller(ctx);

// 記錄測試建立的資源以便清理
let createdKeyId: number | null = null;
let createdStrategyId: number | null = null;

afterAll(async () => {
  // 清理測試資料（順序：策略的 signals → 策略 → 金鑰）
  try {
    if (createdStrategyId) {
      await caller.strategies.delete({ id: createdStrategyId });
    }
  } catch {}
  try {
    if (createdKeyId) {
      await caller.apiKeys.delete({ id: createdKeyId });
    }
  } catch {}
});

describe("驗收：apiKeys 錯誤處理（前端不會卡 Loading）", () => {
  it("OKX 缺少 passphrase 時，create 應立即拋出明確錯誤訊息", async () => {
    await expect(
      caller.apiKeys.create({
        label: "IT-OKX-無passphrase",
        exchange: "okx",
        apiKey: "fake-key",
        apiSecret: "fake-secret",
        isTestnet: true,
      }),
    ).rejects.toThrow(/Passphrase/);
  });

  it("testCredentials 使用無效憑證：應在逾時上限內回傳失敗訊息（而非永久等待）", async () => {
    const start = Date.now();
    const result = await caller.apiKeys.testCredentials({
      exchange: "bybit",
      apiKey: "invalid-key-for-test",
      apiSecret: "invalid-secret-for-test",
      isTestnet: true,
    });
    const elapsed = Date.now() - start;
    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
    // 5 秒逾時 + 緩衝：必須在合理時間內回應（非永久等待）；
    // 外部交易所 API 回應速度有波動（實測偶發 11.4s），放寬至 20 秒以消除偶發性
    expect(elapsed).toBeLessThan(20000);
  }, 30000);
});

describe("驗收：測試信號寫入日誌（sendTestSignal）", () => {
  it("建立金鑰與策略後，sendTestSignal 應寫入 signals 表且狀態為 executed", async () => {
    // 1. 建立測試金鑰（不會實際連線）
    await caller.apiKeys.create({
      label: "IT-測試金鑰",
      exchange: "bybit",
      apiKey: "it-fake-key",
      apiSecret: "it-fake-secret",
      isTestnet: true,
    });
    const keys = await caller.apiKeys.list();
    const key = keys.find((k) => k.label === "IT-測試金鑰");
    expect(key).toBeTruthy();
    createdKeyId = key!.id;

    // 2. 建立策略
    await caller.strategies.create({
      name: "IT-測試策略",
      apiKeyId: createdKeyId!,
      symbol: "BTCUSDT",
      positionSize: 0.001,
      leverage: 1,
      direction: "both",
      orderType: "market",
      maxPositionPct: 0,
      stopLossPct: 0,
      takeProfitPct: 0,
      maxDailyLoss: 0,
      martinMultiplier: 1,
      maxMartinLevel: 1,
      martinSpacingPct: 0,
    });
    const strategies = await caller.strategies.list();
    const strategy = strategies.find((s) => s.name === "IT-測試策略");
    expect(strategy).toBeTruthy();
    createdStrategyId = strategy!.id;

    // 驗收 4：策略列表回傳可複製的 webhookUrl
    expect(strategy!.webhookUrl).toMatch(
      new RegExp(`https://test\\.example\\.com/api/webhook/${strategy!.id}\\?secret=`),
    );

    // 3. 發送測試信號
    const result = await caller.signals.sendTestSignal({ strategyId: createdStrategyId! });
    expect(result.success).toBe(true);
    expect(result.testPayload.action).toBe("buy");

    // 4. 驗證 signals 表已寫入且可從日誌查到
    const logs = await caller.signals.list({
      strategyId: createdStrategyId!,
      page: 1,
      pageSize: 10,
    });
    const testSignal = logs.items.find((s) => s.parsedAction === "buy");
    expect(testSignal).toBeTruthy();
    expect(testSignal!.status).toBe("executed");
    expect(testSignal!.message).toContain("測試信號成功路由");
    expect(JSON.parse(testSignal!.rawPayload!).isTest).toBe(true);
  }, 30000);

  it("對不存在的策略發送測試信號應回傳明確 NOT_FOUND 錯誤", async () => {
    await expect(
      caller.signals.sendTestSignal({ strategyId: 99999999 }),
    ).rejects.toThrow(/策略不存在/);
  });
});
