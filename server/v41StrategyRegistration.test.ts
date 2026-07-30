import { describe, expect, it } from "vitest";
import { getSchemaForStrategy, KAMA_3K_SCHEMA, KAMA_3K_V41_SCHEMA } from "./config/strategySchemas";
import { BUILT_IN_KEYS } from "./services/strategyStudio";
import type { MarketData, StrategyInstanceConfig, StrategySignal } from "./strategies/base";
import { StrategyKama3kV35 } from "./strategies/v35/strategy_kama_3k_v35";
import { StrategyKama3kV41 } from "./strategies/v41/strategy_kama_3k_v41";

function trendingMarket(): MarketData {
  return {
    lastPrice: 160,
    candles: Array.from({ length: 61 }, (_, index) => ({
      timestamp: index + 1,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1_000,
    })),
  };
}

function instance(config: Record<string, unknown>): StrategyInstanceConfig {
  return {
    id: 41,
    symbol: "BTCUSDT",
    direction: "both",
    positionSize: 30,
    leverage: 1,
    config: config as StrategyInstanceConfig["config"],
  };
}

const buySignal: StrategySignal = {
  action: "BUY",
  symbol: "BTCUSDT",
  price: 999_999,
  barTimestamp: 61,
};

describe("V4.1 獨立策略註冊與隔離", () => {
  it("保留全部既有 built-in key 並只追加 V4.1 key", () => {
    expect(BUILT_IN_KEYS.slice(0, 4)).toEqual([
      "strategy_20415",
      "RAINBOW_TREND_LADDER_V1",
      "KAMA_3K_BREAKOUT_V25",
      "20415_KAMA_MARTIN_V35",
    ]);
    expect(BUILT_IN_KEYS).toContain("20415_KAMA_MARTIN_V41");
  });

  it("V4.1 類別有獨立 key／version／0-3 AND 預設，V4.0 預設不變", () => {
    const v40 = new StrategyKama3kV35();
    const v41 = new StrategyKama3kV41();
    expect(v41.key).toBe("20415_KAMA_MARTIN_V41");
    expect(v41.version).toBe("4.1.0");
    expect(v41.defaultConfig).toMatchObject({
      strategyKey: "20415_KAMA_MARTIN_V41",
      configVersion: "4.1",
      entryConditionLogic: "and",
      enableThreeKFilter: false,
      enableKamaFastSlowCross: false,
      enableKamaPriceVsSlow: false,
    });
    expect(v40.defaultConfig).toMatchObject({
      enableThreeKFilter: true,
      threeKPatternMode: "breakout",
      enableKamaDirectionLock: true,
    });
    expect(v40.defaultConfig).not.toHaveProperty("entryConditionLogic");
  });

  it("schema dispatch 先精確命中 V4.1 且不污染 V4.0 schema", () => {
    expect(getSchemaForStrategy("20415_KAMA_MARTIN_V41")).toBe(KAMA_3K_V41_SCHEMA);
    expect(getSchemaForStrategy("20415_KAMA_MARTIN_V35")).toBe(KAMA_3K_SCHEMA);
    expect(KAMA_3K_V41_SCHEMA.fields).toHaveProperty("enableKamaFastSlowCross");
    expect(KAMA_3K_V41_SCHEMA.fields).toHaveProperty("enableKamaPriceVsSlow");
    expect(KAMA_3K_V41_SCHEMA.fields).not.toHaveProperty("threeKPatternMode");
    expect(KAMA_3K_SCHEMA.fields).not.toHaveProperty("entryConditionLogic");
  });

  it("新空白 0/3 在策略類別 fail-closed", async () => {
    const strategy = new StrategyKama3kV41();
    const result = await strategy.validateSignal(buySignal, trendingMarket(), instance({
      __v41Config: strategy.defaultConfig.__v41Config,
    }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("V41_NO_ENTRY_CONDITION_ENABLED");
  });

  it("策略類別使用已收盤 candle close 與本地 KAMA，不使用 signal.price", async () => {
    const strategy = new StrategyKama3kV41();
    const config = {
      ...(strategy.defaultConfig.__v41Config as Record<string, unknown>),
      enableKamaPriceVsSlow: true,
    };
    const result = await strategy.validateSignal(buySignal, trendingMarket(), instance({ __v41Config: config }));
    expect(result.valid).toBe(true);
    expect(result.reason).toContain("V41_ENTRY_OPEN");
  });
});
