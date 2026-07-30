// server/strategies/v35/strategy_kama_3k_v35.ts
// 🔥 V4.0 百分比控仓策略 + V3.x 向後兼容 API

import {
  BaseStrategyV35,
  StrategyAction,
  MarketData,
  StrategySignal,
  StrategyInstanceConfig,
  MartinState,
  StrategyValidationResult,
  createInitialStrategyState,
} from '../base';
import type { StrategyState } from '../base';
import {
  V4Config,
  MartinLayer,
  getFirstOrderValue,
  getLayerSize,
  getLayerValue,
  getStepPct,
  shouldAddLayer,
  calculateUnrealizedLoss,
  calculateUnrealizedLossPct,
  shouldTriggerLimitStop,
  getLayerMultipliers,
  calculateLayerLot,
  getLayerMultiplier,
  parseMartinLayers,
} from '../../services/martingaleEngine';
import { RiskManagerV4 } from '../../services/riskManager';

export class StrategyKama3kV35 extends BaseStrategyV35 {
  readonly key = '20415_KAMA_MARTIN_V35';
  readonly name = 'V4.0 KAMA+3K 動態馬丁策略（百分比控倉）';
  readonly version = '4.0.0';
  override readonly isBuiltIn = true;

  // 🔥 V4.0 固定金本位馬丁默認配置
  readonly defaultConfig: Record<string, any> = {
    // 固定金本位核心參數
    Initial_Capital: 10000,
    Base_Lot_Size: 30,              // 首單固定 30 USDT
    First_Order_Pct: 0.3,           // 回退用：30/10000=0.3%
    Max_Loss_Pct: 5.0,              // 硬止損：本金的 5%（= 500 USDT）
    // V3.x 向後兼容
    Martin_Multiplier: 1.5,
    Max_Layers: 11,
    Max_Drawdown_Pct: 10,
    // KAMA 參數
    KAMA_Fast_Length: 50,
    p2_fastest: 10,
    p3_slowest: 2,
    KAMA_Slow_Length: 50,
    q2_fastest: 10,
    q3_slowest: 6,
    // 馬丁分層（固定金本位階梯式）
    Martin_Step_Pct: 2.0,
    Martin_Layers: JSON.stringify([
      { start: 1, end: 4, multiplier: 1.5 },
      { start: 5, end: 9, multiplier: 1.1 },
      { start: 10, end: 11, multiplier: 1.0 },
    ]),
    // 止盈止損
    Target_TP_Pct: 1.0,
    Callback_Pct: 0.1,
    K_Line_Period: 15,
    // V4.0 入場安全閘（舊策略缺值時維持原有行為）
    enableThreeKFilter: true,
    threeKPatternMode: 'breakout',
    enableKamaDirectionLock: true,
    enableSameDirectionReentry: true,
  };

  // ============================================================
  // V3.x 向後兼容 API
  // ============================================================

