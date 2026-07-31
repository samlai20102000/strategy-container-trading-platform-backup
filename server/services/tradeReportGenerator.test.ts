import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { TradeJournalRow } from "./tradeJournalQuery";
import {
  buildTradeCsv,
  buildTradeReportData,
  buildTradeXlsx,
  csvEscape,
  EmptyTradeReportError,
} from "./tradeReportGenerator";

function journalRow(overrides: Partial<TradeJournalRow> = {}): TradeJournalRow {
  return {
    id: 1,
    signalId: 1,
    strategyId: 20415,
    userId: 1,
    executionId: "exec-1",
    cycleId: "cycle-1",
    rawPayload: "{}",
    parsedAction: "buy",
    parsedSymbol: "BTCUSDT",
    parsedPrice: "100",
    status: "executed",
    message: "normal",
    exchangeResponse: "{}",
    orderId: "order-1",
    latencyMs: 30,
    source: "auto",
    createdAt: new Date("2026-07-29T00:00:00.000Z"),
    tradeId: 11,
    exchange: "okx",
    strategyName: "20415",
    strategyKey: "strategy_20415",
    tradeSide: "buy",
    reduceOnly: false,
    orderType: "market",
    exchangeTradeId: "fill-1",
    triggerSource: "auto",
    requestedSize: "10",
    requestedPrice: "100",
    filledSize: "10",
    filledPrice: "100",
    priceSource: "exchange_fill",
    sizeSource: "exchange_fill",
    grossPnl: null,
    fee: "0.1",
    fundingFee: "0",
    realizedPnl: null,
    realizedPnlPct: null,
    pnlCurrency: "USDT",
    pnlSource: "unavailable",
    dataQuality: "not_applicable",
    reconciliationStatus: "not_required",
    reconciliationAttempts: 0,
    reconciliationError: null,
    filledAt: new Date("2026-07-29T00:00:01.000Z"),
    tradeStatus: "filled",
    pnlState: "not_applicable",
    linkage: "signal_id",
    ...overrides,
  };
}

