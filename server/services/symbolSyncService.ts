/**
 * 交易對同步和驗證服務
 * 
 * 功能：
 * 1. 從 OKX API 同步所有支持的交易對
 * 2. 驗證系統中的交易對是否在 OKX 上存在
 * 3. 自動轉換交易對格式為標準 OKX 格式
 * 4. 提供交易對列表查詢和驗證 API
 * 
 * 目標：確保系統與 OKX 交易對名稱 100% 一致
 */

import type { ExchangeAdapter } from "../exchanges/types";

export interface SymbolInfo {
  instId: string;           // OKX 標準格式 (e.g., "ETH-USDT-SWAP")
  baseCcy: string;          // 基礎幣種 (e.g., "ETH")
  quoteCcy: string;         // 計價幣種 (e.g., "USDT")
  instType: string;         // 交易類型 (e.g., "SWAP", "SPOT")
  state: string;            // 交易對狀態 (e.g., "live", "suspend")
  ctVal?: number;           // 合約面值 (僅限合約)
  minSz?: number;           // 最小下單量
  lotSz?: number;           // 下單量精度
}

// 緩存 OKX 交易對列表
const symbolCache = new Map<string, { symbols: Map<string, SymbolInfo>; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小時

/**
 * 從 OKX API 獲取所有支持的交易對
 * @param instType 交易類型: "SPOT" | "SWAP" | "FUTURES"
 * @returns 交易對映射表 (key: instId, value: SymbolInfo)
 */
export async function fetchOkxSymbols(instType: "SPOT" | "SWAP" | "FUTURES" = "SWAP"): Promise<Map<string, SymbolInfo>> {
  const cacheKey = `okx:${instType}`;
  const cached = symbolCache.get(cacheKey);
  
  // 檢查緩存
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    console.log(`[SymbolSync] 使用緩存的 ${instType} 交易對列表 (${cached.symbols.size} 個)`);
    return cached.symbols;
  }

  console.log(`[SymbolSync] 從 OKX API 獲取 ${instType} 交易對列表...`);

  const symbols = new Map<string, SymbolInfo>();
  
  try {
    const url = `https://www.okx.com/api/v5/public/instruments?instType=${instType}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.code !== "0") {
      throw new Error(`OKX API error: ${data.code} ${data.msg}`);
    }

    // 解析交易對數據
    for (const item of data.data || []) {
      // 只保留 live 狀態的交易對
      if (item.state !== "live") continue;

      const symbolInfo: SymbolInfo = {
        instId: item.instId,
        baseCcy: item.baseCcy,
        quoteCcy: item.quoteCcy,
        instType: item.instType,
        state: item.state,
      };

      // 合約類型添加額外信息
      if (instType === "SWAP") {
        symbolInfo.ctVal = item.ctVal ? parseFloat(item.ctVal) : undefined;
        symbolInfo.minSz = item.minSz ? parseFloat(item.minSz) : undefined;
        symbolInfo.lotSz = item.lotSz ? parseFloat(item.lotSz) : undefined;
      } else {
        symbolInfo.minSz = item.minSz ? parseFloat(item.minSz) : undefined;
        symbolInfo.lotSz = item.lotSz ? parseFloat(item.lotSz) : undefined;
      }

      symbols.set(item.instId, symbolInfo);
    }

    // 保存到緩存
    symbolCache.set(cacheKey, { symbols, fetchedAt: Date.now() });

    console.log(`[SymbolSync] ✓ 成功獲取 ${symbols.size} 個 ${instType} 交易對`);
    return symbols;
  } catch (error) {
    console.error(`[SymbolSync] ✗ 獲取 OKX 交易對失敗:`, error);
    
    // 回退到緩存
    if (cached) {
      console.log(`[SymbolSync] 使用過期緩存 (${cached.symbols.size} 個交易對)`);
      return cached.symbols;
    }
    
    return new Map();
  }
}

/**
 * 驗證交易對是否在 OKX 上存在
 * @param symbol 交易對名稱 (可以是任何格式)
 * @param instType 交易類型
 * @returns SymbolInfo 如果存在，否則 null
 */
export async function validateSymbol(symbol: string, instType: "SPOT" | "SWAP" | "FUTURES" = "SWAP"): Promise<SymbolInfo | null> {
  // 標準化交易對名稱
  const normalized = normalizeSymbol(symbol);
  
  // 獲取 OKX 交易對列表
  const okxSymbols = await fetchOkxSymbols(instType);
  
  // 精確匹配
  if (okxSymbols.has(normalized)) {
    return okxSymbols.get(normalized) || null;
  }

  // 模糊匹配（處理不同格式）
  let result: SymbolInfo | null = null;
  okxSymbols.forEach((info, instId) => {
    if (instId.toUpperCase() === normalized.toUpperCase()) {
      result = info;
    }
  });
  
  if (result) return result;

  console.warn(`[SymbolSync] ✗ 交易對 "${symbol}" 在 OKX ${instType} 上不存在`);
  return null;
}

/**
 * 將交易對名稱標準化為 OKX 格式
 * 
 * 支持的格式：
 * - "ETHUSDT" → "ETH-USDT-SWAP"
 * - "ETH-USDT" → "ETH-USDT-SWAP"
 * - "ETH/USDT" → "ETH-USDT-SWAP"
 * - "ETH-USDT-SWAP" → "ETH-USDT-SWAP"
 * - "ETH_USDT_SWAP" → "ETH-USDT-SWAP"
 * 
 * @param symbol 任何格式的交易對名稱
 * @param instType 交易類型 (默認 "SWAP")
 * @returns OKX 標準格式的交易對名稱
 */
export function normalizeSymbol(symbol: string, instType: "SPOT" | "SWAP" | "FUTURES" = "SWAP"): string {
  if (!symbol) return "";

  // 移除空格並轉大寫
  let clean = symbol.trim().toUpperCase();

  // 移除所有分隔符
  clean = clean.replace(/[-_/]/g, "");

  // 移除已有的交易類型後綴
  clean = clean.replace(/SWAP$/, "").replace(/SPOT$/, "").replace(/FUTURES$/, "");

  // 檢測計價幣種
  let quote = "USDT";
  if (clean.endsWith("USDC")) {
    quote = "USDC";
    clean = clean.slice(0, -4);
  } else if (clean.endsWith("USD")) {
    quote = "USD";
    clean = clean.slice(0, -3);
  } else if (clean.endsWith("USDT")) {
    quote = "USDT";
    clean = clean.slice(0, -4);
  }

  const base = clean;

  // 組裝 OKX 標準格式
  if (instType === "SPOT") {
    return `${base}-${quote}`;
  } else if (instType === "FUTURES") {
    return `${base}-${quote}-FUTURES`;
  } else {
    return `${base}-${quote}-SWAP`;
  }
}

/**
 * 獲取所有支持的交易對列表
 * @param instType 交易類型
 * @returns 交易對列表
 */
export async function getSymbolList(instType: "SPOT" | "SWAP" | "FUTURES" = "SWAP"): Promise<string[]> {
  const symbols = await fetchOkxSymbols(instType);
  return Array.from(symbols.keys()).sort();
}

/**
 * 批量驗證交易對
 * @param symbols 交易對列表
 * @param instType 交易類型
 * @returns 驗證結果 { valid: [], invalid: [] }
 */
export async function validateSymbols(symbols: string[], instType: "SPOT" | "SWAP" | "FUTURES" = "SWAP"): Promise<{
  valid: string[];
  invalid: string[];
}> {
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const symbol of symbols) {
    const result = await validateSymbol(symbol, instType);
    if (result) {
      valid.push(result.instId);
    } else {
      invalid.push(symbol);
    }
  }

  return { valid, invalid };
}

/**
 * 清除交易對緩存
 * @param instType 交易類型 (如果不指定則清除所有)
 */
export function clearSymbolCache(instType?: "SPOT" | "SWAP" | "FUTURES"): void {
  if (instType) {
    symbolCache.delete(`okx:${instType}`);
    console.log(`[SymbolSync] 已清除 ${instType} 交易對緩存`);
  } else {
    symbolCache.clear();
    console.log(`[SymbolSync] 已清除所有交易對緩存`);
  }
}

/**
 * 獲取交易對信息
 * @param symbol 交易對名稱
 * @param instType 交易類型
 * @returns SymbolInfo 或 null
 */
export async function getSymbolInfo(symbol: string, instType: "SPOT" | "SWAP" | "FUTURES" = "SWAP"): Promise<SymbolInfo | null> {
  const normalized = normalizeSymbol(symbol, instType);
  const symbols = await fetchOkxSymbols(instType);
  return symbols.get(normalized) || null;
}

/**
 * 系統初始化時的驗證
 * 檢查系統中的所有交易對是否在 OKX 上存在
 */
export async function initializeSymbolValidation(): Promise<void> {
  console.log("[SymbolSync] 初始化交易對驗證...");
  
  try {
    // 預加載 SWAP 交易對
    const swapSymbols = await fetchOkxSymbols("SWAP");
    console.log(`[SymbolSync] ✓ 預加載 ${swapSymbols.size} 個 SWAP 交易對`);

    // 預加載 SPOT 交易對
    const spotSymbols = await fetchOkxSymbols("SPOT");
    console.log(`[SymbolSync] ✓ 預加載 ${spotSymbols.size} 個 SPOT 交易對`);

    // 驗證常用交易對
    const commonSymbols = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"];
    for (const symbol of commonSymbols) {
      const info = await validateSymbol(symbol, "SWAP");
      if (info) {
        console.log(`[SymbolSync] ✓ 驗證 ${symbol} 成功`);
      } else {
        console.warn(`[SymbolSync] ✗ 驗證 ${symbol} 失敗`);
      }
    }

    console.log("[SymbolSync] ✓ 初始化完成");
  } catch (error) {
    console.error("[SymbolSync] ✗ 初始化失敗:", error);
  }
}
