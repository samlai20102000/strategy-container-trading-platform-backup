/**
 * KAMA 3K V6.1 高頻掃射極致版 — 策略引擎
 * 
 * 核心機制：
 * 1. 區域觸發入場（取代 3K 形態）
 * 2. 動態緩衝區（依 ADX 市場制度自動調整）
 * 3. 方向模式（Trend/Hybrid/Both）
 * 4. 突破確認模式（Inside/Breakout）
 * 5. 最小 ATR 過濾
 * 6. 連續虧損動態縮倉 + 每日風控
 */

import { BaseStrategyV35 } from '../base';
import { getLatestADX, getLatestATR, determineMarketRegime, KLineInput } from '../../services/indicators';
import { getRegime, calculateATRMA } from '../../services/v61Utils'; // 從 v61Utils 導入共用邏輯

// ===== V6.1 Config 類型 =====
export interface V61Config {
  // 基礎設定
  symbol: string;
  timeframe: number;
  initial_capital: number;
  // KAMA 快線
  kama_fast_length: number;
  kama_fast_fastest: number;
  kama_fast_slowest: number;
  // KAMA 慢線
  kama_slow_length: number;
  kama_slow_fastest: number;
  kama_slow_slowest: number;
  // 區域觸發
  buffer_atr_multiplier_trend: number;
  buffer_atr_multiplier_weak: number;
  buffer_atr_multiplier_ranging: number;
  entry_zone_mode: 'inside' | 'breakout';
  direction_mode: 'trend' | 'hybrid' | 'both';
  min_atr_ratio: number;
  // 連續開倉
  enable_continuous_entry: boolean | number | string;
  cooldown_minutes: number;
  enable_bar_lock: boolean;
  // 市場制度 (F1)
  adx_period: number;
  adx_trend_threshold: number;
  adx_strong_threshold: number;
  atr_ratio_threshold: number;
  // 動態止盈 (F3)
  tp_atr_multiplier: number;
  callback_atr_multiplier: number;
  tp_min_pct: number;
  callback_min_pct: number;
  // 波動率倉位 (F5)
  target_volatility: number;
  base_lot_size: number;
  lot_min_multiplier: number;
  lot_max_multiplier: number;
  // 連續虧損縮倉
  enable_loss_shrink: boolean | number | string;
  loss_shrink_level1: number;
  loss_shrink_level1_pct: number;
  loss_shrink_level2: number;
  loss_shrink_level2_pct: number;
  // 每日限制
  max_daily_trades: number;
  max_daily_loss: number;
  // 馬丁格爾（由市場制度自動覆蓋）
  martin_step_pct?: number;
  martin_multiplier?: number;
  max_layers?: number;
  // 極限止損（統一值，不再按 regime 區分）
  hard_stop_pct: number;
  // 最後層偏離 %（馬丁滿層後繼續偏離此值即觸發極限止損）
  max_deviation_pct?: number;
}

// ===== 市場制度馬丁參數對應表 =====
export interface RegimeParams {
  step: number[];       // 各層間距 %
  mult: number[];       // 各層乘數
  max_layers: number;
  hard_stop: number;    // 硬止損 %
}

export const V61_REGIME_PARAMS: Record<string, RegimeParams> = {
  strong_trend: {
    step: [2.0, 2.0, 2.0, 3.0, 3.0, 3.0, 4.0, 4.0, 4.0, 5.0, 5.0, 5.0, 5.0],
    mult: [1.5, 1.5, 1.5, 1.5, 1.2, 1.2, 1.2, 1.2, 1.2, 1.0, 1.0, 1.0, 1.0],
    max_layers: 13,
    hard_stop: 8.0,
  },
  weak_trend: {
    step: [1.5, 1.5, 1.5, 2.5, 2.5, 2.5, 3.0, 3.0, 3.0, 4.0, 4.0],
    mult: [1.6, 1.6, 1.6, 1.6, 1.3, 1.3, 1.3, 1.3, 1.3, 1.0, 1.0],
    max_layers: 11,
    hard_stop: 6.5,
  },
  ranging: {
    step: [1.0, 1.0, 1.0, 2.0, 2.0, 2.0, 3.0, 3.0, 3.0],
    mult: [1.8, 1.8, 1.8, 1.8, 1.2, 1.2, 1.2, 1.2, 1.0],
    max_layers: 9,
    hard_stop: 5.0,
  },
};

