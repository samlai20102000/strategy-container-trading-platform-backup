import type { Strategy } from "../../drizzle/schema";
import {
  createSignal,
  createTrade,
  disableStrategySystem,
  getApiKeyById,
  getStrategyById,
  getTodayRealizedPnl,
  updateSignal,
  updateStrategyMartinState,
  updateTrade,
} from "../db";
import { createAdapter } from "../exchanges/factory";
import type { ExchangeAdapter } from "../exchanges/types";
import type { MartinState, StrategyState } from "../strategies/base";
import { BaseStrategyV35, createInitialStrategyState } from "../strategies/base";
import { getStrategy, initStrategyStudio } from "./strategyStudio";
import { acquireBarLock } from "./barLock";
import { MartingaleEngine, parseMartinLayers } from "./martingaleEngine";
import { calculateMaxLayersFromConfig } from "./parameterValidator";
import { loadStrategyState, saveStrategyState } from "./strategyStateManager";
import { normalizeQtyForSymbol } from "./symbolSpecs";
import { TradingPairManager } from "./tradingPairManager";
import { StrategySymbolAdapter, StrategyAdapters } from "./strategySymbolAdapter";
import { StrategyKama3kV70 } from "../strategies/v70/strategy_kama_3k_v70";
import { StrategyKama3kBreakoutV25 } from "../strategies/v25/strategy_kama_3k_breakout_v25";
import {
  applyV25CloseToState,
  applyV25FillToState,
  type V25CloseReason,
  type V25RuntimeState,
} from "../strategies/v25/core";
import {
  getV25MartinRangeForLayer,
  V25_STRATEGY_KEY,
} from "../../shared/strategies/kama3kBreakoutV25";
import {
  RAINBOW_20415_STRATEGY_KEY,
  validateRainbow20415Config,
  type Rainbow20415BaseLot,
} from "../../shared/strategies/rainbow20415";
import {
  applyRainbow20415CloseToState,
  applyRainbow20415FillToState,
  evaluateRainbow20415Management,
  Rainbow20415CloseReason,
  type Rainbow20415CoreAction,
} from "../strategies/rainbow20415/core";
import { getBoundStrategyConfig } from "./strategySnapshotConfig";

/**
 * 策略執行引擎
 * 接收解析後的 TradingView 訊號，套用風險檢查後於對應交易所下單
 */

export interface ParsedSignal {
  action: "buy" | "sell" | "close";
  symbol?: string;
  price?: number;
  /** V3.5：K 線時間戳（Bar-Lock 去重用） */
  barTimestamp?: number;
  reason?: string; // 策略引擎提供的理由
  confidence?: number; // 信號信心度 (0-1)
  /** V6.1：波動率調整後的首單金額（USDT） */
  lotUsdt?: number;
  /** V2.5 內部決策封印；parseSignalPayload 不映射外部同名欄位。 */
  v25Decision?: boolean;
  v25LayerNum?: number;
  v25CloseReason?: V25CloseReason;
  /** 20415 內部決策封印；外部 Webhook 解析器永不映射這些欄位。 */
  rainbow20415Decision?: boolean;
  rainbow20415Action?: Rainbow20415CoreAction;
  rainbow20415LayerNum?: number;
  rainbow20415CloseReason?: Rainbow20415CloseReason;
  rainbow20415OrderSize?: Rainbow20415BaseLot;
}

/**
 * 解析 TradingView webhook payload
 * 支援格式：
 *   { "action": "buy" | "sell" | "close", "symbol": "BTCUSDT", "price": 62450 }
 *   { "side": "buy", ... } / { "signal": "BUY", ... } 等變體
 */
export function parseSignalPayload(payload: any): ParsedSignal | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = String(
    payload.action ?? payload.side ?? payload.signal ?? "",
  ).toLowerCase();

  let action: ParsedSignal["action"] | null = null;
  if (["buy", "long", "open_long"].includes(raw)) action = "buy";
  else if (["sell", "short", "open_short"].includes(raw)) action = "sell";
  else if (["close", "exit", "close_all", "flat"].includes(raw)) action = "close";
  if (!action) return null;

  const price = payload.price !== undefined ? parseFloat(String(payload.price)) : undefined;
  const barTs =
    payload.bar_timestamp !== undefined
      ? parseInt(String(payload.bar_timestamp), 10)
      : payload.barTimestamp !== undefined
        ? parseInt(String(payload.barTimestamp), 10)
        : payload.time !== undefined
          ? Date.parse(String(payload.time)) || parseInt(String(payload.time), 10)
          : undefined;
  return {
    action,
    symbol: payload.symbol ? String(payload.symbol) : undefined,
    price: Number.isFinite(price) ? price : undefined,
    barTimestamp: Number.isFinite(barTs) ? barTs : undefined,
  };
}

export interface ExecutionResult {
  status: "executed" | "failed" | "rejected" | "skipped";
  message: string;
  orderId?: string;
  exchangeResponse?: string;
}

/**
 * 執行訊號：完整流程（風險檢查 → 下單 → 記錄）
 */
