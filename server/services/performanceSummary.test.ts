import { describe, expect, it } from "vitest";
import {
  summarizeStrategyPerformance,
  type PerformanceTradeInput,
} from "./performanceSummary";

function trade(overrides: Partial<PerformanceTradeInput> = {}): PerformanceTradeInput {
  return {
    id: 1,
    executionId: "exec-1",
    exchangeTradeId: null,
    orderId: "order-1",
    reduceOnly: true,
    status: "filled",
    realizedPnl: "1",
    netRealizedPnl: null,
    reconciliationStatus: "confirmed",
    dataQuality: "exchange_confirmed",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

describe("summarizeStrategyPerformance 統一實盤勝率口徑", () => {
  it("不把開倉與加倉的零 PnL 當成負場", () => {
    const rows = [
      ...Array.from({ length: 114 }, (_, index) => trade({
        id: index + 1,
        executionId: `entry-exec-${index}`,
        orderId: `entry-order-${index}`,
        reduceOnly: false,
        realizedPnl: "0",
        dataQuality: "not_applicable",
      })),
      ...Array.from({ length: 90 }, (_, index) => trade({
        id: 1000 + index,
        executionId: `win-exec-${index}`,
        orderId: `win-order-${index}`,
        realizedPnl: "1",
      })),
      trade({ id: 2000, executionId: "loss-exec", orderId: "loss-order", realizedPnl: "-1" }),
      ...Array.from({ length: 24 }, (_, index) => trade({
        id: 3000 + index,
        executionId: `flat-exec-${index}`,
        orderId: `flat-order-${index}`,
        realizedPnl: "0",
      })),
    ];

    const summary = summarizeStrategyPerformance(rows);

    expect(summary).toMatchObject({
      closedTradeCount: 115,
      decisiveTradeCount: 91,
      wins: 90,
      losses: 1,
      breakevens: 24,
      excludedEntryCount: 114,
    });
    expect(summary.winRate).toBeCloseTo((90 / 91) * 100, 10);
  });

  it("排除 failed／cancelled／pending／unresolved，並分開揭示資料品質", () => {
    const summary = summarizeStrategyPerformance([
      trade({ id: 1, orderId: "failed", status: "failed", realizedPnl: "9" }),
      trade({ id: 2, orderId: "cancelled", status: "cancelled", realizedPnl: "8" }),
      trade({ id: 3, orderId: "pending", realizedPnl: null, reconciliationStatus: "pending" }),
      trade({ id: 4, orderId: "unresolved", realizedPnl: null, reconciliationStatus: "unresolved" }),
      trade({ id: 5, orderId: "win", realizedPnl: "2" }),
    ]);

    expect(summary).toMatchObject({
      closedTradeCount: 1,
      wins: 1,
      pendingPnlCount: 1,
      unresolvedPnlCount: 1,
      excludedNonFilledCloseCount: 2,
    });
    expect(summary.totalPnl).toBe(2);
  });

  it("以 fill／order 穩定識別去重，並優先採已確認的 netRealizedPnl", () => {
    const summary = summarizeStrategyPerformance([
      trade({
        id: 1,
        executionId: "exec-old",
        orderId: "same-order",
        realizedPnl: "10",
        reconciliationStatus: "not_required",
        dataQuality: "legacy_unresolved",
        createdAt: 1,
      }),
      trade({
        id: 2,
        executionId: "exec-new",
        orderId: "same-order",
        realizedPnl: "10",
        netRealizedPnl: "1.5",
        reconciliationStatus: "confirmed",
        dataQuality: "exchange_confirmed",
        createdAt: 2,
      }),
      trade({
        id: 3,
        executionId: "exec-fill-a",
        orderId: "multi-fill-order",
        exchangeTradeId: "fill-a",
        realizedPnl: "0.4",
      }),
      trade({
        id: 4,
        executionId: "exec-fill-b",
        orderId: "multi-fill-order",
        exchangeTradeId: "fill-b",
        realizedPnl: "0.6",
      }),
    ]);

    expect(summary).toMatchObject({
      closedTradeCount: 3,
      wins: 3,
      duplicateExcludedCount: 1,
    });
    expect(summary.totalPnl).toBeCloseTo(2.5, 10);
  });

  it("持平不進勝率分母，回撤仍依已實現平倉時間序列計算", () => {
    const summary = summarizeStrategyPerformance([
      trade({ id: 1, orderId: "one", realizedPnl: "2", createdAt: 1 }),
      trade({ id: 2, orderId: "two", realizedPnl: "0", createdAt: 2 }),
      trade({ id: 3, orderId: "three", realizedPnl: "-0.5", createdAt: 3 }),
    ]);

    expect(summary).toMatchObject({
      closedTradeCount: 3,
      decisiveTradeCount: 2,
      wins: 1,
      losses: 1,
      breakevens: 1,
      winRate: 50,
      maxDrawdown: 0.5,
    });
  });
});
