import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KAMA_RAINBOW_MARTIN_CONFIG } from "../shared/strategies/kamaRainbowMartin";

const mocks = vi.hoisted(() => ({
  initStrategyStudio: vi.fn(),
  getStrategy: vi.fn(),
  createAdapter: vi.fn(),
  getStrategyById: vi.fn(),
  loadStrategyState: vi.fn(),
  saveStrategyState: vi.fn(),
  loadCanonicalRuntimeDeployment: vi.fn(),
  getBoundStrategyConfig: vi.fn(),
  fetchClosedCandles: vi.fn(),
  fetchFreshQuote: vi.fn(),
  evaluateEntry: vi.fn(),
  evaluateManagement: vi.fn(),
}));

vi.mock("./services/strategyStudio", () => ({
  initStrategyStudio: mocks.initStrategyStudio,
  getStrategy: mocks.getStrategy,
}));
vi.mock("./exchanges/factory", () => ({ createAdapter: mocks.createAdapter }));
vi.mock("./db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./db");
  return { ...actual, getStrategyById: mocks.getStrategyById };
});
vi.mock("./services/strategyStateManager", () => ({
  loadStrategyState: mocks.loadStrategyState,
  saveStrategyState: mocks.saveStrategyState,
}));
vi.mock("./services/canonicalRuntimeDeployment", () => ({
  loadCanonicalRuntimeDeployment: mocks.loadCanonicalRuntimeDeployment,
}));
vi.mock("./services/strategySnapshotConfig", () => ({ getBoundStrategyConfig: mocks.getBoundStrategyConfig }));
vi.mock("./services/kamaRainbowMartinMarketData", () => ({
  fetchKamaRainbowMartinClosedCandles: mocks.fetchClosedCandles,
  fetchKamaRainbowMartinFreshQuote: mocks.fetchFreshQuote,
}));
vi.mock("./strategies/kamaRainbowMartin/core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./strategies/kamaRainbowMartin/core");
  return { ...actual, evaluateKamaRainbowMartinEntry: mocks.evaluateEntry };
});
vi.mock("./strategies/kamaRainbowMartin/management", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./strategies/kamaRainbowMartin/management");
  return { ...actual, evaluateKamaRainbowMartinManagement: mocks.evaluateManagement };
});

import { generateTradingSignal } from "./services/autoTradeSignalGenerator";

const strategy = {
  id: 7,
  strategyKey: "KAMA_RAINBOW_MARTIN_V1",
  exchange: "okx",
  symbol: "BTC-USDT-SWAP",
  direction: "both",
  martinState: {},
} as any;

const flatState = {
  currentLayer: 0,
  totalSize: 0,
  avgPrice: 0,
  isLong: true,
  kamaRainbowMartinRuntime: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStrategy.mockReturnValue({});
  mocks.createAdapter.mockReturnValue({});
  mocks.getStrategyById.mockResolvedValue(strategy);
  mocks.loadCanonicalRuntimeDeployment.mockResolvedValue({ strategy });
  mocks.getBoundStrategyConfig.mockReturnValue(DEFAULT_KAMA_RAINBOW_MARTIN_CONFIG);
  mocks.saveStrategyState.mockResolvedValue(undefined);
});

describe("Kama 彩虹馬丁 auto signal 分流", () => {
  it("空倉只讀已收盤 K 線並產生密封 entry signal", async () => {
    mocks.loadStrategyState.mockReturnValue(flatState);
    const candles = Array.from({ length: 30 }, (_, index) => ({
      openTime: index,
      closeTime: index + 1,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100 + index,
      volume: 1,
      closed: true,
    }));
    mocks.fetchClosedCandles.mockResolvedValue({
      candles,
      lastClosedBarIdentity: "okx:BTC-USDT-SWAP:M30:29",
    });
    mocks.evaluateEntry.mockReturnValue({
      action: "OPEN_LONG",
      reason: "全部 KAMA 上升",
      reasonCode: "KRM_ENTRY_LONG_ALL_RISING",
      price: 129,
      barTimestamp: 29,
      nextState: flatState,
    });
    const result = await generateTradingSignal(strategy, {}, { withReason: true });
    expect(mocks.fetchClosedCandles).toHaveBeenCalledTimes(1);
    expect(mocks.fetchFreshQuote).not.toHaveBeenCalled();
    expect(mocks.evaluateEntry).toHaveBeenCalledWith(expect.objectContaining({ lastBarClosed: true }));
    expect(result).toEqual(expect.objectContaining({
      holdReason: null,
      signal: expect.objectContaining({
        action: "buy",
        kamaRainbowMartinDecision: true,
        kamaRainbowMartinAction: "OPEN_LONG",
        kamaRainbowMartinEventKey: "okx:BTC-USDT-SWAP:M30:29",
      }),
    }));
  });

  it("持倉時完全跳過 KAMA，只用 fresh quote 執行風控", async () => {
    const activeState = { ...flatState, currentLayer: 1, totalSize: 1, avgPrice: 100, isLong: true };
    mocks.loadStrategyState.mockReturnValue(activeState);
    mocks.fetchFreshQuote.mockResolvedValue({
      exchange: "okx",
      symbol: "BTC-USDT-SWAP",
      bid: 94,
      ask: 95,
      capturedAt: 5,
    });
    mocks.evaluateManagement.mockReturnValue({
      action: "close",
      reason: "硬止損",
      reasonCode: "KRM_HARD_STOP",
      closeReason: "HARD_STOP",
      nextState: activeState,
    });
    const result = await generateTradingSignal(strategy, {}, { withReason: true });
    expect(mocks.fetchClosedCandles).not.toHaveBeenCalled();
    expect(mocks.evaluateEntry).not.toHaveBeenCalled();
    expect(mocks.fetchFreshQuote).toHaveBeenCalledTimes(1);
    expect(mocks.evaluateManagement).toHaveBeenCalledWith(expect.objectContaining({ currentPrice: 94 }), activeState, expect.anything());
    expect(result).toEqual(expect.objectContaining({
      holdReason: null,
      signal: expect.objectContaining({
        action: "close",
        kamaRainbowMartinDecision: true,
        kamaRainbowMartinAction: "CLOSE",
        kamaRainbowMartinCloseReason: "HARD_STOP",
      }),
    }));
  });
});