export async function executeSignal(
  strategy: Strategy,
  signal: ParsedSignal,
  signalId: number,
): Promise<ExecutionResult> {
    // 0. 統一交易對驗證和標準化（應用於所有策略）
  // ★ 先獲取 API Key 的 isTestnet 狀態，用於交易對驗證
  let isTestnet = false;
  try {
    const apiKeyForValidation = await getApiKeyById(strategy.apiKeyId);
    isTestnet = apiKeyForValidation?.isTestnet ?? false;
  } catch { /* ignore */ }

  try {
    const { prepareSymbolForExecution } = await import('./symbolMiddleware');
    const symbolResult = await prepareSymbolForExecution(
      strategy.symbol,
      strategy.strategyKey || 'default',
      'SWAP',
      isTestnet,
    );
    if (!symbolResult.valid) {
      return {
        status: 'failed',
        message: `交易對驗證失敗: ${symbolResult.error}`,
      };
    }
    // 更新為標準化的交易對名稱
    strategy.symbol = symbolResult.normalized;
  } catch (error) {
    console.error('[executor] 交易對驗證異常:', error);
    // 不中斷執行，繼續使用原始交易對
  }

  // 1. 檢查方向限制
  if (signal.action === "buy" && strategy.direction === "short") {
    return { status: "skipped", message: "策略僅允許做空，忽略買入訊號" };
  }
  if (signal.action === "sell" && strategy.direction === "long") {
    return { status: "skipped", message: "策略僅允許做多，忽略賣出訊號" };
  }

  // 2. 取得 API 金鑰並建立轉接器
  const apiKeyRecord = await getApiKeyById(strategy.apiKeyId);
  if (!apiKeyRecord) {
    return { status: "failed", message: "找不到策略綁定的 API 金鑰" };
  }
  let adapter: ExchangeAdapter;
  try {
    adapter = createAdapter(apiKeyRecord);
  } catch (e: any) {
    return { status: "failed", message: `建立交易所連線失敗: ${e.message}` };
  }

  // 3. 每日虧損上限檢查
  const maxDailyLoss = parseFloat(strategy.maxDailyLoss);
  if (maxDailyLoss > 0) {
    const todayPnl = await getTodayRealizedPnl(strategy.id);
    if (todayPnl <= -maxDailyLoss) {
      await handleDailyLossBreach(strategy, adapter, todayPnl);
      return {
        status: "rejected",
        message: `今日虧損 ${todayPnl.toFixed(2)} USDT 已達上限 ${maxDailyLoss}，已自動平倉並停用策略`,
      };
    }
  }

  // V2.5 全動作使用獨立管線。必須先於通用 close，才能正確保存止盈重入與峰值狀態。
  if (strategy.strategyKey === V25_STRATEGY_KEY) {
    await initStrategyStudio();
    const v25Engine = getStrategy(strategy.strategyKey);
    if (!(v25Engine instanceof StrategyKama3kBreakoutV25)) {
      return { status: "failed", message: "V2.5 策略引擎未正確載入" };
    }
    return executeSignalV25(
      strategy,
      signal,
      signalId,
      v25Engine,
      adapter,
      apiKeyRecord,
    );
  }

  // 4. 平倉訊號
  if (signal.action === "close") {
    // 從交易所查詢真實持倉方向（OKX 雙向持倉模式必須指定 posSide）
    let closePosSide: "long" | "short" | undefined;
    try {
      const positions = await adapter.getPositions(strategy.symbol);
      const activePos = positions.find((p) => p.size > 0);
      if (activePos) closePosSide = activePos.side as "long" | "short";
    } catch {
      // 查詢失敗時嘗試從馬丁狀態推斷
      const ms = (strategy as any).martinState;
      if (ms?.isLong === true) closePosSide = "long";
      else if (ms?.isLong === false) closePosSide = "short";
    }
    console.log(`[executor] 平倉訊號 策略 ${strategy.id} posSide=${closePosSide ?? "unknown"}`);
    const result = await adapter.closePositionSmart(strategy.symbol, closePosSide);
    if (result.success) {
      await createTrade({
        strategyId: strategy.id,
        userId: strategy.userId,
        signalId,
        exchange: strategy.exchange,
        symbol: strategy.symbol,
        side: closePosSide === "short" ? "buy" : "sell",
        orderType: "market",
        orderId: result.orderId,
        size: "0",
        reduceOnly: true,
        status: "filled",
        triggerSource: "webhook",
      });
      return {
        status: "executed",
        message: "平倉指令已執行",
        orderId: result.orderId,
        exchangeResponse: result.rawResponse,
      };
    }
    return {
      status: "failed",
      message: result.errorMessage || "平倉失敗",
      exchangeResponse: result.rawResponse,
    };
  }

  // 5. 策略引擎決策（若綁定 strategyKey，由策略代碼決定動作與倉位，含馬丁加倉）
  let size = parseFloat(strategy.positionSize ?? '0');
  let engineReason = "";
  if (strategy.strategyKey) {
    await initStrategyStudio();
    const engine = getStrategy(strategy.strategyKey);
    if (!engine) {
      return {
        status: "failed",
        message: `策略引擎「${strategy.strategyKey}」未載入，請至策略工作室重新註冊`,
      };
    }

    // ===== V7.0 策略專用管線（KAMA_3K_TORNADO_V70）=====
    if (strategy.strategyKey === 'KAMA_3K_TORNADO_V70' && engine instanceof BaseStrategyV35) {
      return executeSignalV70(strategy, signal, signalId, engine, adapter);
    }

    // ===== V6.1 策略專用管線（KAMA_3K_HF_V61）=====
    if (strategy.strategyKey === 'KAMA_3K_HF_V61' && engine instanceof BaseStrategyV35) {
      return executeSignalV61(strategy, signal, signalId, engine, adapter);
    }

    // ===== V5.0 策略專用管線（KAMA_3K_ULTIMATE_V50）=====
    if (strategy.strategyKey === 'KAMA_3K_ULTIMATE_V50' && engine instanceof BaseStrategyV35) {
      return executeSignalV50(strategy, signal, signalId, engine, adapter);
    }

    // ===== V3.5 策略專用管線（BaseStrategyV35）=====
    if (engine instanceof BaseStrategyV35) {
      return executeSignalV35(strategy, signal, signalId, engine, adapter);
    }

    // ===== 20415 七彩虹策略專用管線 =====
    if (strategy.strategyKey === RAINBOW_20415_STRATEGY_KEY) {
      return executeSignalRainbow20415(strategy, signal, signalId, engine, adapter);
    }

    const martinState = getMartinState(strategy);
    const decision = engine.generateActions(
      {
        action: signal.action === "buy" ? "BUY" : signal.action === "sell" ? "SELL" : "CLOSE",
        symbol: signal.symbol || strategy.symbol,
        price: signal.price ?? 0,
      },
      {
        id: strategy.id,
        symbol: strategy.symbol,
        direction: strategy.direction as "long" | "short" | "both",
        positionSize: parseFloat(strategy.positionSize ?? '0'),
        leverage: strategy.leverage,
        config: {
          martin_multiplier: parseFloat(strategy.martinMultiplier),
          max_martin_level: strategy.maxMartinLevel,
          initial_lot: parseFloat(strategy.positionSize ?? '0'),
        },
      },
      null, // 市場資料（EMA/ATR）由策略自行容錯；無資料時信任訊號方向
      martinState,
    );

    if (decision.action === "HOLD") {
      return { status: "skipped", message: `策略引擎決定觀望：${decision.reason || "HOLD"}` };
    }
    if (decision.action === "CLOSE_ALL") {
      // 從交易所查詢真實持倉方向（OKX 雙向持倉模式必須指定 posSide）
      let genericClosePosSide: "long" | "short" | undefined;
      try {
        const positions = await adapter.getPositions(strategy.symbol);
        const activePos = positions.find((p) => p.size > 0);
        if (activePos) genericClosePosSide = activePos.side as "long" | "short";
      } catch {
        const ms = martinState;
        if (ms?.lastEntryPrice > 0) {
          // 嘗試從馬丁狀態推斷（僅作 fallback）
          genericClosePosSide = undefined;
        }
      }
      console.log(`[executor] 通用引擎 CLOSE_ALL 策略 ${strategy.id} posSide=${genericClosePosSide ?? "unknown"}`);
      const result = await adapter.closePositionSmart(strategy.symbol, genericClosePosSide);
      if (result.success) {
        await createTrade({
          strategyId: strategy.id,
          userId: strategy.userId,
          signalId,
          exchange: strategy.exchange,
          symbol: strategy.symbol,
          side: genericClosePosSide === "short" ? "buy" : "sell",
          orderType: "market",
          orderId: result.orderId,
          size: "0",
          reduceOnly: true,
          status: "filled",
          triggerSource: "webhook",
        });
        return {
          status: "executed",
          message: `策略引擎平倉：${decision.reason || ""}`,
          orderId: result.orderId,
          exchangeResponse: result.rawResponse,
        };
      }
      return { status: "failed", message: result.errorMessage || "平倉失敗", exchangeResponse: result.rawResponse };
    }
    // OPEN_LONG / OPEN_SHORT：覆寫下單方向與倉位
    signal = {
      ...signal,
      action: decision.action === "OPEN_LONG" ? "buy" : "sell",
    };
    if (decision.lotSize > 0) size = decision.lotSize;
    engineReason = decision.reason || "";
    // 記錄本次進場價與倉位（馬丁狀態）
    if (signal.price) {
      await updateStrategyMartinState(strategy.id, {
        ...martinState,
        currentLot: size,
        lastEntryPrice: signal.price,
      });
    }
  }
  const maxPositionPct = parseFloat(strategy.maxPositionPct);
  if (maxPositionPct > 0 && signal.price) {
    try {
      const balance = await adapter.getBalance();
      const maxNotional = (balance.total * maxPositionPct) / 100;
      const orderNotional = (size * signal.price) / Math.max(strategy.leverage, 1);
      if (orderNotional > maxNotional && maxNotional > 0) {
        const cappedSize = (maxNotional * Math.max(strategy.leverage, 1)) / signal.price;
        size = Math.max(cappedSize, 0);
        if (size <= 0) {
          return {
            status: "rejected",
            message: `下單金額超過最大倉位比例 ${maxPositionPct}% 限制`,
          };
        }
      }
    } catch (e: any) {
      // 餘額查詢失敗時保守拒絕，避免超額下單
      return {
        status: "failed",
        message: `查詢餘額失敗，無法執行倉位比例檢查: ${e.message}`,
      };
    }
  }

  // 6. 下單（此處 action 已排除 close，僅剩 buy/sell）
  const orderSide: "buy" | "sell" = signal.action === "sell" ? "sell" : "buy";

  // 第二輪優化 3：依交易對規格對數量做步長取整與最小量檢查，避免被交易所拒單
  try {
    const norm = await normalizeQtyForSymbol(strategy.exchange, strategy.symbol, size, "linear");
    if (norm.rejected) {
      return {
        status: "rejected",
        message: `下單數量不符交易所規格：${norm.reason}`,
      };
    }
    if (norm.adjusted) {
      console.log(`[Executor] 數量已依規格校正：${norm.reason}`);
      size = norm.qty;
    }
  } catch (e: any) {
    // 規格獲取失敗不阻擋下單，由交易所端最終校驗
    console.warn(`[Executor] 規格正規化跳過：${e.message}`);
  }

  const orderResult = await adapter.placeOrder({
    symbol: strategy.symbol,
    side: orderSide,
    orderType: strategy.orderType,
    size,
    price: strategy.orderType === "limit" ? signal.price : undefined,
    leverage: strategy.leverage,
  });

  // 7. 記錄交易
  const tradeId = await createTrade({
    strategyId: strategy.id,
    userId: strategy.userId,
    signalId,
    exchange: strategy.exchange,
    symbol: strategy.symbol,
    side: orderSide,
    orderType: strategy.orderType,
    orderId: orderResult.orderId,
    size: String(size),
    price: signal.price !== undefined ? String(signal.price) : undefined,
    status: orderResult.success ? "filled" : "failed",
    triggerSource: "webhook",
  });

  if (orderResult.success) {
    return {
      status: "executed",
      message: `[開倉] ${signal.action === "buy" ? "買入" : "賣出"} ${size} ${strategy.symbol} 下單成功${engineReason ? `（${engineReason}）` : ""}`,
      orderId: orderResult.orderId,
      exchangeResponse: orderResult.rawResponse,
    };
  }
  return {
    status: "failed",
    message: orderResult.errorMessage || "下單失敗",
    exchangeResponse: orderResult.rawResponse,
  };
}

/**
 * ===== 20415 七彩虹專用執行管線 =====
 *
 * 自動信號只傳遞由伺服器核心產生的封印決策；Webhook／手動 BUY、SELL
 * 只能在空倉建立底倉，或於核心以即時價格重新確認階梯條件後加倉。
 * 所有狀態轉移都發生在交易所成功回報之後。
 */
