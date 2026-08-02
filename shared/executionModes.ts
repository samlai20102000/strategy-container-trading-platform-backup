/**
 * 三模式執行契約的單一真相。
 *
 * 策略只負責產生 CandidateIntent；平台依此 policy 決定是否建立／增加／減少指定 leg。
 * 所有新部署預設 disabled，任何 capability 不明或過期時 fail closed。
 */
export const EXECUTION_POLICY_VERSION = "execution-policy-v1" as const;

export const EXECUTION_MODES = [
  "SINGLE_EXCLUSIVE",
  "MULTI_POSITION",
  "HEDGE_GUARDED",
] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type PositionSide = "LONG" | "SHORT";
export type PositionLegRole = "PRIMARY" | "INDEPENDENT" | "HEDGE";
export type DeploymentActivationState =
  | "LEGACY"
  | "DRAFT"
  | "DISABLED"
  | "PREFLIGHT_FAILED"
  | "READY_DISABLED"
  | "ARMED"
  | "ACTIVE"
  | "PAUSED"
  | "DRAINING"
  | "BLOCKED"
  | "ARCHIVED";

export interface ExecutionRiskBudget {
  /** 單一部署最大 gross notional 佔可用權益百分比。 */
  maxGrossNotionalPct: number;
  /** 單一部署最大預估 margin 佔可用權益百分比。 */
  maxMarginUsagePct: number;
  /** 帳戶風險資料超過此秒數即禁止開新曝險。 */
  capabilityTtlSeconds: number;
}

export interface BaseExecutionPolicy {
  version: typeof EXECUTION_POLICY_VERSION;
  mode: ExecutionMode;
  riskBudget: ExecutionRiskBudget;
  /** 交易所能力不明、過期或不相容時禁止增加曝險。 */
  failClosedOnCapabilityStale: true;
  /** 模式只能在 flat/drained Gate 後切換。 */
  requireFlatForModeChange: true;
}

export interface SingleExclusivePolicy extends BaseExecutionPolicy {
  mode: "SINGLE_EXCLUSIVE";
  maxOpenLegs: 1;
  oppositeSignalPolicy: "CLOSE_THEN_WAIT" | "CLOSE_THEN_REVERSE" | "IGNORE";
}

export interface MultiPositionPolicy extends BaseExecutionPolicy {
  mode: "MULTI_POSITION";
  maxOpenLegs: 2;
  allowOneLegPerSide: true;
  isolateMartinByLeg: true;
  isolateExitByLeg: true;
  oppositeSignalPolicy: "OPEN_INDEPENDENT_LEG";
}

export interface HedgeGuardedPolicy extends BaseExecutionPolicy {
  mode: "HEDGE_GUARDED";
  maxOpenLegs: 2;
  primaryLossTriggerPct: number;
  /** true=必須有反向策略訊號；false=可由策略風控自動產生反向保護候選。 */
  requireOppositeSignal: boolean;
  hedgeRatio: number;
  maxHedgeRatio: number;
  hedgeCooldownSeconds: number;
  minimumHedgeHoldSeconds: number;
  hedgeMartinEnabled: boolean;
  unwindPolicy: "CLOSE_LOSER_KEEP_WINNER" | "CLOSE_HEDGE_ON_RECOVERY";
  allowHedgePromotion: boolean;
}

export type ExecutionPolicy =
  | SingleExclusivePolicy
  | MultiPositionPolicy
  | HedgeGuardedPolicy;

export interface StrategyModeCapabilities {
  contractVersion: "strategy-mode-capabilities-v1";
  supportedModes: ExecutionMode[];
  martingaleLayers: boolean;
  independentLegState: boolean;
  hedgeGuard: boolean;
  preciseLegClose: boolean;
  reason?: string;
}

export type CandidateIntentAction =
  | "OPEN_LONG"
  | "OPEN_SHORT"
  | "ADD_LONG"
  | "ADD_SHORT"
  | "REDUCE_LONG"
  | "REDUCE_SHORT"
  | "CLOSE_LONG"
  | "CLOSE_SHORT"
  | "CLOSE_ALL"
  | "HOLD";

export interface CandidateIntent {
  candidateId: string;
  deploymentId: number;
  action: CandidateIntentAction;
  side?: PositionSide;
  /**
   * 策略語義要求的腿角色；僅為輸入證據，最終角色仍由 mode engine 驗證與核准。
   * 未提供時維持既有通用三模式行為。
   */
  roleHint?: PositionLegRole;
  requestedQuantity?: number;
  signalPrice?: number;
  barTimestamp?: number;
  source: "WEBHOOK" | "AUTO" | "MANUAL" | "RISK" | "RECONCILIATION";
  reasonCode: string;
  reason: string;
  createdAt: number;
}

