/**
 * Auto Trade Signal Generator
 * Generates trading signals in real-time based on K-line data and strategy logic
 * 
 * Features:
 * 1. Fetch latest K-line data from OKX API
 * 2. Prepare market data for strategy engine
 * 3. Dynamically load strategy engine based on strategyKey
 * 4. Call strategy engine's generateActions to get trading signals
 * 5. Return ParsedSignal for executor.ts
 */

import { createAdapter } from "../exchanges/factory";
import type { ExchangeAdapter } from "../exchanges/types";
import type { ParsedSignal } from "./executor";
import { getStrategy, initStrategyStudio } from "./strategyStudio";
import { BaseStrategyV35, KLineData, MarketData, StrategySignal, StrategyAction, StrategyInstanceConfig } from "../strategies/base";
import { Strategy } from "../../drizzle/schema";
import { loadStrategyState, reconcileWithExchange, saveStrategyState } from "./strategyStateManager";
import { TradingPairManager } from "./tradingPairManager";
import { StrategyKama3kV61 } from "../strategies/v61/strategy_kama_3k_v61";
import { StrategyKama3kV70 } from "../strategies/v70/strategy_kama_3k_v70";
import { StrategyKama3kBreakoutV25 } from "../strategies/v25/strategy_kama_3k_breakout_v25";
import { getBoundStrategyConfig } from "./strategySnapshotConfig";
import { normalizeRainbow20415Config } from "../../shared/strategies/rainbow20415";
import {
  evaluateRainbow20415Decision,
  type Rainbow20415AccountMetrics,
} from "../strategies/rainbow20415/core";
import {
  resolveDeploymentPosition,
  withNumericDeploymentBaseLot,
  withObjectDeploymentBaseLot,
} from "./deploymentPosition";
import {
  RAINBOW_TREND_LADDER_STRATEGY_KEY,
  validateRainbowTrendLadderConfig,
} from "../../shared/strategies/rainbowTrendLadder";
import {
  calculateRainbowTrendLadderLineSnapshot,
  evaluateRainbowTrendLadderEntry,
  type RainbowTrendLadderAccountMetrics,
} from "../strategies/rainbowTrendLadder/core";
import { evaluateRainbowTrendLadderManagement } from "../strategies/rainbowTrendLadder/management";
import { fetchRainbowTrendLadderMarketQuote } from "./rainbowTrendLadderMarketQuote";
import {
  evaluateV40EntryGates,
  V40_STRATEGY_KEY,
} from "../strategies/v35/entryGate";
import {
  V41_CONFIG_KEY,
  V41_STRATEGY_KEY,
  validateV41Config,
} from "../../shared/strategies/kama3kMartinV41";
import { StrategyKama3kV41 } from "../strategies/v41/strategy_kama_3k_v41";
import { createV41TrustedEntrySeal } from "./v41TrustedEntrySeal";



/**
 * Convert strategy symbol to OKX instId format
 * 使用交易對管理器確保與 OKX 100% 一致
 */
function toOkxInstId(symbol: string): string {
  // 使用交易對管理器的標準化函數
  return TradingPairManager.normalize(symbol, "SWAP");
}

/**
 * Fetch K-line data from OKX API
 */
export async function fetchKLineData(
  adapter: ExchangeAdapter,
  symbol: string,
  period: number,
  limit: number = 100,
  closedOnly: boolean = false,
): Promise<KLineData[]> {
  try {
    // OKX API format: period in minutes (e.g., "5m", "15m", "1H", "4H", "1D")
    let periodStr: string;
    if (period < 60) {
      periodStr = `${period}m`;
    } else if (period < 1440) {
      periodStr = `${period / 60}H`;
    } else {
      periodStr = `${period / 1440}D`;
    }
    
    // Convert symbol to OKX instId format (BTCUSDT -> BTC-USDT-SWAP)
    const instId = toOkxInstId(symbol);
    
    // 驗證交易對是否在 OKX 上存在
    const isValid = await TradingPairManager.validate(instId, "SWAP");
    if (!isValid) {
      throw new Error(`交易對 "${instId}" 在 OKX 上不存在或不可交易`);
    }
    
    const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${periodStr}&limit=${limit}`;
    
    console.log(`[AutoTradeSignalGenerator] Fetching K-line: ${instId} ${periodStr} (limit=${limit})`);
    
    // Fetch candles from exchange
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    
    if (!response.ok) {
      throw new Error(`OKX API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.code !== "0") {
      throw new Error(`OKX API error code ${data.code}: ${data.msg}`);
    }
    
    if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
      throw new Error(`No candle data returned for ${instId}`);
    }
    
    console.log(`[AutoTradeSignalGenerator] Got ${data.data.length} candles for ${instId}`);
    
    // Convert OKX format to KLineData
    return [...data.data]
      .reverse() // OKX returns newest first, we need oldest first
      .filter((candle: string[]) => !closedOnly || candle[8] === "1")
      .map((candle: string[]) => ({
        timestamp: parseInt(candle[0], 10),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
      }));
  } catch (error) {
    console.error(`[AutoTradeSignalGenerator] Failed to fetch K-line data for ${symbol}:`, error);
    return [];
  }
}

/** HOLD 原因分類 */
export type HoldReason = 
  | { type: 'no_engine'; detail: string }
  | { type: 'no_data'; detail: string }
  | { type: 'kama_insufficient'; detail: string }
  | { type: 'kama_no_direction'; detail: string }
  | { type: 'validation_failed'; detail: string }
  | { type: 'strategy_hold'; detail: string }
  | { type: 'error'; detail: string };

export type SignalGenerationResult = 
  | { signal: ParsedSignal; holdReason: null }
  | { signal: null; holdReason: HoldReason };

/**
 * Generate trading signals based on strategy configuration
 * Returns both signal and holdReason for better logging
 */
