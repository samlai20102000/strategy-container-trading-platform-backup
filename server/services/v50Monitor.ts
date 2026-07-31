/**
 * V5.0 實盤監控器（v50Monitor）
 *
 * 針對綁定 V5.0 策略（KAMA_3K_ULTIMATE_V50）的啟用策略，每輪檢查：
 * 1. F1 市場制度判斷（ADX 驅動）→ 動態覆蓋馬丁參數
 * 2. F2 部分獲利（層數≥4/6/8 時分批平倉）
 * 3. F3 ATR 動態止盈（移動止盈追蹤）
 * 4. 硬止損 + 極限止損
 * 5. 馬丁加倉（制度覆蓋間距/乘數）
 * 6. F4 時間濾網（僅影響新開倉）
 *
 * 與 v35Monitor 完全獨立，不修改任何 V3.5 邏輯。
 */

import {
  listEnabledStrategies,
  getApiKeyById,
  disableStrategySystem,
  updateStrategy,
  createSignal,
} from "../db";
import { recordExistingTradeExecution as createTrade } from "./tradeExecutionLedger";
import { createAdapter } from "../exchanges/factory";
import { createRuntimeGuardedAdapter } from "../exchanges/runtimeGuardedAdapter";
import type { ExchangeAdapter, OrderResult } from "../exchanges/types";
import {
  getRegimeMartinParams,
  getRegimeStepPct,
  getRegimeMultiplier,
  calculateDynamicTP,
  calculatePartialTPRatio,
  type MarketRegime,
} from "./indicators";
import { loadStrategyState, saveStrategyState } from "./strategyStateManager";
import { notifyOwner } from "./notifier";
import { resolveTradeFill, tradeFillRecordFields } from "./tradeFillTruth";

const V50_KEY = "KAMA_3K_ULTIMATE_V50";
const CHECK_INTERVAL_MS = 20_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

// ============================================================
// 主監控循環
// ============================================================

export function startV50Monitor(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runV50Check();
  }, CHECK_INTERVAL_MS);
  console.log(`[V50Monitor] V5.0 監控已啟動（每 ${CHECK_INTERVAL_MS / 1000} 秒檢查）`);
}

export function stopV50Monitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("[V50Monitor] 已停止");
  }
}

