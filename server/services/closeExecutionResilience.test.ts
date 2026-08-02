import { describe, expect, it } from "vitest";
import type { Strategy } from "../../drizzle/schema";
import type { Position } from "../exchanges/types";
import {
  buildStableCloseIntentId,
  classifyCloseExecutionFailure,
  closeRetryRemainingMs,
  computeCloseRetryDelayMs,
  nextCloseRetryState,
  readCloseRetryState,
} from "./closeExecutionResilience";
import { selectOwnedRiskPosition } from "./riskMonitor";

function strategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: 120011,
    userId: 7,
    apiKeyId: 3,
    name: "V4.0 KAMA+3K",
    symbol: "BTCUSDT",
    enabled: true,
    martinState: {
      totalSize: 0.1238,
      avgPrice: 62_999.97,
      isLong: false,
    },
    ...overrides,
  } as Strategy;
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: "BTC-USDT-SWAP",
    side: "short",
    size: 0.1238,
    entryPrice: 62_999.97,
    markPrice: 62_832.1,
    unrealizedPnl: 20.7822,
    leverage: 5,
    ...overrides,
  } as Position;
}

describe("全策略 close execution resilience", () => {
  it("同一策略持倉事實跨輪詢產生穩定 intent，方向或數量改變才換 intent", () => {
    const base = {
      strategyId: 120011,
      side: "short" as const,
      size: 0.1238,
      entryPrice: 62_999.97,
      scope: "take_profit",
    };
    const first = buildStableCloseIntentId(base);
    expect(buildStableCloseIntentId(base)).toBe(first);
    expect(buildStableCloseIntentId({ ...base, size: 0.12 })).not.toBe(first);
    expect(buildStableCloseIntentId({ ...base, side: "long" })).not.toBe(first);
    expect(first.length).toBeLessThanOrEqual(40);
  });

  it("失敗採 1/2/4/8/16/32/60 分鐘持久化退避並封頂", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(computeCloseRetryDelayMs)).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      960_000,
      1_920_000,
      3_600_000,
      3_600_000,
    ]);

    const first = nextCloseRetryState({
      closeIntentId: "cls120011sabc",
      result: {
        errorMessage: "CANONICAL_RUNTIME_CONTEXT_INVALID",
        rawResponse: JSON.stringify({ canonicalRuntimeError: "RUNTIME_CAPABILITY_SNAPSHOT_MISMATCH" }),
      },
      now: 1_000,
    });
    const second = nextCloseRetryState({
      previous: first,
      closeIntentId: first.closeIntentId,
      result: { errorMessage: "still blocked", rawResponse: "{}" },
      now: 61_000,
    });
    expect(first).toMatchObject({
      failureCount: 1,
      nextRetryAt: 61_000,
      reasonCode: "CLOSE_CAPABILITY_SNAPSHOT_MISMATCH",
    });
    expect(second.failureCount).toBe(2);
    expect(closeRetryRemainingMs(second, 61_000)).toBe(120_000);
    expect(readCloseRetryState(second)).toEqual(second);
    expect(readCloseRetryState({ closeIntentId: "x", failureCount: 0, nextRetryAt: 0 })).toBeUndefined();
  });

  it("保留更具體的 canonical 漂移分類供訊號日誌與告警使用", () => {
    expect(classifyCloseExecutionFailure({
      errorMessage: "blocked",
      rawResponse: JSON.stringify({ canonicalRuntimeError: "STRATEGY_LOGIC_HASH_MISMATCH,STALE_CAPABILITY_MANIFEST" }),
    })).toBe("CLOSE_STRATEGY_LOGIC_DRIFT");
  });

  it("RiskMonitor 只選本策略本地狀態可證明的 symbol + posSide，不碰同帳戶反向腿", () => {
    const owned = position();
    const opposite = position({ side: "long", size: 0.02 });
    expect(selectOwnedRiskPosition(strategy(), [opposite, owned])).toBe(owned);
    expect(selectOwnedRiskPosition(
      strategy({ martinState: { totalSize: 0.1238, avgPrice: 62_999.97, isLong: true } }),
      [owned],
    )).toBeUndefined();
    expect(selectOwnedRiskPosition(strategy({ martinState: {} }), [owned])).toBeUndefined();
  });

  it("RiskMonitor 遇到同帳戶同商品同方向由多策略共享時拒絕猜測歸屬", () => {
    const owned = position();
    const primary = strategy();
    const anotherOwner = strategy({ id: 90003, name: "20415 七彩紅馬丁" });

    expect(selectOwnedRiskPosition(primary, [owned], [primary, anotherOwner])).toBeUndefined();
    expect(selectOwnedRiskPosition(
      primary,
      [position({ size: 0.2, entryPrice: 61_000 })],
      [primary],
    )).toBeUndefined();
  });
});
