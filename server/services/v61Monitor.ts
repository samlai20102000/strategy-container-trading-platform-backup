/**
 * V6.1 實盤監控器（v61Monitor）
 *
 * 針對綁定 V6.1 策略（KAMA_3K_HF_V61）的啟用策略，每輪檢查：
 * 1. 區域止損（zone_sl_pct）
 * 2. 極限止損（max_drawdown_pct）
 * 3. 部分獲利（分層平倉）
 * 4. 移動止盈（trailing stop）
 * 5. 馬丁加倉（固定間距 + 倍率）
 *
 * 與 v35Monitor / v50Monitor 完全獨立，不修改任何其他策略邏輯。
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
import {
  closePolicyOptions,
  orderPolicyFields,
  type ApprovedEmergencyReason,
} from "../exchanges/orderPolicyIntent";
import { createRuntimeGuardedAdapter } from "../exchanges/runtimeGuardedAdapter";
import type { ExchangeAdapter, OrderResult } from "../exchanges/types";
import { loadStrategyState, saveStrategyState } from "./strategyStateManager";
import { notifyOwner } from "./notifier";
import { validateAndProcessMartinConfig } from "./parameterValidator";
import { getLayerStepPct } from "./martingaleEngine";
import { getLatestADX, getLatestATR } from "./indicators";
import { KLineInput } from "./indicators";
import { V61_REGIME_PARAMS } from "../strategies/v61/strategy_kama_3k_v61";
import { resolveTradeFill, tradeFillRecordFields } from "./tradeFillTruth";

const V61_KEY = "KAMA_3K_HF_V61";
const CHECK_INTERVAL_MS = 15_000; // V6.1 高頻版 15 秒檢查一次
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * 平倉鎖：同一 symbol 在 CLOSE_LOCK_TTL_MS 內只允許一次平倉嘗試
 * 避免 V6.1 Monitor 每 15 秒重複觸發平倉造成 API 風暴
 */
const closeLocks = new Map<string, number>(); // key=symbol, value=lockUntil timestamp
const CLOSE_LOCK_TTL_MS = 60_000; // 60 秒鎖定

function isCloseLocked(symbol: string): boolean {
  const until = closeLocks.get(symbol);
  if (!until) return false;
  if (Date.now() < until) return true;
  closeLocks.delete(symbol);
  return false;
}

function setCloseLock(symbol: string): void {
  closeLocks.set(symbol, Date.now() + CLOSE_LOCK_TTL_MS);
}

function clearCloseLock(symbol: string): void {
  closeLocks.delete(symbol);
}

// ============================================================
// 主監控循環
// ============================================================

export function startV61Monitor(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runV61Check();
  }, CHECK_INTERVAL_MS);
  console.log(`[V61Monitor] V6.1 高頻掃射監控已啟動（每 ${CHECK_INTERVAL_MS / 1000} 秒檢查）`);
}

export function stopV61Monitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("[V61Monitor] 已停止");
  }
}

