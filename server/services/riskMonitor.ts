import {
  createRiskEvent,
  createSignal,
  disableStrategySystem,
  getApiKeyById,
  getTodayRealizedPnl,
  listEnabledStrategies,
  updateStrategy,
} from "../db";
import { recordExistingTradeExecution as createTrade } from "./tradeExecutionLedger";
import { createInitialStrategyState } from "../strategies/base";
import { createAdapter } from "../exchanges/factory";
import { closePolicyOptions } from "../exchanges/orderPolicyIntent";
import { createRuntimeGuardedAdapter } from "../exchanges/runtimeGuardedAdapter";
import type { ExchangeAdapter, Position } from "../exchanges/types";
import { isV35StrategyKey } from "./v35Monitor";
import { tradeFillRecordFields } from "./tradeFillTruth";

/**
 * 風險監控循環
 * 定期檢查所有啟用策略的持倉：
 *  - 止損百分比觸發 → 自動平倉 + 停用策略
 *  - 止盈百分比觸發 → 自動平倉（不停用）
 *  - 每日虧損上限觸發 → 自動平倉 + 停用策略
 * 全程無需人工介入
 */

const CHECK_INTERVAL_MS = 20_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startRiskMonitor() {
  if (timer) return;
  timer = setInterval(() => {
    void runRiskCheck();
  }, CHECK_INTERVAL_MS);
  console.log(`[RiskMonitor] 風險監控已啟動（每 ${CHECK_INTERVAL_MS / 1000} 秒檢查）`);
}

export function stopRiskMonitor() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function runRiskCheck(): Promise<void> {
  if (running) return; // 防止重疊執行
  running = true;
  try {
    const enabledStrategies = await listEnabledStrategies();
    for (const strategy of enabledStrategies) {
      try {
        await checkStrategyRisk(strategy);
      } catch (e: any) {
        console.error(`[RiskMonitor] 策略 ${strategy.id} 檢查失敗:`, e.message);
      }
    }
  } catch (e: any) {
    console.error("[RiskMonitor] 風險檢查循環失敗:", e.message);
  } finally {
    running = false;
  }
}

// V6.1 策略自帶完整移動止盈邏輯（v61Monitor），RiskMonitor 不重複觸發止盈
// 避免雙重監控器同時搶平同一倉位，造成 API 請求風暴（50001 錯誤）
const V61_STRATEGY_KEYS = ["KAMA_3K_HF_V61"];

export function shouldSkipGenericRiskMonitor(strategyKey: unknown): boolean {
  return isV35StrategyKey(strategyKey);
}

