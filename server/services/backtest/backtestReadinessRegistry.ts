import {
  BACKTEST_READINESS_CONTRACT_VERSION,
  type BacktestAdmissionAssessment,
  type BacktestDataQualityAssessment,
  type BacktestReadinessReasonCode,
  type BacktestStrategyReadinessEntry,
} from "../../../shared/backtest/backtestReadiness";
import type { ExecutionMode } from "../../../shared/executionModes";
import {
  BUILT_IN_STRATEGY_KEYS,
  getBuiltInStrategyRunnerDescriptor,
  isBuiltInStrategyKey,
  type BuiltInStrategyKey,
} from "../strategyRunnerDescriptors";
import type { BacktestDataQuality } from "./backtestContracts";
import type { OHLCVRow } from "./backtestDatabase";

const OKX_BACKTEST_TIMEFRAMES = [
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "7d",
] as const;

type AuditDefinition = Omit<
  BacktestStrategyReadinessEntry,
  | "contractVersion"
  | "readiness"
  | "certification"
  | "certificationReason"
  | "supportedModes"
  | "allowedTimeframes"
> & { allowedTimeframes?: readonly string[] };

const ALL_TIMEFRAMES = [...OKX_BACKTEST_TIMEFRAMES];

const AUDITED_STRATEGIES: Readonly<Record<BuiltInStrategyKey, AuditDefinition>> = Object.freeze({
  strategy_20415: {
    strategyKey: "strategy_20415",
    displayName: "20415 七彩虹馬丁策略",
    confidence: "HIGH",
    riskLevel: "HIGH",
    recommendedTimeframes: ["15m", "30m"],
    minimumClosedBars: 120,
    dataRequirements: ["至少 120 根已收盤 OHLCV", "逐腿與馬丁層狀態"],
    logicParity: "SHARED_CORE",
    logicAssessment: "實盤與回測共用 rainbow20415 進場與管理核心。",
    canonicalConfigPath: "shared/strategies/rainbow20415.ts",
    liveLogicPath: "server/strategies/rainbow20415/core.ts",
    backtestLogicPath: "server/services/backtest/builtInPortfolioRuntimeFactories.ts",
    registrationEvidence: ["strategyRunnerDescriptors.ts", "strategyStudio.ts"],
    outputCapabilities: ["martingaleLayers", "independentLegState", "preciseLegClose", "hedgeGuard"],
    baselineOracleTargets: ["RAINBOW_20415_ENTRY", "RAINBOW_20415_MANAGE"],
    highRiskOracleTargets: ["MULTI_LEG_ACCOUNTING", "MARTINGALE_LAYER_ISOLATION"],
    auditNotes: [],
  },
  RAINBOW_TREND_LADDER_V1: {
    strategyKey: "RAINBOW_TREND_LADDER_V1",
    displayName: "七線趨勢階梯策略",
    confidence: "HIGH",
    riskLevel: "HIGH",
    recommendedTimeframes: ["30m"],
    minimumClosedBars: 120,
    dataRequirements: ["至少 120 根已收盤 OHLCV", "M30 進場與管理事件"],
    logicParity: "SHARED_CORE",
    logicAssessment: "實盤橋接與回測共用 rainbowTrendLadder 純核心。",
    canonicalConfigPath: "shared/strategies/rainbowTrendLadder.ts",
    liveLogicPath: "server/strategies/builtin/strategyRainbowTrendLadder.ts",
    backtestLogicPath: "server/services/backtest/rainbowTrendLadderBacktest.ts",
    registrationEvidence: ["strategyRunnerDescriptors.ts", "strategyStudio.ts"],
    outputCapabilities: ["martingaleLayers", "independentLegState", "preciseLegClose", "hedgeGuard"],
    baselineOracleTargets: ["RAINBOW_LADDER_ENTRY", "RAINBOW_LADDER_MANAGEMENT"],
    highRiskOracleTargets: ["M30_CLOSED_BAR_SEMANTICS", "MULTI_LEG_ACCOUNTING"],
    auditNotes: [],
  },
  KAMA_RAINBOW_MARTIN_V1: {
    strategyKey: "KAMA_RAINBOW_MARTIN_V1",
    displayName: "KAMA 彩虹馬丁策略",
    confidence: "HIGH",
    riskLevel: "HIGH",
    allowedTimeframes: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"],
    recommendedTimeframes: ["15m", "30m"],
    minimumClosedBars: 2,
    dataRequirements: ["至少 max(啟用 KAMA ER 週期)+1 根已收盤 OHLCV", "S1 模式"],
    logicParity: "SHARED_CORE",
    logicAssessment: "實盤與回測共用 KRM entry／management 核心；M2/H3 依方案 B 凍結。",
    canonicalConfigPath: "shared/strategies/kamaRainbowMartin.ts",
    liveLogicPath: "server/strategies/kamaRainbowMartin/core.ts;management.ts",
    backtestLogicPath: "server/services/backtest/kamaRainbowMartinBacktest.ts",
    registrationEvidence: ["strategyRunnerDescriptors.ts", "portfolioStrategyAdapterRegistry.ts"],
    outputCapabilities: ["trades", "equity", "fees", "reentry", "cycleEvidence"],
    baselineOracleTargets: ["KRM_ENTRY_LONG", "KRM_ENTRY_SHORT", "KRM_HARD_STOP", "KRM_TRAILING_EXIT", "KRM_MARTIN_ADD"],
    highRiskOracleTargets: ["KRM_CROSS_LOCK", "KRM_TOUCH_LOCK", "KRM_MIXED_SLOPE", "KRM_REENTRY"],
    auditNotes: ["funding 尚未納入 KRM 專用 runner。"],
  },
  KAMA_3K_BREAKOUT_V25: {
    strategyKey: "KAMA_3K_BREAKOUT_V25",
    displayName: "KAMA 3K 突破 V2.5",
    confidence: "HIGH",
    riskLevel: "HIGH",
    recommendedTimeframes: ["15m", "30m"],
    minimumClosedBars: 201,
    dataRequirements: ["至少 max(KAMA Fast/Slow Length)+1 根已收盤 OHLCV"],
    logicParity: "SHARED_CORE",
    logicAssessment: "實盤與回測共用 V2.5 訊號核心。",
    canonicalConfigPath: "shared/strategies/kama3kBreakoutV25.ts",
    liveLogicPath: "server/strategies/v25/core.ts",
    backtestLogicPath: "server/services/backtest/builtInPortfolioRuntimeFactories.ts",
    registrationEvidence: ["strategyRunnerDescriptors.ts", "strategyStudio.ts"],
    outputCapabilities: ["trades", "equity", "fees", "funding", "reentry", "modeAttribution"],
    baselineOracleTargets: ["V25_ENTRY_LONG", "V25_ENTRY_SHORT", "V25_HARD_STOP"],
    highRiskOracleTargets: ["V25_MARTIN_RANGES", "V25_TRAILING_TP", "V25_REENTRY_ON_TREND"],
    auditNotes: [],
  },
  "20415_KAMA_MARTIN_V35": {
    strategyKey: "20415_KAMA_MARTIN_V35",
    displayName: "KAMA 3K 動態馬丁 V3.5",
    confidence: "HIGH",
    riskLevel: "HIGH",
    recommendedTimeframes: ["15m", "30m"],
    minimumClosedBars: 4,
    dataRequirements: ["至少 4 根已收盤 OHLCV", "逐腿 canonical portfolio ledger"],
    logicParity: "SHARED_CORE",
    logicAssessment: "實盤與回測共用 V3.5/V4.0 entry gate 與 portfolio kernel。",
    canonicalConfigPath: "server/services/strategySnapshotConfig.ts",
    liveLogicPath: "server/strategies/v35/strategy_kama_3k_v35.ts;entryGate.ts",
    backtestLogicPath: "server/services/backtest/advancedKamaPortfolioBacktest.ts",
    registrationEvidence: ["strategyRunnerDescriptors.ts", "strategyStudio.ts"],
    outputCapabilities: ["trades", "metrics", "equityCurve", "accounting", "legAccounting", "modeResults"],
    baselineOracleTargets: ["V35_ENTRY_GATE", "V35_SINGLE_LEDGER"],
    highRiskOracleTargets: ["V35_M2_OPPOSITE_LEGS", "V35_H3_HEDGE_GUARD"],
    auditNotes: [],
  },
  "20415_KAMA_MARTIN_V41": {
    strategyKey: "20415_KAMA_MARTIN_V41",
    displayName: "KAMA 3K 三條件馬丁 V4.1",
    confidence: "HIGH",
    riskLevel: "HIGH",
    recommendedTimeframes: ["15m", "30m"],
    minimumClosedBars: 120,
    dataRequirements: ["至少 120 根已收盤 OHLCV", "AND/OR 三條件資料"],
    logicParity: "SHARED_CORE",
    logicAssessment: "實盤與回測共用 V4.1 entryConditions。",
    canonicalConfigPath: "shared/strategies/kama3kMartinV41.ts",
    liveLogicPath: "server/strategies/v41/strategy_kama_3k_v41.ts;entryConditions.ts",
    backtestLogicPath: "server/services/backtest/builtInPortfolioRuntimeFactories.ts",
    registrationEvidence: ["strategyRunnerDescriptors.ts", "strategyStudio.ts"],
    outputCapabilities: ["martingaleLayers", "independentLegState", "preciseLegClose", "hedgeGuard"],
    baselineOracleTargets: ["V41_ENTRY_OPEN", "V41_NO_PATTERN", "V41_FAST_SLOW_EQUAL", "V41_PRICE_EQUALS_SLOW"],
    highRiskOracleTargets: ["V41_DIRECTION_CONFLICT", "V41_AND_WAITING_FOR_ALL", "V41_OR_NO_DIRECTION", "V41_REENTRY"],
    auditNotes: [],
  },
  KAMA_3K_ULTIMATE_V50: {
    strategyKey: "KAMA_3K_ULTIMATE_V50",
    displayName: "KAMA 3K Ultimate V5.0",
    confidence: "HIGH",
    riskLevel: "HIGH",
    recommendedTimeframes: ["15m"],
    minimumClosedBars: 120,
    dataRequirements: ["至少 120 根已收盤 OHLCV", "ADX 與 ATR 可計算"],
    logicParity: "WRAPPED_SHARED_CORE",
    logicAssessment: "實盤與回測沿用 V5.0 F1-F6 模組及 canonical portfolio kernel。",
    canonicalConfigPath: "server/services/strategySnapshotConfig.ts",
    liveLogicPath: "server/strategies/v50/strategy_kama_3k_v50.ts",
    backtestLogicPath: "server/services/backtest/advancedKamaPortfolioBacktest.ts",
    registrationEvidence: ["strategyRunnerDescriptors.ts", "strategyStudio.ts"],
    outputCapabilities: ["martingaleLayers", "independentLegState", "preciseLegClose", "hedgeGuard"],
    baselineOracleTargets: ["V50_ENTRY", "V50_F1_REGIME", "V50_TRAILING_EXIT"],
    highRiskOracleTargets: ["V50_DYNAMIC_MARTIN", "V50_PARTIAL_TP", "V50_MULTI_MODE_ACCOUNTING"],
    auditNotes: [],
  },
  KAMA_3K_HF_V61: {
    strategyKey: "KAMA_3K_HF_V61",
    displayName: "KAMA 3K V6.1 高頻掃射",
    confidence: "HIGH",
    riskLevel: "CRITICAL",
    recommendedTimeframes: ["15m", "30m"],
    minimumClosedBars: 69,
    dataRequirements: ["至少 max(KAMA Slow, 50)+14 根已收盤 OHLCV", "ATR 與 regime 資料"],
    logicParity: "FORK_RISK",
    logicAssessment: "實盤使用 generateSignalV61；部分 S1 回測仍有 inline V6.1 區域與方向邏輯，存在漂移風險。",
    canonicalConfigPath: "server/strategies/v61/strategy_kama_3k_v61.ts",
    liveLogicPath: "server/strategies/v61/strategy_kama_3k_v61.ts;autoTradeSignalGenerator.ts",
    backtestLogicPath: "server/services/backtest/backtestEngine.ts;builtInPortfolioRuntimeFactories.ts",
    registrationEvidence: ["strategyRunnerDescriptors.ts", "strategyStudio.ts"],
    outputCapabilities: ["trades", "equity", "fees", "regime", "dailyTrades", "modeResults"],
    baselineOracleTargets: ["V61_BACKTEST_ORACLE", "V61_LIVE_ORACLE"],
    highRiskOracleTargets: ["V61_ZONE_TRIGGER_PARITY", "V61_DIRECTION_MODE_PARITY", "V61_NEGATIVE_EQUITY"],
    auditNotes: ["FORK_RISK 必須由 parity oracle 持續守護。"],
  },
  KAMA_3K_TORNADO_V70: {
    strategyKey: "KAMA_3K_TORNADO_V70",
    displayName: "V7.0 KAMA 3K 龍捲風雙渦輪",
    confidence: "HIGH",
    riskLevel: "CRITICAL",
    recommendedTimeframes: ["5m", "15m"],
    minimumClosedBars: 220,
    dataRequirements: ["至少 max(MA200+20, KAMA Fast/Slow ER+1) 根已收盤 OHLCV"],
    logicParity: "FORK_RISK",
    logicAssessment: "共用訊號核心，但 S1 回測有專用 runV70Backtest 執行路徑，存在漂移風險。",
    canonicalConfigPath: "server/strategies/v70/strategy_kama_3k_v70.ts",
    liveLogicPath: "server/strategies/v70/strategy_kama_3k_v70.ts;autoTradeSignalGenerator.ts",
    backtestLogicPath: "server/services/backtest/backtestEngine.ts:runV70Backtest",
    registrationEvidence: ["strategyRunnerDescriptors.ts"],
    outputCapabilities: ["trades", "equity", "commission", "martingaleLayers", "modeResults"],
    baselineOracleTargets: ["V70_MA200", "V70_KAMA_CROSS", "V70_S_CURVE_LAYER", "V70_HARD_STOP"],
    highRiskOracleTargets: ["V70_REVERSE_CROSS_CLOSE", "V70_LAYER_TP", "V70_MARTIN_TRIGGER", "V70_PATH_PARITY"],
    auditNotes: ["funding、重新入市與 attribution 不屬於目前 V7.0 runner 能力。"],
  },
});

