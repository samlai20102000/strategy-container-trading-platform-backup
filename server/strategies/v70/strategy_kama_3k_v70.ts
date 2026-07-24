/**
 * KAMA 3K V7.0 — 龍捲風雙渦輪（MA200 + KAMA 雙線 + S 曲線階梯馬丁）
 *
 * 核心機制（嚴格按照《軍工級量化策略生產部署藍皮書》實作）：
 * 1. MA200 宏觀趨勢錨（SMA/EMA + 震盪過濾斜率門檻）
 * 2. KAMA 雙線交叉入場（金叉做多 / 死叉做空 / 雙向模式）
 * 3. S 曲線階梯馬丁（多空分離間距 gap_long / gap_short）
 * 4. 硬止損 + MA200 強平保護（鐵律）+ 反向交叉平倉 + 追蹤止盈
 * 5. 加倉層專屬止盈（layer_tp_long / layer_tp_short）
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

// ============================================================
// V7.0 配置型別
// ============================================================
export interface V70MartinLayerRule {
  start: number;
  end: number;
  multiplier: number;
  gap_long: number;   // 多頭間距 %
  gap_short: number;  // 空頭間距 %
}

export interface V70Config {
  // 1. 基礎設定
  base_lot_size_usdt: number;
  leverage: number;
  timeframe: string;

  // 2. 宏觀趨勢錨 (MA200)
  ma200_enabled: boolean;
  ma200_period: number;
  ma200_type: 'SMA' | 'EMA';
  ma200_oscillation_filter_pct: number;

  // 3. KAMA 雙線參數
  kama_fast_er_period: number;
  kama_fast_fast_const: number;
  kama_fast_slow_const: number;
  kama_slow_er_period: number;
  kama_slow_fast_const: number;
  kama_slow_slow_const: number;
  cross_mode: 'both' | 'long_only' | 'short_only';

  // 4. 出場與風控
  risk_hard_stop_pct: number;
  risk_ma_force_liq: boolean;
  risk_reverse_cross_close: boolean;
  risk_reverse_cross_profit_limit: number;

  // 5. 追蹤止盈
  trailing_enabled: boolean;
  trailing_activation_pct: number;
  trailing_retracement_pct: number;

  // 6. S 曲線階梯馬丁
  martin_enabled: boolean;
  martin_max_layers: number;
  martin_layer_tp_long: number;
  martin_layer_tp_short: number;
  martin_layers: V70MartinLayerRule[];
}

/** V7.0 默認配置（完全對應文件第一部分 STRATEGY_CONFIG） */
export const V70_DEFAULT_CONFIG: V70Config = {
  // 1. 基礎設定
  base_lot_size_usdt: 150.0,
  leverage: 5,
  timeframe: '5m',

  // 2. 宏觀趨勢錨 (MA200)
  ma200_enabled: true,
  ma200_period: 200,
  ma200_type: 'SMA',
  ma200_oscillation_filter_pct: 0.015,

  // 3. KAMA 雙線參數
  kama_fast_er_period: 50,
  kama_fast_fast_const: 10,
  kama_fast_slow_const: 2,
  kama_slow_er_period: 50,
  kama_slow_fast_const: 10,
  kama_slow_slow_const: 6,
  cross_mode: 'both',

  // 4. 出場與風控
  risk_hard_stop_pct: 4.5,
  risk_ma_force_liq: true,
  risk_reverse_cross_close: true,
  risk_reverse_cross_profit_limit: 1.5,

  // 5. 追蹤止盈
  trailing_enabled: true,
  trailing_activation_pct: 3.0,
  trailing_retracement_pct: 1.5,

  // 6. S 曲線階梯馬丁
  martin_enabled: true,
  martin_max_layers: 11,
  martin_layer_tp_long: 0.30,
  martin_layer_tp_short: 0.20,
  martin_layers: [
    { start: 1, end: 4, multiplier: 1.5, gap_long: 0.60, gap_short: 0.40 },
    { start: 5, end: 9, multiplier: 1.1, gap_long: 1.00, gap_short: 0.70 },
    { start: 10, end: 11, multiplier: 1.0, gap_long: 1.80, gap_short: 1.20 },
  ],
};

