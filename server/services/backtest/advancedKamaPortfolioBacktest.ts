import type { BaseStrategy } from "../../strategies/base";
import { buildEnvironmentSnapshot, validateRiskSettings } from "../riskSettingsValidator";
import type { ExecutionPolicy, PositionSide } from "../../../shared/executionModes";
import { calculateKAMASeries } from "./kama";
import { calculatePerformance, type EquityPoint, type TradeRecord } from "./performanceCalculator";
import type { OHLCVRow } from "./backtestDatabase";
import {
  createContinuousEngineSemantics,
  roundBacktestMoney,
  type BacktestEndPositionPolicy,
} from "./backtestContracts";
import {
  ThreeModePortfolioKernel,
  type BacktestPortfolioCandidate,
} from "./threeModePortfolioKernel";
import type { BacktestRequest, BacktestResult } from "./backtestEngine";
import {
  createPortfolioStrategyRuntimeAdapter,
  resolvePortfolioStrategyAdapter,
  type ResolvedPortfolioStrategyAdapter,
} from "./portfolioStrategyAdapterRegistry";
import { ensureBuiltInPortfolioRuntimeFactoriesRegistered } from "./builtInPortfolioRuntimeFactories";
import {
  throwIfBacktestAborted,
  type BacktestJobControl,
} from "./backtestJobControl";

interface AdvancedKamaPortfolioInput {
  request: BacktestRequest;
  strategy: BaseStrategy;
  config: Record<string, unknown>;
  candles: OHLCVRow[];
  startMs: number;
  endMs: number;
  executionPolicy: ExecutionPolicy;
  endPositionPolicy: BacktestEndPositionPolicy;
  commission: number;
  slippage: number;
  onProgress?: (progress: number, message: string) => void;
  jobControl?: BacktestJobControl;
  resolvedAdapter?: ResolvedPortfolioStrategyAdapter;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function calculateATRSeries(candles: OHLCVRow[], period: number): Array<number | null> {
  const result = new Array<number | null>(candles.length).fill(null);
  if (candles.length <= period || period <= 0) return result;
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  let rolling = 0;
  for (let index = 0; index < trueRanges.length; index += 1) {
    rolling += trueRanges[index];
    if (index >= period) rolling -= trueRanges[index - period];
    if (index >= period - 1) result[index] = rolling / period;
  }
  return result;
}

function resolveBaseLotUsdt(config: Record<string, unknown>, initialCapital: number): number {
  const raw = config.Base_Lot_Size ?? config.base_lot_size;
  if (typeof raw === "object" && raw !== null && (raw as { mode?: unknown }).mode === "usdt") {
    const value = Number((raw as { value?: unknown }).value);
    if (Number.isFinite(value) && value > 0) return value;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) return raw;
  return initialCapital * (numberValue(config.First_Order_Pct, 0.5) / 100);
}

function consecutiveLossCount(trades: ReturnType<ThreeModePortfolioKernel["snapshotTrades"]>): number {
  let count = 0;
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    if (trades[index].pnl < 0) count += 1;
    else break;
  }
  return count;
}

function buildTradeRecords(
  trades: ReturnType<ThreeModePortfolioKernel["snapshotTrades"]>,
): TradeRecord[] {
  return trades.map((trade, index) => ({
    id: index + 1,
    legId: trade.legId,
    cycleId: trade.cycleId,
    role: trade.role,
    deploymentMode: trade.deploymentMode,
    triggerSource: trade.triggerSource,
    entryReason: trade.entryReason,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    side: trade.side === "LONG" ? "long" : "short",
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    size: trade.quantity,
    pnl: roundBacktestMoney(trade.pnl),
    pnlPct: trade.entryPrice > 0
      ? Math.round((trade.grossPnl / (trade.entryPrice * trade.quantity)) * 10_000) / 100
      : 0,
    exitReason: trade.exitReason,
    martinLayer: trade.martinLayer,
  }));
}

