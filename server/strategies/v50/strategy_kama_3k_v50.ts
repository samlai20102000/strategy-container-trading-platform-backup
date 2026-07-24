/**
 * KAMA 3K V5.0 極致優化版策略引擎
 * 
 * 在 V3.5 KAMA+3K+馬丁基礎上新增六大模組：
 * F1 - 市場制度切換（ADX 驅動動態馬丁參數）
 * F2 - 部分獲利（分批平倉）
 * F3 - ATR 動態止盈
 * F4 - 時間濾網
 * F5 - 波動率倉位調整
 * F6 - AI 輔助過濾（KAMA 斜率 + 成交量放大）
 */

import {
  BaseStrategyV35,
  StrategyAction,
  MarketData,
  StrategySignal,
  StrategyInstanceConfig,
  StrategyValidationResult,
  createInitialStrategyState,
} from '../base';
import type { StrategyState } from '../base';
import {
  parseMartinLayers,
  calculateLayerLot,
} from '../../services/martingaleEngine';
import {
  determineMarketRegime,
  getRegimeMartinParams,
  getRegimeStepPct,
  getRegimeMultiplier,
  calculateDynamicTP,
  calculateVolatilityScale,
  isWithinTradingHours,
  calculateKAMASlope,
  isVolumeExpansion,
  calculatePartialTPRatio,
  type MarketRegime,
  type RegimeMartinOverride,
  type DynamicTPConfig,
  type VolPositionConfig,
  type TimeFilterConfig,
  type PartialTakeConfig,
} from '../../services/indicators';

export class StrategyKama3kV50 extends BaseStrategyV35 {
  readonly key = 'KAMA_3K_ULTIMATE_V50';
  readonly name = 'V5.0 KAMA+3K 極致優化馬丁策略';
  readonly version = '5.0.0';
  override readonly isBuiltIn = true;

  readonly defaultConfig: Record<string, any> = {
    // ===== 基礎資金參數 =====
    Initial_Capital: 10000,
    Base_Lot_Size: 30,              // 首單固定 30 USDT
    First_Order_Pct: 0.3,           // 回退用

    // ===== KAMA 參數（V5.0 優化預設）=====
    KAMA_Fast_Length: 30,
    p2_fastest: 8,
    p3_slowest: 2,
    KAMA_Slow_Length: 55,
    q2_fastest: 10,
    q3_slowest: 8,

    // ===== 馬丁基礎參數 =====
    Martin_Multiplier: 1.5,
    Max_Layers: 13,
    Martin_Step_Pct: 2.0,
    Martin_Layers: JSON.stringify([
      { start: 1, end: 4, multiplier: 1.5 },
      { start: 5, end: 9, multiplier: 1.2 },
      { start: 10, end: 13, multiplier: 1.0 },
    ]),

    // ===== 止盈止損 =====
    Target_TP_Pct: 1.0,
    Callback_Pct: 0.1,
    Max_Loss_Pct: 6.0,
    Max_Drawdown_Pct: 10,
    Max_Loss_USDT: 0,

    // ===== K 線與重入 =====
    K_Line_Period: 15,
    Reentry_On_Trend: true,

    // ===== F1：市場制度切換 =====
    enable_regime_switch: true,
    adx_period: 14,
    atr_period: 14,
    adx_strong_threshold: 30,
    adx_weak_threshold: 20,

    // ===== F2：部分獲利 =====
    enable_partial_tp: true,
    partial_tp_layer_4: 0.3,
    partial_tp_layer_6: 0.3,
    partial_tp_layer_8: 0.2,
    partial_tp_trigger_pct: 0.5,

    // ===== F3：ATR 動態止盈 =====
    enable_dynamic_tp: true,
    tp_min_pct: 0.8,
    tp_atr_multiplier: 2.5,

    // ===== F4：時間濾網（預設關閉，24/7 全時段交易） =====
    // KAMA 自適應特性 + F6 AI 斜率過濾已足夠過濾低波動假信號
    enable_time_filter: false,
    allowed_start_hour: 0,
    allowed_end_hour: 24,

    // ===== F5：波動率倉位調整 =====
    enable_vol_position: true,
    target_vol_pct: 1.5,
    vol_min_scale: 0.5,
    vol_max_scale: 2.0,

    // ===== F6：AI 輔助過濾 =====
    enable_ai_filter: true,
    kama_slope_lookback: 5,
    kama_slope_min: 0.02,       // KAMA 斜率最小閾值（%）—— 0.02% 適合 BTC 窄幅震盪環境
    volume_ma_period: 20,
    volume_expansion_threshold: 1.5,
  };

  // ============================================================
  // V3.x 向後兼容 API
  // ============================================================

