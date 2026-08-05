import {
  applyKamaRainbowMartinCloseToState,
  applyKamaRainbowMartinFillToState,
  evaluateKamaRainbowMartinManagement,
  type KamaRainbowMartinManagementDecision,
} from "../../strategies/kamaRainbowMartin/management";
import {
  calculateKamaRainbowMartinSnapshotSeries,
  createKamaRainbowMartinRuntimeState,
  evaluateKamaRainbowMartinEntry,
  type KamaRainbowMartinEntryDecision,
  type KamaRainbowMartinPositionSize,
  type KamaRainbowMartinRuntimeState,
} from "../../strategies/kamaRainbowMartin/core";
import type { KLineData } from "../../strategies/base";
import {
  assertExplicitKamaRainbowMartinConfig,
  createKamaRainbowMartinLineSetReceipt,
  getKamaRainbowMartinTimeframeMinutes,
  type KamaRainbowMartinConfig,
  type KamaRainbowMartinLineSetReceipt,
} from "../../../shared/strategies/kamaRainbowMartin";
import { buildEnvironmentSnapshot } from "../riskSettingsValidator";
import { getBacktestDatabase, type OHLCVRow } from "./backtestDatabase";
import {
  calculatePerformance,
  type EquityPoint,
  type TradeRecord,
} from "./performanceCalculator";
import type { BacktestRequest, BacktestResult } from "./backtestEngine";
import type { BacktestJobControl } from "./backtestJobControl";
import { downsampleEquityCurve as downsample } from "./equityCurveDownsample";
import { parseTimeframe } from "./timeframeParser";
import {
  V25_END_OF_DATA_EXIT_REASON,
  assertSingleEquityLedger,
  buildAccountingSnapshot,
  buildOpenPositionSnapshot,
  roundBacktestMoney,
} from "./backtestContracts";
import {
  createBacktestReentryTracker,
  recordBacktestCycleClose,
  recordBacktestCycleEntry,
  snapshotBacktestReentryDiagnostics,
  type BacktestReentryCycleDescriptor,
  type BacktestReentryTracker,
} from "./backtestReentryDiagnostics";

export interface KamaRainbowMartinBacktestPositionLayer {
  price: number;
  size: number;
  time: number;
  layer: number;
}

export interface KamaRainbowMartinBacktestSession {
  equity: number;
  tradeId: number;
  state: KamaRainbowMartinRuntimeState;
  positionMeta: {
    side: "long" | "short";
    entryTime: number;
    layers: KamaRainbowMartinBacktestPositionLayer[];
    cycle: BacktestReentryCycleDescriptor;
  } | null;
  reentryTracker: BacktestReentryTracker;
  closedCandles: KLineData[];
  trades: TradeRecord[];
  equityCurve: EquityPoint[];
  candleCount: number;
  firstCandle: OHLCVRow | null;
  lastCandle: OHLCVRow | null;
}

export interface KamaRainbowMartinBacktestRunOptions {
  session?: KamaRainbowMartinBacktestSession;
  /** 只有整段資料最後一片可執行終點政策與持久化。 */
  finalize?: boolean;
  /** Durable worker 控制面；省略時維持測試與同步呼叫的純計算語意。 */
  jobControl?: BacktestJobControl;
}

export interface KamaRainbowMartinBacktestRunResult extends BacktestResult {
  lineSetReceipt: KamaRainbowMartinLineSetReceipt;
  session: KamaRainbowMartinBacktestSession;
}

type KamaRainbowMartinDecision = KamaRainbowMartinEntryDecision | KamaRainbowMartinManagementDecision;

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

function toKLine(candle: OHLCVRow): KLineData {
  return {
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    timestamp: candle.timestamp,
  };
}

function normalizePositionSize(rawConfig: Record<string, unknown>): KamaRainbowMartinPositionSize {
  const objectCandidates = [rawConfig.Base_Lot_Size, rawConfig.positionSize, rawConfig.Position_Size];
  for (const candidate of objectCandidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      const value = num(record.value ?? record.Value, 0);
      const modeValue = String(record.mode ?? record.Mode ?? "usdt").toLowerCase();
      if (value > 0) return { mode: modeValue === "quantity" ? "quantity" : "usdt", value };
    }
  }
  const scalar = num(
    rawConfig.tradeAmount
      ?? rawConfig.Trade_Amount
      ?? rawConfig.baseLotSize
      ?? rawConfig.Position_Size_Value,
    100,
  );
  const modeValue = String(
    rawConfig.baseLotSizeMode
      ?? rawConfig.Position_Size_Mode
      ?? rawConfig.positionMode
      ?? "usdt",
  ).toLowerCase();
  return {
    mode: modeValue === "quantity" ? "quantity" : "usdt",
    value: scalar > 0 ? scalar : 100,
  };
}

