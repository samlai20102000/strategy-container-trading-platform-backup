import { afterEach, describe, expect, it } from "vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPortfolioStrategyRuntimeAdapter,
  registerPortfolioStrategyRuntimeFactory,
  resolvePortfolioStrategyAdapter,
  unregisterPortfolioStrategyRuntimeFactory,
} from "./services/backtest/portfolioStrategyAdapterRegistry";
import { ensureBuiltInPortfolioRuntimeFactoriesRegistered } from "./services/backtest/builtInPortfolioRuntimeFactories";

describe("portfolio strategy runtime adapter boundary", () => {
  const adapterId = "kama-3k-v41-portfolio";

  beforeEach(() => ensureBuiltInPortfolioRuntimeFactoriesRegistered());
  afterEach(() => ensureBuiltInPortfolioRuntimeFactoriesRegistered());

  it("沒有 executable factory 時 fail explicit，不會落入 generic 指標策略", () => {
    unregisterPortfolioStrategyRuntimeFactory(adapterId);
    const resolved = resolvePortfolioStrategyAdapter("20415_KAMA_MARTIN_V41", "MULTI_POSITION");
    expect(() => createPortfolioStrategyRuntimeAdapter(resolved, {
      strategy: {} as never,
      config: {},
      candles: [],
      executionPolicy: {
        mode: "MULTI_POSITION",
        grossExposureCapPct: 100,
        marginUsageCapPct: 40,
        capabilityTtlSeconds: 60,
        hedge: { reverseSignalBehavior: "WAIT_FOR_FLAT", triggerLossPct: 3, targetRatio: 0.5, unwindRecoveryPct: 1 },
      },
      initialCapital: 10_000,
      baseLotUsdt: 100,
    })).toThrow("PORTFOLIO_ADAPTER_IMPLEMENTATION_MISSING");
  });

  it("runtime factory 必須與 descriptor／metadata 版本完全一致", () => {
    expect(() => registerPortfolioStrategyRuntimeFactory(adapterId, 99, () => ({
      adapterId,
      adapterVersion: 99,
      ownsPositionManagement: false,
      evaluateBar: () => ({ management: [], entries: [] }),
    }))).toThrow("PORTFOLIO_RUNTIME_FACTORY_VERSION_MISMATCH");
  });
});