  /**
   * V5.0：計算首單倉位大小（base 幣數量）
   * 
   * 優先級：
   * 1. Initial_Capital + First_Order_Pct（百分比控倉 - V4.0+ 推薦）
   * 2. Position_Mode + Position_Value（舊版雙模式）
   * 3. Base_Lot_Size（最舊版本回退）
   * 
   * ★ 核心修復：當有 Initial_Capital 和 First_Order_Pct 時，
   *   首單金額 = Initial_Capital × (First_Order_Pct / 100)
   *   首單數量 = 首單金額 / 當前價格
   *   這確保無論交易對是 BTC、ETH 還是其他，都能正確計算
   */
  async calculateLotSize(config: Record<string, any>, price: number): Promise<number> {
    const MIN_LOT = 0.00001;

    // ★ 最高優先級：百分比控倉（V4.0+ 推薦方式）
    const initCap = Number(config.Initial_Capital) || 0;
    const firstPct = Number(config.First_Order_Pct) || 0;
    if (initCap > 0 && firstPct > 0) {
      if (!price || price <= 0) {
        throw new Error('無效的市價，無法計算百分比控倉');
      }
      const firstOrderUsdt = initCap * (firstPct / 100);
      const lot = firstOrderUsdt / price;
      console.log(`[V5.0 calculateLotSize] 百分比控倉：${initCap} × ${firstPct}% = ${firstOrderUsdt.toFixed(2)} USDT → ${lot.toFixed(6)} 幣（價格 ${price}）`);
      return Math.max(lot, MIN_LOT);
    }

    // 第二優先級：Position_Mode + Position_Value
    if (config.Position_Mode) {
      const mode = config.Position_Mode;
      const value = config.Position_Value ?? (typeof config.Base_Lot_Size === 'number' ? config.Base_Lot_Size : 0.01);
      if (mode === 'usdt') {
        if (!price || price <= 0) throw new Error('無效的市價');
        return Math.max(value / price, MIN_LOT);
      }
      if (mode === 'quantity') return Math.max(value, MIN_LOT);
    }

    // 第三優先級：Base_Lot_Size 對象格式
    if (config.Base_Lot_Size && typeof config.Base_Lot_Size === 'object') {
      const bls = config.Base_Lot_Size as { value: number; mode: string };
      if (bls.mode === 'usdt') {
        if (!price || price <= 0) throw new Error('無效的市價');
        return Math.max(bls.value / price, MIN_LOT);
      }
      return Math.max(bls.value, MIN_LOT);
    }

    // 最低優先級：純數值 Base_Lot_Size
    if (typeof config.Base_Lot_Size === 'number') {
      return config.Base_Lot_Size;
    }

    return 0.01;
  }

  async calculateMartingaleLotSize(
    config: Record<string, any>,
    price: number,
    layer: number,
  ): Promise<number> {
    const baseLot = await this.calculateLotSize(config, price);
    const multiplier = config.Martin_Multiplier ?? 1.5;
    const martinLayers = parseMartinLayers(config.Martin_Layers);
    return calculateLayerLot(baseLot, layer, martinLayers, multiplier);
  }

  // ============================================================
  // V5.0 信號驗證（五層 + F4 時間濾網 + F6 AI 過濾）
  // ============================================================