// ===== V6.1 預設配置 =====
export const V61_DEFAULT_CONFIG: V61Config = {
  symbol: 'BTCUSDT',
  timeframe: 15,
  initial_capital: 10000,
  kama_fast_length: 30,
  kama_fast_fastest: 8,
  kama_fast_slowest: 2,
  kama_slow_length: 55,
  kama_slow_fastest: 10,
  kama_slow_slowest: 8,
  buffer_atr_multiplier_trend: 0.25,
  buffer_atr_multiplier_weak: 0.30,
  buffer_atr_multiplier_ranging: 0.50,
  entry_zone_mode: 'breakout',
  direction_mode: 'hybrid',
  min_atr_ratio: 0.7,
  enable_continuous_entry: "1",
  cooldown_minutes: 0,
  enable_bar_lock: false,
  adx_period: 14,
  adx_trend_threshold: 25,
  adx_strong_threshold: 30,
  atr_ratio_threshold: 1.2,
  tp_atr_multiplier: 1.5,
  callback_atr_multiplier: 0.3,
  tp_min_pct: 0.5,
  callback_min_pct: 0.15,
  target_volatility: 4.0,
  base_lot_size: 15,
  lot_min_multiplier: 0.5,
  lot_max_multiplier: 2.0,
  enable_loss_shrink: "1",
  loss_shrink_level1: 3,
  loss_shrink_level1_pct: 70,
  loss_shrink_level2: 5,
  loss_shrink_level2_pct: 50,
  max_daily_trades: 20,
  max_daily_loss: 3.0,
  // 極限止損 %（預設 3%，用戶可自行調節）
  hard_stop_pct: 3.0,
  // 最後層偏離 %（預設 3%）
  max_deviation_pct: 3.0,
};

/**
 * V6.1 回測中心專用 defaultConfig（含大寫馬丁 key，與 V4.0 架構一致）
 * Backtest.tsx 深度定制面板根據 configJson 中已存在的 key 來渲染 UI，
 * 因此必須包含 Martin_Layers / Martin_Step_Pct / Martin_Multiplier / Max_Layers
 */
export const V61_BACKTEST_DEFAULT_CONFIG: Record<string, any> = {
  // ===== 趨勢與形態參數 =====
  symbol: 'BTCUSDT',
  timeframe: 15,
  initial_capital: 10000,
  kama_fast_length: 30,
  kama_fast_fastest: 8,
  kama_fast_slowest: 2,
  kama_slow_length: 55,
  kama_slow_fastest: 10,
  kama_slow_slowest: 8,
  buffer_atr_multiplier_trend: 0.25,
  buffer_atr_multiplier_weak: 0.30,
  buffer_atr_multiplier_ranging: 0.50,
  entry_zone_mode: 'breakout',
  direction_mode: 'hybrid',
  min_atr_ratio: 0.7,
  enable_continuous_entry: "1",
  cooldown_minutes: 0,
  enable_bar_lock: false,
  adx_period: 14,
  adx_trend_threshold: 25,
  adx_strong_threshold: 30,
  atr_ratio_threshold: 1.2,
  tp_atr_multiplier: 1.5,
  callback_atr_multiplier: 0.3,
  tp_min_pct: 0.5,
  callback_min_pct: 0.15,
  target_volatility: 4.0,
  base_lot_size: 15,
  lot_min_multiplier: 0.5,
  lot_max_multiplier: 2.0,
  // ===== 連續虧損縮倉 + 風控 =====
  enable_loss_shrink: "1",
  loss_shrink_level1: 3,
  loss_shrink_level1_pct: 70,
  loss_shrink_level2: 5,
  loss_shrink_level2_pct: 50,
  max_daily_trades: 100,
  max_daily_loss: 6.0,
  // ===== 極限止損 =====
  hard_stop_pct: 3.0,
  // ===== 最後層偏離 =====
  max_deviation_pct: 3.0,
  // ===== 馬丁加倉與分層參數（大寫 key，與 V4.0 架構一致）=====
  Martin_Multiplier: 1.5,
  Martin_Step_Pct: 2.0,
  Max_Layers: 11,
  Martin_Layers: JSON.stringify([
    { start: 1, end: 4, multiplier: 1.5, stepPct: null },
    { start: 5, end: 9, multiplier: 1.1, stepPct: null },
    { start: 10, end: 11, multiplier: 1.0, stepPct: null },
  ]),
};

