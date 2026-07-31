import {
  normalizeExecutionModePolicy,
  type DeploymentActivationState,
  type ExecutionMode,
  type ExecutionPolicy,
} from "../../shared/executionModes";
import type {
  ExchangeCapabilitySnapshot,
  ExchangeInstrumentSnapshot,
  Position,
} from "../exchanges/types";
import { buildBacktestHash } from "./backtest/backtestContracts";
import {
  buildExecutionPolicyHash,
  capabilityManifestSupportsMode,
  normalizeVersionedCapabilityManifest,
  type VersionedStrategyCapabilityManifest,
} from "./strategyArtifacts";

export const DEPLOYMENT_PREFLIGHT_CONTRACT_VERSION = "deployment-preflight-v1" as const;

export type DeploymentPreflightStatus = "PASS" | "WARNING" | "BLOCKED";
export type DeploymentPreflightCategory =
  | "IDENTITY"
  | "ARTIFACT"
  | "ACCOUNT"
  | "EXCHANGE"
  | "INSTRUMENT"
  | "LEDGER"
  | "RISK"
  | "LIFECYCLE";

export interface DeploymentPreflightCheck {
  code: string;
  category: DeploymentPreflightCategory;
  status: DeploymentPreflightStatus;
  message: string;
  evidence: Record<string, unknown>;
}

export interface DeploymentDescriptor {
  id: number;
  userId: number;
  deploymentKey: string | null;
  strategyKey: string | null;
  strategyVersion: number;
  executionMode: ExecutionMode;
  executionPolicy: unknown;
  capabilitySnapshot: unknown;
  activationState: DeploymentActivationState;
  deploymentRevision: number;
  enabled: boolean;
  apiKeyId: number;
  exchange: "bybit" | "okx";
  symbol: string;
}

export interface DeploymentPreflightFacts {
  now: number;
  currentManifest: VersionedStrategyCapabilityManifest;
  account: {
    exists: boolean;
    ownerMatches: boolean;
    exchangeMatches: boolean;
    lastTestStatus: "untested" | "success" | "failed" | "missing";
    lastTestAt?: number;
  };
  exchangeCapability?: ExchangeCapabilitySnapshot;
  instrument?: ExchangeInstrumentSnapshot;
  balance?: {
    free: number;
    total: number;
    usedMargin: number;
  };
  positions?: Position[];
  openLegCount: number;
  pendingIntentCount: number;
  unresolvedReconciliationCount: number;
  activeHedgeRelationshipCount: number;
  activeReservationCount: number;
  artifactCompatibilityBlockers?: string[];
  probeErrors?: {
    capability?: string;
    instrument?: string;
    balance?: string;
    positions?: string;
  };
  requireFlat?: boolean;
}

export interface DeploymentPreflightReport {
  contractVersion: typeof DEPLOYMENT_PREFLIGHT_CONTRACT_VERSION;
  deploymentId: number;
  deploymentKey: string;
  deploymentRevision: number;
  executionMode: ExecutionMode;
  executionPolicy: ExecutionPolicy;
  executionPolicyHash: string;
  strategyManifestHash: string;
  checkedAt: number;
  expiresAt: number;
  eligible: boolean;
  blockerCodes: string[];
  warningCodes: string[];
  checks: DeploymentPreflightCheck[];
  riskEvidence: {
    accountEquity: number | null;
    availableBalance: number | null;
    grossNotional: number | null;
    grossNotionalPct: number | null;
    usedMargin: number | null;
    marginUsagePct: number | null;
  };
  preflightHash: string;
}

export type DeploymentLifecycleAction =
  | "PREFLIGHT_PASS"
  | "PREFLIGHT_FAIL"
  | "ACTIVATE"
  | "PAUSE"
  | "RESUME"
  | "DRAIN"
  | "DISABLE"
  | "BLOCK"
  | "ARCHIVE";

const ALLOWED_TRANSITIONS: Readonly<
  Record<DeploymentLifecycleAction, ReadonlyArray<DeploymentActivationState>>
