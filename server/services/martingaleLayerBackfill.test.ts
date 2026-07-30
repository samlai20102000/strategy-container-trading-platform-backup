import { describe, expect, it } from "vitest";
import type { Strategy, Trade } from "../../drizzle/schema";
import {
  hydrateLegacyTradeFromOrderTruth,
  reconstructStrictLegacyCycle,
} from "./martingaleLayerBackfill";

function strategy(
  quantity: number,
  entryPrice: number,
  isLong = true,
): Strategy {
  return {
    id: 41,
    name: "可驗證馬丁策略",
    strategyKey: "MARTIN",
    martinState: { totalSize: quantity, avgPrice: entryPrice, isLong },
  } as Strategy;
}

function trade(
  id: number,
  side: "buy" | "sell",
  size: number,
  price: number,
  reduceOnly = false,
  overrides: Partial<Trade> = {},
): Trade {
  return {
    id,
    side,
    size: String(size),
    price: String(price),
    reduceOnly,
    status: "filled",
    executionId: `exec-${id}`,
    sizeSource: "exchange_fill",
    priceSource: "exchange_fill",
    createdAt: new Date(id * 1_000),
    ...overrides,
  } as Trade;
}

describe("martingaleLayerBackfill", () => {
  it("只有完整吻合的交易所指定訂單真值才升格歷史成交", () => {
    const legacy = trade(1, "buy", 1, 100, false, {
      exchange: "okx",
      orderId: "ord-1",
      executionId: null,
      priceSource: "requested",
      sizeSource: "requested",
    });
    const truth = {
      filledPrice: 101,
      filledSize: 1.25,
      filledAt: 1_760_000_000_000,
      tradeId: "fill-1",
      fillQuality: "exact" as const,
      executionStatus: "filled" as const,
      executedSide: "buy" as const,
      executedReduceOnly: false,
    };

    expect(hydrateLegacyTradeFromOrderTruth(legacy, truth)).toMatchObject({
      executionId: "legacy-truth:okx:ord-1",
      exchangeTradeId: "fill-1",
      price: "101.00000000",
      size: "1.25000000",
      priceSource: "exchange_fill",
      sizeSource: "exchange_fill",
    });
    expect(hydrateLegacyTradeFromOrderTruth(legacy, { ...truth, executedSide: "sell" })).toBeNull();
    expect(hydrateLegacyTradeFromOrderTruth(legacy, { ...truth, executedReduceOnly: true })).toBeNull();
    expect(hydrateLegacyTradeFromOrderTruth(legacy, { ...truth, executionStatus: "partially_filled" })).toBeNull();
    expect(hydrateLegacyTradeFromOrderTruth(legacy, { ...truth, filledAt: undefined })).toBeNull();
  });

  it("只在 FIFO、價量及本地持倉全部可證明時允許回填", () => {
    const result = reconstructStrictLegacyCycle(
      strategy(3.5, 360 / 3.5),
      [
        trade(1, "buy", 1, 100),
        trade(2, "buy", 2, 110),
        trade(3, "sell", 0.5, 120, true),
        trade(4, "buy", 1, 90),
      ],
      3,
    );

    expect(result.decision).toMatchObject({
      eligible: true,
      reason: "eligible",
      layerCount: 3,
      reconstructedQuantity: 3.5,
      written: false,
    });
    expect(result.reconstruction?.allocations).toHaveLength(1);
    expect(result.reconstruction?.allocations[0]).toMatchObject({
      openTradeId: 1,
      layerIndex: 1,
      quantity: 0.5,
    });
  });

  it("完全平倉後只重建其後的新循環", () => {
    const result = reconstructStrictLegacyCycle(
      strategy(2, 90),
      [
        trade(1, "buy", 1, 100),
        trade(2, "sell", 1, 101, true),
        trade(3, "buy", 2, 90),
      ],
      5,
    );

    expect(result.decision).toMatchObject({
      eligible: true,
      layerCount: 1,
      cycleId: "legacy:41:exec-3",
    });
    expect(result.reconstruction?.opens[0]).toMatchObject({ layerIndex: 1, remainingQuantity: 2 });
  });

  it("任何非交易所 fill 真值的歷史都整體拒絕", () => {
    const result = reconstructStrictLegacyCycle(
      strategy(1, 100),
      [trade(1, "buy", 1, 100, false, { priceSource: "estimated" })],
      5,
    );
    expect(result.decision).toMatchObject({ eligible: false, reason: "unverifiable_fill_truth" });
  });

  it("方向衝突與平倉超量不會被猜測修正", () => {
    expect(reconstructStrictLegacyCycle(
      strategy(1, 100),
      [trade(1, "sell", 1, 100)],
      5,
    ).decision.reason).toBe("direction_conflict");

    expect(reconstructStrictLegacyCycle(
      strategy(1, 100),
      [trade(1, "buy", 1, 100), trade(2, "sell", 2, 101, true)],
      5,
    ).decision.reason).toBe("close_exceeds_open_quantity");
  });

  it("超出配置層數、數量或均價不一致均拒絕回填", () => {
    const twoLayers = [trade(1, "buy", 1, 100), trade(2, "buy", 1, 110)];
    expect(reconstructStrictLegacyCycle(strategy(2, 105), twoLayers, 1).decision.reason)
      .toBe("layer_count_exceeds_configuration");
    expect(reconstructStrictLegacyCycle(strategy(3, 105), twoLayers, 2).decision.reason)
      .toBe("quantity_mismatch");
    expect(reconstructStrictLegacyCycle(strategy(2, 130), twoLayers, 2).decision.reason)
      .toBe("entry_price_mismatch");
  });
});