async function executeSignalRainbow20415(
  strategy: Strategy,
  signal: ParsedSignal,
  signalId: number,
  _engine: any,
  adapter: ExchangeAdapter,
): Promise<ExecutionResult> {
  const state = loadStrategyState(strategy);
  const martinState = strategy.martinState && typeof strategy.martinState === "object"
    ? strategy.martinState as Record<string, unknown>
    : {};
  const rawConfig = getBoundStrategyConfig(martinState, RAINBOW_20415_STRATEGY_KEY)
    ?? martinState.__v2_0Config
    ?? {};
  const validation = validateRainbow20415Config(rawConfig);
  if (!validation.valid) {
    return {
      status: "rejected",
      message: `20415 七彩虹參數校驗失敗：${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`,
    };
  }
  const config = validation.config;
  const hasPosition = state.currentLayer > 0 && state.totalSize > 0 && state.avgPrice > 0;
  const currentPrice = Number(signal.price) || 0;
  const now = Date.now();
  let account: Awaited<ReturnType<ExchangeAdapter["getBalance"]>> | undefined;
  try {
    account = await adapter.getBalance();
  } catch (error: any) {
    console.warn(`[Executor][20415] 真實帳戶資料取得失敗：${error.message}`);
  }

  let action: Rainbow20415CoreAction;
  let orderSize: Rainbow20415BaseLot | undefined;
  let targetLayer: number | undefined;
  let closeReason: Rainbow20415CloseReason | undefined;
  let decisionReason = signal.reason || "外部指令";

  if (signal.rainbow20415Decision === true && signal.rainbow20415Action) {
    action = signal.rainbow20415Action;
    orderSize = signal.rainbow20415OrderSize;
    targetLayer = signal.rainbow20415LayerNum;
    closeReason = signal.rainbow20415CloseReason;
  } else if (signal.action === "close") {
    action = "close";
    closeReason = "MANUAL";
    decisionReason = signal.reason || "手動／Webhook 平倉";
  } else if (!hasPosition) {
    action = signal.action === "buy" ? "buy" : "sell";
    orderSize = { ...config.Base_Lot_Size };
    targetLayer = 1;
    decisionReason = signal.reason || `手動／Webhook ${action === "buy" ? "做多" : "做空"}底倉`;
  } else {
    const expectedBuy = state.isLong;
    if ((signal.action === "buy") !== expectedBuy) {
      return {
        status: "skipped",
        message: `20415 盲人模式拒絕反向指令：目前為${state.isLong ? "多" : "空"}倉 L${state.currentLayer}`,
      };
    }
    const management = evaluateRainbow20415Management(
      {
        currentPrice,
        now,
        account: account ? { equity: account.total, balance: account.total, usedMargin: account.usedMargin } : undefined,
      },
      state,
      config,
    );
    if (management.action !== "add_long" && management.action !== "add_short") {
      return { status: "skipped", message: `20415 盲人模式未授權加倉：${management.reason}` };
    }
    action = management.action;
    orderSize = management.orderSize;
    targetLayer = management.layerNum;
    decisionReason = management.reason;
  }

  // 在執行瞬間重新檢查持倉風控，避免生成信號後至下單前帳戶狀態變化。
  if (hasPosition && action !== "close") {
    const management = evaluateRainbow20415Management(
      {
        currentPrice,
        now,
        account: account ? { equity: account.total, balance: account.total, usedMargin: account.usedMargin } : undefined,
      },
      state,
      config,
    );
    if (management.action === "close") {
      action = "close";
      closeReason = management.closeReason;
      decisionReason = management.reason;
    } else if (management.action !== "add_long" && management.action !== "add_short") {
      return { status: "skipped", message: `20415 執行前風控取消加倉：${management.reason}` };
    } else {
      action = management.action;
      orderSize = management.orderSize;
      targetLayer = management.layerNum;
      decisionReason = management.reason;
    }
  }

  if (action === "hold") {
    return { status: "skipped", message: `20415 七彩虹觀望：${decisionReason}` };
  }

  if (action === "close") {
    if (!hasPosition) return { status: "skipped", message: "20415 無本地持倉可平倉" };
    const result = await adapter.closePositionSmart(strategy.symbol, state.isLong ? "long" : "short");
    if (!result.success) {
      return { status: "failed", message: result.errorMessage || "20415 平倉失敗", exchangeResponse: result.rawResponse };
    }
    const exitPrice = result.filledPrice || currentPrice;
    const pnl = exitPrice > 0
      ? (exitPrice - state.avgPrice) * state.totalSize * (state.isLong ? 1 : -1)
      : undefined;
    await createTrade({
      strategyId: strategy.id,
      userId: strategy.userId,
      signalId,
      exchange: strategy.exchange,
      symbol: strategy.symbol,
      side: state.isLong ? "sell" : "buy",
      orderType: "market",
      orderId: result.orderId,
      size: String(state.totalSize),
      price: exitPrice > 0 ? String(exitPrice) : undefined,
      realizedPnl: pnl !== undefined ? String(pnl.toFixed(6)) : undefined,
      reduceOnly: true,
      status: "filled",
      triggerSource: "webhook",
    });
    const resolvedCloseReason = closeReason ?? "MANUAL";
    const nextState = applyRainbow20415CloseToState(state, resolvedCloseReason, config, now);
    await saveStrategyState(strategy.id, nextState);
    try {
      const { releaseAllLocks } = await import("./barLock");
      await releaseAllLocks(strategy.id);
    } catch (error: any) {
      console.warn(`[Executor][20415] 清除 Bar-Lock 失敗：${error.message}`);
    }
    return {
      status: "executed",
      message: `[20415 七彩虹平倉] ${decisionReason}${config.Reentry_Enabled ? `；${config.Reentry_Cooldown_Minutes} 分鐘後重判七線` : ""}`,
      orderId: result.orderId,
      exchangeResponse: result.rawResponse,
    };
  }

  const isInitial = action === "buy" || action === "sell";
  const isLong = action === "buy" || action === "add_long";
  if (isInitial && hasPosition) return { status: "skipped", message: "20415 已有持倉，禁止重複底倉" };
  if (!isInitial && !hasPosition) return { status: "skipped", message: "20415 無底倉，禁止直接加倉" };
  if (isLong && strategy.direction === "short") return { status: "skipped", message: "策略僅允許做空" };
  if (!isLong && strategy.direction === "long") return { status: "skipped", message: "策略僅允許做多" };
  if (!orderSize || !(orderSize.value > 0) || !(currentPrice > 0)) {
    return { status: "rejected", message: "20415 下單價格或倉位配置無效" };
  }

  if (isInitial && signal.barTimestamp) {
    const { checkBarLock } = await import("./barLock");
    if (await checkBarLock(strategy.id, signal.barTimestamp)) {
      return { status: "skipped", message: `20415 Bar-Lock 攔截：M30 K 線 ${signal.barTimestamp} 已成交` };
    }
  }
  if (!isInitial && account?.usedMargin == null) {
    return { status: "rejected", message: "20415 缺少交易所真實已用保證金，安全封鎖加倉" };
  }

  let quantity = orderSize.mode === "usdt" ? orderSize.value / currentPrice : orderSize.value;
  try {
    const normalized = await normalizeQtyForSymbol(strategy.exchange, strategy.symbol, quantity, "linear");
    if (normalized.rejected) {
      return { status: "rejected", message: `20415 下單數量不符交易所規格：${normalized.reason}` };
    }
    quantity = normalized.qty;
    if (normalized.adjusted) console.log(`[Executor][20415] 數量校正：${normalized.reason}`);
  } catch (error: any) {
    console.warn(`[Executor][20415] 交易所規格查詢失敗，沿用原量：${error.message}`);
  }

  const orderResult = await adapter.placeOrder({
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: "market",
    size: quantity,
    leverage: strategy.leverage,
  });
  await createTrade({
    strategyId: strategy.id,
    userId: strategy.userId,
    signalId,
    exchange: strategy.exchange,
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: "market",
    orderId: orderResult.orderId,
    size: String(quantity),
    price: String(currentPrice),
    status: orderResult.success ? "filled" : "failed",
    triggerSource: "webhook",
  });
  if (!orderResult.success) {
    return {
      status: "failed",
      message: orderResult.errorMessage || "20415 下單失敗；狀態與 Bar-Lock 未推進",
      exchangeResponse: orderResult.rawResponse,
    };
  }

  const fillPrice = orderResult.filledPrice ?? currentPrice;
  const fillQuantity = orderResult.filledSize ?? quantity;
  const fillAction = action as "buy" | "sell" | "add_long" | "add_short";
  const nextState = applyRainbow20415FillToState(state, {
    action: fillAction,
    fillPrice,
    fillQuantity,
    timestamp: now,
    barTimestamp: signal.barTimestamp,
    targetLayer,
    accountEquity: account?.total,
  });
  await saveStrategyState(strategy.id, nextState);
  if (isInitial && signal.barTimestamp) {
    await acquireBarLock(strategy.id, signal.barTimestamp, config.Entry_Timeframe_Minutes);
  }
  return {
    status: "executed",
    message: `[20415 七彩虹${isInitial ? "底倉" : `加倉 L${nextState.currentLayer}`}] ${isLong ? "買入" : "賣出"} ${fillQuantity} ${strategy.symbol} @ ${fillPrice}；均價 ${nextState.avgPrice.toFixed(4)}；${decisionReason}`,
    orderId: orderResult.orderId,
    exchangeResponse: orderResult.rawResponse,
  };
}

/**
 * ===== V3.5 專用執行管線 =====
 * 依據 Pasted_content_17.txt B.2.3/B.2.4：
 * 1. Bar-Lock 雙重鎖（僅限初始開倉）
 * 2. validateSignal 五層驗證（KAMA 方向鎖、3K 形態、破位、冷卻、Bar-Lock）
 * 3. 馬丁引擎倉位計算與均價更新
 * 4. 狀態持久化
 */
