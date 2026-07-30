import { describe, expect, it } from "vitest";
import {
  createV41DefaultConfig,
  getV41ConfigHash,
  V41_STRATEGY_KEY,
} from "../shared/strategies/kama3kMartinV41";
import { normalizeSnapshotConfigForStrategy } from "./routers/backtest.router";

function executableConfig() {
  return {
    ...createV41DefaultConfig(),
    entryConditionLogic: "or" as const,
    enableThreeKFilter: true,
    enableKamaFastSlowCross: false,
    enableKamaPriceVsSlow: false,
  };
}

describe("V4.1 快照路由 strict canonical 契約", () => {
  it("合法 V4.1 配置保存前後 hash 與顯式 false 不變", () => {
    const config = executableConfig();
    const normalized = normalizeSnapshotConfigForStrategy(V41_STRATEGY_KEY, config);
    expect(getV41ConfigHash(normalized as typeof config)).toBe(getV41ConfigHash(config));
    expect(normalized).toMatchObject({
      strategyKey: V41_STRATEGY_KEY,
      entryConditionLogic: "or",
      enableKamaFastSlowCross: false,
      enableKamaPriceVsSlow: false,
    });
  });

  it("錯誤 strategyKey 的 V4.1 配置必須拒絕", () => {
    expect(() => normalizeSnapshotConfigForStrategy(V41_STRATEGY_KEY, {
      ...executableConfig(),
      strategyKey: "20415_KAMA_MARTIN_V35",
    })).toThrow("V4.1快照參數錯誤");
  });

  it("0/3 草稿不可保存為可執行快照", () => {
    expect(() => normalizeSnapshotConfigForStrategy(
      V41_STRATEGY_KEY,
      createV41DefaultConfig(),
    )).toThrow("V41_NO_ENTRY_CONDITION_ENABLED");
  });

  it("未知策略仍保留原始配置，不套用 V4.1 schema", () => {
    const raw = { futureFlag: false, threshold: 0 };
    expect(normalizeSnapshotConfigForStrategy("FUTURE_ENGINE_V99", raw)).toEqual(raw);
  });
});
