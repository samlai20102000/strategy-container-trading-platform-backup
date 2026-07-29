import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  __tradeExecutionLedgerTestUtils,
  type RecordTradeExecutionInput,
} from "./tradeExecutionLedger";

function input(
  overrides: Partial<RecordTradeExecutionInput> = {},
): RecordTradeExecutionInput {
  return {
    strategy: {
      id: 20415,
      userId: 7,
      exchange: "okx",
      symbol: "BTC-USDT-SWAP",
    },
    signal: {
      action: "close",
      source: "auto",
    },
    order: {
      side: "sell",
      orderType: "market",
      requestedSize: 0.001,
      reduceOnly: true,
      triggerSource: "risk_close",
    },
    execution: {
      status: "filled",
      orderId: "order-001",
    },
    ...overrides,
  };
}

describe("tradeExecutionLedger", () => {
  it("平倉已成交但交易所尚未回傳盈虧時必須進入 pending 對帳", () => {
    expect(__tradeExecutionLedgerTestUtils.inferPnlTruth(input())).toEqual({
      netPnl: null,
      pnlSource: "unknown",
      dataQuality: "pending_reconciliation",
      reconciliationStatus: "pending",
    });
  });

  it("平倉已有確定淨盈虧時立即標記 confirmed", () => {
    const result = __tradeExecutionLedgerTestUtils.inferPnlTruth(input({
      execution: {
        status: "filled",
        orderId: "order-002",
        netRealizedPnl: 1.56986,
        pnlSource: "exchange_settlement",
        dataQuality: "exchange_confirmed",
      },
    }));

    expect(result).toEqual({
      netPnl: 1.56986,
      pnlSource: "exchange_settlement",
      dataQuality: "exchange_confirmed",
      reconciliationStatus: "confirmed",
    });
  });

  it("開倉不應被誤列為待盈虧對帳", () => {
    const result = __tradeExecutionLedgerTestUtils.inferPnlTruth(input({
      order: {
        side: "buy",
        orderType: "market",
        requestedSize: 0.001,
        reduceOnly: false,
        triggerSource: "initial_entry",
      },
    }));

    expect(result.reconciliationStatus).toBe("not_required");
    expect(result.dataQuality).toBe("not_applicable");
  });

  it("同一交易所 orderId 產生穩定 executionId 以支援冪等", () => {
    const first = __tradeExecutionLedgerTestUtils.buildExecutionId(input());
    const second = __tradeExecutionLedgerTestUtils.buildExecutionId(input());
    expect(first).toBe("exec:okx:order-001");
    expect(second).toBe(first);
  });

  it("所有目前與未來生產交易寫入路徑均不得繞過共用 ledger", () => {
    const collectProductionFiles = (directory: URL): URL[] => readdirSync(directory, { withFileTypes: true })
      .flatMap(entry => {
        const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
        if (entry.isDirectory()) return collectProductionFiles(child);
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
        return [child];
      });

    const allowed = new Set([
      new URL("../db.ts", import.meta.url).pathname,
      new URL("tradeExecutionLedger.ts", import.meta.url).pathname,
    ]);
    const forbiddenDirectWrites = collectProductionFiles(new URL("../", import.meta.url))
      .filter(file => !allowed.has(file.pathname))
      .flatMap(file => {
        const source = readFileSync(file, "utf8");
        const importsDbCreateTrade = /import\s*\{[^}]*\bcreateTrade\b[^}]*\}\s*from\s*["'][^"']*\/?db["']/s.test(source);
        const callsDbCreateTrade = /\bdb\.createTrade\s*\(/.test(source);
        return importsDbCreateTrade || callsDbCreateTrade ? [file.pathname] : [];
      });

    expect(forbiddenDirectWrites).toEqual([]);
  });
});