async function executeSignalV35(
  strategy: Strategy,
  signal: ParsedSignal,
  signalId: number,
  engine: BaseStrategyV35,
  adapter: ExchangeAdapter,
): Promise<ExecutionResult> {
  const state = loadStrategyState(strategy);
  const cfg = (strategy as unknown as { config?: Record<string, unknown> }).config ?? {};
  
  // 🔥 修復：讀取 V4.0 完整配置（__v35Config）
  const v35Config = (strategy.martinState && typeof strategy.martinState === 'object' 
    ? (strategy.martinState as Record<string, unknown>).__v35Config 
    : null) as Record<string, unknown> | null;
  
  const mergedCfg: Record<string, number | string | boolean> = {
    ...engine.defaultConfig,
    Base_Lot_Size: strategy.positionSizeObject || engine.defaultConfig.Base_Lot_Size,
    // 倉位雙模式（pasted_content_3.txt 任務 4）：從策略設定帶入 Position_Mode / Position_Value
    Position_Mode: ((strategy as unknown as { positionMode?: string }).positionMode ?? "quantity") as string,
    Position_Value: parseFloat(strategy.positionSize ?? '0') || (typeof engine.defaultConfig.Base_Lot_Size === 'object' ? Number((engine.defaultConfig.Base_Lot_Size as { value: number; mode: string }).value) : Number(engine.defaultConfig.Base_Lot_Size)),
    Martin_Multiplier: parseFloat(strategy.martinMultiplier) || Number(engine.defaultConfig.Martin_Multiplier),
    Max_Layers: strategy.maxMartinLevel || Number(engine.defaultConfig.Max_Layers),
    Martin_Step_Pct: parseFloat(strategy.martinSpacingPct) || Number(engine.defaultConfig.Martin_Step_Pct),
    ...(typeof cfg === "object" ? (cfg as Record<string, number | string | boolean>) : {}),
    // 🔥 V4.0 配置優先級最高（覆蓋默認值和頂層字段）
    ...(v35Config ? (v35Config as Record<string, number | string | boolean>) : {}),
  };

  const instance = {
    id: strategy.id,
    symbol: strategy.symbol,
    direction: strategy.direction as "long" | "short" | "both",
    positionSize: parseFloat(strategy.positionSize ?? '0'),
    leverage: strategy.leverage,
    config: mergedCfg,
    state,
  };

  const engineSignal = {
    action: (signal.action === "buy" ? "BUY" : signal.action === "sell" ? "SELL" : "CLOSE") as
      | "BUY"
      | "SELL"
      | "CLOSE",
    symbol: signal.symbol || strategy.symbol,
    price: signal.price ?? 0,
    barTimestamp: signal.barTimestamp,
  };

  // === 1. Bar-Lock 查詢（僅限初始開倉：currentLayer === 0 且非 CLOSE）===
  // 改為「只查詢不鎖定」，下單成功後才真正鎖定
  const { checkBarLock } = await import("./barLock");
  if (engineSignal.action !== "CLOSE" && state.currentLayer === 0 && signal.barTimestamp) {
    const isLocked = await checkBarLock(strategy.id, signal.barTimestamp);
    if (isLocked) {
      return {
        status: "skipped",
        message: `Bar-Lock 攔截：K 線 ${signal.barTimestamp} 已成功開倉過（重複信號防禦）`,
      };
    }
  }

  // === 2. 五層驗證 ===
  // 對於已經過 generateTradingSignal 完整驗證的信號（自動交易 + 手動觸發），跳過重複驗證
  // 因為此處 marketData 為空（無 candles），重複驗證可能導致誤判
  const marketData = {
    candles: [] as any[],
    lastPrice: signal.price ?? 0,
  };
  const isPreValidatedSignal = !!(signal as any).reason;
  if (!isPreValidatedSignal) {
    const validation = await engine.validateSignal(engineSignal, marketData, instance);
    if (!validation.valid) {
      return { status: "skipped", message: `V3.5 驗證未通過：${validation.reason}` };
    }
  }

  // === 3. 策略決策 ===
  const decision = await engine.generateActionsV35(engineSignal, instance, marketData, state);

  if (decision.action === "HOLD") {
    return { status: "skipped", message: `V3.5 觀望：${decision.reason || "HOLD"}` };
  }

  // === 4. 平倉 ===
  if (decision.action === "CLOSE_ALL") {
    const closePosSide = state.isLong ? "long" : "short";
    const result = await adapter.closePositionSmart(strategy.symbol, closePosSide);
    if (result.success) {
      // 計算 realizedPnl
      const exitPriceV35 = result.filledPrice || 0;
      const dirMultV35 = state.isLong ? 1 : -1;
      const pnlV35 = (exitPriceV35 > 0 && state.avgPrice > 0 && state.totalSize > 0)
        ? (exitPriceV35 - state.avgPrice) * state.totalSize * dirMultV35
        : undefined;
      await createTrade({
        strategyId: strategy.id,
        userId: strategy.userId,
        signalId,
        exchange: strategy.exchange,
        symbol: strategy.symbol,
        side: state.isLong ? "sell" : "buy",
        orderType: "market",
        orderId: result.orderId,
        size: String(state.totalSize || 0),
        price: exitPriceV35 > 0 ? String(exitPriceV35) : undefined,
        realizedPnl: pnlV35 !== undefined ? String(pnlV35.toFixed(6)) : undefined,
        reduceOnly: true,
        status: "filled",
        triggerSource: "webhook",
      });
      // 平倉後：分流判斷（馬丁解套 → 冷卻；正常止盈 → 立即重入）
      const wasMartin = state.currentLayer > 1;
      const kLinePeriod = Number(mergedCfg.K_Line_Period) || 30;
      const newState = createInitialStrategyState();
      if (wasMartin) {
        newState.isCooldown = true;
        newState.cooldownUntil = Date.now() + kLinePeriod * 2 * 60 * 1000;
      }
      // 不再保留 lockedBarTimestamp，平倉後應允許重新開倉
      await saveStrategyState(strategy.id, newState);
      // 清除 Bar-Lock 記錄，允許下次輪詢重新開倉
      try {
        const { releaseAllLocks: releaseAllLocksV35 } = await import("./barLock");
        await releaseAllLocksV35(strategy.id);
      } catch (e: any) {
        console.warn(`[Executor][V3.5] 清除 Bar-Lock 失敗：${e.message}`);
      }
      return {
        status: "executed",
        message: `V3.5 平倉完成${wasMartin ? `（馬丁解套，進入冷卻期 ${kLinePeriod * 2} 分鐘）` : ""}`,
        orderId: result.orderId,
        exchangeResponse: result.rawResponse,
      };
    }
    return { status: "failed", message: result.errorMessage || "V3.5 平倉失敗", exchangeResponse: result.rawResponse };
  }

  // === 5. 開倉/加倉（OPEN_LONG / OPEN_SHORT）===
  const isLong = decision.action === "OPEN_LONG";
  const entryPrice = signal.price ?? 0;

  // 方向限制檢查
  if (isLong && strategy.direction === "short") {
    return { status: "skipped", message: "策略僅允許做空，忽略做多訊號" };
  }
    if (!isLong && strategy.direction === "long") {
    return { status: "skipped", message: "策略僅允許做多，忽略做空訊號" };
  }
  // 第二輪優化 3：V3.5 鏈路也依交易對規格正規化數量
  let v35Size = decision.lotSize;
  try {
    const norm = await normalizeQtyForSymbol(strategy.exchange, strategy.symbol, v35Size, "linear");
    if (norm.rejected) {
      return { status: "rejected", message: `下單數量不符交易所規格：${norm.reason}` };
    }
    if (norm.adjusted) {
      console.log(`[Executor][V3.5] 數量已依規格校正：${norm.reason}`);
      v35Size = norm.qty;
    }
  } catch (e: any) {
    console.warn(`[Executor][V3.5] 規格正規化跳過：${e.message}`);
  }
  decision.lotSize = v35Size;
  const orderResult = await adapter.placeOrder({
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: "market",
    size: decision.lotSize,
    leverage: strategy.leverage,
  });

  await createTrade({
    strategyId: strategy.id,
    userId: strategy.userId,
    signalId,
    exchange: strategy.exchange,
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: "market",
    orderId: orderResult.orderId,
    size: String(decision.lotSize),
    price: entryPrice > 0 ? String(entryPrice) : undefined,
    status: orderResult.success ? "filled" : "failed",
    triggerSource: "webhook",
  });

  if (!orderResult.success) {
    // 下單失敗，不鎖定 Bar-Lock，下次觸發可重試
    console.log(`[Executor][V3.5] 下單失敗，Bar-Lock 未鎖定，下次可重試: ${orderResult.errorMessage}`);
    return {
      status: "failed",
      message: orderResult.errorMessage || "V3.5 下單失敗",
      exchangeResponse: orderResult.rawResponse,
    };
  }

  // 下單成功後才鎖定 Bar-Lock（確保只有真正成功的交易才會被鎖）
  if (signal.barTimestamp && state.currentLayer === 0) {
    const kLinePeriod = Number(mergedCfg.K_Line_Period) || 30;
    await acquireBarLock(strategy.id, signal.barTimestamp, kLinePeriod);
    console.log(`[Executor][V3.5] 下單成功，Bar-Lock 已鎖定 K 線 ${signal.barTimestamp}`);
  }

  // === 6. 馬丁引擎狀態更新（加層 + 均價；O1 支援階梯式乘數）===
  // 關鍵修正：用實際下單的 decision.lotSize（已經過 USDT→BTC 轉換 + normalizeQty 校正）
  // 而非 MartingaleEngine 內部用 baseLot 計算的理論值（可能是 USDT 數字而非 BTC）
  const actualExecutedSize = decision.lotSize; // 實際下單的 BTC 數量
  const martinEngine = new MartingaleEngine(
    {
      baseLot: actualExecutedSize, // 用實際執行數量作為 baseLot
      multiplier: Number(mergedCfg.Martin_Multiplier) || 1.5,
      stepPct: Number(mergedCfg.Martin_Step_Pct) || 1.5,
      maxLayers: calculateMaxLayersFromConfig(mergedCfg),
      martinLayers: parseMartinLayers(Array.isArray(mergedCfg.Martin_Layers) ? mergedCfg.Martin_Layers : []),
    },
    state,
  );
  // 使用實際成交數據（若有）替代理論值，確保與交易所數據一致
  const realSize = orderResult.filledSize ?? actualExecutedSize;
  const realPrice = orderResult.filledPrice ?? (entryPrice || 0);
  const { newState } = martinEngine.addLayer(realPrice, isLong);
  // 雙重保障：確保 totalSize 用實際成交數量累加
  newState.totalSize = parseFloat((state.totalSize + realSize).toPrecision(12));
  newState.totalCost = state.totalCost + (realSize * realPrice);
  if (newState.totalSize > 0) {
    newState.avgPrice = newState.totalCost / newState.totalSize;
  }
  if (orderResult.filledPrice) {
    console.log(`[Executor][V3.5] 使用實際成交數據: 價=${realPrice}, 量=${realSize}`);
  }
  // 記錄 Bar-Lock 時間戳（防同 K 線重複）
  if (signal.barTimestamp) {
    newState.lockedBarTimestamp = signal.barTimestamp;
  }
  // O2/O3：首單開倉時記錄入場 KAMA 方向（payload 可選提供 kamaFast/kamaSlow，否則以交易方向近似）
  if (newState.currentLayer === 1) {
    const kf = Number((signal as unknown as Record<string, unknown>).kamaFast);
    const ks = Number((signal as unknown as Record<string, unknown>).kamaSlow);
    newState.entryTrendBull =
      Number.isFinite(kf) && Number.isFinite(ks) && kf !== 0 && ks !== 0 ? kf > ks : isLong;
    newState.hasTriggeredKamaReversal = false;
  }
  await saveStrategyState(strategy.id, newState);

  const actionLabelV35 = newState.currentLayer === 1 ? "首單開倉" : `加倉第${newState.currentLayer}層`;
  return {
    status: "executed",
    message: `[${actionLabelV35}] V3.5 ${isLong ? "買入" : "賣出"} ${decision.lotSize} ${strategy.symbol} 成功（第 ${newState.currentLayer} 層，均價 ${newState.avgPrice.toFixed(2)}）${decision.reason ? ` - ${decision.reason}` : ""}`,
    orderId: orderResult.orderId,
    exchangeResponse: orderResult.rawResponse,
  };
}

/**
 * ===== V5.0 專用執行管線 =====
 * V5.0 使用自己的 validateSignal（含 F4 時間濾網 + F6 AI 過濾）
 * 與 V3.5 管線完全隶離，不會互相影響
 */