> = Object.freeze({
  PREFLIGHT_PASS: ["DRAFT", "DISABLED", "PREFLIGHT_FAILED", "READY_DISABLED", "PAUSED"],
  PREFLIGHT_FAIL: [
    "DRAFT",
    "DISABLED",
    "PREFLIGHT_FAILED",
    "READY_DISABLED",
    "ARMED",
    "PAUSED",
    "BLOCKED",
  ],
  ACTIVATE: ["READY_DISABLED", "ARMED"],
  PAUSE: ["ACTIVE"],
  RESUME: ["PAUSED"],
  DRAIN: ["ACTIVE", "PAUSED", "BLOCKED"],
  DISABLE: [
    "LEGACY",
    "DRAFT",
    "DISABLED",
    "PREFLIGHT_FAILED",
    "READY_DISABLED",
    "ARMED",
    "PAUSED",
    "DRAINING",
    "BLOCKED",
  ],
  BLOCK: ["DRAFT", "DISABLED", "PREFLIGHT_FAILED", "READY_DISABLED", "ARMED", "ACTIVE", "PAUSED", "DRAINING"],
  ARCHIVE: ["DRAFT", "DISABLED", "PREFLIGHT_FAILED", "READY_DISABLED", "BLOCKED"],
});

export function lifecycleTargetForAction(
  action: DeploymentLifecycleAction,
): DeploymentActivationState {
  switch (action) {
    case "PREFLIGHT_PASS": return "READY_DISABLED";
    case "PREFLIGHT_FAIL": return "PREFLIGHT_FAILED";
    case "ACTIVATE": return "ACTIVE";
    case "PAUSE": return "PAUSED";
    case "RESUME": return "ACTIVE";
    case "DRAIN": return "DRAINING";
    case "DISABLE": return "DISABLED";
    case "BLOCK": return "BLOCKED";
    case "ARCHIVE": return "ARCHIVED";
  }
}

export function assertDeploymentTransitionAllowed(
  fromState: DeploymentActivationState,
  action: DeploymentLifecycleAction,
): void {
  if (!ALLOWED_TRANSITIONS[action].includes(fromState)) {
    throw new Error(`ILLEGAL_DEPLOYMENT_TRANSITION:${fromState}:${action}`);
  }
}

function finiteNonNegative(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(8));
}

function grossNotional(positions: Position[]): number {
  return rounded(positions.reduce((sum, position) => (
    sum + finiteNonNegative(position.size) * finiteNonNegative(position.markPrice)
  ), 0));
}

function addCheck(
  checks: DeploymentPreflightCheck[],
  input: Omit<DeploymentPreflightCheck, "status"> & {
    passed: boolean;
    warning?: boolean;
  },
): void {
  checks.push({
    code: input.code,
    category: input.category,
    status: input.passed ? "PASS" : input.warning ? "WARNING" : "BLOCKED",
    message: input.message,
    evidence: input.evidence,
  });
}

function freshnessExpiresAt(
  observedAt: number | undefined,
  ttlMs: number,
  fallback: number,
): number {
  return Number.isFinite(observedAt) ? Number(observedAt) + ttlMs : fallback;
}

/**
 * 純函式 deterministic preflight。所有交易所資料必須由呼叫端透過只讀 API 取得；
 * 此函式不建立、修改或取消任何訂單，也不改變帳戶 position mode。
 */