export async function runV61Check(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const enabled = await listEnabledStrategies();
    const v61Strategies = enabled.filter((s: any) => s.strategyKey === V61_KEY);
    for (const strategy of v61Strategies) {
      try {
        await checkV61Strategy(strategy as any);
      } catch (e: unknown) {
        console.error(`[V61Monitor] 策略 ${(strategy as any).id} 檢查失敗:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e: unknown) {
    console.error("[V61Monitor] 監控循環失敗:", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

import { V61Config } from "../strategies/v61/strategy_kama_3k_v61";

import { getRegime, calculateATRMA } from "./v61Utils"; // 從 v61Utils 導入共用邏輯

export async function checkV61Strategy(strategy: any): Promise<boolean> {
  const state = loadStrategyState(strategy);
  if (state.totalSize <= 0 || state.avgPrice <= 0) return false; // 無持倉

  const apiKeyRecord = await getApiKeyById(strategy.apiKeyId);
  if (!apiKeyRecord) return false;

  let adapter: ExchangeAdapter;
  try {
    adapter = createAdapter(apiKeyRecord);
  } catch {
    return false;
  }
  adapter = createRuntimeGuardedAdapter(adapter, {
    strategy,
    source: "AUTO",
    eventKey: `v61-monitor:${strategy.id}:${Math.floor(Date.now() / CHECK_INTERVAL_MS)}`,
    reason: "V61 monitor maintenance",
  });

  // 取得當前標記價（匹配策略方向，避免跨策略污染）
  let currentPrice = 0;
  let candles: KLineInput[] = [];
  try {
    const positions = await adapter.getPositions(strategy.symbol);
    const expectedSide = state.isLong ? "long" : "short";
    const pos = positions.find((p: any) => p.size > 0 && p.side === expectedSide);
    if (!pos) {
      console.warn(`[V61Monitor] 策略 ${strategy.id} 找不到本地方向 ${expectedSide} 的交易所腿，停止本輪 mutation 並保留本地 ownership`);
      return false;
    }
    if (!pos || pos.markPrice <= 0) return false;
    currentPrice = pos.markPrice;

    // 獲取 K 線數據用於 regime 判斷
    
    candles = await adapter.getCandles(strategy.symbol, strategy.timeframe || 15, 100); // 獲取足夠的 K 線數據
    // 暫時使用空陣列避免編譯錯誤

    if (candles.length < 10) return false; // 確保有足夠的 K 線數據進行 regime 判斷

    // 交易所同方向腿是帳戶聚合量，可能包含其他策略；只做唯讀漂移告警。
    const exchangeSize = pos.size;
    const exchangeAvgPrice = pos.entryPrice;
    if (exchangeSize > 0 && exchangeAvgPrice > 0) {
      const sizeDiffPct = Math.abs(exchangeSize - state.totalSize) / exchangeSize * 100;
      const priceDiffPct = Math.abs(exchangeAvgPrice - state.avgPrice) / exchangeAvgPrice * 100;
      if (sizeDiffPct > 1 || priceDiffPct > 1) {
        console.warn(`[V61Monitor] 策略 #${strategy.id} 偵測帳戶聚合腿漂移但不回寫 ownership: 本地 size=${state.totalSize.toFixed(6)}/avg=${state.avgPrice.toFixed(2)}, 交易所同向聚合腿 size=${exchangeSize.toFixed(6)}/avg=${exchangeAvgPrice.toFixed(2)} (差異: size ${sizeDiffPct.toFixed(1)}%, price ${priceDiffPct.toFixed(1)}%)`);
      }
    }
  } catch (e) {
    console.error(`[V61Monitor] 獲取持倉或 K 線數據失敗:`, e instanceof Error ? e.message : e);
    return false;
  }

  const v61Config = (strategy.martinState as any)?.__v61Config ?? {};
  const avgPrice = state.avgPrice;
  const isLong = state.isLong;
  const totalSize = state.totalSize;
  const currentLayer = state.currentLayer;
  const capital = Number(v61Config.initial_capital) || 500;
  const leverage = Number(strategy.leverage) || 1;

  // 計算浮動盈虧百分比（基於保證金 = 價格變動% × 槓桿，與 OKX 顯示一致）
  const rawPnlPct = isLong
    ? ((currentPrice - avgPrice) / avgPrice) * 100
    : ((avgPrice - currentPrice) / avgPrice) * 100;
  const pnlPct = rawPnlPct * leverage;
  
  // 計算浮虧佔本金百分比
  const unrealizedLoss = isLong
    ? Math.max(0, (avgPrice - currentPrice) * totalSize)
    : Math.max(0, (currentPrice - avgPrice) * totalSize);
  const unrealizedLossPct = capital > 0 ? (unrealizedLoss / capital) * 100 : 0;

  // === 1. 區域止損（zone_sl_pct）=== 默認禁用（999），靠硬止損兆底
  const zoneSLPct = Number(v61Config.zone_sl_pct) || 999;
  if (pnlPct <= -zoneSLPct) {
    console.log(`[V61Monitor] 策略 ${strategy.id} 觸發區域止損 (pnl=${pnlPct.toFixed(2)}% <= -${zoneSLPct}%)`);
    await closePosition(
      strategy,
      adapter,
      currentPrice,
      `V6.1 區域止損 (浮虧 ${Math.abs(pnlPct).toFixed(2)}%)`,
      "STOP_LOSS",
    );
    return true;
  }

  // === 2. 極限止損（max_drawdown_pct）===
  const maxDrawdownPct = Number(v61Config.max_drawdown_pct) || 15;
  if (unrealizedLossPct >= maxDrawdownPct) {
    console.log(`[V61Monitor] 策略 ${strategy.id} 觸發極限止損 (${unrealizedLossPct.toFixed(2)}% >= ${maxDrawdownPct}%)`);
    await closeAndDisable(strategy, adapter, currentPrice, `V6.1 極限止損 (浮虧 ${unrealizedLossPct.toFixed(2)}% 佔本金)`);
    return true;
  }

  // === 3. 部分獲利（分層平倉）===
  const enablePartialTP = v61Config.enable_partial_tp !== false;
  if (enablePartialTP && pnlPct > 0 && currentLayer >= 4) {
    const alreadyClosed: number[] = (strategy.martinState as any)?.__partialClosedLayers ?? [];
    let ratio = 0;
    const triggerPct = Number(v61Config.partial_tp_trigger_pct) || 0.3;

    if (currentLayer >= 8 && !alreadyClosed.includes(8) && pnlPct >= triggerPct) {
      ratio = Number(v61Config.partial_tp_layer_8) || 0.2;
    } else if (currentLayer >= 6 && !alreadyClosed.includes(6) && pnlPct >= triggerPct) {
      ratio = Number(v61Config.partial_tp_layer_6) || 0.3;
    } else if (currentLayer >= 4 && !alreadyClosed.includes(4) && pnlPct >= triggerPct) {
      ratio = Number(v61Config.partial_tp_layer_4) || 0.3;
    }

    if (ratio > 0) {
      const closeSize = totalSize * ratio;
      console.log(`[V61Monitor] 策略 ${strategy.id} 部分獲利：平倉 ${(ratio * 100).toFixed(0)}% (層=${currentLayer})`);
      await partialClose(strategy, adapter, closeSize, currentLayer);
      return true;
    }
  }

  // === 4. 移動止盈（trailing stop）=== 優先讀取用戶設定的 takeProfitPct
  const userTpPct = Number((strategy as any).takeProfitPct);
  const targetTpPct = userTpPct > 0 ? userTpPct : (Number(v61Config.zone_tp_pct) || 1.0);
  const callbackPct = Number(v61Config.trailing_callback_pct) || 0.3;

  if (pnlPct >= targetTpPct && !state.isTrailingActivated) {
    // 激活追蹤
    const newState = { ...state, isTrailingActivated: true, highestPrice: currentPrice, lowestPrice: currentPrice };
    await saveStrategyState(strategy.id, newState);
    console.log(`[V61Monitor] 策略 ${strategy.id} 移動止盈已激活 (pnl=${pnlPct.toFixed(2)}%)`);
    return false;
  }

  if (state.isTrailingActivated) {
    let newHigh = state.highestPrice || currentPrice;
    let newLow = state.lowestPrice || currentPrice;
    if (isLong && currentPrice > newHigh) newHigh = currentPrice;
    if (!isLong && currentPrice < newLow) newLow = currentPrice;

    const peakPnlPct = isLong
      ? ((newHigh - avgPrice) / avgPrice) * 100 * leverage
      : ((avgPrice - newLow) / avgPrice) * 100 * leverage;
    const drawback = peakPnlPct - pnlPct;

    if (drawback >= callbackPct) {
      console.log(`[V61Monitor] 策略 ${strategy.id} 移動止盈觸發 (回撤 ${drawback.toFixed(3)}%)`);
      await closePosition(strategy, adapter, currentPrice, `V6.1 移動止盈 (峰值 ${peakPnlPct.toFixed(2)}%, 回撤 ${drawback.toFixed(3)}%)`);
      return true;
    }

    // 更新最優價
    if (newHigh !== state.highestPrice || newLow !== state.lowestPrice) {
      const newState = { ...state, highestPrice: newHigh, lowestPrice: newLow };
      await saveStrategyState(strategy.id, newState);
    }
  }

  // === 5. 馬丁加倉檢查（統一使用 validateAndProcessMartinConfig 讀取分層表格）===
  const martinCfg = validateAndProcessMartinConfig({
    Max_Layers: v61Config.max_layers ?? v61Config.Max_Layers,
    Martin_Multiplier: v61Config.martin_multiplier ?? v61Config.Martin_Multiplier,
    Martin_Layers: v61Config.Martin_Layers,
  });
  const maxLayers = martinCfg.maxLayers;
  // const globalStepPct = Number(v61Config.martin_step_pct ?? v61Config.Martin_Step_Pct) || Number((strategy as any).martinSpacingPct) || 2.0; // 移除此行，改用 regime 決定 stepPct

  // 根據當前市場制度獲取馬丁參數
  const currentRegime = getRegime(candles, v61Config as V61Config);
  const regimeMartinParams = V61_REGIME_PARAMS[currentRegime] || V61_REGIME_PARAMS.ranging;

  if (pnlPct < 0 && currentLayer > 0 && currentLayer < maxLayers) {
    // 使用 getLayerStepPct 讀取下一層的專屬間距（分層模式優先，否則用 regime 決定）
    const nextLayer = currentLayer + 1;
    const stepPct = getLayerStepPct(nextLayer, martinCfg.sortedLayers, regimeMartinParams.step[nextLayer - 1] || 2.0); // 使用 regime 參數的 step

    const lastLayerPrice = state.lastLayerPrice || avgPrice;
    // 🔥 偏離% 基於價格變動（不乘槓桿）—— 加倉是為了攤平成本，應基於價格偏離
    const deviation = isLong
      ? ((lastLayerPrice - currentPrice) / lastLayerPrice) * 100
      : ((currentPrice - lastLayerPrice) / lastLayerPrice) * 100;

    if (deviation >= stepPct) {
      console.log(`[V61Monitor] 策略 ${strategy.id} 馬丁加倉條件滿足 (價格偏離 ${deviation.toFixed(2)}% >= ${stepPct}%, 槓桿後=${(deviation * leverage).toFixed(2)}%, 層=${nextLayer}/${maxLayers}, 模式=${martinCfg.usedMode}, 制度=${currentRegime})`);
      // 加倉由 autoTradeSignalGenerator 觸發
    }
  }
  return false;
}

