import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  collectTradeJournalBatches,
  normalizeTradeJournalFilters,
  TRADE_JOURNAL_BATCH_SIZE,
} from "./tradeJournalQuery";

describe("tradeJournalQuery contract", () => {
  it("normalizes multi-strategy filters deterministically and lets strategyIds override the legacy strategyId", () => {
    expect(normalizeTradeJournalFilters({
      strategyId: 99,
      strategyIds: [7, 3, 7, -1, 0],
      symbol: " btcusdt ",
    })).toMatchObject({
      strategyIds: [3, 7],
      symbol: "BTCUSDT",
    });

    expect(normalizeTradeJournalFilters({ strategyId: 99, strategyIds: [] }))
      .toMatchObject({ strategyIds: [99] });
  });

  it("joins PnL truth only by trade.signalId and never restores the legacy orderId fallback", () => {
    const source = readFileSync(new URL("./tradeJournalQuery.ts", import.meta.url), "utf8");
    expect(source).toContain("leftJoin(trades, eq(trades.signalId, signals.id))");
    expect(source).not.toMatch(/leftJoin\(trades,[\s\S]{0,250}trades\.orderId/);
  });

  it("unions trades with null signalId as explicit orphan rows without guessing a signal link", () => {
    const source = readFileSync(new URL("./tradeJournalQuery.ts", import.meta.url), "utf8");
    expect(source).toContain("isNull(trades.signalId)");
    expect(source).toContain("unionAll(signalQuery, orphanQuery)");
    expect(source).toContain("signalId: sql<number | null>`NULL`");
    expect(source).toContain("sql<TradeJournalLinkage>`'orphan_trade'`");
    expect(source).toContain("sql<string | null>`'legacy_orphan_trade'`");
    expect(source).not.toMatch(/orphanJournalSelection[\s\S]*signalId:\s*trades\.id/);
  });

  it("reads every page beyond the removed 10,000-row cap", async () => {
    const total = 10_005;
    const calls: Array<{ offset: number; limit: number }> = [];
    const fetchPage = vi.fn(async (offset: number, limit: number) => {
      calls.push({ offset, limit });
      const remaining = Math.max(total - offset, 0);
      const count = Math.min(limit, remaining);
      return {
        total,
        items: Array.from({ length: count }, (_, index) => offset + index),
      };
    });

    const result = await collectTradeJournalBatches(fetchPage);

    expect(result.total).toBe(total);
    expect(result.rows).toHaveLength(total);
    expect(result.rows?.at(-1)).toBe(total - 1);
    expect(calls).toEqual([
      { offset: 0, limit: TRADE_JOURNAL_BATCH_SIZE },
      { offset: 2_000, limit: TRADE_JOURNAL_BATCH_SIZE },
      { offset: 4_000, limit: TRADE_JOURNAL_BATCH_SIZE },
      { offset: 6_000, limit: TRADE_JOURNAL_BATCH_SIZE },
      { offset: 8_000, limit: TRADE_JOURNAL_BATCH_SIZE },
      { offset: 10_000, limit: TRADE_JOURNAL_BATCH_SIZE },
    ]);
  });
});