export type ModeDecisionOutcome =
  | "APPROVED"
  | "HOLD"
  | "REJECTED"
  | "CLOSE_ONLY"
  | "RECONCILIATION_REQUIRED";

export interface ModeDecision {
  decisionId: string;
  candidateId: string;
  deploymentId: number;
  executionMode: ExecutionMode;
  outcome: ModeDecisionOutcome;
  reasonCode: string;
  targetLegId?: string;
  targetSide?: PositionSide;
  targetRole?: PositionLegRole;
  approvedQuantity?: number;
  reduceOnly?: boolean;
  contextSnapshot: Record<string, unknown>;
  createdAt: number;
}

export interface ExchangeExecutionCapabilities {
  contractVersion: "exchange-execution-capabilities-v1";
  exchange: "okx" | "bybit";
  apiKeyId: number;
  symbol: string;
  accountPositionMode: "NET" | "LONG_SHORT" | "ONE_WAY" | "HEDGE" | "UNKNOWN";
  supportsIndependentLongShort: boolean;
  supportsPositionSide: boolean;
  supportsReduceOnly: boolean;
  supportsClientOrderId: boolean;
  canPreciselyCloseLeg: boolean;
  capturedAt: number;
  expiresAt: number;
  blockerCodes: string[];
}

export const EXECUTION_MODE_META: Readonly<
  Record<ExecutionMode, { code: "S1" | "M2" | "H3"; label: string; description: string }>
> = Object.freeze({
  SINGLE_EXCLUSIVE: {
    code: "S1",
    label: "單倉模式",
    description: "同一部署同一時間只允許一個方向腿。",
  },
  MULTI_POSITION: {
    code: "M2",
    label: "雙向獨立",
    description: "同一部署最多同時保有一個 LONG 與一個 SHORT，風控與馬丁完全隔離。",
  },
  HEDGE_GUARDED: {
    code: "H3",
    label: "保護對沖",
    description: "主腿達浮虧門檻且出現反向信號後，才建立受限保護腿。",
  },
});

const DEFAULT_RISK_BUDGET: ExecutionRiskBudget = Object.freeze({
  maxGrossNotionalPct: 100,
  maxMarginUsagePct: 40,
  capabilityTtlSeconds: 60,
});