function allowedDirectionFrom(rawConfig: Record<string, unknown>): "long" | "short" | "both" {
  const value = String(
    rawConfig.Trade_Direction
      ?? rawConfig.Direction_Mode
      ?? rawConfig.directionMode
      ?? rawConfig.direction
      ?? "both",
  ).toLowerCase();
  return value === "long" || value === "short" ? value : "both";
}

function hasPosition(state: KamaRainbowMartinRuntimeState): boolean {
  return state.currentLayer > 0 && state.totalSize > 0 && state.avgPrice > 0;
}

/**
 * Kama 彩虹馬丁獨立同源回測器。
 *
 * 每根輸入 K 線都必須是 canonical timeframe 的已收盤 K 線。空倉時只執行
 * evaluateKamaRainbowMartinEntry；持倉時只執行 evaluateKamaRainbowMartinManagement，
 * 並由 management 核心保證 exit-first。此 runner 故意不實作來源策略的跨日強平與
 * Max_Hold_Hours，避免把已刪除的來源語義帶入 KRM。
 */
export async function runKamaRainbowMartinBacktest(
  request: BacktestRequest,
  strategyName: string,
  rawConfig: Record<string, unknown>,
  candles: OHLCVRow[],
  startMs: number,
  endMs: number,
  commission: number,
  slippage: number,
  onProgress?: (pct: number, message: string) => void,
  options: KamaRainbowMartinBacktestRunOptions = {},
): Promise<KamaRainbowMartinBacktestRunResult> {
  const config: KamaRainbowMartinConfig = assertExplicitKamaRainbowMartinConfig(rawConfig);
  const lineSetReceipt = createKamaRainbowMartinLineSetReceipt(rawConfig, "backtest-input");
  const expectedMinutes = getKamaRainbowMartinTimeframeMinutes(config.timeframe);
  const expectedTimeframe = `${expectedMinutes}m`;
  const requestTimeframe = parseTimeframe(request.timeframe);
  if (requestTimeframe.totalSeconds !== expectedMinutes * 60) {
    throw new Error(
      `Kama 彩虹馬丁週期不一致：配置為 ${config.timeframe}（${expectedMinutes} 分鐘），但回測資料請求為 ${request.timeframe}`,
    );
  }
  const isFinalSegment = options.finalize ?? true;
  const priorSession = options.session;
  const trades = priorSession?.trades ?? [];
  const equityCurve = priorSession?.equityCurve ?? [];
  const closedCandles = priorSession?.closedCandles ?? [];
  const historyOffset = closedCandles.length;
  const precomputedCandles = [...closedCandles, ...candles.map(toKLine)];
  const precomputedSnapshots = calculateKamaRainbowMartinSnapshotSeries(precomputedCandles, config);
  let equity = priorSession?.equity ?? request.initialCapital;
  let tradeId = priorSession?.tradeId ?? 0;
  let state = priorSession?.state ?? createKamaRainbowMartinRuntimeState({
    capital: request.initialCapital,
  });
  let positionMeta: KamaRainbowMartinBacktestSession["positionMeta"] = priorSession?.positionMeta ?? null;
  const reentryTracker = priorSession?.reentryTracker
    ?? createBacktestReentryTracker(request.strategyKey, config.reentryEnabled);
  const basePositionSize = normalizePositionSize(rawConfig);
  const allowedDirection = allowedDirectionFrom(rawConfig);
  const leverage = Math.max(1, num(rawConfig.Leverage ?? rawConfig.leverage, 1));

  const openPositionAt = (price: number) => {
    const active = positionMeta;
    return active && state.totalSize > 0
      ? buildOpenPositionSnapshot({
          side: active.side,
          entryTime: active.entryTime,
          avgPrice: state.avgPrice,
          totalSize: state.totalSize,
          layers: active.layers,
        }, price, commission)
      : null;
  };

  const simulatedAccount = (price: number) => {
    const unrealizedPnl = openPositionAt(price)?.unrealizedPnl ?? 0;
    const markEquity = Math.max(0.00000001, equity + unrealizedPnl);
    const usedMargin = state.totalCost > 0 ? state.totalCost / leverage : 0;
    return {
      equity: markEquity,
      balance: equity,
      usedMargin,
      marginUsagePct: (usedMargin / markEquity) * 100,
    };
  };

  const quantityForSize = (size: KamaRainbowMartinPositionSize, fillPrice: number): number => (
    size.mode === "usdt" ? size.value / fillPrice : size.value
  );

  const applyEntryOrAdd = (
    decision: KamaRainbowMartinDecision,
    timestamp: number,
  ): void => {
    if (!["OPEN_LONG", "OPEN_SHORT", "add_long", "add_short"].includes(decision.action)) return;
    const isLong = decision.action === "OPEN_LONG" || decision.action === "add_long";
    const isInitial = decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT";
    const fillPrice = isLong
      ? decision.price * (1 + slippage)
      : decision.price * (1 - slippage);
    const layer = isInitial ? 1 : "layerNum" in decision ? decision.layerNum : undefined;
    const orderSize = isInitial
      ? basePositionSize
      : "orderSize" in decision
        ? decision.orderSize
        : undefined;
    if (!orderSize || !layer) return;
    const quantity = quantityForSize(orderSize, fillPrice);
    if (!(fillPrice > 0) || !(quantity > 0) || !Number.isFinite(quantity)) return;
    let fillAction: "OPEN_LONG" | "OPEN_SHORT" | "ADD_LONG" | "ADD_SHORT";
    if (decision.action === "add_long") fillAction = "ADD_LONG";
    else if (decision.action === "add_short") fillAction = "ADD_SHORT";
    else if (decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT") fillAction = decision.action;
    else return;
    state = applyKamaRainbowMartinFillToState(decision.nextState, {
      action: fillAction,
      fillId: `backtest:${request.strategyKey}:${timestamp}:L${layer}:${fillAction}`,
      fillPrice,
      fillQuantity: quantity,
      timestamp,
      targetLayer: layer,
      rawConfig: config,
      configRevision: config.version,
      positionSizeAtOpen: basePositionSize,
    });
    if (isInitial || !positionMeta) {
      const cycle = recordBacktestCycleEntry(reentryTracker, {
        timestamp,
        side: isLong ? "long" : "short",
        price: fillPrice,
        reasonCode: decision.reasonCode,
        reason: decision.reason,
      });
      positionMeta = {
        side: isLong ? "long" : "short",
        entryTime: timestamp,
        layers: [{ price: fillPrice, size: quantity, time: timestamp, layer }],
        cycle,
      };
    } else {
      positionMeta.layers.push({ price: fillPrice, size: quantity, time: timestamp, layer });
    }
  };

  const applyClose = (
    decision: KamaRainbowMartinDecision,
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
    const entryNotional = meta.layers.reduce((sum, layer) => sum + layer.price * layer.size, 0);
    const fees = (entryNotional + effectiveExitPrice * state.totalSize) * commission;
    const pnl = roundBacktestMoney(grossPnl - fees);
    const pnlPct = state.avgPrice > 0
      ? (grossPnl / (state.avgPrice * state.totalSize)) * 100
      : 0;
    const closeReason = "closeReason" in decision && decision.closeReason
      ? decision.closeReason
      : "OTHER";
    recordBacktestCycleClose(reentryTracker, {
      cycle: meta.cycle,
      timestamp,
      price: effectiveExitPrice,
      reasonCode: decision.reasonCode,
      reason: forcedReason ?? decision.reason,
      closeReason,
    });
    equity = roundBacktestMoney(equity + pnl);
    trades.push({
      id: ++tradeId,
      cycleId: meta.cycle.cycleId,
      entryReason: meta.cycle.entryReason,
      entryTime: meta.entryTime,
      exitTime: timestamp,
      side: meta.side,
      entryPrice: Math.round(state.avgPrice * 100) / 100,
      exitPrice: Math.round(effectiveExitPrice * 100) / 100,
      size: state.totalSize,
      pnl,
      pnlPct: Math.round(pnlPct * 100) / 100,
      exitReason: forcedReason ?? decision.reason,
      martinLayer: Math.max(0, state.currentLayer - 1),
    });
    state = applyKamaRainbowMartinCloseToState(
      decision.nextState,
      closeReason,
      timestamp,
    );
    positionMeta = null;
  };

  onProgress?.(
    35,
    `數據就緒（${candles.length} 根 ${request.timeframe}），啟動 KRM ${expectedTimeframe} 同源回測...`,
  );
  await options.jobControl?.checkpoint({
    phase: "RUNNING",
    processedBars: 0,
    totalBars: candles.length,
    progress: 35,
    message: `KRM runner 已就緒（${candles.length} 根）`,
    force: true,
  });
  const first = candles[0] ?? priorSession?.firstCandle;
  if (!first) throw new Error("Kama 彩虹馬丁回測沒有可處理的 K 線");
  if (equityCurve.length === 0) {
    equityCurve.push({ timestamp: first.timestamp, equity, price: first.close });
  }

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const closed = toKLine(candle);
    closedCandles.push(closed);
    let decision: KamaRainbowMartinDecision;
    if (hasPosition(state)) {
      decision = evaluateKamaRainbowMartinManagement({
        currentPrice: candle.close,
        now: candle.timestamp,
        riskEventKey: `backtest:${candle.timestamp}`,
      }, state, config);
    } else {
      decision = evaluateKamaRainbowMartinEntry({
        state,
        rawConfig: config,
        configRevision: config.version,
        lastBarClosed: true,
        allowedDirection,
        precomputedSnapshot: precomputedSnapshots[historyOffset + index],
      });
    }

    if (decision.action === "HOLD" || decision.action === "MANAGE_POSITION" || decision.action === "hold") {
      state = decision.nextState;
    } else if (decision.action === "close") {
      applyClose(decision, candle.timestamp);
      if (config.reentryEnabled) {
        const reentryDecision = evaluateKamaRainbowMartinEntry({
          state,
          rawConfig: config,
          configRevision: config.version,
          lastBarClosed: true,
          allowedDirection,
          precomputedSnapshot: precomputedSnapshots[historyOffset + index],
        });
        if (reentryDecision.action === "OPEN_LONG" || reentryDecision.action === "OPEN_SHORT") {
          applyEntryOrAdd(reentryDecision, candle.timestamp);
        } else {
          state = reentryDecision.nextState;
        }
      }
    } else {
      applyEntryOrAdd(decision, candle.timestamp);
    }

    const unrealizedPnl = openPositionAt(candle.close)?.unrealizedPnl ?? 0;
    equityCurve.push({
      timestamp: candle.timestamp,
      equity: roundBacktestMoney(equity + unrealizedPnl),
      price: candle.close,
    });
    if (index > 0 && index % 250 === 0) {
      const progress = 35 + Math.floor((index / candles.length) * 60);
      const message = `KRM 同源回測 ${index}/${candles.length}（${closedCandles.length} 根已收盤 K 線）...`;
      onProgress?.(progress, message);
      await options.jobControl?.checkpoint({
        phase: "RUNNING",
        processedBars: index,
        totalBars: candles.length,
        progress,
        message,
      });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (isFinalSegment) {
    await options.jobControl?.checkpoint({
      phase: "FINALIZING",
      processedBars: candles.length,
      totalBars: candles.length,
      progress: 95,
      message: "KRM 計算完成，正在保存結果...",
      force: true,
    });
  }

  if (isFinalSegment && config.backtestEndPositionPolicy === "force_close" && positionMeta) {
    const last = candles[candles.length - 1] ?? priorSession?.lastCandle;
    if (last) {
      const forcedDecision = evaluateKamaRainbowMartinManagement({
        currentPrice: last.close,
        now: last.timestamp,
        riskEventKey: `backtest:end:${last.timestamp}`,
      }, state, config);
      applyClose(
        {
          ...forcedDecision,
          action: "close",
          reason: V25_END_OF_DATA_EXIT_REASON,
          closeReason: "OTHER",
        },
        last.timestamp,
        V25_END_OF_DATA_EXIT_REASON,
      );
      equityCurve.push({ timestamp: last.timestamp, equity, price: last.close });
    }
  }

  const finalMark = candles[candles.length - 1] ?? priorSession?.lastCandle ?? null;
  const openPosition = finalMark ? openPositionAt(finalMark.close) : null;
  const finalEquity = roundBacktestMoney(equity + (openPosition?.unrealizedPnl ?? 0));
  if (finalMark) {
    if (equityCurve.length === 0 || equityCurve[equityCurve.length - 1].timestamp !== finalMark.timestamp) {
      equityCurve.push({ timestamp: finalMark.timestamp, equity: finalEquity, price: finalMark.close });
    } else {
      equityCurve[equityCurve.length - 1] = {
        timestamp: finalMark.timestamp,
        equity: finalEquity,
        price: finalMark.close,
      };
    }
  }
  const accounting = buildAccountingSnapshot({
    initialCapital: request.initialCapital,
    trades,
    unrealizedPnl: openPosition?.unrealizedPnl ?? 0,
    finalEquity,
    openPositionCount: openPosition ? 1 : 0,
    syntheticForceCloseCount: trades.filter(trade => trade.exitReason === V25_END_OF_DATA_EXIT_REASON).length,
    openPosition,
  });
  assertSingleEquityLedger(accounting);

  if (isFinalSegment) onProgress?.(95, "計算 KRM 績效指標...");
  const metrics = calculatePerformance(trades, equityCurve, request.initialCapital);
  const runId = makeRunId(request.strategyKey, request.symbol);
  const totalCandleCount = (priorSession?.candleCount ?? 0) + candles.length;
  const firstCandle = priorSession?.firstCandle ?? candles[0] ?? null;
  const lastCandle = candles[candles.length - 1] ?? priorSession?.lastCandle ?? null;
  const summaryPrefix = isFinalSegment ? "Kama 彩虹馬丁回測完成" : "Kama 彩虹馬丁資料分片完成（狀態保留）";
  const reentryDiagnostics = snapshotBacktestReentryDiagnostics(reentryTracker);
  const summary = `${summaryPrefix}：${strategyName} / ${request.symbol} ${expectedTimeframe}，入市線 ${lineSetReceipt.enabledLineCount}/${lineSetReceipt.totalLineCount} [${lineSetReceipt.enabledLineIds.join(", ")}]（${lineSetReceipt.lineSetHash}），共 ${totalCandleCount} 根已收盤 K 線、${trades.length} 筆交易、${reentryDiagnostics.cycleCount} 個 cycle、${reentryDiagnostics.reentryCount} 次重新入市（${reentryDiagnostics.enabled ? "啟用" : "停用"}），總回報 ${metrics.totalReturn}%，勝率 ${metrics.winRate}%，最大回撤 ${metrics.maxDrawdown}%`;

  const session: KamaRainbowMartinBacktestSession = {
    equity,
    tradeId,
    state,
    positionMeta,
    reentryTracker,
    closedCandles,
    trades,
    equityCurve,
    candleCount: totalCandleCount,
    firstCandle,
    lastCandle,
  };

  if (isFinalSegment) {
    try {
      const database = getBacktestDatabase();
      database.saveBacktestResult({
        run_id: runId,
        strategy_key: request.strategyKey,
        symbol: request.symbol,
        timeframe: expectedTimeframe,
        start_date: firstCandle?.timestamp ?? startMs,
        end_date: lastCandle?.timestamp ?? endMs,
        initial_capital: request.initialCapital,
        config: JSON.stringify(config),
        status: "completed",
        created_at: Date.now(),
      }, trades);
      database.savePerformanceMetrics(runId, metrics, downsample(equityCurve, 2000));
    } catch (error) {
      console.warn("[Backtest KRM] 結果持久化失敗（不影響回傳）:", error);
    }
  }

  const environment = buildEnvironmentSnapshot(
    request.symbol,
    expectedTimeframe,
    firstCandle?.timestamp ?? startMs,
    lastCandle?.timestamp ?? endMs,
    totalCandleCount,
    request.initialCapital,
    commission,
    slippage,
    leverage,
    firstCandle?.close,
    lastCandle?.close,
  );
  if (isFinalSegment) onProgress?.(100, summary);
  return {
    runId,
    strategyKey: request.strategyKey,
    strategyName,
    trades,
    metrics,
    equityCurve: downsample(equityCurve, 2000),
    config: { ...config },
    summary,
    candleCount: totalCandleCount,
    environment,
    lineSetReceipt,
    endPositionPolicy: config.backtestEndPositionPolicy,
    accounting,
    reentryDiagnostics,
    session,
  };
}
