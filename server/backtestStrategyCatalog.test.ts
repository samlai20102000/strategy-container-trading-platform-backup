import { describe, expect, it } from "vitest";

import { KAMA_RAINBOW_MARTIN_STRATEGY_KEY } from "../shared/strategies/kamaRainbowMartin";
import { getBacktestStrategyCatalog } from "./services/backtest/backtestStrategyCatalog";
import { initStrategyStudio } from "./services/strategyStudio";

describe("KRM backtest catalog capability projection", () => {
  it("publishes S1 only to the backtest UI fallback catalog", async () => {
    await initStrategyStudio();
    const catalog = await getBacktestStrategyCatalog();
    const krm = catalog.find(entry => entry.key === KAMA_RAINBOW_MARTIN_STRATEGY_KEY);

    expect(krm).toBeDefined();
    expect(krm?.backtestCapabilityManifest.certification).toBe("CERTIFIED");
    expect(krm?.backtestModeCapabilities.supportedModes).toEqual(["SINGLE_EXCLUSIVE"]);
    expect(krm?.backtestModeCapabilities.independentLegState).toBe(false);
    expect(krm?.backtestModeCapabilities.preciseLegClose).toBe(false);
    expect(krm?.backtestModeCapabilities.hedgeGuard).toBe(false);
    expect(krm?.readiness?.strategyKey).toBe(KAMA_RAINBOW_MARTIN_STRATEGY_KEY);
    expect(krm?.readiness?.readiness).toBe("READY");
    expect(krm?.readiness?.supportedModes).toEqual(["SINGLE_EXCLUSIVE"]);
  });

  it("projects the complete audited 9/9 readiness matrix into the fallback catalog", async () => {
    await initStrategyStudio();
    const catalog = await getBacktestStrategyCatalog();
    const audited = catalog.filter(entry => entry.readiness !== null);

    expect(audited).toHaveLength(9);
    expect(new Set(audited.map(entry => entry.readiness?.strategyKey)).size).toBe(9);
    for (const entry of audited) {
      expect(entry.readiness?.contractVersion).toBe("backtest-readiness-v1");
      expect(entry.readiness?.strategyKey).toBe(entry.key);
      expect(entry.readiness?.minimumClosedBars).toBeGreaterThan(0);
      expect(entry.readiness?.dataRequirements.length).toBeGreaterThan(0);
      expect(entry.readiness?.baselineOracleTargets.length).toBeGreaterThan(0);
    }
  });
});