async function checkStrategyRisk(strategy: any): Promise<void> {
  // V35/V4 有獨立的硬止損、移動止盈、馬丁加倉與跨實例租約。
  // 泛用 RiskMonitor 若再掃描，會以另一套 stopLossPct 語義重複平倉／停用。
  if (shouldSkipGenericRiskMonitor(strategy.strategyKey)) return;

  const stopLossPct = parseFloat(strategy.stopLossPct);
  let takeProfitPct = parseFloat(strategy.takeProfitPct);
  const maxDailyLoss = parseFloat(strategy.maxDailyLoss);

  // V6.1 策略：跳過止盈檢查（由 v61Monitor 的移動止盈處理，更精細）
  // 保留止損和每日虧損上限檢查作為最後防線
  const isV61 = V61_STRATEGY_KEYS.includes(strategy.strategyKey);
  if (isV61) {
    takeProfitPct = 0; // 禁用 RiskMonitor 的止盈觸發
  }

  // 沒有任何風險設定則跳過
  if (stopLossPct <= 0 && takeProfitPct <= 0 && maxDailyLoss <= 0) return;

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
    source: "RISK",
    eventKey: `risk-monitor:${strategy.id}:${Math.floor(Date.now() / CHECK_INTERVAL_MS)}`,
    reason: "platform risk monitor",
  });

  // 每日虧損上限檢查
  if (maxDailyLoss > 0) {
    const todayPnl = await getTodayRealizedPnl(strategy.id);
    if (todayPnl <= -maxDailyLoss) {
      await enforceRisk(strategy, adapter, "daily_loss_limit", {
        disable: true,
        detail: `今日已實現盈虧 ${todayPnl.toFixed(2)} USDT，超過上限 ${maxDailyLoss} USDT`,
      });
      return;
    }
  }

  // 止損/止盈檢查（基於持倉入場價與標記價）
  if (stopLossPct <= 0 && takeProfitPct <= 0) return;

  let positions: Position[];
  try {
    positions = await adapter.getPositions(strategy.symbol);
  } catch {
    return;
  }

  const leverage = Number(strategy.leverage) || 1;

  for (const pos of positions) {
    if (pos.entryPrice <= 0 || pos.markPrice <= 0) continue;
    // 計算基於保證金的盈虧%（價格變動% × 槓桿，與 OKX 顯示一致）
    const rawChangePct =
      ((pos.markPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const pnlPct = (pos.side === "long" ? rawChangePct : -rawChangePct) * leverage;

    if (stopLossPct > 0 && pnlPct <= -stopLossPct) {
      await enforceRisk(strategy, adapter, "stop_loss", {
        disable: true,
        detail: `${pos.symbol} ${pos.side === "long" ? "多" : "空"}倉盈虧 ${pnlPct.toFixed(2)}%（${leverage}x槓桿），觸發止損 ${stopLossPct}%（入場 ${pos.entryPrice} → 標記 ${pos.markPrice}）`,
        posSide: pos.side as "long" | "short",
      });
      return;
    }

    if (takeProfitPct > 0 && pnlPct >= takeProfitPct) {
      // 止盈：平倉但不停用策略，重置 martinState 允許重新開倉（利益最大化）
      await enforceRisk(strategy, adapter, "take_profit", {
        disable: false,
        detail: `${pos.symbol} ${pos.side === "long" ? "多" : "空"}倉盈虧 +${pnlPct.toFixed(2)}%（${leverage}x槓桿），觸發止盈 ${takeProfitPct}%（入場 ${pos.entryPrice} → 標記 ${pos.markPrice}）`,
        posSide: pos.side as "long" | "short",
      });
      return;
    }
  }
}

async function enforceRisk(
  strategy: any,
  adapter: ExchangeAdapter,
  eventType: "stop_loss" | "take_profit" | "daily_loss_limit",
  opts: { disable: boolean; detail: string; posSide?: "long" | "short" },
): Promise<void> {
  console.log(`[RiskMonitor] 觸發 ${eventType}: 策略 ${strategy.id} - ${opts.detail}`);

  let positionClosed = false;
  try {
    const emergencyReason = eventType === "stop_loss"
      ? "STOP_LOSS" as const
      : eventType === "daily_loss_limit"
        ? "DAILY_LOSS_LIMIT" as const
        : undefined;
    const result = await adapter.closePositionSmart(
      strategy.symbol,
      opts.posSide,
      undefined,
      undefined,
      closePolicyOptions({
        strategyId: strategy.id,
        source: "RISK",
        reasonCode: eventType,
      }, emergencyReason),
    );
    positionClosed = result.success;
    if (result.success && result.orderId) {
      await createTrade({
        strategyId: strategy.id,
        userId: strategy.userId,
        exchange: strategy.exchange,
        symbol: strategy.symbol,
        side: opts.posSide === "short" ? "buy" : "sell",
        orderType: "market",
        orderId: result.orderId,
        ...tradeFillRecordFields(
          result,
          undefined,
          Number(strategy.martinState?.totalSize || 0),
        ),
        reduceOnly: true,
        status: "filled",
        triggerSource: `risk_${eventType}`,
      });
    }
  } catch (e: any) {
    console.error(`[RiskMonitor] 自動平倉失敗:`, e.message);
  }

  let strategyDisabled = false;
  if (opts.disable) {
    try {
      await disableStrategySystem(strategy.id, `風險觸發（${translateEvent(eventType)}）：${opts.detail}`);
      strategyDisabled = true;
    } catch (e: any) {
      console.error(`[RiskMonitor] 停用策略失敗:`, e.message);
    }
  }

  // 平倉成功後重置 martinState（防止狀態不一致，允許重新開倉）
  if (positionClosed) {
    try {
      const resetState = createInitialStrategyState();
      // 保留 __v35Config / __v61Config / __v50Config 等配置
      const existingMartinState = (strategy.martinState && typeof strategy.martinState === 'object') ? strategy.martinState as Record<string, unknown> : {};
      const preservedConfig: Record<string, unknown> = {};
      for (const key of Object.keys(existingMartinState)) {
        if (key.startsWith('__')) {
          preservedConfig[key] = existingMartinState[key];
        }
      }
      await updateStrategy(strategy.id, strategy.userId, {
        martinState: { ...resetState, ...preservedConfig },
      });
      console.log(`[RiskMonitor] 策略 ${strategy.id} martinState 已重置（${eventType}）`);
    } catch (e: any) {
      console.error(`[RiskMonitor] 重置 martinState 失敗:`, e.message);
    }
  }

  // 寫入訊號日誌
  try {
    await createSignal({
      strategyId: strategy.id,
      userId: strategy.userId,
      rawPayload: JSON.stringify({
        action: "close",
        symbol: strategy.symbol,
        eventType,
        detail: opts.detail,
        posSide: opts.posSide,
        source: "risk_monitor",
      }),
      parsedAction: "close",
      parsedSymbol: strategy.symbol,
      status: positionClosed ? "executed" : "failed",
      message: positionClosed
        ? `[風控監控] ${strategy.symbol} ${translateEvent(eventType)}觸發平倉成功：${opts.detail}`
        : `[風控監控] ${strategy.symbol} ${translateEvent(eventType)}觸發平倉失敗：${opts.detail}`,
      source: "auto",
    });
  } catch (e) {
    console.error(`[RiskMonitor] enforceRisk 寫入訊號日誌失敗`, e);
  }

  await createRiskEvent({
    strategyId: strategy.id,
    userId: strategy.userId,
    eventType,
    detail: opts.detail,
    positionClosed,
    strategyDisabled,
  });
}

function translateEvent(t: string): string {
  switch (t) {
    case "stop_loss":
      return "止損";
    case "take_profit":
      return "止盈";
    case "daily_loss_limit":
      return "每日虧損上限";
    default:
      return t;
  }
}
