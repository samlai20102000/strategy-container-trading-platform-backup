/**
 * 測試：OKX 模擬盤交易對驗證
 * 確認 WLD-USDT-SWAP 在模擬盤不可用，在實盤可用
 */
import { describe, it, expect } from "vitest";

describe("OKX 模擬盤/實盤交易對驗證", () => {
  it("實盤應包含 WLD-USDT-SWAP", async () => {
    const res = await fetch("https://www.okx.com/api/v5/public/instruments?instType=SWAP");
    const data = await res.json();
    const wld = data.data?.find((i: any) => i.instId === "WLD-USDT-SWAP");
    expect(wld).toBeTruthy();
    expect(wld.state).toBe("live");
  });

  it("模擬盤不應包含 WLD-USDT-SWAP", async () => {
    const res = await fetch("https://www.okx.com/api/v5/public/instruments?instType=SWAP", {
      headers: { "x-simulated-trading": "1" },
    });
    const data = await res.json();
    const wld = data.data?.find((i: any) => i.instId === "WLD-USDT-SWAP");
    expect(wld).toBeUndefined();
  });

  it("模擬盤應包含 BTC-USDT-SWAP", async () => {
    const res = await fetch("https://www.okx.com/api/v5/public/instruments?instType=SWAP", {
      headers: { "x-simulated-trading": "1" },
    });
    const data = await res.json();
    const btc = data.data?.find((i: any) => i.instId === "BTC-USDT-SWAP");
    expect(btc).toBeTruthy();
    expect(btc.state).toBe("live");
  });

  it("模擬盤交易對數量應少於實盤", async () => {
    const [demoRes, liveRes] = await Promise.all([
      fetch("https://www.okx.com/api/v5/public/instruments?instType=SWAP", {
        headers: { "x-simulated-trading": "1" },
      }),
      fetch("https://www.okx.com/api/v5/public/instruments?instType=SWAP"),
    ]);
    const demoData = await demoRes.json();
    const liveData = await liveRes.json();
    const demoCount = demoData.data?.filter((i: any) => i.state === "live").length || 0;
    const liveCount = liveData.data?.filter((i: any) => i.state === "live").length || 0;
    expect(demoCount).toBeLessThan(liveCount);
    expect(demoCount).toBeGreaterThan(100); // 模擬盤至少有 100+ 個
    expect(liveCount).toBeGreaterThan(400); // 實盤至少有 400+ 個
  });
});