// ============================================================
// 輔助方法
// ============================================================

async function closeAndDisable(strategy: any, adapter: ExchangeAdapter, price: number, reason: string): Promise<void> {
  try {
    const state = loadStrategyState(strategy);
    let positionClosed = false;
    let exitPrice = 0;
    let pnl: number | undefined;
    let orderId: string | undefined;
    let exchangeCloseResult: OrderResult | undefined;

    if (state.totalSize > 0) {
      const result = await adapter.closePositionSmart(
        strategy.symbol,
        state.isLong ? "long" : "short",
        undefined,
        undefined,
        `clOrdId_V61_CLOSE_DISABLE_${strategy.id}_${Date.now()}`,
        closePolicyOptions({
          strategyId: strategy.id,
          source: "RISK",
          reasonCode: "v61_max_drawdown",
        }, "STOP_LOSS", state.totalSize),
      );
      exchangeCloseResult = result;
      if (!result.success) {
        console.error(`[V61Monitor] closeAndDisable 平倉失敗:`, result.errorMessage, result.rawResponse);
      } else {
        positionClosed = true;
        orderId = result.orderId;
        exitPrice = result.filledPrice || price;
        const dirMult = state.isLong ? 1 : -1;
        pnl = (exitPrice > 0 && state.avgPrice > 0 && state.totalSize > 0)
          ? (exitPrice - state.avgPrice) * state.totalSize * dirMult
          : undefined;
      }
    }

    if (!positionClosed || !exchangeCloseResult) {
      await notifyOwner(
        `V6.1 風控平倉失敗 - 策略 ${strategy.name || strategy.id}`,
        `原因：${reason}\n交易所尚未確認平倉；策略保持啟用且本地持倉不重置，下一輪將重試。`,
      );
      return;
    }

    await disableStrategySystem(strategy.id, reason);

    // 寫入訊號日誌（先建立 signal 取得 signalId）
    let signalId: number | undefined;
    try {
      const pnlStr = pnl !== undefined ? ` | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT` : "";
      signalId = await createSignal({
        strategyId: strategy.id,
        userId: strategy.userId,
        rawPayload: JSON.stringify({
          action: "close_and_disable",
          symbol: strategy.symbol,
          reason,
          price,
          source: "v61_monitor",
        }),
        parsedAction: "close",
        parsedSymbol: strategy.symbol,
        parsedPrice: exitPrice > 0 ? String(exitPrice) : String(price),
        status: positionClosed ? "executed" : "failed",
        orderId,
        message: `[V6.1 Monitor] ${strategy.symbol} 止損平倉並停用：${reason}${pnlStr}`,
        source: "auto",
      });
    } catch (e) {
      console.error(`[V61Monitor] closeAndDisable 寫入訊號日誌失敗`, e);
    }

    // 寫入交易記錄（含 signalId 關聯）
    if (positionClosed) {
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
          realizedPnl: pnl !== undefined ?
 String(pnl.toFixed(6)) : undefined,
          reduceOnly: true,
          status: "filled",
          triggerSource: "v61_stop_loss",
        });
      } catch (e) {
        console.error(`[V61Monitor] closeAndDisable createTrade 失敗`, e);
      }
    }

    await notifyOwner(
      `🛑 V6.1 策略 ${strategy.name || strategy.id} 已停用`,
      `原因：${reason}\n品種：${strategy.symbol}\n浮虧觸發風控`,
    );
  } catch (err: any) {
    console.error(`[V61Monitor] closeAndDisable 失敗:`, err?.message);
  }
}

