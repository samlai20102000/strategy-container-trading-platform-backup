import {
  getSupportedModeCapabilities,
  type ExecutionMode,
  type StrategyModeCapabilities,
} from "../../shared/executionModes";

export const STRATEGY_RUNNER_DESCRIPTOR_VERSION = "strategy-runner-descriptor-v1" as const;

export const BUILT_IN_STRATEGY_KEYS = [
  "strategy_20415",
  "RAINBOW_TREND_LADDER_V1",
  "KAMA_RAINBOW_MARTIN_V1",
  "KAMA_3K_BREAKOUT_V25",
  "20415_KAMA_MARTIN_V35",
  "20415_KAMA_MARTIN_V41",
  "KAMA_3K_ULTIMATE_V50",
  "KAMA_3K_HF_V61",
  "KAMA_3K_TORNADO_V70",
] as const;

export type BuiltInStrategyKey = (typeof BUILT_IN_STRATEGY_KEYS)[number];
export type StrategyRunnerChannel = "BACKTEST" | "SIMULATION" | "LIVE";
export type RunnerCertificationStatus = "CERTIFIED" | "BLOCKED";

export interface StrategyRunnerChannelCertification {
  status: RunnerCertificationStatus;
  supportedModes: readonly ExecutionMode[];
  reason: string;
  evidence: readonly string[];
}

export interface StrategyRunnerDescriptor {
  contractVersion: typeof STRATEGY_RUNNER_DESCRIPTOR_VERSION;
  strategyKey: string;
  strategyVersion: number;
  logicRevision: string;
  adapterId: string;
  adapterVersion: number;
  martingaleLayers: boolean;
  independentLegState: boolean;
  preciseLegClose: boolean;
  hedgeGuard: boolean;
  certifications: Readonly<Record<StrategyRunnerChannel, StrategyRunnerChannelCertification>>;
}

const ALL_MODES = ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"] as const;
const S1_ONLY = ["SINGLE_EXCLUSIVE"] as const;

function certified(
  supportedModes: readonly ExecutionMode[],
  reason: string,
  evidence: readonly string[],
): StrategyRunnerChannelCertification {
  return Object.freeze({ status: "CERTIFIED", supportedModes, reason, evidence });
}

function descriptor(input: Omit<StrategyRunnerDescriptor, "contractVersion">): StrategyRunnerDescriptor {
  return Object.freeze({
    contractVersion: STRATEGY_RUNNER_DESCRIPTOR_VERSION,
    ...input,
    certifications: Object.freeze(input.certifications),
  });
}

