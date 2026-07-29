import { describe, expect, it } from "vitest";
import { getStrategyApiIdentity } from "../client/src/lib/strategyApiIdentity";

describe("strategy API identity display contract", () => {
  const strategy = { apiKeyId: 7, exchange: "okx" };

  it("shows the real safe API label and demo environment for a bound strategy", () => {
    expect(getStrategyApiIdentity(strategy, [{
      id: 7,
      label: "samlai01",
      exchange: "okx",
      isTestnet: true,
    }])).toEqual({
      status: "resolved",
      displayName: "OKX 模擬｜samlai01",
      exchangeLabel: "OKX",
      environmentLabel: "模擬",
      accountLabel: "samlai01",
    });
  });

  it("uses the API account exchange and marks a live account as formal", () => {
    expect(getStrategyApiIdentity(strategy, [{
      id: 7,
      label: "main-live",
      exchange: "bybit",
      isTestnet: false,
    }]).displayName).toBe("BYBIT 正式｜main-live");
  });

  it("returns explicit loading and missing states instead of hiding the binding", () => {
    expect(getStrategyApiIdentity(strategy, undefined)).toMatchObject({
      status: "loading",
      displayName: "OKX｜API 資料載入中",
    });
    expect(getStrategyApiIdentity(strategy, [])).toMatchObject({
      status: "missing",
      displayName: "OKX｜API #7 未找到",
    });
  });

  it("falls back to the non-secret API id when a legacy account label is blank", () => {
    expect(getStrategyApiIdentity(strategy, [{
      id: 7,
      label: "   ",
      exchange: "okx",
      isTestnet: true,
    }]).displayName).toBe("OKX 模擬｜API #7");
  });
});
