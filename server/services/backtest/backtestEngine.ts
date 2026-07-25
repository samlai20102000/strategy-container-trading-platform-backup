/**
 * 回測引擎核心（pasted_content_4.txt 任務 4）
 *
 * 與實盤 V3.5 策略邏輯完全統一：
 * - KAMA 雙線方向鎖（完整遞迴 KAMA，非簡化版）
 * - 3K 形態驗證 + 破位條件（同 strategy_kama_3k_v35.validateSignal）
 * - 馬丁加倉（偏離 Martin_Step_Pct，倍率 Martin_Multiplier，上限 Max_Layers）
 *   倉位計算直接複用 StrategyKama3kV35.calculateMartingaleLotSize（三格式優先級）
 * - 移動止盈（Target_TP_Pct 激活 + Callback_Pct 回撤平倉，同 trailingStopManager）
 * - 極限止損（條件 A：浮虧 ≥ Max_Drawdown_Pct；條件 B：偏離最後層 ≥ Max_Deviation_Pct）
 * - 分流冷卻（分流 A 止盈立即重入 / 分流 B 馬丁解套冷卻）
 */

import { getBacktestDatabase, type OHLCVRow } from "./backtestDatabase";
import { ensureOHLCVData } from "./dataFetcher";
import { calculateKAMASeries } from "./kama";
import { TradingPairManager } from "../tradingPairManager";
import { prepareSymbolForExecution } from "../symbolMiddleware";
import {
  calculatePerformance,
  type EquityPoint,
  type PerformanceMetrics,
  type TradeRecord,
} from "./performanceCalculator";
import { getTimeframeMilliseconds } from "./timeframeParser";

import { getStrategy } from "../strategyStudio";
import { validateRiskSettings, buildEnvironmentSnapshot } from "../riskSettingsValidator";
import { parseMartinLayers, getStepPct, getLayerSize, getFirstOrderValue, getLayerStepPct, calculateLayerLot, getLayerMultiplier, V4Config, MartinLayer } from "../martingaleEngine";
import { validateAndProcessMartinConfig } from "../parameterValidator";
import { decideCloseSplit } from "../kamaReversalGuard";
import type { BaseStrategy, MartinState, StrategyInstanceConfig } from "../../strategies/base";
import { StrategyKama3kBreakoutV25 } from "../../strategies/v25/strategy_kama_3k_breakout_v25";
import { Strategy20415 } from "../../strategies/builtin/strategy20415";
import {
  applyV25CloseToState,
  applyV25FillToState,
  createV25RuntimeState,
  type V25CoreDecision,
  type V25RuntimeState,
} from "../../strategies/v25/core";
import { V25_STRATEGY_KEY } from "../../../shared/strategies/kama3kBreakoutV25";
import {
  applyRainbow20415CloseToState,
  applyRainbow20415FillToState,
  createRainbow20415RuntimeState,
  evaluateRainbow20415Decision,
  evaluateRainbow20415Management,
  type Rainbow20415CoreDecision,
  type Rainbow20415RuntimeState,
} from "../../strategies/rainbow20415/core";
import {
  assertValidRainbow20415Config,
  RAINBOW_20415_STRATEGY_KEY,
} from "../../../shared/strategies/rainbow20415";

export interface BacktestRequest {
  strategyKey: string;
  symbol: string; // 支持任何格式，自動標準化為 OKX 標準格式
  timeframe: string;
  /** 秒或毫秒時間戳皆可（自動判別） */
  startDate: number;
  endDate: number;
  initialCapital: number;
  config: Record<string, unknown>;
  commission?: number; // 單邊手續費率，默認 0.0004
  slippage?: number; // 滑點率，默認 0.0001
  exchange?: "okx" | "bybit";
}

export interface BacktestResult {
  runId: string;
  strategyKey: string;
  strategyName: string;
  trades: TradeRecord[];
  metrics: PerformanceMetrics;
  equityCurve: EquityPoint[];
  config: Record<string, unknown>;
  summary: string;
  candleCount: number;
  /** V5.7 環境快照元數據 */
  environment?: {
    engineVersion: string;
    dataHash: string;
    leverage: number;
    commission: number;
    slippage: number;
    symbol: string;
    timeframe: string;
    startDate: number;
    endDate: number;
    candleCount: number;
    initialCapital: number;
  };
}

interface PositionLayer {
  price: number;
  size: number;
  time: number;
}

interface OpenPosition {
  side: "long" | "short";
  layers: PositionLayer[];
  avgPrice: number;
  totalSize: number;
  entryTime: number;
  peakPnlPct: number; // 移動止盈追蹤的最高浮盈%
  tpActivated: boolean;
  /** O2/O3：入場時的 KAMA 方向（true = 升勢） */
  entryTrendBull: boolean;
}

function toMs(ts: number): number {
  // 秒級時間戳（< 10^12）自動轉毫秒
  return ts < 1e12 ? ts * 1000 : ts;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : Number.isFinite(n) && n === 0 ? 0 : fallback;
}

