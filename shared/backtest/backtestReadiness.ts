import type { ExecutionMode } from "../executionModes";

export const BACKTEST_READINESS_CONTRACT_VERSION = "backtest-readiness-v1" as const;

export type BacktestReadinessState = "READY" | "BLOCKED";
export type BacktestReadinessConfidence = "HIGH" | "MEDIUM" | "LOW";
export type BacktestRiskLevel = "STANDARD" | "HIGH" | "CRITICAL";
export type BacktestLogicParity = "SHARED_CORE" | "WRAPPED_SHARED_CORE" | "FORK_RISK";

export type BacktestReadinessReasonCode =
  | "READY"
  | "BACKTEST_STRATEGY_NOT_AUDITED"
  | "BACKTEST_STRATEGY_NOT_READY"
  | "BACKTEST_MODE_NOT_CERTIFIED"
  | "BACKTEST_TIMEFRAME_NOT_SUPPORTED"
  | "BACKTEST_DATA_EMPTY"
  | "BACKTEST_DATA_INSUFFICIENT"
  | "BACKTEST_DATA_NOT_SORTED"
  | "BACKTEST_DATA_REJECTION_RATIO_EXCEEDED"
  | "BACKTEST_DUPLICATE_RATIO_EXCEEDED"
  | "BACKTEST_DATA_GAP_RATIO_EXCEEDED";

export const BACKTEST_READINESS_REASON_TEXT_ZH_TW: Readonly<Record<BacktestReadinessReasonCode, string>> = Object.freeze({
  READY: "已通過回測準備度預檢",
  BACKTEST_STRATEGY_NOT_AUDITED: "策略尚未納入權威回測準備度稽核",
  BACKTEST_STRATEGY_NOT_READY: "策略目前未取得可執行的回測認證",
  BACKTEST_MODE_NOT_CERTIFIED: "所選執行模式未取得此策略的回測認證",
  BACKTEST_TIMEFRAME_NOT_SUPPORTED: "所選時間框架不在此策略的支援範圍",
  BACKTEST_DATA_EMPTY: "指定區間沒有可用的已收盤 K 線",
  BACKTEST_DATA_INSUFFICIENT: "有效已收盤 K 線少於策略最低需求",
  BACKTEST_DATA_NOT_SORTED: "K 線時間戳未依嚴格遞增順序排列",
  BACKTEST_DATA_REJECTION_RATIO_EXCEEDED: "無效、越界或未收盤 K 線的拒收比例超過 1%",
  BACKTEST_DUPLICATE_RATIO_EXCEEDED: "重複時間戳比例超過 5%",
  BACKTEST_DATA_GAP_RATIO_EXCEEDED: "K 線時間缺口比例超過 5%",
});

export function describeBacktestReadinessReason(code: BacktestReadinessReasonCode): string {
  return BACKTEST_READINESS_REASON_TEXT_ZH_TW[code];
}

export interface BacktestStrategyReadinessEntry {
  contractVersion: typeof BACKTEST_READINESS_CONTRACT_VERSION;
  strategyKey: string;
  displayName: string;
  readiness: BacktestReadinessState;
  certification: "CERTIFIED" | "BLOCKED";
  certificationReason: string;
  confidence: BacktestReadinessConfidence;
  riskLevel: BacktestRiskLevel;
  supportedModes: ExecutionMode[];
  allowedTimeframes: string[];
  recommendedTimeframes: string[];
  minimumClosedBars: number;
  dataRequirements: string[];
  logicParity: BacktestLogicParity;
  logicAssessment: string;
  canonicalConfigPath: string;
  liveLogicPath: string;
  backtestLogicPath: string;
  registrationEvidence: string[];
  outputCapabilities: string[];
  baselineOracleTargets: string[];
  highRiskOracleTargets: string[];
  auditNotes: string[];
}

export interface BacktestAdmissionAssessment {
  allowed: boolean;
  reasonCodes: BacktestReadinessReasonCode[];
  warnings: string[];
  requestedTimeframe: string;
  executionMode: ExecutionMode;
  effectiveMinimumClosedBars: number;
  readiness: BacktestStrategyReadinessEntry | null;
}

export interface BacktestDataQualityAssessment {
  passed: boolean;
  reasonCodes: BacktestReadinessReasonCode[];
  warnings: string[];
  minimumClosedBars: number;
  returnedCandles: number;
  rejectionRatio: number;
  duplicateRatio: number;
  gapCount: number;
  gapRatio: number;
}