const BUILT_IN_DESCRIPTORS: Readonly<Record<BuiltInStrategyKey, StrategyRunnerDescriptor>> = Object.freeze({
  strategy_20415: descriptor({
    strategyKey: "strategy_20415",
    strategyVersion: 1,
    logicRevision: "strategy-20415-v2-runtime",
    adapterId: "rainbow-20415-portfolio",
    adapterVersion: 1,
    martingaleLayers: true,
    independentLegState: true,
    preciseLegClose: true,
    hedgeGuard: true,
    certifications: {
      BACKTEST: certified(ALL_MODES, "七彩虹候選由策略 adapter 產生，帳本交由 canonical portfolio kernel", ["runner-adapter", "multi-leg-ledger"]),
      SIMULATION: certified(S1_ONLY, "模擬執行仍沿用既有單腿 guarded executor", ["legacy-s1-runtime"]),
      LIVE: certified(S1_ONLY, "實盤尚未切換至逐腿七彩虹 adapter", ["legacy-s1-runtime"]),
    },
  }),
  RAINBOW_TREND_LADDER_V1: descriptor({
    strategyKey: "RAINBOW_TREND_LADDER_V1",
    strategyVersion: 1,
    logicRevision: "rainbow-trend-ladder-v1",
    adapterId: "rainbow-trend-ladder-portfolio",
    adapterVersion: 1,
    martingaleLayers: true,
    independentLegState: true,
    preciseLegClose: true,
    hedgeGuard: true,
    certifications: {
      BACKTEST: certified(ALL_MODES, "七線階梯候選由策略 adapter 產生，逐腿狀態由 portfolio kernel 隔離", ["runner-adapter", "multi-leg-ledger"]),
      SIMULATION: certified(S1_ONLY, "模擬執行尚未接入多腿階梯 executor", ["legacy-s1-runtime"]),
      LIVE: certified(S1_ONLY, "實盤尚未接入多腿階梯 executor", ["legacy-s1-runtime"]),
    },
  }),
  KAMA_RAINBOW_MARTIN_V1: descriptor({
    strategyKey: "KAMA_RAINBOW_MARTIN_V1",
    strategyVersion: 1,
    logicRevision: "kama-rainbow-martin-v1-three-mode-cycle-contract-v3",
    adapterId: "kama-rainbow-martin-portfolio",
    adapterVersion: 3,
    martingaleLayers: true,
    independentLegState: true,
    preciseLegClose: true,
    hedgeGuard: true,
    certifications: {
      BACKTEST: certified(ALL_MODES, "六線 KAMA、S1 主腿、每 cycle 單一 M2 反向腿與自動 H3 保護由專用 adapter 接入 canonical kernel", ["krm-pure-core", "multi-leg-ledger", "krm-three-mode-contract-v2"]),
      SIMULATION: certified(ALL_MODES, "KRM guarded executor 已支援腿級模式 envelope", ["advanced-signal-envelope", "leg-scoped-runtime"]),
      LIVE: certified(ALL_MODES, "KRM guarded executor 已支援腿級模式 envelope", ["advanced-signal-envelope", "leg-scoped-runtime"]),
    },
  }),
  KAMA_3K_BREAKOUT_V25: descriptor({
    strategyKey: "KAMA_3K_BREAKOUT_V25",
    strategyVersion: 1,
    logicRevision: "kama-breakout-v25",
    adapterId: "kama-3k-v25-portfolio",
    adapterVersion: 1,
    martingaleLayers: true,
    independentLegState: true,
    preciseLegClose: true,
    hedgeGuard: true,
    certifications: {
      BACKTEST: certified(ALL_MODES, "V2.5 決策核心以逐腿狀態接入 canonical kernel", ["evaluate-v25-decision", "multi-leg-ledger"]),
      SIMULATION: certified(S1_ONLY, "模擬執行尚未接入多腿 V2.5 executor", ["legacy-s1-runtime"]),
      LIVE: certified(S1_ONLY, "實盤尚未接入多腿 V2.5 executor", ["legacy-s1-runtime"]),
    },
  }),
  "20415_KAMA_MARTIN_V35": descriptor({
    strategyKey: "20415_KAMA_MARTIN_V35",
    strategyVersion: 1,
    logicRevision: "advanced-kama-v35-portfolio-v2",
    adapterId: "kama-3k-v35-portfolio",
    adapterVersion: 2,
    martingaleLayers: true,
    independentLegState: true,
    preciseLegClose: true,
    hedgeGuard: true,
    certifications: {
      BACKTEST: certified(ALL_MODES, "V3.5 entry gate 與 canonical portfolio kernel 已接通", ["v35-entry-gate", "multi-leg-ledger"]),
      SIMULATION: certified(ALL_MODES, "V3.5 advanced execution mode engine 已接通", ["advanced-mode-engine"]),
      LIVE: certified(ALL_MODES, "V3.5 advanced execution mode engine 已接通", ["advanced-mode-engine"]),
    },
  }),
  "20415_KAMA_MARTIN_V41": descriptor({
    strategyKey: "20415_KAMA_MARTIN_V41",
    strategyVersion: 1,
    logicRevision: "kama-v41-source-parity-portfolio-v1",
    adapterId: "kama-3k-v41-portfolio",
    adapterVersion: 1,
    martingaleLayers: true,
    independentLegState: true,
    preciseLegClose: true,
    hedgeGuard: true,
    certifications: {
      BACKTEST: certified(ALL_MODES, "V4.1 AND／OR 三條件與已收盤 K 線語義由專用 adapter 接入 canonical kernel", ["v41-entry-conditions", "v40-position-core", "multi-leg-ledger"]),
      SIMULATION: certified(S1_ONLY, "模擬執行尚未接入 V4.1 多腿 executor", ["legacy-s1-runtime"]),
      LIVE: certified(S1_ONLY, "實盤尚未接入 V4.1 多腿 executor", ["legacy-s1-runtime"]),
    },
  }),
  KAMA_3K_ULTIMATE_V50: descriptor({
    strategyKey: "KAMA_3K_ULTIMATE_V50",
    strategyVersion: 1,
    logicRevision: "advanced-kama-v50-portfolio-v2",
    adapterId: "kama-3k-v50-portfolio",
    adapterVersion: 2,
    martingaleLayers: true,
    independentLegState: true,
    preciseLegClose: true,
    hedgeGuard: true,
    certifications: {
      BACKTEST: certified(ALL_MODES, "V5.0 F1–F6 與 canonical portfolio kernel 已接通", ["v50-modules", "multi-leg-ledger"]),
      SIMULATION: certified(ALL_MODES, "V5.0 advanced execution mode engine 已接通", ["advanced-mode-engine"]),
      LIVE: certified(ALL_MODES, "V5.0 advanced execution mode engine 已接通", ["advanced-mode-engine"]),
    },
  }),
  KAMA_3K_HF_V61: descriptor({
    strategyKey: "KAMA_3K_HF_V61",
    strategyVersion: 1,
    logicRevision: "advanced-kama-v61-portfolio-v2",
    adapterId: "kama-3k-v61-portfolio",
    adapterVersion: 2,
    martingaleLayers: true,
    independentLegState: true,
    preciseLegClose: true,
    hedgeGuard: true,
    certifications: {
      BACKTEST: certified(ALL_MODES, "V6.1 ATR／regime 候選與 canonical portfolio kernel 已接通", ["v61-regime", "multi-leg-ledger"]),
      SIMULATION: certified(ALL_MODES, "V6.1 advanced execution mode engine 已接通", ["advanced-mode-engine"]),
      LIVE: certified(ALL_MODES, "V6.1 advanced execution mode engine 已接通", ["advanced-mode-engine"]),
    },
  }),
  KAMA_3K_TORNADO_V70: descriptor({
    strategyKey: "KAMA_3K_TORNADO_V70",
    strategyVersion: 1,
    logicRevision: "kama-v70-source-parity-portfolio-v1",
    adapterId: "kama-3k-v70-portfolio",
    adapterVersion: 1,
    martingaleLayers: true,
    independentLegState: true,
    preciseLegClose: true,
    hedgeGuard: true,
    certifications: {
      BACKTEST: certified(ALL_MODES, "V7.0 MA200／KAMA／S 曲線馬丁由專用 adapter 接入 canonical kernel", ["v70-signal-core", "multi-leg-ledger"]),
      SIMULATION: certified(S1_ONLY, "模擬執行尚未接入 V7.0 多腿 executor", ["legacy-s1-runtime"]),
      LIVE: certified(S1_ONLY, "實盤尚未接入 V7.0 多腿 executor", ["legacy-s1-runtime"]),
    },
  }),
});

