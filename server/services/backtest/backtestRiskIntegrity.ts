import type { ExecutionPolicy } from "../../../shared/executionModes";
import type {
  BacktestAccountingSnapshot,
  BacktestLegAccounting,
  BacktestModeResults,
} from "./backtestContracts";
import type { EquityPoint, TradeRecord } from "./performanceCalculator";

export const BACKTEST_RISK_INTEGRITY_VERSION = "backtest-risk-integrity-v1" as const;

export type BacktestRiskEnforcement = "RUNTIME_KERNEL" | "POSTHOC_ONLY";

export type BacktestRiskIntegrityViolationCode =
  | "NON_FINITE_EQUITY_POINT"
  | "EQUITY_BELOW_ZERO"
  | "BANKRUPTCY_STATE_MISSING"
  | "POST_INSOLVENCY_RECOVERY"
  | "BANKRUPTCY_EQUITY_EVIDENCE_MISSING"
  | "BANKRUPT_RESULT_RECOVERED"
  | "GROSS_NOTIONAL_POLICY_BREACH"
  | "MARGIN_USAGE_POLICY_BREACH";

export interface BacktestRiskIntegrityViolation {
  code: BacktestRiskIntegrityViolationCode;
  message: string;
  timestamp?: number;
  actual?: number;
  limit?: number;
}

export interface BacktestRiskIntegrityAssessment {
  version: typeof BACKTEST_RISK_INTEGRITY_VERSION;
  passed: boolean;
  enforcement: BacktestRiskEnforcement;
  validEquityPointCount: number;
  invalidEquityPointCount: number;
  globalPositiveEquityPeak: number;
  minimumEquity: number;
  minimumEquityTimestamp: number | null;
  firstNonPositiveEquityTimestamp: number | null;
  recoveredAfterInsolvency: boolean;
  bankruptcyDeclared: boolean;
  marginLiquidationCount: number;
  observedEntryNotionalPeak: number;
  grossNotionalLimitAtGlobalPeak: number;
  observedEntryMarginPeak: number;
  marginLimitAtGlobalPeak: number;
  violations: BacktestRiskIntegrityViolation[];
}

export interface BacktestRiskIntegrityInput {
  runId: string;
  strategyKey: string;
  initialCapital: number;
  leverage: number;
  executionPolicy: ExecutionPolicy;
  trades: Pick<TradeRecord, "entryPrice" | "size">[];
  equityCurve: Pick<EquityPoint, "timestamp" | "equity">[];
  accounting?: BacktestAccountingSnapshot;
  legAccounting?: BacktestLegAccounting;
  modeResults?: BacktestModeResults;
  hasRuntimeRiskEvidence: boolean;
}

export class BacktestRiskIntegrityGuardError extends Error {
  readonly code = "BACKTEST_RISK_INTEGRITY_VIOLATION" as const;

