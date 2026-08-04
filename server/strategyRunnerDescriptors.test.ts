import { describe, expect, it } from "vitest";
import {
  BUILT_IN_STRATEGY_KEYS,
  STRATEGY_RUNNER_DESCRIPTOR_VERSION,
  assertCompleteBuiltInDescriptorRegistry,
  assertStrategyRunnerDescriptor,
  getStrategyChannelCapabilities,
  getStrategyRunnerDescriptor,
  listBuiltInStrategyRunnerDescriptors,
  type StrategyRunnerDescriptor,
} from "./services/strategyRunnerDescriptors";
import {
  createPortfolioStrategyRuntimeAdapter,
  listExecutablePortfolioAdapterIds,
  listPortfolioStrategyAdapters,
  resolvePortfolioStrategyAdapter,
} from "./services/backtest/portfolioStrategyAdapterRegistry";
import { ensureBuiltInPortfolioRuntimeFactoriesRegistered } from "./services/backtest/builtInPortfolioRuntimeFactories";
import { createDefaultExecutionPolicy, type ExecutionMode } from "../shared/executionModes";
import {
  V41_CONFIG_KEY,
  V41_STRATEGY_KEY,
} from "../shared/strategies/kama3kMartinV41";
import { getStrategy, initStrategyStudio } from "./services/strategyStudio";

function testCandles(count = 240) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + Math.sin(index / 7) * 3 + index * 0.01;
    return {
      timestamp: 1_700_000_000_000 + index * 60_000,
      open: close - 0.1,
      high: close + 0.4,
      low: close - 0.4,
      close,
      volume: 100 + index,
    };
  });
}