async function executeSignalV50(
  strategy: Strategy,
  signal: ParsedSignal,
  signalId: number,
  engine: BaseStrategyV35,
  adapter: ExchangeAdapter,
): Promise<ExecutionResult> {
  const state = loadStrategyState(strategy);
  const cfg = (strategy as unknown as { config?: Record<string, unknown> }).config ?? {};
  // V5.0: 正確從 martinState.__v50Config 讀取配置
  const martinStateRaw = (strategy.martinState && typeof strategy.martinState === 'object') ? strategy.martinState as Record<string, unknown> : {};
  const v50Cfg = (martinStateRaw.__v50Config && typeof martinStateRaw.__v50Config === 'object') ? martinStateRaw.__v50Config as Record<string, unknown> : {};
  const mergedCfg: Record<string, number | string | boolean> = {
    ...engine.defaultConfig,
    Base_Lot_Size: strategy.positionSizeObject || engine.defaultConfig.Base_Lot_Size,
    Position_Mode: ((strategy as unknown as { positionMode?: string }).positionMode ?? "quantity") as string,
    Position_Value: parseFloat(strategy.positionSize ?? '0') || (typeof engine.defaultConfig.Base_Lot_Size === 'object' ? Number((engine.defaultConfig.Base_Lot_Size as { value: number; mode: string }).value) : Number(engine.defaultConfig.Base_Lot_Size)),
    Martin_Multiplier: parseFloat(strategy.martinMultiplier) || Number(engine.defaultConfig.Martin_Multiplier),
    Max_Layers: strategy.maxMartinLevel || Number(engine.defaultConfig.Max_Layers),
    Martin_Step_Pct: parseFloat(strategy.martinSpacingPct) || Number(engine.defaultConfig.Martin_Step_Pct),
    ...(typeof cfg === "object" ? (cfg as Record<string, number | string | boolean>) : {}),
    ...(typeof v50Cfg === "object" ? (v50Cfg as Record<string, number | string | boolean>) : {}),
    // 強制釋放時間濾網和降低 AI 斜率閾值（24/7 全時段交易）
    enable_time_filter: false,
    kama_slope_min: 0.02,
  };

  const instance = {
    id: strategy.id,
    symbol: strategy.symbol,
    direction: strategy.direction as "long" | "short" | "both",
    positionSize: parseFloat(strategy.positionSize ?? '0'),
    leverage: strategy.leverage,
    config: mergedCfg,
    state,
  };

  const engineSignal = {
    action: (signal.action === "buy" ? "BUY" : signal.action === "sell" ? "SELL" : "CLOSE") as
      | "BUY"
      | "SELL"
      | "CLOSE",
    symbol: signal.symbol || strategy.symbol,
    price: signal.price ?? 0,
    barTimestamp: signal.barTimestamp,
  };

  // === 1. Bar-Lock 查詢（僅限初始開倉）===
  const { checkBarLock } = await import("./barLock");
  if (engineSignal.action !== "CLOSE" && state.currentLayer === 0 && signal.barTimestamp) {
    const isLocked = await checkBarLock(strategy.id, signal.barTimestamp);
    if (isLocked) {
      return {
        status: "skipped",
        message: `Bar-Lock 攝截：K 線 ${signal.barTimestamp} 已成功開倉過（重複信號防禦）`,
      };
    }
  }

  // === 2. V5.0 專用驗證（F4 時間濾網 + KAMA 方向鎖）===
  // 信號已經過 autoTradeSignalGenerator 的 KAMA 方向判斷和 validateSignal，
  // 這裡僅做基本檢查（冷卻期、反向持倉），不再重複檢查時間濾網和 KAMA 方向鎖
  const marketData = {
    candles: [] as any[],
    lastPrice: signal.price ?? 0,
  };
  // 對於已經過 generateTradingSignal 完整驗證的信號（自動交易 + 手動觸發），跳過 executor 層的重複 validateSignal
  // 因為此處 marketData 為空（無 candles/kamaValue），重複驗證會導致誤判
  // 僅對純 webhook 信號（無 reason）執行驗證
  const isPreValidatedSignal = !!(signal as any).reason;
  if (!isPreValidatedSignal) {
    const validation = await engine.validateSignal(engineSignal, marketData, instance);
    if (!validation.valid) {
      return { status: "skipped", message: `V5.0 驗證未通過：${validation.reason}` };
    }
  }

  // === 3. V5.0 策略決策 ===
  const decision = await engine.generateActionsV35(engineSignal, instance, marketData, state);

  if (decision.action === "HOLD") {
    return { status: "skipped", message: `V5.0 觀望：${decision.reason || "HOLD"}` };
  }

  // === 4. 平倉 ===
  if (decision.action === "CLOSE_ALL") {
    const closePosSide = state.isLong ? "long" : "short";
    const result = await adapter.closePositionSmart(strategy.symbol, closePosSide);
    if (result.success) {
      // 計算 realizedPnl
      const exitPriceV50 = result.filledPrice || 0;
      const dirMultV50 = state.isLong ? 1 : -1;
      const pnlV50 = (exitPriceV50 > 0 && state.avgPrice > 0 && state.totalSize > 0)
        ? (exitPriceV50 - state.avgPrice) * state.totalSize * dirMultV50
        : undefined;
      await createTrade({
        strategyId: strategy.id,
        userId: strategy.userId,
        signalId,
        exchange: strategy.exchange,
        symbol: strategy.symbol,
        side: state.isLong ? "sell" : "buy",
        orderType: "market",
        orderId: result.orderId,
        size: String(state.totalSize),
        price: exitPriceV50 > 0 ? String(exitPriceV50) : undefined,
        realizedPnl: pnlV50 !== undefined ? String(pnlV50.toFixed(6)) : undefined,
        reduceOnly: true,
        status: "filled",
        triggerSource: "webhook",
      });
      const resetState = createInitialStrategyState();
      await saveStrategyState(strategy.id, resetState);
      // 清除 Bar-Lock 記錄，允許下次輪詢重新開倉
      try {
        const { releaseAllLocks: releaseAllLocksV50 } = await import("./barLock");
        await releaseAllLocksV50(strategy.id);
      } catch (e: any) {
        console.warn(`[Executor][V5.0] 清除 Bar-Lock 失敗：${e.message}`);
      }
      return { status: "executed", message: `V5.0 平倉成功`, orderId: result.orderId, exchangeResponse: result.rawResponse };
    }
    return { status: "failed", message: result.errorMessage || "V5.0 平倉失敗", exchangeResponse: result.rawResponse };
  }

  // === 5. 開倉/加倉 ===
  const isLong = decision.action === "OPEN_LONG";

  // 方向限制檢查
  if (isLong && strategy.direction === "short") {
    return { status: "skipped", message: "策略僅允許做空，忽略做多訊號" };
  }
  if (!isLong && strategy.direction === "long") {
    return { status: "skipped", message: "策略僅允許做多，忽略做空訊號" };
  }

  // 數量正規化
  let v50Size = decision.lotSize;
  try {
    const norm = await normalizeQtyForSymbol(strategy.exchange, strategy.symbol, v50Size, "linear");
    if (norm.rejected) {
      return { status: "rejected", message: `下單數量不符交易所規格：${norm.reason}` };
    }
    if (norm.adjusted) {
      console.log(`[Executor][V5.0] 數量已依規格校正：${norm.reason}`);
      v50Size = norm.qty;
    }
  } catch (e: any) {
    console.warn(`[Executor][V5.0] 規格正規化跳過：${e.message}`);
  }
  decision.lotSize = v50Size;

  const orderResult = await adapter.placeOrder({
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: "market",
    size: decision.lotSize,
    leverage: strategy.leverage,
  });

  await createTrade({
    strategyId: strategy.id,
    userId: strategy.userId,
    signalId,
    exchange: strategy.exchange,
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: "market",
    orderId: orderResult.orderId,
    size: String(decision.lotSize),
    price: signal.price ? String(signal.price) : undefined,
    status: orderResult.success ? "filled" : "failed",
    triggerSource: "webhook",
  });

  if (!orderResult.success) {
    console.log(`[Executor][V5.0] 下單失敗，Bar-Lock 未鎖定: ${orderResult.errorMessage}`);
    return {
      status: "failed",
      message: orderResult.errorMessage || "V5.0 下單失敗",
      exchangeResponse: orderResult.rawResponse,
    };
  }

  // 下單成功後鎖定 Bar-Lock
  if (signal.barTimestamp && state.currentLayer === 0) {
    const kLinePeriod = Number(mergedCfg.K_Line_Period) || 15;
    await acquireBarLock(strategy.id, signal.barTimestamp, kLinePeriod);
    console.log(`[Executor][V5.0] 下單成功，Bar-Lock 已鎖定 K 線 ${signal.barTimestamp}`);
  }

  // === 6. 馬丁引擎狀態更新 ===
  // 使用實際成交數據（若有）替代理論值，確保與交易所數據一致
  const entryPrice = signal.price ?? 0;
  const actualExecutedSizeV50 = decision.lotSize;
  const realSizeV50 = orderResult.filledSize ?? actualExecutedSizeV50;
  const realPriceV50 = orderResult.filledPrice ?? (entryPrice || 0);
  const martinEngine = new MartingaleEngine(
    {
      baseLot: actualExecutedSizeV50,
      multiplier: Number(mergedCfg.Martin_Multiplier) || 1.5,
      stepPct: Number(mergedCfg.Martin_Step_Pct) || 2.0,
      maxLayers: calculateMaxLayersFromConfig(mergedCfg),
      martinLayers: parseMartinLayers(Array.isArray(mergedCfg.Martin_Layers) ? mergedCfg.Martin_Layers : []),
    },
    state,
  );
  const { newState } = martinEngine.addLayer(realPriceV50, isLong);
  // 雙重保障：確保 totalSize 用實際成交數量累加
  newState.totalSize = parseFloat((state.totalSize + realSizeV50).toPrecision(12));
  newState.totalCost = state.totalCost + (realSizeV50 * realPriceV50);
  if (newState.totalSize > 0) {
    newState.avgPrice = newState.totalCost / newState.totalSize;
  }
  if (orderResult.filledPrice) {
    console.log(`[Executor][V5.0] 使用實際成交數據: 價=${realPriceV50}, 量=${realSizeV50}`);
  }
  // 記錄加倉時間戳（供 generateActionsV35 冷卻時間檢查使用）
  newState.lastAddLayerTime = Date.now();
  if (signal.barTimestamp) {
    newState.lockedBarTimestamp = signal.barTimestamp;
  }
  if (newState.currentLayer === 1) {
    const kf = Number((signal as unknown as Record<string, unknown>).kamaFast);
    const ks = Number((signal as unknown as Record<string, unknown>).kamaSlow);
    newState.entryTrendBull =
      Number.isFinite(kf) && Number.isFinite(ks) && kf !== 0 && ks !== 0 ? kf > ks : isLong;
    newState.hasTriggeredKamaReversal = false;
  }
  await saveStrategyState(strategy.id, newState);

  const actionLabelV50 = newState.currentLayer === 1 ? "首單開倉" : `加倉第${newState.currentLayer}層`;
  return {
    status: "executed",
    message: `[${actionLabelV50}] V5.0 ${isLong ? "買入" : "賣出"} ${decision.lotSize} ${strategy.symbol} 成功（第 ${newState.currentLayer} 層，均價 ${newState.avgPrice.toFixed(2)}）${decision.reason ? ` - ${decision.reason}` : ""}`,
    orderId: orderResult.orderId,
    exchangeResponse: orderResult.rawResponse,
  };
}

/**
 * V6.1 專用執行管線（KAMA 3K 高頻掃射極致版）
 */
