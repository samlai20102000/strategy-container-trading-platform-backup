import type { StrategyRainbowTrendLadder } from "../../strategies/builtin/strategyRainbowTrendLadder";
import {
  calculateRainbowTrendLadderLineSnapshot,
  createRainbowTrendLadderRuntimeState,
  evaluateRainbowTrendLadderEntry,
  type RainbowTrendLadderCoreDecision,
  type RainbowTrendLadderRuntimeState,
} from "../../strategies/rainbowTrendLadder/core";
import {
  applyRainbowTrendLadderCloseToState,
  applyRainbowTrendLadderFillToState,
  evaluateRainbowTrendLadderManagement,
} from "../../strategies/rainbowTrendLadder/management";
import {
  assertValidRainbowTrendLadderConfig,
} from "../../../shared/strategies/rainbowTrendLadder";
import { buildEnvironmentSnapshot } from "../riskSettingsValidator";
import { getBacktestDatabase, type OHLCVRow } from "./backtestDatabase";
import {
  calculatePerformance,
  type EquityPoint,
  type TradeRecord,
} from "./performanceCalculator";
import type { BacktestRequest, BacktestResult } from "./backtestEngine";

interface PositionLayer {
  price: number;
  size: number;
  time: number;
}

interface EntryCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

function num(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function makeRunId(strategyKey: string, symbol: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  const key = strategyKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
  const normalizedSymbol = symbol.replace(/[^A-Za-z0-9]/g, "");
  return `bt_${key}_${Date.now()}_${random}_${normalizedSymbol}`;
}

function downsample(points: EquityPoint[], maxPoints: number): EquityPoint[] {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const result: EquityPoint[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    result.push(points[Math.floor(index * step)]);
  }
  result.push(points[points.length - 1]);
  return result;
}

/**
 * 全新七彩虹線趨勢跟蹤階梯馬丁專屬回測。
 *
 * 只接受管理週期 K 線（預設 M1），內部聚合已完整收盤的 M30 K 線；
 * 空倉只在新 M30 收盤時呼叫進場純核心，持倉則每根 M1 呼叫盲人管理純核心。
 */
export function runRainbowTrendLadderBacktest(
  request: BacktestRequest,
  strategy: StrategyRainbowTrendLadder,
  rawConfig: Record<string, unknown>,
  candles: OHLCVRow[],
  startMs: number,
  endMs: number,
  commission: number,
  slippage: number,
  onProgress?: (pct: number, message: string) => void,
): BacktestResult {
  const config = assertValidRainbowTrendLadderConfig(rawConfig);
  const expectedTimeframe = config.Management_Interval_Minutes % 60 === 0
    ? `${config.Management_Interval_Minutes / 60}h`
    : `${config.Management_Interval_Minutes}m`;
  const entryTimeframeLabel = config.Entry_Timeframe_Minutes % 60 === 0
    ? `${config.Entry_Timeframe_Minutes / 60}h`
    : `${config.Entry_Timeframe_Minutes}m`;
  if (request.timeframe.toLowerCase() !== expectedTimeframe.toLowerCase()) {
    throw new Error(
      `七彩虹線階梯回測必須使用 ${expectedTimeframe} 管理週期；${entryTimeframeLabel} 入場 K 線由引擎內部聚合。`,
    );
  }

  const trades: TradeRecord[] = [];
  const equityCurve: EquityPoint[] = [];
  let equity = request.initialCapital;
  let tradeId = 0;
  let state: RainbowTrendLadderRuntimeState = createRainbowTrendLadderRuntimeState({
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
  const leverage = Math.max(1, num(rawConfig.Leverage ?? rawConfig.leverage, 1));
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
    const usedMargin = state.totalCost > 0 ? state.totalCost / leverage : 0;
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
    decision: RainbowTrendLadderCoreDecision,
    fillPrice: number,
  ): number => {
    const orderSize = decision.orderSize ?? config.Base_Lot_Size;
    return orderSize.mode === "usdt" ? orderSize.value / fillPrice : orderSize.value;
  };

  const applyEntryOrAdd = (
    decision: RainbowTrendLadderCoreDecision,
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
    state = applyRainbowTrendLadderFillToState(decision.nextState, {
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
    decision: RainbowTrendLadderCoreDecision,
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
    state = applyRainbowTrendLadderCloseToState(
      decision.nextState,
      decision.closeReason ?? "OTHER",
      config,
      timestamp,
    );
    positionMeta = null;
  };

  onProgress?.(
    35,
    `數據就緒（${candles.length} 根 ${expectedTimeframe}），啟動七彩虹線階梯 ${entryTimeframeLabel}／${expectedTimeframe} 同源回測...`,
  );
  const first = candles[0];
  equityCurve.push({ timestamp: first.timestamp, equity, price: first.close });

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    updateEntryAggregation(candle);
    const hasPosition = state.currentLayer > 0 && state.totalSize > 0 && state.avgPrice > 0;
    let decision: RainbowTrendLadderCoreDecision | null = null;

    if (hasPosition) {
      const trendSnapshot = closedEntryCandles.length >= requiredEntryBars
        ? calculateRainbowTrendLadderLineSnapshot(closedEntryCandles, config)
        : undefined;
      decision = evaluateRainbowTrendLadderManagement(
        {
          currentPrice: candle.close,
          now: candle.timestamp,
          account: simulatedAccount(candle.close),
          trendSnapshot,
          spreadPoints: 0,
        },
        state,
        config,
      );
    } else if (latestEntryBarClosed) {
      decision = evaluateRainbowTrendLadderEntry({
        candles: closedEntryCandles,
        state,
        rawConfig: config,
        allowedDirection,
        spreadPoints: 0,
      });
    }

    if (decision) {
      if (decision.action === "hold") {
        state = decision.nextState;
      } else if (decision.action === "close") {
        applyClose(decision, candle.timestamp);
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
        `七彩虹線階梯同源回測 ${index}/${candles.length}（${entryTimeframeLabel} 已收盤 ${closedEntryCandles.length} 根）...`,
      );
    }
  }

  if (positionMeta) {
    const last = candles[candles.length - 1];
    const trendSnapshot = closedEntryCandles.length >= requiredEntryBars
      ? calculateRainbowTrendLadderLineSnapshot(closedEntryCandles, config)
      : undefined;
    const forcedDecision = evaluateRainbowTrendLadderManagement(
      {
        currentPrice: last.close,
        now: last.timestamp,
        account: simulatedAccount(last.close),
        trendSnapshot,
        spreadPoints: 0,
      },
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

  onProgress?.(95, "計算七彩虹線階梯績效指標...");
  const metrics = calculatePerformance(trades, equityCurve, request.initialCapital);
  const runId = makeRunId(request.strategyKey, request.symbol);
  const summary = `七彩虹線階梯回測完成：${strategy.name} / ${request.symbol} ${request.timeframe}，共 ${candles.length} 根管理 K 線、${closedEntryCandles.length} 根已收盤 ${entryTimeframeLabel}、${trades.length} 筆交易，總回報 ${metrics.totalReturn}%，勝率 ${metrics.winRate}%，最大回撤 ${metrics.maxDrawdown}%`;

  try {
    const database = getBacktestDatabase();
    database.saveBacktestResult(
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
    database.savePerformanceMetrics(runId, metrics, downsample(equityCurve, 2000));
  } catch (error) {
    console.warn("[Backtest 七彩虹線階梯] 結果持久化失敗（不影響回傳）:", error);
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
    leverage,
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