// ============================================================
// V7.0 持倉狀態（擴展自 StrategyState）
// ============================================================
export interface V70PositionState {
  side: 'LONG' | 'SHORT' | null;
  layers: Array<{ price: number; size: number }>;
  entryPriceAvg: number;
  currentLayer: number;
  totalQty: number;
  maxProfitRate: number;  // 追蹤止盈用
}

// ============================================================
// 工具函數：KAMA 計算（完整遞迴，與文件第三部分一致）
// ============================================================
export function calculateKAMA(
  closes: number[],
  erPeriod: number,
  fastConst: number,
  slowConst: number,
): Array<number | null> {
  const result: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length <= erPeriod) return result;

  const fastestSC = 2.0 / (fastConst + 1);
  const slowestSC = 2.0 / (slowConst + 1);

  // 初始值：以第 erPeriod-1 根的收盤價作為 KAMA 起點
  let kama = closes[erPeriod - 1];
  result[erPeriod - 1] = kama;

  for (let i = erPeriod; i < closes.length; i++) {
    // 1. 計算方向變動 (Direction)
    const change = Math.abs(closes[i] - closes[i - erPeriod]);
    // 2. 計算波動性 (Volatility)
    let volatility = 0;
    for (let j = i - erPeriod + 1; j <= i; j++) {
      volatility += Math.abs(closes[j] - closes[j - 1]);
    }
    // 3. 效率比率 ER
    const er = volatility === 0 ? 1.0 : change / volatility;
    // 4. 平滑常數 SC = [ER × (fastest_SC - slowest_SC) + slowest_SC]²
    const sc = Math.pow(er * (fastestSC - slowestSC) + slowestSC, 2);
    // 5. 計算當期 KAMA
    kama = kama + sc * (closes[i] - kama);
    result[i] = kama;
  }

  return result;
}

// ============================================================
// V7.0 策略引擎
// ============================================================
export class StrategyKama3kV70 extends BaseStrategyV35 {
  readonly key = 'KAMA_3K_TORNADO_V70';
  readonly name = 'V7.0 KAMA 3K 龍捲風雙渦輪';
  readonly version = '7.0.0';
  override readonly isBuiltIn = true;

  readonly defaultConfig: Record<string, any> = {
    // 映射到 flat key 供 UI 和 DB 使用
    base_lot_size_usdt: V70_DEFAULT_CONFIG.base_lot_size_usdt,
    leverage: V70_DEFAULT_CONFIG.leverage,
    timeframe: V70_DEFAULT_CONFIG.timeframe,
    ma200_enabled: V70_DEFAULT_CONFIG.ma200_enabled,
    ma200_period: V70_DEFAULT_CONFIG.ma200_period,
    ma200_type: V70_DEFAULT_CONFIG.ma200_type,
    ma200_oscillation_filter_pct: V70_DEFAULT_CONFIG.ma200_oscillation_filter_pct,
    kama_fast_er_period: V70_DEFAULT_CONFIG.kama_fast_er_period,
    kama_fast_fast_const: V70_DEFAULT_CONFIG.kama_fast_fast_const,
    kama_fast_slow_const: V70_DEFAULT_CONFIG.kama_fast_slow_const,
    kama_slow_er_period: V70_DEFAULT_CONFIG.kama_slow_er_period,
    kama_slow_fast_const: V70_DEFAULT_CONFIG.kama_slow_fast_const,
    kama_slow_slow_const: V70_DEFAULT_CONFIG.kama_slow_slow_const,
    cross_mode: V70_DEFAULT_CONFIG.cross_mode,
    risk_hard_stop_pct: V70_DEFAULT_CONFIG.risk_hard_stop_pct,
    risk_ma_force_liq: V70_DEFAULT_CONFIG.risk_ma_force_liq,
    risk_reverse_cross_close: V70_DEFAULT_CONFIG.risk_reverse_cross_close,
    risk_reverse_cross_profit_limit: V70_DEFAULT_CONFIG.risk_reverse_cross_profit_limit,
    trailing_enabled: V70_DEFAULT_CONFIG.trailing_enabled,
    trailing_activation_pct: V70_DEFAULT_CONFIG.trailing_activation_pct,
    trailing_retracement_pct: V70_DEFAULT_CONFIG.trailing_retracement_pct,
    martin_enabled: V70_DEFAULT_CONFIG.martin_enabled,
    martin_max_layers: V70_DEFAULT_CONFIG.martin_max_layers,
    martin_layer_tp_long: V70_DEFAULT_CONFIG.martin_layer_tp_long,
    martin_layer_tp_short: V70_DEFAULT_CONFIG.martin_layer_tp_short,
    martin_layers: JSON.stringify(V70_DEFAULT_CONFIG.martin_layers),
    // 向後兼容 key（供 executor 和 monitor 使用）
    K_Line_Period: 5,
    Max_Layers: V70_DEFAULT_CONFIG.martin_max_layers,
    Base_Lot_Size: V70_DEFAULT_CONFIG.base_lot_size_usdt,
    Martin_Step_Pct: 0.6,  // 最小間距（用於 monitor 回退）
  };

