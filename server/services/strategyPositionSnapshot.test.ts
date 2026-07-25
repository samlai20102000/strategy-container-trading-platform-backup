import { describe, expect, it } from "vitest";
import type { Strategy } from "../../drizzle/schema";
import type { Position } from "../exchanges/types";
import {
  buildStrategyPositionSnapshots,
  normalizePositionSymbol,
  type AccountPositionResult,
} from "./strategyPositionSnapshot";

function strategy(
  id: number,
  overrides: Partial<Strategy> = {},
): Strategy {
  return {
    id,
    apiKeyId: 7,
    userId: 1,
    exchange: "okx",
    symbol: "BTC-USDT-SWAP",
    leverage: 10,
    martinState: { totalSize: 0.001, avgPrice: 100_000, isLong: true },
    ...overrides,
  } as Strategy;
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: "BTC-USDT-SWAP",
    side: "long",
    size: 0.001,
    entryPrice: 100_000,
    markPrice: 99_000,
    unrealizedPnl: -1,
    unrealizedPnlRatioPct: -1.01,
    leverage: 10,
    positionMargin: 9.9,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

function accounts(value: AccountPositionResult): ReadonlyMap<number, AccountPositionResult> {
  return new Map([[7, value]]);
}

describe("strategyPositionSnapshot", () => {
  it("正規化 OKX、Bybit 與無分隔符號格式", () => {
    expect(normalizePositionSymbol("BTC-USDT-SWAP")).toBe("BTCUSDT");
    expect(normalizePositionSymbol("BTC/USDT")).toBe("BTCUSDT");
    expect(normalizePositionSymbol("btcusdt")).toBe("BTCUSDT");
  });

  it("單一策略精確歸屬時直接採用交易所未實現盈虧", () => {
    const [snapshot] = buildStrategyPositionSnapshots(
      [strategy(1)],
      accounts({ positions: [position()], capturedAt: 1_005_000 }),
      1_006_000,
    );
    expect(snapshot).toMatchObject({
      status: "available",
      source: "exchange_position",
      attribution: "exact",
      pnlKind: "exchange_unrealized",
      entryPrice: 100_000,
      markPrice: 99_000,
      unrealizedPnl: -1,
      unrealizedPnlPct: -1.01,
      stale: false,
    });
  });

  it("同帳戶、交易對與方向被多策略共享時不重複歸入帳戶總盈虧", () => {
    const snapshots = buildStrategyPositionSnapshots(
      [
        strategy(1, { martinState: { totalSize: 0.001, avgPrice: 100_000, isLong: true } }),
        strategy(2, { martinState: { totalSize: 0.002, avgPrice: 101_000, isLong: true } }),
      ],
      accounts({
        positions: [position({ size: 0.003, entryPrice: 100_666.67, unrealizedPnl: -5 })],
        capturedAt: 1_005_000,
      }),
      1_006_000,
    );
    expect(snapshots.map((snapshot) => snapshot.attribution)).toEqual([
      "account_aggregate",
      "account_aggregate",
    ]);
    expect(snapshots.map((snapshot) => snapshot.pnlKind)).toEqual([
      "strategy_gross_estimate",
      "strategy_gross_estimate",
    ]);
    expect(snapshots[0].unrealizedPnl).toBe(-1);
    expect(snapshots[1].unrealizedPnl).toBe(-4);
    expect(snapshots[0].accountUnrealizedPnl).toBe(-5);
  });

  it("唯一策略但本地數量或均價與交易所不吻合時不得冒充精確歸屬", () => {
    const [snapshot] = buildStrategyPositionSnapshots(
      [strategy(1, { martinState: { totalSize: 0.001, avgPrice: 100_000, isLong: true } })],
      accounts({
        positions: [position({ size: 0.003, entryPrice: 100_500, unrealizedPnl: -4.5 })],
        capturedAt: 1_005_000,
      }),
      1_006_000,
    );
    expect(snapshot).toMatchObject({
      status: "available",
      attribution: "account_aggregate",
      pnlKind: "strategy_gross_estimate",
      size: 0.001,
      entryPrice: 100_000,
      markPrice: 99_000,
      unrealizedPnl: -1,
      accountPositionSize: 0.003,
      accountUnrealizedPnl: -4.5,
    });
  });

  it("交易所查詢失敗時不以本地估算冒充即時盈虧", () => {
    const [snapshot] = buildStrategyPositionSnapshots(
      [strategy(1)],
      accounts({ positions: [], capturedAt: 1_005_000, error: "timeout" }),
      1_006_000,
    );
    expect(snapshot).toMatchObject({
      status: "exchange_unavailable",
      source: "local_estimate",
      attribution: "unavailable",
      pnlKind: "unavailable",
      unrealizedPnl: null,
      unrealizedPnlPct: null,
    });
  });

  it("本地有倉但交易所無對應方向時停止顯示估算盈虧", () => {
    const [snapshot] = buildStrategyPositionSnapshots(
      [strategy(1)],
      accounts({ positions: [position({ side: "short" })], capturedAt: 1_005_000 }),
      1_006_000,
    );
    expect(snapshot).toMatchObject({
      status: "no_exchange_position",
      source: "exchange_position",
      pnlKind: "unavailable",
      unrealizedPnl: null,
    });
  });
});
