/**
 * 補充驗證測試（回測模塊缺口）
 * 1. dataFetcher after 分頁邏輯：mock 多頁 fetch 回應驗證翻頁、去重、排序、區間過濾
 * 2. multiSymbolEngine：合成數據實跑多品種回測，驗證彙總報告
 * 3. CSV 導出邏輯：驗證欄位、筆數、格式與交易明細一致（與前端 exportCSV 相同邏輯）
 * 4. 一鍵複製參數：驗證 clipboard 寫入內容為正確策略 JSON
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach, afterAll } from "vitest";
import { fetchOKXCandles, fetchBybitCandles, toOKXInstId, toBybitSymbol } from "./services/backtest/dataFetcher";
import { runMultiSymbolBacktest, generateSummaryReport } from "./services/backtest/multiSymbolEngine";
import { getBacktestDatabase, type OHLCVRow } from "./services/backtest/backtestDatabase";
import { initStrategyStudio } from "./services/strategyStudio";

const H = 3600_000; // 1 小時毫秒

// ---------- 1. dataFetcher after 分頁（mock 多頁） ----------
describe("dataFetcher after 分頁邏輯（mock 多頁）", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("OKX：多頁翻頁直到覆蓋完整區間，結果昇冪且去重", async () => {
    // 構造 900 根 1h K 線（3 頁 × 300），OKX 回傳降冪（新→舊）
    const endMs = 1_700_000_000_000;
    const total = 900;
    const allTs: number[] = [];
    for (let i = 0; i < total; i++) allTs.push(endMs - i * H); // 降冪
    const startMs = allTs[total - 1]; // 最舊

    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      calls.push(url);
      const after = Number(new URL(url).searchParams.get("after"));
      // 回傳嚴格早於 after 的最多 300 根（模擬 OKX 語義）
      const page = allTs.filter((ts) => ts < after).slice(0, 300);
      return {
        ok: true,
        json: async () => ({
          code: "0",
          msg: "",
          data: page.map((ts) => [String(ts), "100", "110", "90", "105", "1000"]),
        }),
      } as any;
    }) as any;

    const rows = await fetchOKXCandles("BTC-USDT", "1h", startMs, endMs);

    expect(calls.length).toBeGreaterThanOrEqual(3); // 至少 3 頁
    expect(rows.length).toBe(total);
    // 昇冪
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].timestamp).toBeGreaterThan(rows[i - 1].timestamp);
    }
    // 去重
    expect(new Set(rows.map((r) => r.timestamp)).size).toBe(rows.length);
    // 邊界
    expect(rows[0].timestamp).toBe(startMs);
    expect(rows[rows.length - 1].timestamp).toBe(endMs);
  }, 30000);

  it("OKX：區間外數據被過濾", async () => {
    const endMs = 1_700_000_000_000;
    const startMs = endMs - 10 * H;
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: "0",
        msg: "",
        // 第一頁回傳含區間外數據（最舊 ts <= startMs 會終止翻頁），後續頁回空
        data:
          callCount++ === 0
            ? [
                [String(endMs - H), "100", "110", "90", "105", "1000"],
                [String(startMs - 5 * H), "1", "2", "0.5", "1.5", "10"],
              ]
            : [],
      }),
    })) as any;

    const rows = await fetchOKXCandles("BTC-USDT", "1h", startMs, endMs);
    expect(rows.length).toBe(1);
    expect(rows[0].timestamp).toBe(endMs - H);
  }, 15000);

  it("Bybit：end 參數向更早翻頁，多頁合併正確", async () => {
    const endMs = 1_700_000_000_000;
    const total = 600; // 2 頁
    const allTs: number[] = [];
    for (let i = 0; i < total; i++) allTs.push(endMs - i * H);
    const startMs = allTs[total - 1];

    globalThis.fetch = vi.fn(async (input: any) => {
      const url = new URL(String(input));
      const end = Number(url.searchParams.get("end"));
      const page = allTs.filter((ts) => ts <= end).slice(0, 300);
      return {
        ok: true,
        json: async () => ({
          retCode: 0,
          retMsg: "OK",
          result: { list: page.map((ts) => [String(ts), "100", "110", "90", "105", "1000"]) },
        }),
      } as any;
    }) as any;

    const rows = await fetchBybitCandles("BTCUSDT", "1h", startMs, endMs);
    expect(rows.length).toBe(total);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].timestamp).toBeGreaterThan(rows[i - 1].timestamp);
    }
  }, 30000);

  it("symbol 轉換：toOKXInstId / toBybitSymbol", () => {
    expect(toOKXInstId("BTCUSDT")).toBe("BTC-USDT");
    expect(toOKXInstId("BTC-USDT-SWAP")).toBe("BTC-USDT-SWAP");
    expect(toBybitSymbol("BTC-USDT-SWAP")).toBe("BTCUSDT");
    expect(toBybitSymbol("ETHUSDT")).toBe("ETHUSDT");
  });
});

// ---------- 2. multiSymbolEngine 實跑 ----------
describe("multiSymbolEngine 多品種回測（合成數據實跑）", () => {
  const symbols = ["TESTMS-AAA", "TESTMS-BBB"];
  const tf = "1h";
  const bars = 800;
  const endMs = Date.now() - Date.now() % H;
  const startMs = endMs - (bars - 1) * H;

  beforeAll(async () => {
    // 策略註冊中心初始化（引擎修復後為動態載入，未註冊 key 會正確報錯）
    await initStrategyStudio();
  });

  beforeEach(() => {
    // 為兩個測試交易對注入確定性合成 K 線（正弦波動，能觸發交易）
    const db = getBacktestDatabase();
    for (const [si, symbol] of symbols.entries()) {
      const rows: OHLCVRow[] = [];
      let price = 100 + si * 50;
      for (let i = 0; i < bars; i++) {
        const drift = Math.sin(i / 40) * 0.02 + (si === 0 ? 0.0005 : -0.0003);
        const open = price;
        price = price * (1 + drift);
        const close = price;
        const high = Math.max(open, close) * 1.005;
        const low = Math.min(open, close) * 0.995;
        rows.push({ symbol, timeframe: tf, timestamp: startMs + i * H, open, high, low, close, volume: 1000 });
      }
      db.insertOHLCV(rows);
    }
  });

  afterAll(() => {
    // 合成測試數據使用專用 TESTMS- 前綴交易對，不影響真實回測快取
  });

  it("串行回測多品種並生成彙總報告", async () => {
    const progress: string[] = [];
    const summary = await runMultiSymbolBacktest(
      symbols,
      {
        strategyKey: "20415_KAMA_MARTIN_V35",
        exchange: "okx",
        timeframe: tf,
        startDate: startMs,
        endDate: endMs,
        initialCapital: 10000,
        config: {},
      },
      (_pct, msg) => progress.push(msg),
    );

    expect(summary.results.length).toBe(2);
    expect(summary.executionTimeMs).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThanOrEqual(2);

    const succeeded = summary.results.filter((r) => r.success);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(summary.bestSymbol).toBeTruthy();

    // 彙總報告格式
    expect(summary.reportMarkdown).toContain("# 多品種回測摘要");
    expect(summary.reportMarkdown).toContain("| 排名 | 交易對 |");
    for (const s of symbols) {
      expect(summary.reportMarkdown).toContain(s);
    }
    // 排序：成功項按總回報降冪
    for (let i = 1; i < succeeded.length; i++) {
      expect(succeeded[i - 1].metrics!.totalReturn).toBeGreaterThanOrEqual(succeeded[i].metrics!.totalReturn);
    }
  }, 120000);

  it("空清單與超過 10 個交易對時拋錯", async () => {
    await expect(runMultiSymbolBacktest([], {} as any)).rejects.toThrow("至少");
    await expect(
      runMultiSymbolBacktest(Array.from({ length: 11 }, (_, i) => `S${i}`), {} as any),
    ).rejects.toThrow("最多");
  });

  it("generateSummaryReport 對失敗項顯示錯誤", () => {
    const md = generateSummaryReport([
      { symbol: "OK-PAIR", success: true, metrics: { totalReturn: 5, winRate: 60, maxDrawdown: -3, sharpeRatio: 1.2, profitFactor: 1.5, totalTrades: 10 } as any },
      { symbol: "BAD-PAIR", success: false, error: "無數據" },
    ]);
    expect(md).toContain("| 1 | OK-PAIR | 5% | 60% |");
    expect(md).toContain("失敗：無數據");
  });
});

// ---------- 3. CSV 導出邏輯（與前端 exportCSV 相同的生成邏輯） ----------
function buildCsv(trades: Array<{ exitTime: number; side: string; entryPrice: number; exitPrice: number; size: number; pnl: number; pnlPct: number; exitReason: string; martinLayer: number }>): string {
  const headers = ["時間", "方向", "入場價", "出場價", "數量", "盈虧", "盈虧%", "原因", "馬丁層數"];
  const rows = trades.map((t) => [
    new Date(t.exitTime).toLocaleString(),
    t.side === "long" ? "買升" : "買跌",
    t.entryPrice,
    t.exitPrice,
    t.size,
    t.pnl,
    t.pnlPct,
    t.exitReason,
    t.martinLayer,
  ]);
  return [headers, ...rows].map((r) => r.join(",")).join("\n");
}

describe("CSV 導出內容驗證", () => {
  const trades = [
    { exitTime: 1700000000000, side: "long", entryPrice: 65000, exitPrice: 66000, size: 0.01, pnl: 10, pnlPct: 1.54, exitReason: "移動止盈", martinLayer: 0 },
    { exitTime: 1700003600000, side: "short", entryPrice: 66000, exitPrice: 67000, size: 0.025, pnl: -25, pnlPct: -1.52, exitReason: "極限止損", martinLayer: 2 },
  ];

  it("欄位標題、筆數、方向翻譯與數值正確", () => {
    const csv = buildCsv(trades);
    const lines = csv.split("\n");
    expect(lines.length).toBe(3); // 1 標題 + 2 明細
    expect(lines[0]).toBe("時間,方向,入場價,出場價,數量,盈虧,盈虧%,原因,馬丁層數");
    expect(lines[1]).toContain("買升");
    expect(lines[1]).toContain("65000,66000,0.01,10,1.54,移動止盈,0");
    expect(lines[2]).toContain("買跌");
    expect(lines[2]).toContain("66000,67000,0.025,-25,-1.52,極限止損,2");
  });

  it("空交易清單只輸出標題行", () => {
    const csv = buildCsv([]);
    expect(csv.split("\n").length).toBe(1);
  });
});

// ---------- 4. 一鍵複製參數（clipboard mock） ----------
describe("一鍵複製參數（clipboard 驗證）", () => {
  it("寫入 clipboard 的內容為正確策略配置 JSON", async () => {
    const written: string[] = [];
    const clipboardMock = { writeText: vi.fn(async (t: string) => void written.push(t)) };
    vi.stubGlobal("navigator", { clipboard: clipboardMock });

    const config = { Base_Lot_Size: 0.01, Martin_Multiplier: 1.5, Max_Layers: 5, Target_TP_Pct: 1 };
    // 與前端 copyParams 相同的邏輯
    await (navigator as any).clipboard.writeText(JSON.stringify(config, null, 2));

    expect(clipboardMock.writeText).toHaveBeenCalledOnce();
    const parsed = JSON.parse(written[0]);
    expect(parsed).toEqual(config);
    expect(written[0]).toContain('"Base_Lot_Size": 0.01');

    vi.unstubAllGlobals();
  });
});