  private cfg: V70Config = V70_DEFAULT_CONFIG;

  constructor(config?: Partial<V70Config>) {
    super();
    if (config) {
      this.cfg = { ...V70_DEFAULT_CONFIG, ...config };
    }
  }

  /**
   * 從 instance.config 解析出 V70Config
   */
  parseConfig(rawConfig: Record<string, any>): V70Config {
    const layers = typeof rawConfig.martin_layers === 'string'
      ? JSON.parse(rawConfig.martin_layers)
      : rawConfig.martin_layers ?? V70_DEFAULT_CONFIG.martin_layers;

    return {
      base_lot_size_usdt: Number(rawConfig.base_lot_size_usdt ?? V70_DEFAULT_CONFIG.base_lot_size_usdt),
      leverage: Number(rawConfig.leverage ?? V70_DEFAULT_CONFIG.leverage),
      timeframe: String(rawConfig.timeframe ?? V70_DEFAULT_CONFIG.timeframe),
      ma200_enabled: rawConfig.ma200_enabled !== false && rawConfig.ma200_enabled !== 0,
      ma200_period: Number(rawConfig.ma200_period ?? V70_DEFAULT_CONFIG.ma200_period),
      ma200_type: (rawConfig.ma200_type === 'EMA' ? 'EMA' : 'SMA') as 'SMA' | 'EMA',
      ma200_oscillation_filter_pct: Number(rawConfig.ma200_oscillation_filter_pct ?? V70_DEFAULT_CONFIG.ma200_oscillation_filter_pct),
      kama_fast_er_period: Number(rawConfig.kama_fast_er_period ?? V70_DEFAULT_CONFIG.kama_fast_er_period),
      kama_fast_fast_const: Number(rawConfig.kama_fast_fast_const ?? V70_DEFAULT_CONFIG.kama_fast_fast_const),
      kama_fast_slow_const: Number(rawConfig.kama_fast_slow_const ?? V70_DEFAULT_CONFIG.kama_fast_slow_const),
      kama_slow_er_period: Number(rawConfig.kama_slow_er_period ?? V70_DEFAULT_CONFIG.kama_slow_er_period),
      kama_slow_fast_const: Number(rawConfig.kama_slow_fast_const ?? V70_DEFAULT_CONFIG.kama_slow_fast_const),
      kama_slow_slow_const: Number(rawConfig.kama_slow_slow_const ?? V70_DEFAULT_CONFIG.kama_slow_slow_const),
      cross_mode: (['both', 'long_only', 'short_only'].includes(rawConfig.cross_mode) ? rawConfig.cross_mode : 'both') as V70Config['cross_mode'],
      risk_hard_stop_pct: Number(rawConfig.risk_hard_stop_pct ?? V70_DEFAULT_CONFIG.risk_hard_stop_pct),
      risk_ma_force_liq: rawConfig.risk_ma_force_liq !== false && rawConfig.risk_ma_force_liq !== 0,
      risk_reverse_cross_close: rawConfig.risk_reverse_cross_close !== false && rawConfig.risk_reverse_cross_close !== 0,
      risk_reverse_cross_profit_limit: Number(rawConfig.risk_reverse_cross_profit_limit ?? V70_DEFAULT_CONFIG.risk_reverse_cross_profit_limit),
      trailing_enabled: rawConfig.trailing_enabled !== false && rawConfig.trailing_enabled !== 0,
      trailing_activation_pct: Number(rawConfig.trailing_activation_pct ?? V70_DEFAULT_CONFIG.trailing_activation_pct),
      trailing_retracement_pct: Number(rawConfig.trailing_retracement_pct ?? V70_DEFAULT_CONFIG.trailing_retracement_pct),
      martin_enabled: rawConfig.martin_enabled !== false && rawConfig.martin_enabled !== 0,
      martin_max_layers: Number(rawConfig.martin_max_layers ?? V70_DEFAULT_CONFIG.martin_max_layers),
      martin_layer_tp_long: Number(rawConfig.martin_layer_tp_long ?? V70_DEFAULT_CONFIG.martin_layer_tp_long),
      martin_layer_tp_short: Number(rawConfig.martin_layer_tp_short ?? V70_DEFAULT_CONFIG.martin_layer_tp_short),
      martin_layers: layers,
    };
  }

