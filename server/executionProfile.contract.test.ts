import { describe, expect, it } from "vitest";
import {
  createCanonicalExecutionProfile,
  withExecutionProfileMode,
} from "../shared/executionProfile";
import { KAMA_RAINBOW_MARTIN_STRATEGY_KEY } from "../shared/strategies/kamaRainbowMartin";

describe("canonical execution profile", () => {
  it("將策略、快照、交易市場與三模式政策組成無 credential 的安全 read model", () => {
    const sourceConfig = { threshold: 0, nested: { enabled: false }, layers: [{ level: 1 }] };
    const profile = createCanonicalExecutionProfile({
      source: { kind: "PARAMETER_SNAPSHOT", sourceSnapshotId: 88, sourceLabel: " M2 回測優選 " },
      strategyKey: " FUTURE_ENGINE_V99 ",
      strategyVersion: 4,
      strategyConfig: sourceConfig,
      exchange: "OKX",
      symbol: "btcusdt",
      timeframe: "30m",
      apiKeyId: 9,
      executionMode: "MULTI_POSITION",
      positionSize: 500,
      positionMode: "usdt",
      leverage: 10,
      tradeMode: "auto",
    });

    expect(profile).toMatchObject({
      contractVersion: "execution-profile-v1",
      source: { kind: "PARAMETER_SNAPSHOT", sourceSnapshotId: 88, sourceLabel: "M2 回測優選" },
      strategy: { key: "FUTURE_ENGINE_V99", version: 4, config: sourceConfig },
      market: { exchange: "okx", symbol: "BTCUSDT", timeframe: "30m" },
      account: { apiKeyId: 9 },
      execution: {
        mode: "MULTI_POSITION",
        policy: { mode: "MULTI_POSITION", isolateMartinByLeg: true, isolateExitByLeg: true },
      },
      deployment: { positionSize: 500, positionMode: "usdt", leverage: 10, tradeMode: "auto" },
    });
    expect(profile).not.toHaveProperty("apiKey");
    expect(profile).not.toHaveProperty("secret");
    (sourceConfig.layers[0] as { level: number }).level = 9;
    expect((profile.strategy.config.layers as Array<{ level: number }>)[0].level).toBe(1);
  });

  it("KRM 切換 H3 時重用策略感知契約並封印 4%／保護腿禁用馬丁", () => {
    const base = createCanonicalExecutionProfile({
      source: { kind: "STRATEGY_DEFINITION" },
      strategyKey: KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
      symbol: "BTCUSDT",
    });
    const h3 = withExecutionProfileMode(base, "HEDGE_GUARDED", {
      mode: "HEDGE_GUARDED",
      primaryLossTriggerPct: 15,
      hedgeMartinEnabled: true,
      hedgeRatio: 0.4,
    });
    expect(h3.execution.policy).toMatchObject({
      mode: "HEDGE_GUARDED",
      primaryLossTriggerPct: 4,
      hedgeMartinEnabled: false,
      hedgeRatio: 0.4,
    });
  });

  it("來源身份缺失時 fail closed", () => {
    expect(() => createCanonicalExecutionProfile({
      source: { kind: "PARAMETER_SNAPSHOT" },
      strategyKey: "ENGINE_A",
      symbol: "BTCUSDT",
    })).toThrow("sourceSnapshotId");
  });
});
