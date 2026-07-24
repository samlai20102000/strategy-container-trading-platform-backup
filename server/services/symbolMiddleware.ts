/**
 * 交易對統一中間件
 * 
 * 為所有策略（現有和未來）提供統一的交易對處理
 * 確保無論使用什麼策略、什麼交易對、什麼格式都能完全一致地工作
 * 
 * ★ 核心修復：所有函數新增 testnet 參數，
 *   確保模擬盤環境只能使用模擬盤支持的交易對。
 *   這是全系統級別的修復，適用於所有現有和未來策略。
 * 
 * 使用方式：
 * import { prepareSymbolForExecution } from './symbolMiddleware';
 * 
 * // 在任何策略執行前調用（傳入 apiKey.isTestnet）
 * const result = await prepareSymbolForExecution(symbol, strategyKey, 'SWAP', isTestnet);
 */

import { TradingPairManager } from './tradingPairManager';
import { StrategySymbolAdapter } from './strategySymbolAdapter';

/**
 * 為策略標準化交易對名稱
 * 自動應用到所有策略（V2.0、V3.5、V5.0、V6.1 及未來策略）
 */
export async function normalizeSymbolForStrategy(
  symbol: string,
  strategyKey: string,
  instType: 'SWAP' | 'SPOT' | 'FUTURES' = 'SWAP'
): Promise<string> {
  if (!symbol) {
    throw new Error('[SymbolMiddleware] 交易對名稱不能為空');
  }

  // 使用交易對管理器標準化
  const normalized = TradingPairManager.normalize(symbol, instType);

  console.log(
    `[SymbolMiddleware][${strategyKey}] 標準化交易對: ${symbol} → ${normalized}`
  );

  return normalized;
}

/**
 * 為策略驗證交易對
 * ★ 核心修復：新增 testnet 參數，驗證時區分實盤/模擬盤
 */
export async function validateSymbolForStrategy(
  symbol: string,
  strategyKey: string,
  instType: 'SWAP' | 'SPOT' | 'FUTURES' = 'SWAP',
  testnet: boolean = false,
): Promise<boolean> {
  if (!symbol) {
    console.warn(`[SymbolMiddleware][${strategyKey}] 交易對名稱不能為空`);
    return false;
  }

  const envLabel = testnet ? '模擬盤' : '實盤';
  const valid = await TradingPairManager.validate(symbol, instType, testnet);

  if (valid) {
    console.log(
      `[SymbolMiddleware][${strategyKey}] ✓ 交易對${envLabel}驗證成功: ${symbol}`
    );
  } else {
    console.warn(
      `[SymbolMiddleware][${strategyKey}] ✗ 交易對${envLabel}驗證失敗: ${symbol}（該交易對在 OKX ${envLabel}不可用）`
    );
  }

  return valid;
}

/**
 * 為策略獲取交易對配置
 */
export async function getSymbolConfigForStrategy(
  symbol: string,
  strategyKey: string,
  instType: 'SWAP' | 'SPOT' | 'FUTURES' = 'SWAP',
  testnet: boolean = false,
) {
  if (!symbol) {
    throw new Error('[SymbolMiddleware] 交易對名稱不能為空');
  }

  const normalized = TradingPairManager.normalize(symbol, instType);
  const config = await TradingPairManager.getConfig(normalized, instType, testnet);

  if (config) {
    console.log(
      `[SymbolMiddleware][${strategyKey}] 獲取配置: ${normalized}`
    );
  } else {
    console.warn(
      `[SymbolMiddleware][${strategyKey}] 配置不存在: ${normalized}`
    );
  }

  return config;
}

/**
 * 策略執行前的交易對驗證和標準化
 * ★ 這是所有策略執行的統一入口點
 * ★ 核心修復：新增 testnet 參數，確保模擬盤環境正確驗證
 * 
 * @param symbol - 交易對名稱（任意格式）
 * @param strategyKey - 策略標識
 * @param instType - 交易對類型
 * @param testnet - 是否模擬盤環境（來自 apiKey.isTestnet）
 */