  constructor(
    readonly runId: string,
    readonly strategyKey: string,
    readonly assessment: BacktestRiskIntegrityAssessment,
  ) {
    const codes = assessment.violations.map((violation) => violation.code).join(",");
    super(
      `${strategyKey} 回測違反有限責任／執行風險契約，結果已拒絕發布（${codes}）`,
    );
    this.name = "BacktestRiskIntegrityGuardError";
  }
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function assessBacktestRiskIntegrity(
  input: BacktestRiskIntegrityInput,
): BacktestRiskIntegrityAssessment {
  const violations: BacktestRiskIntegrityViolation[] = [];
  const validEquityCurve = input.equityCurve.filter(
    (point) => Number.isFinite(point.timestamp) && Number.isFinite(point.equity),
  );
  const invalidEquityPointCount = input.equityCurve.length - validEquityCurve.length;
  if (invalidEquityPointCount > 0) {
    violations.push({
      code: "NON_FINITE_EQUITY_POINT",
      message: `權益曲線包含 ${invalidEquityPointCount} 個非有限數值點`,
      actual: invalidEquityPointCount,
      limit: 0,
    });
  }

  const globalPositiveEquityPeak = Math.max(
    finiteNonNegative(input.initialCapital),
    ...validEquityCurve.map((point) => finiteNonNegative(point.equity)),
  );
  const minimumPoint = validEquityCurve.reduce<(typeof validEquityCurve)[number] | null>(
    (minimum, point) => (!minimum || point.equity < minimum.equity ? point : minimum),
    null,
  );
  const minimumEquity = minimumPoint?.equity ?? input.initialCapital;
  const firstNonPositiveIndex = validEquityCurve.findIndex((point) => point.equity <= 0);
  const firstNonPositivePoint = firstNonPositiveIndex >= 0
    ? validEquityCurve[firstNonPositiveIndex]
    : null;
  const recoveredAfterInsolvency = firstNonPositiveIndex >= 0
    && validEquityCurve
      .slice(firstNonPositiveIndex + 1)
      .some((point) => point.equity > 0.02);
  const bankruptcyDeclared = Boolean(
    input.accounting?.bankrupt
      || input.legAccounting?.bankrupt
      || input.modeResults?.bankrupt,
  );
  const marginLiquidationCount = Math.max(
    finiteNonNegative(input.accounting?.marginLiquidationCount),
    finiteNonNegative(input.legAccounting?.marginLiquidationCount),
    finiteNonNegative(input.modeResults?.marginLiquidationCount),
  );

  if (minimumEquity < -0.02) {
    violations.push({
      code: "EQUITY_BELOW_ZERO",
      message: "有限責任回測的權益不得低於 0",
      timestamp: minimumPoint?.timestamp,
      actual: minimumEquity,
      limit: 0,
    });
  }
  if (firstNonPositivePoint && !bankruptcyDeclared) {
    violations.push({
      code: "BANKRUPTCY_STATE_MISSING",
      message: "權益耗盡但 accounting／legAccounting 未宣告 bankrupt",
      timestamp: firstNonPositivePoint.timestamp,
      actual: firstNonPositivePoint.equity,
      limit: 0,
    });
  }
  if (recoveredAfterInsolvency) {
    violations.push({
      code: "POST_INSOLVENCY_RECOVERY",
      message: "權益耗盡後仍恢復正值，表示模擬器在破產後繼續交易或保留未清算部位",
      timestamp: firstNonPositivePoint?.timestamp,
    });
  }
  if (bankruptcyDeclared && !firstNonPositivePoint) {
    violations.push({
      code: "BANKRUPTCY_EQUITY_EVIDENCE_MISSING",
      message: "結果宣告 bankrupt，但權益曲線沒有 0 權益證據",
    });
  }
  const finalEquity = validEquityCurve.at(-1)?.equity ?? input.initialCapital;
  if (bankruptcyDeclared && finalEquity > 0.02) {
    violations.push({
      code: "BANKRUPT_RESULT_RECOVERED",
      message: "bankrupt 結果的最終權益不得恢復為正值",
      actual: finalEquity,
      limit: 0,
    });
  }

  const observedClosedEntryNotionalPeak = Math.max(
    0,
    ...input.trades.map((trade) => Math.abs(trade.entryPrice * trade.size)),
  );
  const observedOpenEntryNotionalPeak = Math.max(
    0,
    ...(input.accounting?.openPositions ?? (input.accounting?.openPosition
      ? [input.accounting.openPosition]
      : [])).map((position) => Math.abs(position.entryNotional)),
  );
  const observedEntryNotionalPeak = Math.max(
    observedClosedEntryNotionalPeak,
    observedOpenEntryNotionalPeak,
  );
  const grossNotionalLimitAtGlobalPeak = globalPositiveEquityPeak
    * finiteNonNegative(input.executionPolicy.riskBudget.maxGrossNotionalPct)
    / 100;
  const leverage = Math.max(1, finiteNonNegative(input.leverage, 1));
  const observedEntryMarginPeak = observedEntryNotionalPeak / leverage;
  const marginLimitAtGlobalPeak = globalPositiveEquityPeak
    * finiteNonNegative(input.executionPolicy.riskBudget.maxMarginUsagePct)
    / 100;

  // 全期間最高正權益是任何下單當下權益的寬鬆上界；連此上界都超過，必然是訂單准入違約。
  // 只對 S1 套用此保守後驗判定；M2／H3 的重疊腿由 runtime portfolio kernel 逐事件稽核。
  if (input.executionPolicy.mode === "SINGLE_EXCLUSIVE") {
    if (observedEntryNotionalPeak > grossNotionalLimitAtGlobalPeak + 0.02) {
      violations.push({
        code: "GROSS_NOTIONAL_POLICY_BREACH",
        message: "S1 成交名義本金即使以全期間最高權益計算仍超過 executionPolicy 上限",
        actual: observedEntryNotionalPeak,
        limit: grossNotionalLimitAtGlobalPeak,
      });
    }
    if (observedEntryMarginPeak > marginLimitAtGlobalPeak + 0.02) {
      violations.push({
        code: "MARGIN_USAGE_POLICY_BREACH",
        message: "S1 成交保證金即使以全期間最高權益計算仍超過 executionPolicy 上限",
        actual: observedEntryMarginPeak,
        limit: marginLimitAtGlobalPeak,
      });
    }
  }

  return {
    version: BACKTEST_RISK_INTEGRITY_VERSION,
    passed: violations.length === 0,
    enforcement: input.hasRuntimeRiskEvidence ? "RUNTIME_KERNEL" : "POSTHOC_ONLY",
    validEquityPointCount: validEquityCurve.length,
    invalidEquityPointCount,
    globalPositiveEquityPeak,
    minimumEquity,
    minimumEquityTimestamp: minimumPoint?.timestamp ?? null,
    firstNonPositiveEquityTimestamp: firstNonPositivePoint?.timestamp ?? null,
    recoveredAfterInsolvency,
    bankruptcyDeclared,
    marginLiquidationCount,
    observedEntryNotionalPeak,
    grossNotionalLimitAtGlobalPeak,
    observedEntryMarginPeak,
    marginLimitAtGlobalPeak,
    violations,
  };
}

export function assertBacktestRiskIntegrity(
  input: BacktestRiskIntegrityInput,
): BacktestRiskIntegrityAssessment {
  const assessment = assessBacktestRiskIntegrity(input);
  if (!assessment.passed) {
    throw new BacktestRiskIntegrityGuardError(
      input.runId,
      input.strategyKey,
      assessment,
    );
  }
  return assessment;
}
