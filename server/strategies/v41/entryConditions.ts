import {
  V41_CONFIG_VERSION,
  V41_STRATEGY_KEY,
  getV41ConfigHash,
  hasV41ContinuousDirectionCondition,
  validateV41Config,
  type NormalizedV41Config,
  type V41EntryConditionLogic,
  type V41ThreeKMode,
} from "../../../shared/strategies/kama3kMartinV41";

export type V41EntryDirection = "long" | "short";
export type V41AllowedDirection = "both" | V41EntryDirection;
export type V41ConditionId = "three_k" | "kama_fast_slow" | "price_vs_slow";
export type V41VoteStatus = "disabled" | V41EntryDirection | "no_signal" | "data_unavailable";

export type V41ReasonCode =
  | "V41_ENTRY_OPEN"
  | "V41_INVALID_CONFIG"
  | "V41_NO_ENTRY_CONDITION_ENABLED"
  | "V41_INVALID_ENTRY_LOGIC"
  | "V41_THREE_K_NO_PATTERN"
  | "V41_FAST_SLOW_EQUAL"
  | "V41_PRICE_EQUALS_SLOW"
  | "V41_BAR_DATA_UNAVAILABLE"
  | "V41_KAMA_DATA_UNAVAILABLE"
  | "V41_PRICE_DATA_UNAVAILABLE"
  | "V41_AND_WAITING_FOR_ALL"
  | "V41_DIRECTION_CONFLICT"
  | "V41_OR_NO_DIRECTION"
  | "V41_DIRECTION_NOT_ALLOWED"
  | "V41_REQUEST_DIRECTION_MISMATCH"
  | "V41_REENTRY_DISABLED"
  | "V41_REENTRY_REQUIRES_CONTINUOUS_CONDITION"
  | "V41_REENTRY_DIRECTION_NOT_SUPPORTED";

export interface V41ClosedBar {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp?: number;
}

export interface V41ConditionVote {
  condition: V41ConditionId;
  enabled: boolean;
  status: V41VoteStatus;
  reasonCode: V41ReasonCode;
  description: string;
  values: Record<string, number | string | null>;
}

export interface V41EntryEvaluationInput {
  config: unknown;
  closedBars: readonly V41ClosedBar[];
  decisionBarTimestamp: number;
  decisionClose: number | null;
  fastKama: number | null;
  slowKama: number | null;
  allowedDirection: V41AllowedDirection;
  /** Webhook／auto 已提出方向時，只在三票完成合併後作為一致性約束。 */
  requestedDirection?: V41EntryDirection | null;
}

export interface V41EntryEvaluationResult {
  decision: "open" | "hold";
  passed: boolean;
  direction: V41EntryDirection | null;
  primaryReasonCode: V41ReasonCode;
  reason: string;
  votes: V41ConditionVote[];
  enabledConditionCount: number;
  entryConditionLogic: V41EntryConditionLogic | null;
  strategyKey: typeof V41_STRATEGY_KEY;
  configVersion: typeof V41_CONFIG_VERSION;
  configHash: string | null;
  decisionBarTimestamp: number;
  decisionClose: number | null;
  fastKama: number | null;
  slowKama: number | null;
}