async function closePosition(
  strategy: any,
  adapter: ExchangeAdapter,
  price: number,
  reason: string,
  emergencyReason?: ApprovedEmergencyReason,
): Promise<void> {
  // 平倉鎖檢查：同一 symbol 60 秒內不重複嘗試
  if (isCloseLocked(strategy.symbol)) {
    console.warn(`[V61Monitor] ${strategy.symbol} 平倉鎖定中，跳過本次平倉嘗試`);
    return;
  }
  setCloseLock(strategy.symbol);

  try {
    const state = loadStrategyState(strategy);
    let positionClosed = false;
    let exitPrice = 0;
    let pnl: number | undefined;
    let orderId: string | undefined;
    let exchangeCloseResult: OrderResult | undefined;

    if (state.totalSize > 0) {
      const result = await adapter.closePositionSmart(
        strategy.symbol,
        state.isLong ? "long" : "short",
        undefined,
        undefined,
        `clOrdId_V61_CLOSE_POS_${strategy.id}_${Date.now()}`,
        closePolicyOptions({
          strategyId: strategy.id,
          source: "RISK",
          reasonCode: emergencyReason ? "v61_zone_stop" : "v61_trailing_take_profit",
        }, emergencyReason, state.totalSize),
      );
      if (!result.success) {
        console.error(`[V61Monitor] closePosition 平倉失敗:`, result.errorMessage, result.rawResponse);
        return; // 失敗不重置狀態，等待鎖過期後重試
      }
      exchangeCloseResult = result;
      positionClosed = true;
      orderId = result.orderId;
      exitPrice = result.filledPrice || price;
      const dirMult = state.isLong ? 1 : -1;
      pnl = (exitPrice > 0 && state.avgPrice > 0 && state.totalSize > 0)
        ? (exitPrice - state.avgPrice) * state.totalSize * dirMult
        : undefined;
      // 成功平倉，清除鎖
      clearCloseLock(strategy.symbol);
    }

    // 寫入訊號日誌（先建立 signal 取得 signalId）
    let signalId: number | undefined;
    try {
      const pnlStr = pnl !== undefined ? ` | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT` : "";
      signalId = await createSignal({
        strategyId: strategy.id,
        userId: strategy.userId,
        rawPayload: JSON.stringify({
          action: "close",
          symbol: strategy.symbol,
          reason,
          price,
          source: "v61_monitor",
        }),
        parsedAction: "close",
        parsedSymbol: strategy.symbol,
        parsedPrice: exitPrice > 0 ? String(exitPrice) : String(price),
        status: positionClosed ? "executed" : "failed",
        orderId,
        message: `[V6.1 Monitor] ${strategy.symbol} 平倉：${reason}${pnlStr}`,
        source: "auto",
      });
    } catch (e) {
      console.error(`[V61Monitor] closePosition 寫入訊號日誌失敗`, e);
    }

    // 寫入交易記錄（含 signalId 關聯）
    if (positionClosed) {
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
          ...tradeFillRecordFields(exchangeCloseResult!, price, state.totalSize),
          realizedPnl: pnl !== undefined ? String(pnl.toFixed(6)) : undefined,
          reduceOnly: true,
          status: "filled",
          triggerSource: "v61_trailing_stop",
        });
      } catch (e) {
        console.error(`[V61Monitor] closePosition createTrade 失敗`, e);
      }
    }

    // 重置馬丁狀態（保留 __v61Config）
    const martinState = strategy.martinState ?? {};
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
        isCooldown: false,
        cooldownUntil: 0,
        __v61Config: martinState.__v61Config,
      },
    });

    console.log(`[V61Monitor] 策略 ${strategy.id} 已平倉: ${reason}`);
  } catch (err: any) {
    console.error(`[V61Monitor] closePosition 失敗:`, err?.message);
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
      clientOrderId: `clOrdId_V61_PARTIAL_CLOSE_${strategy.id}_${triggerLayer}_${Date.now()}`,
      ...orderPolicyFields({
        strategyId: strategy.id,
        source: "EXECUTOR",
        reasonCode: `v61_partial_profit_layer_${triggerLayer}`,
      }),
    });

    if (!orderResult.success) {
      console.error(`[V61Monitor] partialClose 下單失敗:`, orderResult.errorMessage, orderResult.rawResponse);
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
          source: "v61_monitor",
        }),
        parsedAction: "close",
        parsedSymbol: strategy.symbol,
        parsedPrice: actualClosePrice ? String(actualClosePrice) : undefined,
        status: "executed",
        orderId: orderResult.orderId,
        message: `[V6.1 Monitor] ${strategy.symbol} 部分獲利平倉 ${actualCloseSize.toFixed(6)}，觸發層=${triggerLayer}，剩餘 ${newTotalSize.toFixed(6)}`,
        source: "auto",
      });
    } catch (e) {
      console.error(`[V61Monitor] partialClose 寫入訊號日誌失敗`, e);
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
        triggerSource: "v61_monitor_partial_close",
      });
    } catch (e) {
      console.error(`[V61Monitor] partialClose 寫入交易記錄失敗`, e);
    }

    console.log(`[V61Monitor] 策略 ${strategy.id} 部分獲利平倉 ${actualCloseSize.toFixed(6)}，剩餘 ${newTotalSize.toFixed(6)}`);
  } catch (err: any) {
    console.error(`[V61Monitor] partialClose 失敗:`, err?.message);
  }
}

/** 供 Heartbeat 排程調用的單次檢查 */
export async function runV61CheckOnce(): Promise<{ checked: number }> {
  const enabled = await listEnabledStrategies();
  const v61Strategies = enabled.filter((s: any) => s.strategyKey === V61_KEY);
  if (v61Strategies.length === 0) return { checked: 0 };

  for (const strategy of v61Strategies) {
    try {
      await checkV61Strategy(strategy as any);
    } catch (err: any) {
      console.error(`[V61Monitor] 策略 ${(strategy as any).id} 檢查失敗:`, err?.message);
    }
  }
  return { checked: v61Strategies.length };
}
