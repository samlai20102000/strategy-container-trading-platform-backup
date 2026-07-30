import { describe, expect, it } from "vitest";
import { createV41DefaultConfig } from "../shared/strategies/kama3kMartinV41";
import {
  evaluateV41EntryConditions,
  evaluateV41SameDirectionReentry,
  type V41ClosedBar,
  type V41EntryEvaluationInput,
} from "./strategies/v41/entryConditions";

const longBreakoutBars: V41ClosedBar[] = [
  { open: 100, high: 103, low: 99, close: 102, timestamp: 1 },
  { open: 102, high: 105, low: 101, close: 104, timestamp: 2 },
  { open: 103, high: 107, low: 102, close: 105, timestamp: 3 },
];

const shortBreakoutBars: V41ClosedBar[] = [
  { open: 105, high: 106, low: 102, close: 103, timestamp: 1 },
  { open: 103, high: 104, low: 100, close: 101, timestamp: 2 },
  { open: 102, high: 103, low: 98, close: 100, timestamp: 3 },
];

function input(overrides: Partial<V41EntryEvaluationInput> = {}): V41EntryEvaluationInput {
  return {
    config: { ...createV41DefaultConfig(), enableThreeKFilter: true },
    closedBars: longBreakoutBars,
    decisionBarTimestamp: 3,
    decisionClose: 105,
    fastKama: 104,
    slowKama: 103,
    allowedDirection: "both",
    ...overrides,
  };
}

