import { Strategy } from "../../drizzle/schema";
import { ExchangeAdapter } from "../exchanges/types";
import type { V4Config, StrategyState } from "./martingaleEngine";
import { getFirstOrderValue } from "./martingaleEngine";
import { createTrade } from "../db";
import { saveStrategyState } from "./strategyStateManager";
import { resolveTradeFill, tradeFillRecordFields } from "./tradeFillTruth";

/**
 * V4.0: 計算首單開倉數量 (BTC)
 * 根據 Initial_Capital 和 First_Order_Pct 計算出首單價值，再除以當前價格得到數量。
 */
export function calculateInitialOrderSize(currentPrice: number, config: V4Config): number {
  const firstOrderValue = getFirstOrderValue(config);
  return firstOrderValue / currentPrice;
}

/**
 * V4.0: 建立初始策略狀態
 * @param currentPrice 當前價格
 * @param isLong 是否為多頭策略
 * @param config V4.0 配置
 * @param barTimestamp K線時間戳 (可選)
 * @returns 初始策略狀態
 */
export function createInitialStrategyState(
  currentPrice: number,
  isLong: boolean,
  config: V4Config,
  barTimestamp?: number,
): StrategyState {
  const lotSize = calculateInitialOrderSize(currentPrice, config);
  const totalCost = lotSize * currentPrice;

  return {
    currentLayer: 1, // 首單 (系統語義: 1 = 首單, 對應文件的第 0 層)
    totalSize: lotSize,
    avgPrice: currentPrice,
    totalCost: totalCost,
    lastLayerPrice: currentPrice,
    capital: config.Initial_Capital - totalCost, // 扣除首單成本
    isLong: isLong,
    highestPrice: currentPrice,
    lowestPrice: currentPrice,
    isTrailingActivated: false,
    isCooldown: false,
    cooldownUntil: 0,
    lockedBarTimestamp: barTimestamp ?? 0,
    entryTrendBull: undefined, // 初始狀態不確定 KAMA 方向
    hasTriggeredKamaReversal: false,
  };
}

/**
 * 執行 V4.0 策略的首單開倉
 * @param strategy 策略配置
 * @param adapter 交易所適配器
 * @param currentPrice 當前市場價格
 * @param isLong 是否為多頭方向
 * @param cfg V4.0 配置
 * @returns 成功開倉後的 StrategyState，如果失敗則返回 null
 */
export async function placeInitialOrder(
  strategy: Strategy,
  adapter: ExchangeAdapter,
  currentPrice: number,
  isLong: boolean,
  cfg: V4Config,
): Promise<StrategyState | null> {
  try {
    const lotSize = calculateInitialOrderSize(currentPrice, cfg);

    const orderResult = await adapter.placeOrder({
      symbol: strategy.symbol,
      side: isLong ? "buy" : "sell",
      orderType: "market",
      size: lotSize,
      leverage: strategy.leverage,
    });

    await createTrade({
      strategyId: strategy.id,
      userId: strategy.userId,
      exchange: strategy.exchange,
      symbol: strategy.symbol,
      side: isLong ? "buy" : "sell",
      orderType: "market",
      orderId: orderResult.orderId,
      ...tradeFillRecordFields(orderResult, currentPrice, lotSize),
      status: orderResult.success ? "filled" : "failed",
      triggerSource: "initial_entry",
    });

    if (!orderResult.success) {
      console.error(`[PositionManager] 首單開倉失敗：${orderResult.errorMessage}`);
      return null;
    }

    // 🔥 方案 A：優先使用實際成交數據建立初始狀態
    const resolvedFill = resolveTradeFill(orderResult, currentPrice, lotSize);
    const actualPrice = resolvedFill.price ?? currentPrice;
    const actualSize = resolvedFill.size;
    const actualCost = actualSize * actualPrice;

    const newState: StrategyState = {
      ...createInitialStrategyState(currentPrice, isLong, cfg),
      totalSize: actualSize,
      avgPrice: actualPrice,
      totalCost: actualCost,
      lastLayerPrice: actualPrice,
      capital: cfg.Initial_Capital - actualCost,
    };

    await saveStrategyState(strategy.id, newState);
    console.log(
      `[PositionManager] 首單開倉成功：策略 ${strategy.id} ${isLong ? "買升" : "買跌"} ${actualSize} @ ${actualPrice}${orderResult.filledPrice ? ' (實際成交)' : ' (理論價)'}`,
    );
    return newState;
  } catch (e: unknown) {
    console.error("[PositionManager] 首單開倉異常:", e instanceof Error ? e.message : e);
    return null;
  }
}
