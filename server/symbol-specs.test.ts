/**
 * 第二輪優化測試套件：
 * 1. roundToStep / normalizeOrderQty 純函數（步長取整、最小量檢查、浮點誤差）
 * 2. getSymbolSpecs 實網獲取（OKX/Bybit 規格解析）
 * 3. 收藏 API 的 DB 幫手（toggle 行為，實庫測試後清理）
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  getSymbolSpecs,
  normalizeOrderQty,
  normalizeQtyForSymbol,
  roundToStep,
  type SymbolSpec,
} from "./services/symbolSpecs";
import { getDb, listFavoriteSymbols, toggleFavoriteSymbol } from "./db";
import { favoriteSymbols } from "../drizzle/schema";
import { like } from "drizzle-orm";

const TEST_USER_ID = 999999;

afterAll(async () => {
  // 清理測試收藏，保持測試可重入
  const db = await getDb();
  if (db) {
    await db.delete(favoriteSymbols).where(like(favoriteSymbols.favKey, `${TEST_USER_ID}:%`));
  }
});

describe("roundToStep 步長取整", () => {
  it("按步長向下取整", () => {
    expect(roundToStep(0.0157, 0.001)).toBe(0.015);
    expect(roundToStep(1.23456, 0.01)).toBe(1.23);
  });

  it("整數倍時不變", () => {
    expect(roundToStep(0.015, 0.001)).toBe(0.015);
    expect(roundToStep(100, 1)).toBe(100);
  });

  it("處理浮點誤差（0.3 / 0.1 = 2.9999... 應為 0.3）", () => {
    expect(roundToStep(0.3, 0.1)).toBe(0.3);
    expect(roundToStep(0.07, 0.01)).toBe(0.07);
  });

  it("無步長時原樣返回", () => {
    expect(roundToStep(0.0157, undefined)).toBe(0.0157);
    expect(roundToStep(0.0157, 0)).toBe(0.0157);
  });
});

describe("normalizeOrderQty 數量正規化", () => {
  const spec: SymbolSpec = { symbol: "BTCUSDT", minOrderQty: 0.001, qtyStep: 0.001 };

  it("符合規格時原樣通過", () => {
    const r = normalizeOrderQty(0.005, spec);
    expect(r.qty).toBe(0.005);
    expect(r.adjusted).toBe(false);
    expect(r.rejected).toBe(false);
  });

  it("不符步長時向下取整並標記 adjusted", () => {
    const r = normalizeOrderQty(0.0057, spec);
    expect(r.qty).toBe(0.005);
    expect(r.adjusted).toBe(true);
    expect(r.rejected).toBe(false);
  });

  it("取整後低於最小量時 rejected", () => {
    const r = normalizeOrderQty(0.0005, spec);
    expect(r.rejected).toBe(true);
    expect(r.reason).toContain("最小下單量");
  });

  it("規格缺失時原樣通過（由交易所端校驗）", () => {
    const r = normalizeOrderQty(0.0057, undefined);
    expect(r.qty).toBe(0.0057);
    expect(r.adjusted).toBe(false);
    expect(r.rejected).toBe(false);
  });

  it("OKX 面值規格：ETH-USDT-SWAP ctVal=0.1 步長取整", () => {
    const okxSpec: SymbolSpec = {
      symbol: "ETH-USDT-SWAP",
      minOrderQty: 0.01, // 0.1 張 × 0.1 ctVal
      qtyStep: 0.01,
      ctVal: 0.1,
    };
    const r = normalizeOrderQty(0.123, okxSpec);
    expect(r.qty).toBe(0.12);
    expect(r.adjusted).toBe(true);
  });
});

describe("getSymbolSpecs 實網規格獲取", () => {
  it("OKX linear 含 BTC-USDT-SWAP 且有 minOrderQty/qtyStep", async () => {
    const specs = await getSymbolSpecs("okx", "linear");
    if (specs.size === 0) {
      console.warn("[test] OKX API 不可達（沙盒網路限制），跳過實網驗證");
      return;
    }
    expect(specs.size).toBeGreaterThan(100);
    const btc = specs.get("BTC-USDT-SWAP");
    expect(btc).toBeDefined();
    expect(btc!.minOrderQty).toBeGreaterThan(0);
    expect(btc!.qtyStep).toBeGreaterThan(0);
    expect(btc!.ctVal).toBeGreaterThan(0);
  }, 20000);

  it("Bybit linear 含 BTCUSDT 且有 minOrderQty/qtyStep", async () => {
    const specs = await getSymbolSpecs("bybit", "linear");
    if (specs.size === 0) {
      console.warn("[test] Bybit API 不可達（沙盒網路限制），跳過實網驗證");
      return;
    }
    expect(specs.size).toBeGreaterThan(100);
    const btc = specs.get("BTCUSDT");
    expect(btc).toBeDefined();
    expect(btc!.minOrderQty).toBeGreaterThan(0);
    expect(btc!.qtyStep).toBeGreaterThan(0);
  }, 30000);

  it("normalizeQtyForSymbol 端到端：OKX BTC-USDT-SWAP 校正非法數量", async () => {
    const specs = await getSymbolSpecs("okx", "linear");
    if (specs.size === 0 || !specs.get("BTC-USDT-SWAP")) {
      console.warn("[test] OKX API 不可達（沙盒網路限制），跳過實網驗證");
      return;
    }
    const btc = specs.get("BTC-USDT-SWAP")!;
    // 構造一個略高於最小量但不符步長的數量
    const raw = btc.minOrderQty! + btc.qtyStep! * 1.5;
    const r = await normalizeQtyForSymbol("okx", "BTC-USDT-SWAP", raw, "linear");
    expect(r.rejected).toBe(false);
    // 校正後應為步長整數倍
    const steps = r.qty / btc.qtyStep!;
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
  }, 20000);
});

describe("收藏交易對 DB 幫手", () => {
  it("toggle 兩次：先收藏後取消", async () => {
    const first = await toggleFavoriteSymbol(TEST_USER_ID, "okx", "BTC-USDT-SWAP");
    expect(first.favorited).toBe(true);

    const list = await listFavoriteSymbols(TEST_USER_ID, "okx");
    expect(list.some((f) => f.symbol === "BTC-USDT-SWAP")).toBe(true);

    const second = await toggleFavoriteSymbol(TEST_USER_ID, "okx", "BTC-USDT-SWAP");
    expect(second.favorited).toBe(false);

    const after = await listFavoriteSymbols(TEST_USER_ID, "okx");
    expect(after.some((f) => f.symbol === "BTC-USDT-SWAP")).toBe(false);
  }, 20000);

  it("收藏按交易所隔離", async () => {
    await toggleFavoriteSymbol(TEST_USER_ID, "bybit", "ETHUSDT");
    const okxList = await listFavoriteSymbols(TEST_USER_ID, "okx");
    expect(okxList.some((f) => f.symbol === "ETHUSDT")).toBe(false);
    const bybitList = await listFavoriteSymbols(TEST_USER_ID, "bybit");
    expect(bybitList.some((f) => f.symbol === "ETHUSDT")).toBe(true);
    // 清理
    await toggleFavoriteSymbol(TEST_USER_ID, "bybit", "ETHUSDT");
  }, 20000);
});
