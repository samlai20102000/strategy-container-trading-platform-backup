/**
 * 移動止盈追蹤管理器 - V3.5
 * 依據 Pasted_content_17.txt B.2.5 實作
 *
 * 邏輯：
 * 1. 激活條件：盈利 >= Target_TP_Pct%（基於保證金的盈虧%，即價格變動% × 槓桿）→ isTrailingActivated = true
 * 2. 追蹤：多頭記錄最高價 highestPrice，空頭記錄最低價（同欄位儲存最優價）
 * 3. 平倉條件：價格從最優價回撤 >= Callback_Pct% → 全平（獲利落袋）
 */

import type { StrategyState } from "../strategies/base";

export interface TrailingStopConfig {
  /** 止盈激活百分比（如 1.0 表示保證金盈虧 1% 激活） */
  targetTpPct: number;
  /** 回撤平倉百分比（如 0.2 表示從最優價回撤 0.2% 平倉） */
  callbackPct: number;
  /** 槓桿倍數（用於將價格變動%轉為保證金盈虧%） */
  leverage?: number;
}

export interface TrailingStopResult {
  /** 是否觸發平倉 */
  shouldClose: boolean;
  /** 更新後的狀態 */
  newState: StrategyState;
  reason: string;
}

/**
 * 每次價格更新時調用，更新追蹤狀態並判斷是否平倉
 * profitPct = 價格變動% × leverage（基於保證金的盈虧%，與 OKX 顯示一致）
 */
export function updateTrailingStop(
  state: StrategyState,
  currentPrice: number,
  config: TrailingStopConfig,
): TrailingStopResult {
  if (state.totalSize <= 0 || state.avgPrice <= 0 || currentPrice <= 0) {
    return { shouldClose: false, newState: state, reason: "無持倉" };
  }

  const newState = { ...state };
  const isLong = state.isLong;
  const leverage = config.leverage && config.leverage > 0 ? config.leverage : 1;

  // 當前盈利百分比（基於保證金 = 價格變動% × 槓桿）
  const rawPricePct = isLong
    ? ((currentPrice - state.avgPrice) / state.avgPrice) * 100
    : ((state.avgPrice - currentPrice) / state.avgPrice) * 100;
  const profitPct = rawPricePct * leverage;

  // 1. 未激活 → 檢查激活條件
  if (!state.isTrailingActivated) {
    if (profitPct >= config.targetTpPct) {
      newState.isTrailingActivated = true;
      newState.highestPrice = currentPrice;
      return {
        shouldClose: false,
        newState,
        reason: `移動止盈已激活（盈利 ${profitPct.toFixed(2)}% >= ${config.targetTpPct}%，價格變動 ${rawPricePct.toFixed(3)}% × ${leverage}x），開始追蹤最優價 ${currentPrice}`,
      };
    }
    return { shouldClose: false, newState, reason: `未達激活條件（盈利 ${profitPct.toFixed(2)}% < ${config.targetTpPct}%，價格變動 ${rawPricePct.toFixed(3)}% × ${leverage}x）` };
  }

  // 2. 已激活 → 更新最優價
  const best = state.highestPrice;
  const isBetter = isLong ? currentPrice > best : currentPrice < best;
  if (isBetter) {
    newState.highestPrice = currentPrice;
    return {
      shouldClose: false,
      newState,
      reason: `更新最優價 ${best} → ${currentPrice}`,
    };
  }

  // 3. 檢查回撤（回撤也基於保證金%）
  const rawRetracementPct = isLong
    ? ((best - currentPrice) / best) * 100
    : ((currentPrice - best) / best) * 100;
  const retracementPct = rawRetracementPct * leverage;

  if (retracementPct >= config.callbackPct) {
    return {
      shouldClose: true,
      newState,
      reason: `移動止盈觸發：從最優價 ${best} 回撤 ${retracementPct.toFixed(3)}% >= ${config.callbackPct}%（當前 ${currentPrice}，鎖定盈利 ${profitPct.toFixed(2)}%）`,
    };
  }

  return {
    shouldClose: false,
    newState,
    reason: `追蹤中（回撤 ${retracementPct.toFixed(3)}% < ${config.callbackPct}%）`,
  };
}