  async validateSignal(
    signal: StrategySignal,
    marketData: MarketData,
    instance: StrategyInstanceConfig,
  ): Promise<StrategyValidationResult> {
    if (signal.action === 'CLOSE') {
      return { valid: true };
    }

    const state = instance.state ?? createInitialStrategyState();
    const config = this.mergeConfig(instance);

    // 1. 冷卻期檢查
    if (state.isCooldown && state.cooldownUntil > Date.now()) {
      return { valid: false, reason: `冷卻期中（剩餘 ${Math.ceil((state.cooldownUntil - Date.now()) / 1000)}s）` };
    }

    // 2. KAMA 方向鎖
    if (marketData.kamaValue) {
      if (signal.action === 'BUY' && signal.price < marketData.kamaValue) {
        return { valid: false, reason: `KAMA 方向鎖：價格 ${signal.price} < KAMA ${marketData.kamaValue}，拒絕做多` };
      }
      if (signal.action === 'SELL' && signal.price > marketData.kamaValue) {
        return { valid: false, reason: `KAMA 方向鎖：價格 ${signal.price} > KAMA ${marketData.kamaValue}，拒絕做空` };
      }
    }

    // 3. 反向持倉檢查
    if (state.currentLayer > 0 && state.totalSize > 0) {
      if (signal.action === 'BUY' && !state.isLong) {
        return { valid: false, reason: '持有空倉，拒絕做多信號' };
      }
      if (signal.action === 'SELL' && state.isLong) {
        return { valid: false, reason: '持有多倉，拒絕做空信號' };
      }
    }

    // 4. F4 時間濾網（僅對新開倉信號生效，加倉不受限）
    if (state.currentLayer === 0 && config.enable_time_filter) {
      const timeConfig: TimeFilterConfig = {
        enable_time_filter: true,
        allowed_start_hour: Number(config.allowed_start_hour) || 12,
        allowed_end_hour: Number(config.allowed_end_hour) || 22,
      };
      if (!isWithinTradingHours(Date.now(), timeConfig)) {
        return { valid: false, reason: `時間濾網：當前不在允許交易時段 (UTC ${timeConfig.allowed_start_hour}-${timeConfig.allowed_end_hour})` };
      }
    }

    // 5. F6 AI 輔助過濾（KAMA 斜率方向確認）
    if (state.currentLayer === 0 && config.enable_ai_filter && marketData.kamaFast !== undefined) {
      const slopeMin = Number(config.kama_slope_min) || 0.05;
      // 簡化：使用 kamaFast vs kamaSlow 的差值作為斜率代理
      if (marketData.kamaSlow !== undefined) {
        const slopePct = marketData.kamaFast > 0
          ? ((marketData.kamaFast - marketData.kamaSlow) / marketData.kamaFast) * 100
          : 0;
        if (signal.action === 'BUY' && slopePct < slopeMin) {
          return { valid: false, reason: `AI 過濾：KAMA 斜率 ${slopePct.toFixed(3)}% < ${slopeMin}%，多頭動能不足` };
        }
        if (signal.action === 'SELL' && slopePct > -slopeMin) {
          return { valid: false, reason: `AI 過濾：KAMA 斜率 ${slopePct.toFixed(3)}% > -${slopeMin}%，空頭動能不足` };
        }
      }
    }

    return { valid: true };
  }

  // ============================================================
  // V5.0 完整決策邏輯
  // ============================================================

  async generateActionsV35(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    state: StrategyState,
  ): Promise<StrategyAction> {
    const config = this.mergeConfig(instance);

    // CLOSE 信號
    if (signal.action === 'CLOSE') {
      if (state.currentLayer > 0 && state.totalSize > 0) {
        return { action: 'CLOSE_ALL', lotSize: state.totalSize, reason: '收到平倉信號' };
      }
      return { action: 'HOLD', lotSize: 0, reason: '無持倉，忽略 CLOSE' };
    }

    // BUY/SELL 信號
    const isLong = signal.action === 'BUY';
    const baseLot = await this.calculateLotSize(config, signal.price);

    // F5：波動率倉位調整
    let adjustedLot = baseLot;
    if (config.enable_vol_position && marketData?.atr) {
      const volConfig: VolPositionConfig = {
        target_vol_pct: Number(config.target_vol_pct) || 1.5,
        vol_min_scale: Number(config.vol_min_scale) || 0.5,
        vol_max_scale: Number(config.vol_max_scale) || 2.0,
      };
      const scale = calculateVolatilityScale(marketData.atr, signal.price, volConfig);
      adjustedLot = baseLot * scale;
    }

    // 首單入場
    if (state.currentLayer === 0 || state.totalSize === 0) {
      return {
        action: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
        lotSize: adjustedLot,
        reason: `V5.0 首單入場（波動率調整 ${(adjustedLot / baseLot * 100).toFixed(0)}%）`,
        price: signal.price,
      };
    }

    // 加倉邏輯（已有持倉）
    const maxLayers = Number(config.Max_Layers) || 13;
    if (state.currentLayer >= maxLayers) {
      return { action: 'HOLD', lotSize: 0, reason: `已達最大層數 ${maxLayers}，不再加倉` };
    }

    // ===== 加倉條件 0：Max_Drawdown_Pct 檢查（最大回撤限制）=====
    const maxDrawdownPct = Number(config.Max_Drawdown_Pct) || 10;
    if (state.currentLayer > 0 && state.maxDrawdownPct !== undefined && state.maxDrawdownPct >= maxDrawdownPct) {
      return {
        action: 'HOLD',
        lotSize: 0,
        reason: `回撤已達上限 ${state.maxDrawdownPct.toFixed(2)}% >= ${maxDrawdownPct}%，停止加倉`,
      };
    }

    // ===== 加倉條件 1：Martin_Step_Pct 偏離檢查 =====
    // 使用 lastLayerPrice（最後一次加倉價格）作為基準，方向感知
    const stepPct = Number(config.Martin_Step_Pct) || 2.0;
    const lastLayerPrice = state.lastLayerPrice || state.avgPrice;
    
    if (lastLayerPrice <= 0 || state.avgPrice <= 0) {
      return { action: 'HOLD', lotSize: 0, reason: '加倉基準價異常，等待修正' };
    }

    // 方向感知偏離計算（基於價格偏離%，不乘槓桿）—— 加倉是為了攤平成本，應基於價格偏離
    const deviation = isLong
      ? ((lastLayerPrice - signal.price) / lastLayerPrice) * 100  // 做多：價格下跌才加倉
      : ((signal.price - lastLayerPrice) / lastLayerPrice) * 100; // 做空：價格上漲才加倉

    if (deviation < stepPct) {
      return {
        action: 'HOLD',
        lotSize: 0,
        reason: `偏離不足 ${deviation.toFixed(3)}% < ${stepPct}%（基準價 ${lastLayerPrice.toFixed(2)}），等待加倉條件`,
      };
    }

    // ===== 加倉條件 2：冷卻時間檢查 =====
    // 上次加倉後至少等待 K_Line_Period 分鐘
    const kLinePeriod = Number(config.K_Line_Period) || 15;
    const cooldownMs = kLinePeriod * 60 * 1000; // 轉為毫秒
    const now = Date.now();
    const lastAddTime = state.lastAddLayerTime || 0;
    
    if (lastAddTime > 0 && (now - lastAddTime) < cooldownMs) {
      const remainSec = Math.ceil((cooldownMs - (now - lastAddTime)) / 1000);
      return {
        action: 'HOLD',
        lotSize: 0,
        reason: `冷卻中，距上次加倉 ${remainSec}s < ${kLinePeriod}min`,
      };
    }

    // ===== 通過所有條件，執行加倉 =====
    const martinLot = await this.calculateMartingaleLotSize(config, signal.price, state.currentLayer);
    return {
      action: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
      lotSize: martinLot,
      reason: `V5.0 馬丁加倉第 ${state.currentLayer + 1} 層（偏離 ${deviation.toFixed(2)}% >= ${stepPct}%）`,
      price: signal.price,
    };
  }