export interface V41ReentryEvaluationResult {
  allowed: boolean;
  reasonCode: V41ReasonCode;
  reason: string;
  direction: V41EntryDirection;
  continuousDecision: V41EntryEvaluationResult | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteBar(bar: V41ClosedBar | undefined): bar is V41ClosedBar {
  return Boolean(bar)
    && isFiniteNumber(bar?.open)
    && isFiniteNumber(bar?.high)
    && isFiniteNumber(bar?.low)
    && isFiniteNumber(bar?.close);
}

function disabledVote(condition: V41ConditionId): V41ConditionVote {
  return {
    condition,
    enabled: false,
    status: "disabled",
    reasonCode: "V41_INVALID_CONFIG",
    description: "條件未啟用，不參與方向合併",
    values: {},
  };
}

function resolveThreeKDirection(
  bars: readonly V41ClosedBar[],
  mode: V41ThreeKMode,
): V41EntryDirection | null {
  const [k1, k2, k3] = bars.slice(-3);
  if (!k1 || !k2 || !k3) return null;

  if (mode === "three_body_same_direction") {
    if (k1.close > k1.open && k2.close > k2.open && k3.close > k3.open) return "long";
    if (k1.close < k1.open && k2.close < k2.open && k3.close < k3.open) return "short";
    return null;
  }

  const longBreakout = k1.close > k1.open
    && k2.close > k2.open
    && k3.close >= Math.max(k1.high, k2.high);
  const shortBreakout = k1.close < k1.open
    && k2.close < k2.open
    && k3.close <= Math.min(k1.low, k2.low);
  if (longBreakout) return "long";
  if (shortBreakout) return "short";
  return null;
}

function evaluateThreeK(
  config: NormalizedV41Config,
  closedBars: readonly V41ClosedBar[],
): V41ConditionVote {
  if (!config.enableThreeKFilter) return disabledVote("three_k");
  const lastThree = closedBars.slice(-3);
  if (lastThree.length < 3 || !lastThree.every(isFiniteBar)) {
    return {
      condition: "three_k",
      enabled: true,
      status: "data_unavailable",
      reasonCode: "V41_BAR_DATA_UNAVAILABLE",
      description: "三 K 條件需要三根完整且已收盤的 K 棒",
      values: { availableBars: lastThree.filter(isFiniteBar).length, mode: config.threeKMode },
    };
  }
  const direction = resolveThreeKDirection(lastThree, config.threeKMode);
  if (!direction) {
    return {
      condition: "three_k",
      enabled: true,
      status: "no_signal",
      reasonCode: "V41_THREE_K_NO_PATTERN",
      description: config.threeKMode === "breakout"
        ? "前兩根同向，但第三根收盤尚未完成突破／跌破"
        : "三根 K 棒實體尚未全部連續同向",
      values: { mode: config.threeKMode },
    };
  }
  return {
    condition: "three_k",
    enabled: true,
    status: direction,
    reasonCode: "V41_ENTRY_OPEN",
    description: direction === "long" ? "三 K 形態投出做多票" : "三 K 形態投出做空票",
    values: { mode: config.threeKMode },
  };
}

function evaluateFastSlow(
  config: NormalizedV41Config,
  fastKama: number | null,
  slowKama: number | null,
): V41ConditionVote {
  if (!config.enableKamaFastSlowCross) return disabledVote("kama_fast_slow");
  if (!isFiniteNumber(fastKama) || !isFiniteNumber(slowKama)) {
    return {
      condition: "kama_fast_slow",
      enabled: true,
      status: "data_unavailable",
      reasonCode: "V41_KAMA_DATA_UNAVAILABLE",
      description: "Fast 或 Slow KAMA 尚未完成暖機，或數值無效",
      values: { fastKama, slowKama },
    };
  }
  if (fastKama === slowKama) {
    return {
      condition: "kama_fast_slow",
      enabled: true,
      status: "no_signal",
      reasonCode: "V41_FAST_SLOW_EQUAL",
      description: "Fast 與 Slow KAMA 相等，沒有方向",
      values: { fastKama, slowKama },
    };
  }
  const direction = fastKama > slowKama ? "long" : "short";
  return {
    condition: "kama_fast_slow",
    enabled: true,
    status: direction,
    reasonCode: "V41_ENTRY_OPEN",
    description: direction === "long" ? "Fast KAMA 高於 Slow KAMA" : "Fast KAMA 低於 Slow KAMA",
    values: { fastKama, slowKama },
  };
}

function evaluatePriceSlow(
  config: NormalizedV41Config,
  decisionClose: number | null,
  slowKama: number | null,
): V41ConditionVote {
  if (!config.enableKamaPriceVsSlow) return disabledVote("price_vs_slow");
  if (!isFiniteNumber(decisionClose)) {
    return {
      condition: "price_vs_slow",
      enabled: true,
      status: "data_unavailable",
      reasonCode: "V41_PRICE_DATA_UNAVAILABLE",
      description: "最新已收盤決策 K 的 close 不可用",
      values: { decisionClose, slowKama },
    };
  }
  if (!isFiniteNumber(slowKama)) {
    return {
      condition: "price_vs_slow",
      enabled: true,
      status: "data_unavailable",
      reasonCode: "V41_KAMA_DATA_UNAVAILABLE",
      description: "Slow KAMA 尚未完成暖機，或數值無效",
      values: { decisionClose, slowKama },
    };
  }
  if (decisionClose === slowKama) {
    return {
      condition: "price_vs_slow",
      enabled: true,
      status: "no_signal",
      reasonCode: "V41_PRICE_EQUALS_SLOW",
      description: "決策 K 收盤價等於 Slow KAMA，沒有方向",
      values: { decisionClose, slowKama },
    };
  }
  const direction = decisionClose > slowKama ? "long" : "short";
  return {
    condition: "price_vs_slow",
    enabled: true,
    status: direction,
    reasonCode: "V41_ENTRY_OPEN",
    description: direction === "long" ? "決策 K 收盤價高於 Slow KAMA" : "決策 K 收盤價低於 Slow KAMA",
    values: { decisionClose, slowKama },
  };
}

function buildHold(
  input: V41EntryEvaluationInput,
  reasonCode: V41ReasonCode,
  reason: string,
  votes: V41ConditionVote[],
  config: NormalizedV41Config | null,
): V41EntryEvaluationResult {
  return {
    decision: "hold",
    passed: false,
    direction: null,
    primaryReasonCode: reasonCode,
    reason,
    votes,
    enabledConditionCount: votes.filter((vote) => vote.enabled).length,
    entryConditionLogic: config?.entryConditionLogic ?? null,
    strategyKey: V41_STRATEGY_KEY,
    configVersion: V41_CONFIG_VERSION,
    configHash: config ? getV41ConfigHash(config) : null,
    decisionBarTimestamp: input.decisionBarTimestamp,
    decisionClose: input.decisionClose,
    fastKama: input.fastKama,
    slowKama: input.slowKama,
  };
}

function resolveConfigReason(raw: unknown, issues: readonly { path: string; message: string }[]): V41ReasonCode {
  if (issues.some((issue) => issue.message.includes("V41_NO_ENTRY_CONDITION_ENABLED"))) {
    return "V41_NO_ENTRY_CONDITION_ENABLED";
  }
  const logic = typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>).entryConditionLogic
    : undefined;
  return logic !== "and" && logic !== "or" ? "V41_INVALID_ENTRY_LOGIC" : "V41_INVALID_CONFIG";
}

