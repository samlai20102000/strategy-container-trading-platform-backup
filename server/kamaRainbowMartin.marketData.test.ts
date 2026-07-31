import { describe, expect, it, vi } from "vitest";
import {
  createKamaRainbowMartinBarIdentity,
  fetchKamaRainbowMartinClosedCandles,
  fetchKamaRainbowMartinFreshQuote,
  getKamaRainbowMartinInterval,
  normalizeKamaRainbowMartinCandles,
  normalizeKamaRainbowMartinSymbol,
  parseBybitClosedRows,
} from "./services/kamaRainbowMartinMarketData";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Kama 彩虹馬丁 exchange-aware market data", () => {
  it("映射七種 OKX／Bybit 週期並正規化合約符號", () => {
    expect(getKamaRainbowMartinInterval("okx", "W1")).toBe("1Wutc");
    expect(getKamaRainbowMartinInterval("bybit", "H4")).toBe("240");
    expect(normalizeKamaRainbowMartinSymbol("okx", "BTCUSDT")).toBe("BTC-USDT-SWAP");
    expect(normalizeKamaRainbowMartinSymbol("bybit", "BTC-USDT-SWAP")).toBe("BTCUSDT");
  });

  it("只保留 Bybit 已收盤 bar", () => {
    const now = 10 * 60_000;
    const rows = [
      [String(5 * 60_000), "1", "2", "0.5", "1.5", "10"],
      [String(8 * 60_000), "1.5", "2", "1", "1.8", "8"],
    ];
    expect(parseBybitClosedRows(rows, "M5", now)).toHaveLength(1);
  });

  it("對 K 線排序、去重並以後值覆蓋同 timestamp", () => {
    const normalized = normalizeKamaRainbowMartinCandles([
      { timestamp: 2, open: 2, high: 3, low: 1, close: 2, volume: 1 },
      { timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.2, volume: 1 },
      { timestamp: 2, open: 2, high: 4, low: 1, close: 3, volume: 2 },
    ]);
    expect(normalized.map(candle => candle.timestamp)).toEqual([1, 2]);
    expect(normalized[1].close).toBe(3);
  });

  it("OKX 分頁只接受 confirm=1 並產生穩定 bar identity", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: "0", data: [
        ["300", "3", "4", "2", "3.5", "10", "0", "0", "1"],
        ["200", "2", "3", "1", "2.5", "9", "0", "0", "0"],
      ] }));
    const batch = await fetchKamaRainbowMartinClosedCandles("okx", "BTCUSDT", "M5", 2, { fetcher });
    expect(batch.candles.map(candle => candle.timestamp)).toEqual([300]);
    expect(batch.lastClosedBarIdentity).toBe(createKamaRainbowMartinBarIdentity("okx", "BTCUSDT", "M5", 300));
  });

  it("解析 Bybit fresh bid／ask 並拒絕反轉報價", async () => {
    const good = vi.fn().mockResolvedValue(jsonResponse({ retCode: 0, result: { list: [{ bid1Price: "99", ask1Price: "101" }] } }));
    await expect(fetchKamaRainbowMartinFreshQuote("bybit", "BTCUSDT", { fetcher: good, now: 123 })).resolves.toMatchObject({ mid: 100, capturedAt: 123 });
    const bad = vi.fn().mockResolvedValue(jsonResponse({ retCode: 0, result: { list: [{ bid1Price: "101", ask1Price: "99" }] } }));
    await expect(fetchKamaRainbowMartinFreshQuote("bybit", "BTCUSDT", { fetcher: bad })).rejects.toThrow("反轉");
  });
});