const runtimeDescriptors = new Map<string, StrategyRunnerDescriptor>();

export function isBuiltInStrategyKey(key: string): key is BuiltInStrategyKey {
  return (BUILT_IN_STRATEGY_KEYS as readonly string[]).includes(key);
}

export function getBuiltInStrategyRunnerDescriptor(key: BuiltInStrategyKey): StrategyRunnerDescriptor {
  return BUILT_IN_DESCRIPTORS[key];
}

export function getStrategyRunnerDescriptor(key: string): StrategyRunnerDescriptor | null {
  if (isBuiltInStrategyKey(key)) return BUILT_IN_DESCRIPTORS[key];
  return runtimeDescriptors.get(key) ?? null;
}

export function listBuiltInStrategyRunnerDescriptors(): StrategyRunnerDescriptor[] {
  return BUILT_IN_STRATEGY_KEYS.map(key => BUILT_IN_DESCRIPTORS[key]);
}

export function registerStrategyRunnerDescriptor(value: StrategyRunnerDescriptor): void {
  if (isBuiltInStrategyKey(value.strategyKey)) {
    throw new Error(`內建策略 ${value.strategyKey} 的 runner descriptor 禁止覆蓋`);
  }
  assertStrategyRunnerDescriptor(value);
  runtimeDescriptors.set(value.strategyKey, Object.freeze(value));
}

