import { beforeAll, describe, expect, it } from "vitest";
import {
  V25_STRATEGY_KEY,
  V25_STRATEGY_NAME,
  createV25DefaultConfig,
  deriveV25MaxMartinLayer,
  getV25CumulativeMultiplier,
  getV25MartinRangeForLayer,
  normalizeV25Config,
  validateV25Config,
  type V25StrategyConfig,
} from "../shared/strategies/kama3kBreakoutV25";
import {
  applyV25CloseToState,
  applyV25FillToState,
  calculateV25Kama,
  createV25RuntimeState,
  evaluateV25Decision,
} from "./strategies/v25/core";
import type { KLineData } from "./strategies/base";
import {
  attachSnapshotConfig,
  getBoundStrategyConfig,
} from "./services/strategySnapshotConfig";
import {
  getStrategy,
  initStrategyStudio,
  listRegisteredStrategies,
} from "./services/strategyStudio";
import { BacktestEngine } from "./services/backtest/backtestEngine";
import {
  getBacktestDatabase,
  type OHLCVRow,
} from "./services/backtest/backtestDatabase";

const TEST_SYMBOL = "V25-REGRESSION-USDT";
const TEST_TIMEFRAME = "15m";
const TEST_START = Date.UTC(2025, 2, 1);

function makeConfig(overrides: Partial<V25StrategyConfig> = {}): V25StrategyConfig {
  return {
    ...createV25DefaultConfig(),
    KAMA_Fast_Length: 5,
    p2_fastest: 2,
    p3_slowest: 2,
    KAMA_Slow_Length: 8,
    q2_fastest: 10,
    q3_slowest: 6,
    ...overrides,
    Martin_Ranges: overrides.Martin_Ranges?.map((range) => ({ ...range }))
      ?? createV25DefaultConfig().Martin_Ranges,
  };
}

function makeTrendCandles(
  direction: "up" | "down",
  count = 30,
  startTimestamp = TEST_START,
): KLineData[] {
  const sign = direction === "up" ? 1 : -1;
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + sign * index * 0.5;
    const close = open + sign * 0.3;
    return {
      timestamp: startTimestamp + index * 15 * 60_000,
      open,
      high: Math.max(open, close) + 0.2,
      low: Math.min(open, close) - 0.2,
      close,
      volume: 1000 + index,
    };
  });
}

function withFinalPrice(candles: KLineData[], price: number): KLineData[] {
  const result = candles.map((candle) => ({ ...candle }));
  const index = result.length - 1;
  result[index] = {
    ...result[index],
    open: price,
    high: price + 0.2,
    low: price - 0.2,
    close: price,
  };
  return result;
}

function makeOpenLongState() {
  return createV25RuntimeState({
    currentLayer: 1,
    totalSize: 1,
    totalCost: 100,
    avgPrice: 100,
    lastLayerPrice: 100,
    highestPrice: 100,
    lowestPrice: 100,
    isLong: true,
  });
}

function makeBacktestCandles(count: number): OHLCVRow[] {
  return Array.from({ length: count }, (_, index) => {
    const cycle = index % 48;
    const cycleBase = 100 + Math.floor(index / 48) * 0.5;
    const drift = cycle < 24 ? cycle * 0.22 : (48 - cycle) * 0.22;
    const close = cycleBase + drift;
    const previousCycle = (index - 1 + 48) % 48;
    const previousDrift = previousCycle < 24
      ? previousCycle * 0.22
      : (48 - previousCycle) * 0.22;
    const open = index === 0 ? close - 0.12 : cycleBase + previousDrift;
    return {
      symbol: TEST_SYMBOL,
      timeframe: TEST_TIMEFRAME,
      timestamp: TEST_START + index * 15 * 60_000,
      open,
      high: Math.max(open, close) + 0.18,
      low: Math.min(open, close) - 0.18,
      close,
      volume: 1000 + index,
    };
  });
}