  // ============================================================
  // 核心信號生成：完整 V7.0 引擎（對應文件第三部分 process_bar）
  // ============================================================

  /**
   * 計算 MA200（SMA 或 EMA）
   */
  calculateMA200(closes: number[], period: number, type: 'SMA' | 'EMA'): Array<number | null> {
    const result: Array<number | null> = new Array(closes.length).fill(null);
    if (type === 'SMA') {
      for (let i = period - 1; i < closes.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += closes[j];
        result[i] = sum / period;
      }
    } else {
      // EMA
      const multiplier = 2 / (period + 1);
      let ema = closes[0];
      result[0] = ema;
      for (let i = 1; i < closes.length; i++) {
        ema = (closes[i] - ema) * multiplier + ema;
        result[i] = ema;
      }
    }
    return result;
  }

  /**
   * 計算 MA200 斜率（過去 20 根的百分比變化）
   */
  calculateMA200Slope(ma200Series: Array<number | null>, idx: number): number {
    if (idx < 20) return 0;
    const current = ma200Series[idx];
    const prev = ma200Series[idx - 20];
    if (!current || !prev || prev === 0) return 0;
    return ((current - prev) / prev) * 100;
  }

  /**
   * 檢測 KAMA 交叉信號
   * 返回: 1 = 金叉, -1 = 死叉, 0 = 無
   */
  detectKAMACross(
    kamaFast: Array<number | null>,
    kamaSlow: Array<number | null>,
    idx: number,
  ): number {
    if (idx < 1) return 0;
    const fCurr = kamaFast[idx];
    const fPrev = kamaFast[idx - 1];
    const sCurr = kamaSlow[idx];
    const sPrev = kamaSlow[idx - 1];
    if (fCurr == null || fPrev == null || sCurr == null || sPrev == null) return 0;

    // 金叉：快線從下方穿越慢線
    if (fCurr > sCurr && fPrev <= sPrev) return 1;
    // 死叉：快線從上方穿越慢線
    if (fCurr < sCurr && fPrev >= sPrev) return -1;
    return 0;
  }