describe("V4.1 三條件 AND／OR 純 evaluator", () => {
  it("0/3 配置在 runtime fail-closed", () => {
    const result = evaluateV41EntryConditions(input({ config: createV41DefaultConfig() }));
    expect(result.decision).toBe("hold");
    expect(result.primaryReasonCode).toBe("V41_NO_ENTRY_CONDITION_ENABLED");
  });

  it("breakout 保留 V4.0 前二同向＋第三收盤破位定義", () => {
    const result = evaluateV41EntryConditions(input());
    expect(result.decision).toBe("open");
    expect(result.direction).toBe("long");
    expect(result.votes[0]).toMatchObject({ condition: "three_k", status: "long" });
  });

  it("three_body_same_direction 可投出做空票", () => {
    const config = {
      ...createV41DefaultConfig(),
      enableThreeKFilter: true,
      threeKMode: "three_body_same_direction" as const,
    };
    const result = evaluateV41EntryConditions(input({ config, closedBars: shortBreakoutBars, decisionClose: 100 }));
    expect(result.decision).toBe("open");
    expect(result.direction).toBe("short");
  });

  it("三 K 資料不足不論 AND／OR 均 HOLD", () => {
    for (const logic of ["and", "or"] as const) {
      const config = { ...createV41DefaultConfig(), enableThreeKFilter: true, entryConditionLogic: logic };
      const result = evaluateV41EntryConditions(input({ config, closedBars: longBreakoutBars.slice(0, 2) }));
      expect(result.primaryReasonCode).toBe("V41_BAR_DATA_UNAVAILABLE");
    }
  });

  it("Fast／Slow 相等在 AND 模式阻擋入場", () => {
    const config = {
      ...createV41DefaultConfig(),
      enableThreeKFilter: true,
      enableKamaFastSlowCross: true,
    };
    const result = evaluateV41EntryConditions(input({ config, fastKama: 103, slowKama: 103 }));
    expect(result.decision).toBe("hold");
    expect(result.primaryReasonCode).toBe("V41_AND_WAITING_FOR_ALL");
    expect(result.votes[1].reasonCode).toBe("V41_FAST_SLOW_EQUAL");
  });

  it("Price 等於 Slow KAMA 在 OR 模式不產生方向", () => {
    const config = {
      ...createV41DefaultConfig(),
      entryConditionLogic: "or" as const,
      enableKamaPriceVsSlow: true,
    };
    const result = evaluateV41EntryConditions(input({ config, decisionClose: 103, slowKama: 103 }));
    expect(result.decision).toBe("hold");
    expect(result.primaryReasonCode).toBe("V41_OR_NO_DIRECTION");
    expect(result.votes[2].reasonCode).toBe("V41_PRICE_EQUALS_SLOW");
  });

  it("AND 要求所有票有方向且一致", () => {
    const config = {
      ...createV41DefaultConfig(),
      enableThreeKFilter: true,
      enableKamaFastSlowCross: true,
    };
    const pass = evaluateV41EntryConditions(input({ config, fastKama: 104, slowKama: 103 }));
    const wait = evaluateV41EntryConditions(input({ config, fastKama: 103, slowKama: 103 }));
    expect(pass.direction).toBe("long");
    expect(wait.primaryReasonCode).toBe("V41_AND_WAITING_FOR_ALL");
  });

  it("OR 忽略 no_signal，保留唯一有效方向票", () => {
    const config = {
      ...createV41DefaultConfig(),
      entryConditionLogic: "or" as const,
      enableThreeKFilter: true,
      enableKamaFastSlowCross: true,
    };
    const result = evaluateV41EntryConditions(input({ config, fastKama: 103, slowKama: 103 }));
    expect(result.decision).toBe("open");
    expect(result.direction).toBe("long");
  });

  it("OR 出現 long／short 衝突時決定性 HOLD", () => {
    const config = {
      ...createV41DefaultConfig(),
      entryConditionLogic: "or" as const,
      enableThreeKFilter: true,
      enableKamaFastSlowCross: true,
    };
    const result = evaluateV41EntryConditions(input({ config, fastKama: 102, slowKama: 103 }));
    expect(result.decision).toBe("hold");
    expect(result.primaryReasonCode).toBe("V41_DIRECTION_CONFLICT");
  });

  it("OR 任一啟用條件 data_unavailable 仍 fail-closed", () => {
    const config = {
      ...createV41DefaultConfig(),
      entryConditionLogic: "or" as const,
      enableThreeKFilter: true,
      enableKamaFastSlowCross: true,
    };
    const result = evaluateV41EntryConditions(input({ config, fastKama: null }));
    expect(result.decision).toBe("hold");
    expect(result.primaryReasonCode).toBe("V41_KAMA_DATA_UNAVAILABLE");
  });

  it("Price 條件只使用明確傳入的已收盤 decisionClose", () => {
    const config = { ...createV41DefaultConfig(), enableKamaPriceVsSlow: true };
    const long = evaluateV41EntryConditions(input({ config, decisionClose: 105, slowKama: 103 }));
    const short = evaluateV41EntryConditions(input({ config, decisionClose: 101, slowKama: 103 }));
    expect(long.direction).toBe("long");
    expect(short.direction).toBe("short");
    expect(short.decisionClose).toBe(101);
  });

  it("方向限制只在三票合併後套用", () => {
    const result = evaluateV41EntryConditions(input({ allowedDirection: "short" }));
    expect(result.decision).toBe("hold");
    expect(result.primaryReasonCode).toBe("V41_DIRECTION_NOT_ALLOWED");
  });

  it("外部要求方向只在三票合併後套用且不一致時 HOLD", () => {
    const result = evaluateV41EntryConditions(input({ requestedDirection: "short" }));
    expect(result.decision).toBe("hold");
    expect(result.primaryReasonCode).toBe("V41_REQUEST_DIRECTION_MISMATCH");
  });

  it("不修改輸入配置或 K 棒，保持 evaluator 無副作用", () => {
    const value = input();
    const before = JSON.stringify(value);
    evaluateV41EntryConditions(value);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("完整輸出策略身份、hash、逐票與決策棒證據", () => {
    const result = evaluateV41EntryConditions(input());
    expect(result.strategyKey).toBe("20415_KAMA_MARTIN_V41");
    expect(result.configVersion).toBe("4.1");
    expect(result.configHash).toMatch(/^v41-fnv1a32-/);
    expect(result.votes).toHaveLength(3);
    expect(result.decisionBarTimestamp).toBe(3);
  });
});

describe("V4.1 特殊原地重入安全語義", () => {
  it("只啟用三 K 時拒絕重入，避免重用過期事件票", () => {
    const config = {
      ...createV41DefaultConfig(),
      enableThreeKFilter: true,
      enableSameDirectionReentry: true,
    };
    const result = evaluateV41SameDirectionReentry({ ...input({ config }), originalDirection: "long" });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("V41_REENTRY_REQUIRES_CONTINUOUS_CONDITION");
  });

  it("重入開關關閉時明確拒絕", () => {
    const config = { ...createV41DefaultConfig(), enableKamaFastSlowCross: true };
    const result = evaluateV41SameDirectionReentry({ ...input({ config }), originalDirection: "long" });
    expect(result.reasonCode).toBe("V41_REENTRY_DISABLED");
  });

  it("KAMA 持續方向仍支持原方向時允許進入後續安全檢查", () => {
    const config = {
      ...createV41DefaultConfig(),
      enableThreeKFilter: true,
      enableKamaFastSlowCross: true,
      enableSameDirectionReentry: true,
    };
    const result = evaluateV41SameDirectionReentry({
      ...input({ config, fastKama: 104, slowKama: 103 }),
      originalDirection: "long",
    });
    expect(result.allowed).toBe(true);
    expect(result.continuousDecision?.direction).toBe("long");
  });

  it("持續方向與原方向相反時拒絕重入", () => {
    const config = {
      ...createV41DefaultConfig(),
      enableKamaPriceVsSlow: true,
      enableSameDirectionReentry: true,
    };
    const result = evaluateV41SameDirectionReentry({
      ...input({ config, decisionClose: 101, slowKama: 103 }),
      originalDirection: "long",
    });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("V41_REENTRY_DIRECTION_NOT_SUPPORTED");
  });
});
