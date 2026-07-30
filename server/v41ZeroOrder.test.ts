import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeyById: vi.fn(),
  getTodayRealizedPnl: vi.fn(),
  createAdapter: vi.fn(),
  placeOrder: vi.fn(),
  closePosition: vi.fn(),
  closePositionSmart: vi.fn(),
  cancelOrder: vi.fn(),
  getPositions: vi.fn(),
  getStrategy: vi.fn(),
  initStrategyStudio: vi.fn(),
  prepareSymbolForExecution: vi.fn(),
  fetchKLineData: vi.fn(),
  loadStrategyState: vi.fn(),
  saveStrategyState: vi.fn(),
  acquireBarLock: vi.fn(),
  checkBarLock: vi.fn(),
}));

vi.mock("./db", () => ({
  createSignal: vi.fn(),
  disableStrategySystem: vi.fn(),
  getApiKeyById: mocks.getApiKeyById,
  listEnabledStrategies: vi.fn(),
  getStrategyById: vi.fn(),
  getTodayRealizedPnl: mocks.getTodayRealizedPnl,
  updateSignal: vi.fn(),
  updateStrategyMartinState: vi.fn(),
  updateTrade: vi.fn(),
}));

vi.mock("./services/tradeExecutionLedger", () => ({
  recordExistingTradeExecution: vi.fn(),
}));

vi.mock("./exchanges/factory", () => ({
  createAdapter: mocks.createAdapter,
}));

vi.mock("./services/strategyStudio", () => ({
  getStrategy: mocks.getStrategy,
  initStrategyStudio: mocks.initStrategyStudio,
}));

vi.mock("./services/symbolMiddleware", () => ({
  prepareSymbolForExecution: mocks.prepareSymbolForExecution,
}));

vi.mock("./services/autoTradeSignalGenerator", () => ({
  fetchKLineData: mocks.fetchKLineData,
}));

vi.mock("./services/strategyStateManager", () => ({
  loadStrategyState: mocks.loadStrategyState,
  saveStrategyState: mocks.saveStrategyState,
}));

vi.mock("./services/barLock", () => ({
  acquireBarLock: mocks.acquireBarLock,
  checkBarLock: mocks.checkBarLock,
}));

import {
  createV41DefaultConfig,
  V41_STRATEGY_KEY,
} from "../shared/strategies/kama3kMartinV41";
import { StrategyKama3kV41 } from "./strategies/v41/strategy_kama_3k_v41";
import { executeSignal, type ParsedSignal } from "./services/executor";
import { attachSnapshotConfig } from "./services/strategySnapshotConfig";

const adapter = {
  placeOrder: mocks.placeOrder,
  closePosition: mocks.closePosition,
  closePositionSmart: mocks.closePositionSmart,
  cancelOrder: mocks.cancelOrder,
  getPositions: mocks.getPositions,
};

const initialState = {
  currentLayer: 0,
  totalSize: 0,
  avgPrice: 0,
  isLong: true,
  entryPrice: 0,
  highestPrice: 0,
  lowestPrice: 0,
  lastActionTime: 0,
  cooldownUntil: 0,
  lastBarTimestamp: 0,
};

function strategyWithConfig(config?: Record<string, unknown>) {
  const martinState = config
    ? attachSnapshotConfig(initialState, V41_STRATEGY_KEY, config, { snapshotName: "zero-order-test" })
    : { ...initialState };
  return {
    id: 41,
    userId: 1,
    apiKeyId: 1,
    strategyKey: V41_STRATEGY_KEY,
    name: "V4.1 zero-order test",
    symbol: "BTC-USDT-SWAP",
    direction: "both",
    exchange: "okx",
    enabled: true,
    maxDailyLoss: "0",
    positionSize: "0.01",
    positionSizeObject: null,
    positionMode: "quantity",
    leverage: 1,
    martinMultiplier: "2",
    maxMartinLevel: 6,
    martinSpacingPct: "1",
    reentryEnabled: false,
    reentryCooldownBars: 0,
    martinState,
  } as any;
}

function rawSignal(overrides: Partial<ParsedSignal> = {}): ParsedSignal {
  return {
    action: "buy",
    symbol: "BTC-USDT-SWAP",
    price: 999_999,
    barTimestamp: 999_999,
    ...overrides,
  };
}