describe("strategy runner descriptors", () => {
  it("每一個內建策略都有唯一 descriptor，KRM 僅認證 S1，其餘維持既有能力", () => {
    expect(() => assertCompleteBuiltInDescriptorRegistry()).not.toThrow();
    expect(listBuiltInStrategyRunnerDescriptors().map(item => item.strategyKey)).toEqual(BUILT_IN_STRATEGY_KEYS);
    for (const key of BUILT_IN_STRATEGY_KEYS) {
      const descriptor = getStrategyRunnerDescriptor(key);
      expect(descriptor?.contractVersion).toBe(STRATEGY_RUNNER_DESCRIPTOR_VERSION);
      expect(getStrategyChannelCapabilities(key, "BACKTEST").supportedModes).toEqual(
        key === "KAMA_RAINBOW_MARTIN_V1"
          ? ["SINGLE_EXCLUSIVE"]
          : ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"],
      );
    }
  });

  it("KRM 的 BACKTEST／SIMULATION／LIVE 三個 channel 全部凍結 M2／H3", () => {
    for (const channel of ["BACKTEST", "SIMULATION", "LIVE"] as const) {
      const capabilities = getStrategyChannelCapabilities("KAMA_RAINBOW_MARTIN_V1", channel);
      expect(capabilities.supportedModes).toEqual(["SINGLE_EXCLUSIVE"]);
      expect(capabilities.independentLegState).toBe(false);
      expect(capabilities.preciseLegClose).toBe(false);
      expect(capabilities.hedgeGuard).toBe(false);
      expect(capabilities.reason).toContain("方案 B");
    }
  });

  it("V4.1 回測已認證 M2／H3，但不會把尚未接入的實盤能力誤標為已認證", () => {
    expect(getStrategyChannelCapabilities("20415_KAMA_MARTIN_V41", "BACKTEST").supportedModes).toContain("MULTI_POSITION");
    expect(getStrategyChannelCapabilities("20415_KAMA_MARTIN_V41", "BACKTEST").supportedModes).toContain("HEDGE_GUARDED");
    expect(getStrategyChannelCapabilities("20415_KAMA_MARTIN_V41", "LIVE").supportedModes).toEqual(["SINGLE_EXCLUSIVE"]);
  });

  it("未來策略若未註冊 descriptor，安全降級為 S1 而非假裝支援進階模式", () => {
    const capabilities = getStrategyChannelCapabilities("FUTURE_STRATEGY", "BACKTEST", true);
    expect(capabilities.supportedModes).toEqual(["SINGLE_EXCLUSIVE"]);
    expect(capabilities.reason).toContain("尚未註冊");
  });

  it("拒絕沒有認證證據的未來策略 descriptor", () => {
    const invalid = {
      contractVersion: STRATEGY_RUNNER_DESCRIPTOR_VERSION,
      strategyKey: "FUTURE_STRATEGY",
      strategyVersion: 1,
      logicRevision: "future-v1",
      adapterId: "future-adapter",
      adapterVersion: 1,
      martingaleLayers: false,
      independentLegState: true,
      preciseLegClose: true,
      hedgeGuard: true,
      certifications: {
        BACKTEST: { status: "CERTIFIED", supportedModes: ["SINGLE_EXCLUSIVE"], reason: "test", evidence: [] },
        SIMULATION: { status: "CERTIFIED", supportedModes: ["SINGLE_EXCLUSIVE"], reason: "test", evidence: ["test"] },
        LIVE: { status: "CERTIFIED", supportedModes: ["SINGLE_EXCLUSIVE"], reason: "test", evidence: ["test"] },
      },
    } as StrategyRunnerDescriptor;
    expect(() => assertStrategyRunnerDescriptor(invalid)).toThrow("缺少認證證據");
  });

  it("每個內建 descriptor 都有版本一致且涵蓋全部回測模式的 portfolio adapter", () => {
    const adapters = listPortfolioStrategyAdapters();
    expect(new Set(adapters.map(item => item.adapterId)).size).toBe(adapters.length);

    for (const descriptor of listBuiltInStrategyRunnerDescriptors()) {
      for (const mode of ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"] as const) {
        if (descriptor.certifications.BACKTEST.supportedModes.includes(mode)) {
          const resolved = resolvePortfolioStrategyAdapter(descriptor.strategyKey, mode);
          expect(resolved.adapter.adapterId).toBe(descriptor.adapterId);
          expect(resolved.adapter.adapterVersion).toBe(descriptor.adapterVersion);
          expect(resolved.adapter.supportedModes).toContain(mode);
        } else {
          expect(() => resolvePortfolioStrategyAdapter(descriptor.strategyKey, mode))
            .toThrow("BACKTEST_MODE_NOT_CERTIFIED");
        }
      }
    }
  });

  it("每個內建策略的定義、預設參數與 S1／M2／H3 executable runtime 都齊全", async () => {
    await initStrategyStudio();
    ensureBuiltInPortfolioRuntimeFactoriesRegistered();
    const executableIds = new Set(listExecutablePortfolioAdapterIds());
    const candles = testCandles();

    for (const descriptor of listBuiltInStrategyRunnerDescriptors()) {
      const strategy = getStrategy(descriptor.strategyKey);
      expect(strategy, `${descriptor.strategyKey} 缺少策略實例`).toBeDefined();
      expect(strategy?.defaultConfig, `${descriptor.strategyKey} 缺少預設參數快照`).toBeDefined();
      expect(executableIds.has(descriptor.adapterId), `${descriptor.adapterId} 缺少 executable factory`).toBe(true);

      for (const mode of descriptor.certifications.BACKTEST.supportedModes satisfies readonly ExecutionMode[]) {
        const executionPolicy = createDefaultExecutionPolicy(mode);
        const resolved = resolvePortfolioStrategyAdapter(descriptor.strategyKey, mode);
        const runtimeConfig = descriptor.strategyKey === V41_STRATEGY_KEY
          ? {
              ...strategy!.defaultConfig,
              enableKamaFastSlowCross: true,
              [V41_CONFIG_KEY]: {
                ...((strategy!.defaultConfig[V41_CONFIG_KEY] ?? {}) as Record<string, unknown>),
                enableKamaFastSlowCross: true,
              },
            }
          : strategy!.defaultConfig;
        const runtime = createPortfolioStrategyRuntimeAdapter(resolved, {
          strategy: strategy!,
          config: runtimeConfig,
          candles,
          executionPolicy,
          initialCapital: 10_000,
          baseLotUsdt: 100,
        });
        expect(runtime.adapterId).toBe(descriptor.adapterId);
        expect(runtime.adapterVersion).toBe(descriptor.adapterVersion);

        const decision = await runtime.evaluateBar({
          index: candles.length - 1,
          timestamp: candles.at(-1)!.timestamp,
          candle: candles.at(-1)!,
          previousCandle: (offset) => candles[candles.length - 1 - offset],
          config: runtimeConfig,
          strategy: strategy!,
          executionMode: mode,
          executionPolicy,
          initialCapital: 10_000,
          baseLotUsdt: 100,
          openLegs: [],
          indicators: { kamaFast: 101, kamaSlow: 100, atr: 1, atrAverage: 1 },
          consecutiveLosses: 0,
          closedTradeCount: 0,
        });
        expect(Array.isArray(decision.management)).toBe(true);
        expect(Array.isArray(decision.entries)).toBe(true);
      }
    }
  });

  it("未註冊 descriptor 的未來策略不可落入 generic portfolio runner", () => {
    expect(() => resolvePortfolioStrategyAdapter("FUTURE_UNREGISTERED", "MULTI_POSITION"))
      .toThrow("RUNNER_DESCRIPTOR_MISSING");
  });
});