function numberFromRecord(value: unknown, keys: readonly string[]): number | null {
  const visited = new Set<unknown>();
  const walk = (candidate: unknown, depth: number): number | null => {
    if (!candidate || typeof candidate !== "object" || depth > 4 || visited.has(candidate)) return null;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const found = walk(item, depth + 1);
        if (found !== null) return found;
      }
      return null;
    }
    const record = candidate as Record<string, unknown>;
    for (const key of keys) {
      const number = Number(record[key]);
      if (Number.isFinite(number) && number > 0) return number;
    }
    for (const nested of Object.values(record)) {
      const found = walk(nested, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(value, 0);
}

function krmMinimumBars(config: Record<string, unknown>): number | null {
  const visited = new Set<unknown>();
  const periods: number[] = [];
  const walk = (candidate: unknown, depth: number): void => {
    if (!candidate || typeof candidate !== "object" || depth > 4 || visited.has(candidate)) return;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) walk(item, depth + 1);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (Array.isArray(record.kamaLines)) {
      for (const line of record.kamaLines) {
        if (!line || typeof line !== "object") continue;
        const value = line as Record<string, unknown>;
        const erPeriod = Number(value.erPeriod);
        if (value.enabled !== false && Number.isFinite(erPeriod) && erPeriod > 0) periods.push(erPeriod);
      }
    }
    for (const nested of Object.values(record)) walk(nested, depth + 1);
  };
  walk(config, 0);
  return periods.length > 0 ? Math.max(...periods) + 1 : null;
}

