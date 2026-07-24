import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

/**
 * P1 三項優化測試（Pasted_content_16.txt 適配版）
 * 驗證：
 *   1. strategies router 具備 setStatus / emergencyCloseAll 程序
 *   2. apiKeys.getServerIP 回傳 tradingViewIPs 與 message
 *   3. setStatus 輸入驗證（running/paused/stopped）
 * 註：涉及真實交易所 API 的路徑由整合環境驗證，此處驗證路由契約與輸入驗證。
 */

function createCaller(user: { id: number; openId: string; role: "admin" | "user" } | null) {
  return appRouter.createCaller({
    user: user as any,
    req: {
      headers: { host: "test.manus.space" },
      protocol: "https",
      get: (key: string) => (key.toLowerCase() === "host" ? "test.manus.space" : undefined),
    } as any,
    res: {} as any,
  } as any);
}

describe("P1 優化：路由契約", () => {
  it("strategies router 應包含 setStatus 程序", () => {
    expect((appRouter as any)._def.procedures["strategies.setStatus"]).toBeDefined();
  });

  it("strategies router 應包含 emergencyCloseAll 程序", () => {
    expect((appRouter as any)._def.procedures["strategies.emergencyCloseAll"]).toBeDefined();
  });

  it("strategies router 應包含 closePosition 程序（支援 pauseAfterClose）", () => {
    expect((appRouter as any)._def.procedures["strategies.closePosition"]).toBeDefined();
  });
});

describe("P1 優化：未登入保護", () => {
  it("setStatus 未登入應拒絕", async () => {
    const caller = createCaller(null);
    await expect(
      caller.strategies.setStatus({ id: 1, status: "paused" }),
    ).rejects.toThrow();
  });

  it("emergencyCloseAll 未登入應拒絕", async () => {
    const caller = createCaller(null);
    await expect(caller.strategies.emergencyCloseAll()).rejects.toThrow();
  });

  it("getServerIP 未登入應拒絕", async () => {
    const caller = createCaller(null);
    await expect(caller.apiKeys.getServerIP()).rejects.toThrow();
  });
});

describe("P1 優化：setStatus 輸入驗證", () => {
  it("不合法的 status 值應被 zod 拒絕", async () => {
    const caller = createCaller({ id: 1, openId: "test", role: "user" });
    await expect(
      // @ts-expect-error 測試非法輸入
      caller.strategies.setStatus({ id: 1, status: "invalid" }),
    ).rejects.toThrow();
  });

  it("缺少 id 應被 zod 拒絕", async () => {
    const caller = createCaller({ id: 1, openId: "test", role: "user" });
    await expect(
      // @ts-expect-error 測試非法輸入
      caller.strategies.setStatus({ status: "paused" }),
    ).rejects.toThrow();
  });
});

describe("P1 優化：getServerIP 回傳 TradingView IP 提示", () => {
  it("應回傳 tradingViewIPs 陣列與 message 字串", async () => {
    const caller = createCaller({ id: 1, openId: "test", role: "user" });
    const result = await caller.apiKeys.getServerIP();
    expect(Array.isArray(result.tradingViewIPs)).toBe(true);
    expect(result.tradingViewIPs.length).toBeGreaterThan(0);
    expect(result.tradingViewIPs).toContain("52.89.214.238");
    expect(typeof result.message).toBe("string");
    expect(result.message).toContain("TradingView");
    expect(Array.isArray(result.allIps)).toBe(true);
    expect(typeof result.ip).toBe("string");
  }, 30000);
});