// ===== 信號動作類型 =====
export interface V61Signal {
  action: 'buy' | 'sell' | 'close' | 'add' | 'wait';
  reason: string;
  confidence: number;
  lotUsdt?: number;
  regime?: string;
  dailyTrades?: number;
}

// ===== V6.1 策略引擎 =====
export class StrategyKama3kV61 extends BaseStrategyV35 {
  readonly key = 'KAMA_3K_HF_V61';
  readonly name = 'KAMA 3K V6.1 高頻掃射';
  readonly version = '6.1';
  readonly defaultConfig: Record<string, any> = V61_BACKTEST_DEFAULT_CONFIG;
  readonly isBuiltIn = true;

  private cfg: V61Config;
  private consecutiveLoss: number = 0;
  private dailyTrades: number = 0;
  private dailyLoss: number = 0;
  private currentDay: string | null = null;
  private peakProfit: number = 0;
  private lastEntryBar: number = -1;

  constructor(config?: Partial<V61Config>) {
    super();
    this.cfg = { ...V61_DEFAULT_CONFIG, ...(config || {}) };
  }

  // ===== 實現 BaseStrategy 抽象方法 =====
  generateActions(
    signal: any,
    instance: any,
    marketData: any,
    martinState: any,
  ): any {
    return { action: 'HOLD', lotSize: 0, reason: 'V6.1 uses generateSignalV61' };
  }

  // ===== 實現 BaseStrategyV35 抽象方法 =====
  async validateSignal(
    signal: any,
    marketData: any,
    instance: any,
  ): Promise<{ valid: boolean; reason?: string }> {
    // V6.1 使用自己的區域觸發驗證，這裡默認通過
    return { valid: true };
  }

  async generateActionsV35(
    signal: any,
    instance: any,
    marketData: any,
    state: any,
  ): Promise<any> {
    return { action: 'HOLD', lotSize: 0, reason: 'V6.1 uses generateSignalV61' };
  }



  /**
   * 取得動態緩衝區倍數
   */
  getBufferMultiplier(regime: string): number {
    switch (regime) {
      case 'strong_trend': return this.cfg.buffer_atr_multiplier_trend;
      case 'weak_trend': return this.cfg.buffer_atr_multiplier_weak;
      case 'ranging': return this.cfg.buffer_atr_multiplier_ranging;
      default: return this.cfg.buffer_atr_multiplier_weak;
    }
  }

  /**
   * 區域觸發檢查
   */
  checkZoneEntry(
    currentPrice: number,
    kamaSlow: number,
    atrVal: number,
    regime: string
  ): { triggered: boolean; direction: number } {
    const bufferMult = this.getBufferMultiplier(regime);
    const buffer = bufferMult * atrVal;
    const zoneUpper = kamaSlow + buffer;
    const zoneLower = kamaSlow - buffer;

    if (this.cfg.entry_zone_mode === 'breakout') {
      // 突破模式：價格穿出 Zone 邊界
      if (currentPrice > zoneUpper) {
        return { triggered: true, direction: 1 }; // 做多
      } else if (currentPrice < zoneLower) {
        return { triggered: true, direction: -1 }; // 做空
      }
    } else {
      // 內部模式：價格在 Zone 內
      if (currentPrice >= zoneLower && currentPrice <= zoneUpper) {
        const mid = (zoneLower + zoneUpper) / 2;
        return { triggered: true, direction: currentPrice >= mid ? 1 : -1 };
      }
    }
    return { triggered: false, direction: 0 };
  }