export function unregisterStrategyRunnerDescriptor(strategyKey: string): void {
  if (!isBuiltInStrategyKey(strategyKey)) runtimeDescriptors.delete(strategyKey);
}

export function getStrategyChannelCapabilities(
  strategyKey: string,
  channel: StrategyRunnerChannel,
  martingaleFallback = false,
): StrategyModeCapabilities {
  const descriptorValue = getStrategyRunnerDescriptor(strategyKey);
  const certification = descriptorValue?.certifications[channel];
  if (!descriptorValue || !certification || certification.status !== "CERTIFIED") {
    return getSupportedModeCapabilities({
      supportedModes: [...S1_ONLY],
      martingaleLayers: descriptorValue?.martingaleLayers ?? martingaleFallback,
      independentLegState: false,
      preciseLegClose: false,
      hedgeGuard: false,
      reason: descriptorValue
        ? certification?.reason ?? `${channel} runner 未認證`
        : `策略尚未註冊 ${STRATEGY_RUNNER_DESCRIPTOR_VERSION}；只允許相容 S1`,
    });
  }
  const supportedModes = [...certification.supportedModes];
  const advanced = supportedModes.includes("MULTI_POSITION") || supportedModes.includes("HEDGE_GUARDED");
  return getSupportedModeCapabilities({
    supportedModes,
    martingaleLayers: descriptorValue.martingaleLayers,
    independentLegState: advanced && descriptorValue.independentLegState,
    preciseLegClose: advanced && descriptorValue.preciseLegClose,
    hedgeGuard: supportedModes.includes("HEDGE_GUARDED") && descriptorValue.hedgeGuard,
    reason: certification.reason,
  });
}

export function assertStrategyRunnerDescriptor(value: StrategyRunnerDescriptor): void {
  if (value.contractVersion !== STRATEGY_RUNNER_DESCRIPTOR_VERSION) {
    throw new Error(`不支援的 runner descriptor contract: ${value.contractVersion}`);
  }
  if (!value.strategyKey.trim() || !value.adapterId.trim()) throw new Error("runner descriptor 缺少 strategyKey／adapterId");
  if (!Number.isInteger(value.strategyVersion) || value.strategyVersion < 1) throw new Error("strategyVersion 必須為正整數");
  if (!Number.isInteger(value.adapterVersion) || value.adapterVersion < 1) throw new Error("adapterVersion 必須為正整數");
  for (const channel of ["BACKTEST", "SIMULATION", "LIVE"] as const) {
    const certification = value.certifications[channel];
    if (!certification || !certification.supportedModes.includes("SINGLE_EXCLUSIVE")) {
      throw new Error(`${value.strategyKey} ${channel} descriptor 必須明確包含 S1`);
    }
    const hasM2 = certification.supportedModes.includes("MULTI_POSITION");
    const hasH3 = certification.supportedModes.includes("HEDGE_GUARDED");
    if ((hasM2 || hasH3) && (!value.independentLegState || !value.preciseLegClose)) {
      throw new Error(`${value.strategyKey} ${channel} M2／H3 缺少逐腿狀態或精確平腿能力`);
    }
    if (hasH3 && !value.hedgeGuard) throw new Error(`${value.strategyKey} ${channel} H3 缺少 hedgeGuard`);
    if (certification.evidence.length === 0) throw new Error(`${value.strategyKey} ${channel} 缺少認證證據`);
  }
}

export function assertCompleteBuiltInDescriptorRegistry(): void {
  const descriptorKeys = Object.keys(BUILT_IN_DESCRIPTORS).sort();
  const builtInKeys = [...BUILT_IN_STRATEGY_KEYS].sort();
  if (JSON.stringify(descriptorKeys) !== JSON.stringify(builtInKeys)) {
    throw new Error("內建策略與 runner descriptor 集合不一致");
  }
  for (const key of BUILT_IN_STRATEGY_KEYS) assertStrategyRunnerDescriptor(BUILT_IN_DESCRIPTORS[key]);
}

assertCompleteBuiltInDescriptorRegistry();