  /**
   * V3.x/V4.0：計算首單倉位大小（base 幣數量）
   * 
   * 優先級：
   * 1. Position_Mode + Position_Value（實盤部署覆寫）
   * 2. Initial_Capital + First_Order_Pct（沒有部署覆寫時的策略回退）
   * 3. Base_Lot_Size（最舊版本回退）
   */
  async calculateLotSize(config: Record<string, any>, price: number): Promise<number> {
    const MIN_LOT = 0.00001;

    // 最高優先級：實盤部署覆寫不得被快照內的百分比控倉蓋過。
    if (config.Position_Mode) {
      const mode = config.Position_Mode;
      const value = config.Position_Value ?? (typeof config.Base_Lot_Size === 'number' ? config.Base_Lot_Size : 0.01);

      if (mode === 'usdt') {
        if (!price || price <= 0) {
          throw new Error('無效的市價');
        }
        const lot = value / price;
        console.log(`[calculateLotSize] USDT 模式：${value} USDT → ${lot.toFixed(6)} 幣（價格 ${price}）`);
        return Math.max(lot, MIN_LOT);
      }
      if (mode === 'quantity') {
        console.log(`[calculateLotSize] 數量模式：${value} 幣`);
        return Math.max(value, MIN_LOT);
      }
    }

    // 第二優先級：快照策略原始百分比控倉；僅在沒有部署覆寫時使用。
    if (config.Initial_Capital && config.First_Order_Pct && config.Initial_Capital > 0 && config.First_Order_Pct > 0) {
      if (!price || price <= 0) {
        throw new Error('無效的市價，無法計算百分比控倉');
      }
      const firstOrderUsdt = config.Initial_Capital * (config.First_Order_Pct / 100);
      const lot = firstOrderUsdt / price;
      console.log(`[calculateLotSize] 百分比控倉：${config.Initial_Capital} × ${config.First_Order_Pct}% = ${firstOrderUsdt.toFixed(2)} USDT → ${lot.toFixed(6)} 幣（價格 ${price}）`);
      return Math.max(lot, MIN_LOT);
    }

    // 第三優先級：Base_Lot_Size 對象格式
    if (config.Base_Lot_Size && typeof config.Base_Lot_Size === 'object') {
      const bls = config.Base_Lot_Size as { value: number; mode: string };
      if (bls.mode === 'usdt') {
        if (!price || price <= 0) throw new Error('無效的市價');
        const lot = bls.value / price;
        return Math.max(lot, MIN_LOT);
      }
      return Math.max(bls.value, MIN_LOT);
    }

    // 最低優先級：純數值 Base_Lot_Size
    if (typeof config.Base_Lot_Size === 'number') {
      return config.Base_Lot_Size;
    }

    return 0.01; // 默認
  }

  /**
   * V3.x：計算馬丁加倉倉位大小
   * 支持 Position_Mode/Position_Value 扁平格式
   */
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

  /**
   * V3.5：信號驗證（五層檢查）
   */
  async validateSignal(
    signal: StrategySignal,
    marketData: MarketData,
    instance: StrategyInstanceConfig,
  ): Promise<StrategyValidationResult> {
    // CLOSE 信號始終有效
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

    return { valid: true };
  }

  /**
   * V3.5：完整決策邏輯
   */
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
    // 使用 calculateLotSize 正確處理 Position_Mode (usdt/quantity) 換算
    const baseLot = await this.calculateLotSize(config, signal.price);

    // 首單
    if (state.currentLayer === 0 || state.totalSize === 0) {
      return {
        action: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
        lotSize: baseLot,
        reason: '首單開倉',
      };
    }

