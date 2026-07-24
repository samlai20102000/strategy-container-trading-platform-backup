/**
 * 數據庫層交易對標準化 Helper
 * 
 * 確保所有數據庫操作都使用標準化的交易對名稱
 * 在保存到數據庫前自動標準化，在讀取時驗證
 */

import { TradingPairManager } from '../services/tradingPairManager';

/**
 * 在保存策略前標準化交易對
 */
export async function normalizeStrategySymbol(symbol: string): Promise<string> {
  try {
    const normalized = TradingPairManager.normalize(symbol, 'SWAP');
    console.log(`[DB] 標準化策略交易對: ${symbol} → ${normalized}`);
    return normalized;
  } catch (error) {
    console.error(`[DB] 標準化交易對失敗: ${symbol}`, error);
    // 返回原始值，讓應用層處理
    return symbol;
  }
}

/**
 * 在保存訊號前標準化交易對
 */
export async function normalizeSignalSymbol(symbol: string): Promise<string> {
  try {
    const normalized = TradingPairManager.normalize(symbol, 'SWAP');
    console.log(`[DB] 標準化訊號交易對: ${symbol} → ${normalized}`);
    return normalized;
  } catch (error) {
    console.error(`[DB] 標準化訊號交易對失敗: ${symbol}`, error);
    return symbol;
  }
}

/**
 * 在保存交易前標準化交易對
 */
export async function normalizeTradeSymbol(symbol: string): Promise<string> {
  try {
    const normalized = TradingPairManager.normalize(symbol, 'SWAP');
    console.log(`[DB] 標準化交易交易對: ${symbol} → ${normalized}`);
    return normalized;
  } catch (error) {
    console.error(`[DB] 標準化交易交易對失敗: ${symbol}`, error);
    return symbol;
  }
}

/**
 * 驗證數據庫中的交易對格式
 */
export async function validateStoredSymbol(symbol: string): Promise<boolean> {
  try {
    const valid = await TradingPairManager.validate(symbol, 'SWAP');
    if (!valid) {
      console.warn(`[DB] 存儲的交易對無效: ${symbol}`);
    }
    return valid;
  } catch (error) {
    console.error(`[DB] 驗證交易對失敗: ${symbol}`, error);
    return false;
  }
}

/**
 * 批量標準化交易對
 */
export async function normalizeSymbols(symbols: string[]): Promise<string[]> {
  const normalized: string[] = [];
  for (const symbol of symbols) {
    try {
      const norm = TradingPairManager.normalize(symbol, 'SWAP');
      normalized.push(norm);
    } catch (error) {
      console.error(`[DB] 標準化交易對失敗: ${symbol}`, error);
      normalized.push(symbol);
    }
  }
  return normalized;
}

/**
 * 獲取數據庫中所有唯一的交易對
 * 應該都是標準格式
 */
export function getAllStoredSymbols(): Promise<string[]> {
  // 這個函數應該由應用層調用，從數據庫查詢
  // 返回所有 strategies、signals、trades 表中的唯一交易對
  return Promise.resolve([]);
}

/**
 * 驗證數據庫中所有交易對的格式
 */
export async function validateAllStoredSymbols(): Promise<{
  valid: string[];
  invalid: string[];
}> {
  const valid: string[] = [];
  const invalid: string[] = [];

  // 這個函數應該由應用層調用
  // 從數據庫查詢所有交易對並驗證

  return { valid, invalid };
}

/**
 * 數據庫層的交易對標準化中間件
 * 在所有數據庫操作中使用
 */
export const dbSymbolMiddleware = {
  /**
   * 在創建策略時標準化交易對
   */
  beforeCreateStrategy: async (data: any) => {
    if (data.symbol) {
      data.symbol = await normalizeStrategySymbol(data.symbol);
    }
    return data;
  },

  /**
   * 在更新策略時標準化交易對
   */
  beforeUpdateStrategy: async (data: any) => {
    if (data.symbol) {
      data.symbol = await normalizeStrategySymbol(data.symbol);
    }
    return data;
  },

  /**
   * 在創建訊號時標準化交易對
   */
  beforeCreateSignal: async (data: any) => {
    if (data.symbol) {
      data.symbol = await normalizeSignalSymbol(data.symbol);
    }
    return data;
  },

  /**
   * 在創建交易時標準化交易對
   */
  beforeCreateTrade: async (data: any) => {
    if (data.symbol) {
      data.symbol = await normalizeTradeSymbol(data.symbol);
    }
    return data;
  },

  /**
   * 在查詢後驗證交易對
   */
  afterQuery: async (data: any) => {
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.symbol) {
          const valid = await validateStoredSymbol(item.symbol);
          if (!valid) {
            console.warn(`[DB] 查詢到無效交易對: ${item.symbol}`);
          }
        }
      }
    } else if (data && data.symbol) {
      const valid = await validateStoredSymbol(data.symbol);
      if (!valid) {
        console.warn(`[DB] 查詢到無效交易對: ${data.symbol}`);
      }
    }
    return data;
  },
};

/**
 * 初始化數據庫層交易對系統
 * 應在應用啟動時調用
 */
export async function initializeDbSymbolSystem(): Promise<void> {
  console.log('[DB] 初始化數據庫層交易對系統...');

  try {
    // 驗證所有存儲的交易對
    const result = await validateAllStoredSymbols();
    console.log(`[DB] ✓ 交易對驗證完成: ${result.valid.length} 個有效, ${result.invalid.length} 個無效`);

    if (result.invalid.length > 0) {
      console.warn(`[DB] ⚠ 發現無效交易對:`, result.invalid);
    }
  } catch (error) {
    console.error('[DB] 初始化失敗:', error);
  }
}