export function evaluateV41EntryConditions(
  input: V41EntryEvaluationInput,
): V41EntryEvaluationResult {
  const validation = validateV41Config(input.config);
  if (!validation.valid || !validation.config) {
    const reasonCode = resolveConfigReason(input.config, validation.issues);
    return buildHold(
      input,
      reasonCode,
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；") || "V4.1 配置無效",
      [],
      null,
    );
  }

  const config = validation.config;
  const votes = [
    evaluateThreeK(config, input.closedBars),
    evaluateFastSlow(config, input.fastKama, input.slowKama),
    evaluatePriceSlow(config, input.decisionClose, input.slowKama),
  ];
  const enabledVotes = votes.filter((vote) => vote.enabled);
  const unavailable = enabledVotes.find((vote) => vote.status === "data_unavailable");
  if (unavailable) {
    return buildHold(input, unavailable.reasonCode, unavailable.description, votes, config);
  }

  const hasLong = enabledVotes.some((vote) => vote.status === "long");
  const hasShort = enabledVotes.some((vote) => vote.status === "short");
  if (hasLong && hasShort) {
    return buildHold(
      input,
      "V41_DIRECTION_CONFLICT",
      "已啟用條件同時投出做多與做空票，安全保持 HOLD",
      votes,
      config,
    );
  }

  let direction: V41EntryDirection | null = null;
  if (config.entryConditionLogic === "and") {
    const allLong = enabledVotes.every((vote) => vote.status === "long");
    const allShort = enabledVotes.every((vote) => vote.status === "short");
    if (allLong) direction = "long";
    else if (allShort) direction = "short";
    else {
      return buildHold(
        input,
        "V41_AND_WAITING_FOR_ALL",
        "AND 模式要求所有已啟用條件均有訊號且方向一致",
        votes,
        config,
      );
    }
  } else {
    if (hasLong) direction = "long";
    else if (hasShort) direction = "short";
    else {
      return buildHold(
        input,
        "V41_OR_NO_DIRECTION",
        "OR 模式目前沒有任何有效方向票",
        votes,
        config,
      );
    }
  }

  if (input.allowedDirection !== "both" && input.allowedDirection !== direction) {
    return buildHold(
      input,
      "V41_DIRECTION_NOT_ALLOWED",
      `合併方向為${direction === "long" ? "做多" : "做空"}，但策略限制為${input.allowedDirection === "long" ? "只做多" : "只做空"}`,
      votes,
      config,
    );
  }

  if (input.requestedDirection && input.requestedDirection !== direction) {
    return buildHold(
      input,
      "V41_REQUEST_DIRECTION_MISMATCH",
      `合併方向為${direction === "long" ? "做多" : "做空"}，與外部要求的${input.requestedDirection === "long" ? "做多" : "做空"}不一致`,
      votes,
      config,
    );
  }

  return {
    decision: "open",
    passed: true,
    direction,
    primaryReasonCode: "V41_ENTRY_OPEN",
    reason: `${config.entryConditionLogic.toUpperCase()} 合併後允許${direction === "long" ? "做多" : "做空"}入場`,
    votes,
    enabledConditionCount: enabledVotes.length,
    entryConditionLogic: config.entryConditionLogic,
    strategyKey: V41_STRATEGY_KEY,
    configVersion: V41_CONFIG_VERSION,
    configHash: getV41ConfigHash(config),
    decisionBarTimestamp: input.decisionBarTimestamp,
    decisionClose: input.decisionClose,
    fastKama: input.fastKama,
    slowKama: input.slowKama,
  };
}

