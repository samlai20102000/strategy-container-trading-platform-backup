import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  runTradePnlReconciliation,
  type ReconciliationCandidate,
  type ReconciliationDependencies,
} from "./tradePnlReconciliation";

function candidate(overrides: Partial<ReconciliationCandidate> = {}): ReconciliationCandidate {
  return {
    id: 77,
    strategyId: 20415,
    userId: 7,
    signalId: 88,
    exchange: "bybit",
    symbol: "BTCUSDT",
    orderId: "close-order-001",
    reconciliationAttempts: 0,
    pnlCurrency: "USDT",
    ...overrides,
  } as ReconciliationCandidate;
}

function makeDependencies(overrides: Partial<ReconciliationDependencies> = {}): ReconciliationDependencies {
  return {
    listCandidates: vi.fn(async () => []),
    claim: vi.fn(async () => true),
    getStrategy: vi.fn(async () => ({ id: 20415, apiKeyId: 9 } as any)),
    getApiKey: vi.fn(async () => ({ id: 9, exchange: "bybit" } as any)),
    createTruthReader: vi.fn(() => ({
      getOrderExecutionTruth: vi.fn(async () => ({ settlementStatus: "pending" as const })),
    })),
    complete: vi.fn(async () => true),
    markIncomplete: vi.fn(async () => undefined),
    ...overrides,
  } as ReconciliationDependencies;
}

describe("tradePnlReconciliation", () => {
  it("以交易所 final 結算真相確認盈虧並同步標準 ledger 欄位", async () => {
    const row = candidate();
    const reader = {
      getOrderExecutionTruth: vi.fn(async () => ({
        settlementStatus: "final" as const,
        netRealizedPnl: 1.56986,
        grossRealizedPnl: 1.6,
        fee: 0.03014,
        filledPrice: 118_234.5,
        filledSize: 0.001,
        filledAt: 1_754_000_000_000,
        tradeId: "trade-abc",
      })),
    };
    const dependencies = makeDependencies({
      listCandidates: vi.fn(async () => [row]) as any,
      createTruthReader: vi.fn(() => reader),
    });

    const result = await runTradePnlReconciliation({ now: new Date("2026-07-29T10:00:00Z") }, dependencies);

    expect(result).toMatchObject({ scanned: 1, claimed: 1, confirmed: 1, pending: 0, errors: 0 });
    expect(reader.getOrderExecutionTruth).toHaveBeenCalledWith("BTCUSDT", "close-order-001", true);
    expect(dependencies.complete).toHaveBeenCalledWith(expect.objectContaining({
      tradeId: 77,
      signalId: 88,
      message: "✅ 平倉已執行｜已實現盈虧 +1.56986000 USDT",
      values: expect.objectContaining({
        realizedPnl: "1.56986000",
        netRealizedPnl: "1.56986000",
        grossPnl: "1.60000000",
        fee: "0.03014000",
        price: "118234.50000000",
        size: "0.00100000",
        pnlSource: "exchange_settlement",
        dataQuality: "exchange_confirmed",
      }),
    }));
    expect(dependencies.markIncomplete).not.toHaveBeenCalled();
  });

  it("交易所尚未結算時維持 pending，不以估算值冒充權威盈虧", async () => {
    const dependencies = makeDependencies({
      listCandidates: vi.fn(async () => [candidate()]) as any,
    });

    const result = await runTradePnlReconciliation({}, dependencies);

    expect(result).toMatchObject({ pending: 1, confirmed: 0, unresolved: 0 });
    expect(dependencies.complete).not.toHaveBeenCalled();
    expect(dependencies.markIncomplete).toHaveBeenCalledWith(expect.objectContaining({
      tradeId: 77,
      terminal: false,
    }));
  });

  it("第 30 次仍無權威結果時轉為明確 unresolved，避免永久假裝處理中", async () => {
    const dependencies = makeDependencies({
      listCandidates: vi.fn(async () => [candidate({ reconciliationAttempts: 29 })]) as any,
    });

    const result = await runTradePnlReconciliation({}, dependencies);

    expect(result.unresolved).toBe(1);
    expect(dependencies.markIncomplete).toHaveBeenCalledWith(expect.objectContaining({ terminal: true }));
  });

  it("跨實例租約未取得時跳過，絕不重複呼叫交易所", async () => {
    const createTruthReader = vi.fn();
    const dependencies = makeDependencies({
      listCandidates: vi.fn(async () => [candidate()]) as any,
      claim: vi.fn(async () => false),
      createTruthReader,
    });

    const result = await runTradePnlReconciliation({}, dependencies);

    expect(result).toMatchObject({ scanned: 1, claimed: 0, skipped: 1 });
    expect(createTruthReader).not.toHaveBeenCalled();
  });

  it("對帳服務只具備只讀 truth reader，不得引用下單、撤單或平倉方法", () => {
    const source = readFileSync(new URL("tradePnlReconciliation.ts", import.meta.url), "utf8");
    expect(source).not.toContain(".placeOrder(");
    expect(source).not.toContain(".cancelOrder(");
    expect(source).not.toContain(".closePosition(");
    expect(source).not.toContain(".closePositionSmart(");
  });
});