  /**
   * 開倉條件檢查（對應文件 _check_entry_condition）
   */
  checkEntryCondition(
    cfg: V70Config,
    price: number,
    ma200Value: number | null,
    ma200Slope: number,
    cross: number,
  ): boolean {
    // 0. 震盪過濾
    if (cfg.ma200_oscillation_filter_pct > 0) {
      if (Math.abs(ma200Slope) < cfg.ma200_oscillation_filter_pct) {
        return false;
      }
    }

    if (cross === 0) return false;

    // 交叉模式過濾
    if (cfg.cross_mode === 'long_only' && cross === -1) return false;
    if (cfg.cross_mode === 'short_only' && cross === 1) return false;

    // MA200 方向校驗
    if (cfg.ma200_enabled && ma200Value != null) {
      if (cross === 1 && price <= ma200Value) return false;  // 金叉但價格低於MA200 -> 不做多
      if (cross === -1 && price >= ma200Value) return false; // 死叉但價格高於MA200 -> 不做空
    }

    return true;
  }

  /**
   * 馬丁加倉觸發檢查（對應文件 _check_martyn_trigger）
   * 多空分離間距：多頭看 gap_long，空頭看 gap_short
   */
  checkMartinTrigger(
    cfg: V70Config,
    position: V70PositionState,
    price: number,
    ma200Value: number | null,
  ): { triggered: boolean; layerNum: number; reason: string } {
    if (!cfg.martin_enabled) return { triggered: false, layerNum: 0, reason: '' };
    if (position.currentLayer >= cfg.martin_max_layers) {
      return { triggered: false, layerNum: 0, reason: '已達最大層數' };
    }

    const nextLayer = position.currentLayer + 1;
    const layerConfig = this.getLayerConfig(cfg, nextLayer);
    if (!layerConfig) return { triggered: false, layerNum: 0, reason: '無對應層配置' };

    const lastEntryPrice = position.layers[position.layers.length - 1]?.price ?? 0;
    if (lastEntryPrice <= 0) return { triggered: false, layerNum: 0, reason: '無上一層價格' };

    if (position.side === 'LONG') {
      // 多頭加倉：價格 > MA200 且價格下跌偏離
      if (cfg.ma200_enabled && ma200Value != null && price <= ma200Value) {
        return { triggered: false, layerNum: 0, reason: '價格已跌破MA200，不加倉' };
      }
      const gap = layerConfig.gap_long / 100;
      if (price <= lastEntryPrice * (1 - gap)) {
        return { triggered: true, layerNum: nextLayer, reason: `多頭第${nextLayer}層加倉（偏離${(layerConfig.gap_long).toFixed(2)}%）` };
      }
    } else if (position.side === 'SHORT') {
      // 空頭加倉：價格 < MA200 且價格上漲偏離
      if (cfg.ma200_enabled && ma200Value != null && price >= ma200Value) {
        return { triggered: false, layerNum: 0, reason: '價格已突破MA200，不加倉' };
      }
      const gap = layerConfig.gap_short / 100;
      if (price >= lastEntryPrice * (1 + gap)) {
        return { triggered: true, layerNum: nextLayer, reason: `空頭第${nextLayer}層加倉（偏離${(layerConfig.gap_short).toFixed(2)}%）` };
      }
    }

    return { triggered: false, layerNum: 0, reason: '未達加倉間距' };
  }