async function executeSignalV61(
  strategy: Strategy,
  signal: ParsedSignal,
  signalId: number,
  engine: BaseStrategyV35,
  adapter: ExchangeAdapter,
): Promise<ExecutionResult> {
  const state = loadStrategyState(strategy);
  const martinStateRaw = (strategy.martinState && typeof strategy.martinState === 'object') ? strategy.martinState as Record<string, unknown> : {};
  const v61Cfg = (martinStateRaw.__v61Config && typeof martinStateRaw.__v61Config === 'object') ? martinStateRaw.__v61Config as Record<string, unknown> : {};
  const mergedCfg: Record<string, number | string | boolean> = {
    ...engine.defaultConfig,
    Base_Lot_Size: Number(v61Cfg.base_lot_size ?? 15),
    Position_Mode: ((strategy as unknown as { positionMode?: string }).positionMode ?? "usdt") as string,
    Position_Value: parseFloat(strategy.positionSize ?? '0') || 15,
    ...(typeof v61Cfg === "object" ? (v61Cfg as Record<string, number | string | boolean>) : {}),
  };

  const instance = {
    id: strategy.id,
    symbol: strategy.symbol,
    direction: strategy.direction as "long" | "short" | "both",
    positionSize: parseFloat(strategy.positionSize ?? '0'),
    leverage: strategy.leverage,
    config: mergedCfg,
    state,
  };

  const engineSignal = {
    action: (signal.action === "buy" ? "BUY" : signal.action === "sell" ? "SELL" : "CLOSE") as
      | "BUY"
      | "SELL"
      | "CLOSE",
    symbol: signal.symbol || strategy.symbol,
    price: signal.price ?? 0,
    barTimestamp: signal.barTimestamp,
  };

  // === 1. Bar-Lock 查詢 ===
  if (v61Cfg.enable_bar_lock && engineSignal.action !== "CLOSE" && state.currentLayer === 0 && signal.barTimestamp) {
    const { checkBarLock } = await import("./barLock");
    const isLocked = await checkBarLock(strategy.id, signal.barTimestamp);
    if (isLocked) {
      return { status: "skipped", message: `V6.1 Bar-Lock 攝截：K 線 ${signal.barTimestamp} 已開倉過` };
    }
  }

  // === 2. V6.1 專用驗證（區域觸發驗證） ===
  // 對於已經過 generateTradingSignal 完整驗證的信號（自動交易 + 手動觸發），跳過重複驗證
  // 因為此處 marketData 為空（無 candles），重複驗證可能導致誤判
  const marketData = { candles: [] as any[], lastPrice: signal.price ?? 0 };
  const isPreValidatedSignal = !!(signal as any).reason;
  if (!isPreValidatedSignal) {
    const validation = await engine.validateSignal(engineSignal, marketData, instance);
    if (!validation.valid) {
      return { status: "skipped", message: `V6.1 驗證未通過：${validation.reason}` };
    }
  }

  // === 3. V6.1 策略決策 ===
  // 對於已預驗證信號（由 autoTradeSignalGenerator 的 generateSignalV61 生成），
  // 直接根據信號方向執行，不再調用 generateActionsV35（它總是返回 HOLD）
  let decision: { action: string; lotSize?: number; reason?: string };
  if (isPreValidatedSignal) {
    // 信號已經過 generateSignalV61 完整驗證，直接映射為執行決策
    if (engineSignal.action === 'CLOSE') {
      decision = { action: 'CLOSE_ALL', reason: (signal as any).reason || 'V6.1 平倉信號' };
    } else if (engineSignal.action === 'BUY') {
      decision = { action: 'OPEN_LONG', lotSize: (signal as any).lotUsdt || mergedCfg.Base_Lot_Size as number || 15, reason: (signal as any).reason };
    } else {
      decision = { action: 'OPEN_SHORT', lotSize: (signal as any).lotUsdt || mergedCfg.Base_Lot_Size as number || 15, reason: (signal as any).reason };
    }
  } else {
    // 非預驗證信號（手動觸發等），回退到 generateActionsV35
    decision = await engine.generateActionsV35(engineSignal, instance, marketData, state);
  }
  if (decision.action === "HOLD") {
    return { status: "skipped", message: `V6.1 觀望：${decision.reason || "HOLD"}` };
  }

  // === 4. 平倉 ===
  if (decision.action === "CLOSE_ALL") {
    const closePosSide = state.isLong ? "long" : "short";
    const result = await adapter.closePositionSmart(strategy.symbol, closePosSide);
    if (result.success) {
      // 計算 realizedPnl
      const exitPriceV61 = result.filledPrice || 0;
      const dirMultV61 = state.isLong ? 1 : -1;
      const pnlV61 = (exitPriceV61 > 0 && state.avgPrice > 0 && state.totalSize > 0)
        ? (exitPriceV61 - state.avgPrice) * state.totalSize * dirMultV61
        : undefined;
      await createTrade({
        strategyId: strategy.id,
        userId: strategy.userId,
        signalId,
        exchange: strategy.exchange,
        symbol: strategy.symbol,
        side: state.isLong ? "sell" : "buy",
        orderType: "market",
        orderId: result.orderId,
        size: String(state.totalSize),
        price: exitPriceV61 > 0 ? String(exitPriceV61) : undefined,
        realizedPnl: pnlV61 !== undefined ? String(pnlV61.toFixed(6)) : undefined,
        reduceOnly: true,
        status: "filled",
        triggerSource: "webhook",
      });
      const resetState = createInitialStrategyState();
      await saveStrategyState(strategy.id, resetState);
      // 清除 Bar-Lock 記錄，允許下次輪詢重新開倉
      try {
        const { releaseAllLocks: releaseAllLocksV61 } = await import("./barLock");
        await releaseAllLocksV61(strategy.id);
      } catch (e: any) {
        console.warn(`[Executor][V6.1] 清除 Bar-Lock 失敗：${e.message}`);
      }
      return { status: "executed", message: `V6.1 平倉成功`, orderId: result.orderId, exchangeResponse: result.rawResponse };
    }
    return { status: "failed", message: result.errorMessage || "V6.1 平倉失敗", exchangeResponse: result.rawResponse };
  }

  // === 5. 開倉/加倉 ===
  const isLong = decision.action === "OPEN_LONG";
  if (isLong && strategy.direction === "short") {
    return { status: "skipped", message: "策略僅允許做空，忽略做多訊號" };
  }
  if (!isLong && strategy.direction === "long") {
    return { status: "skipped", message: "策略僅允許做多，忽略做空訊號" };
  }

  // ★ 核心修復：V6.1 引擎返回的是 lotUsdt（USDT 金額），必須轉換為基礎幣數量
  const entryPrice = signal.price ?? 0;
  const lotUsdt: number = decision.lotSize || 15;
  let v61Size: number;
  if (entryPrice > 0) {
    v61Size = lotUsdt / entryPrice;
    console.log(`[Executor][V6.1] USDT→幣轉換：${lotUsdt} USDT / ${entryPrice} = ${v61Size.toFixed(8)} 幣`);
  } else {
    // 無價格時回退到最小單位（安全防線）
    v61Size = 0.001;
    console.warn(`[Executor][V6.1] 無有效價格，回退到最小下單量 0.001`);
  }

  // 數量正規化
  try {
    const norm = await normalizeQtyForSymbol(strategy.exchange, strategy.symbol, v61Size, "linear");
    if (norm.rejected) {
      return { status: "rejected", message: `下單數量不符交易所規格：${norm.reason}` };
    }
    if (norm.adjusted) {
      console.log(`[Executor][V6.1] 數量已依規格校正：${norm.reason}`);
      v61Size = norm.qty;
    }
  } catch (e: any) {
    console.warn(`[Executor][V6.1] 規格正規化跳過：${e.message}`);
  }
  decision.lotSize = v61Size;

  // ★ 修復：使用策略設定的 orderType（而非硬編碼 market）
  const v61OrderType = strategy.orderType === 'limit' ? 'limit' : 'market';
  const orderResult = await adapter.placeOrder({
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: v61OrderType,
    size: decision.lotSize,
    price: v61OrderType === 'limit' ? entryPrice : undefined,
    leverage: strategy.leverage,
  });

  await createTrade({
    strategyId: strategy.id,
    userId: strategy.userId,
    signalId,
    exchange: strategy.exchange,
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: v61OrderType,
    orderId: orderResult.orderId,
    size: String(decision.lotSize),
    price: signal.price ? String(signal.price) : undefined,
    status: orderResult.success ? "filled" : "failed",
    triggerSource: "webhook",
  });

  if (!orderResult.success) {
    return {
      status: "failed",
      message: orderResult.errorMessage || "V6.1 下單失敗",
      exchangeResponse: orderResult.rawResponse,
    };
  }

  // 下單成功後鎖定 Bar-Lock
  if (v61Cfg.enable_bar_lock && signal.barTimestamp && state.currentLayer === 0) {
    const kLinePeriod = Number(v61Cfg.timeframe || mergedCfg.K_Line_Period) || 15;
    await acquireBarLock(strategy.id, signal.barTimestamp, kLinePeriod);
  }

  // === 6. 馬丁引擎狀態更新 ===
  // 使用實際成交數據（若有）替代理論值，確保與交易所數據一致
  // entryPrice 已在上方開倉段落定義
  const actualExecutedSizeV61 = decision.lotSize || 0.001;
  const realSizeV61 = orderResult.filledSize ?? actualExecutedSizeV61;
  const realPriceV61 = orderResult.filledPrice ?? (entryPrice || 0);
  const martinEngine = new MartingaleEngine(
    {
      baseLot: actualExecutedSizeV61,
      multiplier: 1.5,
      stepPct: 2.0,
      maxLayers: 13,
      martinLayers: [],
    },
    state,
  );
  const { newState } = martinEngine.addLayer(realPriceV61, isLong);
  // 雙重保障：確保 totalSize 用實際成交數量累加
  newState.totalSize = parseFloat((state.totalSize + realSizeV61).toPrecision(12));
  newState.totalCost = state.totalCost + (realSizeV61 * realPriceV61);
  if (newState.totalSize > 0) {
    newState.avgPrice = newState.totalCost / newState.totalSize;
  }
  if (orderResult.filledPrice) {
    console.log(`[Executor][V6.1] 使用實際成交數據: 價=${realPriceV61}, 量=${realSizeV61}`);
  }
  if (signal.barTimestamp) {
    newState.lockedBarTimestamp = signal.barTimestamp;
  }
  if (newState.currentLayer === 1) {
    newState.entryTrendBull = isLong;
    newState.hasTriggeredKamaReversal = false;
  }
  await saveStrategyState(strategy.id, newState);

  const actionLabelV61 = newState.currentLayer === 1 ? "首單開倉" : `加倉第${newState.currentLayer}層`;
  return {
    status: "executed",
    message: `[${actionLabelV61}] V6.1 ${isLong ? "買入" : "賣出"} ${decision.lotSize} ${strategy.symbol} 成功（第 ${newState.currentLayer} 層，均價 ${newState.avgPrice.toFixed(2)}）${decision.reason ? ` - ${decision.reason}` : ""}`,
    orderId: orderResult.orderId,
    exchangeResponse: orderResult.rawResponse,
  };
}

/**
 * ===== V2.5 專用執行管線（KAMA 三K突破｜階梯式馬丁）=====
 * 自動模式使用伺服器策略核心產生的封印決策；外部買賣訊號會重新跑即時核心，
 * 不允許 webhook 繞過 KAMA／三K／出場／馬丁條件。外部 close 保留為緊急平倉。
 */
