import { describe, expect, it } from "vitest";
import {
  V41_CONFIG_VERSION,
  V41_STRATEGY_KEY,
  assertValidV41Config,
  convertV40ToV41Draft,
  countEnabledV41EntryConditions,
  createV41DefaultConfig,
  getV41ConfigHash,
  normalizeV41Config,
  validateV41Config,
} from "../shared/strategies/kama3kMartinV41";

describe("V4.1 KAMA+3K canonical 配置契約", () => {
  it("使用獨立策略身份，空白草稿為 AND、0/3 且重入關閉", () => {
    const config = createV41DefaultConfig();
    expect(V41_STRATEGY_KEY).toBe("20415_KAMA_MARTIN_V41");
    expect(config.strategyKey).toBe(V41_STRATEGY_KEY);
    expect(config.configVersion).toBe(V41_CONFIG_VERSION);
    expect(config.entryConditionLogic).toBe("and");
    expect(countEnabledV41EntryConditions(config)).toBe(0);
    expect(config.enableSameDirectionReentry).toBe(false);
  });

  it("0/3 草稿可顯示但嚴格提交驗證 fail-closed", () => {
    const result = validateV41Config(createV41DefaultConfig());
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      path: "entryConditions",
      message: expect.stringContaining("V41_NO_ENTRY_CONDITION_ENABLED"),
    }));
  });

  it("嚴格提交拒絕未知欄位、缺欄位及錯誤版本", () => {
    const valid = { ...createV41DefaultConfig(), enableKamaPriceVsSlow: true };
    expect(validateV41Config({ ...valid, hiddenPriceGate: true }).valid).toBe(false);
    const { threeKMode: _removed, ...missing } = valid;
    expect(validateV41Config(missing).valid).toBe(false);
    expect(validateV41Config({ ...valid, configVersion: "4.0" }).valid).toBe(false);
  });

  it("normalizer 保留明確 false／0 字串且不使用 truthy 行為", () => {
    const normalized = normalizeV41Config({
      enableThreeKFilter: "false",
      enableKamaFastSlowCross: "0",
      enableKamaPriceVsSlow: "1",
      enableSameDirectionReentry: 0,
      entryConditionLogic: "or",
    });
    expect(normalized.enableThreeKFilter).toBe(false);
    expect(normalized.enableKamaFastSlowCross).toBe(false);
    expect(normalized.enableKamaPriceVsSlow).toBe(true);
    expect(normalized.enableSameDirectionReentry).toBe(false);
    expect(normalized.entryConditionLogic).toBe("or");
  });

  it("V4.0 僅經顯式動作轉為 V4.1 AND 草稿，不暗中啟用快慢線條件", () => {
    const converted = convertV40ToV41Draft({
      enableThreeKFilter: false,
      threeKPatternMode: "three_body_same_direction",
      enableKamaDirectionLock: true,
      enableSameDirectionReentry: true,
      Base_Lot_Size: 88,
    });
    expect(converted.entryConditionLogic).toBe("and");
    expect(converted.enableThreeKFilter).toBe(false);
    expect(converted.threeKMode).toBe("three_body_same_direction");
    expect(converted.enableKamaFastSlowCross).toBe(false);
    expect(converted.enableKamaPriceVsSlow).toBe(true);
    expect(converted.enableSameDirectionReentry).toBe(true);
    expect(converted.Base_Lot_Size).toBe(88);
    expect(assertValidV41Config(converted)).toEqual(converted);
  });

  it("V4.0 兩 gate 均關閉時轉換後仍為非法 0/3 草稿", () => {
    const converted = convertV40ToV41Draft({
      enableThreeKFilter: false,
      enableKamaDirectionLock: false,
    });
    expect(countEnabledV41EntryConditions(converted)).toBe(0);
    expect(validateV41Config(converted).valid).toBe(false);
  });

  it("JSON round-trip 與物件鍵順序不改變配置 hash", () => {
    const config = {
      ...createV41DefaultConfig(),
      enableKamaFastSlowCross: true,
      entryConditionLogic: "or" as const,
    };
    const reordered = Object.fromEntries(Object.entries(config).reverse());
    const roundTrip = JSON.parse(JSON.stringify(config));
    expect(getV41ConfigHash(config)).toBe(getV41ConfigHash(roundTrip));
    expect(getV41ConfigHash(config)).toBe(getV41ConfigHash(reordered as typeof config));
  });

  it("預設物件與新草稿的馬丁陣列彼此隔離", () => {
    const first = createV41DefaultConfig();
    const second = createV41DefaultConfig();
    first.Martin_Layers[0].multiplier = 4;
    expect(second.Martin_Layers[0].multiplier).toBe(1.5);
  });
});