describe("KAMA 三K突破 V2.5｜共用參數契約", () => {
  it("預設配置每次回傳獨立的馬丁範圍，不共享可變陣列", () => {
    const first = createV25DefaultConfig();
    const second = createV25DefaultConfig();
    first.Martin_Ranges[0].gap = 9;
    expect(second.Martin_Ranges[0].gap).toBe(0.8);
  });

  it("PACK 1 巢狀別名可正規化，且合法 0／false 不被預設值覆蓋", () => {
    const config = normalizeV25Config({
      kamaFast: { er: 9, fastest: 3, slowest: 2 },
      kamaSlow: { er: 21, fastest: 10, slowest: 7 },
      baseLot: 250,
      slPct: 0,
      tpPct: 0,
      trailingTpEnabled: false,
      martinEnabled: false,
      reentryEnabled: false,
      martinRanges: [{ start: 1, end: 25, multiplier: 1, gap: 0.5 }],
    });
    expect(config).toMatchObject({
      KAMA_Fast_Length: 9,
      KAMA_Slow_Length: 21,
      Base_Lot_Size: 250,
      Hard_Stop_Loss_Pct: 0,
      Take_Profit_Pct: 0,
      Trailing_TP_Enabled: false,
      Martin_Enabled: false,
      Reentry_On_Trend: false,
    });
    expect(config.Martin_Ranges).toEqual([
      { start: 1, end: 25, multiplier: 1, gap: 0.5 },
    ]);
  });

  it("嚴格阻擋 KAMA 關係、追蹤止盈與馬丁重疊／斷層錯誤", () => {
    const result = validateV25Config(makeConfig({
      q3_slowest: 2,
      Trailing_Activation_Pct: 0.5,
      Trailing_Callback_Pct: 0.8,
      Martin_Ranges: [
        { start: 1, end: 3, multiplier: 1.2, gap: 0.8 },
        { start: 3, end: 5, multiplier: 1.1, gap: 1.2 },
      ],
    }));
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      "q3_slowest",
      "Trailing_Callback_Pct",
      "Martin_Ranges.1.start",
    ]));
  });

  it("動態馬丁沒有固定十層上限，範圍、最大層與累乘皆正確", () => {
    const ranges = [
      { start: 1, end: 3, multiplier: 1.2, gap: 0.8 },
      { start: 4, end: 100, multiplier: 1.01, gap: 1.5 },
    ];
    expect(getV25MartinRangeForLayer(ranges, 87)).toEqual(ranges[1]);
    expect(deriveV25MaxMartinLayer(ranges)).toBe(100);
    expect(getV25CumulativeMultiplier(ranges, 0)).toBeCloseTo(1.2 ** 3);
  });
});

describe("KAMA 三K突破 V2.5｜純策略核心", () => {
  const config = makeConfig();

  it("KAMA 在資料不足時保持 null，形成後輸出有限數值", () => {
    const result = calculateV25Kama([100, 101, 102, 103, 104, 105], 5, 2, 2);
    expect(result.slice(0, 4)).toEqual([null, null, null, null]);
    expect(result[4]).toBe(104);
    expect(Number.isFinite(result[5])).toBe(true);
  });

  it("多頭 KAMA 排列＋前兩根陽 K＋當前影線突破會真實開多", () => {
    const decision = evaluateV25Decision(
      makeTrendCandles("up"),
      createV25RuntimeState(),
      config,
      "both",
    );
    expect(decision.action).toBe("buy");
    expect(decision.lotUsdt).toBe(config.Base_Lot_Size);
    expect(decision.metrics.isLongEntry).toBe(true);
  });

  it("空頭 KAMA 排列＋前兩根陰 K＋當前影線跌破會真實開空，方向鎖可阻擋", () => {
    const candles = makeTrendCandles("down");
    const shortDecision = evaluateV25Decision(candles, createV25RuntimeState(), config, "both");
    const blockedDecision = evaluateV25Decision(candles, createV25RuntimeState(), config, "long");
    expect(shortDecision.action).toBe("sell");
    expect(shortDecision.metrics.isShortEntry).toBe(true);
    expect(blockedDecision.action).toBe("hold");
  });

  it("硬止損採名義價格百分比並優先平倉", () => {
    const decision = evaluateV25Decision(
      withFinalPrice(makeTrendCandles("up"), 96.5),
      makeOpenLongState(),
      config,
    );
    expect(decision.action).toBe("close");
    expect(decision.closeReason).toBe("SL");
    expect(decision.metrics.profitPct).toBeCloseTo(-3.5);
  });

  it("固定止盈在追蹤未回撤時仍會平倉", () => {
    const state = makeOpenLongState();
    const decision = evaluateV25Decision(
      withFinalPrice(makeTrendCandles("up"), 101.2),
      state,
      makeConfig({ Trailing_TP_Enabled: true, Take_Profit_Pct: 1 }),
    );
    expect(decision.action).toBe("close");
    expect(decision.closeReason).toBe("TP_FIXED");
  });

  it("追蹤止盈達啟動門檻並回撤時優先平倉", () => {
    const state = makeOpenLongState();
    state.highestPrice = 102;
    const decision = evaluateV25Decision(
      withFinalPrice(makeTrendCandles("up"), 101.4),
      state,
      config,
    );
    expect(decision.action).toBe("close");
    expect(decision.closeReason).toBe("TP_TRAILING");
  });

  it("價格達階梯間距時，依目前層所在範圍輸出 USDT 加倉金額", () => {
    const decision = evaluateV25Decision(
      withFinalPrice(makeTrendCandles("up"), 99.1),
      makeOpenLongState(),
      config,
    );
    expect(decision.action).toBe("add_long");
    expect(decision.layerNum).toBe(1);
    expect(decision.lotUsdt).toBe(120);
  });

  it("實際成交函數以成交價與成交量更新層數、總成本及均價", () => {
    const opened = applyV25FillToState(createV25RuntimeState(), "buy", 100, 1, 1);
    const added = applyV25FillToState(opened, "add_long", 90, 1, 2);
    expect(added).toMatchObject({
      currentLayer: 2,
      totalSize: 2,
      totalCost: 190,
      avgPrice: 95,
      lastLayerPrice: 90,
      isLong: true,
    });
  });

  it("止盈平倉保存重入旗標，條件仍成立時輸出原地重入", () => {
    const candles = makeTrendCandles("up");
    const closed = applyV25CloseToState(
      makeOpenLongState(),
      "TP_FIXED",
      true,
      candles.at(-1)!.timestamp,
    );
    const decision = evaluateV25Decision(candles, closed, config);
    expect(decision.action).toBe("buy");
    expect(decision.reason).toContain("原地重入");
  });

  it("相同 K 棒的相同動作會被核心去重，不會重複下單", () => {
    const candles = makeTrendCandles("up");
    const first = evaluateV25Decision(candles, createV25RuntimeState(), config);
    const duplicate = evaluateV25Decision(candles, first.nextState, config);
    expect(first.action).toBe("buy");
    expect(duplicate.action).toBe("hold");
    expect(duplicate.reason).toContain("同 K 棒動作已處理");
  });
});

