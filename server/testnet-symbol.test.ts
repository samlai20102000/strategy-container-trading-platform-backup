/**
 * 測試：OKX 模擬盤交易對驗證
 * 確認 WLD-USDT-SWAP 在模擬盤不可用，在實盤可用
 */
import { describe, it, expect } from "vitest";

// 此檔會直接連線 OKX 公網，屬 live 整合測試而非確定性單元測試。
// 預設測試套件不依賴外網；需要驗證交易所即時清單時請設定：
// RUN_OKX_INTEGRATION_TESTS=1 pnpm vitest run server/testnet-symbol.test.ts --testTimeout=30000
const RUN_LIVE_OKX_TESTS = process.env.RUN_OKX_INTEGRATION_TESTS === "1";

describe.runIf(RUN_LIVE_OKX_TESTS)("OKX 模擬盤/實盤交易對驗證", () => {
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