export function resolveBacktestMinimumClosedBars(
  strategyKey: string,
  config: Record<string, unknown> = {},
): number {
  const base = getBacktestReadinessEntry(strategyKey)?.minimumClosedBars ?? 1;
  if (strategyKey === "KAMA_RAINBOW_MARTIN_V1") return Math.max(base, krmMinimumBars(config) ?? base);
  if (strategyKey === "KAMA_3K_BREAKOUT_V25") {
    const length = numberFromRecord(config, ["KAMA_Slow_Length", "kama_slow_length"]);
    return Math.max(base, length ? Math.ceil(length) + 1 : base);
  }
  if (strategyKey === "KAMA_3K_HF_V61") {
    const length = numberFromRecord(config, ["kama_slow_length"]);
    return Math.max(base, length ? Math.ceil(Math.max(length, 50)) + 14 : base);
  }
  if (strategyKey === "KAMA_3K_TORNADO_V70") {
    const ma = numberFromRecord(config, ["ma200_period"]);
    const fast = numberFromRecord(config, ["kama_fast_er_period"]);
    const slow = numberFromRecord(config, ["kama_slow_er_period"]);
    return Math.max(base, (ma ?? 200) + 20, (fast ?? 50) + 1, (slow ?? 50) + 1);
  }
  return base;
}