export async function generateTradingSignal(
  strategy: Strategy,
  apiKeyRecord: any
): Promise<ParsedSignal | null>;
export async function generateTradingSignal(
  strategy: Strategy,
  apiKeyRecord: any,
  options?: { withReason: true }
): Promise<SignalGenerationResult>;
export async function generateTradingSignal(
  strategy: Strategy,
  apiKeyRecord: any,
  options?: { withReason?: boolean }
): Promise<ParsedSignal | null | SignalGenerationResult> {
  const withReason = options?.withReason === true;
  try {
    await initStrategyStudio(); // Ensure strategies are loaded

    const engine = getStrategy(strategy.strategyKey || "");
    if (!engine) {
      console.warn(`[AutoTradeSignalGenerator] Strategy engine for key '${strategy.strategyKey}' not found.`);
      if (withReason) return { signal: null, holdReason: { type: 'no_engine', detail: `策略引擎 '${strategy.strategyKey}' 未找到` } };
      return null;
    }

    const initialState =
      strategy.martinState && typeof strategy.martinState === "object"
        ? (strategy.martinState as Record<string, unknown>)
        : {};
    const initialSnapshotConfig = getBoundStrategyConfig(
      initialState,
      strategy.strategyKey || "",
    );

    // 建立交易所轉接器。20415 會在抓 K 線前先對賬，避免本地狀態剛被重置時仍錯用 M1 進場。
    const adapter = createAdapter(apiKeyRecord);

    if (strategy.strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY) {
      const { getStrategyById } = await import("../db");
      const freshStrategy = await getStrategyById(strategy.id);
      const effectiveStrategy = freshStrategy || strategy;
      const state = loadStrategyState(effectiveStrategy);
      const effectiveMartinState = effectiveStrategy.martinState && typeof effectiveStrategy.martinState === "object"
        ? effectiveStrategy.martinState as Record<string, unknown>
        : {};
      const rawConfig = getBoundStrategyConfig(effectiveMartinState, RAINBOW_TREND_LADDER_STRATEGY_KEY)
        ?? effectiveMartinState.__rainbowTrendLadderConfig
        ?? initialSnapshotConfig
        ?? {};
      const validation = validateRainbowTrendLadderConfig(rawConfig);
      if (!validation.valid) {
        const detail = `新七彩虹階梯策略配置無效：${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`;
        if (withReason) return { signal: null, holdReason: { type: "validation_failed", detail } };
        return null;
      }
      const config = validation.config;
      const hasPosition = state.currentLayer > 0 && state.totalSize > 0 && state.avgPrice > 0;
      let quote: Awaited<ReturnType<typeof fetchRainbowTrendLadderMarketQuote>> | null = null;
      try {
        quote = await fetchRainbowTrendLadderMarketQuote(
          effectiveStrategy.exchange as "okx" | "bybit",
          effectiveStrategy.symbol,
          config.Point_Value,
        );
      } catch (error: any) {
        console.warn(`[AutoTradeSignalGenerator][RainbowTrendLadder] 即時 bid/ask 取得失敗，所有新單將 fail-closed：${error.message}`);
      }

      let decision;
      let barTimestamp: number | undefined;
      if (!hasPosition) {
        const maxLinePeriod = Math.max(...config.Lines.map((line) => line.period));
        const klines = await fetchKLineData(
          adapter,
          effectiveStrategy.symbol,
          config.Entry_Timeframe_Minutes,
          Math.min(300, Math.max(100, maxLinePeriod + 2)),
          true,
        );
        if (klines.length === 0) {
          const detail = `新七彩虹階梯策略無法取得 ${effectiveStrategy.symbol} M${config.Entry_Timeframe_Minutes} 已收盤 K 線`;
          if (withReason) return { signal: null, holdReason: { type: "no_data", detail } };
          return null;
        }
        barTimestamp = klines.at(-1)?.timestamp;
        decision = evaluateRainbowTrendLadderEntry({
          candles: klines,
          state,
          rawConfig: config,
          allowedDirection: effectiveStrategy.direction as "long" | "short" | "both",
          spreadPoints: quote?.spreadPoints ?? null,
        });
      } else {
        const [managementKlines, trendKlines, balanceResult] = await Promise.all([
          fetchKLineData(adapter, effectiveStrategy.symbol, config.Management_Interval_Minutes, 5, true),
          fetchKLineData(adapter, effectiveStrategy.symbol, config.Entry_Timeframe_Minutes, 100, true),
          adapter.getBalance().catch((error) => {
            console.warn(`[AutoTradeSignalGenerator][RainbowTrendLadder] 帳戶真值取得失敗：${error.message}`);
            return null;
          }),
        ]);
        const managementCandle = managementKlines.at(-1);
        const managementBarTimestamp = managementCandle?.timestamp ?? 0;
        if (!managementCandle || managementBarTimestamp <= 0) {
          const detail = `新七彩虹階梯策略無法取得 ${effectiveStrategy.symbol} M${config.Management_Interval_Minutes} 已收盤管理 K 線`;
          if (withReason) return { signal: null, holdReason: { type: "no_data", detail } };
          return null;
        }
        const runtime = (state as any).rainbowTrendLadderRuntime ?? {};
        if (runtime.lastManagementBarTimestamp === managementBarTimestamp) {
          const detail = `新七彩虹階梯策略已管理 M${config.Management_Interval_Minutes} K 棒 ${managementBarTimestamp}，等待下一根收盤`;
          if (withReason) return { signal: null, holdReason: { type: "strategy_hold", detail } };
          return null;
        }
        const currentPrice = managementCandle.close;
        const account: RainbowTrendLadderAccountMetrics | undefined = balanceResult
          ? {
              equity: balanceResult.total,
              balance: balanceResult.total,
              usedMargin: balanceResult.usedMargin,
            }
          : undefined;
        const trendSnapshot = trendKlines.length > 0
          ? calculateRainbowTrendLadderLineSnapshot(trendKlines, config)
          : undefined;
        barTimestamp = managementBarTimestamp;
        decision = evaluateRainbowTrendLadderManagement(
          {
            currentPrice,
            now: Date.now(),
            barTimestamp: managementBarTimestamp,
            account,
            trendSnapshot,
            spreadPoints: quote?.spreadPoints ?? null,
          },
          state,
          config,
        );
      }

      const currentRuntime = (state as any).rainbowTrendLadderRuntime ?? {};
      const nextRuntime = (decision.nextState as any).rainbowTrendLadderRuntime ?? {};
      if (JSON.stringify(currentRuntime) !== JSON.stringify(nextRuntime)) {
        await saveStrategyState(effectiveStrategy.id, decision.nextState);
      }
      console.log(
        `[AutoTradeSignalGenerator][RainbowTrendLadder] mode=${hasPosition ? "M30-BLIND" : "M30-SCAN"} armed=${config.Live_Trading_Armed} action=${decision.action} reason=${decision.reason}`,
      );
      if (decision.action === "hold" || !config.Live_Trading_Armed) {
        const detail = decision.action === "hold"
          ? `新七彩虹階梯策略觀望：${decision.reason}`
          : `新七彩虹階梯策略尚未武裝實盤；本輪模擬決策 ${decision.action}：${decision.reason}`;
        if (withReason) return { signal: null, holdReason: { type: "strategy_hold", detail } };
        return null;
      }

      const sealedSignal: ParsedSignal = {
        action: decision.action === "close"
          ? "close"
          : decision.action === "buy" || decision.action === "add_long"
            ? "buy"
            : "sell",
        symbol: effectiveStrategy.symbol,
        price: decision.price,
        barTimestamp,
        reason: decision.reason,
        confidence: 1,
        rainbowTrendLadderDecision: true,
        rainbowTrendLadderAction: decision.action,
        rainbowTrendLadderLayerNum: decision.layerNum,
        rainbowTrendLadderCloseReason: decision.closeReason,
        rainbowTrendLadderOrderSize: decision.orderSize,
      };
      if (withReason) return { signal: sealedSignal, holdReason: null };
      return sealedSignal;
    }

    if (strategy.strategyKey === "strategy_20415") {
      try {
        const reconcileResult = await reconcileWithExchange(strategy.id, adapter);
        if (!reconcileResult.matched && reconcileResult.corrections.length > 0) {
          console.log(`[AutoTradeSignalGenerator][20415] 持倉同步修正：${reconcileResult.corrections.join("; ")}`);
        }
      } catch (error: any) {
        console.warn(`[AutoTradeSignalGenerator][20415] 持倉同步失敗，維持本地狀態且不認領外部倉位：${error.message}`);
      }

      const { getStrategyById } = await import("../db");
      const freshStrategy = await getStrategyById(strategy.id);
      const effectiveStrategy = freshStrategy || strategy;
      const strategyState = loadStrategyState(effectiveStrategy);
      const effectiveMartinState =
        effectiveStrategy.martinState && typeof effectiveStrategy.martinState === "object"
          ? effectiveStrategy.martinState as Record<string, unknown>
          : {};
      const boundConfig = getBoundStrategyConfig(effectiveMartinState, "strategy_20415")
        ?? effectiveMartinState.__v2_0Config
        ?? initialSnapshotConfig
        ?? {};
      const snapshotRainbowConfig = normalizeRainbow20415Config(boundConfig);
      const deploymentPosition = resolveDeploymentPosition(
        effectiveStrategy,
        snapshotRainbowConfig.Base_Lot_Size,
      );
      const rainbowConfig = normalizeRainbow20415Config(
        withObjectDeploymentBaseLot(
          boundConfig as Record<string, unknown>,
          deploymentPosition,
        ),
      );
      const hasPosition =
        strategyState.currentLayer > 0 &&
        strategyState.totalSize > 0 &&
        strategyState.avgPrice > 0;
      const kLinePeriod = hasPosition
        ? rainbowConfig.Management_Interval_Minutes
        : rainbowConfig.Entry_Timeframe_Minutes;
      const maxLinePeriod = Math.max(...rainbowConfig.Lines.map((line) => line.period));
      const candleLimit = hasPosition ? 100 : Math.min(300, Math.max(100, maxLinePeriod + 2));
      const klines = await fetchKLineData(
        adapter,
        effectiveStrategy.symbol,
        kLinePeriod,
        candleLimit,
        !hasPosition,
      );

      if (klines.length === 0) {
        const detail = `20415 無法取得 ${effectiveStrategy.symbol} ${kLinePeriod} 分鐘${hasPosition ? "管理" : "已收盤入場"} K 線`;
        if (withReason) return { signal: null, holdReason: { type: "no_data", detail } };
        return null;
      }

      let currentPrice = klines.at(-1)?.close ?? 0;
      let accountMetrics: Rainbow20415AccountMetrics | undefined;
      if (hasPosition) {
        const [balanceResult, positionsResult] = await Promise.allSettled([
          adapter.getBalance(),
          adapter.getPositions(effectiveStrategy.symbol),
        ]);
        if (balanceResult.status === "fulfilled") {
          accountMetrics = {
            equity: balanceResult.value.total,
            balance: balanceResult.value.total,
            usedMargin: balanceResult.value.usedMargin,
          };
        } else {
          console.warn(`[AutoTradeSignalGenerator][20415] 真實帳戶權益取得失敗：${balanceResult.reason}`);
        }
        if (positionsResult.status === "fulfilled") {
          const expectedSide = strategyState.isLong ? "long" : "short";
          const ownedDirectionPosition = positionsResult.value.find(
            (position) => position.side === expectedSide && position.size > 0,
          );
          if (ownedDirectionPosition && ownedDirectionPosition.markPrice > 0) {
            currentPrice = ownedDirectionPosition.markPrice;
          }
        } else {
          console.warn(`[AutoTradeSignalGenerator][20415] 真實持倉標記價格取得失敗：${positionsResult.reason}`);
        }
      }

      const decision = evaluateRainbow20415Decision(
        klines,
        strategyState,
        rainbowConfig,
        {
          allowedDirection: effectiveStrategy.direction as "long" | "short" | "both",
          now: Date.now(),
          currentPrice,
          account: accountMetrics,
        },
      );

      const currentRuntime = (strategyState as any).rainbow20415Runtime ?? {};
      const nextRuntime = (decision.nextState as any).rainbow20415Runtime ?? {};
      if (JSON.stringify(currentRuntime) !== JSON.stringify(nextRuntime)) {
        await saveStrategyState(effectiveStrategy.id, decision.nextState);
      }

      console.log(
        `[AutoTradeSignalGenerator][20415] mode=${hasPosition ? "M1-BLIND" : "M30-SCAN"} action=${decision.action} reason=${decision.reason}`,
      );
      if (decision.action === "hold") {
        const detail = `20415 七彩虹判斷觀望：${decision.reason}`;
        if (withReason) return { signal: null, holdReason: { type: "strategy_hold", detail } };
        return null;
      }

      const signal: ParsedSignal = {
        action: decision.action === "close"
          ? "close"
          : decision.action === "buy" || decision.action === "add_long"
            ? "buy"
            : "sell",
        symbol: effectiveStrategy.symbol,
        price: decision.price || currentPrice,
        barTimestamp: klines.at(-1)?.timestamp,
        reason: decision.reason,
        confidence: 1,
        rainbow20415Decision: true,
        rainbow20415Action: decision.action,
        rainbow20415LayerNum: decision.layerNum,
        rainbow20415CloseReason: decision.closeReason,
        rainbow20415OrderSize: decision.orderSize,
      };
      if (withReason) return { signal, holdReason: null };
      return signal;
    }

    const configuredPeriod = Number(
      initialSnapshotConfig?.K_Line_Period ??
      strategy.kLinePeriod ??
      (engine.defaultConfig as Record<string, unknown> | undefined)?.K_Line_Period ??
      5,
    );
    const kLinePeriod = Number.isFinite(configuredPeriod) && configuredPeriod > 0
      ? configuredPeriod
      : 5;

    // Fetch K-line data
    const klines = await fetchKLineData(
      adapter,
      strategy.symbol,
      kLinePeriod,
      100,
      strategy.strategyKey === V40_STRATEGY_KEY || strategy.strategyKey === V41_STRATEGY_KEY,
    );
    
    if (klines.length === 0) {
      console.warn(`[AutoTradeSignalGenerator] No K-line data fetched for ${strategy.symbol}`);
      if (withReason) return { signal: null, holdReason: { type: 'no_data', detail: `無法獲取 ${strategy.symbol} K線數據` } };
      return null;
    }

    // Prepare market data for the strategy engine
    const marketData: MarketData = {
      candles: klines,
      lastPrice: klines[klines.length - 1].close,
      // Add other market data as needed by strategies
    };

    const initialSignal: StrategySignal = {
      action: "NONE", // Signal generator initiates the check, not an external signal
      symbol: strategy.symbol,
      price: marketData.lastPrice,
      barTimestamp: marketData.candles[marketData.candles.length - 1].timestamp,
    };

    let signal: ParsedSignal | null = null;
    let holdDetail: HoldReason | null = null;
    
    // === 持倉同步：在信號生成前與交易所對賬 ===
    // 確保本地 state 與交易所實際持倉一致，防止策略恢復後重複開倉
    try {
      const reconcileResult = await reconcileWithExchange(strategy.id, adapter);
      if (!reconcileResult.matched && reconcileResult.corrections.length > 0) {
        console.log(`[AutoTradeSignalGenerator] 持倉同步修正：${reconcileResult.corrections.join('; ')}`);
      }
    } catch (e: any) {
      console.warn(`[AutoTradeSignalGenerator] 持倉同步失敗（不影響信號生成）：${e.message}`);
    }
    
    // 重新載入策略（可能已被 reconcile 修正）
    const { getStrategyById } = await import("../db");
    const freshStrategy = await getStrategyById(strategy.id);
    const strategyState = loadStrategyState(freshStrategy || strategy);
    const effectiveStrategy = freshStrategy || strategy;
    const effectiveMartinState =
      effectiveStrategy.martinState && typeof effectiveStrategy.martinState === "object"
        ? (effectiveStrategy.martinState as Record<string, unknown>)
        : {};
    const boundSnapshotConfig = getBoundStrategyConfig(
      effectiveMartinState,
      strategy.strategyKey || "",
    ) ?? {};
    const deploymentPosition = resolveDeploymentPosition(effectiveStrategy, {
      value: 1,
      mode: "quantity",
    });

    console.log(`[AutoTradeSignalGenerator] Analysing strategy ${strategy.id} (${strategy.name}) | engine=${strategy.strategyKey} | kLine=${kLinePeriod}m | lastPrice=${marketData.lastPrice}`);

    // Handle V2.5 KAMA 三K突破策略：直接調用文件同源純核心，不硬編碼方向或馬丁層數。
    if (strategy.strategyKey === 'KAMA_3K_BREAKOUT_V25' && engine instanceof StrategyKama3kBreakoutV25) {
      const mergedConfig = withNumericDeploymentBaseLot(
        {
          ...(engine.defaultConfig || {}),
          ...(boundSnapshotConfig as Record<string, unknown>),
        },
        deploymentPosition,
      );
      const candles = marketData.candles.map((c) => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
        timestamp: c.timestamp,
      }));
      const v25Result = engine.generateTradingSignal(
        { candles, lastPrice: marketData.lastPrice },
        strategyState,
        mergedConfig,
        strategy.direction as "long" | "short" | "both",
        marketData.lastPrice,
      );

      console.log(`[AutoTradeSignalGenerator] V2.5 decision: action=${v25Result.action} reason=${v25Result.reason}`);

      if (v25Result.action === 'hold') {
        const currentRuntime = (strategyState as any).v25Runtime ?? {};
        const nextRuntime = (v25Result.nextState as any).v25Runtime ?? {};
        if (JSON.stringify(currentRuntime) !== JSON.stringify(nextRuntime)) {
          await saveStrategyState(effectiveStrategy.id, v25Result.nextState);
        }
        holdDetail = { type: 'strategy_hold', detail: `V2.5 策略判斷觀望: ${v25Result.reason}` };
      } else {
        signal = {
          action:
            v25Result.action === 'close'
              ? 'close'
              : v25Result.action === 'buy'
                ? 'buy'
                : v25Result.action === 'sell'
                  ? 'sell'
                  : v25Result.action === 'add_long'
                    ? 'buy'
                    : 'sell',
          symbol: strategy.symbol,
          price: v25Result.price || marketData.lastPrice,
          barTimestamp: marketData.candles[marketData.candles.length - 1].timestamp,
          reason: v25Result.reason,
          confidence: 1,
          lotUsdt: v25Result.lotUsdt,
          v25Decision: true,
          v25LayerNum: v25Result.layerNum,
          v25CloseReason: v25Result.closeReason,
        };
        console.log(`[AutoTradeSignalGenerator] ✅ V2.5 SIGNAL GENERATED: ${signal!.action} ${signal!.symbol} @ ${signal!.price}`);
      }
    }
    // Handle V7.0 strategies (KAMA_3K_TORNADO_V70) — must be checked before V6.1
    else if (strategy.strategyKey === 'KAMA_3K_TORNADO_V70' && engine instanceof BaseStrategyV35) {
      const martinStateRaw = effectiveMartinState;
      const mergedConfig = {
        ...(engine.defaultConfig || {}),
        ...(boundSnapshotConfig as Record<string, number | string | boolean>),
        base_lot_size_usdt: deploymentPosition.value,
        Position_Mode: deploymentPosition.mode,
        Position_Value: deploymentPosition.value,
      };

      const v70Engine = new StrategyKama3kV70();
      const candles = marketData.candles.map((c: any) => ({
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume || 0, timestamp: c.timestamp,
      }));

      const v70Result = v70Engine.generateTradingSignal(candles, strategyState, mergedConfig);

      console.log(`[AutoTradeSignalGenerator] V7.0 generateTradingSignal result: action=${v70Result.action} reason=${v70Result.reason}`);

      if (v70Result.action === 'buy' || v70Result.action === 'sell' || v70Result.action === 'close' || v70Result.action === 'add_long' || v70Result.action === 'add_short') {
        let signalAction: 'buy' | 'sell' | 'close';
        if (v70Result.action === 'close') {
          signalAction = 'close';
        } else if (v70Result.action === 'add_long') {
          signalAction = 'buy';
        } else if (v70Result.action === 'add_short') {
          signalAction = 'sell';
        } else {
          signalAction = v70Result.action;
        }
        signal = {
          action: signalAction,
          symbol: strategy.symbol,
          price: v70Result.price || marketData.lastPrice,
          barTimestamp: marketData.candles[marketData.candles.length - 1].timestamp,
          reason: v70Result.reason,
          confidence: 1.0,
          lotUsdt: v70Result.lotUsdt,
        };
        console.log(`[AutoTradeSignalGenerator] ✅ V7.0 SIGNAL GENERATED: ${signal!.action} ${signal!.symbol} @ ${signal!.price}`);
      } else {
        console.log(`[AutoTradeSignalGenerator] ⏸️ V7.0 ${v70Result.action} - ${v70Result.reason}`);
        holdDetail = { type: 'strategy_hold', detail: `V7.0 策略判斷觀望: ${v70Result.reason}` };
      }
    }
    // Handle V6.1 strategies (KAMA_3K_HF_V61) — must be checked before V5.0 and generic V3.5
    // 修復：正確調用 generateSignalV61（包含 entry_zone_mode + direction_mode 區域觸發邏輯）
    else if (strategy.strategyKey === 'KAMA_3K_HF_V61' && engine instanceof BaseStrategyV35) {
      const martinStateRaw = effectiveMartinState;
      const mergedConfig: Record<string, number | string | boolean> = {
        ...(engine.defaultConfig || {}),
        ...(boundSnapshotConfig as Record<string, number | string | boolean>),
        base_lot_size: deploymentPosition.value,
        Base_Lot_Size: deploymentPosition.value,
        Position_Mode: deploymentPosition.mode,
        Position_Value: deploymentPosition.value,
      };

      // 創建 V6.1 引擎實例（帶入用戶配置）
      const v61Engine = new StrategyKama3kV61(mergedConfig as any);

      // 調用 generateSignalV61（包含 entry_zone_mode 區域觸發 + direction_mode 方向過濾）
      const candles = marketData.candles.map((c: any) => ({
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume || 0, timestamp: c.timestamp,
      }));

      // 檢查當前持倉狀態（從 V3.5 StrategyState 結構讀取正確字段）
      const currentLayer = (martinStateRaw.currentLayer as number) || 0;
      const hasPosition = currentLayer > 0 && ((martinStateRaw.totalSize as number) || 0) > 0;
      const isLongRaw = martinStateRaw.isLong;
      const positionSide: 'long' | 'short' | undefined = hasPosition
        ? (isLongRaw === true ? 'long' : isLongRaw === false ? 'short' : undefined)
        : undefined;
      const positionLayers = currentLayer;
      const avgEntryPrice = (martinStateRaw.avgPrice as number) || 0;

      const v61Result = v61Engine.generateSignalV61(
        candles, hasPosition, positionSide, positionLayers, avgEntryPrice, 0
      );

      console.log(`[AutoTradeSignalGenerator] V6.1 generateSignalV61 result: action=${v61Result.action} reason=${v61Result.reason} mode=${mergedConfig.entry_zone_mode || 'breakout'}`);

      if (v61Result.action === 'buy' || v61Result.action === 'sell' || v61Result.action === 'close' || v61Result.action === 'add') {
        // 🔒 加倉信號必須與持倉方向一致（做多持倉加倉 = buy，做空持倉加倉 = sell）
        let signalAction: 'buy' | 'sell' | 'close';
        if (v61Result.action === 'close') {
          signalAction = 'close';
        } else if (v61Result.action === 'add') {
          // 加倉必須跟隨持倉方向
          signalAction = positionSide === 'long' ? 'buy' : 'sell';
        } else {
          signalAction = v61Result.action;
        }
        signal = {
          action: signalAction,
          symbol: strategy.symbol,
          price: marketData.lastPrice,
          barTimestamp: marketData.candles[marketData.candles.length - 1].timestamp,
          reason: v61Result.reason,
          confidence: v61Result.confidence || 1.0,
          lotUsdt: v61Result.lotUsdt,
        };
        console.log(`[AutoTradeSignalGenerator] ✅ V6.1 SIGNAL GENERATED: ${signal!.action} ${signal!.symbol} @ ${signal!.price} (original=${v61Result.action})`);
      } else {
        console.log(`[AutoTradeSignalGenerator] ⏸️ V6.1 ${v61Result.action} - ${v61Result.reason}`);
        holdDetail = { type: 'strategy_hold', detail: `V6.1 策略判斷觀望: ${v61Result.reason}` };
      }
    }
    // Handle V5.0 strategies (KAMA_3K_ULTIMATE_V50) — must be checked before generic V3.5
    else if (strategy.strategyKey === 'KAMA_3K_ULTIMATE_V50' && engine instanceof BaseStrategyV35) {
      // V5.0: 正確讀取 __v50Config（存在 martinState 中）
      const v50Instance: StrategyInstanceConfig = {
        ...strategy,
        positionSize: parseFloat(strategy.positionSize || '0'),
        config: {
          ...(engine.defaultConfig || {}),
          ...(boundSnapshotConfig as Record<string, number | string | boolean>),
          martinMultiplier: parseFloat(strategy.martinMultiplier?.toString() || '1'),
          maxMartinLevel: strategy.maxMartinLevel,
          martinSpacingPct: parseFloat(strategy.martinSpacingPct?.toString() || '0'),
          reentryEnabled: strategy.reentryEnabled,
          reentryCooldownBars: strategy.reentryCooldownBars,
          ...(typeof strategy.positionSizeObject === 'object' && strategy.positionSizeObject !== null ? strategy.positionSizeObject as Record<string, number | string | boolean> : {}),
          Base_Lot_Size: deploymentPosition.value,
          Position_Mode: deploymentPosition.mode,
          Position_Value: deploymentPosition.value,
          // 強制釋放時間濾網，開啟 24/7 全時段交易
          enable_time_filter: false,
          // 降低 F6 AI 斜率閾值，適應 BTC 窄幅震盪環境
          kama_slope_min: 0.02,
        },
        state: strategyState,
      } as StrategyInstanceConfig;

      const config: Record<string, any> = {
        ...(engine.defaultConfig || {}),
        ...(boundSnapshotConfig as Record<string, any>),
        Base_Lot_Size: deploymentPosition.value,
        Position_Mode: deploymentPosition.mode,
        Position_Value: deploymentPosition.value,
        enable_time_filter: false,
        kama_slope_min: 0.02,
      };

      // ===== V5.0 自主 KAMA 雙線方向判斷（仿 V6.1 模式）=====
      // 從 K 線數據計算 KAMA 快線和慢線，決定入場方向
      const closes = marketData.candles.map(c => c.close);
      const kamaFastLength = Number(config.KAMA_Fast_Length) || 30;
      const kamaSlowLength = Number(config.KAMA_Slow_Length) || 55;
      const p2 = Number(config.p2_fastest) || 8;
      const p3 = Number(config.p3_slowest) || 2;
      const q2 = Number(config.q2_fastest) || 10;
      const q3 = Number(config.q3_slowest) || 8;

      // KAMA 計算函數（與 V6.1 一致）
      const calcKAMA = (data: number[], length: number, fastest: number, slowest: number): number | null => {
        if (data.length < length + 1) return null;
        const fastSC = 2 / (fastest + 1);
        const slowSC = 2 / (slowest + 1);
        let kama = data[length - 1];
        for (let i = length; i < data.length; i++) {
          const direction = Math.abs(data[i] - data[i - length]);
          let volatility = 0;
          for (let j = i - length + 1; j <= i; j++) {
            volatility += Math.abs(data[j] - data[j - 1]);
          }
          const er = volatility === 0 ? 0 : direction / volatility;
          const sc = Math.pow(er * (fastSC - slowSC) + slowSC, 2);
          kama = kama + sc * (data[i] - kama);
        }
        return kama;
      };

      const kamaFast = calcKAMA(closes, kamaFastLength, p2, p3);
      const kamaSlow = calcKAMA(closes, kamaSlowLength, q2, q3);

      console.log(`[AutoTradeSignalGenerator] V5.0 KAMA: fast=${kamaFast?.toFixed(2) || 'null'} slow=${kamaSlow?.toFixed(2) || 'null'} price=${marketData.lastPrice}`);

      // 如果 KAMA 數據不足，無法判斷方向
      if (kamaFast === null || kamaSlow === null) {
        console.log(`[AutoTradeSignalGenerator] ⏸️ V5.0 HOLD - KAMA 數據不足`);
        holdDetail = { type: 'kama_insufficient' as const, detail: 'KAMA 數據不足，無法判斷方向' };
      } else {
        // 根據 KAMA 雙線判斷方向
        let v50Direction: 'BUY' | 'SELL' | null = null;

        // 策略方向限制
        const strategyDirection = strategy.direction || 'both';

        if (kamaFast > kamaSlow) {
          // 快線在慢線上方 → 多頭趨勢
          if (strategyDirection === 'both' || strategyDirection === 'long') {
            v50Direction = 'BUY';
          }
        } else if (kamaFast < kamaSlow) {
          // 快線在慢線下方 → 空頭趨勢
          if (strategyDirection === 'both' || strategyDirection === 'short') {
            v50Direction = 'SELL';
          }
        }

        if (!v50Direction) {
          console.log(`[AutoTradeSignalGenerator] ⏸️ V5.0 HOLD - KAMA 無明確方向或方向受限 (fast=${kamaFast.toFixed(2)}, slow=${kamaSlow.toFixed(2)}, dir=${strategyDirection})`);
          holdDetail = { type: 'kama_no_direction' as const, detail: `KAMA 無明確方向 (fast=${kamaFast.toFixed(2)}, slow=${kamaSlow.toFixed(2)}, 方向=${strategyDirection})` };
        } else {
          // 構建帶方向的信號
          const v50Signal: StrategySignal = {
            action: v50Direction,
            symbol: strategy.symbol,
            price: marketData.lastPrice,
            barTimestamp: marketData.candles[marketData.candles.length - 1].timestamp,
          };

          // 豐富 marketData 的 KAMA 值（供 validateSignal 使用）
          const enrichedMarketData: MarketData = {
            ...marketData,
            kamaFast,
            kamaSlow,
            kamaValue: kamaSlow, // KAMA 方向鎖使用慢線
          };

          // V5.0 驗證（帶方向的信號）
          const validation = await engine.validateSignal(v50Signal, enrichedMarketData, v50Instance);
          if (!validation.valid) {
            console.log(`[AutoTradeSignalGenerator] V5.0 驗證未通過：${validation.reason}`);
            holdDetail = { type: 'validation_failed' as const, detail: `V5.0 驗證未通過：${validation.reason}` };
            // 不生成信號
          } else {
            const v50Action: StrategyAction = await engine.generateActionsV35(
              v50Signal,
              v50Instance,
              enrichedMarketData,
              strategyState,
            );
            console.log(`[AutoTradeSignalGenerator] V5.0 engine result: action=${v50Action?.action || 'null'} reason=${v50Action?.reason || 'none'}`);
            if (v50Action && v50Action.action !== "HOLD") {
              signal = {
                action: v50Action.action === "OPEN_LONG" ? "buy" : v50Action.action === "OPEN_SHORT" ? "sell" : "close",
                symbol: strategy.symbol,
                price: v50Action.price || marketData.lastPrice,
                barTimestamp: marketData.candles[marketData.candles.length - 1].timestamp,
                reason: v50Action.reason,
                confidence: 1.0,
              };
              console.log(`[AutoTradeSignalGenerator] ✅ V5.0 SIGNAL GENERATED: ${signal.action} ${signal.symbol} @ ${signal.price}`);
            } else {
              console.log(`[AutoTradeSignalGenerator] ⏸️ V5.0 HOLD - ${v50Action?.reason || 'no action needed'}`);
              holdDetail = { type: 'strategy_hold' as const, detail: `V5.0 策略判斷觀望: ${v50Action?.reason || '條件未滿足'}` };
            }
          }
        }
      }
    }
    // V4.1 嚴格使用 canonical closed-bar evaluator，通過後才簽發伺服器內部 HMAC 封印。
    else if (strategy.strategyKey === V41_STRATEGY_KEY && engine instanceof StrategyKama3kV41) {
      const configValidation = validateV41Config(boundSnapshotConfig);
      if (!configValidation.valid || !configValidation.config) {
        holdDetail = {
          type: "validation_failed",
          detail: `V4.1 canonical 配置無效（fail-closed）：${configValidation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；")}`,
        };
      } else {
        const v41RuntimeConfig: Record<string, any> = {
          ...engine.defaultConfig,
          ...configValidation.config,
          [V41_CONFIG_KEY]: configValidation.config,
          martinMultiplier: parseFloat(strategy.martinMultiplier?.toString() || "1"),
          maxMartinLevel: strategy.maxMartinLevel,
          martinSpacingPct: parseFloat(strategy.martinSpacingPct?.toString() || "0"),
          reentryEnabled: strategy.reentryEnabled,
          reentryCooldownBars: strategy.reentryCooldownBars,
          ...(typeof strategy.positionSizeObject === "object" && strategy.positionSizeObject !== null
            ? strategy.positionSizeObject as Record<string, unknown>
            : {}),
          Base_Lot_Size: deploymentPosition.value,
          Position_Mode: deploymentPosition.mode,
          Position_Value: deploymentPosition.value,
        };
        const v41Instance: StrategyInstanceConfig = {
          ...strategy,
          positionSize: parseFloat(strategy.positionSize || "0"),
          config: v41RuntimeConfig,
          state: strategyState,
        };
        const isInitialEntry = Number(strategyState.currentLayer ?? 0) === 0
          || Number(strategyState.totalSize ?? 0) <= 0;

        if (!isInitialEntry) {
          holdDetail = {
            type: "strategy_hold",
            detail: "V4.1 已有持倉；入場 evaluator 不重複觸發，持倉管理交由單一 V35-family monitor",
          };
        } else {
          const evaluation = engine.evaluateEntryConditions(initialSignal, marketData, v41Instance);
          if (!evaluation.passed || !evaluation.direction) {
            holdDetail = {
              type: "validation_failed",
              detail: `${evaluation.primaryReasonCode}｜${evaluation.reason}`,
            };
          } else {
            const v41InputSignal: StrategySignal = {
              ...initialSignal,
              action: evaluation.direction === "long" ? "BUY" : "SELL",
              price: evaluation.decisionClose ?? marketData.lastPrice,
              barTimestamp: evaluation.decisionBarTimestamp,
            };
            const stateValidation = engine.validateExecutionState(v41InputSignal, v41Instance);
            if (!stateValidation.valid) {
              holdDetail = {
                type: "validation_failed",
                detail: `V4.1 狀態驗證未通過：${stateValidation.reason}`,
              };
            } else {
              const v41Action = await engine.generateActionsV35(
                v41InputSignal,
                v41Instance,
                marketData,
                strategyState,
              );
              if (v41Action.action === "OPEN_LONG" || v41Action.action === "OPEN_SHORT") {
                const parsedAction = v41Action.action === "OPEN_LONG" ? "buy" : "sell";
                const trustedSeal = createV41TrustedEntrySeal({
                  strategyId: strategy.id,
                  action: parsedAction,
                  evaluation,
                });
                signal = {
                  action: parsedAction,
                  symbol: strategy.symbol,
                  price: evaluation.decisionClose ?? marketData.lastPrice,
                  barTimestamp: evaluation.decisionBarTimestamp,
                  reason: `${evaluation.primaryReasonCode}｜${evaluation.reason}；${v41Action.reason || "首單開倉"}`,
                  confidence: 1,
                  v41TrustedEntrySeal: trustedSeal,
                };
                console.log(
                  `[AutoTradeSignalGenerator][V4.1] ✅ sealed ${parsedAction} strategy=${strategy.id} bar=${evaluation.decisionBarTimestamp} hash=${evaluation.configHash}`,
                );
              } else {
                holdDetail = {
                  type: "strategy_hold",
                  detail: `V4.1 策略判斷觀望：${v41Action.reason || "條件未滿足"}`,
                };
              }
            }
          }
        }
      }
    }
    // Handle V3.5/V4.0 strategies (KAMA) separately due to async generateActionsV35
    else if (engine instanceof BaseStrategyV35) {
      const v35RuntimeConfig: Record<string, number | string | boolean> = {
        // 快照原始配置覆蓋引擎預設；身份不一致時不會回傳配置。
        ...(engine.defaultConfig || {}),
        ...(boundSnapshotConfig as Record<string, number | string | boolean>),
        // Override with strategy-specific fields from the 'strategies' table
        martinMultiplier: parseFloat(strategy.martinMultiplier?.toString() || '1'),
        maxMartinLevel: strategy.maxMartinLevel,
        martinSpacingPct: parseFloat(strategy.martinSpacingPct?.toString() || '0'),
        reentryEnabled: strategy.reentryEnabled,
        reentryCooldownBars: strategy.reentryCooldownBars,
        // Merge positionSizeObject if it's a valid object
        ...(typeof strategy.positionSizeObject === 'object' && strategy.positionSizeObject !== null ? strategy.positionSizeObject as Record<string, number | string | boolean> : {}),
        Base_Lot_Size: deploymentPosition.value,
        Position_Mode: deploymentPosition.mode,
        Position_Value: deploymentPosition.value,
      };
      const v35Instance = {
        ...strategy,
        positionSize: parseFloat(strategy.positionSize || '0'),
        config: v35RuntimeConfig,
      } as StrategyInstanceConfig;

      const isV40InitialEntry = strategy.strategyKey === V40_STRATEGY_KEY
        && (Number(strategyState.currentLayer ?? 0) === 0 || Number(strategyState.totalSize ?? 0) <= 0);
      const v40Gate = isV40InitialEntry
        ? evaluateV40EntryGates({
            candles: marketData.candles,
            rawConfig: v35RuntimeConfig,
            currentPrice: marketData.lastPrice,
            allowedDirection: strategy.direction as "long" | "short" | "both",
          })
        : null;
      const v35InputSignal: StrategySignal = v40Gate?.passed
        ? {
            ...initialSignal,
            action: v40Gate.direction === "long" ? "BUY" : "SELL",
            price: v40Gate.evidence.currentPrice ?? marketData.lastPrice,
          }
        : initialSignal;
      const v35Signal: StrategyAction = v40Gate && !v40Gate.passed
        ? { action: "HOLD", lotSize: 0, reason: v40Gate.reason }
        : await engine.generateActionsV35(
            v35InputSignal,
            v35Instance,
            marketData,
            strategyState,
          );
      console.log(`[AutoTradeSignalGenerator] V35 engine result: action=${v35Signal?.action || 'null'} reason=${v35Signal?.reason || 'none'}`);
      if (v35Signal && v35Signal.action !== "HOLD") {
        const parsedAction = v35Signal.action === "OPEN_LONG" ? "buy" : v35Signal.action === "OPEN_SHORT" ? "sell" : "close";
        const gateBarTimestamp = marketData.candles.at(-1)?.timestamp;
        signal = {
          action: parsedAction,
          symbol: strategy.symbol,
          price: v35Signal.price || marketData.lastPrice,
          barTimestamp: gateBarTimestamp,
          reason: v35Signal.reason, // Add reason
          confidence: 1.0, // Default confidence for V3.5 signals
          ...(strategy.strategyKey === V40_STRATEGY_KEY && isV40InitialEntry && v40Gate?.passed && parsedAction !== "close"
            ? {
                v40EntryGateValidated: true as const,
                v40EntryGateDirection: v40Gate.direction!,
                v40EntryGateBarTimestamp: gateBarTimestamp,
              }
            : {}),
        };
        console.log(`[AutoTradeSignalGenerator] ✅ SIGNAL GENERATED: ${signal.action} ${signal.symbol} @ ${signal.price}`);
      } else {
        console.log(`[AutoTradeSignalGenerator] ⏸️ HOLD - no action needed`);
        holdDetail = { type: 'strategy_hold', detail: `V3.5 策略判斷觀望: ${v35Signal?.reason || '條件未滿足'}` };
      }
    } else {
      // Handle generic strategies (e.g., EMA Martingale)
      const genericSignal: StrategyAction = engine.generateActions(
        initialSignal,
        {
          ...strategy,
          positionSize: parseFloat(strategy.positionSize || '0'),
          config: {
            // 未來註冊的新策略亦自動取得完整快照配置。
            ...(engine.defaultConfig || {}),
            ...(boundSnapshotConfig as Record<string, number | string | boolean>),
            // Override with strategy-specific fields from the 'strategies' table
            martinMultiplier: parseFloat(strategy.martinMultiplier?.toString() || '1'),
            maxMartinLevel: strategy.maxMartinLevel,
            martinSpacingPct: parseFloat(strategy.martinSpacingPct?.toString() || '0'),
            reentryEnabled: strategy.reentryEnabled,
            reentryCooldownBars: strategy.reentryCooldownBars,
            // Merge positionSizeObject if it's a valid object
            ...(typeof strategy.positionSizeObject === 'object' && strategy.positionSizeObject !== null ? strategy.positionSizeObject as Record<string, number | string | boolean> : {}),
            Base_Lot_Size: deploymentPosition.value,
            Position_Mode: deploymentPosition.mode,
            Position_Value: deploymentPosition.value,
          }
        } as StrategyInstanceConfig,
        marketData,
        (freshStrategy || strategy).martinState as any,
      );

      console.log(`[AutoTradeSignalGenerator] Generic engine result: action=${genericSignal?.action || 'null'} reason=${genericSignal?.reason || 'none'}`);
      if (genericSignal && genericSignal.action !== "HOLD") {
        signal = {
          action: genericSignal.action === "OPEN_LONG" ? "buy" : genericSignal.action === "OPEN_SHORT" ? "sell" : "close",
          symbol: strategy.symbol,
          price: genericSignal.price || marketData.lastPrice,
          barTimestamp: marketData.candles[marketData.candles.length - 1].timestamp,
          reason: genericSignal.reason, // Add reason
          confidence: 1.0, // Default confidence for generic signals
        };
        console.log(`[AutoTradeSignalGenerator] ✅ SIGNAL GENERATED: ${signal.action} ${signal.symbol} @ ${signal.price}`);
      } else {
        console.log(`[AutoTradeSignalGenerator] ⏸️ HOLD - no action needed`);
        holdDetail = { type: 'strategy_hold', detail: `策略判斷觀望: ${genericSignal?.reason || '條件未滿足'}` };
      }
    }

    if (withReason) {
      if (signal) return { signal, holdReason: null };
      return { signal: null, holdReason: holdDetail || { type: 'strategy_hold', detail: '策略分析完成，無交易信號' } };
    }
    return signal;
  } catch (error) {
    console.error(`[AutoTradeSignalGenerator] Error generating signal for strategy ${strategy.id}:`, error);
    if (withReason) return { signal: null, holdReason: { type: 'error' as const, detail: `錯誤: ${(error as Error).message}` } };
    return null;
  }
}

/**
 * Generate signals for multiple trading pairs (deprecated, use generateTradingSignal with strategy object)
 */
export async function generateSignalsForMultiplePairs(
  symbols: string[],
  // config: SignalGeneratorConfig, // This is now deprecated
  apiKeyRecord: any
): Promise<Record<string, ParsedSignal | null>> {
  console.warn("generateSignalsForMultiplePairs is deprecated. Use generateTradingSignal with a Strategy object.");
  return {};
}