function expectNoExchangeOrderAttempt() {
  expect(mocks.placeOrder).toHaveBeenCalledTimes(0);
  expect(mocks.closePosition).toHaveBeenCalledTimes(0);
  expect(mocks.closePositionSmart).toHaveBeenCalledTimes(0);
  expect(mocks.cancelOrder).toHaveBeenCalledTimes(0);
}

describe("V4.1 fail-closed 零下單證據", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeyById.mockResolvedValue({ id: 1, exchange: "okx", isTestnet: true });
    mocks.getTodayRealizedPnl.mockResolvedValue(0);
    mocks.createAdapter.mockReturnValue(adapter);
    mocks.getStrategy.mockReturnValue(new StrategyKama3kV41());
    mocks.initStrategyStudio.mockResolvedValue(undefined);
    mocks.prepareSymbolForExecution.mockResolvedValue({ valid: true, normalized: "BTC-USDT-SWAP" });
    mocks.fetchKLineData.mockResolvedValue([]);
    mocks.loadStrategyState.mockReturnValue({ ...initialState });
    mocks.saveStrategyState.mockResolvedValue(undefined);
    mocks.checkBarLock.mockResolvedValue(false);
    mocks.acquireBarLock.mockResolvedValue({ acquired: true });
  });

  it("缺少 canonical __v41Config 時在下單前拒絕", async () => {
    const result = await executeSignal(strategyWithConfig(), rawSignal(), 1);
    expect(result).toMatchObject({ status: "skipped" });
    expect(result.message).toContain("canonical 配置無效");
    expectNoExchangeOrderAttempt();
  });

  it("持久化配置遭竄改為 0/3 時在下單前拒絕", async () => {
    const zeroOfThree = createV41DefaultConfig();
    const result = await executeSignal(strategyWithConfig(zeroOfThree), rawSignal(), 2);
    expect(result).toMatchObject({ status: "skipped" });
    expect(result.message).toContain("V41_NO_ENTRY_CONDITION_ENABLED");
    expectNoExchangeOrderAttempt();
  });

  it("外部偽造可信封印時不重抓也不下單", async () => {
    const config = { ...createV41DefaultConfig(), enableThreeKFilter: true };
    const result = await executeSignal(strategyWithConfig(config), rawSignal({
      v41TrustedEntrySeal: {
        claims: {
          sealVersion: 1,
          strategyId: 41,
          strategyKey: V41_STRATEGY_KEY,
          configVersion: "4.1",
          configHash: "forged",
          action: "buy",
          direction: "long",
          barTimestamp: 999_999,
          decisionClose: 999_999,
          fastKama: null,
          slowKama: null,
          issuedAt: Date.now(),
        },
        signature: "0".repeat(64),
      } as any,
    }), 3);
    expect(result).toMatchObject({ status: "skipped" });
    expect(result.message).toContain("可信封印無效");
    expect(mocks.fetchKLineData).toHaveBeenCalledTimes(0);
    expectNoExchangeOrderAttempt();
  });

  it("Raw Webhook 無已收盤 K 線時忽略外部價格並零下單", async () => {
    const config = { ...createV41DefaultConfig(), enableThreeKFilter: true };
    const result = await executeSignal(strategyWithConfig(config), rawSignal(), 4);
    expect(result).toMatchObject({ status: "skipped" });
    expect(result.message).toContain("無已收盤 K 線");
    expect(mocks.fetchKLineData).toHaveBeenCalledWith(
      adapter,
      "BTC-USDT-SWAP",
      config.K_Line_Period,
      100,
      true,
    );
    expectNoExchangeOrderAttempt();
  });

  it("Raw Webhook 方向與 closed-bar evaluator 不一致時零下單", async () => {
    const config = { ...createV41DefaultConfig(), enableThreeKFilter: true };
    mocks.fetchKLineData.mockResolvedValue([
      { open: 100, high: 103, low: 99, close: 102, timestamp: 1_000 },
      { open: 102, high: 105, low: 101, close: 104, timestamp: 2_000 },
      { open: 103, high: 107, low: 102, close: 105, timestamp: 3_000 },
    ]);
    const result = await executeSignal(strategyWithConfig(config), rawSignal({ action: "sell" }), 5);
    expect(result).toMatchObject({ status: "skipped" });
    expect(result.message).toContain("closed-bar evaluator 未通過");
    expectNoExchangeOrderAttempt();
  });
});
