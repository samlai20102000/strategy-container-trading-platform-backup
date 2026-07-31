import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KAMA_RAINBOW_MARTIN_CONFIG } from "../shared/strategies/kamaRainbowMartin";

const mocks = vi.hoisted(() => ({
  listEnabledStrategies: vi.fn(),
  acquireBarLock: vi.fn(),
  releaseAllLocks: vi.fn(),
  resolveDeploymentPosition: vi.fn(),
  fetchFreshQuote: vi.fn(),
  loadStrategyState: vi.fn(),
  saveStrategyState: vi.fn(),
  getBoundStrategyConfig: vi.fn(),
  normalizeQtyForSymbol: vi.fn(),
  recordTrade: vi.fn(),
}));

vi.mock("./db", () => ({ listEnabledStrategies: mocks.listEnabledStrategies }));
vi.mock("./services/barLock", () => ({
  acquireBarLock: mocks.acquireBarLock,
  releaseAllLocks: mocks.releaseAllLocks,
}));
vi.mock("./services/deploymentPosition", () => ({ resolveDeploymentPosition: mocks.resolveDeploymentPosition }));
vi.mock("./services/kamaRainbowMartinMarketData", () => ({
  fetchKamaRainbowMartinFreshQuote: mocks.fetchFreshQuote,
}));
vi.mock("./services/strategyStateManager", () => ({
  loadStrategyState: mocks.loadStrategyState,
  saveStrategyState: mocks.saveStrategyState,
}));
vi.mock("./services/strategySnapshotConfig", () => ({ getBoundStrategyConfig: mocks.getBoundStrategyConfig }));
vi.mock("./services/symbolSpecs", () => ({ normalizeQtyForSymbol: mocks.normalizeQtyForSymbol }));
vi.mock("./services/tradeExecutionLedger", () => ({ recordExistingTradeExecution: mocks.recordTrade }));

import { executeKamaRainbowMartinSignal } from "./services/kamaRainbowMartinExecutor";

function flatState() {
  return {
    currentLayer: 0,
    isLong: true,
    totalSize: 0,
    totalCost: 0,
    avgPrice: 0,
    lastEntryPrice: 0,
    peakPrice: 0,
    troughPrice: 0,
    kamaRainbowMartinRuntime: { fills: [], seenFillIds: [], processedRiskEventKeys: [] },
  };
}

function longState(size = 2) {
  return {
    ...flatState(),
    currentLayer: 1,
    totalSize: size,
    totalCost: 100 * size,
    avgPrice: 100,
    lastEntryPrice: 100,
    peakPrice: 110,
    troughPrice: 100,
    kamaRainbowMartinRuntime: {
      fills: [{ fillId: "fill-open", action: "OPEN_LONG", layer: 1, price: 100, quantity: size, timestamp: 1 }],
      seenFillIds: ["fill-open"],
      processedRiskEventKeys: [],
      activeConfig: DEFAULT_KAMA_RAINBOW_MARTIN_CONFIG,
      activeConfigRevision: "kamaRainbowMartin.v1",
      positionSizeAtOpen: { mode: "usdt", value: 100 },
    },
  };
}

const strategy = {
  id: 1,
  userId: 9,
  apiKeyId: 3,
  strategyKey: "KAMA_RAINBOW_MARTIN_V1",
  exchange: "okx",
  symbol: "BTC-USDT-SWAP",
  direction: "both",
  leverage: 2,
  maxPositionPct: "0",
  martinState: {},
} as any;

function adapter(overrides: Record<string, unknown> = {}) {
  return {
    getPositions: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ total: 1_000 }),
    setLeverage: vi.fn().mockResolvedValue(undefined),
    placeOrder: vi.fn().mockResolvedValue({
      success: true,
      orderId: "order-1",
      tradeId: "trade-1",
      filledSize: 1,
      filledPrice: 100,
      filledAt: 2,
      settlementStatus: "final",
    }),
    getOrderExecutionTruth: vi.fn(),
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listEnabledStrategies.mockResolvedValue([]);
  mocks.acquireBarLock.mockResolvedValue(true);
  mocks.releaseAllLocks.mockResolvedValue(undefined);
  mocks.resolveDeploymentPosition.mockReturnValue({ mode: "usdt", value: 100 });
  mocks.fetchFreshQuote.mockResolvedValue({ bid: 99, ask: 100, capturedAt: 2 });
  mocks.getBoundStrategyConfig.mockReturnValue(DEFAULT_KAMA_RAINBOW_MARTIN_CONFIG);
  mocks.normalizeQtyForSymbol.mockImplementation(async (_exchange, _symbol, qty) => ({ rejected: false, qty }));
  mocks.saveStrategyState.mockResolvedValue(undefined);
  mocks.recordTrade.mockResolvedValue({});
});