export function createDefaultExecutionPolicy(mode: ExecutionMode): ExecutionPolicy {
  const base = {
    version: EXECUTION_POLICY_VERSION,
    riskBudget: { ...DEFAULT_RISK_BUDGET },
    failClosedOnCapabilityStale: true as const,
    requireFlatForModeChange: true as const,
  };

  if (mode === "MULTI_POSITION") {
    return {
      ...base,
      mode,
      maxOpenLegs: 2,
      allowOneLegPerSide: true,
      isolateMartinByLeg: true,
      isolateExitByLeg: true,
      oppositeSignalPolicy: "OPEN_INDEPENDENT_LEG",
    };
  }

  if (mode === "HEDGE_GUARDED") {
    return {
      ...base,
      mode,
      maxOpenLegs: 2,
      primaryLossTriggerPct: 5,
      requireOppositeSignal: true,
      hedgeRatio: 0.5,
      maxHedgeRatio: 1,
      hedgeCooldownSeconds: 300,
      minimumHedgeHoldSeconds: 60,
      hedgeMartinEnabled: false,
      unwindPolicy: "CLOSE_LOSER_KEEP_WINNER",
      allowHedgePromotion: false,
    };
  }

  return {
    ...base,
    mode: "SINGLE_EXCLUSIVE",
    maxOpenLegs: 1,
    oppositeSignalPolicy: "CLOSE_THEN_WAIT",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

/**
 * 將資料庫、快照或 UI 傳入的未知 policy 正規化為可安全執行的 canonical policy。
 * H3 的雙條件與保護腿馬丁禁止規則不可被外部 payload 覆蓋。
 */
export function normalizeExecutionModePolicy(input: unknown): ExecutionPolicy {
  const raw = asRecord(input);
  const mode = isExecutionMode(raw.mode) ? raw.mode : "SINGLE_EXCLUSIVE";
  const defaults = createDefaultExecutionPolicy(mode);
  const rawRiskBudget = asRecord(raw.riskBudget);
  const riskBudget: ExecutionRiskBudget = {
    maxGrossNotionalPct: clampNumber(
      rawRiskBudget.maxGrossNotionalPct,
      defaults.riskBudget.maxGrossNotionalPct,
      1,
      500,
    ),
    maxMarginUsagePct: clampNumber(
      rawRiskBudget.maxMarginUsagePct,
      defaults.riskBudget.maxMarginUsagePct,
      1,
      100,
    ),
    capabilityTtlSeconds: clampNumber(
      rawRiskBudget.capabilityTtlSeconds,
      defaults.riskBudget.capabilityTtlSeconds,
      15,
      3_600,
    ),
  };

  if (mode === "MULTI_POSITION") {
    return {
      ...defaults,
      mode,
      riskBudget,
      maxOpenLegs: 2,
      allowOneLegPerSide: true,
      isolateMartinByLeg: true,
      isolateExitByLeg: true,
      oppositeSignalPolicy: "OPEN_INDEPENDENT_LEG",
    };
  }

  if (mode === "HEDGE_GUARDED") {
    const h3Defaults = defaults as HedgeGuardedPolicy;
    const maxHedgeRatio = clampNumber(raw.maxHedgeRatio, h3Defaults.maxHedgeRatio, 0.01, 1);
    const hedgeRatio = Math.min(
      maxHedgeRatio,
      clampNumber(raw.hedgeRatio, h3Defaults.hedgeRatio, 0.01, 1),
    );
    const unwindPolicy =
      raw.unwindPolicy === "CLOSE_HEDGE_ON_RECOVERY"
        ? "CLOSE_HEDGE_ON_RECOVERY"
        : "CLOSE_LOSER_KEEP_WINNER";

    return {
      ...h3Defaults,
      riskBudget,
      primaryLossTriggerPct: clampNumber(
        raw.primaryLossTriggerPct,
        h3Defaults.primaryLossTriggerPct,
        0.1,
        100,
      ),
      requireOppositeSignal: true,
      hedgeRatio,
      maxHedgeRatio,
      hedgeCooldownSeconds: clampNumber(
        raw.hedgeCooldownSeconds,
        h3Defaults.hedgeCooldownSeconds,
        0,
        86_400,
      ),
      minimumHedgeHoldSeconds: clampNumber(
        raw.minimumHedgeHoldSeconds,
        h3Defaults.minimumHedgeHoldSeconds,
        0,
        86_400,
      ),
      hedgeMartinEnabled: false,
      unwindPolicy,
      allowHedgePromotion: raw.allowHedgePromotion === true,
    };
  }

  const s1Defaults = defaults as SingleExclusivePolicy;
  const oppositeSignalPolicy =
    raw.oppositeSignalPolicy === "CLOSE_THEN_REVERSE" || raw.oppositeSignalPolicy === "IGNORE"
      ? raw.oppositeSignalPolicy
      : "CLOSE_THEN_WAIT";
  return {
    ...s1Defaults,
    riskBudget,
    oppositeSignalPolicy,
  };
}

export const DEFAULT_EXECUTION_POLICIES: Readonly<Record<ExecutionMode, ExecutionPolicy>> =
  Object.freeze({
    SINGLE_EXCLUSIVE: createDefaultExecutionPolicy("SINGLE_EXCLUSIVE"),
    MULTI_POSITION: createDefaultExecutionPolicy("MULTI_POSITION"),
    HEDGE_GUARDED: createDefaultExecutionPolicy("HEDGE_GUARDED"),
  });

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === "string" && (EXECUTION_MODES as readonly string[]).includes(value);
}

export function getSupportedModeCapabilities(input?: Partial<StrategyModeCapabilities>): StrategyModeCapabilities {
  const supportedModes = input?.supportedModes?.filter(isExecutionMode) ?? ["SINGLE_EXCLUSIVE"];
  return {
    contractVersion: "strategy-mode-capabilities-v1",
    supportedModes:
      supportedModes.length > 0 ? Array.from(new Set(supportedModes)) : ["SINGLE_EXCLUSIVE"],
    martingaleLayers: input?.martingaleLayers === true,
    independentLegState: input?.independentLegState === true,
    hedgeGuard: input?.hedgeGuard === true,
    preciseLegClose: input?.preciseLegClose === true,
    reason: input?.reason,
  };
}