export function getBacktestReadinessEntry(strategyKey: string): BacktestStrategyReadinessEntry | null {
  if (!isBuiltInStrategyKey(strategyKey)) return null;
  const audit = AUDITED_STRATEGIES[strategyKey];
  const descriptor = getBuiltInStrategyRunnerDescriptor(strategyKey);
  const certification = descriptor.certifications.BACKTEST;
  return {
    contractVersion: BACKTEST_READINESS_CONTRACT_VERSION,
    ...audit,
    allowedTimeframes: [...(audit.allowedTimeframes ?? ALL_TIMEFRAMES)],
    readiness: certification.status === "CERTIFIED" ? "READY" : "BLOCKED",
    certification: certification.status,
    certificationReason: certification.reason,
    supportedModes: [...certification.supportedModes],
  };
}

export function listBacktestReadinessMatrix(): BacktestStrategyReadinessEntry[] {
  return BUILT_IN_STRATEGY_KEYS.map(key => {
    const entry = getBacktestReadinessEntry(key);
    if (!entry) throw new Error(`BACKTEST_READINESS_MATRIX_MISSING:${key}`);
    return entry;
  });
}

export function assessBacktestAdmission(input: {
  strategyKey: string;
  timeframe: string;
  executionMode: ExecutionMode;
  config?: Record<string, unknown>;
}): BacktestAdmissionAssessment {
  const readiness = getBacktestReadinessEntry(input.strategyKey);
  const reasonCodes: BacktestReadinessReasonCode[] = [];
  const warnings: string[] = [];
  if (!readiness) reasonCodes.push("BACKTEST_STRATEGY_NOT_AUDITED");
  else {
    if (readiness.readiness !== "READY" || readiness.certification !== "CERTIFIED") {
      reasonCodes.push("BACKTEST_STRATEGY_NOT_READY");
    }
    if (!readiness.supportedModes.includes(input.executionMode)) reasonCodes.push("BACKTEST_MODE_NOT_CERTIFIED");
    if (!readiness.allowedTimeframes.includes(input.timeframe)) reasonCodes.push("BACKTEST_TIMEFRAME_NOT_SUPPORTED");
    if (!readiness.recommendedTimeframes.includes(input.timeframe)) {
      warnings.push(`目前時間框架 ${input.timeframe} 非此策略的建議時間框架（${readiness.recommendedTimeframes.join("、")}）`);
    }
    if (readiness.logicParity === "FORK_RISK") warnings.push("實盤與回測存在分岔執行路徑，結果需由 parity oracle 持續守護");
  }
  const uniqueReasonCodes = [...new Set(reasonCodes)];
  return {
    allowed: uniqueReasonCodes.length === 0,
    reasonCodes: uniqueReasonCodes.length === 0 ? ["READY"] : uniqueReasonCodes,
    warnings,
    requestedTimeframe: input.timeframe,
    executionMode: input.executionMode,
    effectiveMinimumClosedBars: resolveBacktestMinimumClosedBars(input.strategyKey, input.config),
    readiness,
  };
}