export async function runV50Check(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const enabled = await listEnabledStrategies();
    const v50Strategies = enabled.filter((s: any) => s.strategyKey === V50_KEY);
    for (const strategy of v50Strategies) {
      try {
        await checkV50Strategy(strategy as any);
      } catch (e: unknown) {
        console.error(`[V50Monitor] 策略 ${(strategy as any).id} 檢查失敗:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e: unknown) {
    console.error("[V50Monitor] 監控循環失敗:", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

export async function checkV50Strategy(strategy: any): Promise<void> {
  const state = loadStrategyState(strategy);
  if (state.totalSize <= 0 || state.avgPrice <= 0) return; // 無持倉

  const apiKeyRecord = await getApiKeyById(strategy.apiKeyId);
  if (!apiKeyRecord) return;

  let adapter: ExchangeAdapter;
  try {
    adapter = createAdapter(apiKeyRecord);
  } catch {
    return;
  }
  adapter = createRuntimeGuardedAdapter(adapter, {
    strategy,
    source: "AUTO",
    eventKey: `v50-monitor:${strategy.id}:${Math.floor(Date.now() / CHECK_INTERVAL_MS)}`,
    reason: "V50 monitor maintenance",
  });

  // 取得當前標記價和交易所真實持倉
  // 🔒 關鍵修復：必須匹配策略方向（isLong），避免同一帳戶同一 symbol 下多個策略互相污染
  let currentPrice = 0;
  let exchangeSize = 0;
  let exchangeEntryPrice = 0;
  let exchangeSide: "long" | "short" = "long";
  let exchangeUnrealizedPnl = 0;
  try {
    const positions = await adapter.getPositions(strategy.symbol);
    // 優先匹配與本地策略方向一致的持倉
    const expectedSide = state.isLong ? "long" : "short";
    let pos = positions.find((p: any) => p.size > 0 && p.side === expectedSide);
    if (!pos) {
      // 如果找不到匹配方向的持倉，可能已被平倉，使用任意持倉獲取價格但不同步數量
      pos = positions.find((p: any) => p.size > 0);
      if (!pos || pos.markPrice <= 0) return;
      // 只用於獲取當前價格，不同步數量/方向
      currentPrice = pos.markPrice;
      // 不同步 exchangeSize，保持本地 state 不變
      exchangeSize = 0;
    } else {
      currentPrice = pos.markPrice;
      exchangeSize = pos.size;
      exchangeEntryPrice = pos.entryPrice;
      exchangeSide = pos.side;
      exchangeUnrealizedPnl = pos.unrealizedPnl;
    }
  } catch {
    return;
  }

  const v50Config = (strategy.martinState as any)?.__v50Config ?? {};
  // 優先使用交易所真實數據（只在方向匹配時），本地 state 作為 fallback
  const avgPrice = (exchangeSize > 0 && exchangeEntryPrice > 0) ? exchangeEntryPrice : state.avgPrice;
  const isLong = exchangeSize > 0 ? exchangeSide === "long" : state.isLong;
  const totalSize = exchangeSize > 0 ? exchangeSize : state.totalSize;
  const currentLayer = state.currentLayer;
  const capital = Number(v50Config.Initial_Capital) || 10000;

  // 同步本地 state（只在方向匹配且數據不一致時）
  if (exchangeSize > 0 && (Math.abs(totalSize - state.totalSize) > 0.000001 || Math.abs(avgPrice - state.avgPrice) > 0.01)) {
    console.log(`[V50Monitor] 策略 ${strategy.id} 持倉同步：本地(size=${state.totalSize}, avg=${state.avgPrice}, isLong=${state.isLong}) → 交易所(size=${totalSize}, avg=${avgPrice}, side=${exchangeSide})`);
    const syncedState = { ...state, totalSize, avgPrice };
    await saveStrategyState(strategy.id, syncedState);
  }

  // 計算浮動盈虧百分比
  const pnlPct = isLong
    ? ((currentPrice - avgPrice) / avgPrice) * 100
    : ((avgPrice - currentPrice) / avgPrice) * 100;

  // 計算浮虧佔本金百分比（優先使用交易所的 unrealizedPnl）
  let unrealizedLoss = 0;
  if (exchangeUnrealizedPnl < 0) {
    // 交易所直接返回的未實現虧損（負數表示虧損）
    unrealizedLoss = Math.abs(exchangeUnrealizedPnl);
  } else if (exchangeUnrealizedPnl === 0) {
    // fallback：手動計算
    unrealizedLoss = isLong
      ? Math.max(0, (avgPrice - currentPrice) * totalSize)
      : Math.max(0, (currentPrice - avgPrice) * totalSize);
  }
  // 如果 exchangeUnrealizedPnl > 0 表示盈利，unrealizedLoss = 0
  const unrealizedLossPct = capital > 0 ? (unrealizedLoss / capital) * 100 : 0;

  // === 1. 硬止損 ===
  const maxLossPct = Number(v50Config.Max_Loss_Pct) || 6.0;
  if (unrealizedLossPct >= maxLossPct) {
    console.log(`[V50Monitor] 策略 ${strategy.id} 觸發硬止損 (${unrealizedLossPct.toFixed(2)}% >= ${maxLossPct}%) | 詳情: size=${totalSize}, avgPrice=${avgPrice}, markPrice=${currentPrice}, isLong=${isLong}, unrealizedLoss=${unrealizedLoss.toFixed(4)}, capital=${capital}, exchangePnl=${exchangeUnrealizedPnl}`);
    await closeAndDisable(strategy, adapter, currentPrice, `V5.0 硬止損 (浮虧 ${unrealizedLossPct.toFixed(2)}% 佔本金)`);
    return;
  }

  // === 2. 極限止損 ===
  const maxDrawdownPct = Number(v50Config.Max_Drawdown_Pct) || 10;
  if (unrealizedLossPct >= maxDrawdownPct) {
    console.log(`[V50Monitor] 策略 ${strategy.id} 觸發極限止損 (${unrealizedLossPct.toFixed(2)}%)`);
    await closeAndDisable(strategy, adapter, currentPrice, `V5.0 極限止損 (浮虧 ${unrealizedLossPct.toFixed(2)}%)`);
    return;
  }

  // === 3. F2 部分獲利 ===
  if (v50Config.enable_partial_tp && pnlPct > 0) {
    const martinState = strategy.martinState ?? {};
    const alreadyPartialClosed: number[] = martinState.__partialClosedLayers ?? [];
    const ratio = calculatePartialTPRatio(currentLayer, pnlPct, {
      enable_partial_tp: true,
      partial_tp_layer_4: Number(v50Config.partial_tp_layer_4) || 0.3,
      partial_tp_layer_6: Number(v50Config.partial_tp_layer_6) || 0.3,
      partial_tp_layer_8: Number(v50Config.partial_tp_layer_8) || 0.2,
      partial_tp_trigger_pct: Number(v50Config.partial_tp_trigger_pct) || 0.5,
    }, alreadyPartialClosed);

    if (ratio > 0) {
      const closeSize = totalSize * ratio;
      console.log(`[V50Monitor] 策略 ${strategy.id} F2 部分獲利：平倉 ${(ratio * 100).toFixed(0)}%`);
      await partialClose(strategy, adapter, closeSize, currentLayer);
      return;
    }
  }

  // === 4. F3 ATR 動態止盈（移動止盈追蹤）===
  const targetTpPct = v50Config.enable_dynamic_tp
    ? calculateDynamicTP((strategy.martinState as any)?.__lastATR ?? null, currentPrice, {
        tp_min_pct: Number(v50Config.tp_min_pct) || 0.8,
        tp_atr_multiplier: Number(v50Config.tp_atr_multiplier) || 2.5,
      })
    : (Number(v50Config.Target_TP_Pct) || 1.0);

  const callbackPct = Number(v50Config.Callback_Pct) || 0.1;

  // 移動止盈邏輯
  if (pnlPct >= targetTpPct && !state.isTrailingActivated) {
    // 激活追蹤
    const newState = { ...state, isTrailingActivated: true, highestPrice: currentPrice, lowestPrice: currentPrice };
    await saveStrategyState(strategy.id, newState);
    return;
  }

  if (state.isTrailingActivated) {
    let newHigh = state.highestPrice || currentPrice;
    let newLow = state.lowestPrice || currentPrice;
    if (isLong && currentPrice > newHigh) newHigh = currentPrice;
    if (!isLong && currentPrice < newLow) newLow = currentPrice;

    const peakPnlPct = isLong
      ? ((newHigh - avgPrice) / avgPrice) * 100
      : ((avgPrice - newLow) / avgPrice) * 100;
    const drawback = peakPnlPct - pnlPct;

    if (drawback >= callbackPct) {
      console.log(`[V50Monitor] 策略 ${strategy.id} 移動止盈觸發 (回撤 ${drawback.toFixed(3)}%)`);
      await closePosition(strategy, adapter, currentPrice, `V5.0 移動止盈 (峰值 ${peakPnlPct.toFixed(2)}%, 回撤 ${drawback.toFixed(3)}%)`);
      return;
    }

    // 更新最優價
    if (newHigh !== state.highestPrice || newLow !== state.lowestPrice) {
      const newState = { ...state, highestPrice: newHigh, lowestPrice: newLow };
      await saveStrategyState(strategy.id, newState);
    }
  }

  // === 5. 馬丁加倉（F1 制度覆蓋）===
  if (pnlPct < 0 && currentLayer > 0) {
    const regime: MarketRegime = (strategy.martinState as any)?.__currentRegime ?? "weak_trend";
    const override = getRegimeMartinParams(regime);
    const maxLayers = override.maxLayers;

    if (currentLayer < maxLayers) {
      const stepPct = getRegimeStepPct(currentLayer + 1, override);
      const lastLayerPrice = state.lastLayerPrice || avgPrice;
      const deviation = isLong
        ? ((lastLayerPrice - currentPrice) / lastLayerPrice) * 100
        : ((currentPrice - lastLayerPrice) / lastLayerPrice) * 100;

      if (deviation >= stepPct) {
        console.log(`[V50Monitor] 策略 ${strategy.id} 馬丁加倉條件滿足 (偏離 ${deviation.toFixed(2)}% >= ${stepPct}%, 制度=${regime}, 層=${currentLayer + 1})`);
        // 加倉邏輯由 autoTradeSignalGenerator 觸發
      }
    }
  }
}

// ============================================================
// 輔助方法
// ============================================================

async function closeAndDisable(strategy: any, adapter: ExchangeAdapter, price: number, reason: string): Promise<void> {
  try {
    const state = loadStrategyState(strategy);

    let exitPrice = 0;
    let pnl: number | undefined;
    let orderId: string | undefined;
    let exchangeCloseResult: OrderResult | undefined;

    if (state.totalSize > 0) {
      // 使用 adapter.closePosition 平倉（平台級別通用，自動處理 posMode/posSide）
      const result = await adapter.closePositionSmart(strategy.symbol);
      exchangeCloseResult = result;
      if (!result.success) {
        console.error(`[V50Monitor] closeAndDisable 平倉失敗:`, result.errorMessage, result.rawResponse);
      } else {
        exitPrice = result.filledPrice || price;
        orderId = result.orderId;
        const dirMult = state.isLong ? 1 : -1;
        if (exitPrice > 0 && state.avgPrice > 0 && state.totalSize > 0) {
          pnl = (exitPrice - state.avgPrice) * state.totalSize * dirMult;
        }
      }
    }

    if (!exchangeCloseResult?.success) {
      await notifyOwner(
        `V5.0 風控平倉失敗 - 策略 ${strategy.name || strategy.id}`,
        `原因：${reason}\n交易所尚未確認平倉；本地持倉與策略啟用狀態保持不變，下一輪將重試。`,
      );
      return;
    }

    await disableStrategySystem(strategy.id, reason);

    // 寫入訊號日誌
    const pnlStr = pnl !== undefined ? ` | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT` : "";
    let signalId: number | undefined;
    try {
      signalId = await createSignal({
        strategyId: strategy.id,
        userId: strategy.userId,
        rawPayload: JSON.stringify({
          action: "close_and_disable",
          symbol: strategy.symbol,
          reason,
          price,
          source: "v50_monitor",
        }),
        parsedAction: "close",
        parsedSymbol: strategy.symbol,
        parsedPrice: exitPrice > 0 ? String(exitPrice) : String(price),
        status: "executed",
        orderId,
        message: `[V5.0 Monitor] ${strategy.symbol} 止損平倉並停用：${reason}${pnlStr}`,
        source: "auto",
      });
    } catch (e) {
      console.error(`[V50Monitor] closeAndDisable 寫入訊號日誌失敗`, e);
    }

    // 寫入交易記錄
    if (exitPrice > 0 && state.totalSize > 0) {
      try {
        await createTrade({
          strategyId: strategy.id,
          userId: strategy.userId,
          signalId,
          exchange: strategy.exchange,
          symbol: strategy.symbol,
          side: state.isLong ? "sell" : "buy",
          orderType: "market",
          orderId,
          ...tradeFillRecordFields(exchangeCloseResult, price, state.totalSize),
          realizedPnl: pnl !== undefined ? String(pnl.toFixed(6)) : undefined,
          reduceOnly: true,
          status: "filled",
          triggerSource: "v50_monitor_close_disable",
        });
      } catch (e) {
        console.error(`[V50Monitor] closeAndDisable 寫入交易記錄失敗`, e);
      }
    }

    await notifyOwner(
      `🛑 V5.0 策略 ${strategy.name || strategy.id} 已停用`,
      `原因：${reason}\n品種：${strategy.symbol}\n浮虧觸發風控`,
    );
  } catch (err: any) {
    console.error(`[V50Monitor] closeAndDisable 失敗:`, err?.message);
  }
}

async function closePosition(strategy: any, adapter: ExchangeAdapter, price: number, reason: string): Promise<void> {
  try {
    const state = loadStrategyState(strategy);

    let exitPrice = 0;
    let pnl: number | undefined;
    let orderId: string | undefined;
    let exchangeCloseResult: OrderResult | undefined;

    if (state.totalSize > 0) {
      // 使用 adapter.closePosition 平倉（平台級別通用，自動處理 posMode/posSide）
      const result = await adapter.closePositionSmart(strategy.symbol);
      exchangeCloseResult = result;
      if (!result.success) {
        console.error(`[V50Monitor] closePosition 平倉失敗:`, result.errorMessage, result.rawResponse);
      } else {
        exitPrice = result.filledPrice || price;
        orderId = result.orderId;
        const dirMult = state.isLong ? 1 : -1;
        if (exitPrice > 0 && state.avgPrice > 0 && state.totalSize > 0) {
          pnl = (exitPrice - state.avgPrice) * state.totalSize * dirMult;
        }
      }
    }

    if (!exchangeCloseResult?.success) {
      await notifyOwner(
        `V5.0 平倉失敗 - 策略 ${strategy.name || strategy.id}`,
        `原因：${reason}\n交易所尚未確認平倉；本地馬丁狀態保持不變，下一輪將重試。`,
      );
      return;
    }

    // 重置馬丁狀態（保留 v50Config）
    const martinState = strategy.martinState ?? {};
    const kLinePeriod = Number(martinState.__v50Config?.K_Line_Period) || 15;
    await updateStrategy(strategy.id, strategy.userId, {
      martinState: {
        lossCount: 0,
        currentLot: 0,
        lastEntryPrice: 0,
        currentLayer: 0,
        totalSize: 0,
        avgPrice: 0,
        isLong: true,
        isTrailingActivated: false,
        isCooldown: true,
        cooldownUntil: Date.now() + kLinePeriod * 60000 * 2,
        __v50Config: martinState.__v50Config,
      },
    });

    // 寫入訊號日誌
    const pnlStr = pnl !== undefined ? ` | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT` : "";
    let signalId: number | undefined;
    try {
      signalId = await createSignal({
        strategyId: strategy.id,
        userId: strategy.userId,
        rawPayload: JSON.stringify({
          action: "close",
          symbol: strategy.symbol,
          reason,
          price,
          source: "v50_monitor",
        }),
        parsedAction: "close",
        parsedSymbol: strategy.symbol,
        parsedPrice: exitPrice > 0 ? String(exitPrice) : String(price),
        status: "executed",
        orderId,
        message: `[V5.0 Monitor] ${strategy.symbol} 平倉：${reason}${pnlStr}`,
        source: "auto",
      });
    } catch (e) {
      console.error(`[V50Monitor] closePosition 寫入訊號日誌失敗`, e);
    }

    // 寫入交易記錄
    if (exitPrice > 0 && state.totalSize > 0) {
      try {
        await createTrade({
          strategyId: strategy.id,
          userId: strategy.userId,
          signalId,
          exchange: strategy.exchange,
          symbol: strategy.symbol,
          side: state.isLong ? "sell" : "buy",
          orderType: "market",
          orderId,
          ...tradeFillRecordFields(exchangeCloseResult, price, state.totalSize),
          realizedPnl: pnl !== undefined ? String(pnl.toFixed(6)) : undefined,
          reduceOnly: true,
          status: "filled",
          triggerSource: "v50_monitor_close",
        });
      } catch (e) {
        console.error(`[V50Monitor] closePosition 寫入交易記錄失敗`, e);
      }
    }

    console.log(`[V50Monitor] 策略 ${strategy.id} 已平倉: ${reason}`);
  } catch (err: any) {
    console.error(`[V50Monitor] closePosition 失敗:`, err?.message);
  }
}

async function partialClose(strategy: any, adapter: ExchangeAdapter, closeSize: number, triggerLayer: number): Promise<void> {
  try {
    const state = loadStrategyState(strategy);
    const side = state.isLong ? "sell" : "buy";
    // 部分平倉仍用 placeOrder（需要指定精確數量），但傳遞正確的 posSide
    const posSide: "long" | "short" = state.isLong ? "long" : "short";

    const orderResult = await adapter.placeOrder({
      symbol: strategy.symbol,
      side,
      orderType: "market",
      size: closeSize,
      reduceOnly: true,
      posSide,
    });

    if (!orderResult.success) {
      console.error(`[V50Monitor] partialClose 下單失敗:`, orderResult.errorMessage, orderResult.rawResponse);
      return;
    }

    const resolvedFill = resolveTradeFill(orderResult, undefined, closeSize);
    const actualCloseSize = Math.min(state.totalSize, resolvedFill.size);
    const actualClosePrice = resolvedFill.price;

    // 更新狀態
    const martinState = strategy.martinState ?? {};
    const alreadyClosed: number[] = martinState.__partialClosedLayers ?? [];
    alreadyClosed.push(triggerLayer);

    const newTotalSize = Math.max(0, state.totalSize - actualCloseSize);
    await updateStrategy(strategy.id, strategy.userId, {
      martinState: {
        ...martinState,
        totalSize: newTotalSize,
        __partialClosedLayers: alreadyClosed,
      },
    });

    // 寫入訊號日誌
    let signalId: number | undefined;
    try {
      signalId = await createSignal({
        strategyId: strategy.id,
        userId: strategy.userId,
        rawPayload: JSON.stringify({
          action: "partial_close",
          symbol: strategy.symbol,
          requestedCloseSize: closeSize,
          actualCloseSize,
          actualClosePrice,
          triggerLayer,
          remainingSize: newTotalSize,
          source: "v50_monitor",
        }),
        parsedAction: "close",
        parsedSymbol: strategy.symbol,
        parsedPrice: actualClosePrice ? String(actualClosePrice) : undefined,
        status: "executed",
        orderId: orderResult.orderId,
        message: `[V5.0 Monitor] ${strategy.symbol} 部分獲利平倉 ${actualCloseSize.toFixed(6)}，觸發層=${triggerLayer}，剩餘 ${newTotalSize.toFixed(6)}`,
        source: "auto",
      });
    } catch (e) {
      console.error(`[V50Monitor] partialClose 寫入訊號日誌失敗`, e);
    }

    try {
      const realizedPnl = actualClosePrice && state.avgPrice > 0
        ? (actualClosePrice - state.avgPrice) * actualCloseSize * (state.isLong ? 1 : -1)
        : undefined;
      await createTrade({
        strategyId: strategy.id,
        userId: strategy.userId,
        signalId,
        exchange: strategy.exchange,
        symbol: strategy.symbol,
        side,
        orderType: "market",
        orderId: orderResult.orderId,
        ...tradeFillRecordFields(orderResult, undefined, closeSize),
        realizedPnl: realizedPnl !== undefined ? String(realizedPnl.toFixed(6)) : undefined,
        reduceOnly: true,
        status: "filled",
        triggerSource: "v50_monitor_partial_close",
      });
    } catch (e) {
      console.error(`[V50Monitor] partialClose 寫入交易記錄失敗`, e);
    }

    console.log(`[V50Monitor] 策略 ${strategy.id} 部分獲利平倉 ${actualCloseSize.toFixed(6)}，剩餘 ${newTotalSize.toFixed(6)}`);
  } catch (err: any) {
    console.error(`[V50Monitor] partialClose 失敗:`, err?.message);
  }
}

/** 供 Heartbeat 排程調用的單次檢查 */
export async function runV50CheckOnce(): Promise<{ checked: number }> {
  const enabled = await listEnabledStrategies();
  const v50Strategies = enabled.filter((s: any) => s.strategyKey === V50_KEY);
  if (v50Strategies.length === 0) return { checked: 0 };

  for (const strategy of v50Strategies) {
    try {
      await checkV50Strategy(strategy as any);
    } catch (err: any) {
      console.error(`[V50Monitor] 策略 ${(strategy as any).id} 檢查失敗:`, err?.message);
    }
  }
  return { checked: v50Strategies.length };
}