describe("tradeReportGenerator", () => {
  it("rejects a zero-row report instead of returning a blank success file", () => {
    expect(() => buildTradeReportData([], {})).toThrow(EmptyTradeReportError);
  });

  it("uses RFC 4180-style escaping, CRLF rows, UTF-8 BOM and spreadsheet formula protection", () => {
    expect(csvEscape('a,"b"\nnext')).toBe('"a,""b""\nnext"');
    expect(csvEscape("=2+2")).toBe("'=2+2");

    const data = buildTradeReportData([
      journalRow({ message: '逗號, 引號" 與\n換行', strategyName: "=DANGEROUS" }),
    ], {});
    const csv = buildTradeCsv(data);
    const text = csv.toString("utf8");
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text).toContain('"逗號, 引號"" 與\n換行"');
    expect(text).toContain("'=DANGEROUS");
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it("merges partial closes into one cycle and sums only known close PnL", () => {
    const data = buildTradeReportData([
      journalRow(),
      journalRow({
        id: 2,
        signalId: 2,
        tradeId: 12,
        parsedAction: "close",
        tradeSide: "sell",
        reduceOnly: true,
        filledSize: "4",
        filledPrice: "110",
        grossPnl: "4",
        fee: "0.05",
        realizedPnl: "3.95",
        pnlSource: "exchange",
        dataQuality: "exchange_confirmed",
        reconciliationStatus: "confirmed",
        pnlState: "known",
      }),
    ], {});

    expect(data.cycles).toHaveLength(1);
    expect(data.cycles[0]).toMatchObject({
      entryCount: 1,
      closeCount: 1,
      totalEntrySize: 10,
      totalCloseSize: 4,
      remainingSize: 6,
      netRealizedPnl: 3.95,
      status: "部分平倉",
      pnlState: "known",
    });
  });

  it("creates the required four-sheet workbook with numeric PnL cells", async () => {
    const data = buildTradeReportData([
      journalRow({
        reduceOnly: true,
        parsedAction: "close",
        filledSize: "10",
        realizedPnl: "1.56986",
        grossPnl: "1.7",
        fee: "0.13014",
        pnlSource: "exchange",
        dataQuality: "exchange_confirmed",
        reconciliationStatus: "confirmed",
        pnlState: "known",
      }),
    ], {});
    const buffer = await buildTradeXlsx(data);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual([
      "交易明細",
      "交易循環",
      "策略摘要",
      "資料品質",
    ]);
    expect(workbook.getWorksheet("交易明細")?.rowCount).toBe(2);
    expect(workbook.getWorksheet("交易明細")?.getCell("AE2").value).toBe(1.56986);
  });

  it("preserves orphan-trade PnL truth without fabricating a signal in summaries or quality rows", () => {
    const data = buildTradeReportData([
      journalRow({
        id: -180001,
        signalId: null,
        tradeId: 180001,
        cycleId: null,
        parsedAction: "close",
        tradeSide: "sell",
        reduceOnly: true,
        grossPnl: "1.7",
        realizedPnl: "1.56986",
        pnlSource: "exchange",
        dataQuality: "legacy_orphan_trade",
        reconciliationStatus: "confirmed",
        pnlState: "known",
        linkage: "orphan_trade",
      }),
    ], {});

    expect(data.rows[0]).toMatchObject({
      signalId: null,
      tradeId: 180001,
      realizedPnl: "1.56986",
      dataQuality: "legacy_orphan_trade",
      linkage: "orphan_trade",
    });
    expect(data.cycles[0]).toMatchObject({ netRealizedPnl: 1.56986, pnlState: "known" });
    expect(data.strategies[0]).toMatchObject({
      signalCount: 0,
      executedCount: 0,
      tradeCount: 1,
      closeCount: 1,
      knownPnlCount: 1,
      netRealizedPnl: 1.56986,
    });
    expect(data.quality[0]).toMatchObject({
      dataQuality: "legacy_orphan_trade",
      pnlState: "known",
      linkage: "orphan_trade",
      rowCount: 1,
      percentage: 100,
    });
  });

  it("uses the shared decisive win-rate denominator and never counts zero-PnL entries as losses", () => {
    const data = buildTradeReportData([
      journalRow({
        id: 1,
        signalId: 1,
        tradeId: 11,
        executionId: "entry-exec",
        orderId: "entry-order",
        exchangeTradeId: "entry-fill",
        reduceOnly: false,
        realizedPnl: "0",
        pnlState: "not_applicable",
      }),
      journalRow({
        id: 2,
        signalId: 2,
        tradeId: 12,
        executionId: "win-exec",
        orderId: "win-order",
        exchangeTradeId: "win-fill",
        parsedAction: "close",
        reduceOnly: true,
        realizedPnl: "2",
        dataQuality: "exchange_confirmed",
        reconciliationStatus: "confirmed",
        pnlState: "known",
      }),
      journalRow({
        id: 3,
        signalId: 3,
        tradeId: 13,
        executionId: "loss-exec",
        orderId: "loss-order",
        exchangeTradeId: "loss-fill",
        parsedAction: "close",
        reduceOnly: true,
        realizedPnl: "-1",
        dataQuality: "exchange_confirmed",
        reconciliationStatus: "confirmed",
        pnlState: "known",
      }),
      journalRow({
        id: 4,
        signalId: 4,
        tradeId: 14,
        executionId: "flat-exec",
        orderId: "flat-order",
        exchangeTradeId: "flat-fill",
        parsedAction: "close",
        reduceOnly: true,
        realizedPnl: "0",
        dataQuality: "exchange_confirmed",
        reconciliationStatus: "confirmed",
        pnlState: "known",
      }),
    ], {});

    expect(data.strategies[0]).toMatchObject({
      tradeCount: 4,
      closeCount: 3,
      knownPnlCount: 3,
      decisivePnlCount: 2,
      winCount: 1,
      lossCount: 1,
      breakevenCount: 1,
      winRatePct: 50,
      netRealizedPnl: 1,
    });
  });

  it("keeps every current and future strategy distinct across OKX and Bybit without a whitelist", () => {
    const strategyCases = [
      { strategyId: 20415, strategyKey: "strategy_20415", exchange: "okx" },
      { strategyId: 35, strategyKey: "20415_KAMA_MARTIN_V35", exchange: "bybit" },
      { strategyId: 50, strategyKey: "KAMA_3K_ULTIMATE_V50", exchange: "okx" },
      { strategyId: 61, strategyKey: "KAMA_3K_HF_V61", exchange: "bybit" },
      { strategyId: 70, strategyKey: "KAMA_3K_TORNADO_V70", exchange: "okx" },
      { strategyId: 99, strategyKey: "FUTURE_ENGINE_V99", exchange: "bybit" },
    ];
    const data = buildTradeReportData(strategyCases.map((item, index) => journalRow({
      id: index + 1,
      signalId: index + 1,
      strategyId: item.strategyId,
      strategyName: item.strategyKey,
      strategyKey: item.strategyKey,
      exchange: item.exchange,
      executionId: `exec-${index + 1}`,
      cycleId: `cycle-${index + 1}`,
      orderId: `order-${index + 1}`,
      tradeId: index + 11,
    })), {});

    expect(data.strategies).toHaveLength(strategyCases.length);
    expect(data.strategies.map(summary => summary.strategyKey).sort()).toEqual(
      strategyCases.map(item => item.strategyKey).sort(),
    );
    expect(data.strategies.find(summary => summary.strategyKey === "FUTURE_ENGINE_V99"))
      .toMatchObject({ strategyId: 99, exchange: "bybit", signalCount: 1, tradeCount: 1 });
    expect(new Set(data.strategies.map(summary => summary.exchange))).toEqual(new Set(["okx", "bybit"]));
  });
});