    // 加倉邏輯（已有持倉且方向一致）— 由 V35Monitor 負責加倉判斷
    const layerCheck = shouldAddLayer(state, signal.price || 0, config as unknown as V4Config);
    const baseP = (state.lastLayerPrice && state.lastLayerPrice > 0) ? state.lastLayerPrice : state.avgPrice;
    const curDev = baseP > 0 && signal.price > 0
      ? (state.isLong ? ((baseP - signal.price) / baseP) * 100 : ((signal.price - baseP) / baseP) * 100)
      : 0;
    return { action: 'HOLD', lotSize: 0, reason: `已有持倉(L${state.currentLayer})，偏離${curDev.toFixed(2)}%/${layerCheck.stepPctUsed.toFixed(1)}%，由Monitor加倉` };
  }

  // ============================================================
  // V4.0 新功能
  // ============================================================

  /**
   * 🔥 V4.0：获取首单金额
   */
  getFirstOrderValue(config: any): number {
    return config.Initial_Capital * (config.First_Order_Pct / 100);
  }

  /**
   * 🔥 V4.0：获取极限止损触发金额
   */
  getMaxLossAmount(config: any): number {
    return config.Initial_Capital * (config.Max_Loss_Pct / 100);
  }

  /**
   * 🔥 V4.0：执行加仓检查
   */
  async checkMartingaleAdd(
    state: StrategyState,
    currentPrice: number,
    config: any,
    instance: any,
  ): Promise<{ added: boolean; state: StrategyState; message: string }> {
    const { shouldAdd, stepPctUsed, nextLayer } = shouldAddLayer(state, currentPrice, config);

    if (!shouldAdd) {
      return { added: false, state, message: `未达加仓间距 ${stepPctUsed}%` };
    }

    if (state.currentLayer >= config.Max_Layers) {
      return { added: false, state, message: `已达最大层数 ${state.currentLayer}/${config.Max_Layers}` };
    }

    const layerSize = getLayerSize(state.currentLayer + 1, currentPrice, config);
    const cost = layerSize * currentPrice;

    if (cost > state.capital) {
      return { added: false, state, message: `余额不足：需要 ${cost.toFixed(2)} USDT` };
    }

    const totalCost = state.avgPrice * state.totalSize + cost;
    const newTotalSize = state.totalSize + layerSize;

    state.currentLayer += 1;
    state.totalSize = newTotalSize;
    state.avgPrice = totalCost / newTotalSize;
    state.totalCost = totalCost;
    state.capital -= cost;

    return {
      added: true,
      state,
      message: `加仓成功，第 ${state.currentLayer} 层，间距 ${stepPctUsed}%`,
    };
  }

  /**
   * 🔥 V4.0：检查极限止损
   */
  async checkLimitStop(
    state: StrategyState,
    currentPrice: number,
    config: any,
    instance: any,
    closeAll: Function,
    pause: Function,
  ): Promise<{ triggered: boolean }> {
    const result = shouldTriggerLimitStop(state, currentPrice, config);
    if (result.triggered) {
      console.log(`🛑 [V4.0 极限止损] ${result.reason}`);
      await closeAll(instance.id);
      await pause(instance.id);
      return { triggered: true };
    }
    return { triggered: false };
  }

  // ============================================================
  // BaseStrategy 抽象方法實現
  // ============================================================

  generateActions(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    martinState: MartinState,
  ): StrategyAction {
    // V4.0 邏輯使用 generateActionsV35 非同步版本
    // 此同步版本保留向後兼容，但正確處理 Position_Mode
    const isLong = signal.action === 'BUY';
    const config = this.mergeConfig(instance);

    // ★ 統一倉位計算：實盤部署覆寫必須高於快照百分比控倉
    let baseLot: number;
    const _initCap = Number(config.Initial_Capital) || 0;
    const _firstPct = Number(config.First_Order_Pct) || 0;
    if (config.Position_Mode === 'usdt' || config.Position_Mode === 'quantity') {
      const value = Number(config.Position_Value ?? (typeof config.Base_Lot_Size === 'number' ? config.Base_Lot_Size : 0.01));
      if (config.Position_Mode === 'usdt') {
        if (!signal.price || signal.price <= 0) throw new Error('無效的市價');
        baseLot = value / signal.price;
      } else {
        baseLot = value;
      }
    } else if (_initCap > 0 && _firstPct > 0 && signal.price > 0) {
      // ★ 百分比控倉（V4.0+ 推薦）
      const firstOrderUsdt = _initCap * (_firstPct / 100);
      baseLot = firstOrderUsdt / signal.price;
    } else if (typeof config.Base_Lot_Size === 'number') {
      baseLot = config.Base_Lot_Size;
    } else {
      baseLot = 0.01;
    }
    baseLot = Math.max(baseLot, 0.00001);

    if (signal.action === 'CLOSE') {
      if (martinState.lossCount > 0) {
        return { action: 'CLOSE_ALL', lotSize: martinState.currentLot, reason: '收到平倉信號' };
      }
      return { action: 'HOLD', lotSize: 0, reason: '無持倉' };
    }

    return {
      action: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
      lotSize: baseLot,
      reason: '首單開倉',
    };
  }
}

// V3.x 向後兼容：singleton export
export const strategyKama3kV35 = new StrategyKama3kV35();
