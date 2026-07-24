/**
 * 交易對管理系統 - 一勞永逸的完整解決方案
 * 
 * 功能：
 * 1. 統一管理所有交易對（現貨、合約、期貨）
 * 2. 支持所有格式的交易對轉換
 * 3. 為所有策略提供統一的交易對接口
 * 4. 自動同步 OKX 最新交易對列表（區分實盤/模擬盤）
 * 5. 提供交易對驗證和轉換服務
 * 
 * ★ 核心修復：所有驗證/查詢方法均支持 testnet 參數，
 *   確保模擬盤環境只能使用模擬盤支持的交易對，
 *   實盤環境使用實盤支持的交易對。
 * 
 * 使用方式：
 * import { TradingPairManager } from './tradingPairManager';
 * 
 * const manager = TradingPairManager.getInstance();
 * const normalized = manager.normalize('ETHUSDT');  // ETH-USDT-SWAP
 * const valid = await manager.validate('ETH-USDT-SWAP', 'SWAP', false);  // 實盤驗證
 * const valid = await manager.validate('ETH-USDT-SWAP', 'SWAP', true);   // 模擬盤驗證
 * const list = await manager.getAvailablePairs('SWAP', false);   // 實盤交易對
 * const list = await manager.getAvailablePairs('SWAP', true);    // 模擬盤交易對
 */

export interface TradingPairConfig {
  instId: string;           // OKX 標準格式 (e.g., "ETH-USDT-SWAP")
  baseCcy: string;          // 基礎幣種
  quoteCcy: string;         // 計價幣種
  instType: 'SPOT' | 'SWAP' | 'FUTURES';
  state: 'live' | 'suspend' | 'preopen';
  ctVal?: number;           // 合約面值
  minSz?: number;           // 最小下單量
  lotSz?: number;           // 下單量精度
  minNotional?: number;     // 最小名義價值
}

export interface TradingPairCacheEntry {
  pairs: Map<string, TradingPairConfig>;
  fetchedAt: number;
  instType: 'SPOT' | 'SWAP' | 'FUTURES';
}

/**
 * 交易對管理器 - 單例模式
 * 提供統一的交易對管理接口
 */
class TradingPairManagerClass {
  private static instance: TradingPairManagerClass;
  private cache = new Map<string, TradingPairCacheEntry>();
  private readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 小時
  private readonly OKX_API_BASE = 'https://www.okx.com/api/v5/public/instruments';

  private constructor() {}

  /**
   * 獲取單例實例
   */
  static getInstance(): TradingPairManagerClass {
    if (!TradingPairManagerClass.instance) {
      TradingPairManagerClass.instance = new TradingPairManagerClass();
    }
    return TradingPairManagerClass.instance;
  }

  /**
   * 生成緩存 key（區分實盤/模擬盤）
   */
  private getCacheKey(instType: string, testnet: boolean): string {
    return `okx:${instType}:${testnet ? 'demo' : 'live'}`;
  }

  /**
   * 從 OKX API 獲取交易對列表
   * ★ 核心修復：新增 testnet 參數，模擬盤查詢帶 x-simulated-trading header
   * 
   * @param instType - 交易對類型
   * @param testnet - 是否查詢模擬盤（默認 false = 實盤）
   */
  async fetchFromOkx(
    instType: 'SPOT' | 'SWAP' | 'FUTURES' = 'SWAP',
    testnet: boolean = false,
  ): Promise<Map<string, TradingPairConfig>> {
    const cacheKey = this.getCacheKey(instType, testnet);
    const cached = this.cache.get(cacheKey);

    // 檢查緩存
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.pairs;
    }

    const envLabel = testnet ? '模擬盤' : '實盤';
    console.log(`[TradingPairManager] 從 OKX ${envLabel} 獲取 ${instType} 交易對...`);

    const pairs = new Map<string, TradingPairConfig>();

