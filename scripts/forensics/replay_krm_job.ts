import fs from "node:fs";
import path from "node:path";

import { fetchOKXCandles } from "../../server/services/backtest/dataFetcher";
import { runKamaRainbowMartinBacktest } from "../../server/services/backtest/kamaRainbowMartinBacktest";
import type { BacktestRequest } from "../../server/services/backtest/backtestEngine";

const ROOT = "/home/ubuntu/策略容器化自動交易平台-的副本";
const OUTPUT_DIR = path.join(ROOT, "artifacts/backtest-100dd");
const SOURCE_SUMMARY = path.join(OUTPUT_DIR, "job_1785770356467_b7fe7008_forensic_summary.json");
const OUTPUT_SUMMARY = path.join(OUTPUT_DIR, "krm_true_data_replay_summary.json");
const OUTPUT_CURVE = path.join(OUTPUT_DIR, "krm_true_data_replay_equity_curve.json");

type JsonRecord = Record<string, any>;

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

async function main(): Promise<void> {
  const source = JSON.parse(fs.readFileSync(SOURCE_SUMMARY, "utf8")) as JsonRecord;
  const job = source.job as JsonRecord;
  const commission = Number(job.environment.commission);
  const slippage = Number(job.environment.slippage);
  const leverage = Number(job.environment.leverage);
  const grossLimitPct = Number(job.executionContext.executionPolicy.riskBudget.maxGrossNotionalPct);
  const marginLimitPct = Number(job.executionContext.executionPolicy.riskBudget.maxMarginUsagePct);
  const maintenanceMarginRate = 0.005;

  const candles = await fetchOKXCandles(
    String(job.symbol),
    String(job.timeframe),
    Number(job.startDate),
    Number(job.endDate),
  );
  if (candles.length !== Number(job.dataQuality.candleCount)) {
    throw new Error(`K 線數不一致：重播=${candles.length}，原 job=${job.dataQuality.candleCount}`);
  }

  const request: BacktestRequest = {
    strategyKey: String(job.strategyKey),
    symbol: String(job.symbol),
    timeframe: String(job.timeframe),
    startDate: Number(job.startDate),
    endDate: Number(job.endDate),
    initialCapital: Number(job.initialCapital),
    commission,
    slippage,
    config: job.config,
    exchange: "okx",
    endPositionPolicy: job.config.backtestEndPositionPolicy,
    executionMode: job.executionContext.executionMode,
    executionPolicy: job.executionContext.executionPolicy,
  } as BacktestRequest;

  const replay = await runKamaRainbowMartinBacktest(
    request,
    "Kama彩虹馬丁策略",
    job.config,
    candles,
    Number(job.startDate),
    Number(job.endDate),
    commission,
    slippage,
    undefined,
    { finalize: false },
  );

  // BacktestResult.equityCurve 為 UI／持久化降採樣輸出；session.equityCurve 才是逐 K 完整路徑。
  // 法證、回撤與破產判定必須使用完整路徑，否則會遺失真正峰值／谷值。
  const curve = replay.session.equityCurve;
  const firstNonPositive = curve.find(point => point.equity <= 0);
  if (!firstNonPositive) throw new Error("重播未產生非正權益，無法重現原事故");
  const minimum = curve.reduce((candidate, point) => point.equity < candidate.equity ? point : candidate, curve[0]);
  const pointBeforeInsolvency = curve[curve.findIndex(point => point.timestamp === firstNonPositive.timestamp) - 1] ?? null;

  const partialCandles = candles.filter(candle => candle.timestamp <= firstNonPositive.timestamp);
  const partial = await runKamaRainbowMartinBacktest(
    request,
    "Kama彩虹馬丁策略",
    job.config,
    partialCandles,
    Number(job.startDate),
    firstNonPositive.timestamp + 1,
    commission,
    slippage,
    undefined,
    { finalize: false },
  );
  const state = partial.session.state;
  const meta = partial.session.positionMeta;
  if (!meta) throw new Error("首次破產點沒有持倉，與事故證據不一致");

  let priorQuantity = 0;
  let priorEntryNotional = 0;
  let priorEntryFees = 0;
  const realizedBalance = partial.session.equity;
  let firstGrossBreach: JsonRecord | null = null;
  let firstMarginBreach: JsonRecord | null = null;
  const layerRiskAudit = meta.layers.map(layer => {
    const proposedNotional = layer.price * layer.size;
    const existingGrossAtMark = priorQuantity * layer.price;
    const proposedGrossAtMark = existingGrossAtMark + proposedNotional;
    const previousAverageEntry = priorQuantity > 0 ? priorEntryNotional / priorQuantity : 0;
    const existingGrossPnl = priorQuantity <= 0
      ? 0
      : meta.side === "long"
        ? (layer.price - previousAverageEntry) * priorQuantity
        : (previousAverageEntry - layer.price) * priorQuantity;
    const riskEquityBeforeOrder = realizedBalance + existingGrossPnl - priorEntryFees;
    const grossLimit = riskEquityBeforeOrder * grossLimitPct / 100;
    const marginLimit = riskEquityBeforeOrder * marginLimitPct / 100;
    const proposedMargin = proposedGrossAtMark / leverage;
    const grossApproved = proposedGrossAtMark <= grossLimit + 0.01;
    const marginApproved = proposedMargin <= marginLimit + 0.01;
    const audit = {
      layer: layer.layer,
      timestamp: layer.time,
      timestampIso: iso(layer.time),
      fillPrice: round(layer.price),
      fillQuantity: round(layer.size, 12),
      proposedLayerNotional: round(proposedNotional),
      cumulativeGrossAtMark: round(proposedGrossAtMark),
      cumulativeMargin: round(proposedMargin),
      riskEquityBeforeOrder: round(riskEquityBeforeOrder),
      grossLimit: round(grossLimit),
      marginLimit: round(marginLimit),
      grossApproved,
      marginApproved,
      policyApproved: grossApproved && marginApproved,
      rejectionReason: !grossApproved
        ? "RISK_GROSS_NOTIONAL_LIMIT"
        : !marginApproved
          ? "RISK_MARGIN_USAGE_LIMIT"
          : null,
    };
    if (!grossApproved && !firstGrossBreach) firstGrossBreach = audit;
    if (!marginApproved && !firstMarginBreach) firstMarginBreach = audit;
    priorQuantity += layer.size;
    priorEntryNotional += proposedNotional;
    priorEntryFees += proposedNotional * commission;
    return audit;
  });

  const grossNotionalAtInsolvency = state.totalSize * firstNonPositive.price;
  const usedMarginAtInsolvency = grossNotionalAtInsolvency / leverage;
  const maintenanceMarginAtInsolvency = grossNotionalAtInsolvency * maintenanceMarginRate;
  const insolvencyPriceMovePct = meta.side === "long"
    ? (firstNonPositive.price - state.avgPrice) / state.avgPrice * 100
    : (state.avgPrice - firstNonPositive.price) / state.avgPrice * 100;
  const matchingOriginalTrade = replay.trades.find(trade => (
    trade.entryTime <= firstNonPositive.timestamp && trade.exitTime >= firstNonPositive.timestamp
  ));

  let peak = Number(job.initialCapital);
  let maximumDrawdown = { pct: 0, usdt: 0, peak, trough: peak, timestamp: curve[0].timestamp };
  const enrichedCurve = curve.map(point => {
    if (point.equity > peak) peak = point.equity;
    const boundedEquity = Math.max(0, point.equity);
    const drawdownUsdt = Math.max(0, peak - boundedEquity);
    const drawdownPct = peak > 0 ? Math.min(100, drawdownUsdt / peak * 100) : 0;
    if (drawdownPct > maximumDrawdown.pct || (drawdownPct === maximumDrawdown.pct && drawdownUsdt > maximumDrawdown.usdt)) {
      maximumDrawdown = {
        pct: drawdownPct,
        usdt: drawdownUsdt,
        peak,
        trough: point.equity,
        timestamp: point.timestamp,
      };
    }
    return {
      ...point,
      timestampIso: iso(point.timestamp),
      runningPeak: round(peak),
      drawdownUsdt: round(drawdownUsdt),
      drawdownPct: round(drawdownPct),
    };
  });

  const summary = {
    sourceJobId: job.jobId,
    replayData: {
      candleCount: candles.length,
      firstTimestamp: candles[0]?.timestamp,
      firstTimestampIso: candles[0] ? iso(candles[0].timestamp) : null,
      lastTimestamp: candles.at(-1)?.timestamp,
      lastTimestampIso: candles.at(-1) ? iso(candles.at(-1)!.timestamp) : null,
      fullEquityPointCount: curve.length,
      tradeCount: replay.trades.length,
    },
    reproducibility: {
      originalMetrics: job.metrics,
      replayMetrics: replay.metrics,
      totalReturnDifferencePct: round(replay.metrics.totalReturn - Number(job.metrics.totalReturn)),
      maxDrawdownDifferencePct: round(replay.metrics.maxDrawdown - Number(job.metrics.maxDrawdown)),
      maxDrawdownUsdtDifference: round(replay.metrics.maxDrawdownUSDT - Number(job.metrics.maxDrawdownUSDT)),
      tradeCountDifference: replay.trades.length - Number(job.metrics.totalTrades),
    },
    insolvency: {
      firstNonPositive: { ...firstNonPositive, timestampIso: iso(firstNonPositive.timestamp) },
      pointBeforeInsolvency: pointBeforeInsolvency
        ? { ...pointBeforeInsolvency, timestampIso: iso(pointBeforeInsolvency.timestamp) }
        : null,
      minimum: { ...minimum, timestampIso: iso(minimum.timestamp) },
      realizedBalance: round(realizedBalance),
      side: meta.side,
      currentLayer: state.currentLayer,
      totalSize: round(state.totalSize, 12),
      averageEntryPrice: round(state.avgPrice),
      totalEntryNotional: round(state.totalCost),
      grossNotionalAtMark: round(grossNotionalAtInsolvency),
      usedMarginAtMark: round(usedMarginAtInsolvency),
      marginUsagePctOfMarkEquity: firstNonPositive.equity > 0
        ? round(usedMarginAtInsolvency / firstNonPositive.equity * 100)
        : null,
      maintenanceMarginAtMark: round(maintenanceMarginAtInsolvency),
      maintenanceLiquidationRequired: firstNonPositive.equity <= maintenanceMarginAtInsolvency + 0.01,
      adversePriceMoveFromWeightedAveragePct: round(insolvencyPriceMovePct),
      configuredHardStopLossPct: Number(job.config.hardStopLossPct),
      hardStopTriggeredAtThisClose: Math.abs(insolvencyPriceMovePct) >= Number(job.config.hardStopLossPct),
      matchingClosedTrade: matchingOriginalTrade ?? null,
    },
    riskPolicyAudit: {
      leverage,
      maxGrossNotionalPct: grossLimitPct,
      maxMarginUsagePct: marginLimitPct,
      maintenanceMarginRate,
      firstGrossBreach,
      firstMarginBreach,
      layerRiskAudit,
    },
    maximumDrawdownFromFullReplay: {
      ...maximumDrawdown,
      timestampIso: iso(maximumDrawdown.timestamp),
    },
  };

  fs.writeFileSync(OUTPUT_SUMMARY, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(OUTPUT_CURVE, `${JSON.stringify(enrichedCurve, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    outputSummary: OUTPUT_SUMMARY,
    outputCurve: OUTPUT_CURVE,
    candleCount: candles.length,
    fullEquityPointCount: curve.length,
    tradeCount: replay.trades.length,
    firstNonPositive: summary.insolvency.firstNonPositive,
    currentLayer: summary.insolvency.currentLayer,
    firstMarginBreach,
    firstGrossBreach,
    replayMetrics: replay.metrics,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