  /**
   * 出場條件檢查（對應文件 _check_exit_conditions）
   */
  checkExitConditions(
    cfg: V70Config,
    position: V70PositionState,
    price: number,
    ma200Value: number | null,
    cross: number,
  ): { shouldExit: boolean; reason: string } {
    if (!position.side) return { shouldExit: false, reason: '' };

    const avgPrice = position.entryPriceAvg;
    const profitRate = position.side === 'LONG'
      ? (price - avgPrice) / avgPrice
      : (avgPrice - price) / avgPrice;

    // 5.1 硬止損
    if (cfg.risk_hard_stop_pct > 0) {
      const hardStopThreshold = -(cfg.risk_hard_stop_pct / 100);
      if (profitRate < hardStopThreshold) {
        return { shouldExit: true, reason: `硬止損觸發（虧損${(profitRate * 100).toFixed(2)}% > ${cfg.risk_hard_stop_pct}%）` };
      }
    }

    // 5.2 MA200 強平保護（鐵律）
    if (cfg.risk_ma_force_liq && ma200Value != null) {
      if (position.side === 'LONG' && price < ma200Value) {
        return { shouldExit: true, reason: `MA200強平保護：多頭價格${price}跌破MA200=${ma200Value.toFixed(2)}` };
      }
      if (position.side === 'SHORT' && price > ma200Value) {
        return { shouldExit: true, reason: `MA200強平保護：空頭價格${price}突破MA200=${ma200Value.toFixed(2)}` };
      }
    }

    // 5.3 反向交叉平倉
    if (cfg.risk_reverse_cross_close) {
      const limit = cfg.risk_reverse_cross_profit_limit / 100;
      if (profitRate < limit) {
        if (position.side === 'LONG' && cross === -1) {
          return { shouldExit: true, reason: `反向交叉平倉：多頭遇死叉（浮盈${(profitRate * 100).toFixed(2)}% < ${cfg.risk_reverse_cross_profit_limit}%）` };
        }
        if (position.side === 'SHORT' && cross === 1) {
          return { shouldExit: true, reason: `反向交叉平倉：空頭遇金叉（浮盈${(profitRate * 100).toFixed(2)}% < ${cfg.risk_reverse_cross_profit_limit}%）` };
        }
      }
    }

    // 5.4 追蹤止盈
    if (cfg.trailing_enabled) {
      const activationThreshold = cfg.trailing_activation_pct / 100;
      const retracementThreshold = cfg.trailing_retracement_pct / 100;
      if (profitRate > activationThreshold) {
        // 更新最高盈利
        if (profitRate > position.maxProfitRate) {
          position.maxProfitRate = profitRate;
        }
        // 檢查回撤
        if (position.maxProfitRate - profitRate > retracementThreshold) {
          return { shouldExit: true, reason: `追蹤止盈觸發：最高盈利${(position.maxProfitRate * 100).toFixed(2)}%，回撤${((position.maxProfitRate - profitRate) * 100).toFixed(2)}%` };
        }
      } else {
        // 未達啟動門檻，持續追蹤最高盈利
        position.maxProfitRate = Math.max(position.maxProfitRate, profitRate);
      }
    }

    return { shouldExit: false, reason: '' };
  }

  /**
   * 加倉層專屬止盈檢查
   */
  checkLayerTP(
    cfg: V70Config,
    position: V70PositionState,
    price: number,
  ): { shouldExit: boolean; reason: string } {
    if (!position.side || position.currentLayer <= 1) return { shouldExit: false, reason: '' };

    const avgPrice = position.entryPriceAvg;
    const profitRate = position.side === 'LONG'
      ? (price - avgPrice) / avgPrice
      : (avgPrice - price) / avgPrice;

    const tpPct = position.side === 'LONG'
      ? cfg.martin_layer_tp_long / 100
      : cfg.martin_layer_tp_short / 100;

    if (profitRate >= tpPct) {
      return { shouldExit: true, reason: `加倉層止盈：${position.side === 'LONG' ? '多頭' : '空頭'}浮盈${(profitRate * 100).toFixed(2)}% ≥ ${position.side === 'LONG' ? cfg.martin_layer_tp_long : cfg.martin_layer_tp_short}%` };
    }

    return { shouldExit: false, reason: '' };
  }

  /**
   * 查找層級配置
   */
  getLayerConfig(cfg: V70Config, layerNum: number): V70MartinLayerRule | null {
    for (const layer of cfg.martin_layers) {
      if (layer.start <= layerNum && layerNum <= layer.end) {
        return layer;
      }
    }
    return null;
  }

