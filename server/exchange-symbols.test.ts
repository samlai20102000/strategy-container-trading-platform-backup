/**
 * 交易對動態搜索 + 倉位單位動態跟隨 測試套件
 * 依據 pasted_content_3.txt 驗收標準：
 * - parseSymbol 正確解析 base/quote（Bybit BTCUSDT / OKX BTC-USDT-SWAP）
 * - 策略引擎支持 Position_Mode / Position_Value 配置格式
 * - USDT 模式按市價換算；quantity 模式直接使用
 * - 切換交易對後基礎貨幣提取正確（BTCUSDT→BTC，ETHUSDT→ETH，SOLUSDT→SOL）
 */
import { describe, expect, it } from "vitest";
import { parseSymbol } from "./routers/exchange.router";
import { strategyKama3kV35 } from "./strategies/v35/strategy_kama_3k_v35";

describe("parseSymbol - 交易對 base/quote 解析", () => {
  it("Bybit 格式：BTCUSDT → BTC/USDT", () => {
    expect(parseSymbol("BTCUSDT")).toEqual({ symbol: "BTCUSDT", base: "BTC", quote: "USDT" });
  });

  it("Bybit 格式：ETHUSDT → ETH/USDT", () => {
    expect(parseSymbol("ETHUSDT")).toEqual({ symbol: "ETHUSDT", base: "ETH", quote: "USDT" });
  });

  it("Bybit 格式：SOLUSDT → SOL/USDT", () => {
    expect(parseSymbol("SOLUSDT")).toEqual({ symbol: "SOLUSDT", base: "SOL", quote: "USDT" });
  });

  it("Bybit USDC 交易對：BTCUSDC → BTC/USDC", () => {
    expect(parseSymbol("BTCUSDC")).toEqual({ symbol: "BTCUSDC", base: "BTC", quote: "USDC" });
  });

  it("OKX SWAP 格式：BTC-USDT-SWAP → BTC/USDT", () => {
    expect(parseSymbol("BTC-USDT-SWAP")).toEqual({
      symbol: "BTC-USDT-SWAP",
      base: "BTC",
      quote: "USDT",
    });
  });

  it("OKX 現貨格式：ETH-USDT → ETH/USDT", () => {
    expect(parseSymbol("ETH-USDT")).toEqual({ symbol: "ETH-USDT", base: "ETH", quote: "USDT" });
  });

  it("反向合約：BTCUSD → BTC/USD", () => {
    expect(parseSymbol("BTCUSD")).toEqual({ symbol: "BTCUSD", base: "BTC", quote: "USD" });
  });

  it("ETH 報價交易對：SOLETH → SOL/ETH", () => {
    expect(parseSymbol("SOLETH")).toEqual({ symbol: "SOLETH", base: "SOL", quote: "ETH" });
  });
});

describe("Position_Mode / Position_Value 配置格式（pasted_content_3.txt 任務 4）", () => {
  it("扁平格式 quantity 模式：直接返回 Position_Value", async () => {
    const config = { Position_Mode: "quantity", Position_Value: 0.05 };
    const lot = await strategyKama3kV35.calculateLotSize(config, 50000);
    expect(lot).toBe(0.05);
  });

  it("扁平格式 usdt 模式：按市價換算（100 USDT / 50000 = 0.002）", async () => {
    const config = { Position_Mode: "usdt", Position_Value: 100 };
    const lot = await strategyKama3kV35.calculateLotSize(config, 50000);
    expect(lot).toBeCloseTo(0.002, 8);
  });

  it("扁平格式優先級高於 Base_Lot_Size 對象格式", async () => {
    const config = {
      Position_Mode: "usdt",
      Position_Value: 200,
      Base_Lot_Size: { value: 0.01, mode: "quantity" },
    };
    const lot = await strategyKama3kV35.calculateLotSize(config, 50000);
    expect(lot).toBeCloseTo(0.004, 8); // 200 / 50000
  });

  it("僅有 Position_Mode 時回退用 Base_Lot_Size 數值", async () => {
    const config = { Position_Mode: "quantity", Base_Lot_Size: 0.03 };
    const lot = await strategyKama3kV35.calculateLotSize(config, 50000);
    expect(lot).toBe(0.03);
  });

  it("usdt 模式馬丁加倉：第 2 層 = (10/2000) × 1.5^2（ETH 場景）", async () => {
    const config = { Position_Mode: "usdt", Position_Value: 10, Martin_Multiplier: 1.5 };
    // ETHUSDT 市價 2000：首單 = 10/2000 = 0.005 ETH
    const lot = await strategyKama3kV35.calculateMartingaleLotSize(config, 2000, 2);
    expect(lot).toBeCloseTo(0.005 * 2.25, 8);
  });

  it("usdt 模式市價無效時拋錯（由決策層轉為 HOLD）", async () => {
    const config = { Position_Mode: "usdt", Position_Value: 100 };
    await expect(strategyKama3kV35.calculateLotSize(config, 0)).rejects.toThrow();
  });
});

describe("UI Schema 接線驗證（pasted_content_3.txt 任務 5）", () => {
  it("strategySchema.json 可被讀取且包含 Symbol / Base_Lot_Size / Position_Mode 欄位", async () => {
    const { readFile } = await import("fs/promises");
    const path = await import("path");
    const raw = await readFile(
      path.resolve(process.cwd(), "server/ui/strategySchema.json"),
      "utf-8",
    );
    const schema = JSON.parse(raw);
    expect(schema.Symbol).toBeDefined();
    expect(schema.Symbol.type).toBe("string");
    expect(schema.Base_Lot_Size.type).toBe("object");
    expect(schema.Base_Lot_Size.properties.mode.enum).toEqual(["quantity", "usdt"]);
    expect(schema.Position_Mode.enum).toEqual(["quantity", "usdt"]);
    expect(schema.Position_Value.type).toBe("number");
  });
});

describe("驗收標準：切換交易對後倉位單位跟隨（前端 parseSymbolClient 邏輯等效驗證）", () => {
  // parseSymbolClient 與後端 parseSymbol 邏輯一致，此處以後端函數驗證等效行為
  it("選擇 BTCUSDT → 基礎貨幣 BTC", () => {
    expect(parseSymbol("BTCUSDT").base).toBe("BTC");
  });
  it("選擇 ETHUSDT → 基礎貨幣 ETH", () => {
    expect(parseSymbol("ETHUSDT").base).toBe("ETH");
  });
  it("選擇 SOLUSDT → 基礎貨幣 SOL", () => {
    expect(parseSymbol("SOLUSDT").base).toBe("SOL");
  });
  it("選擇 OKX DOGE-USDT-SWAP → 基礎貨幣 DOGE", () => {
    expect(parseSymbol("DOGE-USDT-SWAP").base).toBe("DOGE");
  });
});
