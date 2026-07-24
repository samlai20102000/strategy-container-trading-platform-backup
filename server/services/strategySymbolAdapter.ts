/**
 * 策略交易對適配層
 * 
 * 為所有策略提供統一的交易對轉換和驗證接口
 * 確保無論使用什麼策略、什麼交易對、什麼格式都能完全一致地工作
 * 
 * 使用方式：
 * import { StrategySymbolAdapter } from './strategySymbolAdapter';
 * 
 * // 在策略中使用
 * const adapter = new StrategySymbolAdapter('V5.0');
 * const normalized = adapter.normalize('ETHUSDT');  // ETH-USDT-SWAP
 * const valid = await adapter.validate('ETH-USDT-SWAP');
 * const config = await adapter.getConfig('ETH-USDT-SWAP');
 */

import { TradingPairManager, TradingPairConfig } from './tradingPairManager';

export interface StrategySymbolContext {
  strategyKey: string;
  strategyName: string;
  instType: 'SWAP' | 'SPOT' | 'FUTURES';
}

/**
 * 策略交易對適配器
 * 為每個策略提供獨立的交易對管理上下文
 */
export class StrategySymbolAdapter {
  private strategyKey: string;
  private strategyName: string;
  private instType: 'SWAP' | 'SPOT' | 'FUTURES';
  private manager: typeof TradingPairManager;

  constructor(strategyKey: string, strategyName?: string, instType: 'SWAP' | 'SPOT' | 'FUTURES' = 'SWAP') {
    this.strategyKey = strategyKey;
    this.strategyName = strategyName || strategyKey;
    this.instType = instType;
    this.manager = TradingPairManager;
  }

  /**
   * 標準化交易對名稱
   */
  normalize(symbol: string): string {
    const normalized = this.manager.normalize(symbol, this.instType);
    console.log(`[StrategySymbolAdapter][${this.strategyName}] 標準化: ${symbol} → ${normalized}`);
    return normalized;
  }

  /**
   * 驗證交易對
   */
  async validate(symbol: string): Promise<boolean> {
    const normalized = this.normalize(symbol);
    const valid = await this.manager.validate(normalized, this.instType);

    if (valid) {
      console.log(`[StrategySymbolAdapter][${this.strategyName}] ✓ 交易對驗證成功: ${normalized}`);
    } else {
      console.warn(`[StrategySymbolAdapter][${this.strategyName}] ✗ 交易對驗證失敗: ${normalized}`);
    }

    return valid;
  }

  /**
   * 獲取交易對配置
   */
  async getConfig(symbol: string): Promise<TradingPairConfig | null> {
    const normalized = this.normalize(symbol);
    const config = await this.manager.getConfig(normalized, this.instType);

    if (config) {
      console.log(`[StrategySymbolAdapter][${this.strategyName}] 獲取配置: ${normalized}`);
    } else {
      console.warn(`[StrategySymbolAdapter][${this.strategyName}] 配置不存在: ${normalized}`);
    }

    return config;
  }

  /**
   * 批量驗證交易對
   */
  async validateMultiple(symbols: string[]): Promise<{
    valid: string[];
    invalid: string[];
  }> {
    const valid: string[] = [];
    const invalid: string[] = [];

    for (const symbol of symbols) {
      const isValid = await this.validate(symbol);
      if (isValid) {
        valid.push(this.normalize(symbol));
      } else {
        invalid.push(symbol);
      }
    }

    console.log(
      `[StrategySymbolAdapter][${this.strategyName}] 批量驗證: ${valid.length} 個有效, ${invalid.length} 個無效`
    );

    return { valid, invalid };
  }

  /**
   * 獲取所有可用的交易對
   */
  async getAvailablePairs(): Promise<string[]> {
    const pairs = await this.manager.getAvailablePairs(this.instType);
    console.log(`[StrategySymbolAdapter][${this.strategyName}] 獲取 ${pairs.length} 個可用交易對`);
    return pairs;
  }

  /**
   * 搜索交易對
   */
  async search(keyword: string): Promise<TradingPairConfig[]> {
    const results = await this.manager.search(keyword, this.instType);
    console.log(`[StrategySymbolAdapter][${this.strategyName}] 搜索 "${keyword}": 找到 ${results.length} 個結果`);
    return results;
  }

  /**
   * 獲取交易對類型
   */
  getInstType(): 'SWAP' | 'SPOT' | 'FUTURES' {
    return this.instType;
  }

  /**
   * 設置交易對類型
   */
  setInstType(instType: 'SWAP' | 'SPOT' | 'FUTURES'): void {
    this.instType = instType;
    console.log(`[StrategySymbolAdapter][${this.strategyName}] 設置交易對類型: ${instType}`);
  }

  /**
   * 獲取策略信息
   */
  getContext(): StrategySymbolContext {
    return {
      strategyKey: this.strategyKey,
      strategyName: this.strategyName,
      instType: this.instType,
    };
  }
}

/**
 * 為不同策略創建適配器的工廠函數
 */
export const createStrategySymbolAdapter = (
  strategyKey: string,
  strategyName?: string,
  instType?: 'SWAP' | 'SPOT' | 'FUTURES'
): StrategySymbolAdapter => {
  return new StrategySymbolAdapter(strategyKey, strategyName, instType);
};

/**
 * 預定義的策略適配器
 */
export const StrategyAdapters = {
  V20: () => createStrategySymbolAdapter('20415_KAMA_MARTIN_V20', 'V2.0 KAMA+3K 馬丁策略'),
  V35: () => createStrategySymbolAdapter('20415_KAMA_MARTIN_V35', 'V4.0 KAMA+3K 動態馬丁策略'),
  V50: () => createStrategySymbolAdapter('20415_KAMA_MARTIN_V50', 'V5.0 KAMA+3K 極致優化馬丁策略'),
  V61: () => createStrategySymbolAdapter('20415_KAMA_MARTIN_V61', 'V6.1 KAMA+3K 超級馬丁策略'),
};