  /**
   * 方向模式過濾
   */
  checkDirection(direction: number, kamaFast: number, kamaSlow: number, regime: string): boolean {
    if (this.cfg.direction_mode === 'trend') {
      return direction === 1 ? kamaFast > kamaSlow : kamaFast < kamaSlow;
    } else if (this.cfg.direction_mode === 'hybrid') {
      // 震盪時雙向，趨勢時順勢
      if (regime === 'ranging') return true;
      return direction === 1 ? kamaFast > kamaSlow : kamaFast < kamaSlow;
    }
    // both 模式
    return true;
  }

  /**
   * 計算波動率倉位
   */
  getVolatilityLot(entryPrice: number, atrVal: number): number {
    const atrPct = (atrVal / entryPrice) * 100;
    let multiplier = this.cfg.target_volatility / atrPct;
    multiplier = Math.max(this.cfg.lot_min_multiplier, Math.min(this.cfg.lot_max_multiplier, multiplier));

    // 連續虧損縮倉
    if (Number(this.cfg.enable_loss_shrink) === 1 || this.cfg.enable_loss_shrink === true) {
      if (this.consecutiveLoss >= this.cfg.loss_shrink_level2) {
        multiplier *= (this.cfg.loss_shrink_level2_pct / 100);
      } else if (this.consecutiveLoss >= this.cfg.loss_shrink_level1) {
        multiplier *= (this.cfg.loss_shrink_level1_pct / 100);
      }
    }

    return this.cfg.base_lot_size * multiplier;
  }

  /**
   * 動態止盈計算
   */
  getDynamicTPCallback(entryPrice: number, atrVal: number): { tpPct: number; cbPct: number } {
    const tpPct = Math.max(this.cfg.tp_min_pct / 100, (atrVal / entryPrice) * this.cfg.tp_atr_multiplier);
    const cbPct = Math.max(this.cfg.callback_min_pct / 100, (atrVal / entryPrice) * this.cfg.callback_atr_multiplier);
    return { tpPct, cbPct };
  }

  /**
   * 每日風控重置
   */
  resetDailyIfNeeded(currentTime: Date): void {
    const today = currentTime.toISOString().slice(0, 10);
    if (this.currentDay !== today) {
      this.currentDay = today;
      this.dailyTrades = 0;
      this.dailyLoss = 0;
    }
  }

  /**
   * 檢查每日限制
   */
  checkDailyLimits(): { blocked: boolean; reason: string } {
    if (this.dailyTrades >= this.cfg.max_daily_trades) {
      return { blocked: true, reason: `每日交易次數已達上限 (${this.cfg.max_daily_trades})` };
    }
    if (this.dailyLoss <= -this.cfg.max_daily_loss) {
      return { blocked: true, reason: `每日虧損已達上限 (${this.cfg.max_daily_loss}%)` };
    }
    return { blocked: false, reason: '' };
  }