  /**
   * 計算加倉大小（基於 base_lot_size_usdt 和層級乘數）
   */
  calculateLayerSize(cfg: V70Config, layerNum: number, price: number): number {
    const baseSize = cfg.base_lot_size_usdt / price;
    if (layerNum <= 1) return baseSize;

    // 累積乘數計算
    let cumulativeMultiplier = 1.0;
    for (let l = 2; l <= layerNum; l++) {
      const layerCfg = this.getLayerConfig(cfg, l);
      if (layerCfg) {
        cumulativeMultiplier *= layerCfg.multiplier;
      }
    }
    return baseSize * cumulativeMultiplier;
  }

  /**
   * 計算下一層加倉偏離百分比（供持倉卡片顯示）
   */
  getNextLayerGapPct(cfg: V70Config, position: V70PositionState): number | null {
    if (!position.side || position.currentLayer >= cfg.martin_max_layers) return null;
    const nextLayer = position.currentLayer + 1;
    const layerCfg = this.getLayerConfig(cfg, nextLayer);
    if (!layerCfg) return null;
    return position.side === 'LONG' ? layerCfg.gap_long : layerCfg.gap_short;
  }

  // ============================================================
  // BaseStrategy 抽象方法實現
  // ============================================================

  generateActions(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    martinState: any,
  ): StrategyAction {
    // V7.0 使用 generateActionsV35 非同步版本
    // 此同步版本保留向後兼容
    const cfg = this.parseConfig(instance.config);
    const price = signal.price || 0;
    if (price <= 0) return { action: 'HOLD', lotSize: 0, reason: 'V7.0: 無有效價格' };

    const baseLot = cfg.base_lot_size_usdt / price;

    if (signal.action === 'CLOSE') {
      return { action: 'CLOSE_ALL', lotSize: 0, reason: 'V7.0: 收到平倉信號' };
    }

    const isLong = signal.action === 'BUY';
    return {
      action: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
      lotSize: baseLot,
      reason: 'V7.0: 底倉開倉',
    };
  }

  async validateSignal(
    signal: StrategySignal,
    marketData: MarketData,
    instance: StrategyInstanceConfig,
  ): Promise<StrategyValidationResult> {
    // V7.0 驗證：基本檢查
    if (!signal.price || signal.price <= 0) {
      return { valid: false, reason: '無有效價格' };
    }
    return { valid: true };
  }

  async generateActionsV35(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    state: StrategyState,
  ): Promise<StrategyAction> {
    const cfg = this.parseConfig(instance.config);
    const price = signal.price || 0;
    if (price <= 0) return { action: 'HOLD', lotSize: 0, reason: 'V7.0: 無有效價格' };

    const baseLot = cfg.base_lot_size_usdt / price;

    // 平倉信號
    if (signal.action === 'CLOSE') {
      if (state.currentLayer > 0) {
        return { action: 'CLOSE_ALL', lotSize: state.totalSize, reason: 'V7.0: 收到平倉信號' };
      }
      return { action: 'HOLD', lotSize: 0, reason: 'V7.0: 無持倉' };
    }

    // 有持倉時：由 Monitor 處理加倉和平倉
    if (state.currentLayer > 0) {
      return { action: 'HOLD', lotSize: 0, reason: `V7.0: 已有持倉(L${state.currentLayer})，由Monitor管理` };
    }

    // 無持倉：開倉
    const isLong = signal.action === 'BUY';
    return {
      action: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
      lotSize: baseLot,
      reason: 'V7.0: 底倉開倉',
      price,
    };
  }

  // ============================================================
  // V7.0 信號生成（供 Heartbeat / 自動交易使用）
  // ============================================================

