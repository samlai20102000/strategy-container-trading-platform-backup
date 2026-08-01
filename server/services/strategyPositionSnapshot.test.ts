import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKey, Strategy } from "../../drizzle/schema";
import type { Position } from "../exchanges/types";
import {
  buildStrategyPositionSnapshots,
  getAccountPositionSnapshot,
  invalidateAccountPositionSnapshotCache,
  normalizePositionSymbol,
  STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION,
  type AccountPositionResult,
} from "./strategyPositionSnapshot";

const { getPositionsMock } = vi.hoisted(() => ({
  getPositionsMock: vi.fn(),
}));

vi.mock("../exchanges/factory", () => ({
  createAdapter: () => ({ getPositions: getPositionsMock }),
}));

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

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 7,
    updatedAt: new Date(1_000_000),
    ...overrides,
  } as ApiKey;
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

function accounts(
  value: Omit<AccountPositionResult, "contractVersion"> & Partial<Pick<AccountPositionResult, "contractVersion">>,
): ReadonlyMap<number, AccountPositionResult> {
  return new Map([[7, {
    contractVersion: STRATEGY_POSITION_SNAPSHOT_CONTRACT_VERSION,
    ...value,
  }]]);
}

describe("strategyPositionSnapshot", () => {
  beforeEach(() => {
    invalidateAccountPositionSnapshotCache();
    getPositionsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
      contractVersion: "exchange-position-v2",
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

  it("本地 long 與 OKX long/short 並存時只歸屬 long，並把無本地擁有者的 short 標為未歸屬", () => {
    const [snapshot] = buildStrategyPositionSnapshots(
      [strategy(120011, { martinState: { totalSize: 0.0079, avgPrice: 113_000, isLong: true } })],
      accounts({
        positions: [
          position({ side: "long", size: 0.0079, entryPrice: 113_000 }),
          position({ side: "short", size: 0.1159, entryPrice: 115_000, unrealizedPnl: 347.7 }),
        ],
        capturedAt: 1_005_000,
      }),
      1_006_000,
    );

    expect(snapshot).toMatchObject({
      strategyId: 120011,
      side: "long",
      size: 0.0079,
      accountOppositeSide: "short",
      accountOppositePositionSize: 0.1159,
      accountOppositePositionAttribution: "unassigned",
    });
  });

  it("同帳戶反向倉有另一策略本地所有權時標為 other_strategy，而非孤兒倉", () => {
    const snapshots = buildStrategyPositionSnapshots(
      [
        strategy(1, { martinState: { totalSize: 0.0079, avgPrice: 113_000, isLong: true } }),
        strategy(2, { martinState: { totalSize: 0.1159, avgPrice: 115_000, isLong: false } }),
      ],
      accounts({
        positions: [
          position({ side: "long", size: 0.0079, entryPrice: 113_000 }),
          position({ side: "short", size: 0.1159, entryPrice: 115_000, unrealizedPnl: 347.7 }),
        ],
        capturedAt: 1_005_000,
      }),
      1_006_000,
    );

    expect(snapshots[0]).toMatchObject({
      accountOppositeSide: "short",
      accountOppositePositionSize: 0.1159,
      accountOppositePositionAttribution: "other_strategy",
    });
    expect(snapshots[1]).toMatchObject({
      accountOppositeSide: "long",
      accountOppositePositionSize: 0.0079,
      accountOppositePositionAttribution: "other_strategy",
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

  it("唯一策略但本地狀態尚未對齊時仍透傳唯一交易所持倉原生 UPL，且不冒充精確歸屬", () => {
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
      attribution: "singleton_exchange",
      pnlKind: "exchange_unrealized",
      size: 0.003,
      entryPrice: 100_500,
      markPrice: 99_000,
      unrealizedPnl: -4.5,
      accountPositionSize: 0.003,
      accountUnrealizedPnl: -4.5,
    });
  });

  it("同一帳戶快照 TTL 內跨頁併發只查詢交易所一次", async () => {
    getPositionsMock.mockResolvedValue([position()]);

    const [dashboardSnapshot, strategySnapshot] = await Promise.all([
      getAccountPositionSnapshot(1, apiKey()),
      getAccountPositionSnapshot(1, apiKey()),
    ]);

    expect(getPositionsMock).toHaveBeenCalledTimes(1);
    expect(dashboardSnapshot).toEqual(strategySnapshot);
    expect(dashboardSnapshot.contractVersion).toBe("exchange-position-v2");
  });

  it("交易所慢回應尚未完成時即使超過 TTL 仍沿用同一個待決請求", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let resolvePositions!: (positions: Position[]) => void;
    getPositionsMock.mockImplementation(() => new Promise<Position[]>((resolve) => {
      resolvePositions = resolve;
    }));

    const first = getAccountPositionSnapshot(1, apiKey());
    now += 30_000;
    const second = getAccountPositionSnapshot(1, apiKey());

    expect(getPositionsMock).toHaveBeenCalledTimes(1);
    resolvePositions([position()]);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
  });

  it("手動強制刷新會建立新交易所請求並原子替換共用快照", async () => {
    getPositionsMock
      .mockResolvedValueOnce([position({ markPrice: 99_000, unrealizedPnl: -1 })])
      .mockResolvedValueOnce([position({ markPrice: 99_500, unrealizedPnl: -0.5 })]);

    const key = apiKey();
    const first = await getAccountPositionSnapshot(1, key);
    const refreshed = await getAccountPositionSnapshot(1, key, { forceRefresh: true });
    const reused = await getAccountPositionSnapshot(1, key);

    expect(getPositionsMock).toHaveBeenCalledTimes(2);
    expect(first.positions[0].markPrice).toBe(99_000);
    expect(refreshed.positions[0].markPrice).toBe(99_500);
    expect(reused).toEqual(refreshed);
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