  /**
   * 主信號生成（V6.1 核心邏輯）
   */
  generateSignalV61(
    candles: KLineInput[],
    hasPosition: boolean,
    positionSide?: 'long' | 'short',
    positionLayers?: number,
    avgEntryPrice?: number,
    unrealizedPnlPct?: number,
  ): V61Signal {
    if (candles.length < Math.max(this.cfg.kama_slow_length, 50) + 14) {
      return { action: 'wait', reason: '數據不足', confidence: 0 };
    }

    const currentPrice = candles[candles.length - 1].close;
    const ts = candles[candles.length - 1].timestamp;
    const currentTime = new Date(ts ?? Date.now());
    
    // 每日風控重置
    this.resetDailyIfNeeded(currentTime);

    // 計算指標
    const regime = getRegime(candles, this.cfg);
    const regimeParams = V61_REGIME_PARAMS[regime] || V61_REGIME_PARAMS.ranging;
    const atrVal = getLatestATR(candles, 14) || 0;
    const atrma = calculateATRMA(candles, 50);

    // 計算 KAMA
    const closes = candles.map(c => c.close);
    const kamaFast = this.calculateKAMA(closes, this.cfg.kama_fast_length, this.cfg.kama_fast_fastest, this.cfg.kama_fast_slowest);
    const kamaSlow = this.calculateKAMA(closes, this.cfg.kama_slow_length, this.cfg.kama_slow_fastest, this.cfg.kama_slow_slowest);

    if (kamaFast === null || kamaSlow === null) {
      return { action: 'wait', reason: 'KAMA 計算中', confidence: 0 };
    }

    // ===== 有持倉：管理 =====
    if (hasPosition && avgEntryPrice && positionLayers !== undefined) {
      return this.handlePositionManagement(
        currentPrice, avgEntryPrice, atrVal, regime, regimeParams,
        positionSide!, positionLayers, unrealizedPnlPct || 0
      );
    }

    // ===== 無持倉：檢查入場 =====
    // 每日限制檢查
    const dailyCheck = this.checkDailyLimits();
    if (dailyCheck.blocked) {
      return { action: 'wait', reason: dailyCheck.reason, confidence: 0, regime, dailyTrades: this.dailyTrades };
    }

    // 連續開倉開關
    if (Number(this.cfg.enable_continuous_entry) === 0 || this.cfg.enable_continuous_entry === false) {
      return { action: 'wait', reason: '連續開倉已關閉', confidence: 0 };
    }

    // 最小 ATR 過濾
    if (atrVal < this.cfg.min_atr_ratio * atrma) {
      return { action: 'wait', reason: `ATR 過低 (${(atrVal/atrma).toFixed(2)} < ${this.cfg.min_atr_ratio})`, confidence: 0, regime };
    }

    // Bar-Lock 檢查
    if (this.cfg.enable_bar_lock && candles.length - 1 === this.lastEntryBar) {
      return { action: 'wait', reason: 'Bar-Lock 限制', confidence: 0 };
    }

    // 區域觸發檢查
    const zoneResult = this.checkZoneEntry(currentPrice, kamaSlow, atrVal, regime);
    if (!zoneResult.triggered) {
      return { action: 'wait', reason: '價格不在觸發區域', confidence: 0, regime };
    }

    // 方向模式過濾
    if (!this.checkDirection(zoneResult.direction, kamaFast, kamaSlow, regime)) {
      return { action: 'wait', reason: '方向模式過濾', confidence: 0, regime };
    }

    // 開倉
    const lotUsdt = this.getVolatilityLot(currentPrice, atrVal);
    this.dailyTrades++;
    this.lastEntryBar = candles.length - 1;

    const action = zoneResult.direction === 1 ? 'buy' : 'sell';
    return {
      action,
      reason: `V6.1 區域觸發 (${this.cfg.entry_zone_mode}模式, ${regime}, 波動率調整 ${(lotUsdt/this.cfg.base_lot_size*100).toFixed(0)}%)`,
      confidence: 1,
      lotUsdt,
      regime,
      dailyTrades: this.dailyTrades,
    };
  }