    try {
      const url = `${this.OKX_API_BASE}?instType=${instType}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      
      // ★ 模擬盤需要帶 x-simulated-trading header
      if (testnet) {
        headers['x-simulated-trading'] = '1';
      }

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.code !== '0') {
        throw new Error(`OKX API error: ${data.code} ${data.msg}`);
      }

      // 解析交易對數據
      for (const item of data.data || []) {
        // 只保留 live 狀態的交易對
        if (item.state !== 'live') continue;

        const config: TradingPairConfig = {
          instId: item.instId,
          baseCcy: item.baseCcy || item.instId.split('-')[0],
          quoteCcy: item.quoteCcy || item.instId.split('-')[1] || 'USDT',
          instType: item.instType,
          state: item.state,
        };

        // 添加合約特定信息
        if (instType === 'SWAP' || instType === 'FUTURES') {
          config.ctVal = item.ctVal ? parseFloat(item.ctVal) : undefined;
          config.minSz = item.minSz ? parseFloat(item.minSz) : undefined;
          config.lotSz = item.lotSz ? parseFloat(item.lotSz) : undefined;
        } else {
          config.minSz = item.minSz ? parseFloat(item.minSz) : undefined;
          config.lotSz = item.lotSz ? parseFloat(item.lotSz) : undefined;
          config.minNotional = item.minNotional ? parseFloat(item.minNotional) : undefined;
        }

        pairs.set(item.instId, config);
      }

      // 保存到緩存
      this.cache.set(cacheKey, { pairs, fetchedAt: Date.now(), instType });

      console.log(`[TradingPairManager] ✓ 成功獲取 ${pairs.size} 個 ${envLabel} ${instType} 交易對`);
      return pairs;
    } catch (error) {
      console.error(`[TradingPairManager] ✗ 獲取 OKX ${envLabel} ${instType} 交易對失敗:`, error);

      // 回退到緩存
      if (cached) {
        console.log(`[TradingPairManager] 使用過期緩存 (${cached.pairs.size} 個交易對)`);
        return cached.pairs;
      }

      return new Map();
    }
  }

  /**
   * 標準化交易對名稱
   * 支持所有格式的輸入，統一輸出為 OKX 標準格式
   */
  normalize(symbol: string, instType: 'SPOT' | 'SWAP' | 'FUTURES' = 'SWAP'): string {
    if (!symbol) return '';

    // 移除空格並轉大寫
    let clean = symbol.trim().toUpperCase();

    // 如果已經是標準 OKX 格式（如 BTC-USDT-SWAP），直接返回
    if (/^[A-Z0-9]+-[A-Z]+-SWAP$/.test(clean) && instType === 'SWAP') return clean;
    if (/^[A-Z0-9]+-[A-Z]+$/.test(clean) && instType === 'SPOT') return clean;

    // 移除所有分隔符
    clean = clean.replace(/[-_/\.]/g, '');

    // 移除已有的交易類型後綴
    clean = clean.replace(/SWAP$/, '').replace(/SPOT$/, '').replace(/FUTURES$/, '').replace(/PERP$/, '');

    // 檢測計價幣種（優先級：USDT > USDC > USD > 其他）
    let quote = 'USDT';
    if (clean.endsWith('USDT')) {
      quote = 'USDT';
      clean = clean.slice(0, -4);
    } else if (clean.endsWith('USDC')) {
      quote = 'USDC';
      clean = clean.slice(0, -4);
    } else if (clean.endsWith('BUSD')) {
      quote = 'BUSD';
      clean = clean.slice(0, -4);
    } else if (clean.endsWith('USD')) {
      quote = 'USD';
      clean = clean.slice(0, -3);
    } else if (clean.endsWith('EUR')) {
      quote = 'EUR';
      clean = clean.slice(0, -3);
    } else if (clean.endsWith('BTC')) {
      quote = 'BTC';
      clean = clean.slice(0, -3);
    } else if (clean.endsWith('ETH')) {
      quote = 'ETH';
      clean = clean.slice(0, -3);
    }

    const base = clean;

    // 組裝 OKX 標準格式
    if (instType === 'SPOT') {
      return `${base}-${quote}`;
    } else if (instType === 'FUTURES') {
      return `${base}-${quote}-FUTURES`;
    } else {
      return `${base}-${quote}-SWAP`;
    }
  }

  /**
   * 驗證交易對是否在 OKX 上存在
   * ★ 核心修復：新增 testnet 參數
   * 
   * @param symbol - 交易對名稱
   * @param instType - 交易對類型
   * @param testnet - 是否驗證模擬盤（默認 false = 實盤）
   */
  async validate(
    symbol: string,
    instType: 'SPOT' | 'SWAP' | 'FUTURES' = 'SWAP',
    testnet: boolean = false,
  ): Promise<boolean> {
    const normalized = this.normalize(symbol, instType);
    const pairs = await this.fetchFromOkx(instType, testnet);
    return pairs.has(normalized);
  }

  /**
   * 獲取交易對配置信息
   */
  async getConfig(
    symbol: string,
    instType: 'SPOT' | 'SWAP' | 'FUTURES' = 'SWAP',
    testnet: boolean = false,
  ): Promise<TradingPairConfig | null> {
    const normalized = this.normalize(symbol, instType);
    const pairs = await this.fetchFromOkx(instType, testnet);
    return pairs.get(normalized) || null;
  }

  /**
   * 獲取所有可用的交易對列表
   * ★ 核心修復：新增 testnet 參數
   */
  async getAvailablePairs(
    instType: 'SPOT' | 'SWAP' | 'FUTURES' = 'SWAP',
    testnet: boolean = false,
  ): Promise<string[]> {
    const pairs = await this.fetchFromOkx(instType, testnet);
    return Array.from(pairs.keys()).sort();
  }

  /**
   * 獲取所有可用的交易對配置
   */
  async getAvailableConfigs(
    instType: 'SPOT' | 'SWAP' | 'FUTURES' = 'SWAP',
    testnet: boolean = false,
  ): Promise<TradingPairConfig[]> {
    const pairs = await this.fetchFromOkx(instType, testnet);
    return Array.from(pairs.values()).sort((a, b) => a.instId.localeCompare(b.instId));
  }

  /**
   * 批量驗證交易對
   */
  async validateMultiple(
    symbols: string[],
    instType: 'SPOT' | 'SWAP' | 'FUTURES' = 'SWAP',
    testnet: boolean = false,
  ): Promise<{
    valid: string[];
    invalid: string[];
  }> {
    const valid: string[] = [];
    const invalid: string[] = [];

    for (const symbol of symbols) {
      const isValid = await this.validate(symbol, instType, testnet);
      if (isValid) {
        valid.push(this.normalize(symbol, instType));
      } else {
        invalid.push(symbol);
      }
    }

    return { valid, invalid };
  }

  /**
   * 搜索交易對
   */
  async search(
    keyword: string,
    instType: 'SPOT' | 'SWAP' | 'FUTURES' = 'SWAP',
    testnet: boolean = false,
  ): Promise<TradingPairConfig[]> {
    const pairs = await this.fetchFromOkx(instType, testnet);
    const searchKey = keyword.toUpperCase();

    return Array.from(pairs.values()).filter(
      (pair) =>
        pair.instId.includes(searchKey) ||
        pair.baseCcy.includes(searchKey) ||
        pair.quoteCcy.includes(searchKey)
    );
  }

  /**
   * 清除緩存
   */
  clearCache(instType?: 'SPOT' | 'SWAP' | 'FUTURES'): void {
    if (instType) {
      this.cache.delete(this.getCacheKey(instType, false));
      this.cache.delete(this.getCacheKey(instType, true));
      console.log(`[TradingPairManager] 已清除 ${instType} 交易對緩存（實盤+模擬盤）`);
    } else {
      this.cache.clear();
      console.log(`[TradingPairManager] 已清除所有交易對緩存`);
    }
  }

  /**
   * 初始化系統
   * 預加載所有交易對類型（實盤）
   */
  async initialize(): Promise<void> {
    console.log('[TradingPairManager] 初始化交易對管理系統...');

    try {
      // 預加載實盤 SWAP 交易對
      const swapPairs = await this.fetchFromOkx('SWAP', false);
      console.log(`[TradingPairManager] ✓ 預加載 ${swapPairs.size} 個實盤 SWAP 交易對`);

      // 預加載模擬盤 SWAP 交易對
      const demoSwapPairs = await this.fetchFromOkx('SWAP', true);
      console.log(`[TradingPairManager] ✓ 預加載 ${demoSwapPairs.size} 個模擬盤 SWAP 交易對`);

      console.log('[TradingPairManager] ✓ 初始化完成');
    } catch (error) {
      console.error('[TradingPairManager] ✗ 初始化失敗:', error);
    }
  }

  /**
   * 獲取統計信息
   */
  async getStats(): Promise<{
    swap: number;
    spot: number;
    futures: number;
    total: number;
    swapDemo: number;
  }> {
    const swapPairs = await this.fetchFromOkx('SWAP', false);
    const spotPairs = await this.fetchFromOkx('SPOT', false);
    const futuresPairs = await this.fetchFromOkx('FUTURES', false);
    const swapDemoPairs = await this.fetchFromOkx('SWAP', true);

    return {
      swap: swapPairs.size,
      spot: spotPairs.size,
      futures: futuresPairs.size,
      total: swapPairs.size + spotPairs.size + futuresPairs.size,
      swapDemo: swapDemoPairs.size,
    };
  }
}

// 導出單例
export const TradingPairManager = TradingPairManagerClass.getInstance();

// 為了向後兼容，也導出原始的函數接口
export async function normalizeSymbol(symbol: string, instType: 'SPOT' | 'SWAP' | 'FUTURES' = 'SWAP'): Promise<string> {
  return TradingPairManager.normalize(symbol, instType);
}

export async function validateSymbol(
  symbol: string,
  instType: 'SPOT' | 'SWAP' | 'FUTURES' = 'SWAP',
  testnet: boolean = false,
): Promise<boolean> {
  return TradingPairManager.validate(symbol, instType, testnet);
}

export async function getSymbolList(
  instType: 'SPOT' | 'SWAP' | 'FUTURES' = 'SWAP',
  testnet: boolean = false,
): Promise<string[]> {
  return TradingPairManager.getAvailablePairs(instType, testnet);
}
