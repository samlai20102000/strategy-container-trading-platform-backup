/**
 * 策略基底類別與型別定義（策略工作室）
 * 依據用戶提供文件中的 BaseStrategy 設計實作
 */

/** 進入策略的訊號 */
export interface StrategySignal {
  /** BUY / SELL / CLOSE（大寫標準化） */
  action: "BUY" | "SELL" | "CLOSE" | "NONE";
  symbol: string;
  price: number;
  /** K 線時間戳（V3.5 Bar-Lock 用，毫秒） */
  barTimestamp?: number;
  /** 原始 payload（策略可讀取額外欄位） */
  raw?: Record<string, unknown>;
}

/** 策略實例配置（DB strategies 表的簡化視圖 + 用戶自訂參數） */
export interface StrategyInstanceConfig {
  id: number;
  symbol: string;
  direction: "long" | "short" | "both";
  positionSize: number;
  leverage: number;
  /** 策略自訂參數（合併 defaultConfig） */
  config: Record<string, number | string | boolean>;
  /** V3.5 完整策略狀態（可選，由執行器注入） */
  state?: StrategyState;
}

/** 市場資料（由執行器提供，可能為 null 表示無法取得） */
export interface KLineData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketData {
  candles: KLineData[];
  lastPrice: number;
  /** EMA 值映射，例如 { ema30: 65000, ema60: 64500 } */
  ema?: Record<string, number>;
  /** ATR 值 */
  atr?: number;
  /** V3.5：KAMA 快線值（由 TradingView payload 或本地計算提供） */
  kamaFast?: number;
  /** V3.5：KAMA 慢線值 */
  kamaSlow?: number;
  /** V3.5：單線 KAMA 值（價格 vs KAMA 方向鎖） */
  kamaValue?: number;
  /** V3.5：3K 形態資料（K1/K2 前兩根 K 線） */
  k1High?: number;
  k1Low?: number;
  k2High?: number;
  k2Low?: number;
  k1Bull?: boolean;
  k2Bull?: boolean;
  k1Bear?: boolean;
  k2Bear?: boolean;
}

/** 馬丁狀態 */
export interface MartinState {
  lossCount: number;
  currentLot: number;
  lastEntryPrice: number;
}

/** V3.5 完整策略狀態（馬丁層數、移動止盈、冷卻、Bar-Lock） */
import type { MartinLayer, StrategyState } from "../services/martingaleEngine";

export type { StrategyState } from "../services/martingaleEngine";

/** 建立初始 V3.5 策略狀態 */
export function createInitialStrategyState(): StrategyState {
  return {
    currentLayer: 0,
    totalSize: 0,
    avgPrice: 0,
    totalCost: 0,
    lastLayerPrice: 0,
    capital: 0,
    highestPrice: 0,
    lowestPrice: 0,
    isLong: true,
    isTrailingActivated: false,
    isCooldown: false,
    cooldownUntil: 0,
    lockedBarTimestamp: 0,
    entryTrendBull: undefined,
    hasTriggeredKamaReversal: false,
  };
}

/** 信號驗證結果 */
export interface StrategyValidationResult {
  valid: boolean;
  reason?: string;
}

/** 策略決策動作 */
export interface StrategyAction {
  action: "OPEN_LONG" | "OPEN_SHORT" | "CLOSE_ALL" | "HOLD";
  lotSize: number;
  stopLoss?: number;
  takeProfit?: number;
  reason?: string;
  price?: number; // Add price to StrategyAction
}

/**
 * 策略基底抽象類別
 * 自訂策略必須繼承並實作 generateActions
 */
export abstract class BaseStrategy {
  /** 策略唯一 key（如 strategy_20415） */
  abstract readonly key: string;
  /** 策略顯示名稱 */
  abstract readonly name: string;
  /** 預設參數 */
  abstract readonly defaultConfig: Record<string, any>;
  /** 是否為內建策略（內建策略受保護，禁止覆蓋與刪除） */
  readonly isBuiltIn: boolean = false;

  /**
   * 核心決策方法：根據訊號、實例配置、市場資料與馬丁狀態產生交易動作
   */
  abstract generateActions(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    martinState: MartinState,
  ): StrategyAction;

  /** 合併預設參數與實例參數 */
  protected mergeConfig(
    instance: StrategyInstanceConfig,
  ): Record<string, number | string | boolean | MartinLayer[]> {
    return { ...this.defaultConfig, ...instance.config };
  }

  /**
   * 馬丁倉位計算：currentLot = initialLot * multiplier^lossCount
   * 層數達上限後不再加倍
   */
  protected calcMartinLot(
    initialLot: number,
    multiplier: number,
    lossCount: number,
    maxLevel: number,
  ): number {
    const level = Math.min(lossCount, Math.max(0, maxLevel - 1));
    const lot = initialLot * Math.pow(multiplier, level);
    return Math.round(lot * 1e8) / 1e8;
  }

  /** 計算持倉均價 */
  protected calcAvgPrice(totalCost: number, totalSize: number): number {
    if (totalSize === 0) return 0;
    return totalCost / totalSize;
  }
}

/**
 * V3.5 進階策略基底類別
 * 支持非同步信號驗證（KAMA 方向鎖、3K 形態、破位、冷卻、Bar-Lock）
 * 與完整策略狀態（StrategyState）
 */
export abstract class BaseStrategyV35 extends BaseStrategy {
  /** 版本號 */
  abstract readonly version: string;

  /**
   * 驗證信號的有效性（V3.5 五層檢查）
   */
  abstract validateSignal(
    signal: StrategySignal,
    marketData: MarketData,
    instance: StrategyInstanceConfig,
  ): Promise<StrategyValidationResult>;

  /**
   * V3.5 非同步決策（使用完整 StrategyState）
   */
  abstract generateActionsV35(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    state: StrategyState,
  ): Promise<StrategyAction>;
}