  /**
   * 持倉管理（止盈/止損/加倉）
   */
  private handlePositionManagement(
    currentPrice: number,
    avgEntryPrice: number,
    atrVal: number,
    regime: string,
    regimeParams: RegimeParams,
    positionSide: 'long' | 'short',
    layers: number,
    unrealizedPnlPct: number,
  ): V61Signal {
    // 計算盈虧百分比
    let profitPct: number;
    if (positionSide === 'long') {
      profitPct = (currentPrice - avgEntryPrice) / avgEntryPrice;
    } else {
      profitPct = (avgEntryPrice - currentPrice) / avgEntryPrice;
    }

    // 硬止損（使用用戶可配置的 hard_stop_pct，預設 3%）
    const hardStopVal = this.cfg.hard_stop_pct ?? 3.0;
    const hardStopPct = hardStopVal / 100;
    if (profitPct <= -hardStopPct) {
      this.consecutiveLoss++;
      this.dailyLoss += profitPct * 100;
      return {
        action: 'close',
        reason: `硬止損觸發 (${regime}, ${(profitPct*100).toFixed(2)}% <= -${hardStopVal}%)`,
        confidence: 1,
        regime,
      };
    }

    // 動態止盈（追蹤止盈）
    const { tpPct, cbPct } = this.getDynamicTPCallback(avgEntryPrice, atrVal);
    if (profitPct >= tpPct) {
      this.peakProfit = Math.max(this.peakProfit, profitPct);
      if (this.peakProfit - profitPct >= cbPct) {
        this.consecutiveLoss = 0; // 盈利重置
        this.peakProfit = 0;
        return {
          action: 'close',
          reason: `追蹤止盈 (峰值 ${(this.peakProfit*100).toFixed(2)}%, 回撤 ${(cbPct*100).toFixed(2)}%)`,
          confidence: 1,
          regime,
        };
      }
    }

    // 馬丁加倉
    if (layers < regimeParams.max_layers) {
      const stepIdx = Math.min(layers, regimeParams.step.length - 1);
      const stepPct = regimeParams.step[stepIdx] / 100;
      
      let distance: number;
      if (positionSide === 'long') {
        distance = (avgEntryPrice - currentPrice) / avgEntryPrice;
      } else {
        distance = (currentPrice - avgEntryPrice) / avgEntryPrice;
      }

      if (distance >= stepPct) {
        const multIdx = Math.min(layers, regimeParams.mult.length - 1);
        const mult = regimeParams.mult[multIdx];
        const newLotUsdt = this.cfg.base_lot_size * Math.pow(mult, layers);
        
        // 連續虧損縮倉也應用於加倉
        let adjustedLot = newLotUsdt;
        if (Number(this.cfg.enable_loss_shrink) === 1 || this.cfg.enable_loss_shrink === true) {
          if (this.consecutiveLoss >= this.cfg.loss_shrink_level2) {
            adjustedLot *= (this.cfg.loss_shrink_level2_pct / 100);
          } else if (this.consecutiveLoss >= this.cfg.loss_shrink_level1) {
            adjustedLot *= (this.cfg.loss_shrink_level1_pct / 100);
          }
        }

        return {
          action: 'add',
          reason: `馬丁加倉 L${layers+1} (${regime}, 間距 ${(distance*100).toFixed(2)}% >= ${regimeParams.step[stepIdx]}%)`,
          confidence: 1,
          lotUsdt: adjustedLot,
          regime,
        };
      }
    }

    return { action: 'wait', reason: '持倉中，無動作', confidence: 0, regime };
  }

  /**
   * 計算 KAMA 值
   */
  private calculateKAMA(closes: number[], length: number, fastest: number, slowest: number): number | null {
    if (closes.length < length + 1) return null;
    
    const fastSC = 2 / (fastest + 1);
    const slowSC = 2 / (slowest + 1);
    
    let kama = closes[length - 1]; // 初始值
    
    for (let i = length; i < closes.length; i++) {
      const direction = Math.abs(closes[i] - closes[i - length]);
      let volatility = 0;
      for (let j = i - length + 1; j <= i; j++) {
        volatility += Math.abs(closes[j] - closes[j - 1]);
      }
      const er = volatility === 0 ? 0 : direction / volatility;
      const sc = Math.pow(er * (fastSC - slowSC) + slowSC, 2);
      kama = kama + sc * (closes[i] - kama);
    }
    
    return kama;
  }

  /**
   * 重置連續虧損計數（外部調用）
   */
  resetConsecutiveLoss(): void {
    this.consecutiveLoss = 0;
  }

  /**
   * 設置連續虧損計數（從 DB 恢復）
   */
  setConsecutiveLoss(count: number): void {
    this.consecutiveLoss = count;
  }

  /**
   * 取得當前配置
   */
  getConfig(): V61Config {
    return { ...this.cfg };
  }
}
