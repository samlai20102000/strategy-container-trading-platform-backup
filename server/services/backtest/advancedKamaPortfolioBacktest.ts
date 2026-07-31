import type { BaseStrategy } from "../../strategies/base";
import {
  evaluateV40EntryGates,
  normalizeV40EntryGateConfig,
  V40_STRATEGY_KEY,
} from "../../strategies/v35/entryGate";
import {
  calculateLayerLot,
  getLayerStepPct,
  parseMartinLayers,
} from "../martingaleEngine";
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

const ADVANCED_KAMA_STRATEGY_KEYS = new Set([
  V40_STRATEGY_KEY,
  "KAMA_3K_ULTIMATE_V50",
  "KAMA_3K_HF_V61",
]);

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
}

interface TrailingState {
  activated: boolean;
  peakPnlPct: number;
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
  return ADVANCED_KAMA_STRATEGY_KEYS.has(strategyKey);
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
  } = input;
  if (!supportsAdvancedKamaPortfolio(request.strategyKey)) {
    throw new Error(`策略 ${request.strategyKey} 尚未接入 advanced KAMA portfolio runner`);
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
  const isV35 = request.strategyKey === V40_STRATEGY_KEY;
  const isV61 = request.strategyKey === "KAMA_3K_HF_V61";
  const v40Gate = isV35 ? normalizeV40EntryGateConfig(config) : null;
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
  const targetTpPct = numberValue(config.Target_TP_Pct, riskValidation.settings.targetTPPct);
  const callbackPct = numberValue(config.Callback_Pct, riskValidation.settings.callbackPct);
  const maxLayers = Math.max(1, Math.trunc(numberValue(config.Max_Layers ?? config.MaxMartinLevels, 15)));
  const martinStepPct = numberValue(config.Martin_Step_Pct, 1.5);
  const martinMultiplier = numberValue(config.Martin_Multiplier, 1.5);
  const martinRules = parseMartinLayers(config.Martin_Layers) ?? null;
  const baseLotUsdt = resolveBaseLotUsdt(config, request.initialCapital);
  const enableLossShrink = booleanValue(config.enable_loss_shrink ?? config.Enable_Loss_Shrink, true);
  const lossShrinkLevel1 = numberValue(config.loss_shrink_level1 ?? config.Loss_Shrink_Level1, 3);
  const lossShrinkLevel1Pct = numberValue(config.loss_shrink_level1_pct ?? config.Loss_Shrink_Level1_Pct, 70);
  const lossShrinkLevel2 = numberValue(config.loss_shrink_level2 ?? config.Loss_Shrink_Level2, 5);
  const lossShrinkLevel2Pct = numberValue(config.loss_shrink_level2_pct ?? config.Loss_Shrink_Level2_Pct, 50);
  const enableContinuousEntry = booleanValue(
    config.enable_continuous_entry ?? config.Enable_Continuous_Entry,
    true,
  );
  const trailingByLeg = new Map<string, TrailingState>();
  let candidateSequence = 0;

  const nextCandidate = (
    timestamp: number,
    action: BacktestPortfolioCandidate["action"],
    reasonCode: string,
    quantity?: number,
    eventKind?: BacktestPortfolioCandidate["eventKind"],
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
      requestedQuantity: quantity,
      signalPrice: candles.find(candle => candle.timestamp === timestamp)?.close,
      barTimestamp: timestamp,
      source: eventKind === "FORCED_RISK_EXIT" ? "RISK" : "AUTO",
      reasonCode,
      reason: reasonCode,
      createdAt: timestamp,
      eventKind,
      sequence: candidateSequence,
    };
  };

  const startIndex = Math.max(fastLength + 2, slowLength + 2, 3);
  for (let index = startIndex; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous1 = candles[index - 1];
    const previous2 = candles[index - 2];
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

      const trailing = trailingByLeg.get(leg.legId) ?? { activated: false, peakPnlPct: 0 };
      if (!trailing.activated && pnlPct >= targetTpPct) {
        trailing.activated = true;
        trailing.peakPnlPct = pnlPct;
      }
      if (trailing.activated) {
        trailing.peakPnlPct = Math.max(trailing.peakPnlPct, pnlPct);
        if (trailing.peakPnlPct - pnlPct >= callbackPct) {
          candidates.push(nextCandidate(timestamp, closeAction, "TRAILING_STOP", leg.size, "REGULAR_EXIT"));
        }
      }
      trailingByLeg.set(leg.legId, trailing);

      if (leg.role !== "HEDGE" && leg.martinLayer + 1 < maxLayers) {
        const nextLayer = leg.martinLayer + 2;
        const dynamicStepPct = getLayerStepPct(nextLayer, martinRules, martinStepPct);
        if (deviationFromLast >= dynamicStepPct) {
          const layerUsdt = calculateLayerLot(
            baseLotUsdt,
            leg.martinLayer + 1,
            martinRules,
            martinMultiplier,
          );
          candidates.push(nextCandidate(
            timestamp,
            leg.sideCode === "LONG" ? "ADD_LONG" : "ADD_SHORT",
            "MARTIN_DISTANCE_TRIGGER",
            layerUsdt / price,
            "MARTIN_ADD",
          ));
        }
      }
    }

    const fast = kamaFast[index];
    const slow = kamaSlow[index];
    let signal: "long" | "short" | null = null;
    if (!hasForcedExit && fast !== null && slow !== null) {
      if (isV61) {
        const atr = atrSeries[index] ?? 0;
        const atrMa = atrMaSeries[index];
        const minAtrRatio = numberValue(config.min_atr_ratio, 0.7);
        if (atr > 0 && (atrMa === 0 || atr >= minAtrRatio * atrMa)) {
          const normalizedSpread = Math.abs(fast - slow) / atr;
          const adxPeriod = numberValue(config.adx_period, 14);
          const adxTrendThreshold = numberValue(config.adx_trend_threshold, 25);
          const adxStrongThreshold = numberValue(config.adx_strong_threshold, 30);
          const atrRatioThreshold = numberValue(config.atr_ratio_threshold, 1.2);
          let regime: "ranging" | "weak_trend" | "strong_trend" = "ranging";
          if (index >= adxPeriod) {
            if (normalizedSpread > adxStrongThreshold / 10 && atr > atrMa * atrRatioThreshold) {
              regime = "strong_trend";
            } else if (normalizedSpread > adxTrendThreshold / 10) {
              regime = "weak_trend";
            }
          }
          const bufferMultiplier = regime === "strong_trend"
            ? numberValue(config.buffer_atr_multiplier_trend, 0.25)
            : regime === "weak_trend"
              ? numberValue(config.buffer_atr_multiplier_weak, 0.3)
              : numberValue(config.buffer_atr_multiplier_ranging, 0.5);
          const upper = slow + bufferMultiplier * atr;
          const lower = slow - bufferMultiplier * atr;
          const zoneMode = String(config.entry_zone_mode ?? "breakout");
          let direction = 0;
          if (zoneMode === "breakout") {
            if (price > upper) direction = 1;
            else if (price < lower) direction = -1;
          } else if (price >= lower && price <= upper) {
            direction = price >= (upper + lower) / 2 ? 1 : -1;
          }
          const directionMode = String(config.direction_mode ?? "hybrid");
          const trendPass = direction === 1 ? fast > slow : direction === -1 ? fast < slow : false;
          const directionPass = directionMode === "both"
            || (directionMode === "hybrid" && regime === "ranging")
            || trendPass;
          if (direction !== 0 && directionPass) signal = direction === 1 ? "long" : "short";
        }
      } else if (isV35) {
        const gate = evaluateV40EntryGates({
          candles: [previous2, previous1, candle],
          rawConfig: config,
          currentPrice: price,
          slowKama: slow,
          allowedDirection: config.direction === "long" || config.direction === "short"
            ? config.direction
            : "both",
        });
        if (gate.passed) signal = gate.direction;
      } else {
        const longPattern = previous2.close > previous2.open
          && previous1.close > previous1.open
          && candle.close >= Math.max(previous2.high, previous1.high);
        const shortPattern = previous2.close < previous2.open
          && previous1.close < previous1.open
          && candle.close <= Math.min(previous2.low, previous1.low);
        if (fast > slow && longPattern) signal = "long";
        else if (fast < slow && shortPattern) signal = "short";
      }
    }

    if (signal && (!enableContinuousEntry ? kernel.snapshotTrades().length === 0 : true)) {
      const refreshedLegs = kernel.snapshotOpenLegs(price);
      const sideCode: PositionSide = signal === "long" ? "LONG" : "SHORT";
      const sameSideOpen = refreshedLegs.some(leg => leg.sideCode === sideCode);
      const hedgeActive = refreshedLegs.some(leg => leg.role === "HEDGE");
      if (!sameSideOpen && !hedgeActive) {
        const losses = consecutiveLossCount(kernel.snapshotTrades());
        let effectiveLotUsdt = baseLotUsdt;
        if (enableLossShrink && losses >= lossShrinkLevel2) {
          effectiveLotUsdt *= lossShrinkLevel2Pct / 100;
        } else if (enableLossShrink && losses >= lossShrinkLevel1) {
          effectiveLotUsdt *= lossShrinkLevel1Pct / 100;
        }
        candidates.push(nextCandidate(
          timestamp,
          signal === "long" ? "OPEN_LONG" : "OPEN_SHORT",
          executionPolicy.mode === "HEDGE_GUARDED" && refreshedLegs.length > 0
            ? "H3_REVERSE_SIGNAL_CANDIDATE"
            : "KAMA_ENTRY_SIGNAL",
          effectiveLotUsdt / price,
          "NEW_DIRECTION_OR_HEDGE",
        ));
      }
    }

    kernel.processBar({
      timestamp,
      price,
      high: candle.high,
      low: candle.low,
      fundingRate: numberValue(config.Backtest_Funding_Rate_Per_Bar, 0),
    }, candidates);

    const openIds = new Set(kernel.snapshotOpenLegs(price).map(leg => leg.legId));
    for (const legId of Array.from(trailingByLeg.keys())) {
      if (!openIds.has(legId)) trailingByLeg.delete(legId);
    }
    if (index % 2_000 === 0) {
      const progress = 35 + Math.floor(((index - startIndex) / Math.max(1, candles.length - startIndex)) * 60);
      onProgress?.(progress, `三模式 portfolio 回測 ${index}/${candles.length}（${progress}%）...`);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  const last = candles[candles.length - 1];
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