async function executeSignalV25(
  strategy: Strategy,
  incomingSignal: ParsedSignal,
  signalId: number,
  engine: StrategyKama3kBreakoutV25,
  adapter: ExchangeAdapter,
  apiKeyRecord: unknown,
): Promise<ExecutionResult> {
  const forcedManualClose =
    incomingSignal.action === "close" && incomingSignal.v25Decision !== true;
  let signal = incomingSignal;

  if (!forcedManualClose && signal.v25Decision !== true) {
    const { generateTradingSignal } = await import("./autoTradeSignalGenerator");
    const generated = await generateTradingSignal(strategy, apiKeyRecord);
    if (!generated) {
      return {
        status: "skipped",
        message: "V2.5 即時核心判斷為觀望；外部方向不會繞過 KAMA 三K條件",
      };
    }
    signal = generated;
  }

  const freshStrategy = (await getStrategyById(strategy.id)) || strategy;
  const state = loadStrategyState(freshStrategy) as V25RuntimeState;
  const rawState =
    freshStrategy.martinState && typeof freshStrategy.martinState === "object"
      ? (freshStrategy.martinState as Record<string, unknown>)
      : {};
  const mergedConfig = {
    ...engine.defaultConfig,
    ...(getBoundStrategyConfig(rawState, V25_STRATEGY_KEY) ?? {}),
  };
  const cfg = engine.parseConfig(mergedConfig);
  const barTimestamp = signal.barTimestamp ?? Date.now();

  if (signal.action === "close") {
    if (state.currentLayer <= 0 || state.totalSize <= 0) {
      return { status: "skipped", message: "V2.5 目前無本地持倉，不執行平倉" };
    }
    const closePosSide = state.isLong ? "long" : "short";
    const result = await adapter.closePositionSmart(strategy.symbol, closePosSide);
    if (!result.success) {
      return {
        status: "failed",
        message: result.errorMessage || "V2.5 平倉失敗",
        exchangeResponse: result.rawResponse,
      };
    }

    const exitPrice = result.filledPrice || signal.price || 0;
    const directionMultiplier = state.isLong ? 1 : -1;
    const realizedPnl =
      exitPrice > 0 && state.avgPrice > 0
        ? (exitPrice - state.avgPrice) * state.totalSize * directionMultiplier
        : undefined;
    await createTrade({
      strategyId: strategy.id,
      userId: strategy.userId,
      signalId,
      exchange: strategy.exchange,
      symbol: strategy.symbol,
      side: state.isLong ? "sell" : "buy",
      orderType: "market",
      orderId: result.orderId,
      size: String(state.totalSize),
      price: exitPrice > 0 ? String(exitPrice) : undefined,
      realizedPnl:
        realizedPnl !== undefined ? String(realizedPnl.toFixed(8)) : undefined,
      reduceOnly: true,
      status: "filled",
      triggerSource: "webhook",
    });

    const closeReason: Exclude<V25CloseReason, null> = forcedManualClose
      ? "OTHER"
      : signal.v25CloseReason ?? "OTHER";
    const resetState = applyV25CloseToState(
      state,
      closeReason,
      cfg.Reentry_On_Trend && !forcedManualClose,
      barTimestamp,
    );
    await saveStrategyState(strategy.id, resetState);
    try {
      const { releaseAllLocks } = await import("./barLock");
      await releaseAllLocks(strategy.id);
    } catch (error) {
      console.warn("[Executor][V2.5] 清除 Bar-Lock 失敗", error);
    }
    return {
      status: "executed",
      message: `V2.5 平倉成功（${forcedManualClose ? "緊急手動" : closeReason}${realizedPnl !== undefined ? `，PnL=${realizedPnl.toFixed(2)}` : ""}）`,
      orderId: result.orderId,
      exchangeResponse: result.rawResponse,
    };
  }

  const isLong = signal.action === "buy";
  const isInitialEntry = state.currentLayer <= 0 || state.totalSize <= 0;
  if (!isInitialEntry && state.isLong !== isLong) {
    return { status: "skipped", message: "V2.5 禁止以反向訊號翻倉，須先完成平倉" };
  }
  if (isLong && strategy.direction === "short") {
    return { status: "skipped", message: "策略僅允許做空，忽略 V2.5 做多訊號" };
  }
  if (!isLong && strategy.direction === "long") {
    return { status: "skipped", message: "策略僅允許做多，忽略 V2.5 做空訊號" };
  }

  if (isInitialEntry && signal.barTimestamp) {
    const { checkBarLock } = await import("./barLock");
    if (await checkBarLock(strategy.id, signal.barTimestamp)) {
      return {
        status: "skipped",
        message: `V2.5 Bar-Lock 攔截：K 線 ${signal.barTimestamp} 已完成開倉`,
      };
    }
  }

  const martinLayerNum = isInitialEntry
    ? 0
    : signal.v25LayerNum ?? Math.max(1, state.currentLayer);
  const martinRange = getV25MartinRangeForLayer(
    cfg.Martin_Ranges,
    Math.max(1, martinLayerNum),
  );
  const fallbackLotUsdt = isInitialEntry
    ? cfg.Base_Lot_Size
    : cfg.Base_Lot_Size * (martinRange?.multiplier ?? 1);
  const lotUsdt =
    Number(signal.lotUsdt) > 0 ? Number(signal.lotUsdt) : fallbackLotUsdt;
  const entryPrice = Number(signal.price);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return {
      status: "rejected",
      message: "V2.5 缺少有效即時價格，拒絕推算下單量",
    };
  }

  let orderQuantity = lotUsdt / entryPrice;
  try {
    const normalized = await normalizeQtyForSymbol(
      strategy.exchange,
      strategy.symbol,
      orderQuantity,
      "linear",
    );
    if (normalized.rejected) {
      return {
        status: "rejected",
        message: `V2.5 下單數量不符交易所規格：${normalized.reason}`,
      };
    }
    orderQuantity = normalized.qty;
  } catch (error) {
    console.warn("[Executor][V2.5] 數量規格正規化失敗，沿用原始計算", error);
  }

  const orderResult = await adapter.placeOrder({
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: "market",
    size: orderQuantity,
    leverage: strategy.leverage,
  });
  await createTrade({
    strategyId: strategy.id,
    userId: strategy.userId,
    signalId,
    exchange: strategy.exchange,
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: "market",
    orderId: orderResult.orderId,
    size: String(orderQuantity),
    price: String(entryPrice),
    status: orderResult.success ? "filled" : "failed",
    triggerSource: "webhook",
  });
  if (!orderResult.success) {
    return {
      status: "failed",
      message: orderResult.errorMessage || "V2.5 下單失敗",
      exchangeResponse: orderResult.rawResponse,
    };
  }

  if (isInitialEntry && signal.barTimestamp) {
    await acquireBarLock(strategy.id, signal.barTimestamp, cfg.K_Line_Period);
  }
  const filledPrice = orderResult.filledPrice ?? entryPrice;
  const filledQuantity = orderResult.filledSize ?? orderQuantity;
  const fillAction = isInitialEntry
    ? isLong
      ? "buy"
      : "sell"
    : isLong
      ? "add_long"
      : "add_short";
  const filledState = applyV25FillToState(
    state,
    fillAction,
    filledPrice,
    filledQuantity,
    barTimestamp,
  );
  filledState.v25Runtime = {
    ...(filledState.v25Runtime ?? {
      pendingReentry: false,
      lastCloseReason: null,
      lastActionBarTimestamp: 0,
      lastActionSignature: "",
    }),
    lastActionBarTimestamp: barTimestamp,
    lastActionSignature: `${fillAction}:${martinLayerNum}:`,
  };
  await saveStrategyState(strategy.id, filledState);

  return {
    status: "executed",
    message: `[${isInitialEntry ? "首單開倉" : `馬丁加倉 L${martinLayerNum}`}] V2.5 ${isLong ? "買入" : "賣出"} ${lotUsdt.toFixed(2)} USDT 成功（成交 ${filledQuantity} @ ${filledPrice}）${signal.reason ? ` - ${signal.reason}` : ""}`,
    orderId: orderResult.orderId,
    exchangeResponse: orderResult.rawResponse,
  };
}

/**
 * ===== V7.0 專用執行管線（KAMA_3K_TORNADO_V70 龍捲風雙渦輪）=====
 */
async function executeSignalV70(
  strategy: Strategy,
  signal: ParsedSignal,
  signalId: number,
  engine: BaseStrategyV35,
  adapter: ExchangeAdapter,
): Promise<ExecutionResult> {
  const state = loadStrategyState(strategy);
  const martinStateRaw = (strategy.martinState && typeof strategy.martinState === 'object') ? strategy.martinState as Record<string, unknown> : {};
  const v70Cfg = (martinStateRaw.__v70Config && typeof martinStateRaw.__v70Config === 'object') ? martinStateRaw.__v70Config as Record<string, unknown> : {};

  // 合併配置：策略定義配置 > 用戶覆寫 > 默認值
  const mergedCfg: Record<string, any> = {
    ...engine.defaultConfig,
    ...(typeof v70Cfg === 'object' ? v70Cfg : {}),
  };

  const v70Engine = engine as unknown as StrategyKama3kV70;
  const cfg = v70Engine.parseConfig(mergedCfg);

  const instance = {
    id: strategy.id,
    symbol: strategy.symbol,
    direction: strategy.direction as "long" | "short" | "both",
    positionSize: parseFloat(strategy.positionSize ?? '0'),
    leverage: strategy.leverage,
    config: mergedCfg,
    state,
  };
  const engineSignal = {
    action: (signal.action === "buy" ? "BUY" : signal.action === "sell" ? "SELL" : "CLOSE") as
      | "BUY"
      | "SELL"
      | "CLOSE",
    symbol: signal.symbol || strategy.symbol,
    price: signal.price ?? 0,
    barTimestamp: signal.barTimestamp,
  };

  // === 1. Bar-Lock 查詢 ===
  const { checkBarLock } = await import("./barLock");
  if (engineSignal.action !== "CLOSE" && state.currentLayer === 0 && signal.barTimestamp) {
    const isLocked = await checkBarLock(strategy.id, signal.barTimestamp);
    if (isLocked) {
      return { status: "skipped", message: `V7.0 Bar-Lock 攞截：K 線 ${signal.barTimestamp} 已成功開倉過` };
    }
  }

  // === 2. 策略決策 ===
  const decision = await engine.generateActionsV35(engineSignal, instance, null, state);
  if (decision.action === "HOLD") {
    return { status: "skipped", message: `V7.0 觀望：${decision.reason || "HOLD"}` };
  }

  // === 3. 平倉 ===
  if (decision.action === "CLOSE_ALL") {
    const closePosSide = state.isLong ? "long" : "short";
    const result = await adapter.closePositionSmart(strategy.symbol, closePosSide);
    if (result.success) {
      const exitPrice = result.filledPrice || 0;
      const dirMult = state.isLong ? 1 : -1;
      const pnl = (exitPrice > 0 && state.avgPrice > 0 && state.totalSize > 0)
        ? (exitPrice - state.avgPrice) * state.totalSize * dirMult
        : undefined;
      await createTrade({
        strategyId: strategy.id,
        userId: strategy.userId,
        signalId,
        exchange: strategy.exchange,
        symbol: strategy.symbol,
        side: state.isLong ? "sell" : "buy",
        orderType: "market",
        orderId: result.orderId,
        size: String(state.totalSize),
        price: exitPrice > 0 ? String(exitPrice) : undefined,
        reduceOnly: true,
        status: "filled",
        triggerSource: "webhook",
        realizedPnl: pnl !== undefined ? String(pnl) : undefined,
      });
      // 重置狀態
      const resetState = createInitialStrategyState();
      await saveStrategyState(strategy.id, resetState);
      return { status: "executed", message: `V7.0 平倉成功（${decision.reason || ''}${pnl !== undefined ? `，PnL=${pnl.toFixed(2)}` : ''})）`, orderId: result.orderId, exchangeResponse: result.rawResponse };
    }
    return { status: "failed", message: result.errorMessage || "V7.0 平倉失敗", exchangeResponse: result.rawResponse };
  }

  // === 4. 開倉/加倉 ===
  const isLong = decision.action === "OPEN_LONG";
  if (isLong && strategy.direction === "short") {
    return { status: "skipped", message: "策略僅允許做空，忽略做多訊號" };
  }
  if (!isLong && strategy.direction === "long") {
    return { status: "skipped", message: "策略僅允許做多，忽略做空訊號" };
  }

  // V7.0 使用 base_lot_size_usdt 轉換為幣數量
  const entryPrice = signal.price ?? 0;
  const lotUsdt: number = signal.lotUsdt || cfg.base_lot_size_usdt;
  let v70Size: number;
  if (entryPrice > 0) {
    v70Size = lotUsdt / entryPrice;
    console.log(`[Executor][V7.0] USDT→幣轉換：${lotUsdt} USDT / ${entryPrice} = ${v70Size.toFixed(8)} 幣`);
  } else {
    v70Size = 0.001;
    console.warn(`[Executor][V7.0] 無有效價格，回退到最小下單量 0.001`);
  }

  // 數量正規化
  try {
    const norm = await normalizeQtyForSymbol(strategy.exchange, strategy.symbol, v70Size, "linear");
    if (norm.rejected) {
      return { status: "rejected", message: `下單數量不符交易所規格：${norm.reason}` };
    }
    if (norm.adjusted) {
      console.log(`[Executor][V7.0] 數量已依規格校正：${norm.reason}`);
      v70Size = norm.qty;
    }
  } catch (e: any) {
    console.warn(`[Executor][V7.0] 規格正規化跳過：${e.message}`);
  }
  decision.lotSize = v70Size;

  const orderResult = await adapter.placeOrder({
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: "market",
    size: decision.lotSize,
    leverage: strategy.leverage,
  });

  await createTrade({
    strategyId: strategy.id,
    userId: strategy.userId,
    signalId,
    exchange: strategy.exchange,
    symbol: strategy.symbol,
    side: isLong ? "buy" : "sell",
    orderType: "market",
    orderId: orderResult.orderId,
    size: String(decision.lotSize),
    price: signal.price ? String(signal.price) : undefined,
    status: orderResult.success ? "filled" : "failed",
    triggerSource: "webhook",
  });

  if (!orderResult.success) {
    return {
      status: "failed",
      message: orderResult.errorMessage || "V7.0 下單失敗",
      exchangeResponse: orderResult.rawResponse,
    };
  }

  // 下單成功後鎖定 Bar-Lock
  if (signal.barTimestamp && state.currentLayer === 0) {
    const kLinePeriod = Number(mergedCfg.K_Line_Period) || 5;
    await acquireBarLock(strategy.id, signal.barTimestamp, kLinePeriod);
    console.log(`[Executor][V7.0] 下單成功，Bar-Lock 已鎖定 K 線 ${signal.barTimestamp}`);
  }

  // === 5. 馬丁引擎狀態更新 ===
  const realSizeV70 = orderResult.filledSize ?? v70Size;
  const realPriceV70 = orderResult.filledPrice ?? (entryPrice || 0);
  const martinEngine = new MartingaleEngine(
    {
      baseLot: v70Size,
      multiplier: 1.5,
      stepPct: cfg.martin_layers[0]?.gap_long ?? 0.6,
      maxLayers: cfg.martin_max_layers,
      martinLayers: [],
    },
    state,
  );
  const { newState } = martinEngine.addLayer(realPriceV70, isLong);
  newState.totalSize = parseFloat((state.totalSize + realSizeV70).toPrecision(12));
  newState.totalCost = state.totalCost + (realSizeV70 * realPriceV70);
  if (newState.totalSize > 0) {
    newState.avgPrice = newState.totalCost / newState.totalSize;
  }
  if (orderResult.filledPrice) {
    console.log(`[Executor][V7.0] 使用實際成交數據: 價=${realPriceV70}, 量=${realSizeV70}`);
  }
  if (signal.barTimestamp) {
    newState.lockedBarTimestamp = signal.barTimestamp;
  }
  if (newState.currentLayer === 1) {
    newState.entryTrendBull = isLong;
    newState.hasTriggeredKamaReversal = false;
  }
  await saveStrategyState(strategy.id, newState);

  const actionLabel = newState.currentLayer === 1 ? "首單開倉" : `加倉第${newState.currentLayer}層`;
  return {
    status: "executed",
    message: `[${actionLabel}] V7.0 ${isLong ? "買入" : "賣出"} ${decision.lotSize} ${strategy.symbol} 成功（第 ${newState.currentLayer} 層，均價 ${newState.avgPrice.toFixed(2)}）${decision.reason ? ` - ${decision.reason}` : ""}`,
    orderId: orderResult.orderId,
    exchangeResponse: orderResult.rawResponse,
  };
}

