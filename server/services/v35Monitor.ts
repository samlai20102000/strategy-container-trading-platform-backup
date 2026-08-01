/**
 * V3.5 實時監控循環
 * 依據 Pasted_content_17.txt B.2.4/B.2.5 實作
 *
 * 針對綁定 V3.7 策略（20415_KAMA_MARTIN_V35）的啟用策略，每輪檢查（V3.7 簡化風控順序）：
 * 1. 移動止盈追蹤（激活 → 追蹤最優價 → 回撤平倉，分流 A：無冷卻）
 * 2. 🛡️ V3.7 硬止損（Max_Loss_Pct，取代 KAMA 反轉割肉）+ 極限防爆倉止損（條件 A/B/C）
 * 3. 馬丁加倉判斷（價格偏離均價 >= stepPct% → 自動加倉並更新均價）
 *
 * V3.7：❌ KAMA 反轉割肉已完全移除（馬丁持倉時頻繁騙線，導致大量盈利單被誤割；改用純硬止損 Max_Loss_Pct）
 *
 * 部署適配：dev 環境由 setInterval 驅動；生產（serverless）由 heartbeat 排程調用 runV35Check。
 */

import {
  createRiskEvent,
  createSignal,
  disableStrategySystem,
  getApiKeyById,
  listEnabledStrategies,
} from "../db";
import { recordExistingTradeExecution as createTrade } from "./tradeExecutionLedger";
import { createAdapter } from "../exchanges/factory";
import { closePolicyOptions, orderPolicyFields } from "../exchanges/orderPolicyIntent";
import { createRuntimeGuardedAdapter } from "../exchanges/runtimeGuardedAdapter";
import type { ExchangeAdapter, OrderResult } from "../exchanges/types";
import type { Strategy } from "../../drizzle/schema";
import type { V4Config, StrategyState, MartinLayer } from "./martingaleEngine";
import { calculateUnrealizedLossPct, getLayerSize, shouldAddLayer, getFirstOrderValue } from "./martingaleEngine";
import { parseMartinLayersStrict } from "./parameterValidator";
import { RiskManagerV4 } from "./riskManager";
import { updateTrailingStop } from "./trailingStopManager";
import { loadStrategyState, saveStrategyState } from "./strategyStateManager";
import { createInitialStrategyState } from "../strategies/base";
import { notifyOwner } from "./notifier";
import { decideCloseSplit, buildReentryState } from "./kamaReversalGuard";
import { calculateKAMA } from "./backtest/kama";
import { fetchOKXCandles, fetchBybitCandles } from "./backtest/dataFetcher";
import { getTimeframeMilliseconds } from "./backtest/timeframeParser";
import { resolveTradeFill, tradeFillRecordFields } from "./tradeFillTruth";
import { normalizeV40EntryGateConfig } from "../strategies/v35/entryGate";
import {
  V41_STRATEGY_KEY,
  validateV41Config,
  type NormalizedV41Config,
} from "../../shared/strategies/kama3kMartinV41";
import { getBoundStrategyConfig } from "./strategySnapshotConfig";
import { evaluateV41SameDirectionReentry } from "../strategies/v41/entryConditions";
import { fetchKLineData } from "./autoTradeSignalGenerator";

export const V35_STRATEGY_KEY = "20415_KAMA_MARTIN_V35";
export function isV35StrategyKey(strategyKey: unknown): boolean {
  return strategyKey === V35_STRATEGY_KEY || strategyKey === V41_STRATEGY_KEY;
}

export type V35PostCloseAction = "retry_close" | "reenter" | "cooldown" | "none";

/** 平倉未獲交易所確認時一律只允許重試，禁止重置狀態或建立新一輪持倉。 */
export function decideV35PostCloseAction(
  positionClosed: boolean,
  requestedAction: "reenter" | "cooldown" | "none",
): V35PostCloseAction {
  return positionClosed ? requestedAction : "retry_close";
}
const CHECK_INTERVAL_MS = 20_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startV35Monitor() {
  if (timer) return;
  timer = setInterval(() => {
    void runV35Check();
  }, CHECK_INTERVAL_MS);
  console.log(`[V35Monitor] V3.5 監控已啟動（每 ${CHECK_INTERVAL_MS / 1000} 秒檢查）`);
}

