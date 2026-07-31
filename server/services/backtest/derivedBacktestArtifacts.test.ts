import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runBacktest: vi.fn(),
}));

vi.mock("./backtestEngine", () => ({
  backtestEngine: { runBacktest: mocks.runBacktest },
}));

import { runOptimization } from "./optimizer";
import { runMultiSymbolBacktest } from "./multiSymbolEngine";

const metrics = {
  totalReturn: 12.5,
  winRate: 60,
  sharpeRatio: 1.4,
  profitFactor: 1.8,
  calmarRatio: 1.2,
  maxDrawdown: 4,
  totalTrades: 10,
};

const execution = {
  executionMode: "HEDGE_GUARDED",
  comparisonGroupId: "comparison:derived-artifact",
  engineVersion: "backtest-engine-v3",
};
const modeResults = {
  executionMode: "HEDGE_GUARDED",
  fairComparisonEligible: true,
  hedgeCost: 2.5,
};
const legAccounting = {
  executionMode: "HEDGE_GUARDED",
  legs: [{ legId: "primary", role: "PRIMARY", realizedPnl: 15 }],
  hedgeRelationships: [{ relationshipId: "hedge-1", pairPnl: 12.5 }],
};

function makeResult(runId: string) {
  return {
    runId,
    metrics,
    execution,
    modeResults,
    legAccounting,
  };
}

describe("衍生回測 finalized 三模式 artifact", () => {
  beforeEach(() => {
    mocks.runBacktest.mockReset();
  });

  it("同步優化應保留每個參數組合的 finalized artifact", async () => {
    mocks.runBacktest.mockResolvedValue(makeResult("opt-1"));

    const summary = await runOptimization({
      baseRequest: {
        strategyKey: "KAMA_3K_HF_V61",
        symbol: "BTC-USDT-SWAP",
        timeframe: "15m",
        startDate: 1,
        endDate: 2,
        initialCapital: 10_000,
        config: {},
        executionMode: "HEDGE_GUARDED",
        executionPolicy: { mode: "HEDGE_GUARDED" },
      },
      parameterRanges: [{ name: "KAMA_Fast_Length", min: 21, max: 21, step: 1 }],
      objective: "totalReturn",
    });

    expect(mocks.runBacktest).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: "HEDGE_GUARDED",
      executionPolicy: { mode: "HEDGE_GUARDED" },
    }));
    expect(summary.best).toMatchObject({ execution, modeResults, legAccounting });
  });

  it("多商品回測應逐商品保留 finalized artifact", async () => {
    mocks.runBacktest
      .mockResolvedValueOnce(makeResult("multi-btc"))
      .mockResolvedValueOnce(makeResult("multi-eth"));

    const summary = await runMultiSymbolBacktest(
      ["BTC-USDT-SWAP", "ETH-USDT-SWAP"],
      {
        strategyKey: "KAMA_3K_HF_V61",
        timeframe: "15m",
        startDate: 1,
        endDate: 2,
        initialCapital: 10_000,
        config: {},
        executionMode: "HEDGE_GUARDED",
        executionPolicy: { mode: "HEDGE_GUARDED" },
      },
    );

    expect(mocks.runBacktest).toHaveBeenCalledTimes(2);
    expect(summary.results).toHaveLength(2);
    for (const result of summary.results) {
      expect(result).toMatchObject({ success: true, execution, modeResults, legAccounting });
    }
  });
});