  // ============================================================
  // V5.0 專用方法（供 Monitor 和回測使用）
  // ============================================================

  /**
   * 獲取當前市場制度
   */
  getMarketRegime(adxValue: number | null, config: Record<string, any>): MarketRegime {
    return determineMarketRegime(adxValue, {
      adx_strong_threshold: Number(config.adx_strong_threshold) || 30,
      adx_weak_threshold: Number(config.adx_weak_threshold) || 20,
    });
  }

  /**
   * 獲取制度覆蓋的馬丁參數
   */
  getRegimeOverride(regime: MarketRegime): RegimeMartinOverride {
    return getRegimeMartinParams(regime);
  }

  /**
   * 計算動態止盈百分比
   */
  getDynamicTP(atrValue: number | null, price: number, config: Record<string, any>): number {
    if (!config.enable_dynamic_tp) {
      return Number(config.Target_TP_Pct) || 1.0;
    }
    return calculateDynamicTP(atrValue, price, {
      tp_min_pct: Number(config.tp_min_pct) || 0.8,
      tp_atr_multiplier: Number(config.tp_atr_multiplier) || 2.5,
    });
  }

  /**
   * 計算部分獲利比例
   */
  getPartialTPRatio(
    currentLayer: number,
    unrealizedPnlPct: number,
    config: Record<string, any>,
    alreadyPartialClosed: number[] = [],
  ): number {
    if (!config.enable_partial_tp) return 0;
    return calculatePartialTPRatio(currentLayer, unrealizedPnlPct, {
      enable_partial_tp: true,
      partial_tp_layer_4: Number(config.partial_tp_layer_4) || 0.3,
      partial_tp_layer_6: Number(config.partial_tp_layer_6) || 0.3,
      partial_tp_layer_8: Number(config.partial_tp_layer_8) || 0.2,
      partial_tp_trigger_pct: Number(config.partial_tp_trigger_pct) || 0.5,
    }, alreadyPartialClosed);
  }

  /**
   * 獲取制度覆蓋的加倉間距
   */
  getRegimeStepForLayer(layer: number, regime: MarketRegime): number {
    const override = getRegimeMartinParams(regime);
    return getRegimeStepPct(layer, override);
  }

  /**
   * 獲取制度覆蓋的乘數
   */
  getRegimeMultiplierForLayer(layer: number, regime: MarketRegime): number {
    const override = getRegimeMartinParams(regime);
    return getRegimeMultiplier(layer, override);
  }

  // ============================================================
  // generateActions（BaseStrategy 兼容，簡化版）
  // ============================================================

  generateActions(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
  ): StrategyAction {
    // 同步版本（簡化，不含 F1-F6 完整邏輯）
    const config = this.mergeConfig(instance);
    if (signal.action === 'CLOSE') {
      return { action: 'CLOSE_ALL', lotSize: 0, reason: '平倉信號' };
    }
    const isLong = signal.action === 'BUY';
    return {
      action: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
      lotSize: Number(config.Base_Lot_Size) || 30,
      reason: 'V5.0 同步入場',
    };
  }
}