/** 讀取策略馬丁狀態（預設初始化） */
export function getMartinState(strategy: Strategy): MartinState {
  const raw = strategy.martinState as MartinState | null;
  if (raw && typeof raw === "object" && typeof raw.lossCount === "number") {
    return raw;
  }
  return {
    lossCount: 0,
    currentLot: (strategy.positionSizeObject as { value: number; mode: string } | null)?.value ?? parseFloat(strategy.positionSize ?? '0'),
    lastEntryPrice: 0,
  };
}

/**
 * 平倉後更新馬丁狀態：虧損 lossCount+1，盈利歸零
 * 由風險監控或平倉流程呼叫
 */
export async function updateMartinAfterClose(
  strategy: Strategy,
  realizedPnl: number,
): Promise<void> {
  const state = getMartinState(strategy);
  const maxLevel = strategy.maxMartinLevel || 1;
  const next: MartinState =
    realizedPnl < 0
      ? {
          lossCount: Math.min(state.lossCount + 1, maxLevel),
          currentLot: state.currentLot,
          lastEntryPrice: state.lastEntryPrice,
        }
      : { lossCount: 0, currentLot: (strategy.positionSizeObject as { value: number; mode: string } | null)?.value ?? parseFloat(strategy.positionSize ?? '0'), lastEntryPrice: 0 };
  await updateStrategyMartinState(strategy.id, next);
}

/**
 * 每日虧損上限觸發：自動平倉 + 停用策略 + 記錄風險事件
 */
async function handleDailyLossBreach(
  strategy: Strategy,
  adapter: ExchangeAdapter,
  todayPnl: number,
) {
  const { createRiskEvent } = await import("../db");
  let positionClosed = false;
  try {
    // 從交易所查詢真實持倉方向（OKX 雙向持倉模式必須指定 posSide）
    let dailyLossPosSide: "long" | "short" | undefined;
    try {
      const positions = await adapter.getPositions(strategy.symbol);
      const activePos = positions.find((p) => p.size > 0);
      if (activePos) dailyLossPosSide = activePos.side as "long" | "short";
    } catch {
      const ms = (strategy as any).martinState;
      if (ms?.isLong === true) dailyLossPosSide = "long";
      else if (ms?.isLong === false) dailyLossPosSide = "short";
    }
    console.log(`[executor] 每日虧損平倉 策略 ${strategy.id} posSide=${dailyLossPosSide ?? "unknown"}`);
    const result = await adapter.closePositionSmart(strategy.symbol, dailyLossPosSide);
    positionClosed = result.success;
    if (result.success) {
      const exitPriceDL = result.filledPrice || 0;
      await createTrade({
        strategyId: strategy.id,
        userId: strategy.userId,
        exchange: strategy.exchange,
        symbol: strategy.symbol,
        side: dailyLossPosSide === "short" ? "buy" : "sell",
        orderType: "market",
        orderId: result.orderId,
        size: String(result.filledSize || 0),
        price: exitPriceDL > 0 ? String(exitPriceDL) : undefined,
        reduceOnly: true,
        status: "filled",
        triggerSource: "risk_daily_loss",
      });
    }
  } catch {
    positionClosed = false;
  }
  await disableStrategySystem(
    strategy.id,
    `每日虧損上限觸發（今日已實現盈虧 ${todayPnl.toFixed(2)} USDT）`,
  );

  // 寫入訊號日誌
  try {
    await createSignal({
      strategyId: strategy.id,
      userId: strategy.userId,
      rawPayload: JSON.stringify({
        action: "close",
        symbol: strategy.symbol,
        eventType: "daily_loss_limit",
        todayPnl,
        maxDailyLoss: strategy.maxDailyLoss,
        source: "executor_daily_loss",
      }),
      parsedAction: "close",
      parsedSymbol: strategy.symbol,
      status: positionClosed ? "executed" : "failed",
      message: positionClosed
        ? `[每日虧損] ${strategy.symbol} 觸發每日虧損上限平倉成功（今日 ${todayPnl.toFixed(2)} USDT，上限 ${strategy.maxDailyLoss} USDT）`
        : `[每日虧損] ${strategy.symbol} 觸發每日虧損上限平倉失敗`,
      source: "auto",
    });
  } catch (e) {
    console.error(`[executor] handleDailyLossBreach 寫入訊號日誌失敗`, e);
  }

  await createRiskEvent({
    strategyId: strategy.id,
    userId: strategy.userId,
    eventType: "daily_loss_limit",
    detail: `今日已實現盈虧 ${todayPnl.toFixed(2)} USDT，超過上限 ${strategy.maxDailyLoss} USDT`,
    positionClosed,
    strategyDisabled: true,
  });
}

/**
 * 完整 webhook 訊號處理入口：記錄 → 驗證 → 執行 → 更新日誌
 */
export async function processWebhookSignal(
  strategy: Strategy | undefined,
  rawBody: string,
  payload: any,
  providedSecret: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  const startTime = Date.now();

  // 記錄原始訊號
  const signalId = await createSignal({
    strategyId: strategy?.id,
    userId: strategy?.userId,
    rawPayload: rawBody.slice(0, 8000),
    status: "received",
    source: "webhook",
  });

  const finish = async (
    status: "executed" | "failed" | "rejected" | "skipped",
    message: string,
    extra: Partial<{ orderId: string; exchangeResponse: string; parsed: ParsedSignal }> = {},
  ) => {
    await updateSignal(signalId, {
      status,
      message,
      orderId: extra.orderId,
      exchangeResponse: extra.exchangeResponse?.slice(0, 8000),
      parsedAction: extra.parsed?.action,
      parsedSymbol: extra.parsed?.symbol,
      parsedPrice: extra.parsed?.price !== undefined ? String(extra.parsed.price) : undefined,
      latencyMs: Date.now() - startTime,
    });
    return { ok: status === "executed" || status === "skipped", message };
  };

  if (!strategy) {
    return finish("rejected", "找不到對應的策略");
  }

  // 驗證 secret token
  if (!providedSecret || providedSecret !== strategy.webhookSecret) {
    return finish("rejected", "Secret token 驗證失敗");
  }

  if (!strategy.enabled) {
    return finish("rejected", `策略已停用${strategy.disabledReason ? `（${strategy.disabledReason}）` : ""}`);
  }

  // 解析訊號
  const parsed = parseSignalPayload(payload);
  if (!parsed) {
    return finish("failed", "無法解析訊號內容，需包含 action: buy/sell/close", {});
  }

  // 執行
  try {
    const result = await executeSignal(strategy, parsed, signalId);
    return finish(result.status, result.message, {
      orderId: result.orderId,
      exchangeResponse: result.exchangeResponse,
      parsed,
    });
  } catch (e: any) {
    return finish("failed", `執行異常: ${e.message}`, { parsed });
  }
}
