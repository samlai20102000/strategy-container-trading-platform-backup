import type { ExecutionMode } from "../../../shared/executionModes";
import {
  getStrategyRunnerDescriptor,
  type StrategyRunnerDescriptor,
} from "../strategyRunnerDescriptors";
import {
  assertPortfolioStrategyRuntimeAdapter,
  type PortfolioStrategyRuntimeAdapter,
  type PortfolioStrategyRuntimeFactory,
  type PortfolioStrategyRuntimeFactoryContext,
} from "./portfolioStrategyRuntimeAdapter";

export const PORTFOLIO_ADAPTER_REGISTRY_VERSION = "portfolio-adapter-registry-v1" as const;

export type PortfolioStrategySemantic =
  | "RAINBOW_20415"
  | "RAINBOW_TREND_LADDER"
  | "KAMA_RAINBOW_MARTIN"
  | "KAMA_3K_V25"
  | "KAMA_3K_V35"
  | "KAMA_3K_V41"
  | "KAMA_3K_V50"
  | "KAMA_3K_V61"
  | "KAMA_3K_V70";

export interface PortfolioStrategyAdapterRegistration {
  registryVersion: typeof PORTFOLIO_ADAPTER_REGISTRY_VERSION;
  adapterId: string;
  adapterVersion: number;
  semantic: PortfolioStrategySemantic;
  supportedModes: readonly ExecutionMode[];
  minimumClosedBars: number;
  evidence: readonly string[];
}

export interface ResolvedPortfolioStrategyAdapter {
  descriptor: StrategyRunnerDescriptor;
  adapter: PortfolioStrategyAdapterRegistration;
}

export type PortfolioAdapterResolutionErrorCode =
  | "RUNNER_DESCRIPTOR_MISSING"
  | "BACKTEST_CHANNEL_NOT_CERTIFIED"
  | "BACKTEST_MODE_NOT_CERTIFIED"
  | "PORTFOLIO_ADAPTER_MISSING"
  | "PORTFOLIO_ADAPTER_IMPLEMENTATION_MISSING"
  | "PORTFOLIO_ADAPTER_VERSION_MISMATCH"
  | "PORTFOLIO_ADAPTER_MODE_MISMATCH";