export async function prepareSymbolForExecution(
  symbol: string,
  strategyKey: string,
  instType: 'SWAP' | 'SPOT' | 'FUTURES' = 'SWAP',
  testnet: boolean = false,
): Promise<{
  normalized: string;
  valid: boolean;
  config: any;
  error?: string;
}> {
  try {
    const envLabel = testnet ? '模擬盤' : '實盤';

    // 步驟 1: 標準化
    const normalized = await normalizeSymbolForStrategy(symbol, strategyKey, instType);

    // 步驟 2: 驗證（★ 使用對應環境驗證）
    const valid = await validateSymbolForStrategy(normalized, strategyKey, instType, testnet);

    if (!valid) {
      const errorMsg = testnet
        ? `交易對 "${normalized}" 在 OKX 模擬盤不可用。OKX 模擬盤僅支持約 170 個交易對，請切換到實盤 API Key 或選擇模擬盤支持的交易對。`
        : `交易對 "${normalized}" 在 OKX 實盤不存在或不可交易`;
      return {
        normalized,
        valid: false,
        config: null,
        error: errorMsg,
      };
    }

    // 步驟 3: 獲取配置（使用對應環境）
    const config = await getSymbolConfigForStrategy(normalized, strategyKey, instType, testnet);

    console.log(
      `[SymbolMiddleware][${strategyKey}] ✓ 交易對${envLabel}準備完成: ${normalized}`
    );

    return {
      normalized,
      valid: true,
      config,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `[SymbolMiddleware][${strategyKey}] ✗ 交易對準備失敗: ${errorMsg}`
    );

    return {
      normalized: '',
      valid: false,
      config: null,
      error: errorMsg,
    };
  }
}

/**
 * 批量準備交易對（用於回測或多策略場景）
 */
export async function prepareSymbolsForExecution(
  symbols: string[],
  strategyKey: string,
  instType: 'SWAP' | 'SPOT' | 'FUTURES' = 'SWAP',
  testnet: boolean = false,
): Promise<{
  valid: Array<{ symbol: string; config: any }>;
  invalid: Array<{ symbol: string; error: string }>;
}> {
  const valid: Array<{ symbol: string; config: any }> = [];
  const invalid: Array<{ symbol: string; error: string }> = [];

  for (const symbol of symbols) {
    const result = await prepareSymbolForExecution(symbol, strategyKey, instType, testnet);

    if (result.valid && result.config) {
      valid.push({
        symbol: result.normalized,
        config: result.config,
      });
    } else {
      invalid.push({
        symbol,
        error: result.error || '未知錯誤',
      });
    }
  }

  console.log(
    `[SymbolMiddleware][${strategyKey}] 批量準備完成: ${valid.length} 個有效, ${invalid.length} 個無效`
  );

  return { valid, invalid };
}

/**
 * 獲取策略支持的所有交易對
 * ★ 核心修復：新增 testnet 參數
 */
export async function getAvailableSymbolsForStrategy(
  strategyKey: string,
  instType: 'SWAP' | 'SPOT' | 'FUTURES' = 'SWAP',
  testnet: boolean = false,
): Promise<string[]> {
  const envLabel = testnet ? '模擬盤' : '實盤';
  const symbols = await TradingPairManager.getAvailablePairs(instType, testnet);
  console.log(
    `[SymbolMiddleware][${strategyKey}] 獲取 ${symbols.length} 個${envLabel}可用交易對`
  );
  return symbols;
}

/**
 * 搜索交易對
 */
export async function searchSymbolsForStrategy(
  keyword: string,
  strategyKey: string,
  instType: 'SWAP' | 'SPOT' | 'FUTURES' = 'SWAP',
  testnet: boolean = false,
) {
  const results = await TradingPairManager.search(keyword, instType, testnet);
  console.log(
    `[SymbolMiddleware][${strategyKey}] 搜索 "${keyword}": 找到 ${results.length} 個結果`
  );
  return results;
}

/**
 * 清除交易對緩存（用於強制刷新）
 */
export function clearSymbolCache(instType?: 'SWAP' | 'SPOT' | 'FUTURES'): void {
  TradingPairManager.clearCache(instType);
  console.log('[SymbolMiddleware] 已清除交易對緩存');
}

/**
 * 初始化交易對系統
 * 應在應用啟動時調用
 */
export async function initializeSymbolSystem(): Promise<void> {
  console.log('[SymbolMiddleware] 初始化交易對系統...');
  await TradingPairManager.initialize();
  console.log('[SymbolMiddleware] ✓ 交易對系統初始化完成');
}

/**
 * 獲取交易對系統統計信息
 */
export async function getSymbolSystemStats() {
  const stats = await TradingPairManager.getStats();
  console.log('[SymbolMiddleware] 交易對系統統計:', stats);
  return stats;
}