describe("KAMA 三K突破 V2.5｜全鏈路契約", () => {
  const backtestCandles = makeBacktestCandles(480);
  const endDate = TEST_START + backtestCandles.length * 15 * 60_000;

  beforeAll(async () => {
    await initStrategyStudio();
    getBacktestDatabase().insertOHLCV(backtestCandles);
  });

  it("工作室註冊中心公開獨立內建策略與完整預設配置", () => {
    const strategy = getStrategy(V25_STRATEGY_KEY);
    expect(strategy?.key).toBe(V25_STRATEGY_KEY);
    expect(strategy?.name).toBe(V25_STRATEGY_NAME);
    expect(strategy?.isBuiltIn).toBe(true);
    expect(strategy?.defaultConfig).toMatchObject(createV25DefaultConfig());
    expect(listRegisteredStrategies().map((item) => item.key)).toContain(V25_STRATEGY_KEY);
  });

  it("快照綁定完整保留 false、0 與超過十層的 Martin_Ranges", () => {
    const rawConfig = makeConfig({
      Hard_Stop_Loss_Pct: 0,
      Take_Profit_Pct: 0,
      Trailing_TP_Enabled: false,
      Martin_Enabled: false,
      Reentry_On_Trend: false,
      Martin_Ranges: [{ start: 1, end: 25, multiplier: 1, gap: 0.5 }],
    });
    const state = attachSnapshotConfig({}, V25_STRATEGY_KEY, rawConfig, {
      snapshotId: 25,
      snapshotName: "V2.5 無損往返",
      importedAt: 123456,
    });
    expect(getBoundStrategyConfig(state, V25_STRATEGY_KEY)).toEqual(rawConfig);
    expect(getBoundStrategyConfig(state, "KAMA_3K_TORNADO_V70")).toBeUndefined();
  });

  it("公開回測引擎派送至 V2.5 同源核心並回傳正確策略身份與交易", async () => {
    const result = await new BacktestEngine().runBacktest({
      strategyKey: V25_STRATEGY_KEY,
      symbol: TEST_SYMBOL,
      timeframe: TEST_TIMEFRAME,
      startDate: TEST_START,
      endDate,
      initialCapital: 10_000,
      config: makeConfig({ Base_Lot_Size: 100 }),
    });
    expect(result.strategyKey).toBe(V25_STRATEGY_KEY);
    expect(result.strategyName).toBe(V25_STRATEGY_NAME);
    expect(result.runId).toContain("KAMA3KBREAKOUTV25");
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBeGreaterThan(0);
  }, 60_000);
});
