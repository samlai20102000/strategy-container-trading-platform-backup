import { describe, expect, it } from "vitest";
import type { RecordTradeExecutionInput } from "./tradeExecutionLedger";
import { __martingalePositionLedgerTestUtils } from "./martingalePositionLedger";

function executionInput(
  side: "buy" | "sell",
  reduceOnly: boolean,
): RecordTradeExecutionInput {
  return {
    strategy: { id: 1, userId: 2, exchange: "okx", symbol: "BTC-USDT-SWAP" },
    signal: { action: reduceOnly ? "close" : side, source: "auto" },
    order: {
      side,
      orderType: "market",
      requestedSize: 1,
      reduceOnly,
      triggerSource: reduceOnly ? "risk_close" : "initial_entry",
    },
    execution: { status: "filled", orderId: "order-1" },
  };
}

describe("martingalePositionLedger", () => {
  it("開倉及 reduce-only 平倉方向會解析為正確持倉 side", () => {
    expect(__martingalePositionLedgerTestUtils.positionSide(executionInput("buy", false))).toBe("long");
    expect(__martingalePositionLedgerTestUtils.positionSide(executionInput("sell", false))).toBe("short");
    expect(__martingalePositionLedgerTestUtils.positionSide(executionInput("sell", true))).toBe("long");
    expect(__martingalePositionLedgerTestUtils.positionSide(executionInput("buy", true))).toBe("short");
  });

  it("層號單調遞增，超出配置上限只降級稽核品質而不竄改成交", () => {
    expect(__martingalePositionLedgerTestUtils.nextLayerDecision(2, 3, "live_exact")).toEqual({
      layerIndex: 3,
      dataQuality: "live_exact",
    });
    expect(__martingalePositionLedgerTestUtils.nextLayerDecision(3, 3, "live_exact")).toEqual({
      layerIndex: 4,
      dataQuality: "reconciliation_required",
    });
  });

  it("FIFO 部分平倉會先用盡第一層剩餘數量再分配第二層", () => {
    const plan = __martingalePositionLedgerTestUtils.planFifoCloseAllocations(
      [
        { id: 1, layerIndex: 1, quantity: "1", entryPrice: "100" },
        { id: 2, layerIndex: 2, quantity: "2", entryPrice: "110" },
      ],
      [{ layerEventId: 1, quantity: "0.4" }],
      1,
    );

    expect(plan.allocations).toEqual([
      { eventId: 1, layerIndex: 1, quantity: 0.6, entryPrice: 100 },
      { eventId: 2, layerIndex: 2, quantity: 0.4, entryPrice: 110 },
    ]);
    expect(plan).toMatchObject({
      unallocatedClose: 0,
      totalOpened: 3,
      totalClosedBefore: 0.4,
      totalClosedAfter: 1.4,
    });
  });

  it("平倉量超過 ledger 可證明數量時保留 residual 供 runtime 轉 reconciliation_required", () => {
    const plan = __martingalePositionLedgerTestUtils.planFifoCloseAllocations(
      [{ id: 1, layerIndex: 1, quantity: "1", entryPrice: "100" }],
      [],
      1.5,
    );
    expect(plan.allocations[0].quantity).toBe(1);
    expect(plan.unallocatedClose).toBe(0.5);
  });
});