function deterministicDeploymentId(request: BacktestRequest): number {
  const input = `${request.strategyKey}|${request.symbol}|${request.timeframe}|${request.startDate}|${request.endDate}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.max(1, hash >>> 0);
}

export function supportsAdvancedKamaPortfolio(strategyKey: string): boolean {
  try {
    resolvePortfolioStrategyAdapter(strategyKey, "MULTI_POSITION");
    return true;
  } catch {
    return false;
  }
}

export async function runAdvancedKamaPortfolioBacktest(
  input: AdvancedKamaPortfolioInput,
): Promise<BacktestResult> {
  const {
    request,
    strategy,
    config,
    candles,
    startMs,
    endMs,
    executionPolicy,
    endPositionPolicy,
    commission,
    slippage,
    onProgress,
    jobControl,
    resolvedAdapter: suppliedAdapter,
  } = input;
  const resolvedAdapter = suppliedAdapter
    ?? resolvePortfolioStrategyAdapter(request.strategyKey, executionPolicy.mode);
  if (resolvedAdapter.descriptor.strategyKey !== request.strategyKey) {
    throw new Error(`PORTFOLIO_ADAPTER_STRATEGY_MISMATCH:${request.strategyKey}`);
  }
  if (candles.length < 4) throw new Error("advanced portfolio 回測至少需要 4 根已收盤 K 線");

  const deploymentId = deterministicDeploymentId(request);
  const leverage = Math.max(1, numberValue(config.Leverage ?? config.leverage, 1));
  const capabilities = request.strategyModeCapabilities;
  const kernel = new ThreeModePortfolioKernel({
    deploymentId,
    executionPolicy,
    initialCapital: request.initialCapital,
    leverage,
    commissionRate: commission,
    slippageRate: slippage,
    capabilities: {
      supportsIndependentLongShort: capabilities?.independentLegState === true,
      canPreciselyCloseLeg: capabilities?.preciseLegClose === true,
      capturedAt: startMs,
      expiresAt: endMs + 1,
      blockerCodes: [],
    },
  });

  const fastLength = Math.max(1, Math.trunc(numberValue(config.kama_fast_length ?? config.KAMA_Fast_Length, 50)));
  const slowLength = Math.max(1, Math.trunc(numberValue(config.kama_slow_length ?? config.KAMA_Slow_Length, 50)));
  const closes = candles.map(candle => candle.close);
  const kamaFast = calculateKAMASeries(
    closes,
    fastLength,
    numberValue(config.kama_fast_fastest ?? config.p2_fastest, 10),
    numberValue(config.kama_fast_slowest ?? config.p3_slowest, 2),
  );
  const kamaSlow = calculateKAMASeries(
    closes,
    slowLength,
    numberValue(config.kama_slow_fastest ?? config.q2_fastest, 10),
    numberValue(config.kama_slow_slowest ?? config.q3_slowest, 6),
  );
  const atrSeries = calculateATRSeries(candles, 14);
  const atrMaSeries = new Array<number>(candles.length).fill(0);
  let atrRollingSum = 0;
  let atrRollingCount = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const atr = atrSeries[index];
    if (atr !== null) {
      atrRollingSum += atr;
      atrRollingCount += 1;
    }
    const removeIndex = index - 50;
    if (removeIndex >= 0 && atrSeries[removeIndex] !== null) {
      atrRollingSum -= atrSeries[removeIndex] as number;
      atrRollingCount -= 1;
    }
    atrMaSeries[index] = atrRollingCount > 0 ? atrRollingSum / atrRollingCount : 0;
  }

  const riskValidation = validateRiskSettings(config);
  if (!riskValidation.valid) {
    throw new Error(`advanced portfolio 風控參數不合法：${riskValidation.errors.map(error => `${error.field}:${error.message}`).join("；")}`);
  }
  const maxLossPct = numberValue(config.Max_Loss_Pct, riskValidation.settings.maxLossPct);
  const maxLossUsdt = numberValue(config.Max_Loss_USDT, 0);
  const maxDrawdownPct = numberValue(config.Max_Drawdown_Pct ?? config.MaxDrawdownPercent, 35);
  const maxDeviationPct = numberValue(config.Max_Deviation_Pct ?? config.max_deviation_pct, 3);
  const maxLayers = Math.max(1, Math.trunc(numberValue(config.Max_Layers ?? config.MaxMartinLevels, 15)));
  const baseLotUsdt = resolveBaseLotUsdt(config, request.initialCapital);
  ensureBuiltInPortfolioRuntimeFactoriesRegistered();
  const runtimeAdapter = createPortfolioStrategyRuntimeAdapter(resolvedAdapter, {
    strategy,
    config,
    candles,
    executionPolicy,
    initialCapital: request.initialCapital,
    baseLotUsdt,
  });
  let candidateSequence = 0;

  const nextCandidate = (
    timestamp: number,
    action: BacktestPortfolioCandidate["action"],
    reasonCode: string,
    quantity?: number,
    eventKind?: BacktestPortfolioCandidate["eventKind"],
    roleHint?: BacktestPortfolioCandidate["roleHint"],
    cycleIdHint?: BacktestPortfolioCandidate["cycleIdHint"],
  ): BacktestPortfolioCandidate => {
    candidateSequence += 1;
    const side: PositionSide | undefined = action.endsWith("LONG")
      ? "LONG"
      : action.endsWith("SHORT")
        ? "SHORT"
        : undefined;
    return {
      candidateId: `bt:${deploymentId}:${timestamp}:${candidateSequence}:${action}`.slice(0, 128),
      deploymentId,
      action,
      side,
      roleHint,
      requestedQuantity: quantity,
      signalPrice: candles.find(candle => candle.timestamp === timestamp)?.close,
      barTimestamp: timestamp,
      source: eventKind === "FORCED_RISK_EXIT" ? "RISK" : "AUTO",
      reasonCode,
      reason: reasonCode,
      createdAt: timestamp,
      eventKind,
      cycleIdHint,
      sequence: candidateSequence,
    };
  };

  // minimumClosedBars 是 registry 的保守資料需求提示，不得凌駕本次參數快照。
  // 真正的 warm-up 由各 executable adapter／策略核心依其 config 決定；KAMA 共用指標只需按本次長度起跑。
  const startIndex = Math.max(fastLength + 2, slowLength + 2, 3);
  await jobControl?.checkpoint({
    phase: "RUNNING",
    processedBars: startIndex,
    totalBars: candles.length,
    progress: 35,
    message: `三模式 portfolio kernel 已就緒（${candles.length} 根）`,
    force: true,
  });
  for (let index = startIndex; index < candles.length; index += 1) {
    throwIfBacktestAborted(jobControl?.signal);
    const candle = candles[index];
    const price = candle.close;
    const timestamp = candle.timestamp;
    const candidates: BacktestPortfolioCandidate[] = [];
    const legs = kernel.snapshotOpenLegs(price);
    let hasForcedExit = false;

    for (const leg of legs) {
      const pnlPct = leg.entryNotional > 0 ? (leg.unrealizedGrossPnl / leg.entryNotional) * 100 : 0;
      const floatingLoss = Math.max(0, -leg.unrealizedGrossPnl);
      const maxLossAbsolute = request.initialCapital * (maxLossPct / 100);
      const deviationFromLast = leg.side === "long"
        ? ((leg.lastEntryPrice - price) / leg.lastEntryPrice) * 100
        : ((price - leg.lastEntryPrice) / leg.lastEntryPrice) * 100;
      const hardLoss = maxLossPct > 0 && floatingLoss >= maxLossAbsolute;
      const absoluteLoss = maxLossUsdt > 0 && floatingLoss >= maxLossUsdt;
      const extremeLoss = pnlPct <= -maxDrawdownPct
        || (leg.martinLayer + 1 >= maxLayers && deviationFromLast >= maxDeviationPct);
      const closeAction = leg.sideCode === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT";

      if (hardLoss || absoluteLoss || extremeLoss) {
        const reason = hardLoss
          ? "HARD_STOP_INITIAL_CAPITAL"
          : absoluteLoss
            ? "ABSOLUTE_LOSS_STOP"
            : "EXTREME_DRAWDOWN_STOP";
        candidates.push(nextCandidate(timestamp, closeAction, reason, leg.size, "FORCED_RISK_EXIT"));
        hasForcedExit = true;
        continue;
      }

    }

    const closedTrades = kernel.snapshotTrades();
    const previousCandle = (offset: number) => (
      Number.isSafeInteger(offset) && offset >= 1 ? candles[index - offset] : undefined
    );
    const adapterDecision = await runtimeAdapter.evaluateBar({
      index,
      timestamp,
      candle,
      previousCandle,
      config,
      strategy,
      executionMode: executionPolicy.mode,
      executionPolicy,
      initialCapital: request.initialCapital,
      baseLotUsdt,
      openLegs: legs,
      indicators: {
        kamaFast: kamaFast[index],
        kamaSlow: kamaSlow[index],
        atr: atrSeries[index] ?? 0,
        atrAverage: atrMaSeries[index],
      },
      consecutiveLosses: consecutiveLossCount(closedTrades),
      closedTradeCount: closedTrades.length,
    });
    if (!hasForcedExit) {
      for (const intent of [...adapterDecision.management, ...adapterDecision.entries]) {
        candidates.push(nextCandidate(
          timestamp,
          intent.action,
          intent.reasonCode,
          intent.quantity,
          intent.eventKind,
          intent.roleHint,
          intent.cycleIdHint,
        ));
      }
    }

    const beforeLegs = legs;
    kernel.processBar({
      timestamp,
      price,
      high: candle.high,
      low: candle.low,
      fundingRate: numberValue(config.Backtest_Funding_Rate_Per_Bar, 0),
    }, candidates);

    const afterLegs = kernel.snapshotOpenLegs(price);
    await runtimeAdapter.onBarCommitted?.({
      index,
      timestamp,
      candle,
      previousCandle,
      config,
      strategy,
      executionMode: executionPolicy.mode,
      executionPolicy,
      initialCapital: request.initialCapital,
      baseLotUsdt,
      openLegs: afterLegs,
      beforeLegs,
      afterLegs,
      indicators: {
        kamaFast: kamaFast[index],
        kamaSlow: kamaSlow[index],
        atr: atrSeries[index] ?? 0,
        atrAverage: atrMaSeries[index],
      },
      consecutiveLosses: consecutiveLossCount(kernel.snapshotTrades()),
      closedTradeCount: kernel.snapshotTrades().length,
    });
    if (index % 250 === 0) {
      const progress = 35 + Math.floor(((index - startIndex) / Math.max(1, candles.length - startIndex)) * 60);
      onProgress?.(progress, `三模式 portfolio 回測 ${index}/${candles.length}（${progress}%）...`);
      await jobControl?.checkpoint({
        phase: "RUNNING",
        processedBars: index,
        totalBars: candles.length,
        progress,
        message: `三模式 portfolio 回測 ${index}/${candles.length}（${progress}%）...`,
      });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  const last = candles[candles.length - 1];
  await jobControl?.checkpoint({
    phase: "FINALIZING",
    processedBars: candles.length,
    totalBars: candles.length,
    progress: 95,
    message: "三模式 portfolio 計算完成，正在保存績效與結果...",
    force: true,
  });
  const portfolio = kernel.finalize(endPositionPolicy, last.timestamp, last.close);
  const trades = buildTradeRecords(portfolio.trades);
  const equityCurve: EquityPoint[] = portfolio.equityCurve.map(point => ({
    timestamp: point.timestamp,
    equity: point.equity,
    price: point.price,
  }));
  const metrics = calculatePerformance(trades, equityCurve, request.initialCapital);
  const runId = `bt-3m-${deploymentId}-${last.timestamp}`;
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
    last.close,
  );
  const summary = `三模式回測完成：${strategy.name} / ${request.symbol} ${request.timeframe} / ${executionPolicy.mode}，${candles.length} 根 K 線，${trades.length} 筆逐腿交易，總回報 ${metrics.totalReturn}%，最大回撤 ${metrics.maxDrawdown}%`;

  return {
    runId,
    strategyKey: request.strategyKey,
    strategyName: strategy.name,
    trades,
    metrics,
    equityCurve,
    config,
    summary,
    candleCount: candles.length,
    environment,
    endPositionPolicy,
    accounting: portfolio.accounting,
    engineSemantics: createContinuousEngineSemantics(),
    legAccounting: portfolio.legAccounting,
    modeResults: portfolio.modeResults,
  };
}