describe("Kama 彩虹馬丁 S1 guarded executor", () => {
  it("拒絕未封印訊號且不接觸交易所", async () => {
    const exchange = adapter();
    const result = await executeKamaRainbowMartinSignal(strategy, { action: "buy" }, 0, exchange, { source: "AUTO" });
    expect(result.status).toBe("rejected");
    expect(exchange.placeOrder).not.toHaveBeenCalled();
  });

  it("底倉只在真實 fill 後提交狀態與 Bar-Lock", async () => {
    mocks.loadStrategyState.mockReturnValue(flatState());
    const exchange = adapter();
    const result = await executeKamaRainbowMartinSignal(strategy, {
      action: "buy",
      price: 99,
      barTimestamp: 1_700_000_000_000,
      kamaRainbowMartinDecision: true,
      kamaRainbowMartinAction: "OPEN_LONG",
      kamaRainbowMartinReasonCode: "KRM_ENTRY_LONG_ALL_RISING",
      kamaRainbowMartinEventKey: "okx:BTC-USDT-SWAP:M30:1",
      kamaRainbowMartinConfigRevision: "kamaRainbowMartin.v1",
    }, 0, exchange, { source: "AUTO" });
    expect(result.status).toBe("executed");
    expect(exchange.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", size: 1, reduceOnly: false, posSide: "long" }));
    expect(mocks.saveStrategyState).toHaveBeenCalledWith(1, expect.objectContaining({ currentLayer: 1, totalSize: 1, avgPrice: 100 }));
    expect(mocks.acquireBarLock).toHaveBeenCalledWith(1, 1_700_000_000_000, 30);
    expect(mocks.recordTrade).toHaveBeenCalledTimes(1);
  });

  it("S1 發現同帳戶同商品既有策略腿時拒絕底倉", async () => {
    mocks.loadStrategyState
      .mockReturnValueOnce(flatState())
      .mockReturnValueOnce(longState(1));
    mocks.listEnabledStrategies.mockResolvedValue([{ ...strategy, id: 2 }]);
    const exchange = adapter();
    const result = await executeKamaRainbowMartinSignal(strategy, {
      action: "buy",
      kamaRainbowMartinDecision: true,
      kamaRainbowMartinAction: "OPEN_LONG",
    }, 0, exchange, { source: "AUTO" });
    expect(result.status).toBe("rejected");
    expect(exchange.placeOrder).not.toHaveBeenCalled();
  });

  it("部分 reduce-only 成交只扣腿級數量，不重置整腿", async () => {
    mocks.loadStrategyState.mockReturnValue(longState(2));
    const placeOrder = vi.fn().mockResolvedValue({
      success: true,
      orderId: "close-1",
      tradeId: "close-fill-1",
      filledSize: 1,
      filledPrice: 110,
      filledAt: 3,
      settlementStatus: "final",
    });
    const exchange = adapter({
      getPositions: vi.fn().mockResolvedValue([{ side: "long", size: 3 }]),
      placeOrder,
    });
    const result = await executeKamaRainbowMartinSignal(strategy, {
      action: "close",
      price: 110,
      kamaRainbowMartinDecision: true,
      kamaRainbowMartinAction: "CLOSE",
      kamaRainbowMartinCloseReason: "TRAILING_TAKE_PROFIT",
      kamaRainbowMartinReasonCode: "KRM_TRAILING_EXIT",
    }, 0, exchange, { source: "RISK" });
    expect(result.status).toBe("executed");
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ reduceOnly: true, posSide: "long", size: 2 }));
    expect(mocks.saveStrategyState).toHaveBeenCalledWith(1, expect.objectContaining({ currentLayer: 1, totalSize: 1, totalCost: 100 }));
    expect(mocks.releaseAllLocks).not.toHaveBeenCalled();
  });

  it("成功回應缺少成交真值時不推進狀態", async () => {
    mocks.loadStrategyState.mockReturnValue(flatState());
    const exchange = adapter({
      placeOrder: vi.fn().mockResolvedValue({ success: true, orderId: "pending-1" }),
      getOrderExecutionTruth: vi.fn().mockResolvedValue({ success: true, orderId: "pending-1" }),
    });
    const result = await executeKamaRainbowMartinSignal(strategy, {
      action: "buy",
      kamaRainbowMartinDecision: true,
      kamaRainbowMartinAction: "OPEN_LONG",
    }, 0, exchange, { source: "AUTO" });
    expect(result.status).toBe("failed");
    expect(mocks.saveStrategyState).not.toHaveBeenCalled();
    expect(mocks.acquireBarLock).not.toHaveBeenCalled();
  });
});