export function stopV35Monitor() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function runV35Check(): Promise<void> {
  if (running) { console.log(`[V35Monitor] 跳過（上一輪仍在運行）`); return; }
  running = true;
  try {
    const enabled = await listEnabledStrategies();
    const v35Strategies = enabled.filter((s) => isV35StrategyKey(s.strategyKey));
    console.log(`[V35Monitor] 運行檢查: 全部啟用策略=${enabled.length}, V35策略=${v35Strategies.length}, keys=[${v35Strategies.map(s => `${s.id}:${s.strategyKey}`).join(',')}]`);
    for (const strategy of v35Strategies) {
      try {
        await checkV35Strategy(strategy as Strategy);
      } catch (e: unknown) {
        console.error(`[V35Monitor] 策略 ${strategy.id} 檢查失敗:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e: unknown) {
    console.error("[V35Monitor] 監控循環失敗:", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

/**
 * 檢查單個 V3.5 策略的止盈/止損/加倉。
 * @returns true = 已觸發平倉（止盈或止損），false = 未觸發平倉
 */
export async function checkV35Strategy(strategy: Strategy): Promise<boolean> {
  const state = loadStrategyState(strategy);
  if (state.totalSize <= 0 || state.avgPrice <= 0) {
    console.log(`[V35Monitor] 策略 #${strategy.id} 無持倉 (totalSize=${state.totalSize}, avgPrice=${state.avgPrice})`);
    return false; // 無持倉
  }

  const apiKeyRecord = await getApiKeyById(strategy.apiKeyId);
  if (!apiKeyRecord) return false;

  let adapter: ExchangeAdapter;
  try {
    adapter = createAdapter(apiKeyRecord);
  } catch {
    return false;
  }

  // 取得當前標記價（匹配策略方向，避免跨策略污染）
  let currentPrice = 0;
  try {
    const positions = await adapter.getPositions(strategy.symbol);
    const expectedSide = state.isLong ? "long" : "short";
    let pos = positions.find((p) => p.size > 0 && p.side === expectedSide);
    if (!pos) {
      pos = positions.find((p) => p.size > 0);
    }
    if (!pos || pos.markPrice <= 0) {
      console.log(`[V35Monitor] 策略 #${strategy.id} 交易所無持倉或無標記價 (pos=${!!pos}, positions=${positions.length}, expectedSide=${expectedSide})`);
      return false;
    }
    currentPrice = pos.markPrice;

    // ===== 自動校準：比對 OKX 實際持倉與本地 martinState =====
    const exchangeSize = pos.size; // OKX 實際持倉量（已正確轉換 ctVal）
    const exchangeAvgPrice = pos.entryPrice; // OKX 實際開倉均價
    if (exchangeSize > 0 && exchangeAvgPrice > 0) {
      const sizeDiffPct = Math.abs(exchangeSize - state.totalSize) / exchangeSize * 100;
      const priceDiffPct = Math.abs(exchangeAvgPrice - state.avgPrice) / exchangeAvgPrice * 100;
      // 如果持倉量或均價差異超過 1%，自動用 OKX 數據校準
      if (sizeDiffPct > 1 || priceDiffPct > 1) {
        console.log(`[V35Monitor] 自動校準策略 #${strategy.id}: 本地 size=${state.totalSize.toFixed(6)}/avg=${state.avgPrice.toFixed(2)} → OKX size=${exchangeSize.toFixed(6)}/avg=${exchangeAvgPrice.toFixed(2)} (差異: size ${sizeDiffPct.toFixed(1)}%, price ${priceDiffPct.toFixed(1)}%)`);
        state.totalSize = exchangeSize;
        state.avgPrice = exchangeAvgPrice;
        await saveStrategyState(strategy.id, state);
      }
    }
  } catch (e: unknown) {
    console.log(`[V35Monitor] 策略 #${strategy.id} 獲取持倉失敗: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }

  // readonly probe 完成後，任何加倉／重入／平倉 mutation 都必須先持久化 canonical mode decision。
  adapter = createRuntimeGuardedAdapter(adapter, {
    strategy,
    source: "AUTO",
    eventKey: `v35-monitor:${strategy.id}:${Math.floor(Date.now() / CHECK_INTERVAL_MS)}`,
    reason: "V35 monitor maintenance",
    signalPrice: currentPrice,
  });

  const {
    config: cfg,
    audit: configAudit,
    allowExpansion,
    v41Config,
  } = readV4Config(strategy);
  const isV41 = strategy.strategyKey === V41_STRATEGY_KEY;

  // 馬丁層數（文件語義，首單 = 第 0 層）= currentLayer - 1
  const martinDepth = state.currentLayer; // V4.0 currentLayer 直接表示層數

  // ===== V3.7：❌ KAMA 反轉主動割肉（O2）已完全移除 =====
  // 理由：KAMA 在馬丁持倉時頻繁騙線，導致大量盈利單被誤割；改用純硬止損 Max_Loss_Pct

  // ===== 1. 🛡️ V3.7 硬止損（Max_Loss_Pct，取代 KAMA 反轉割肉）+ 極限防爆倉止損（含 O4）=====
  const riskManager = new RiskManagerV4(cfg); // 使用 RiskManagerV4
  const currentLossPct = calculateUnrealizedLossPct(state, currentPrice, cfg);
  console.log(
    `[V35Monitor][RiskAudit] strategy=${strategy.id} rawMaxLossPct=${configAudit.rawDisplay} ` +
    `effectiveMaxLossPct=${cfg.Max_Loss_Pct} status=${configAudit.status} ` +
    `capital=${cfg.Initial_Capital} totalSize=${state.totalSize} avgPrice=${state.avgPrice} ` +
    `markPrice=${currentPrice} lossPct=${currentLossPct.toFixed(6)}`,
  );

  // 🛡️ V3.7 硬止損檢查（整組馬丁持倉總浮虧 % >= Max_Loss_Pct → 全線市價平倉 + 暫停 + 重置馬丁 + 警報）
  const hardStop = riskManager.checkLimitStop(state, currentPrice);
  if (hardStop.triggered) {
    console.log(`   馬丁層數: ${martinDepth}`);
    const closeResult = await executeFullClose(strategy, adapter, state, "hard_stop_loss", hardStop.reason, {
      disable: true, // 暫停策略（防止立即重入）
      cooldownMinutes: cfg.K_Line_Period * 2,
    });
    if (!closeResult.positionClosed) {
      await notifyOwner(
        `🚨 硬止損平倉失敗 - 策略 #${strategy.id} ${strategy.name}`,
        `${hardStop.reason}\n馬丁層數：${martinDepth}\n當前價格：${currentPrice}\n本地持倉狀態未重置、策略保持啟用，下一次 Heartbeat 將重試。`,
      );
    }
    return true; // 已觸發平倉（止損）
  }

  // ===== 2. 移動止盈追蹤 =====
  const leverage = Number(strategy.leverage) || 1;
  const trailing = updateTrailingStop(state, currentPrice, {
    targetTpPct: cfg.Target_TP_Pct,
    callbackPct: cfg.Callback_Pct,
    leverage,
  });
  console.log(`[V35Monitor] 策略 #${strategy.id} 止盈檢查: price=${currentPrice}, avg=${state.avgPrice}, isLong=${state.isLong}, leverage=${leverage}x, activated=${state.isTrailingActivated}, highestPrice=${state.highestPrice}, TP=${cfg.Target_TP_Pct}%, CB=${cfg.Callback_Pct}% | result: shouldClose=${trailing.shouldClose}, reason=${trailing.reason}`);

  if (trailing.shouldClose) {
    // V4.1 原地重入只接受同一 closed-bar evaluator 的「持續方向條件」；事件型 3K 不可重複當票。
    const hasMartinLayer = state.currentLayer > 1;
    const kama = isV41 ? null : await computeLiveKama(strategy, cfg);
    const v41Reentry = isV41 && !hasMartinLayer && allowExpansion && v41Config
      ? await evaluateV41LiveReentry(strategy, adapter, state, v41Config)
      : null;
    const split = isV41
      ? {
          action: hasMartinLayer
            ? "cooldown" as const
            : v41Reentry?.allowed
              ? "reenter" as const
              : "none" as const,
          reason: hasMartinLayer
            ? "V4.1 曾發生馬丁加倉，止盈後強制冷卻"
            : v41Reentry?.reason ?? "V4.1 原地重入未通過或未啟用",
        }
      : decideCloseSplit({
          martinDepth,
          exitReason: "trailing_stop",
          entryTrendBull: state.entryTrendBull,
          currentKamaFast: kama?.fast ?? 0,
          currentKamaSlow: kama?.slow ?? 0,
          kLinePeriod: cfg.K_Line_Period,
          cooldownBars: 2,
          reentryEnabled: cfg.enableSameDirectionReentry,
        });

    const closeResult = await executeFullClose(strategy, adapter, state, "trailing_take_profit", trailing.reason, {
      disable: false,
      cooldownMinutes: split.action === "cooldown" ? cfg.K_Line_Period * 2 : 0,
    });

    const requestedAction = !isV41 && split.action === "reenter" && !kama
      ? "none"
      : split.action;
    const postCloseAction = decideV35PostCloseAction(closeResult.positionClosed, requestedAction);
    if (postCloseAction === "retry_close") {
      await notifyOwner(
        `🚨 移動止盈平倉失敗 - 策略 #${strategy.id} ${strategy.name}`,
        `${trailing.reason}\n交易所尚未確認平倉；本地持倉狀態未重置、未執行順勢重入，下一次 Heartbeat 將重試。`,
      );
      return true;
    }

    if (postCloseAction === "reenter" && (isV41 ? v41Reentry?.allowed : !!kama)) {
      // ✅ O3：第 0 層順勢重入（立即市價重入首單）
      const reentryDirectionBull = isV41 ? state.isLong : (kama?.fast ?? 0) > (kama?.slow ?? 0);
      const reentered = await executeReentry(strategy, adapter, state, currentPrice, reentryDirectionBull, cfg);
      await notifyOwner(
        `⚡ 移動止盈 + 順勢重入 - 策略 #${strategy.id} ${strategy.name}`,
        `${trailing.reason}\n${split.reason}\n${reentered ? "已市價重入首單，新一輪開始" : "重入下單失敗，等待新 3K 信號"}`,
      );
    } else {
      await notifyOwner(
        `✅ 移動止盈觸發 - 策略 #${strategy.id} ${strategy.name}`,
        `${trailing.reason}\n${postCloseAction === "cooldown" ? `馬丁解套（第 ${martinDepth} 層馬丁），進入冷卻期 ${cfg.K_Line_Period * 2} 分鐘` : split.reason}`,
      );
    }
    return true; // 已觸發平倉（止盈）
  }

  // 追蹤狀態有更新 → 持久化（激活/最優價變更）
  if (
    trailing.newState.isTrailingActivated !== state.isTrailingActivated ||
    trailing.newState.highestPrice !== state.highestPrice
  ) {
    await saveStrategyState(strategy.id, trailing.newState);
  }

  // ===== 3. 馬丁加倉判斷（O1：支援階梯式乘數）=====
  if (allowExpansion && shouldAddLayer(state, currentPrice, cfg, leverage).shouldAdd) {
    const nextLayer = state.currentLayer + 1;
    const lotSize = getLayerSize(nextLayer, currentPrice, cfg);

    const orderResult = await adapter.placeOrder({
      symbol: strategy.symbol,
      side: state.entryTrendBull ? "buy" : "sell", // 使用 entryTrendBull 判斷方向
      orderType: "market",
      size: lotSize,
      leverage: strategy.leverage,
      clientOrderId: `clOrdId_V35_MARTIN_ADD_${strategy.id}_${nextLayer}_${Date.now()}`,
      ...orderPolicyFields({
        strategyId: strategy.id,
        source: "EXECUTOR",
        reasonCode: `v35_monitor_martin_layer_${nextLayer}`,
      }),
    });

    await createTrade({
      strategyId: strategy.id,
      userId: strategy.userId,
      exchange: strategy.exchange,
      symbol: strategy.symbol,
      side: state.entryTrendBull ? "buy" : "sell",
      orderType: "market",
      orderId: orderResult.orderId,
      ...tradeFillRecordFields(orderResult, currentPrice, lotSize),
      status: orderResult.success ? "filled" : "failed",
      triggerSource: "martin_add_layer",
    });

    if (orderResult.success) {
      // 🔥 方案 A：優先使用 OKX 實際成交數據（filledPrice/filledSize），而非理論值
      const resolvedFill = resolveTradeFill(orderResult, currentPrice, lotSize);
      const actualPrice = resolvedFill.price ?? currentPrice;
      const actualSize = resolvedFill.size;

      const newState: StrategyState = {
        ...state,
        currentLayer: nextLayer,
        totalSize: state.totalSize + actualSize,
        avgPrice: (state.totalCost + actualSize * actualPrice) / (state.totalSize + actualSize),
        totalCost: state.totalCost + actualSize * actualPrice,
        capital: state.capital - (actualSize * actualPrice),
        lastLayerPrice: actualPrice, // 更新 lastLayerPrice 為實際成交價格
      };
      await saveStrategyState(strategy.id, newState);
      console.log(
        `[V35Monitor] 馬丁加倉：策略 ${strategy.id} 第 ${newState.currentLayer} 層 ${actualSize} @ ${actualPrice}（理論: ${lotSize} @ ${currentPrice}），新均價 ${newState.avgPrice.toFixed(2)}`,
      );

      // 寫入訊號日誌，讓「上次檢測」時間更新
      try {
        await createSignal({
          strategyId: strategy.id,
          userId: strategy.userId,
          rawPayload: JSON.stringify({
            action: "add_layer",
            symbol: strategy.symbol,
            layer: newState.currentLayer,
            size: actualSize,
            price: actualPrice,
            source: "v35_monitor",
          }),
          parsedAction: "buy",
          parsedSymbol: strategy.symbol,
          status: "executed",
          message: `[Auto] [加倉第${newState.currentLayer}層] V3.5 賣出 ${actualSize} ${strategy.symbol} @ ${actualPrice}（第 ${newState.currentLayer} 層，均價 ${newState.avgPrice.toFixed(2)}）`,
          source: "auto",
        });
      } catch (e) {
        console.error(`[V35Monitor] 加倉寫入訊號日誌失敗`, e);
      }

      await notifyOwner(
        `📊 馬丁加倉 - 策略 #${strategy.id} ${strategy.name}`,
        `第 ${newState.currentLayer}/${cfg.Max_Layers} 層，加倉 ${actualSize} ${strategy.symbol} @ ${actualPrice}${orderResult.filledPrice ? ' (實際成交)' : ' (理論價)'}\n新均價：${newState.avgPrice.toFixed(2)}\n總持倉：${newState.totalSize}`,
      );
    } else {
      console.error(`[V35Monitor] 馬丁加倉下單失敗：${orderResult.errorMessage}`);
    }
  }
  return false; // 未觸發平倉
}

type MaxLossConfigStatus = "configured" | "fallback_missing" | "fallback_invalid";

export function normalizeV4MaxLossPct(
  rawValue: unknown,
  fallback = 5,
): { value: number; status: MaxLossConfigStatus; rawDisplay: string } {
  const rawDisplay = rawValue === undefined
    ? "undefined"
    : rawValue === null
      ? "null"
      : typeof rawValue === "number" && Number.isNaN(rawValue)
        ? "NaN"
        : JSON.stringify(rawValue);

  if (
    rawValue === undefined ||
    rawValue === null ||
    (typeof rawValue === "string" && rawValue.trim() === "")
  ) {
    return { value: fallback, status: "fallback_missing", rawDisplay };
  }
  if (typeof rawValue === "boolean") {
    return { value: fallback, status: "fallback_invalid", rawDisplay };
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 50) {
    return { value: fallback, status: "fallback_invalid", rawDisplay };
  }
  return { value: parsed, status: "configured", rawDisplay };
}

/** 讀取 V35-family 合併配置，並保留硬止損原始值與 V4.1 曝險擴張權限供稽核。 */
function readV4Config(strategy: Strategy): {
  config: V4Config;
  audit: ReturnType<typeof normalizeV4MaxLossPct>;
  allowExpansion: boolean;
  v41Config: NormalizedV41Config | null;
} {
  // 從 strategy.martinState JSON 中讀取擴展配置（__v35Config 鍵，由策略設定 UI 寫入）
  // 🔥 固定金本位馬丁預設值
  const defaults: V4Config = {
    Initial_Capital: 10000,
    First_Order_Pct: 0.3,           // 回退用：30/10000=0.3%
    Max_Loss_Pct: 5.0,              // 硬止損：本金的 5%（= 500 USDT）
    Martin_Step_Pct: 2.0,
    Martin_Layers: [
      { start: 1, end: 4, multiplier: 1.5 },
      { start: 5, end: 9, multiplier: 1.1 },
      { start: 10, end: 11, multiplier: 1.0 },
    ],
    Max_Layers: 11,
    Target_TP_Pct: 1.0,
    Callback_Pct: 0.1,
    K_Line_Period: 30,
    ...normalizeV40EntryGateConfig(),
  };

  const defaultAudit = normalizeV4MaxLossPct(undefined, defaults.Max_Loss_Pct);

  if (strategy.strategyKey === V41_STRATEGY_KEY) {
    const rawV41Config = getBoundStrategyConfig(strategy.martinState, V41_STRATEGY_KEY);
    const validation = validateV41Config(rawV41Config);
    if (validation.valid && validation.config) {
      const canonical = validation.config;
      const maxLossAudit = normalizeV4MaxLossPct(canonical.Max_Loss_Pct, defaults.Max_Loss_Pct);
      return {
        config: {
          Initial_Capital: canonical.Initial_Capital,
          First_Order_Pct: canonical.First_Order_Pct,
          Max_Loss_Pct: maxLossAudit.value,
          Martin_Step_Pct: canonical.Martin_Step_Pct,
          Martin_Layers: canonical.Martin_Layers.map((layer) => ({ ...layer })),
          Max_Layers: canonical.Max_Layers,
          Target_TP_Pct: canonical.Target_TP_Pct,
          Callback_Pct: canonical.Callback_Pct,
          K_Line_Period: canonical.K_Line_Period,
          enableThreeKFilter: canonical.enableThreeKFilter,
          threeKPatternMode: canonical.threeKMode,
          enableKamaDirectionLock: canonical.enableKamaFastSlowCross || canonical.enableKamaPriceVsSlow,
          enableSameDirectionReentry: canonical.enableSameDirectionReentry,
        },
        audit: maxLossAudit,
        allowExpansion: true,
        v41Config: canonical,
      };
    }
    console.error(
      `[V35Monitor][V4.1] 策略 #${strategy.id} canonical 配置無效；保留防守性止損／止盈，禁止加倉與重入：${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；")}`,
    );
    return {
      config: defaults,
      audit: normalizeV4MaxLossPct(rawV41Config, defaults.Max_Loss_Pct),
      allowExpansion: false,
      v41Config: null,
    };
  }

  try {
    const ms = strategy.martinState;
    if (ms && typeof ms === "object") {
      const v35 = (ms as Record<string, unknown>).__v35Config;
      if (v35 && typeof v35 === "object") {
        const c = v35 as Record<string, unknown>;
        const maxLossAudit = normalizeV4MaxLossPct(c.Max_Loss_Pct, defaults.Max_Loss_Pct);
        const entryGates = normalizeV40EntryGateConfig(c);
        return { config: {
          Initial_Capital: Number.isFinite(Number(c.Initial_Capital)) && Number(c.Initial_Capital) > 0 ? Number(c.Initial_Capital) : defaults.Initial_Capital,
          First_Order_Pct: Number.isFinite(Number(c.First_Order_Pct)) ? Number(c.First_Order_Pct) : defaults.First_Order_Pct,
          Max_Loss_Pct: maxLossAudit.value,
          Martin_Step_Pct: Number.isFinite(Number(c.Martin_Step_Pct)) ? Number(c.Martin_Step_Pct) : (Number.isFinite(Number((strategy as any).martinSpacingPct)) && Number((strategy as any).martinSpacingPct) > 0 ? Number((strategy as any).martinSpacingPct) : defaults.Martin_Step_Pct),
          Martin_Layers: (() => {
            // 🔥 修復：Martin_Layers 可能是 JSON 字串或陣列，統一用 parseMartinLayersStrict 解析
            try {
              const parsed = parseMartinLayersStrict(c.Martin_Layers);
              return parsed && parsed.length > 0 ? parsed : defaults.Martin_Layers;
            } catch {
              return defaults.Martin_Layers;
            }
          })(),
          Max_Layers: Number.isFinite(Number(c.Max_Layers)) ? Number(c.Max_Layers) : defaults.Max_Layers,
          Target_TP_Pct: Number.isFinite(Number(c.Target_TP_Pct)) ? Number(c.Target_TP_Pct) : defaults.Target_TP_Pct,
          Callback_Pct: Number.isFinite(Number(c.Callback_Pct)) ? Number(c.Callback_Pct) : defaults.Callback_Pct,
          K_Line_Period: Number.isFinite(Number(c.K_Line_Period)) && Number(c.K_Line_Period) > 0 ? Number(c.K_Line_Period) : defaults.K_Line_Period,
          ...entryGates,
        }, audit: maxLossAudit, allowExpansion: true, v41Config: null };
      }
    }
  } catch {
    // 解析失敗使用預設
  }
  return { config: defaults, audit: defaultAudit, allowExpansion: true, v41Config: null };
}

async function evaluateV41LiveReentry(
  strategy: Strategy,
  adapter: ExchangeAdapter,
  state: StrategyState,
  config: NormalizedV41Config,
): Promise<{ allowed: boolean; reason: string }> {
  try {
    const closedBars = await fetchKLineData(
      adapter,
      strategy.symbol,
      config.K_Line_Period,
      100,
      true,
    );
    const latest = closedBars.at(-1);
    if (!latest) return { allowed: false, reason: "V4.1 原地重入缺少已收盤 K 線" };
    const closes = closedBars.map((bar) => bar.close);
    const fastKama = calculateKAMA(
      closes,
      config.KAMA_Fast_Length,
      config.p2_fastest,
      config.p3_slowest,
    );
    const slowKama = calculateKAMA(
      closes,
      config.KAMA_Slow_Length,
      config.q2_fastest,
      config.q3_slowest,
    );
    const originalDirection = state.isLong ? "long" as const : "short" as const;
    const result = evaluateV41SameDirectionReentry({
      config,
      closedBars,
      decisionBarTimestamp: latest.timestamp,
      decisionClose: latest.close,
      fastKama,
      slowKama,
      allowedDirection: strategy.direction as "long" | "short" | "both",
      requestedDirection: originalDirection,
      originalDirection,
    });
    return { allowed: result.allowed, reason: `${result.reasonCode}｜${result.reason}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { allowed: false, reason: `V4.1 原地重入行情／判定失敗（fail-closed）：${detail}` };
  }
}

/**
 * O3：實盤 KAMA 雙線計算（僅用於順勢重入方向確認；從公開行情 API 拓最近 K 線，與回測引擎同一 KAMA 公式）
 * 失敗時回傳 null（跳過重入判斷，不阻斷其他風控）
 */
async function computeLiveKama(
  strategy: Strategy,
  cfg: V4Config,
): Promise<{ fast: number; slow: number } | null> {
  try {
    const timeframe = `${cfg.K_Line_Period}m`;
    const tfMs = getTimeframeMilliseconds(timeframe);
    const lookback = 130; // KAMA_Length 50 + 緩衝
    const endMs = Date.now();
    const startMs = endMs - tfMs * lookback;
    const candles =
      strategy.exchange === "bybit"
        ? await fetchBybitCandles(strategy.symbol, timeframe, startMs, endMs)
        : await fetchOKXCandles(strategy.symbol, timeframe, startMs, endMs);
    if (candles.length < 60) return null;
    const closes = candles.map((c) => c.close);
    const fast = calculateKAMA(closes, 50, 10, 2);
    const slow = calculateKAMA(closes, 50, 10, 6);
    if (fast === null || slow === null) return null;
    return { fast, slow };
  } catch (e: unknown) {
    console.warn("[V35Monitor] KAMA 實盤計算失敗（跳過反轉檢查）:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * O3：執行第 0 層順勢重入（市價重入首單，重置狀態為新一輪）
 */
async function executeReentry(
  strategy: Strategy,
  adapter: ExchangeAdapter,
  prevState: StrategyState,
  currentPrice: number,
  currentTrendBull: boolean,
  cfg: V4Config,
): Promise<boolean> {
  try {
    const firstOrderValue = getFirstOrderValue(cfg);
    const lotSize = firstOrderValue / currentPrice;

    const orderResult = await adapter.placeOrder({
      symbol: strategy.symbol,
      side: currentTrendBull ? "buy" : "sell",
      orderType: "market",
      size: lotSize,
      leverage: strategy.leverage,
      clientOrderId: `clOrdId_V35_REENTRY_${strategy.id}_${Date.now()}`,
      ...orderPolicyFields({
        strategyId: strategy.id,
        source: "EXECUTOR",
        reasonCode: "v35_monitor_trend_reentry",
      }),
    });

    await createTrade({
      strategyId: strategy.id,
      userId: strategy.userId,
      exchange: strategy.exchange,
      symbol: strategy.symbol,
      side: currentTrendBull ? "buy" : "sell",
      orderType: "market",
      orderId: orderResult.orderId,
      ...tradeFillRecordFields(orderResult, currentPrice, lotSize),
      status: orderResult.success ? "filled" : "failed",
      triggerSource: "trend_reentry",
    });

    if (!orderResult.success) {
      console.error(`[V35Monitor] 順勢重入下單失敗：${orderResult.errorMessage}`);
      return false;
    }

    const resolvedFill = resolveTradeFill(orderResult, currentPrice, lotSize);
    const actualPrice = resolvedFill.price ?? currentPrice;
    const actualSize = resolvedFill.size;

    // 重置狀態（新一輪開始，保留入場方向），使用實際成交價量。
    const newState = buildReentryState({
      currentPrice: actualPrice,
      lotSize: actualSize,
      entryTrendBull: currentTrendBull,
      isLong: currentTrendBull, // 重入方向與趨勢一致
      capital: cfg.Initial_Capital,
    });

    await saveStrategyState(strategy.id, newState);
    console.log(
      `[V35Monitor] O3 順勢重入完成：策略 ${strategy.id} ${currentTrendBull ? "買升" : "買跌"} ${actualSize} @ ${actualPrice}`,
    );
    return true;
  } catch (e: unknown) {
    console.error("[V35Monitor] 順勢重入失敗:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** 市價全平 + 記錄 + 狀態重置（含分流冷卻） */
async function executeFullClose(
  strategy: Strategy,
  adapter: ExchangeAdapter,
  state: StrategyState,
  triggerSource: string,
  reason: string,
  opts: { disable: boolean; cooldownMinutes: number },
): Promise<{ positionClosed: boolean; strategyDisabled: boolean }> {
  let positionClosed = false;
  let exitPrice = 0;
  let pnl: number | undefined;
  let orderId: string | undefined;
  let exchangeCloseResult: OrderResult | undefined;
  try {
    const closeDir = state.entryTrendBull ? "long" : "short";
    const emergencyReason = triggerSource === "hard_stop_loss" ? "STOP_LOSS" as const : undefined;
    const result = await adapter.closePositionSmart(
      strategy.symbol,
      closeDir,
      undefined,
      undefined,
      `clOrdId_V35_FULL_CLOSE_${strategy.id}_${Date.now()}`,
      closePolicyOptions({
        strategyId: strategy.id,
        source: "RISK",
        reasonCode: triggerSource,
      }, emergencyReason),
    );
    exchangeCloseResult = result;
    positionClosed = result.success;
    orderId = result.orderId;
    if (result.success) {
      exitPrice = result.filledPrice || 0;
      const dirMult = state.entryTrendBull ? 1 : -1;
      pnl = (exitPrice > 0 && state.avgPrice > 0 && state.totalSize > 0)
        ? (exitPrice - state.avgPrice) * state.totalSize * dirMult
        : undefined;
    }
  } catch (e: unknown) {
    console.error(`[V35Monitor] 全平失敗:`, e instanceof Error ? e.message : e);
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
        triggerSource,
        totalSize: state.totalSize,
        source: "v35_monitor",
      }),
      parsedAction: "close",
      parsedSymbol: strategy.symbol,
      parsedPrice: exitPrice > 0 ? String(exitPrice) : undefined,
      status: positionClosed ? "executed" : "failed",
      orderId,
      message: positionClosed
        ? `[V3.5 Monitor] ${strategy.symbol} ${reason}，平倉成功${pnlStr}`
        : `[V3.5 Monitor] ${strategy.symbol} ${reason}，平倉失敗`,
      source: "auto",
    });
  } catch (e) {
    console.error(`[V35Monitor] executeFullClose 寫入訊號日誌失敗`, e);
  }

  // 寫入交易記錄（含 signalId 關聯）
  if (positionClosed && exchangeCloseResult) {
    try {
      await createTrade({
        strategyId: strategy.id,
        userId: strategy.userId,
        signalId,
        exchange: strategy.exchange,
        symbol: strategy.symbol,
        side: state.entryTrendBull ? "sell" : "buy",
        orderType: "market",
        orderId,
        ...tradeFillRecordFields(exchangeCloseResult, undefined, state.totalSize),
        realizedPnl: pnl !== undefined ? String(pnl.toFixed(6)) : undefined,
        reduceOnly: true,
        status: "filled",
        triggerSource,
      });
    } catch (e) {
      console.error(`[V35Monitor] createTrade 失敗`, e);
    }
  }

  let strategyDisabled = false;
  if (positionClosed) {
    // 僅在交易所確認平倉後重置本地狀態；失敗時保留持倉狀態供下一輪重試。
    const newState = createInitialStrategyState();
    if (opts.cooldownMinutes > 0) {
      newState.isCooldown = true;
      newState.cooldownUntil = Date.now() + opts.cooldownMinutes * 60 * 1000;
    }
    await saveStrategyState(strategy.id, newState);

    if (opts.disable) {
      strategyDisabled = await disableStrategySystem(strategy.id, reason);
    }
  }

  await createRiskEvent({
    strategyId: strategy.id,
    userId: strategy.userId,
    eventType: triggerSource.includes("stop") ? "stop_loss" : "take_profit",
    detail: `[V4.0] ${reason}`,
    positionClosed,
    strategyDisabled,
  });
  return { positionClosed, strategyDisabled };
}