  /**
   * 生成交易信號（完整 V7.0 引擎）
   * 輸入：K 線數據陣列
   * 輸出：交易動作
   */
  generateTradingSignal(
    candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>,
    state: StrategyState,
    rawConfig: Record<string, any>,
  ): { action: 'buy' | 'sell' | 'close' | 'add_long' | 'add_short' | 'hold'; reason: string; price: number; lotUsdt?: number; layerNum?: number } {
    const cfg = this.parseConfig(rawConfig);
    if (candles.length < Math.max(cfg.ma200_period + 20, cfg.kama_fast_er_period + 1, cfg.kama_slow_er_period + 1)) {
      return { action: 'hold', reason: 'K線數據不足', price: 0 };
    }

    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];
    const idx = closes.length - 1;

    // 計算指標
    const ma200Series = this.calculateMA200(closes, cfg.ma200_period, cfg.ma200_type);
    const ma200Value = ma200Series[idx];
    const ma200Slope = this.calculateMA200Slope(ma200Series, idx);

    const kamaFast = calculateKAMA(closes, cfg.kama_fast_er_period, cfg.kama_fast_fast_const, cfg.kama_fast_slow_const);
    const kamaSlow = calculateKAMA(closes, cfg.kama_slow_er_period, cfg.kama_slow_fast_const, cfg.kama_slow_slow_const);
    const cross = this.detectKAMACross(kamaFast, kamaSlow, idx);

    // 構建持倉狀態
    const position: V70PositionState = {
      side: state.currentLayer > 0 ? (state.isLong ? 'LONG' : 'SHORT') : null,
      layers: state.currentLayer > 0 ? [{ price: state.avgPrice, size: state.totalSize }] : [],
      entryPriceAvg: state.avgPrice,
      currentLayer: state.currentLayer,
      totalQty: state.totalSize,
      maxProfitRate: 0,
    };

    // 如果有 lastLayerPrice，用它構建更精確的 layers
    if (state.currentLayer > 0 && state.lastLayerPrice > 0) {
      position.layers = [{ price: state.lastLayerPrice, size: state.totalSize }];
    }

    // --- 第一步：有持倉時檢查風控 ---
    if (position.side !== null) {
      // 檢查出場條件
      const exitCheck = this.checkExitConditions(cfg, position, currentPrice, ma200Value, cross);
      if (exitCheck.shouldExit) {
        return { action: 'close', reason: exitCheck.reason, price: currentPrice };
      }

      // 檢查加倉層止盈
      const layerTPCheck = this.checkLayerTP(cfg, position, currentPrice);
      if (layerTPCheck.shouldExit) {
        return { action: 'close', reason: layerTPCheck.reason, price: currentPrice };
      }

      // 檢查馬丁加倉
      const martinCheck = this.checkMartinTrigger(cfg, position, currentPrice, ma200Value);
      if (martinCheck.triggered) {
        const layerCfg = this.getLayerConfig(cfg, martinCheck.layerNum);
        const layerSize = this.calculateLayerSize(cfg, martinCheck.layerNum, currentPrice);
        const lotUsdt = layerSize * currentPrice;
        return {
          action: position.side === 'LONG' ? 'add_long' : 'add_short',
          reason: martinCheck.reason,
          price: currentPrice,
          lotUsdt,
          layerNum: martinCheck.layerNum,
        };
      }

      return { action: 'hold', reason: `持倉中(L${position.currentLayer})，無觸發條件`, price: currentPrice };
    }

    // --- 第二步：無持倉時檢查開倉 ---
    const entryOk = this.checkEntryCondition(cfg, currentPrice, ma200Value, ma200Slope, cross);
    if (entryOk) {
      const side = cross === 1 ? 'buy' : 'sell';
      return {
        action: side as 'buy' | 'sell',
        reason: `V7.0 ${cross === 1 ? '金叉' : '死叉'}開倉（MA200=${ma200Value?.toFixed(2)}，斜率=${ma200Slope.toFixed(4)}）`,
        price: currentPrice,
        lotUsdt: cfg.base_lot_size_usdt,
      };
    }

    return { action: 'hold', reason: '無入場信號', price: currentPrice };
  }
}

// Singleton export
export const strategyKama3kV70 = new StrategyKama3kV70();
