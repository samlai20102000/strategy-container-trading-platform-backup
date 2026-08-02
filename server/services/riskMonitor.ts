import {
  createRiskEvent,
  createSignal,
  disableStrategySystem,
  getApiKeyById,
  getTodayRealizedPnl,
  listRiskMonitorCandidates,
  listStrategies,
  updateStrategy,
} from "../db";
import { recordExistingTradeExecution as createTrade } from "./tradeExecutionLedger";
import { createInitialStrategyState } from "../strategies/base";
import { createAdapter } from "../exchanges/factory";
import { closePolicyOptions } from "../exchanges/orderPolicyIntent";
import { createRuntimeGuardedAdapter } from "../exchanges/runtimeGuardedAdapter";
import type { ExchangeAdapter, OrderResult, Position } from "../exchanges/types";
import { isV35StrategyKey } from "./v35Monitor";
import { tradeFillRecordFields } from "./tradeFillTruth";
import { acquireProcessLease, releaseProcessLease } from "./barLock";
import {
  buildStableCloseIntentId,
  closeExecutionErrorMessage,
  closeRetryRemainingMs,
  nextCloseRetryState,
  readCloseRetryState,
  type CloseRetryState,
} from "./closeExecutionResilience";
import {
  buildStrategyPositionSnapshots,
  normalizePositionSymbol,
  STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION,
  toLocalPositionState,
} from "./strategyPositionSnapshot";

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
    const candidates = await listRiskMonitorCandidates();
    const ownershipStrategiesByUser = new Map<number, Awaited<ReturnType<typeof listStrategies>>>();
    for (const strategy of candidates) {
      try {
        let ownershipStrategies = ownershipStrategiesByUser.get(strategy.userId);
        if (!ownershipStrategies) {
          ownershipStrategies = await listStrategies(strategy.userId);
          ownershipStrategiesByUser.set(strategy.userId, ownershipStrategies);
        }
        await checkStrategyRisk(strategy, ownershipStrategies);
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

export function selectOwnedRiskPosition(
  strategy: any,
  positions: readonly Position[],
  ownershipStrategies: readonly any[] = [strategy],
): Position | undefined {
  const local = toLocalPositionState(strategy);
  if (!local.hasPosition || !local.side) return undefined;
  const snapshot = buildStrategyPositionSnapshots(
    Array.from(ownershipStrategies),
    new Map([[strategy.apiKeyId, {
      contractVersion: STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION,
      positions: Array.from(positions),
      capturedAt: Date.now(),
    }]]),
  ).find(item => item.strategyId === strategy.id);
  // 只有本地數量／均價、API 帳戶、商品、方向皆與唯一交易所腿吻合時才可自動平倉。
  // singleton_exchange／account_aggregate 只供介面對帳，禁止風控猜測歸屬後下單。
  if (!snapshot || snapshot.status !== "available" || snapshot.attribution !== "exact") return undefined;
  const symbolKey = normalizePositionSymbol(strategy.symbol);
  return positions.find(position =>
    position.size > 0
    && position.side === local.side
    && normalizePositionSymbol(position.symbol) === symbolKey,
  );
}

async function checkStrategyRisk(strategy: any, ownershipStrategies: readonly any[]): Promise<void> {
  // V35/V4 有獨立的硬止損、移動止盈、馬丁加倉與跨實例租約。
  // 泛用 RiskMonitor 若再掃描，會以另一套 stopLossPct 語義重複平倉／停用。
  if (shouldSkipGenericRiskMonitor(strategy.strategyKey)) return;

  const martinState = strategy.martinState && typeof strategy.martinState === "object"
    ? strategy.martinState as Record<string, unknown>
    : {};
  const pendingRetry = readCloseRetryState(martinState.closeRetry);
  const pendingContext = martinState.closeRetryContext && typeof martinState.closeRetryContext === "object"
    ? martinState.closeRetryContext as Record<string, unknown>
    : undefined;
  if (!strategy.enabled && !pendingRetry) return;

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
  if (!pendingRetry && stopLossPct <= 0 && takeProfitPct <= 0 && maxDailyLoss <= 0) return;

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

  let positions: Position[];
  try {
    positions = await adapter.getPositions(strategy.symbol);
  } catch {
    return;
  }

  const local = toLocalPositionState(strategy);
  const pos = selectOwnedRiskPosition(strategy, positions, ownershipStrategies);
  if (!pos || !local.side) return;
  const requestedSize = Math.min(local.size, pos.size);

  if (pendingRetry) {
    if (closeRetryRemainingMs(pendingRetry) > 0) return;
    const eventType = pendingContext?.eventType === "stop_loss"
      || pendingContext?.eventType === "daily_loss_limit"
      || pendingContext?.eventType === "take_profit"
      ? pendingContext.eventType
      : "take_profit";
    await enforceRisk(strategy, adapter, eventType, {
      disable: pendingContext?.disable === true,
      detail: typeof pendingContext?.detail === "string" ? pendingContext.detail : "待完成的風控平倉重試",
      posSide: local.side,
      requestedSize,
      entryPrice: local.entryPrice,
    });
    return;
  }

  if (maxDailyLoss > 0) {
    const todayPnl = await getTodayRealizedPnl(strategy.id);
    if (todayPnl <= -maxDailyLoss) {
      await enforceRisk(strategy, adapter, "daily_loss_limit", {
        disable: true,
        detail: `今日已實現盈虧 ${todayPnl.toFixed(2)} USDT，超過上限 ${maxDailyLoss} USDT`,
        posSide: local.side,
        requestedSize,
        entryPrice: local.entryPrice,
      });
      return;
    }
  }

  if (pos.entryPrice <= 0 || pos.markPrice <= 0) return;
  const leverage = Number(strategy.leverage) || 1;
  const rawChangePct = ((pos.markPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlPct = (pos.side === "long" ? rawChangePct : -rawChangePct) * leverage;

  if (stopLossPct > 0 && pnlPct <= -stopLossPct) {
    await enforceRisk(strategy, adapter, "stop_loss", {
      disable: true,
      detail: `${pos.symbol} ${pos.side === "long" ? "多" : "空"}倉盈虧 ${pnlPct.toFixed(2)}%（${leverage}x槓桿），觸發止損 ${stopLossPct}%（入場 ${pos.entryPrice} → 標記 ${pos.markPrice}）`,
      posSide: local.side,
      requestedSize,
      entryPrice: local.entryPrice,
    });
    return;
  }

  if (takeProfitPct > 0 && pnlPct >= takeProfitPct) {
    await enforceRisk(strategy, adapter, "take_profit", {
      disable: false,
      detail: `${pos.symbol} ${pos.side === "long" ? "多" : "空"}倉盈虧 +${pnlPct.toFixed(2)}%（${leverage}x槓桿），觸發止盈 ${takeProfitPct}%（入場 ${pos.entryPrice} → 標記 ${pos.markPrice}）`,
      posSide: local.side,
      requestedSize,
      entryPrice: local.entryPrice,
    });
  }
}

async function enforceRisk(
  strategy: any,
  adapter: ExchangeAdapter,
  eventType: "stop_loss" | "take_profit" | "daily_loss_limit",
  opts: {
    disable: boolean;
    detail: string;
    posSide: "long" | "short";
    requestedSize: number;
    entryPrice: number;
  },
): Promise<void> {
  const lease = await acquireProcessLease("risk-close-v2", strategy.id, 120_000);
  if (!lease) {
    console.log(`[RiskMonitor] 策略 ${strategy.id} 已有平倉執行中，本輪略過重複命令`);
    return;
  }
  try {
  const existingState = strategy.martinState && typeof strategy.martinState === "object"
    ? strategy.martinState as Record<string, unknown>
    : {};
  const closeIntentId = buildStableCloseIntentId({
    strategyId: strategy.id,
    side: opts.posSide,
    size: opts.requestedSize,
    entryPrice: opts.entryPrice,
    scope: eventType,
  });
  const previousRetry = readCloseRetryState(existingState.closeRetry);
  if (previousRetry?.closeIntentId === closeIntentId && closeRetryRemainingMs(previousRetry) > 0) return;

  console.log(`[RiskMonitor] 觸發 ${eventType}: 策略 ${strategy.id} intent=${closeIntentId} - ${opts.detail}`);

  let result: OrderResult;
  try {
    const emergencyReason = eventType === "stop_loss"
      ? "STOP_LOSS" as const
      : eventType === "daily_loss_limit"
        ? "DAILY_LOSS_LIMIT" as const
        : undefined;
    result = await adapter.closePositionSmart(
      strategy.symbol,
      opts.posSide,
      undefined,
      undefined,
      closeIntentId,
      closePolicyOptions({
        strategyId: strategy.id,
        source: "RISK",
        reasonCode: eventType,
        intentKey: closeIntentId,
      }, emergencyReason, opts.requestedSize),
    );
    if (result.success && result.orderId) {
      await createTrade({
        strategyId: strategy.id,
        userId: strategy.userId,
        exchange: strategy.exchange,
        symbol: strategy.symbol,
        side: opts.posSide === "short" ? "buy" : "sell",
        orderType: result.policyAudit?.finalOrderType === "market" ? "market" : "limit",
        orderId: result.orderId,
        ...tradeFillRecordFields(
          result,
          undefined,
          opts.requestedSize,
        ),
        reduceOnly: true,
        status: "filled",
        triggerSource: `risk_${eventType}`,
      });
    }
  } catch (e: any) {
    console.error(`[RiskMonitor] 自動平倉失敗:`, e.message);
    result = {
      success: false,
      rawResponse: JSON.stringify({ thrownError: String(e?.message || e) }),
      errorMessage: String(e?.message || e),
    };
  }

  const positionClosed = result.success;
  let retryState: CloseRetryState | undefined;
  if (!positionClosed) {
    retryState = nextCloseRetryState({ previous: previousRetry, closeIntentId, result });
    try {
      await updateStrategy(strategy.id, strategy.userId, {
        martinState: {
          ...existingState,
          closeRetry: retryState,
          closeRetryContext: {
            eventType,
            disable: opts.disable,
            detail: opts.detail,
            posSide: opts.posSide,
            requestedSize: opts.requestedSize,
            entryPrice: opts.entryPrice,
          },
        },
      });
    } catch (error) {
      console.error(`[RiskMonitor] 保存策略 ${strategy.id} 平倉退避失敗`, error);
    }
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
        requestedSize: opts.requestedSize,
        closeIntentId,
        retry: retryState,
        source: "risk_monitor",
      }),
      parsedAction: "close",
      parsedSymbol: strategy.symbol,
      status: positionClosed ? "executed" : "failed",
      reasonCode: positionClosed ? eventType : retryState?.reasonCode,
      orderId: result.orderId,
      exchangeResponse: JSON.stringify({
        closeIntentId,
        posSide: opts.posSide,
        requestedSize: opts.requestedSize,
        errorMessage: result.errorMessage,
        rawResponse: result.rawResponse,
        policyAudit: result.policyAudit,
        retry: retryState,
      }),
      message: positionClosed
        ? `[風控監控] ${strategy.symbol} ${translateEvent(eventType)}觸發平倉成功：${opts.detail}`
        : `[風控監控] ${strategy.symbol} ${translateEvent(eventType)}觸發平倉失敗：${closeExecutionErrorMessage(result)}；intent=${closeIntentId}；posSide=${opts.posSide}；size=${opts.requestedSize}；${retryState ? `${Math.ceil(closeRetryRemainingMs(retryState) / 1000)}s 後重試` : "等待下一輪重試"}`,
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
  } finally {
    await releaseProcessLease(lease);
  }
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