export function assessBacktestDataQuality(input: {
  quality: BacktestDataQuality;
  candles: OHLCVRow[];
  minimumClosedBars: number;
  timeframeMs: number;
}): BacktestDataQualityAssessment {
  const reasonCodes: BacktestReadinessReasonCode[] = [];
  const warnings: string[] = [];
  const { quality, candles } = input;
  const rejectionCount = quality.invalidCandleCount + quality.outOfRangeCount + quality.unclosedCandleCount;
  const rejectionRatio = quality.inputCandles > 0 ? rejectionCount / quality.inputCandles : 0;
  const duplicateRatio = quality.inputCandles > 0 ? quality.duplicateTimestampCount / quality.inputCandles : 0;
  let gapCount = 0;
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].timestamp - candles[index - 1].timestamp > input.timeframeMs * 1.5) gapCount += 1;
  }
  const gapRatio = candles.length > 1 ? gapCount / (candles.length - 1) : 0;

  if (candles.length === 0) reasonCodes.push("BACKTEST_DATA_EMPTY");
  else if (candles.length < input.minimumClosedBars) reasonCodes.push("BACKTEST_DATA_INSUFFICIENT");
  if (!quality.sortedAscending) reasonCodes.push("BACKTEST_DATA_NOT_SORTED");
  if (rejectionRatio > 0.01) reasonCodes.push("BACKTEST_DATA_REJECTION_RATIO_EXCEEDED");
  else if (rejectionCount > 0) warnings.push(`已移除 ${rejectionCount} 根無效／越界／未收盤 K 線`);
  if (duplicateRatio > 0.05) reasonCodes.push("BACKTEST_DUPLICATE_RATIO_EXCEEDED");
  else if (quality.duplicateTimestampCount > 0) warnings.push(`已去除 ${quality.duplicateTimestampCount} 個重複時間戳`);
  if (gapRatio > 0.05) reasonCodes.push("BACKTEST_DATA_GAP_RATIO_EXCEEDED");
  else if (gapCount > 0) warnings.push(`資料包含 ${gapCount} 個時間缺口`);

  const uniqueReasonCodes = [...new Set(reasonCodes)];
  return {
    passed: uniqueReasonCodes.length === 0,
    reasonCodes: uniqueReasonCodes.length === 0 ? ["READY"] : uniqueReasonCodes,
    warnings,
    minimumClosedBars: input.minimumClosedBars,
    returnedCandles: candles.length,
    rejectionRatio,
    duplicateRatio,
    gapCount,
    gapRatio,
  };
}

