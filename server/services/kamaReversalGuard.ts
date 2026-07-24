/**
 * KAMA 反轉主動割肉（O2）與平倉分流（O3）純邏輯模組
 * 依據 Pasted_content_21.txt 第三、四節實作（用戶提供代碼邏輯原樣整合）
 *
 * O2：當馬丁層數 >= Kama_Reversal_Min_Layer（預設 3）且 KAMA 快慢線
 *     方向與入場方向相反時，立即市價全平 + 暫停策略 + 發送警報。
 * O3：平倉分流——
 *     分流 A：無馬丁（馬丁層數 == 0，即僅首單）且止盈退出且 KAMA 方向未變
 *             → 立即市價重入首單（原地重入，單邊行情無限套利）
 *     分流 B：有馬丁（馬丁層數 >= 1）→ 強制冷卻 K_Line_Period 分鐘
 *
 * 層數語義統一說明：
 *   文件的「層數」指馬丁加倉次數（首單 = 第 0 層）。
 *   系統 StrategyState.currentLayer 以 1 = 首單計，
 *   因此 馬丁層數 martinDepth = currentLayer - 1。
 */

import type { StrategyState } from "../services/martingaleEngine";

/** KAMA 反轉檢查結果 */
export interface KamaReversalResult {
  triggered: boolean;
  reason: string;
  /** 預估虧損（USDT，正值表示虧損） */
  estimatedLoss: number;
}

/**
 * O2：檢查 KAMA 反轉主動割肉（純函數，實盤與回測共用）
 * 條件 1：馬丁層數 >= minLayer（已有馬丁扛單）
 * 條件 2：當前 KAMA 方向 = kamaFast > kamaSlow
 * 條件 3：方向與入場方向相反
 */
export function checkKamaReversal(params: {
  /** 馬丁層數（首單 = 0，即已加倉次數） */
  martinDepth: number;
  /** 入場時的 KAMA 方向（true = 升勢） */
  entryTrendBull: boolean | undefined;
  /** 當前 KAMA 快線值 */
  currentKamaFast: number;
  /** 當前 KAMA 慢線值 */
  currentKamaSlow: number;
  /** 持倉均價 */
  avgPrice: number;
  /** 當前價格 */
  currentPrice: number;
  /** 總持倉數量 */
  totalSize: number;
  /** 持倉方向（true = 多） */
  isLong: boolean;
  /** 觸發最小馬丁層數（預設 3，0 = 停用） */
  minLayer?: number;
}): KamaReversalResult {
  const minLayer = params.minLayer ?? 3;

  // 0 = 停用此防禦
  if (minLayer <= 0) {
    return { triggered: false, reason: "KAMA 反轉割肉已停用", estimatedLoss: 0 };
  }

  // 條件 1：馬丁層數 >= minLayer（已有馬丁扛單）
  if (params.martinDepth < minLayer) {
    return { triggered: false, reason: `馬丁層數 ${params.martinDepth} < ${minLayer}，未達割肉門檻`, estimatedLoss: 0 };
  }

  // 入場方向未記錄（舊狀態相容）→ 無法判斷反轉，跳過
  if (params.entryTrendBull === undefined) {
    return { triggered: false, reason: "入場 KAMA 方向未記錄（舊狀態），跳過反轉檢查", estimatedLoss: 0 };
  }

  // 條件 2：計算當前 KAMA 方向
  const currentTrendBull = params.currentKamaFast > params.currentKamaSlow;

  // 條件 3：方向是否反轉（與入場方向相反）
  const hasReversed = params.entryTrendBull !== currentTrendBull;
  if (!hasReversed) {
    return { triggered: false, reason: "KAMA 方向未反轉", estimatedLoss: 0 };
  }

  // ✅ 觸發主動割肉
  const pnl = params.isLong
    ? (params.currentPrice - params.avgPrice) * params.totalSize
    : (params.avgPrice - params.currentPrice) * params.totalSize;
  const estimatedLoss = pnl < 0 ? Math.abs(pnl) : 0;

  return {
    triggered: true,
    reason:
      `KAMA 反轉主動割肉（O2）：入場方向 ${params.entryTrendBull ? "升" : "跌"} → ` +
      `目前方向 ${currentTrendBull ? "升" : "跌"}，馬丁層數 ${params.martinDepth}，` +
      `均價 ${params.avgPrice.toFixed(2)}，現價 ${params.currentPrice.toFixed(2)}，` +
      `預估虧損 ${estimatedLoss.toFixed(2)} USDT`,
    estimatedLoss,
  };
}