export class PortfolioAdapterResolutionError extends Error {
  constructor(
    readonly code: PortfolioAdapterResolutionErrorCode,
    readonly strategyKey: string,
    readonly mode: ExecutionMode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${strategyKey} / ${mode}`);
    this.name = "PortfolioAdapterResolutionError";
  }
}

const registrations = new Map<string, PortfolioStrategyAdapterRegistration>();
const runtimeFactories = new Map<string, {
  adapterVersion: number;
  factory: PortfolioStrategyRuntimeFactory;
}>();

function immutableRegistration(
  value: Omit<PortfolioStrategyAdapterRegistration, "registryVersion">,
): PortfolioStrategyAdapterRegistration {
  if (!value.adapterId.trim()) throw new Error("portfolio adapter 缺少 adapterId");
  if (!Number.isInteger(value.adapterVersion) || value.adapterVersion < 1) {
    throw new Error(`${value.adapterId} adapterVersion 必須為正整數`);
  }
  if (!value.supportedModes.includes("SINGLE_EXCLUSIVE")) {
    throw new Error(`${value.adapterId} 必須明確支援 S1`);
  }
  if (!Number.isInteger(value.minimumClosedBars) || value.minimumClosedBars < 1) {
    throw new Error(`${value.adapterId} minimumClosedBars 必須為正整數`);
  }
  if (value.evidence.length === 0) throw new Error(`${value.adapterId} 缺少語義證據`);
  return Object.freeze({
    registryVersion: PORTFOLIO_ADAPTER_REGISTRY_VERSION,
    ...value,
    supportedModes: Object.freeze([...value.supportedModes]),
    evidence: Object.freeze([...value.evidence]),
  });
}

export function registerPortfolioStrategyAdapter(
  value: Omit<PortfolioStrategyAdapterRegistration, "registryVersion">,
): PortfolioStrategyAdapterRegistration {
  const normalized = immutableRegistration(value);
  const existing = registrations.get(normalized.adapterId);
  if (existing && existing.adapterVersion !== normalized.adapterVersion) {
    throw new Error(
      `${normalized.adapterId} 已註冊 v${existing.adapterVersion}，禁止以 v${normalized.adapterVersion} 靜默覆蓋`,
    );
  }
  registrations.set(normalized.adapterId, normalized);
  return normalized;
}

export function unregisterPortfolioStrategyAdapter(adapterId: string): void {
  registrations.delete(adapterId);
  runtimeFactories.delete(adapterId);
}

export function getPortfolioStrategyAdapter(
  adapterId: string,
): PortfolioStrategyAdapterRegistration | null {
  return registrations.get(adapterId) ?? null;
}

export function listPortfolioStrategyAdapters(): PortfolioStrategyAdapterRegistration[] {
  return Array.from(registrations.values());
}

export function registerPortfolioStrategyRuntimeFactory(
  adapterId: string,
  adapterVersion: number,
  factory: PortfolioStrategyRuntimeFactory,
): void {
  if (!adapterId.trim()) throw new Error("portfolio runtime factory 缺少 adapterId");
  if (!Number.isInteger(adapterVersion) || adapterVersion < 1) {
    throw new Error(`${adapterId} runtime adapterVersion 必須為正整數`);
  }
  if (typeof factory !== "function") throw new Error(`${adapterId} runtime factory 無效`);

  const metadata = registrations.get(adapterId);
  if (!metadata) throw new Error(`PORTFOLIO_ADAPTER_METADATA_MISSING:${adapterId}`);
  if (metadata.adapterVersion !== adapterVersion) {
    throw new Error(
      `PORTFOLIO_RUNTIME_FACTORY_VERSION_MISMATCH:${adapterId}:metadata=${metadata.adapterVersion}:runtime=${adapterVersion}`,
    );
  }
  const existing = runtimeFactories.get(adapterId);
  if (existing && existing.adapterVersion !== adapterVersion) {
    throw new Error(
      `PORTFOLIO_RUNTIME_FACTORY_REPLACE_DENIED:${adapterId}:registered=${existing.adapterVersion}:incoming=${adapterVersion}`,
    );
  }
  runtimeFactories.set(adapterId, { adapterVersion, factory });
}

export function unregisterPortfolioStrategyRuntimeFactory(adapterId: string): void {
  runtimeFactories.delete(adapterId);
}

export function listExecutablePortfolioAdapterIds(): string[] {
  return Array.from(runtimeFactories.keys()).sort();
}

export function assertExecutablePortfolioStrategyAdapter(
  resolved: ResolvedPortfolioStrategyAdapter,
  mode: ExecutionMode,
): void {
  const executable = runtimeFactories.get(resolved.adapter.adapterId);
  if (!executable) {
    throw new PortfolioAdapterResolutionError(
      "PORTFOLIO_ADAPTER_IMPLEMENTATION_MISSING",
      resolved.descriptor.strategyKey,
      mode,
      { adapterId: resolved.adapter.adapterId },
    );
  }
  if (executable.adapterVersion !== resolved.adapter.adapterVersion) {
    throw new PortfolioAdapterResolutionError(
      "PORTFOLIO_ADAPTER_VERSION_MISMATCH",
      resolved.descriptor.strategyKey,
      mode,
      {
        adapterId: resolved.adapter.adapterId,
        registeredVersion: resolved.adapter.adapterVersion,
        runtimeVersion: executable.adapterVersion,
      },
    );
  }
}

export function createPortfolioStrategyRuntimeAdapter(
  resolved: ResolvedPortfolioStrategyAdapter,
  context: PortfolioStrategyRuntimeFactoryContext,
): PortfolioStrategyRuntimeAdapter {
  assertExecutablePortfolioStrategyAdapter(resolved, context.executionPolicy.mode);
  const executable = runtimeFactories.get(resolved.adapter.adapterId)!;
  const runtime = executable.factory(context);
  assertPortfolioStrategyRuntimeAdapter(
    runtime,
    resolved.adapter.adapterId,
    resolved.adapter.adapterVersion,
  );
  return runtime;
}

export function resolvePortfolioStrategyAdapter(
  strategyKey: string,
  mode: ExecutionMode,
): ResolvedPortfolioStrategyAdapter {
  const descriptor = getStrategyRunnerDescriptor(strategyKey);
  if (!descriptor) {
    throw new PortfolioAdapterResolutionError("RUNNER_DESCRIPTOR_MISSING", strategyKey, mode);
  }
  const certification = descriptor.certifications.BACKTEST;
  if (certification.status !== "CERTIFIED") {
    throw new PortfolioAdapterResolutionError("BACKTEST_CHANNEL_NOT_CERTIFIED", strategyKey, mode, {
      reason: certification.reason,
    });
  }
  if (!certification.supportedModes.includes(mode)) {
    throw new PortfolioAdapterResolutionError("BACKTEST_MODE_NOT_CERTIFIED", strategyKey, mode, {
      supportedModes: certification.supportedModes,
    });
  }
  const adapter = registrations.get(descriptor.adapterId);
  if (!adapter) {
    throw new PortfolioAdapterResolutionError("PORTFOLIO_ADAPTER_MISSING", strategyKey, mode, {
      adapterId: descriptor.adapterId,
    });
  }
  if (adapter.adapterVersion !== descriptor.adapterVersion) {
    throw new PortfolioAdapterResolutionError("PORTFOLIO_ADAPTER_VERSION_MISMATCH", strategyKey, mode, {
      adapterId: adapter.adapterId,
      descriptorVersion: descriptor.adapterVersion,
      registeredVersion: adapter.adapterVersion,
    });
  }
  if (!adapter.supportedModes.includes(mode)) {
    throw new PortfolioAdapterResolutionError("PORTFOLIO_ADAPTER_MODE_MISMATCH", strategyKey, mode, {
      adapterId: adapter.adapterId,
      supportedModes: adapter.supportedModes,
    });
  }
  return { descriptor, adapter };
}

const ALL_MODES = ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"] as const;

for (const value of [
  { adapterId: "rainbow-20415-portfolio", adapterVersion: 1, semantic: "RAINBOW_20415", minimumClosedBars: 120, evidence: ["rainbow20415/core.ts"] },
  { adapterId: "rainbow-trend-ladder-portfolio", adapterVersion: 1, semantic: "RAINBOW_TREND_LADDER", minimumClosedBars: 120, evidence: ["rainbowTrendLadder/core.ts"] },
  { adapterId: "kama-rainbow-martin-portfolio", adapterVersion: 2, semantic: "KAMA_RAINBOW_MARTIN", minimumClosedBars: 120, evidence: ["kamaRainbowMartin/core.ts", "kamaRainbowMartin/management.ts"] },
  { adapterId: "kama-3k-v25-portfolio", adapterVersion: 1, semantic: "KAMA_3K_V25", minimumClosedBars: 120, evidence: ["v25/core.ts"] },
  { adapterId: "kama-3k-v35-portfolio", adapterVersion: 2, semantic: "KAMA_3K_V35", minimumClosedBars: 120, evidence: ["v35/entryGate.ts", "threeModePortfolioKernel.ts"] },
  { adapterId: "kama-3k-v41-portfolio", adapterVersion: 1, semantic: "KAMA_3K_V41", minimumClosedBars: 120, evidence: ["v41/entryConditions.ts", "v40PositionCore"] },
  { adapterId: "kama-3k-v50-portfolio", adapterVersion: 2, semantic: "KAMA_3K_V50", minimumClosedBars: 120, evidence: ["v50 strategy F1-F6", "threeModePortfolioKernel.ts"] },
  { adapterId: "kama-3k-v61-portfolio", adapterVersion: 2, semantic: "KAMA_3K_V61", minimumClosedBars: 120, evidence: ["v61 ATR/regime", "threeModePortfolioKernel.ts"] },
  { adapterId: "kama-3k-v70-portfolio", adapterVersion: 1, semantic: "KAMA_3K_V70", minimumClosedBars: 220, evidence: ["v70 MA200/KAMA/S-curve", "threeModePortfolioKernel.ts"] },
] satisfies Array<Omit<PortfolioStrategyAdapterRegistration, "registryVersion" | "supportedModes">>) {
  registerPortfolioStrategyAdapter({ ...value, supportedModes: ALL_MODES });
}