export class BacktestDataQualityGuardError extends Error {
  readonly code: Exclude<BacktestReadinessReasonCode, "READY">;

  constructor(
    readonly strategyKey: string,
    readonly timeframe: string,
    readonly assessment: BacktestDataQualityAssessment,
  ) {
    const code = assessment.reasonCodes.find(
      (reason): reason is Exclude<BacktestReadinessReasonCode, "READY"> => reason !== "READY",
    ) ?? "BACKTEST_DATA_INSUFFICIENT";
    super(`${code}: ${strategyKey} / ${timeframe}`);
    this.name = "BacktestDataQualityGuardError";
    this.code = code;
  }
}

export function assertBacktestReadinessMatrixIntegrity(): void {
  const keys = Object.keys(AUDITED_STRATEGIES).sort();
  const expected = [...BUILT_IN_STRATEGY_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`BACKTEST_READINESS_MATRIX_KEY_MISMATCH:${keys.join(",")}`);
  }
  for (const entry of listBacktestReadinessMatrix()) {
    if (entry.strategyKey !== getBuiltInStrategyRunnerDescriptor(entry.strategyKey as BuiltInStrategyKey).strategyKey) {
      throw new Error(`BACKTEST_READINESS_DESCRIPTOR_MISMATCH:${entry.strategyKey}`);
    }
    if (entry.minimumClosedBars < 1 || entry.baselineOracleTargets.length === 0) {
      throw new Error(`BACKTEST_READINESS_EVIDENCE_INCOMPLETE:${entry.strategyKey}`);
    }
  }
}

assertBacktestReadinessMatrixIntegrity();