/** 平倉分流決策結果（O3） */
export interface CloseSplitDecision {
  /** 'reenter' = 分流 A 順勢重入；'cooldown' = 分流 B 強制冷卻；'none' = 不重入也不冷卻（首層止損等） */
  action: "reenter" | "cooldown" | "none";
  reason: string;
  /** 分流 B 的冷卻毫秒數（action === 'cooldown' 時有效） */
  cooldownMs: number;
}

/**
 * O3：平倉後的分流處理決策（純函數，實盤與回測共用）
 * 分流 A：馬丁層數 == 0 + 止盈退出 + KAMA 方向未變 → 立即重入
 * 分流 B：馬丁層數 >= 1 → 強制冷卻（等待下一組全新 3K 條件）
 */
export function decideCloseSplit(params: {
  /** 馬丁層數（首單 = 0） */
  martinDepth: number;
  /** 退出原因（'trailing_stop' | 'take_profit' | 'stop_loss' | ...） */
  exitReason: string;
  /** 入場時的 KAMA 方向 */
  entryTrendBull: boolean | undefined;
  /** 當前 KAMA 快線值 */
  currentKamaFast: number;
  /** 當前 KAMA 慢線值 */
  currentKamaSlow: number;
  /** K 線週期（分鐘），冷卻時間 = kLinePeriod 分鐘 × cooldownBars */
  kLinePeriod: number;
  /** 冷卻倍數（預設 2 根 K 線，與現有系統一致） */
  cooldownBars?: number;
  /** 是否啟用順勢重入（Reentry_On_Trend，預設 true） */
  reentryEnabled?: boolean;
}): CloseSplitDecision {
  const cooldownBars = params.cooldownBars ?? 2;
  const cooldownMs = params.kLinePeriod * 60 * 1000 * cooldownBars;

  // ============================================
  // 分流 B：有馬丁（層數 >= 1）→ 懲罰冷卻
  // ============================================
  if (params.martinDepth >= 1) {
    return {
      action: "cooldown",
      reason: `馬丁解套（第 ${params.martinDepth} 層馬丁）→ 強制冷卻 ${params.kLinePeriod * cooldownBars} 分鐘，等待新的 3K 形態`,
      cooldownMs,
    };
  }

  // ============================================
  // 分流 A：無馬丁（層數 == 0）→ 順勢重入
  // ============================================
  // 條件 0：啟用開關
  if (params.reentryEnabled === false) {
    return { action: "none", reason: "順勢重入未啟用（Reentry_On_Trend = false）", cooldownMs: 0 };
  }

  // 條件 1：退出原因是止盈相關（非止損）
  const isProfitExit = ["trailing_stop", "take_profit", "移動止盈"].includes(params.exitReason);
  if (!isProfitExit) {
    return { action: "none", reason: `退出原因為 ${params.exitReason}，不執行重入`, cooldownMs: 0 };
  }

  // 條件 2：KAMA 方向未變
  if (params.entryTrendBull === undefined) {
    return { action: "none", reason: "入場 KAMA 方向未記錄，不執行重入", cooldownMs: 0 };
  }
  const currentTrendBull = params.currentKamaFast > params.currentKamaSlow;
  if (currentTrendBull !== params.entryTrendBull) {
    return { action: "none", reason: "KAMA 方向已反轉，不執行重入", cooldownMs: 0 };
  }

  // ✅ 執行順勢重入
  return {
    action: "reenter",
    reason: `第 0 層順勢重入（O3）：止盈退出且 KAMA 方向未變（${currentTrendBull ? "升" : "跌"}），立即市價重入首單`,
    cooldownMs: 0,
  };
}

/**
 * O3：重入後的狀態重置（新一輪開始，保留入場方向）
 */
export function buildReentryState(params: {
  currentPrice: number;
  lotSize: number;
    entryTrendBull: boolean;
    isLong: boolean;
    barTimestamp?: number;
    capital: number; // Initial capital for the strategy
  }): StrategyState {
    return {
      currentLayer: 1, // 首單（系統語義：1 = 首單，對應文件的第 0 層）
      totalSize: params.lotSize,
      avgPrice: params.currentPrice,
      totalCost: params.currentPrice * params.lotSize,
      lastLayerPrice: params.currentPrice,
      capital: params.capital - (params.lotSize * params.currentPrice), // Deduct initial order cost
      isLong: params.isLong,
      highestPrice: params.currentPrice,
      lowestPrice: params.currentPrice, // Initialize lowestPrice for short positions
      isTrailingActivated: false,
      isCooldown: false,
      cooldownUntil: 0,
      lockedBarTimestamp: params.barTimestamp ?? 0,
      entryTrendBull: params.entryTrendBull,
      hasTriggeredKamaReversal: false,
    };
  }