/**
 * 原地重入只重驗持續方向條件，不把事件型三 K 當成可重複使用的方向票。
 * Bar-Lock、冷卻、倉位與風控仍由 executor／監控層在此函式之後處理。
 */
export function evaluateV41SameDirectionReentry(
  input: V41EntryEvaluationInput & { originalDirection: V41EntryDirection },
): V41ReentryEvaluationResult {
  const validation = validateV41Config(input.config);
  if (!validation.valid || !validation.config) {
    const decision = evaluateV41EntryConditions(input);
    return {
      allowed: false,
      reasonCode: decision.primaryReasonCode,
      reason: decision.reason,
      direction: input.originalDirection,
      continuousDecision: decision,
    };
  }
  const config = validation.config;
  if (!config.enableSameDirectionReentry) {
    return {
      allowed: false,
      reasonCode: "V41_REENTRY_DISABLED",
      reason: "特殊原地重入未啟用",
      direction: input.originalDirection,
      continuousDecision: null,
    };
  }
  if (!hasV41ContinuousDirectionCondition(config)) {
    return {
      allowed: false,
      reasonCode: "V41_REENTRY_REQUIRES_CONTINUOUS_CONDITION",
      reason: "特殊原地重入至少需要一項 KAMA 持續方向條件",
      direction: input.originalDirection,
      continuousDecision: null,
    };
  }

  const continuousConfig: NormalizedV41Config = {
    ...config,
    enableThreeKFilter: false,
  };
  const continuousDecision = evaluateV41EntryConditions({
    ...input,
    config: continuousConfig,
  });
  const supported = continuousDecision.decision === "open"
    && continuousDecision.direction === input.originalDirection;
  return {
    allowed: supported,
    reasonCode: supported ? "V41_ENTRY_OPEN" : "V41_REENTRY_DIRECTION_NOT_SUPPORTED",
    reason: supported
      ? `持續方向條件仍支持${input.originalDirection === "long" ? "做多" : "做空"}原地重入`
      : "持續方向條件未支持原方向，拒絕原地重入",
    direction: input.originalDirection,
    continuousDecision,
  };
}
