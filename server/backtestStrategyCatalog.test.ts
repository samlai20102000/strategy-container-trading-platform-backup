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
  });
});