export function buildDeploymentPreflightReport(
  deployment: DeploymentDescriptor,
  facts: DeploymentPreflightFacts,
): DeploymentPreflightReport {
  const policy = normalizeExecutionModePolicy(
    deployment.executionPolicy ?? { mode: deployment.executionMode },
  );
  const policyHash = buildExecutionPolicyHash(policy);
  const checks: DeploymentPreflightCheck[] = [];
  const deploymentKey = deployment.deploymentKey?.trim() || `strategy-${deployment.id}`;
  const strategyKey = deployment.strategyKey?.trim() || "";
  const capabilitySnapshot = deployment.capabilitySnapshot
    ? normalizeVersionedCapabilityManifest(deployment.capabilitySnapshot, facts.currentManifest)
    : null;
  const ttlMs = policy.riskBudget.capabilityTtlSeconds * 1_000;
  const exchangeCapability = facts.exchangeCapability;
  const instrument = facts.instrument;
  const positions = facts.positions ?? [];
  const equity = facts.balance ? finiteNonNegative(facts.balance.total) : null;
  const free = facts.balance ? finiteNonNegative(facts.balance.free) : null;
  const usedMargin = facts.balance ? finiteNonNegative(facts.balance.usedMargin) : null;
  const gross = facts.balance ? grossNotional(positions) : null;
  const grossPct = equity && gross !== null ? rounded((gross / equity) * 100) : null;
  const marginPct = equity && usedMargin !== null ? rounded((usedMargin / equity) * 100) : null;
  const advancedMode = policy.mode !== "SINGLE_EXCLUSIVE";

  addCheck(checks, {
    code: "DEPLOYMENT_IDENTITY_VALID",
    category: "IDENTITY",
    passed: Boolean(deployment.deploymentKey && strategyKey),
    message: "部署必須具有不可變 deploymentKey 與 strategyKey。",
    evidence: { deploymentKey: deployment.deploymentKey, strategyKey },
  });
  addCheck(checks, {
    code: "POLICY_MODE_MATCH",
    category: "IDENTITY",
    passed: policy.mode === deployment.executionMode,
    message: "executionMode 必須與 canonical executionPolicy.mode 一致。",
    evidence: { executionMode: deployment.executionMode, policyMode: policy.mode },
  });
  addCheck(checks, {
    code: "ACTIVATION_SOURCE_ALLOWED",
    category: "LIFECYCLE",
    passed: deployment.activationState !== "ARCHIVED" && deployment.activationState !== "ACTIVE",
    message: "封存或已啟用部署不可重新執行 activation preflight。",
    evidence: { activationState: deployment.activationState, enabled: deployment.enabled },
  });
  addCheck(checks, {
    code: "CAPABILITY_SNAPSHOT_PRESENT",
    category: "ARTIFACT",
    passed: capabilitySnapshot !== null,
    message: "部署必須保存版本化 capability snapshot。",
    evidence: { present: capabilitySnapshot !== null },
  });
  addCheck(checks, {
    code: "CAPABILITY_MANIFEST_CURRENT",
    category: "ARTIFACT",
    passed: capabilitySnapshot?.manifestHash === facts.currentManifest.manifestHash
      && capabilitySnapshot.strategyVersion === deployment.strategyVersion,
    message: "部署 capability snapshot 必須與目前策略版本及 registry manifest 一致。",
    evidence: {
      deploymentStrategyVersion: deployment.strategyVersion,
      snapshotStrategyVersion: capabilitySnapshot?.strategyVersion,
      snapshotManifestHash: capabilitySnapshot?.manifestHash,
      currentManifestHash: facts.currentManifest.manifestHash,
    },
  });
  addCheck(checks, {
    code: "EXECUTION_MODE_CERTIFIED",
    category: "ARTIFACT",
    passed: capabilityManifestSupportsMode(facts.currentManifest, policy.mode),
    message: "目前策略版本必須認證目標 execution mode。",
    evidence: {
      mode: policy.mode,
      certification: facts.currentManifest.certification,
      supportedModes: facts.currentManifest.capabilities.supportedModes,
    },
  });
  for (const blocker of [...(facts.artifactCompatibilityBlockers ?? [])].sort()) {
    addCheck(checks, {
      code: `ARTIFACT_${blocker}`,
      category: "ARTIFACT",
      passed: false,
      message: "策略 artifact 與目前部署目標不相容。",
      evidence: { blocker },
    });
  }

  addCheck(checks, {
    code: "ACCOUNT_OWNED",
    category: "ACCOUNT",
    passed: facts.account.exists && facts.account.ownerMatches,
    message: "API key 必須存在且屬於 deployment owner。",
    evidence: { exists: facts.account.exists, ownerMatches: facts.account.ownerMatches },
  });
  addCheck(checks, {
    code: "ACCOUNT_EXCHANGE_MATCH",
    category: "ACCOUNT",
    passed: facts.account.exchangeMatches,
    message: "API key 交易所必須與部署交易所一致。",
    evidence: { expectedExchange: deployment.exchange, exchangeMatches: facts.account.exchangeMatches },
  });
  addCheck(checks, {
    code: "ACCOUNT_CONNECTION_HEALTHY",
    category: "ACCOUNT",
    passed: facts.account.lastTestStatus === "success",
    message: "API key 必須完成成功的只讀連線驗證。",
    evidence: {
      lastTestStatus: facts.account.lastTestStatus,
      lastTestAt: facts.account.lastTestAt,
    },
  });

  const capabilityFresh = Boolean(
    exchangeCapability
      && exchangeCapability.exchange === deployment.exchange
      && exchangeCapability.symbol === deployment.symbol
      && exchangeCapability.observedAt <= facts.now
      && exchangeCapability.observedAt + ttlMs >= facts.now,
  );
  addCheck(checks, {
    code: "EXCHANGE_CAPABILITY_AVAILABLE",
    category: "EXCHANGE",
    passed: Boolean(exchangeCapability),
    message: "必須從交易所只讀 API 取得 position mode 與逐腿關閉能力。",
    evidence: {
      available: Boolean(exchangeCapability),
      source: exchangeCapability?.source,
      sanitizedError: facts.probeErrors?.capability,
    },
  });
  addCheck(checks, {
    code: "EXCHANGE_CAPABILITY_FRESH",
    category: "EXCHANGE",
    passed: capabilityFresh,
    message: "交易所 capability evidence 必須在 policy TTL 內。",
    evidence: {
      observedAt: exchangeCapability?.observedAt,
      ttlSeconds: policy.riskBudget.capabilityTtlSeconds,
      checkedAt: facts.now,
    },
  });
  addCheck(checks, {
    code: "ACCOUNT_POSITION_MODE_COMPATIBLE",
    category: "EXCHANGE",
    passed: !advancedMode || exchangeCapability?.positionMode === "HEDGE",
    message: "M2／H3 必須使用交易所 hedge／long-short position mode。",
    evidence: { mode: policy.mode, positionMode: exchangeCapability?.positionMode },
  });
  addCheck(checks, {
    code: "PRECISE_LEG_CLOSE_AVAILABLE",
    category: "EXCHANGE",
    passed: !advancedMode || exchangeCapability?.preciseLegClose === true,
    message: "M2／H3 必須能以 position side 精確 reduce／close 指定腿。",
    evidence: { mode: policy.mode, preciseLegClose: exchangeCapability?.preciseLegClose },
  });

  const instrumentFresh = Boolean(
    instrument
      && instrument.exchange === deployment.exchange
      && instrument.symbol === deployment.symbol
      && instrument.observedAt <= facts.now
      && instrument.observedAt + ttlMs >= facts.now,
  );
  addCheck(checks, {
    code: "INSTRUMENT_TRADABLE",
    category: "INSTRUMENT",
    passed: Boolean(instrument?.exists && instrument.active),
    message: "指定商品必須存在且處於可交易狀態。",
    evidence: {
      exists: instrument?.exists,
      active: instrument?.active,
      source: instrument?.source,
    },
  });
  addCheck(checks, {
    code: "INSTRUMENT_SPEC_FRESH",
    category: "INSTRUMENT",
    passed: instrumentFresh,
    message: "商品規格必須由 TTL 內的只讀交易所資料取得。",
    evidence: {
      observedAt: instrument?.observedAt,
      checkedAt: facts.now,
      sanitizedError: facts.probeErrors?.instrument,
    },
  });
  addCheck(checks, {
    code: "INSTRUMENT_SIZE_VALID",
    category: "INSTRUMENT",
    passed: Boolean(
      instrument
        && finiteNonNegative(instrument.minOrderSize) > 0
        && finiteNonNegative(instrument.quantityStep) > 0,
    ),
    message: "商品必須提供有效最小下單量與 quantity step。",
    evidence: {
      minOrderSize: instrument?.minOrderSize,
      quantityStep: instrument?.quantityStep,
    },
  });

  addCheck(checks, {
    code: "LEDGER_FLAT",
    category: "LEDGER",
    passed: facts.requireFlat === false || facts.openLegCount === 0,
    message: "啟用或切換模式前 deployment 必須 flat；有腿時只能 drain 或建立新 deployment。",
    evidence: { requireFlat: facts.requireFlat !== false, openLegCount: facts.openLegCount },
  });
  addCheck(checks, {
    code: "NO_PENDING_ORDER_INTENTS",
    category: "LEDGER",
    passed: facts.pendingIntentCount === 0,
    message: "不得存在未完成的 order intent。",
    evidence: { pendingIntentCount: facts.pendingIntentCount },
  });
  addCheck(checks, {
    code: "NO_UNRESOLVED_RECONCILIATION",
    category: "LEDGER",
    passed: facts.unresolvedReconciliationCount === 0,
    message: "不得存在未解決 reconciliation case。",
    evidence: { unresolvedReconciliationCount: facts.unresolvedReconciliationCount },
  });
  addCheck(checks, {
    code: "NO_ACTIVE_HEDGE_RELATIONSHIP",
    category: "LEDGER",
    passed: facts.requireFlat === false || facts.activeHedgeRelationshipCount === 0,
    message: "切換／新啟用前不得保留未解除的 H3 relationship。",
    evidence: { activeHedgeRelationshipCount: facts.activeHedgeRelationshipCount },
  });
  addCheck(checks, {
    code: "NO_ACTIVE_RISK_RESERVATION",
    category: "LEDGER",
    passed: facts.activeReservationCount === 0,
    message: "不得存在尚未提交或釋放的 gross／margin 預留。",
    evidence: { activeReservationCount: facts.activeReservationCount },
  });

  addCheck(checks, {
    code: "ACCOUNT_EQUITY_POSITIVE",
    category: "RISK",
    passed: equity !== null && equity > 0,
    message: "必須取得正值帳戶權益，才能評估 gross 與 margin Gate。",
    evidence: {
      equity,
      free,
      sanitizedBalanceError: facts.probeErrors?.balance,
      sanitizedPositionsError: facts.probeErrors?.positions,
    },
  });
  addCheck(checks, {
    code: "GROSS_NOTIONAL_WITHIN_BUDGET",
    category: "RISK",
    passed: grossPct !== null && grossPct <= policy.riskBudget.maxGrossNotionalPct,
    message: "帳戶 gross notional 不得超過 deployment policy 上限。",
    evidence: {
      grossNotional: gross,
      grossNotionalPct: grossPct,
      limitPct: policy.riskBudget.maxGrossNotionalPct,
    },
  });
  addCheck(checks, {
    code: "MARGIN_USAGE_WITHIN_BUDGET",
    category: "RISK",
    passed: marginPct !== null && marginPct <= policy.riskBudget.maxMarginUsagePct,
    message: "帳戶 margin usage 不得超過 deployment policy 上限。",
    evidence: {
      usedMargin,
      marginUsagePct: marginPct,
      limitPct: policy.riskBudget.maxMarginUsagePct,
    },
  });

  const blockerCodes = checks
    .filter(check => check.status === "BLOCKED")
    .map(check => check.code);
  const warningCodes = checks
    .filter(check => check.status === "WARNING")
    .map(check => check.code);
  const expiresAt = Math.min(
    freshnessExpiresAt(exchangeCapability?.observedAt, ttlMs, facts.now),
    freshnessExpiresAt(instrument?.observedAt, ttlMs, facts.now),
  );
  const identityCore = {
    contractVersion: DEPLOYMENT_PREFLIGHT_CONTRACT_VERSION,
    deploymentId: deployment.id,
    deploymentKey,
    deploymentRevision: deployment.deploymentRevision,
    executionMode: policy.mode,
    executionPolicyHash: policyHash,
    strategyManifestHash: facts.currentManifest.manifestHash,
    exchangeCapability,
    instrument,
    account: facts.account,
    ledger: {
      openLegCount: facts.openLegCount,
      pendingIntentCount: facts.pendingIntentCount,
      unresolvedReconciliationCount: facts.unresolvedReconciliationCount,
      activeHedgeRelationshipCount: facts.activeHedgeRelationshipCount,
      activeReservationCount: facts.activeReservationCount,
    },
    risk: { equity, free, usedMargin, gross, grossPct, marginPct },
    checks: checks.map(check => ({
      code: check.code,
      category: check.category,
      status: check.status,
      evidence: check.evidence,
    })),
  };

  return {
    contractVersion: DEPLOYMENT_PREFLIGHT_CONTRACT_VERSION,
    deploymentId: deployment.id,
    deploymentKey,
    deploymentRevision: deployment.deploymentRevision,
    executionMode: policy.mode,
    executionPolicy: policy,
    executionPolicyHash: policyHash,
    strategyManifestHash: facts.currentManifest.manifestHash,
    checkedAt: facts.now,
    expiresAt,
    eligible: blockerCodes.length === 0,
    blockerCodes,
    warningCodes,
    checks,
    riskEvidence: {
      accountEquity: equity,
      availableBalance: free,
      grossNotional: gross,
      grossNotionalPct: grossPct,
      usedMargin,
      marginUsagePct: marginPct,
    },
    preflightHash: buildBacktestHash(identityCore),
  };
}

export function assertFreshPassingPreflight(
  report: DeploymentPreflightReport | null | undefined,
  input: {
    deploymentId: number;
    deploymentRevision: number;
    executionMode: ExecutionMode;
    executionPolicy: unknown;
    now: number;
  },
): asserts report is DeploymentPreflightReport {
  if (!report) throw new Error("PREFLIGHT_NOT_RUN");
  if (!report.eligible) throw new Error(`PREFLIGHT_BLOCKED:${report.blockerCodes.join(",")}`);
  if (report.expiresAt < input.now) throw new Error("PREFLIGHT_EXPIRED");
  if (report.deploymentId !== input.deploymentId) throw new Error("PREFLIGHT_DEPLOYMENT_MISMATCH");
  if (report.deploymentRevision !== input.deploymentRevision) throw new Error("PREFLIGHT_REVISION_STALE");
  const policy = normalizeExecutionModePolicy(input.executionPolicy);
  if (report.executionMode !== input.executionMode || report.executionPolicyHash !== buildExecutionPolicyHash(policy)) {
    throw new Error("PREFLIGHT_POLICY_STALE");
  }
}
