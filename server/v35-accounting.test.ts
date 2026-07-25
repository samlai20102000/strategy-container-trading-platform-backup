import { describe, expect, it } from "vitest";
import { formatPnlAmount } from "../shared/pnl";
import { loadStrategyState } from "./services/strategyStateManager";
import { summarizeStrategyPerformance } from "./services/performanceSummary";
import { calculateV35RealizedPnl } from "./services/v35Accounting";

describe("V4/V35 盈虧與狀態閉環", () => {
  it("新策略沒有 martinState 時回傳完整初始狀態", () => {
    const state = loadStrategyState({ martinState: null } as any);
    expect(state).toMatchObject({
      currentLayer: 0,
      totalSize: 0,
      avgPrice: 0,
      totalCost: 0,
      isTrailingActivated: false,
      isCooldown: false,
    });
  });

  it("多單與空單平倉依方向正確計算 realizedPnl", () => {
    expect(calculateV35RealizedPnl({
      exitPrice: 101,
      avgPrice: 100,
      totalSize: 0.00799,
      isLong: true,
    })).toBeCloseTo(0.00799, 10);
    expect(calculateV35RealizedPnl({
      exitPrice: 99,
      avgPrice: 100,
      totalSize: 0.00799,
      isLong: false,
    })).toBeCloseTo(0.00799, 10);
  });

  it("成交價、均價或數量不可信時不寫入虛假零盈虧", () => {
    expect(calculateV35RealizedPnl({ exitPrice: 0, avgPrice: 100, totalSize: 1, isLong: true })).toBeUndefined();
    expect(calculateV35RealizedPnl({ exitPrice: 101, avgPrice: Number.NaN, totalSize: 1, isLong: true })).toBeUndefined();
    expect(calculateV35RealizedPnl({ exitPrice: 101, avgPrice: 100, totalSize: 0, isLong: true })).toBeUndefined();
  });

  it("performance.byStrategy 共用摘要能保留小額非零 totalPnl", () => {
    const summary = summarizeStrategyPerformance([
      { realizedPnl: "0.005000", createdAt: new Date("2026-07-25T01:00:00Z") },
      { realizedPnl: "0.002990", createdAt: new Date("2026-07-25T02:00:00Z") },
      { realizedPnl: null, createdAt: new Date("2026-07-25T03:00:00Z") },
    ]);
    expect(summary.closedTradeCount).toBe(2);
    expect(summary.wins).toBe(2);
    expect(summary.totalPnl).toBeCloseTo(0.00799, 10);
    expect(summary.maxDrawdown).toBe(0);
  });

  it("非法舊 PnL 不污染總盈虧，且累計曲線正確計算回撤", () => {
    const summary = summarizeStrategyPerformance([
      { realizedPnl: "2", createdAt: 1 },
      { realizedPnl: "not-a-number", createdAt: 2 },
      { realizedPnl: "-0.5", createdAt: 3 },
    ]);
    expect(summary.closedTradeCount).toBe(2);
    expect(summary.totalPnl).toBe(1.5);
    expect(summary.maxDrawdown).toBe(0.5);
  });

  it("小於 0.01 USDT 的非零盈虧使用自適應精度", () => {
    expect(formatPnlAmount(0)).toBe("0.00");
    expect(formatPnlAmount(1.2)).toBe("1.20");
    expect(formatPnlAmount(0.00799)).toBe("0.00799");
    expect(formatPnlAmount(-0.00799)).toBe("-0.00799");
    expect(formatPnlAmount(0.000001)).toBe("0.000001");
  });
});