export class BacktestEngine {
  /**
   * 執行完整回測
   */
  async runBacktest(
    request: BacktestRequest,
    onProgress?: (pct: number, message: string) => void,
  ): Promise<BacktestResult> {
    // 統一交易對驗證和標準化（應用於所有回測）
    try {
      const symbolResult = await prepareSymbolForExecution(
        request.symbol,
        request.strategyKey,
        'SWAP'
      );
      
      if (symbolResult.valid) {
        // 更新為標準化的交易對名稱
        request.symbol = symbolResult.normalized;
        console.log(`[Backtest] ✓ 交易對已驗證和標準化: ${request.symbol}`);
      } else {
        // 驗證失敗時：如果是測試環境或用戶提供了自定義 K 線數據，允許繼續
        // 這樣回測可以使用自定義/虛構交易對進行策略邏輯測試
        console.warn(`[Backtest] ⚠ 交易對驗證未通過: ${symbolResult.error}，使用原始名稱繼續回測`);
      }
    } catch (error) {
      // 驗證服務不可用時不應阻止回測（容錯設計）
      console.warn('[Backtest] ⚠ 交易對驗證服務異常，使用原始名稱繼續:', (error as Error).message);
    }

    const startMs = toMs(request.startDate);
    const endMs = toMs(request.endDate);
    if (endMs <= startMs) throw new Error("結束時間必須晚於開始時間");

    // === 任務 A2：策略動態載入（不再硬編碼 V3.5）===
    const strategy = getStrategy(request.strategyKey);
    if (!strategy) {
      throw new Error(`策略「${request.strategyKey}」未註冊，請確認策略 key 正確`);
    }
    const isV35 = request.strategyKey === "20415_KAMA_MARTIN_V35";
    const isV50 = request.strategyKey === "KAMA_3K_ULTIMATE_V50";
    const isV61 = request.strategyKey === "KAMA_3K_HF_V61";
    const isV70 = request.strategyKey === "KAMA_3K_TORNADO_V70";
    const isV25 = request.strategyKey === V25_STRATEGY_KEY;
    const isRainbow20415 = request.strategyKey === RAINBOW_20415_STRATEGY_KEY;

    // 合併策略默認配置（與實盤 resolveConfig 邏輯一致，依選中策略的 defaultConfig）
    const config: Record<string, unknown> = {
      ...strategy.defaultConfig,
      ...request.config,
    };

    // V5.7: 風控參數驗證
    const riskValidation = validateRiskSettings(config);
    if (!riskValidation.valid) {
      console.warn(`[Backtest] 風控參數校驗失敗:`, riskValidation.errors);
    }
    if (riskValidation.warnings.length > 0) {
      console.warn(`[Backtest] 風控參數警告:`, riskValidation.warnings);
    }

    // 任務 A4：每次回測都是全新執行（無結果快取），日誌佐證
    console.log(
      `[Backtest] 新回測執行：策略=${request.strategyKey}（${strategy.name}） 品種=${request.symbol} 框架=${request.timeframe} 參數=${JSON.stringify(request.config)}`,
    );

    const commission = request.commission ?? 0.0004;
    const slippage = request.slippage ?? 0.0001;

    onProgress?.(5, "載入歷史數據中...");
    const candles = await ensureOHLCVData(
      request.symbol,
      request.timeframe,
      startMs,
      endMs,
      request.exchange ?? "okx",
      (p) => onProgress?.(5 + Math.min(25, p.fetched / 400), p.message),
    );

    if (candles.length < 120) {
      throw new Error(
        `歷史數據不足（僅 ${candles.length} 根 K 線），至少需要 120 根。請縮短時間框架或調整日期區間。`,
      );
    }

    // 20415 七彩虹：M1 管理 + 已收盤 M30 七線掃描，逐步調用與實盤相同的純核心。
    if (isRainbow20415) {
      if (!(strategy instanceof Strategy20415)) {
        throw new Error("20415 七彩虹回測引擎類型不一致");
      }
      return this.runRainbow20415Backtest(
        request,
        strategy,
        config,
        candles,
        startMs,
        endMs,
        commission,
        slippage,
        onProgress,
      );
    }

    // V2.5：逐 K 調用與實盤相同的獨立純核心，禁止落入通用 SMA 回測空殼。
    if (isV25) {
      if (!(strategy instanceof StrategyKama3kBreakoutV25)) {
        throw new Error("V2.5 回測引擎類型不一致");
      }
      return this.runV25Backtest(
        request,
        strategy,
        config,
        candles,
        startMs,
        endMs,
        commission,
        slippage,
        onProgress,
      );
    }

    // === V5.0 策略：複用 V3.5 KAMA+3K 回測路徑（同樣的 KAMA 指標 + 3K 形態 + 馬丁，但參數來自 V5.0 配置）===
    // V5.0 和 V3.5 共享相同的 KAMA+3K 回測核心，差異僅在參數預設值和 F1-F6 模組（在實盤中生效）
    if (!isV35 && !isV50 && !isV61 && !isV70) {
      return this.runGenericBacktest(
        request, strategy, config, candles, startMs, endMs, commission, slippage, onProgress,
      );
    }

    // V7.0 龍捲風雙渦輪：使用專屬回測路徑
    if (isV70) {
      return this.runV70Backtest(
        request, strategy, config, candles, startMs, endMs, commission, slippage, onProgress,
      );
    }

    onProgress?.(35, `數據就緒（${candles.length} 根），計算 KAMA 指標...`);

    // === KAMA 雙線（完整遞迴計算，與實盤定義一致）===
    // V6.1 使用小寫 key（kama_fast_length），V3.5/V5.0 使用大寫 key（KAMA_Fast_Length）
    const closes = candles.map((c) => c.close);
    const kamaFastLen = num(config.kama_fast_length ?? config.KAMA_Fast_Length, 50);
    const kamaFast = calculateKAMASeries(
      closes,
      kamaFastLen,
      num(config.kama_fast_fastest ?? config.p2_fastest, 10),
      num(config.kama_fast_slowest ?? config.p3_slowest, 2),
    );
    const kamaSlow = calculateKAMASeries(
      closes,
      num(config.kama_slow_length ?? config.KAMA_Slow_Length, 50),
      num(config.kama_slow_fastest ?? config.q2_fastest, 10),
      num(config.kama_slow_slowest ?? config.q3_slowest, 6),
    );

    // === 策略參數 ===
    const martinStepPct = num(config.Martin_Step_Pct, 2.0);
    // BE-1/BE-2（Pasted_content_22）：參數驗證與聯動——有分層時 Max_Layers 自動 = 最後一層 end，
    // 並忽略固定 Martin_Multiplier（usedMode=layered）；重疊/間隙直接拋錯
    const martinCfg = validateAndProcessMartinConfig(config);
    const martinMultiplier =
      martinCfg.usedMode === "fixed" ? num(config.Martin_Multiplier, 1.5) : martinCfg.effectiveMultiplier(1);
    const maxLayers = martinCfg.maxLayers;
    console.log(
      `[Backtest] 馬丁模式: ${martinCfg.usedMode === "layered" ? "階梯式分層" : "固定乘數"}，Max_Layers=${maxLayers}`,
    );
    const targetTpPct = num(config.Target_TP_Pct, 1.0);
    const callbackPct = num(config.Callback_Pct, 0.1);
    // V5.8 修復：maxDrawdownPct 應獨立於 Max_Loss_Pct，使用專屬參數 Max_Drawdown_Pct
    const maxDrawdownPct = num(config.Max_Drawdown_Pct ?? 10, 10);
    const maxDeviationPct = num(config.Max_Deviation_Pct ?? config.max_deviation_pct ?? 3, 3);
    const tfMs = getTimeframeMilliseconds(request.timeframe);
    const cooldownMs = tfMs * 2; // 分流 B：馬丁解套冷卻 = K 線週期 × 2
    // === 馬丁分層規則 ===
    const martinLayersRules = parseMartinLayers(Array.isArray(config.Martin_Layers) ? config.Martin_Layers : []);
    // 🔥 固定金本位模式：Base_Lot_Size 為 USDT 金額（首單固定金額）
    // 優先使用 Base_Lot_Size（大寫），其次 base_lot_size（小寫，V6.1 用），否則回退 V4.0 百分比模式
    const baseLotObj = config.Base_Lot_Size ?? config.base_lot_size;
    let baseLotUsdt: number;
    if (typeof baseLotObj === 'object' && baseLotObj !== null && (baseLotObj as any).mode === 'usdt') {
      baseLotUsdt = Number((baseLotObj as any).value) || 30;
    } else if (typeof baseLotObj === 'number' && baseLotObj >= 1) {
      // 如果 Base_Lot_Size 是數字且 >= 1，視為 USDT 金額（固定金本位）
      baseLotUsdt = baseLotObj;
    } else {
      // 回退 V4.0 百分比模式
      baseLotUsdt = request.initialCapital * (num(config.First_Order_Pct, 0.5) / 100);
    }
    console.log(`[Backtest] 首單模式: 固定金本位 ${baseLotUsdt} USDT，Initial_Capital=${request.initialCapital}`);
    // V3.7：硬止損觸發閾值
    const maxLossPct = num(config.Max_Loss_Pct ?? 5, 5);
    const reentryOnTrend = config.Reentry_On_Trend !== false && config.Reentry_On_Trend !== "false";
    const maxLossUsdt = num(config.Max_Loss_USDT ?? 0, 0); // 預設 0 = 不啟用（由 Max_Loss_Pct 控制）
    // === 連續虧損縮倉 & 連續開倉開關（V6.1 風控功能）===
    const enableLossShrinkRaw = config.enable_loss_shrink ?? config.Enable_Loss_Shrink ?? "1";
    const enableLossShrink = Number(enableLossShrinkRaw) === 1 || enableLossShrinkRaw === true;
    const lossShrinkLevel1 = num(config.loss_shrink_level1 ?? config.Loss_Shrink_Level1 ?? 3, 3);
    const lossShrinkLevel1Pct = num(config.loss_shrink_level1_pct ?? config.Loss_Shrink_Level1_Pct ?? 70, 70);
    const lossShrinkLevel2 = num(config.loss_shrink_level2 ?? config.Loss_Shrink_Level2 ?? 5, 5);
    const lossShrinkLevel2Pct = num(config.loss_shrink_level2_pct ?? config.Loss_Shrink_Level2_Pct ?? 50, 50);
    const enableContinuousEntryRaw = config.enable_continuous_entry ?? config.Enable_Continuous_Entry ?? "1";
    const enableContinuousEntry = Number(enableContinuousEntryRaw) === 1 || enableContinuousEntryRaw === true;
    if (martinLayersRules) {
      console.log(`[Backtest] O1 階梯式馬丁分層啟用：${JSON.stringify(martinLayersRules)}`);
    }
    console.log(`[Backtest] 風控開關: enable_loss_shrink=${enableLossShrink}, enable_continuous_entry=${enableContinuousEntry}`);

    // === V6.1 區域觸發參數（entry_zone_mode / direction_mode / buffer / ADX）===
    const entryZoneMode = String(config.entry_zone_mode ?? 'breakout');
    const directionMode = String(config.direction_mode ?? 'hybrid');
    const bufferAtrMultTrend = num(config.buffer_atr_multiplier_trend, 0.25);
    const bufferAtrMultWeak = num(config.buffer_atr_multiplier_weak, 0.30);
    const bufferAtrMultRanging = num(config.buffer_atr_multiplier_ranging, 0.50);
    const adxPeriod = num(config.adx_period, 14);
    const adxTrendThreshold = num(config.adx_trend_threshold, 25);
    const adxStrongThreshold = num(config.adx_strong_threshold, 30);
    const atrRatioThreshold = num(config.atr_ratio_threshold, 1.2);
    const minAtrRatio = num(config.min_atr_ratio, 0.7);
    // V6.1 ATR 系列（用於區域觸發和方向過濾）
    const v61AtrSeries = calculateATRSeries(candles, 14);
    // 🔥 性能優化：預計算 ATR MA(50) 滑動窗口陣列，避免每根 K 線都做 slice+filter+reduce
    const v61AtrMaSeries: number[] = new Array(candles.length).fill(0);
    if (isV61) {
      let atrMaSum = 0;
      let atrMaCount = 0;
      for (let j = 0; j < candles.length; j++) {
        const atrJ = v61AtrSeries[j];
        if (atrJ !== null) {
          atrMaSum += atrJ;
          atrMaCount++;
          // 移除超出窗口的舊值
          const removeIdx = j - 50;
          if (removeIdx >= 0 && v61AtrSeries[removeIdx] !== null) {
            atrMaSum -= v61AtrSeries[removeIdx]!;
            atrMaCount--;
          }
          v61AtrMaSeries[j] = atrMaCount > 0 ? atrMaSum / atrMaCount : 0;
        }
      }
      console.log(`[Backtest] V6.1 區域觸發模式: entry_zone_mode=${entryZoneMode}, direction_mode=${directionMode}`);
      console.log(`[Backtest] 🔥 性能優化已啟用：預計算 ATR MA + 滑動窗口 + event loop yield`);
    }

    // === 回測狀態 ===
    const trades: TradeRecord[] = [];
    const equityCurve: EquityPoint[] = [];
    let equity = request.initialCapital;
    let position: OpenPosition | null = null;
    let cooldownUntil = 0; // 分流 B：馬丁解套冷却截止時間
    let tradeId = 0;
    let consecutiveLoss = 0; // 連續虧損計數（用於 enable_loss_shrink）
    /** O3：平倉後待重入請求（在主循環中執行；用物件包裝避免閉包窄化為 never） */
    const reentryBox: { req: { side: "long" | "short"; entryTrendBull: boolean } | null } = { req: null };

    const startIdx = Math.max(kamaFastLen + 2, 3);

    const closePosition = (
      exitPrice: number,
      exitTime: number,
      reason: string,
    ): void => {
      if (!position) return;
      const p = position;
      const effExit =
        p.side === "long" ? exitPrice * (1 - slippage) : exitPrice * (1 + slippage);
      const grossPnl =
        p.side === "long"
          ? (effExit - p.avgPrice) * p.totalSize
          : (p.avgPrice - effExit) * p.totalSize;
      const fees = (p.avgPrice + effExit) * p.totalSize * commission;
      const pnl = grossPnl - fees;
      const pnlPct = p.avgPrice > 0 ? (grossPnl / (p.avgPrice * p.totalSize)) * 100 : 0;

      equity += pnl;
      // 連續虧損計數（用於 enable_loss_shrink 縮倉功能）
      if (pnl < 0) {
        consecutiveLoss++;
      } else {
        consecutiveLoss = 0;
      }
      trades.push({
        id: ++tradeId,
        entryTime: p.entryTime,
        exitTime,
        side: p.side,
        entryPrice: Math.round(p.avgPrice * 100) / 100,
        exitPrice: Math.round(effExit * 100) / 100,
        size: p.totalSize,
        pnl: Math.round(pnl * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
        exitReason: reason,
        martinLayer: p.layers.length - 1,
      });

      // === O3 平倉分流（統一純函數 decideCloseSplit）===
      // 馬丁層數（文件語義）= layers.length - 1（首單 = 第 0 層）
      const martinDepth = p.layers.length - 1;
      const kfNow = lastKamaFast;
      const ksNow = lastKamaSlow;
      const split = decideCloseSplit({
        martinDepth,
        exitReason: reason === "移動止盈" ? "trailing_stop" : reason,
        entryTrendBull: p.entryTrendBull,
        currentKamaFast: kfNow,
        currentKamaSlow: ksNow,
        kLinePeriod: tfMs / 60000,
        cooldownBars: 2,
        reentryEnabled: reentryOnTrend,
      });

      if (split.action === "cooldown") {
        // 分流 B：馬丁解套 → 強制冷卻
        cooldownUntil = exitTime + split.cooldownMs;
      } else if (reason === "極限止損" || reason === "每日虧損上限" || reason === "硬止損" || reason === "絕對金額限損") {
        // 風控性平倉：即使無馬丁也強制冷卻（防止立即重入）
        cooldownUntil = exitTime + cooldownMs;
      } else if (split.action === "reenter") {
        // 分流 A：第 0 層順勢重入（在主循環執行市價重入）
        reentryBox.req = { side: p.side, entryTrendBull: p.entryTrendBull };
      }
      position = null;
    };

    // 供 closePosition 內分流判斷使用的最新 KAMA 快照（主循環每根 K 線更新）
    let lastKamaFast = 0;
    let lastKamaSlow = 0;

    // === 主循環（i 從 startIdx 開始，k1=i-2, k2=i-1, k3=i）===
    for (let i = startIdx; i < candles.length; i++) {
      const k1 = candles[i - 2];
      const k2 = candles[i - 1];
      const k3 = candles[i];
      const price = k3.close;
      const now = k3.timestamp;

      if (i % 2000 === 0) {
        const pct = 35 + Math.floor(((i - startIdx) / (candles.length - startIdx)) * 60);
        onProgress?.(pct, `回測計算中 ${i}/${candles.length}（${Math.round(pct)}%）...`);
        // 🔥 性能優化：定期 yield event loop，讓 WebSocket/HTTP 進度推送有機會執行
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      // 更新 KAMA 快照（供平倉分流與 O2 反轉檢查使用）
      if (kamaFast[i] !== null && kamaSlow[i] !== null) {
        lastKamaFast = kamaFast[i] as number;
        lastKamaSlow = kamaSlow[i] as number;
      }

      // ====== 持倉監控（V3.7 優先級：移動止盈 > 硬止損 + 極限止損 > 馬丁加倉）======
      if (position) {
        const p: OpenPosition = position;
        const pnlPct =
          p.side === "long"
            ? ((price - p.avgPrice) / p.avgPrice) * 100
            : ((p.avgPrice - price) / p.avgPrice) * 100;

        // --- 🔥 統一止損機制（基於 Initial_Capital 本金） ---
        // 優先級 1：總浮虧金額 ≥ Initial_Capital × Max_Loss_Pct%（硬止損）
        // 優先級 2：總浮虧金額 ≥ Max_Loss_USDT（絕對金額限損，預設 0 = 不啟用）
        // 優先級 3：極限止損（Max_Drawdown_Pct / 最後層偏離）
        const totalCost = p.avgPrice * p.totalSize;
        const currentValue = price * p.totalSize;
        const floatingLoss = p.side === "long"
          ? (totalCost - currentValue)
          : (currentValue - totalCost);
        // 🔥 硬止損基於本金：Max_Loss_Pct% × Initial_Capital
        const maxLossAbsolute = request.initialCapital * (maxLossPct / 100);

        // 條件 1：總浮虧金額 ≥ maxLossAbsolute（硬止損）
        if (maxLossPct > 0 && floatingLoss > 0 && floatingLoss >= maxLossAbsolute) {
          closePosition(price, now, "硬止損");
          equityCurve.push({ timestamp: now, equity, price });
          continue;
        }

        // 條件 2：總浮虧金額 ≥ Max_Loss_USDT（絕對金額限損）
        if (maxLossUsdt > 0 && floatingLoss >= maxLossUsdt) {
          closePosition(price, now, "絕對金額限損");
          equityCurve.push({ timestamp: now, equity, price });
          continue;
        }

        // 條件 3：極限止損（後備防線）
        // 條件 A：浮虧 ≥ Max_Drawdown_Pct
        const conditionA = pnlPct <= -maxDrawdownPct;
        // 條件 B：滿層後價格繼續偏離最後一層 ≥ Max_Deviation_Pct
        const lastLayer = p.layers[p.layers.length - 1];
        const deviationFromLast =
          p.side === "long"
            ? ((lastLayer.price - price) / lastLayer.price) * 100
            : ((price - lastLayer.price) / lastLayer.price) * 100;
        const conditionB = p.layers.length >= maxLayers && deviationFromLast >= maxDeviationPct;
        if (conditionA || conditionB) {
          // V5.8：記錄極限止損觸發原因（含閾值）
          const reason = conditionA 
            ? `極限止損（浮虧保護觸發：${pnlPct.toFixed(2)}% <= -${maxDrawdownPct}%）`
            : `極限止損（最後層偏離保護觸發：${deviationFromLast.toFixed(2)}% >= ${maxDeviationPct}%）`;
          closePosition(price, now, reason);
          equityCurve.push({ timestamp: now, equity, price });
          continue;
        }

        // --- 2. 移動止盈（同 trailingStopManager：激活 → 追蹤峰值 → 回撤平倉）---
        if (!p.tpActivated && pnlPct >= targetTpPct) {
          p.tpActivated = true;
          p.peakPnlPct = pnlPct;
        }
        if (p.tpActivated) {
          if (pnlPct > p.peakPnlPct) p.peakPnlPct = pnlPct;
          if (p.peakPnlPct - pnlPct >= callbackPct) {
            closePosition(price, now, "移動止盈");
            equityCurve.push({ timestamp: now, equity, price });
            continue;
          }
        }

        // --- 3. 馬丁加倉（固定金本位 + 階梯式分層乘數 + 動態間距）---
        if (p.layers.length < maxLayers) {
          const nextLayer = p.layers.length + 1;
          // 動態間距：優先使用分層專屬 stepPct，否則回退全局 martinStepPct
          const dynamicStepPct = getLayerStepPct(nextLayer, martinLayersRules, martinStepPct);
          const lastPrice = p.layers[p.layers.length - 1].price;
          const deviation =
            p.side === "long"
              ? ((lastPrice - price) / lastPrice) * 100
              : ((price - lastPrice) / lastPrice) * 100;
          if (deviation >= dynamicStepPct) {
            // 🔥 固定金本位加倉：baseLotUsdt × 階梯式累乘（calculateLayerLot）
            const layerLotUsdt = calculateLayerLot(baseLotUsdt, p.layers.length, martinLayersRules, martinMultiplier);
            const lotSize = layerLotUsdt / price;
            const effPrice =
              p.side === "long" ? price * (1 + slippage) : price * (1 - slippage);
            p.layers.push({ price: effPrice, size: lotSize, time: now });
            // 均價更新（成交量加權）
            const totalCost = p.layers.reduce((s, l) => s + l.price * l.size, 0);
            p.totalSize = p.layers.reduce((s, l) => s + l.size, 0);
            p.avgPrice = totalCost / p.totalSize;
            // 加倉後重置移動止盈追蹤（均價變動）
            p.tpActivated = false;
            p.peakPnlPct = 0;
          }
        }

        equityCurve.push({ timestamp: now, equity: equityWithUnrealized(equity, p, price), price });
        continue;
      }

      // ====== 無持倉：入市判斷（同 strategy_kama_3k_v35.validateSignal 五層驗證）======

      // 冷卻期檢查（分流 B）
      if (now < cooldownUntil) {
        reentryBox.req = null; // 冷卻期內不執行重入
        equityCurve.push({ timestamp: now, equity, price });
        continue;
      }

      const kf = kamaFast[i];
      const ks = kamaSlow[i];
      if (kf === null || ks === null) {
        equityCurve.push({ timestamp: now, equity, price });
        continue;
      }

      // === O3：第 0 層順勢平倉原地重入（優先於新 3K 入場判斷）===
      const reentryReq = reentryBox.req;
      if (reentryReq) {
        const currentTrendBull = kf > ks;
        // 重入前再確認 KAMA 方向仍未變（雙重防線）
        if (currentTrendBull === reentryReq.entryTrendBull) {
          const side = reentryReq.side;
          // 🔥 固定金本位重入：首單 = baseLotUsdt / price（含縮倉）
          let reentryLotUsdt = baseLotUsdt;
          if (enableLossShrink) {
            if (consecutiveLoss >= lossShrinkLevel2) {
              reentryLotUsdt = baseLotUsdt * (lossShrinkLevel2Pct / 100);
            } else if (consecutiveLoss >= lossShrinkLevel1) {
              reentryLotUsdt = baseLotUsdt * (lossShrinkLevel1Pct / 100);
            }
          }
          const baseSize = reentryLotUsdt / price;
          const effPrice = side === "long" ? price * (1 + slippage) : price * (1 - slippage);
          position = {
            side,
            layers: [{ price: effPrice, size: baseSize, time: now }],
            avgPrice: effPrice,
            totalSize: baseSize,
            entryTime: now,
            peakPnlPct: 0,
            tpActivated: false,
            entryTrendBull: currentTrendBull,
          };
        }
        reentryBox.req = null;
        equityCurve.push({
          timestamp: now,
          equity: position ? equityWithUnrealized(equity, position, price) : equity,
          price,
        });
        continue;
      }

      // KAMA 方向鎖
      const trendBull = kf > ks;
      const trendBear = kf < ks;

      let side: "long" | "short" | null = null;

      if (isV61) {
        // ===== V6.1 區域觸發模式（entry_zone_mode + direction_mode）=====
        const atrVal = v61AtrSeries[i] ?? 0;
        if (atrVal > 0) {
          // 🔥 性能優化：使用預計算的 ATR MA(50)，避免每根 K 線都做 slice+filter+reduce
          const atrMa = v61AtrMaSeries[i];

          // 最小 ATR 過濾
          const passAtrFilter = atrMa === 0 || atrVal >= minAtrRatio * atrMa;

          if (passAtrFilter) {
            // 市場制度判斷（簡化版 ADX）
            let regime = 'ranging';
            // 🔥 性能優化：用索引直接判斷而非 candles.slice
            if (i >= adxPeriod) {
              // 簡化的趨勢強度：用 KAMA 差值 / ATR 作為代理
              const kamaSpread = Math.abs(kf - ks);
              const normalizedSpread = kamaSpread / atrVal;
              if (normalizedSpread > adxStrongThreshold / 10 && atrVal > atrMa * atrRatioThreshold) {
                regime = 'strong_trend';
              } else if (normalizedSpread > adxTrendThreshold / 10) {
                regime = 'weak_trend';
              }
            }

            // 動態緩衝區倍數
            let bufferMult = bufferAtrMultRanging;
            if (regime === 'strong_trend') bufferMult = bufferAtrMultTrend;
            else if (regime === 'weak_trend') bufferMult = bufferAtrMultWeak;

            const buffer = bufferMult * atrVal;
            const zoneUpper = ks + buffer;
            const zoneLower = ks - buffer;

            // 區域觸發檢查
            let zoneDirection = 0;
            let zoneTriggered = false;
            if (entryZoneMode === 'breakout') {
              // 突破模式：價格穿出 Zone 邊界
              if (price > zoneUpper) { zoneTriggered = true; zoneDirection = 1; }
              else if (price < zoneLower) { zoneTriggered = true; zoneDirection = -1; }
            } else {
              // 內部模式：價格在 Zone 內
              if (price >= zoneLower && price <= zoneUpper) {
                zoneTriggered = true;
                const mid = (zoneLower + zoneUpper) / 2;
                zoneDirection = price >= mid ? 1 : -1;
              }
            }

            // 方向模式過濾
            if (zoneTriggered) {
              let directionPass = true;
              if (directionMode === 'trend') {
                directionPass = zoneDirection === 1 ? kf > ks : kf < ks;
              } else if (directionMode === 'hybrid') {
                if (regime !== 'ranging') {
                  directionPass = zoneDirection === 1 ? kf > ks : kf < ks;
                }
              }
              // both 模式不過濾

              if (directionPass) {
                side = zoneDirection === 1 ? 'long' : 'short';
              }
            }
          }
        }
      } else {
        // ===== V3.5/V5.0 原始 3K 形態 + 破位邏輯 =====
        // 多頭：k1、k2 皆陽 + k3 收盤突破前兩根最高
        const longPattern =
          k1.close > k1.open &&
          k2.close > k2.open &&
          k3.close >= Math.max(k1.high, k2.high);
        // 空頭：k1、k2 皆陰 + k3 收盤跌破前兩根最低
        const shortPattern =
          k1.close < k1.open &&
          k2.close < k2.open &&
          k3.close <= Math.min(k1.low, k2.low);

        if (trendBull && longPattern) side = "long";
        else if (trendBear && shortPattern) side = "short";
      }

      if (side) {
        // 連續開倉開關檢查（enable_continuous_entry = 0 時不開新倉）
        if (!enableContinuousEntry && trades.length > 0) {
          equityCurve.push({ timestamp: now, equity, price });
          continue;
        }
        // 🔥 固定金本位首單：baseLotUsdt / price
        let effectiveLotUsdt = baseLotUsdt;
        // 連續虧損縮倉（enable_loss_shrink = 1 時生效）
        if (enableLossShrink) {
          if (consecutiveLoss >= lossShrinkLevel2) {
            effectiveLotUsdt = baseLotUsdt * (lossShrinkLevel2Pct / 100);
          } else if (consecutiveLoss >= lossShrinkLevel1) {
            effectiveLotUsdt = baseLotUsdt * (lossShrinkLevel1Pct / 100);
          }
        }
        const baseSize = effectiveLotUsdt / price;
        const effPrice = side === "long" ? price * (1 + slippage) : price * (1 - slippage);
        position = {
          side,
          layers: [{ price: effPrice, size: baseSize, time: now }],
          avgPrice: effPrice,
          totalSize: baseSize,
          entryTime: now,
          peakPnlPct: 0,
          tpActivated: false,
          entryTrendBull: trendBull, // O2/O3：記錄入場 KAMA 方向
        };
      }

      equityCurve.push({
        timestamp: now,
        equity: position ? equityWithUnrealized(equity, position, price) : equity,
        price,
      });
    }

    // 回測結束：強制平倉未結倉位
    if (position) {
      const last = candles[candles.length - 1];
      closePosition(last.close, last.timestamp, "回測結束強制平倉");
      equityCurve.push({ timestamp: last.timestamp, equity, price: last.close });
    }

    onProgress?.(95, "計算績效指標...");
    const metrics = calculatePerformance(trades, equityCurve, request.initialCapital);

    const runId = makeRunId(request.strategyKey, request.symbol);
    const summary = `回測完成：${strategy.name} / ${request.symbol} ${request.timeframe}，共 ${candles.length} 根 K 線，${trades.length} 筆交易，總回報 ${metrics.totalReturn}%，勝率 ${metrics.winRate}%，最大回撤 ${metrics.maxDrawdown}%`;

    // 持久化到 SQLite（本地快取層）
    try {
      const db = getBacktestDatabase();
      db.saveBacktestResult(
        {
          run_id: runId,
          strategy_key: request.strategyKey,
          symbol: request.symbol,
          timeframe: request.timeframe,
          start_date: startMs,
          end_date: endMs,
          initial_capital: request.initialCapital,
          config: JSON.stringify(config),
          status: "completed",
          created_at: Date.now(),
        },
        trades,
      );
      // 權益曲線降採樣後儲存（最多 2000 點，避免膨脹）
      db.savePerformanceMetrics(runId, metrics, downsample(equityCurve, 2000));
    } catch (e) {
      console.warn("[Backtest] 結果持久化失敗（不影響回傳）:", e);
    }

    // V5.7: 構建環境快照元數據（V3.5 路徑）
    const envSnapshotV35 = buildEnvironmentSnapshot(
      request.symbol,
      request.timeframe,
      startMs,
      endMs,
      candles.length,
      request.initialCapital,
      commission,
      slippage,
      1,
      candles[0]?.close,
      candles[candles.length - 1]?.close,
    );

    onProgress?.(100, summary);

    return {
      runId,
      strategyKey: request.strategyKey,
      strategyName: strategy.name,
      trades,
      metrics,
      equityCurve: downsample(equityCurve, 2000),
      config,
      summary,
      candleCount: candles.length,
      environment: envSnapshotV35,
    };
  }

  /**
   * 20415 七彩虹專用同源回測。
   *
   * 輸入資料必須是管理週期（預設 M1）；引擎只在 M30 完整收盤後把聚合 Bar
   * 交給七線核心，持倉期間則每根 M1 以模擬權益與已用保證金執行盲人管理。
   */
  private runRainbow20415Backtest(
    request: BacktestRequest,
    strategy: Strategy20415,
    rawConfig: Record<string, unknown>,
    candles: OHLCVRow[],
    startMs: number,
    endMs: number,
    commission: number,
    slippage: number,
    onProgress?: (pct: number, message: string) => void,
  ): BacktestResult {
    const config = assertValidRainbow20415Config(rawConfig);
    const expectedTimeframe = config.Management_Interval_Minutes % 60 === 0
      ? `${config.Management_Interval_Minutes / 60}h`
      : `${config.Management_Interval_Minutes}m`;
    const entryTimeframeLabel = config.Entry_Timeframe_Minutes % 60 === 0
      ? `${config.Entry_Timeframe_Minutes / 60}h`
      : `${config.Entry_Timeframe_Minutes}m`;
    if (request.timeframe.toLowerCase() !== expectedTimeframe.toLowerCase()) {
      throw new Error(
        `20415 七彩虹回測必須使用 ${expectedTimeframe} 管理週期，才能逐段模擬止盈、階梯與三道風控；${entryTimeframeLabel} 入場由引擎內部聚合。`,
      );
    }

    type EntryCandle = {
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      timestamp: number;
    };

    const trades: TradeRecord[] = [];
    const equityCurve: EquityPoint[] = [];
    let equity = request.initialCapital;
    let tradeId = 0;
    let state: Rainbow20415RuntimeState = createRainbow20415RuntimeState({
      capital: request.initialCapital,
    });
    let positionMeta: {
      side: "long" | "short";
      entryTime: number;
      layers: PositionLayer[];
    } | null = null;

    const entryFrameMs = config.Entry_Timeframe_Minutes * 60_000;
    const requiredEntryBars = Math.max(...config.Lines.map((line) => line.period)) + 1;
    const closedEntryCandles: EntryCandle[] = [];
    let activeBucketStart = -1;
    let activeBucket: EntryCandle | null = null;
    let latestEntryBarClosed = false;

    const directionValue = String(
      rawConfig.Trade_Direction ?? rawConfig.Direction_Mode ?? rawConfig.directionMode ?? "both",
    ).toLowerCase();
    const allowedDirection: "long" | "short" | "both" =
      directionValue === "long" || directionValue === "short" ? directionValue : "both";

    const simulatedAccount = (price: number) => {
      const active = positionMeta as {
        side: "long" | "short";
        entryTime: number;
        layers: PositionLayer[];
      } | null;
      const unrealizedPnl = active && state.totalSize > 0
        ? active.side === "long"
          ? (price - state.avgPrice) * state.totalSize
          : (state.avgPrice - price) * state.totalSize
        : 0;
      const markEquity = Math.max(0.00000001, equity + unrealizedPnl);
      const usedMargin = state.totalCost > 0 ? state.totalCost : 0;
      return {
        equity: markEquity,
        balance: equity,
        usedMargin,
        marginUsagePct: (usedMargin / markEquity) * 100,
      };
    };

    const updateEntryAggregation = (candle: OHLCVRow): void => {
      latestEntryBarClosed = false;
      const bucketStart = Math.floor(candle.timestamp / entryFrameMs) * entryFrameMs;
      if (!activeBucket || bucketStart !== activeBucketStart) {
        if (activeBucket) {
          closedEntryCandles.push(activeBucket);
          latestEntryBarClosed = true;
        }
        activeBucketStart = bucketStart;
        activeBucket = {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          timestamp: bucketStart,
        };
        return;
      }
      activeBucket.high = Math.max(activeBucket.high, candle.high);
      activeBucket.low = Math.min(activeBucket.low, candle.low);
      activeBucket.close = candle.close;
      activeBucket.volume += candle.volume;
    };

    const quantityForDecision = (
      decision: Rainbow20415CoreDecision,
      fillPrice: number,
    ): number => {
      const orderSize = decision.orderSize ?? config.Base_Lot_Size;
      return orderSize.mode === "usdt" ? orderSize.value / fillPrice : orderSize.value;
    };

    const applyEntryOrAdd = (
      decision: Rainbow20415CoreDecision,
      timestamp: number,
    ): void => {
      if (!["buy", "sell", "add_long", "add_short"].includes(decision.action)) return;
      const isLong = decision.action === "buy" || decision.action === "add_long";
      const isInitial = decision.action === "buy" || decision.action === "sell";
      const fillPrice = isLong
        ? decision.price * (1 + slippage)
        : decision.price * (1 - slippage);
      const quantity = quantityForDecision(decision, fillPrice);
      if (!(fillPrice > 0) || !(quantity > 0) || !Number.isFinite(quantity)) return;
      const account = simulatedAccount(fillPrice);
      const barTimestamp = decision.metrics.mode === "SCAN"
        ? decision.metrics.lines.barTimestamp
        : undefined;
      state = applyRainbow20415FillToState(decision.nextState, {
        action: decision.action as "buy" | "sell" | "add_long" | "add_short",
        fillPrice,
        fillQuantity: quantity,
        timestamp,
        barTimestamp,
        targetLayer: decision.layerNum,
        accountEquity: account.equity,
      });
      if (isInitial || !positionMeta) {
        positionMeta = {
          side: isLong ? "long" : "short",
          entryTime: timestamp,
          layers: [{ price: fillPrice, size: quantity, time: timestamp }],
        };
      } else {
        positionMeta.layers.push({ price: fillPrice, size: quantity, time: timestamp });
      }
    };

    const applyClose = (
      decision: Rainbow20415CoreDecision,
      timestamp: number,
      forcedReason?: string,
    ): void => {
      const meta = positionMeta;
      if (!meta || state.totalSize <= 0 || state.avgPrice <= 0) return;
      const effectiveExitPrice = meta.side === "long"
        ? decision.price * (1 - slippage)
        : decision.price * (1 + slippage);
      const grossPnl = meta.side === "long"
        ? (effectiveExitPrice - state.avgPrice) * state.totalSize
        : (state.avgPrice - effectiveExitPrice) * state.totalSize;
      const entryNotional = meta.layers.reduce(
        (sum, layer) => sum + layer.price * layer.size,
        0,
      );
      const fees = (entryNotional + effectiveExitPrice * state.totalSize) * commission;
      const pnl = grossPnl - fees;
      const pnlPct = state.avgPrice > 0
        ? (grossPnl / (state.avgPrice * state.totalSize)) * 100
        : 0;
      equity += pnl;
      trades.push({
        id: ++tradeId,
        entryTime: meta.entryTime,
        exitTime: timestamp,
        side: meta.side,
        entryPrice: Math.round(state.avgPrice * 100) / 100,
        exitPrice: Math.round(effectiveExitPrice * 100) / 100,
        size: state.totalSize,
        pnl: Math.round(pnl * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
        exitReason: forcedReason ?? decision.reason,
        martinLayer: Math.max(0, state.currentLayer - 1),
      });
      state = applyRainbow20415CloseToState(
        decision.nextState,
        decision.closeReason ?? "OTHER",
        config,
        timestamp,
      );
      positionMeta = null;
    };

    onProgress?.(
      35,
      `數據就緒（${candles.length} 根 ${expectedTimeframe}），啟動 20415 七彩虹 ${entryTimeframeLabel}／${expectedTimeframe} 同源回測...`,
    );
    const first = candles[0];
    equityCurve.push({ timestamp: first.timestamp, equity, price: first.close });

    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index];
      updateEntryAggregation(candle);
      const hasPosition = state.currentLayer > 0 && state.totalSize > 0 && state.avgPrice > 0;
      let decision: Rainbow20415CoreDecision | null = null;

      if (hasPosition) {
        decision = evaluateRainbow20415Decision(closedEntryCandles, state, config, {
          allowedDirection,
          now: candle.timestamp,
          currentPrice: candle.close,
          account: simulatedAccount(candle.close),
        });
      } else if (latestEntryBarClosed) {
        decision = evaluateRainbow20415Decision(closedEntryCandles, state, config, {
          allowedDirection,
          now: candle.timestamp,
          currentPrice: candle.close,
          account: simulatedAccount(candle.close),
        });
      }

      if (decision) {
        if (decision.action === "hold") {
          state = decision.nextState;
        } else if (decision.action === "close") {
          applyClose(decision, candle.timestamp);
          if (state.rainbow20415Runtime?.pendingReentry && closedEntryCandles.length >= requiredEntryBars) {
            const reentry = evaluateRainbow20415Decision(closedEntryCandles, state, config, {
              allowedDirection,
              now: candle.timestamp,
              currentPrice: candle.close,
              account: simulatedAccount(candle.close),
            });
            if (reentry.action === "buy" || reentry.action === "sell") {
              applyEntryOrAdd(reentry, candle.timestamp);
            } else {
              state = reentry.nextState;
            }
          }
        } else {
          applyEntryOrAdd(decision, candle.timestamp);
        }
      }

      const active = positionMeta as {
        side: "long" | "short";
        entryTime: number;
        layers: PositionLayer[];
      } | null;
      const unrealizedPnl = active && state.totalSize > 0
        ? active.side === "long"
          ? (candle.close - state.avgPrice) * state.totalSize
          : (state.avgPrice - candle.close) * state.totalSize
        : 0;
      equityCurve.push({
        timestamp: candle.timestamp,
        equity: Math.round((equity + unrealizedPnl) * 100) / 100,
        price: candle.close,
      });

      if (index > 0 && index % 2000 === 0) {
        const progress = 35 + Math.floor((index / candles.length) * 60);
        onProgress?.(
          progress,
          `20415 七彩虹同源回測 ${index}/${candles.length}（${entryTimeframeLabel} 已收盤 ${closedEntryCandles.length} 根）...`,
        );
      }
    }

    if (positionMeta) {
      const last = candles[candles.length - 1];
      const forcedDecision = evaluateRainbow20415Management(
        { currentPrice: last.close, now: last.timestamp, account: simulatedAccount(last.close) },
        state,
        config,
      );
      applyClose(
        { ...forcedDecision, action: "close", reason: "回測結束強制平倉", closeReason: "OTHER" },
        last.timestamp,
        "回測結束強制平倉",
      );
      equityCurve.push({
        timestamp: last.timestamp,
        equity: Math.round(equity * 100) / 100,
        price: last.close,
      });
    }

    onProgress?.(95, "計算 20415 七彩虹績效指標...");
    const metrics = calculatePerformance(trades, equityCurve, request.initialCapital);
    const runId = makeRunId(request.strategyKey, request.symbol);
    const summary = `20415 七彩虹回測完成：${strategy.name} / ${request.symbol} ${request.timeframe}，共 ${candles.length} 根管理 K 線、${closedEntryCandles.length} 根已收盤 ${entryTimeframeLabel}、${trades.length} 筆交易，總回報 ${metrics.totalReturn}%，勝率 ${metrics.winRate}%，最大回撤 ${metrics.maxDrawdown}%`;

    try {
      const db = getBacktestDatabase();
      db.saveBacktestResult(
        {
          run_id: runId,
          strategy_key: request.strategyKey,
          symbol: request.symbol,
          timeframe: request.timeframe,
          start_date: startMs,
          end_date: endMs,
          initial_capital: request.initialCapital,
          config: JSON.stringify(config),
          status: "completed",
          created_at: Date.now(),
        },
        trades,
      );
      db.savePerformanceMetrics(runId, metrics, downsample(equityCurve, 2000));
    } catch (error) {
      console.warn("[Backtest 20415 七彩虹] 結果持久化失敗（不影響回傳）:", error);
    }

    const environment = buildEnvironmentSnapshot(
      request.symbol,
      request.timeframe,
      startMs,
      endMs,
      candles.length,
      request.initialCapital,
      commission,
      slippage,
      1,
      candles[0]?.close,
      candles[candles.length - 1]?.close,
    );
    onProgress?.(100, summary);
    return {
      runId,
      strategyKey: request.strategyKey,
      strategyName: strategy.name,
      trades,
      metrics,
      equityCurve: downsample(equityCurve, 2000),
      config: { ...config },
      summary,
      candleCount: candles.length,
      environment,
    };
  }

  /**
   * KAMA 三K突破 V2.5 專用回測。
   * 使用 100 根滾動 K 線視窗，與實盤自主信號產生器一致；所有決策均由 V2.5 核心輸出。
   */
  private runV25Backtest(
    request: BacktestRequest,
    strategy: StrategyKama3kBreakoutV25,
    rawConfig: Record<string, unknown>,
    candles: OHLCVRow[],
    startMs: number,
    endMs: number,
    commission: number,
    slippage: number,
    onProgress?: (pct: number, message: string) => void,
  ): BacktestResult {
    const config = strategy.parseConfig(rawConfig);
    const trades: TradeRecord[] = [];
    const equityCurve: EquityPoint[] = [];
    let equity = request.initialCapital;
    let tradeId = 0;
    let state: V25RuntimeState = createV25RuntimeState({
      capital: request.initialCapital,
    });
    let positionMeta: {
      side: "long" | "short";
      entryTime: number;
      layers: PositionLayer[];
    } | null = null;

    const minimumBars = Math.max(
      3,
      config.KAMA_Fast_Length + 1,
      config.KAMA_Slow_Length + 1,
    );
    const startIndex = Math.max(99, minimumBars - 1);
    onProgress?.(
      35,
      `數據就緒（${candles.length} 根），啟動 V2.5 同源核心逐 K 回測...`,
    );

    const getWindow = (index: number) =>
      candles.slice(Math.max(0, index - 99), index + 1).map((candle) => ({
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        timestamp: candle.timestamp,
      }));

    const applyEntryOrAdd = (
      decision: V25CoreDecision,
      timestamp: number,
    ): void => {
      if (!["buy", "sell", "add_long", "add_short"].includes(decision.action)) {
        return;
      }
      const isLong = decision.action === "buy" || decision.action === "add_long";
      const isInitial = decision.action === "buy" || decision.action === "sell";
      const fillPrice = isLong
        ? decision.price * (1 + slippage)
        : decision.price * (1 - slippage);
      const lotUsdt = decision.lotUsdt ?? config.Base_Lot_Size;
      const quantity = lotUsdt / fillPrice;
      if (!(fillPrice > 0) || !(quantity > 0)) return;

      state = applyV25FillToState(
        decision.nextState,
        decision.action as "buy" | "sell" | "add_long" | "add_short",
        fillPrice,
        quantity,
        timestamp,
      );
      if (isInitial || !positionMeta) {
        positionMeta = {
          side: isLong ? "long" : "short",
          entryTime: timestamp,
          layers: [{ price: fillPrice, size: quantity, time: timestamp }],
        };
      } else {
        positionMeta.layers.push({ price: fillPrice, size: quantity, time: timestamp });
      }
    };

    const applyClose = (
      decision: V25CoreDecision,
      timestamp: number,
      forcedReason?: string,
    ): void => {
      const meta = positionMeta;
      if (!meta || state.totalSize <= 0 || state.avgPrice <= 0) return;
      const effectiveExitPrice =
        meta.side === "long"
          ? decision.price * (1 - slippage)
          : decision.price * (1 + slippage);
      const grossPnl =
        meta.side === "long"
          ? (effectiveExitPrice - state.avgPrice) * state.totalSize
          : (state.avgPrice - effectiveExitPrice) * state.totalSize;
      const entryNotional = meta.layers.reduce(
        (sum, layer) => sum + layer.price * layer.size,
        0,
      );
      const fees =
        (entryNotional + effectiveExitPrice * state.totalSize) * commission;
      const pnl = grossPnl - fees;
      const pnlPct =
        state.avgPrice > 0
          ? (grossPnl / (state.avgPrice * state.totalSize)) * 100
          : 0;
      equity += pnl;
      trades.push({
        id: ++tradeId,
        entryTime: meta.entryTime,
        exitTime: timestamp,
        side: meta.side,
        entryPrice: Math.round(state.avgPrice * 100) / 100,
        exitPrice: Math.round(effectiveExitPrice * 100) / 100,
        size: state.totalSize,
        pnl: Math.round(pnl * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
        exitReason: forcedReason ?? decision.reason,
        martinLayer: Math.max(0, meta.layers.length - 1),
      });
      const closeReason = decision.closeReason ?? "OTHER";
      state = applyV25CloseToState(
        decision.nextState,
        closeReason,
        forcedReason ? false : config.Reentry_On_Trend,
        timestamp,
      );
      positionMeta = null;
    };

    const firstPoint = candles[Math.min(startIndex, candles.length - 1)];
    equityCurve.push({
      timestamp: firstPoint.timestamp,
      equity,
      price: firstPoint.close,
    });

    for (let index = startIndex; index < candles.length; index += 1) {
      const candle = candles[index];
      const window = getWindow(index);
      const decision = strategy.generateTradingSignal(
        { candles: window, lastPrice: candle.close },
        state,
        config,
        "both",
        candle.close,
      );

      if (decision.action === "hold") {
        state = decision.nextState;
      } else if (decision.action === "close") {
        applyClose(decision, candle.timestamp);

        // 止盈後原地重入：模擬實盤下一次 15 秒掃描仍位於同一 K 棒的情況。
        if (state.v25Runtime?.pendingReentry) {
          const reentry = strategy.generateTradingSignal(
            { candles: window, lastPrice: candle.close },
            state,
            config,
            "both",
            candle.close,
          );
          if (reentry.action === "buy" || reentry.action === "sell") {
            applyEntryOrAdd(reentry, candle.timestamp);
          } else {
            state = reentry.nextState;
          }
        }
      } else {
        applyEntryOrAdd(decision, candle.timestamp);
      }

      const activePosition = positionMeta as {
        side: "long" | "short";
        entryTime: number;
        layers: PositionLayer[];
      } | null;
      const unrealizedPnl =
        activePosition && state.totalSize > 0
          ? activePosition.side === "long"
            ? (candle.close - state.avgPrice) * state.totalSize
            : (state.avgPrice - candle.close) * state.totalSize
          : 0;
      equityCurve.push({
        timestamp: candle.timestamp,
        equity: Math.round((equity + unrealizedPnl) * 100) / 100,
        price: candle.close,
      });

      if (index % 2000 === 0) {
        const progress =
          35 + Math.floor(((index - startIndex) / (candles.length - startIndex)) * 60);
        onProgress?.(
          progress,
          `V2.5 同源核心回測 ${index}/${candles.length}（${progress}%）...`,
        );
      }
    }

    if (positionMeta) {
      const last = candles[candles.length - 1];
      applyClose(
        {
          action: "close",
          reason: "回測結束強制平倉",
          price: last.close,
          closeReason: "OTHER",
          nextState: state,
          metrics: {
            kamaFast: null,
            kamaSlow: null,
            isLongEntry: false,
            isShortEntry: false,
            profitPct: null,
            peakProfitPct: null,
            nextMartinLayer: null,
          },
        },
        last.timestamp,
        "回測結束強制平倉",
      );
      equityCurve.push({
        timestamp: last.timestamp,
        equity: Math.round(equity * 100) / 100,
        price: last.close,
      });
    }

    onProgress?.(95, "計算 V2.5 績效指標...");
    const metrics = calculatePerformance(
      trades,
      equityCurve,
      request.initialCapital,
    );
    const runId = makeRunId(request.strategyKey, request.symbol);
    const summary = `V2.5 回測完成：${strategy.name} / ${request.symbol} ${request.timeframe}，共 ${candles.length} 根 K 線，${trades.length} 筆交易，總回報 ${metrics.totalReturn}%，勝率 ${metrics.winRate}%，最大回撤 ${metrics.maxDrawdown}%`;

    try {
      const db = getBacktestDatabase();
      db.saveBacktestResult(
        {
          run_id: runId,
          strategy_key: request.strategyKey,
          symbol: request.symbol,
          timeframe: request.timeframe,
          start_date: startMs,
          end_date: endMs,
          initial_capital: request.initialCapital,
          config: JSON.stringify(config),
          status: "completed",
          created_at: Date.now(),
        },
        trades,
      );
      db.savePerformanceMetrics(runId, metrics, downsample(equityCurve, 2000));
    } catch (error) {
      console.warn("[Backtest V2.5] 結果持久化失敗（不影響回傳）:", error);
    }

    const environment = buildEnvironmentSnapshot(
      request.symbol,
      request.timeframe,
      startMs,
      endMs,
      candles.length,
      request.initialCapital,
      commission,
      slippage,
      1,
      candles[0]?.close,
      candles[candles.length - 1]?.close,
    );
    onProgress?.(100, summary);
    return {
      runId,
      strategyKey: request.strategyKey,
      strategyName: strategy.name,
      trades,
      metrics,
      equityCurve: downsample(equityCurve, 2000),
      config: { ...config },
      summary,
      candleCount: candles.length,
      environment,
    };
  }

  /**
   * SMA v3.00 對稱統一版：通用策略回測路徑（非 V3.5）
   * V6.0：完整對齊 Pasted_content_28.txt 策略邏輯
   * - Killer/Wave EMA 交叉入場（cross_up + price < Enter → 做多；cross_down + price > Enter → 做空）
   * - 非對稱網格馬丁加倉（點數間距，乘數 1.5x，最大 8 層）
   * - 金額追踪止盈（Dollar_Start + Dollar_Trail 回撤）
   * - 方向轉換（反向交叉信號平倉轉向）
   * - 硬止損（Dollar_Loss 金額）
   * - 新聞禁開倉（News_Blackout_Minutes）
   */
  private runGenericBacktest(
    request: BacktestRequest,
    strategy: BaseStrategy,
    config: Record<string, unknown>,
    candles: OHLCVRow[],
    startMs: number,
    endMs: number,
    commission: number,
    slippage: number,
    onProgress?: (pct: number, message: string) => void,
  ): BacktestResult {
    onProgress?.(35, `數據就緒（${candles.length} 根），計算 EMA 指標...`);

    const closes = candles.map((c) => c.close);

    // === Base_Lot_Size 解析（支援雙模式） ===
    const baseLotRaw = config.Base_Lot_Size;
    let lotMode: "quantity" | "usdt" = "quantity";
    let lotValue = 0.01; // 預設值

    if (baseLotRaw !== undefined && baseLotRaw !== null) {
      if (typeof baseLotRaw === "object" && baseLotRaw !== null) {
        const obj = baseLotRaw as { mode?: string; value?: unknown };
        lotMode = obj.mode === "usdt" ? "usdt" : "quantity";
        lotValue = num(obj.value, 0.01);
      } else {
        // 兼容舊版直接傳遞數值的情況，預設為 quantity 模式
        lotValue = num(baseLotRaw, 0.01);
        // 如果數值很大，可能是 USDT 金額，但這裡強制為 quantity 模式
        // warnings.push(`Base_Lot_Size=${lotValue} 數值較大，請確認是否應為 USDT 模式`);
      }
    }
    const resolveInitialLot = (price: number): number => {
      if (lotMode === "usdt" && price > 0) {
        return Math.max(Number((lotValue / price).toFixed(8)), 0.00000001);
      }
      return lotValue;
    };

    // === EMA 均線回歸馬丁格爾策略參數解析 ===
    // EMA 指標週期（只需 3 條：Killer, Wave, Enter）
    const emaKillerPeriod = num(config.ema_killer, num(config.EMA1_Period, 3));
    const emaWavePeriod = num(config.ema_wave, num(config.EMA2_Period, 6));
    const emaEnterPeriod = num(config.ema_enter, num(config.EMA3_Period, 15));
    const emaPeriods = [emaKillerPeriod, emaWavePeriod, emaEnterPeriod];
    const pointValue = num(config.Point_Value, 0.01);
    const bufferPoints = num(config.buffer_points, 8000);
    const slopeThreshold = num(config.slope_threshold, 3.0);

    // 計算三條 EMA（Killer, Wave, Enter）
    const emaSeriesAll = emaPeriods.map(p => calculateEMASeries(closes, p));

    // 馬丁參數
    const martinMultiplier = num(config.multiplier, num(config.Martin_Multiplier, 1.5));
    const maxMartinLevels = num(config.max_layers, num(config.MaxMartinLevels, 12));

    // 動態 Pipstep（ATR-based）
    const pipStepBase = num(config.pip_step_base, num(config.Global_Pipstep, 500));
    const enableDynamicPip = config.enable_dynamic_pip !== false;
    const atrPeriod = num(config.atr_period, 14);
    const pipstepAtrMultiplier = num(config.pipstep_atr_multiplier, 0.15);
    const pipstepMin = num(config.pipstep_min, 200);
    const pipstepMax = num(config.pipstep_max, 800);

    // 計算 ATR 序列（用於動態 pipstep 和硬止損）
    const atrSeries: number[] = new Array(candles.length).fill(0);
    for (let i = 1; i < candles.length; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      );
      if (i < atrPeriod) {
        atrSeries[i] = tr;
      } else if (i === atrPeriod) {
        let sum = 0;
        for (let j = 1; j <= atrPeriod; j++) sum += Math.max(candles[j].high - candles[j].low, Math.abs(candles[j].high - candles[j-1].close), Math.abs(candles[j].low - candles[j-1].close));
        atrSeries[i] = sum / atrPeriod;
      } else {
        atrSeries[i] = (atrSeries[i - 1] * (atrPeriod - 1) + tr) / atrPeriod;
      }
    }

    // 動態 pipstep 計算函數
    const getDynamicPipstep = (idx: number): number => {
      if (!enableDynamicPip) return pipStepBase;
      const atr = atrSeries[idx] || 0;
      const dynamicPip = (atr * pipstepAtrMultiplier) / pointValue;
      return Math.max(pipstepMin, Math.min(pipstepMax, dynamicPip));
    };

    // 計算指定層的倉位大小（累乘）
    const calculateTierLot = (baseLot: number, layer: number): number => {
      if (layer <= 0) return baseLot;
      return baseLot * Math.pow(martinMultiplier, layer);
    };

    // 網格間距（動態）
    const getGridStep = (idx: number): number => {
      const pipstep = getDynamicPipstep(idx);
      return pipstep * pointValue;
    };

    // 止盈系統（普通/趨勢雙模式）
    const tpNormal = num(config.tp_normal, num(config.Dollar_Start_Buy, 150));
    const tpTrend = num(config.tp_trend, 250);
    const trailNormal = num(config.trail_normal, num(config.Dollar_Trail, 25));
    const trailTrend = num(config.trail_trend, 30);
    const trendThreshold = num(config.trend_threshold, 50);

    // 硬止損
    const hardStopMax = num(config.hard_stop_max, -1200);
    const hardStopAtrMultiplier = num(config.hard_stop_atr_multiplier, 0.6);

    // 風控（向後相容舊參數）
    const dollarLoss = num(config.Dollar_Loss, 100);
    const maxPositionRatio = num(config.Max_Position_Ratio, 0.2);
    const maxEquityDrawdown = num(config.Max_Equity_Drawdown, 0.05);
    const newsBlackoutMinutes = num(config.News_Blackout_Minutes, 0);

    console.log(
      `[Backtest/EMA_Martin] 參數: EMA=[${emaPeriods}], maxLevels=${maxMartinLevels}, mult=${martinMultiplier}, ` +
      `pipBase=${pipStepBase}, dynamicPip=${enableDynamicPip}, buffer=${bufferPoints}, slope=${slopeThreshold}, ` +
      `tp_normal=${tpNormal}, tp_trend=${tpTrend}, trail_normal=${trailNormal}, trail_trend=${trailTrend}, ` +
      `hardStop=${hardStopMax}, MaxPosRatio=${maxPositionRatio}, MaxEquityDD=${maxEquityDrawdown}`,
    );

    // === 狀態變數 ===
    const trades: TradeRecord[] = [];
    const equityCurve: EquityPoint[] = [];
    let equity = request.initialCapital;
    let peakEquity = request.initialCapital;
    let position: OpenPosition | null = null;
    let tradeId = 0;
    let peakProfit = 0; // 金額追踪止盈的浮盈峰值
    const martinState: MartinState = { lossCount: 0, currentLot: 0, lastEntryPrice: 0 };

    // === 平倉函數 ===
    let reentryCooldownCounter = 0; // 定義循環再入場冷卻計數器
    const closePos = (exitPrice: number, exitTime: number, reason: string, idx: number): void => {
      if (!position) return;
      const p = position;
      const effExit = p.side === "long" ? exitPrice * (1 - slippage) : exitPrice * (1 + slippage);
      const grossPnl =
        p.side === "long"
          ? (effExit - p.avgPrice) * p.totalSize
          : (p.avgPrice - effExit) * p.totalSize;
      const fees = (p.avgPrice + effExit) * p.totalSize * commission;
      const pnl = grossPnl - fees;
      const pnlPct = p.avgPrice > 0 ? (grossPnl / (p.avgPrice * p.totalSize)) * 100 : 0;
      equity += pnl;
      trades.push({
        id: ++tradeId,
        entryTime: p.entryTime,
        exitTime,
        side: p.side,
        entryPrice: Math.round(p.avgPrice * 100) / 100,
        exitPrice: Math.round(effExit * 100) / 100,
        size: p.totalSize,
        pnl: Math.round(pnl * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
        exitReason: reason,
        martinLayer: p.layers.length - 1,
      });
      if (pnl < 0) martinState.lossCount += 1;
      else martinState.lossCount = 0;
      position = null;
      peakProfit = 0;

      // 循環再入場邏輯：平倉後根據 Reentry_Enabled 和 Reentry_Cooldown_Bars 決定是否立即重入或設置冷卻
      const reentryEnabled = config.Reentry_Enabled === true || config.Reentry_Enabled === "true";
      const cooldownBars = num(config.Reentry_Cooldown_Bars, 1);

      if (reentryEnabled && cooldownBars === 0) {
        // 冷卻時間為 0，立即檢查是否可以重新入場
        const { shouldEnter: reentryShouldEnter, direction: reentryDirection } = checkEntry(idx, exitPrice);
        if (reentryShouldEnter) {
          const dynLot = resolveInitialLot(exitPrice);
          const openNotional = dynLot * exitPrice;
          const maxAllowed = equity * maxPositionRatio;
          if (maxPositionRatio > 0 && openNotional > maxAllowed) {
            // 持倉比例超限，拒絕再入場
          } else {
            openPos(reentryDirection, dynLot, exitPrice, exitTime);
            martinState.lossCount = 0;
          }
        }
      } else if (reentryEnabled) {
        // 有冷卻時間，設定冷卻計數器，在主迴圈中遞減後再檢查入場
        reentryCooldownCounter = cooldownBars;
      }
      // 如果未啟用循環再入場，不設置冷卻計數器，等待下一次 EMA 交叉信號
    };

    // === 開倉函數 ===
    const openPos = (side: "long" | "short", lotSize: number, price: number, time: number): void => {
      const effPrice = side === "long" ? price * (1 + slippage) : price * (1 - slippage);
      position = {
        side,
        layers: [{ price: effPrice, size: lotSize, time }],
        avgPrice: effPrice,
        totalSize: lotSize,
        entryTime: time,
        peakPnlPct: 0,
        tpActivated: false,
        entryTrendBull: side === "long",
      };
      peakProfit = 0;
    };

    // === 馬丁加倉函數 ===
    const addMartinLayer = (price: number, time: number): void => {
      if (!position) return;
      const p = position;
      // 階梯式分層：根據當前層數計算新層倉位
      const currentLayerIdx = p.layers.length; // 0-based，即下一層的索引
      const newSize = calculateTierLot(lotValue, currentLayerIdx);
      const effPrice = p.side === "long" ? price * (1 + slippage) : price * (1 - slippage);
      p.layers.push({ price: effPrice, size: newSize, time });
      let totalCost = 0;
      let totalSize = 0;
      for (const layer of p.layers) {
        totalCost += layer.price * layer.size;
        totalSize += layer.size;
      }
      p.avgPrice = totalCost / totalSize;
      p.totalSize = totalSize;
    };

        // === EMA 均線回歸入場信號判斷 ===
    // 新策略入場邏輯：
    // 做多：Killer 上穿 Wave + price < Enter - buffer*pointValue + slope 確認
    // 做空：Killer 下穿 Wave + price > Enter + buffer*pointValue + slope 確認
    const checkCrossSignal = (idx: number): { crossUp: boolean; crossDown: boolean } => {
      if (idx < 1) return { crossUp: false, crossDown: false };
      const killerSeries = emaSeriesAll[0];
      const waveSeries = emaSeriesAll[1];
      const killerNow = killerSeries[idx];
      const killerPrev = killerSeries[idx - 1];
      const waveNow = waveSeries[idx];
      const wavePrev = waveSeries[idx - 1];
      if (killerNow === null || killerPrev === null || waveNow === null || wavePrev === null) {
        return { crossUp: false, crossDown: false };
      }
      const crossUp = killerPrev <= wavePrev && killerNow > waveNow;
      const crossDown = killerPrev >= wavePrev && killerNow < waveNow;
      return { crossUp, crossDown };
    };

    // EMA 斜率計算（用於 slope 確認）
    const getEmaSlope = (series: (number | null)[], idx: number, lookback: number = 3): number => {
      if (idx < lookback) return 0;
      const curr = series[idx];
      const prev = series[idx - lookback];
      if (curr === null || prev === null) return 0;
      return ((curr - prev) / lookback) / pointValue;
    };

    const checkEntry = (idx: number, price: number): { shouldEnter: boolean; direction: "long" | "short" } => {
      if (idx < 2) return { shouldEnter: false, direction: "long" };
      const killerSeries = emaSeriesAll[0];
      const waveSeries = emaSeriesAll[1];
      const enterSeries = emaSeriesAll[2];
      const killerNow = killerSeries[idx];
      const killerPrev = killerSeries[idx - 1];
      const waveNow = waveSeries[idx];
      const wavePrev = waveSeries[idx - 1];
      const enterNow = enterSeries[idx];
      if (killerNow === null || killerPrev === null || waveNow === null || wavePrev === null || enterNow === null) {
        return { shouldEnter: false, direction: "long" };
      }

      const bufferValue = bufferPoints * pointValue;
      const killerSlope = getEmaSlope(killerSeries, idx);

      // 做多：Killer 上穿 Wave + price < Enter - buffer + Killer 斜率向上
      const crossUp = killerPrev <= wavePrev && killerNow > waveNow;
      const isLongSignal = crossUp && (price < enterNow - bufferValue) && (killerSlope > slopeThreshold);

      // 做空：Killer 下穿 Wave + price > Enter + buffer + Killer 斜率向下
      const crossDown = killerPrev >= wavePrev && killerNow < waveNow;
      const isShortSignal = crossDown && (price > enterNow + bufferValue) && (killerSlope < -slopeThreshold);

      if (isLongSignal) return { shouldEnter: true, direction: "long" };
      if (isShortSignal) return { shouldEnter: true, direction: "short" };
      return { shouldEnter: false, direction: "long" };
    };

    // === 方向轉換已停用：EMA 交叉時不平倉、不轉向，只有止盈/止損才會平倉 ===

    // === 網格加倉判斷 ===
    const checkGridAdd = (price: number, idx: number): boolean => {
      if (!position) return false;
      const p = position;
      const layerCount = p.layers.length;
      if (layerCount >= maxMartinLevels) return false;
      // 動態 pipstep：使用 ATR 計算當前網格間距
      const step = getGridStep(idx);
      const lastPrice = p.layers[p.layers.length - 1].price;
      if (p.side === "long") {
        // 做多加倉：價格下跌至 lastPrice - step
        return price <= lastPrice - step;
      } else {
        // 做空加倉：價格上漲至 lastPrice + step
        return price >= lastPrice + step;
      }
    };

    // === 金額追踪止盈判斷 ===
    // 判斷是否處於趨勢模式：利潤超過 trendThreshold
    const isTrendMode = (profit: number): boolean => profit >= trendThreshold;
    const checkTakeProfit = (totalProfit: number, _side: "long" | "short"): boolean => {
      const inTrend = isTrendMode(totalProfit);
      const target = inTrend ? tpTrend : tpNormal;
      const trail = inTrend ? trailTrend : trailNormal;
      if (totalProfit >= target) {
        // 更新峰值
        if (totalProfit > peakProfit) {
          peakProfit = totalProfit;
        }
        // 從峰值回撤超過 trail
        if (peakProfit - totalProfit >= trail) {
          return true;
        }
      }
      return false;
    };

    // === 主迴圈（馬丁補倉 + DollarAmount 止盈，無方向轉換）===
    const startIdx = Math.max(...emaPeriods) + 2;
    for (let i = startIdx; i < candles.length; i++) {
      const k = candles[i];
      const price = k.close;
      const now = k.timestamp;
      if (i % 500 === 0) {
        onProgress?.(35 + Math.floor(((i - startIdx) / (candles.length - startIdx)) * 60), `回測中 ${i}/${candles.length}...`);
      }

      // --- 有持倉 ---
      if (position) {
        const p: OpenPosition = position;
        // 計算總浮盈（金額）
        const totalProfit = p.side === "long"
          ? (price - p.avgPrice) * p.totalSize
          : (p.avgPrice - price) * p.totalSize;
        const currentEquity = equity + totalProfit;
        if (currentEquity > peakEquity) peakEquity = currentEquity;

        // --- 權益回撤止損（Max_Equity_Drawdown）---
        if (maxEquityDrawdown > 0 && peakEquity > 0) {
          const drawdown = (peakEquity - currentEquity) / peakEquity;
          if (drawdown >= maxEquityDrawdown) {
            closePos(price, now, `動態回撤止損（回撤 ${(drawdown * 100).toFixed(2)}% ≥ ${(maxEquityDrawdown * 100).toFixed(0)}%，峰值 $${peakEquity.toFixed(2)}）`, i);
            equityCurve.push({ timestamp: now, equity, price });
            continue;
          }
        }

        // --- 硬止損：ATR-based 動態止損 + hard_stop_max 絕對上限 ---
        const atrStopValue = atrSeries[i] * hardStopAtrMultiplier * p.totalSize;
        const effectiveStopLoss = Math.min(atrStopValue > 0 ? atrStopValue : Math.abs(hardStopMax), Math.abs(hardStopMax));
        if (effectiveStopLoss > 0 && totalProfit <= -effectiveStopLoss) {
          closePos(price, now, `硬止損（浮虧 $${totalProfit.toFixed(2)} ≤ -$${effectiveStopLoss.toFixed(2)}，ATR=${atrSeries[i].toFixed(2)}）`, i);
          equityCurve.push({ timestamp: now, equity, price });
            continue;
        }

        // --- Priority 3：金額追踪止盈（原因分類：止盈觸發）---
        if (checkTakeProfit(totalProfit, p.side)) {
          const _activeTrail = isTrendMode(totalProfit) ? trailTrend : trailNormal;
          closePos(price, now, `止盈觸發（第 ${p.layers.length} 層，峰值 $${peakProfit.toFixed(2)}，回撤 $${(peakProfit - totalProfit).toFixed(2)} ≥ $${_activeTrail}）`, i);
          equityCurve.push({ timestamp: now, equity, price });
          continue;
        }

        // --- 馬丁補倉迴圈：price_diff > PipStep 時加倉 ---
        if (checkGridAdd(price, i)) {
          // 持倉比例風控：加倉後總名義值不得超過 equity × maxPositionRatio
          const nextLayerIdx = p.layers.length;
          const newLotSize = calculateTierLot(lotValue, nextLayerIdx);
          const newNotional = newLotSize * price;
          const currentNotional = p.totalSize * price;
          const currentEq = equity + totalProfit;
          const maxAllowed = currentEq * maxPositionRatio;
          if (maxPositionRatio > 0 && (currentNotional + newNotional) > maxAllowed) {
            // 持倉比例超限，拒絕加倉
          } else {
            addMartinLayer(price, now);
            equityCurve.push({ timestamp: now, equity: equityWithUnrealized(equity, position!, price), price });
            continue;
          }
        }
        // ★ 已完全移除方向轉換邏輯：EMA 交叉時不平倉、不轉向，只有 DollarAmount 止盈/止損才會平倉 ★
      }

      // --- 無持倉：檢查入場信號 ---
      if (!position) {
        // 處理冷卻計數器（無持倉時遞減）
        if (reentryCooldownCounter > 0) {
          reentryCooldownCounter--;
        }
        if (reentryCooldownCounter === 0) {
          const { shouldEnter, direction } = checkEntry(i, price);
          if (shouldEnter) {
            const dynLot = resolveInitialLot(price);
            // 持倉比例風控：開倉名義值不得超過 equity × maxPositionRatio
            const openNotional = dynLot * price;
            const maxAllowed = equity * maxPositionRatio;
            if (maxPositionRatio > 0 && openNotional > maxAllowed) {
              // 持倉比例超限，拒絕開倉
            } else {
              openPos(direction, dynLot, price, now);
              martinState.lossCount = 0;
            }
          }
        }
      }

      equityCurve.push({
        timestamp: now,
        equity: position ? equityWithUnrealized(equity, position, price) : equity,
        price,
      });
    }

    // 回測結束：強制平倉
    if (position) {
      const last = candles[candles.length - 1];
      closePos(last.close, last.timestamp, "回測結束強制平倉", candles.length - 1);
      equityCurve.push({ timestamp: last.timestamp, equity, price: last.close });
    }

    onProgress?.(95, "計算績效指標...");
    const metrics = calculatePerformance(trades, equityCurve, request.initialCapital);
    const runId = makeRunId(request.strategyKey, request.symbol);
    const summary = `回測完成：${strategy.name} / ${request.symbol} ${request.timeframe}，共 ${candles.length} 根 K 線，${trades.length} 筆交易，總回報 ${metrics.totalReturn}%，勝率 ${metrics.winRate}%，最大回撤 ${metrics.maxDrawdown}%`;

    try {
      const db = getBacktestDatabase();
      db.saveBacktestResult(
        {
          run_id: runId,
          strategy_key: request.strategyKey,
          symbol: request.symbol,
          timeframe: request.timeframe,
          start_date: startMs,
          end_date: endMs,
          initial_capital: request.initialCapital,
          config: JSON.stringify(config),
          status: "completed",
          created_at: Date.now(),
        },
        trades,
      );
      db.savePerformanceMetrics(runId, metrics, downsample(equityCurve, 2000));
    } catch (e) {
      console.warn("[Backtest] 結果持久化失敗（不影響回傳）:", e);
    }

    // V5.7: 構建環境快照元數據
    const envSnapshot = buildEnvironmentSnapshot(
      request.symbol,
      request.timeframe,
      startMs,
      endMs,
      candles.length,
      request.initialCapital,
      commission,
      slippage,
      1, // leverage (backtest default = 1x)
      candles[0]?.close,
      candles[candles.length - 1]?.close,
    );

    onProgress?.(100, summary);
    return {
      runId,
      strategyKey: request.strategyKey,
      strategyName: strategy.name,
      trades,
      metrics,
      equityCurve: downsample(equityCurve, 2000),
      config,
      summary,
      candleCount: candles.length,
      environment: envSnapshot,
    };
  }

  /**
   * V7.0 龍捲風雙渦輪專屬回測路徑
   * KAMA 雙線 + MA200 宏觀趨勢錨 + S 曲線階梯馬丁
   */
  private runV70Backtest(
    request: BacktestRequest,
    strategy: BaseStrategy,
    config: Record<string, unknown>,
    candles: OHLCVRow[],
    startMs: number,
    endMs: number,
    commission: number,
    slippage: number,
    onProgress?: (pct: number, message: string) => void,
  ): BacktestResult {
    onProgress?.(35, `數據就緒（${candles.length} 根），計算 V7.0 指標...`);

    const closes = candles.map((c) => c.close);

    // === 參數解析 ===
    const baseLotUsdt = num(config.base_lot_size_usdt, 150);
    const leverage = num(config.leverage, 5);
    const ma200Period = num(config.ma200_period, 200);
    const ma200Type = String(config.ma200_type || "SMA");
    const ma200Enabled = config.ma200_enabled !== false;
    const oscillationFilter = num(config.ma200_oscillation_filter_pct, 0.015);

    const kamaFastErPeriod = num(config.kama_fast_er_period, 50);
    const kamaFastFastConst = num(config.kama_fast_fast_const, 10);
    const kamaFastSlowConst = num(config.kama_fast_slow_const, 2);
    const kamaSlowErPeriod = num(config.kama_slow_er_period, 50);
    const kamaSlowFastConst = num(config.kama_slow_fast_const, 10);
    const kamaSlowSlowConst = num(config.kama_slow_slow_const, 6);
    const crossMode = String(config.cross_mode || "both");

    const hardStopPct = num(config.risk_hard_stop_pct, 4.5) / 100;
    const maForceLiq = config.risk_ma_force_liq !== false;
    const reverseCrossClose = config.risk_reverse_cross_close !== false;
    const reverseCrossProfitLimit = num(config.risk_reverse_cross_profit_limit, 1.5) / 100;

    const trailingEnabled = config.trailing_enabled !== false;
    const trailingActivation = num(config.trailing_activation_pct, 3.0) / 100;
    const trailingRetracement = num(config.trailing_retracement_pct, 1.5) / 100;

    const martinEnabled = config.martin_enabled !== false;
    const martinMaxLayers = num(config.martin_max_layers, 11);
    const martinLayerTpLong = num(config.martin_layer_tp_long, 0.30) / 100;
    const martinLayerTpShort = num(config.martin_layer_tp_short, 0.20) / 100;

    // 解析分層表格
    let martinLayers: Array<{start:number;end:number;multiplier:number;gap_long:number;gap_short:number}> = [
      {start:1,end:4,multiplier:1.5,gap_long:0.60,gap_short:0.40},
      {start:5,end:9,multiplier:1.1,gap_long:1.00,gap_short:0.70},
      {start:10,end:11,multiplier:1.0,gap_long:1.80,gap_short:1.20},
    ];
    if (config.martin_layers) {
      try {
        const parsed = typeof config.martin_layers === "string" ? JSON.parse(config.martin_layers as string) : config.martin_layers;
        if (Array.isArray(parsed)) martinLayers = parsed;
      } catch { /* use default */ }
    }

    // === 計算 MA200 ===
    const ma200: (number | null)[] = new Array(candles.length).fill(null);
    if (ma200Enabled) {
      if (ma200Type === "EMA") {
        const ema = calculateEMASeries(closes, ma200Period);
        for (let i = 0; i < ema.length; i++) ma200[i] = ema[i];
      } else {
        // SMA
        for (let i = ma200Period - 1; i < closes.length; i++) {
          let sum = 0;
          for (let j = i - ma200Period + 1; j <= i; j++) sum += closes[j];
          ma200[i] = sum / ma200Period;
        }
      }
    }

    // MA200 斜率（過去 20 根）
    const ma200Slope: (number | null)[] = new Array(candles.length).fill(null);
    for (let i = 20; i < candles.length; i++) {
      if (ma200[i] != null && ma200[i - 20] != null && ma200[i - 20]! > 0) {
        ma200Slope[i] = ((ma200[i]! - ma200[i - 20]!) / ma200[i - 20]!) * 100;
      }
    }

    // === 計算 KAMA 雙線 ===
    const kamaFast = calculateKAMASeries(closes, kamaFastErPeriod, kamaFastFastConst, kamaFastSlowConst);
    const kamaSlow = calculateKAMASeries(closes, kamaSlowErPeriod, kamaSlowFastConst, kamaSlowSlowConst);

    onProgress?.(50, `指標計算完成，開始回測循環...`);

    // === 回測狀態 ===
    const trades: TradeRecord[] = [];
    const equityCurve: EquityPoint[] = [];
    let realizedPnl = 0;
    let position: OpenPosition | null = null;
    let maxProfitRate = 0; // 追蹤止盈用

    const getLayerConfig = (layerNum: number) => {
      for (const l of martinLayers) {
        if (l.start <= layerNum && layerNum <= l.end) return l;
      }
      return null;
    };

    const getMultiplierForLayer = (layerNum: number): number => {
      const cfg = getLayerConfig(layerNum);
      return cfg?.multiplier ?? 1.0;
    };

    const warmup = Math.max(ma200Period, kamaFastErPeriod, kamaSlowErPeriod) + 5;

    for (let i = warmup; i < candles.length; i++) {
      const price = closes[i];
      const time = candles[i].timestamp;

      // KAMA 交叉信號
      const kf = kamaFast[i];
      const ks = kamaSlow[i];
      const kfPrev = kamaFast[i - 1];
      const ksPrev = kamaSlow[i - 1];
      let cross = 0; // 1=金叉, -1=死叉
      if (kf != null && ks != null && kfPrev != null && ksPrev != null) {
        if (kf > ks && kfPrev <= ksPrev) cross = 1;
        if (kf < ks && kfPrev >= ksPrev) cross = -1;
      }

      const currentMa200 = ma200[i];
      const currentSlope = ma200Slope[i];

      // --- 風控檢查（優先級最高） ---
      if (position) {
        const avgPrice = position.avgPrice;
        const side = position.side;
        const profitRate = side === "long"
          ? (price - avgPrice) / avgPrice
          : (avgPrice - price) / avgPrice;

        let exitReason = "";

        // 5.1 硬止損
        if (hardStopPct > 0 && profitRate < -hardStopPct) {
          exitReason = `硬止損 (${(profitRate * 100).toFixed(2)}%)`;
        }

        // 5.2 MA200 強平保護
        if (!exitReason && maForceLiq && currentMa200 != null) {
          if (side === "long" && price < currentMa200) exitReason = "MA200 強平保護 (價格穿越 MA200)";
          if (side === "short" && price > currentMa200) exitReason = "MA200 強平保護 (價格穿越 MA200)";
        }

        // 5.3 反向交叉平倉
        if (!exitReason && reverseCrossClose && profitRate < reverseCrossProfitLimit) {
          if (side === "long" && cross === -1) exitReason = "反向交叉平倉 (死叉)";
          if (side === "short" && cross === 1) exitReason = "反向交叉平倉 (金叉)";
        }

        // 5.4 追蹤止盈
        if (!exitReason && trailingEnabled) {
          if (profitRate > trailingActivation) {
            if (profitRate > maxProfitRate) maxProfitRate = profitRate;
            if (maxProfitRate - profitRate > trailingRetracement) {
              exitReason = `追蹤止盈 (峰值${(maxProfitRate * 100).toFixed(2)}% 回撤${((maxProfitRate - profitRate) * 100).toFixed(2)}%)`;
            }
          } else {
            maxProfitRate = Math.max(maxProfitRate, profitRate);
          }
        }

        // 馬丁加倉層專屬止盈
        if (!exitReason && martinEnabled && position.layers.length > 1) {
          const layerTp = side === "long" ? martinLayerTpLong : martinLayerTpShort;
          if (profitRate > layerTp) {
            exitReason = `加倉層止盈 (${(profitRate * 100).toFixed(2)}%)`;
          }
        }

        if (exitReason) {
          // 平倉
          const exitPrice = price * (1 + (side === "long" ? -slippage : slippage));
          const pnl = side === "long"
            ? (exitPrice - avgPrice) * position.totalSize
            : (avgPrice - exitPrice) * position.totalSize;
          const pnlAfterFee = pnl - (exitPrice * position.totalSize * commission);
          realizedPnl += pnlAfterFee;

          trades.push({
            id: trades.length + 1,
            entryTime: position.entryTime,
            exitTime: time,
            side: side,
            entryPrice: avgPrice,
            exitPrice,
            size: position.totalSize,
            pnl: Math.round(pnlAfterFee * 100) / 100,
            pnlPct: Math.round((pnlAfterFee / request.initialCapital) * 10000) / 100,
            martinLayer: position.layers.length,
            exitReason,
          });

          position = null;
          maxProfitRate = 0;
          equityCurve.push({ timestamp: time, equity: Math.round((request.initialCapital + realizedPnl) * 100) / 100, price });
          continue; // 強平後本 K 線不再開新倉
        }

        // --- 馬丁加倉檢查 ---
        if (martinEnabled && position.layers.length < martinMaxLayers) {
          const currentLayer = position.layers.length;
          const nextLayer = currentLayer + 1;
          const layerCfg = getLayerConfig(nextLayer);
          if (layerCfg) {
            const lastEntryPrice = position.layers[position.layers.length - 1].price;
            let shouldAdd = false;

            if (side === "long") {
              const canAdd = !ma200Enabled || currentMa200 == null || price > currentMa200;
              if (canAdd) {
                const gap = layerCfg.gap_long / 100;
                if (price <= lastEntryPrice * (1 - gap)) shouldAdd = true;
              }
            } else {
              const canAdd = !ma200Enabled || currentMa200 == null || price < currentMa200;
              if (canAdd) {
                const gap = layerCfg.gap_short / 100;
                if (price >= lastEntryPrice * (1 + gap)) shouldAdd = true;
              }
            }

            if (shouldAdd) {
              const multiplier = getMultiplierForLayer(nextLayer);
              const addSize = (baseLotUsdt * leverage * multiplier) / price;
              const entryPrice = price * (1 + (side === "long" ? slippage : -slippage));
              const fee = entryPrice * addSize * commission;
              realizedPnl -= fee;

              position.layers.push({ price: entryPrice, size: addSize, time });
              const totalCost = position.layers.reduce((s, l) => s + l.price * l.size, 0);
              position.totalSize = position.layers.reduce((s, l) => s + l.size, 0);
              position.avgPrice = totalCost / position.totalSize;
            }
          }
        }
      } else {
        // --- 開倉條件檢查 ---
        if (cross !== 0) {
          let canOpen = true;

          // 方向過濾
          if (crossMode === "long_only" && cross === -1) canOpen = false;
          if (crossMode === "short_only" && cross === 1) canOpen = false;

          // 震盪過濾
          if (canOpen && oscillationFilter > 0 && currentSlope != null) {
            if (Math.abs(currentSlope) < oscillationFilter) canOpen = false;
          }

          // MA200 方向校驗
          if (canOpen && ma200Enabled && currentMa200 != null) {
            if (cross === 1 && price <= currentMa200) canOpen = false;
            if (cross === -1 && price >= currentMa200) canOpen = false;
          }

          if (canOpen) {
            const side: "long" | "short" = cross === 1 ? "long" : "short";
            const entryPrice = price * (1 + (side === "long" ? slippage : -slippage));
            const size = (baseLotUsdt * leverage) / entryPrice;
            const fee = entryPrice * size * commission;
            realizedPnl -= fee;

            position = {
              side,
              layers: [{ price: entryPrice, size, time }],
              avgPrice: entryPrice,
              totalSize: size,
              entryTime: time,
              peakPnlPct: 0,
              tpActivated: false,
              entryTrendBull: cross === 1,
            };
            maxProfitRate = 0;
          }
        }
      }

      // 權益曲線
      const equity = position
        ? equityWithUnrealized(request.initialCapital + realizedPnl, position, price)
        : request.initialCapital + realizedPnl;
      if (i % 5 === 0 || i === candles.length - 1) {
        equityCurve.push({ timestamp: time, equity: Math.round(equity * 100) / 100, price });
      }

      // 進度
      if (i % 200 === 0) {
        const pct = 50 + Math.round(((i - warmup) / (candles.length - warmup)) * 40);
        onProgress?.(pct, `回測中... ${trades.length} 筆交易`);
      }
    }

    // 強制平倉未平持倉
    if (position) {
      const lastPrice = closes[closes.length - 1];
      const side = position.side;
      const pnl = side === "long"
        ? (lastPrice - position.avgPrice) * position.totalSize
        : (position.avgPrice - lastPrice) * position.totalSize;
      const fee = lastPrice * position.totalSize * commission;
      realizedPnl += pnl - fee;
      trades.push({
        id: trades.length + 1,
        entryTime: position.entryTime,
        exitTime: candles[candles.length - 1].timestamp,
        side,
        entryPrice: position.avgPrice,
        exitPrice: lastPrice,
        size: position.totalSize,
        pnl: Math.round((pnl - fee) * 100) / 100,
        pnlPct: Math.round(((pnl - fee) / request.initialCapital) * 10000) / 100,
        martinLayer: position.layers.length,
        exitReason: "回測結束強制平倉",
      });
    }

    // 績效計算
    const metrics = calculatePerformance(trades, equityCurve, request.initialCapital);
    const runId = makeRunId(request.strategyKey, request.symbol);
    const summary = `V7.0 回測完成：${strategy.name} / ${request.symbol} ${request.timeframe}，共 ${candles.length} 根 K 線，${trades.length} 筆交易，總回報 ${metrics.totalReturn}%，勝率 ${metrics.winRate}%，最大回撤 ${metrics.maxDrawdown}%`;

    // 持久化
    try {
      const db = getBacktestDatabase();
      db.saveBacktestResult(
        {
          run_id: runId,
          strategy_key: request.strategyKey,
          symbol: request.symbol,
          timeframe: request.timeframe,
          start_date: startMs,
          end_date: endMs,
          initial_capital: request.initialCapital,
          config: JSON.stringify(config),
          status: "completed",
          created_at: Date.now(),
        },
        trades,
      );
      db.savePerformanceMetrics(runId, metrics, downsample(equityCurve, 2000));
    } catch (e) {
      console.warn("[Backtest V7.0] 結果持久化失敗（不影響回傳）:", e);
    }

    const envSnapshot = buildEnvironmentSnapshot(
      request.symbol, request.timeframe, startMs, endMs,
      candles.length, request.initialCapital, commission, slippage,
      leverage, candles[0]?.close, candles[candles.length - 1]?.close,
    );

    onProgress?.(100, summary);
    return {
      runId,
      strategyKey: request.strategyKey,
      strategyName: strategy.name,
      trades,
      metrics,
      equityCurve: downsample(equityCurve, 2000),
      config,
      summary,
      candleCount: candles.length,
      environment: envSnapshot,
    };
  }
}

/** 任務 A3：唯一 runId（含策略 key + 時間戳 + 隨機碼，避免同毫秒碰撞） */
function makeRunId(strategyKey: string, symbol: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const key = strategyKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
  const sym = symbol.replace(/[^A-Za-z0-9]/g, "");
  return `bt_${key}_${Date.now()}_${rand}_${sym}`;
}

/** EMA 系列（null 表示未就緒） */
function calculateEMASeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let ema = sum / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** ATR 系列（Wilder 平滑） */
function calculateATRSeries(candles: OHLCVRow[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  let atr = sum / period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** 含未實現盈虧的權益 */
function equityWithUnrealized(realized: number, p: OpenPosition, price: number): number {
  const unrealized =
    p.side === "long"
      ? (price - p.avgPrice) * p.totalSize
      : (p.avgPrice - price) * p.totalSize;
  return Math.round((realized + unrealized) * 100) / 100;
}

/** 權益曲線降採樣（保留首尾） */
function downsample(points: EquityPoint[], maxPoints: number): EquityPoint[] {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out: EquityPoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.floor(i * step)]);
  }
  out.push(points[points.length - 1]);
  return out;
}

export const backtestEngine = new BacktestEngine();
