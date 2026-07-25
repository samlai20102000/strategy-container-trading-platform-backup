import { describe, expect, it } from "vitest";

import {
  createRainbow20415DefaultConfig,
  type Rainbow20415Config,
} from "../shared/strategies/rainbow20415";
import type { KLineData } from "./strategies/base";
import {
  applyRainbow20415CloseToState,
  applyRainbow20415FillToState,
  calculateRainbow20415LineSnapshot,
  createRainbow20415RuntimeState,
  evaluateRainbow20415Decision,
  evaluateRainbow20415Entry,
  evaluateRainbow20415Management,
} from "./strategies/rainbow20415/core";

const START = Date.UTC(2026, 0, 1);

function candles(closes: number[]): KLineData[] {
  return closes.map((close, index) => ({
    timestamp: START + index * 30 * 60_000,
    open: close,
    high: close + 0.1,
    low: Math.max(0.0001, close - 0.1),
    close,
    volume: 100 + index,
  }));
}

function compactSmaConfig(): Rainbow20415Config {
  const config = createRainbow20415DefaultConfig();
  config.Lines = config.Lines.map((line, index) => ({
    ...line,
    type: "SMA",
    period: index + 1,
  }));
  return config;
}

function activeLongState(overrides: Record<string, unknown> = {}) {
  return createRainbow20415RuntimeState({
    currentLayer: 1,
    totalSize: 0.01,
    totalCost: 1,
    avgPrice: 100,
    lastLayerPrice: 100,
    highestPrice: 100,
    lowestPrice: 100,
    isLong: true,
    lockedBarTimestamp: START,
    rainbow20415Runtime: {
      configVersion: "rainbow20415.v1",
      blindMode: true,
      entryTimestamp: START,
      entryAccountEquity: 10_000,
      pendingReentry: false,
      reentryReadyAt: 0,
      lastCloseReason: null,
      lastScanBarTimestamp: START,
      lastEntryBarTimestamp: START,
      lastManagedAt: START,
      lastActionTimestamp: START,
      lastActionSignature: "buy:L1",
      lastDecisionReason: "test",
      currentRank: [],
      previousRank: [],
      slopeDirection: "INSUFFICIENT",
      noCross: false,
      currentLineValues: {},
      previousLineValues: {},
      lineSlopes: {},
    },
    ...overrides,
  });
}

describe("20415 七彩虹七線入場", () => {
  it("七線全部向上且前後排名完全一致時只產生多單意圖，不提前改持倉", () => {
    const config = compactSmaConfig();
    const market = candles([1, 2, 3, 4, 5, 6, 7, 8]);
    const state = createRainbow20415RuntimeState();
    const snapshot = calculateRainbow20415LineSnapshot(market, config);
    const decision = evaluateRainbow20415Entry(market, state, config);

    expect(snapshot).toMatchObject({ ready: true, slopeDirection: "UP", noCross: true, hasTies: false });
    expect(snapshot.currentRank).toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7"]);
    expect(decision).toMatchObject({ action: "buy", layerNum: 1, orderSize: config.Base_Lot_Size });
    expect(decision.nextState.currentLayer).toBe(0);
    expect(decision.nextState.totalSize).toBe(0);
  });

  it("七線全部向下且排名不變時產生空單意圖", () => {
    const config = compactSmaConfig();
    const market = candles([8, 7, 6, 5, 4, 3, 2, 1]);
    const decision = evaluateRainbow20415Entry(market, createRainbow20415RuntimeState(), config);
    expect(decision.action).toBe("sell");
    expect(decision.metrics.mode).toBe("SCAN");
    if (decision.metrics.mode === "SCAN") {
      expect(decision.metrics.lines.slopeDirection).toBe("DOWN");
      expect(decision.metrics.lines.currentRank).toEqual(["L7", "L6", "L5", "L4", "L3", "L2", "L1"]);
    }
  });

  it("排名交叉、同值或斜率未全同向時拒絕入場", () => {
    const config = compactSmaConfig();
    const crossing = evaluateRainbow20415Entry(
      candles([1, 2, 3, 4, 5, 6, 7, 5.8]),
      createRainbow20415RuntimeState(),
      config,
    );
    const ties = evaluateRainbow20415Entry(
      candles([5, 5, 5, 5, 5, 5, 5, 5]),
      createRainbow20415RuntimeState(),
      config,
    );
    expect(crossing.action).toBe("hold");
    expect(crossing.reason).toMatch(/排名序列改變|斜率未全同向/);
    expect(ties.action).toBe("hold");
    expect(ties.reason).toMatch(/同值/);
  });

  it("資料不足、同 M30 Bar 重複與既有持倉都不重複下底倉", () => {
    const config = compactSmaConfig();
    const market = candles([1, 2, 3, 4, 5, 6, 7, 8]);
    const insufficient = evaluateRainbow20415Entry(market.slice(0, 7), createRainbow20415RuntimeState(), config);
    const duplicate = evaluateRainbow20415Entry(
      market,
      createRainbow20415RuntimeState({
        rainbow20415Runtime: { lastScanBarTimestamp: market.at(-1)!.timestamp },
      }),
      config,
    );
    const blind = evaluateRainbow20415Entry(market, activeLongState(), config);
    expect(insufficient.reason).toMatch(/數據不足/);
    expect(duplicate.reason).toMatch(/已完成七線掃描/);
    expect(blind.reason).toMatch(/盲人模式/);
    expect([insufficient.action, duplicate.action, blind.action]).toEqual(["hold", "hold", "hold"]);
  });
});

describe("20415 七彩虹盲人模式與動態階梯", () => {
  it("多單逆向達間距且有真實保證金資料時，跳過停用區間到下一有效層", () => {
    const config = createRainbow20415DefaultConfig();
    config.Martin_Ranges = [
      { id: "base", startLayer: 1, endLayer: 2, multiplier: 1.5, useGlobalSpacing: true, spacingPct: 1.5, enabled: true },
      { id: "off", startLayer: 3, endLayer: 4, multiplier: 0, useGlobalSpacing: false, spacingPct: 2, enabled: false },
      { id: "tail", startLayer: 5, endLayer: 999, multiplier: 1.1, useGlobalSpacing: false, spacingPct: 3, enabled: true },
    ];
    const state = activeLongState({ currentLayer: 2 });
    const decision = evaluateRainbow20415Management(
      { currentPrice: 97, now: START + 60_000, account: { equity: 10_000, usedMargin: 1_000 } },
      state,
      config,
    );
    expect(decision).toMatchObject({
      action: "add_long",
      layerNum: 5,
      orderSize: { value: 0.011, mode: "quantity" },
    });
    expect(decision.nextState.currentLayer).toBe(2);
  });

  it("缺少真實保證金資料時安全封鎖已觸發的加倉", () => {
    const decision = evaluateRainbow20415Management(
      { currentPrice: 98.5, now: START + 60_000 },
      activeLongState(),
      createRainbow20415DefaultConfig(),
    );
    expect(decision.action).toBe("hold");
    expect(decision.reason).toMatch(/缺少真實保證金/);
  });

  it("空單使用對稱逆向門檻並產生 add_short", () => {
    const state = activeLongState({ isLong: false });
    const decision = evaluateRainbow20415Management(
      { currentPrice: 101.5, now: START + 60_000, account: { marginUsagePct: 10 } },
      state,
      createRainbow20415DefaultConfig(),
    );
    expect(decision).toMatchObject({ action: "add_short", layerNum: 2 });
  });

  it("只有交易所成交成功後套用底倉與加倉，並以成交量計算加權均價", () => {
    const empty = createRainbow20415RuntimeState();
    const initial = applyRainbow20415FillToState(empty, {
      action: "buy",
      fillPrice: 100,
      fillQuantity: 0.01,
      timestamp: START,
      barTimestamp: START,
      accountEquity: 10_000,
    });
    const added = applyRainbow20415FillToState(initial, {
      action: "add_long",
      fillPrice: 98,
      fillQuantity: 0.015,
      timestamp: START + 60_000,
      targetLayer: 2,
    });
    expect(initial).toMatchObject({ currentLayer: 1, totalSize: 0.01, avgPrice: 100, isLong: true });
    expect(added.currentLayer).toBe(2);
    expect(added.totalSize).toBeCloseTo(0.025, 12);
    expect(added.totalCost).toBeCloseTo(2.47, 12);
    expect(added.avgPrice).toBeCloseTo(98.8, 12);
    expect(() => applyRainbow20415FillToState(initial, {
      action: "add_short",
      fillPrice: 101,
      fillQuantity: 0.01,
      timestamp: START + 60_000,
    })).toThrow(/方向與既有持倉不一致/);
  });
});

describe("20415 七彩虹止盈、三道鐵幕與重入", () => {
  it("平均成本名義價格盈利達 0.2% 時全平", () => {
    const decision = evaluateRainbow20415Management(
      { currentPrice: 100.21, now: START + 60_000, account: { marginUsagePct: 10 } },
      activeLongState(),
      createRainbow20415DefaultConfig(),
    );
    expect(decision).toMatchObject({ action: "close", closeReason: "TAKE_PROFIT" });
  });

  it("持倉 48 小時及保證金使用率 70% 分別觸發鐵幕平倉", () => {
    const config = createRainbow20415DefaultConfig();
    const timeLimit = evaluateRainbow20415Management(
      { currentPrice: 100, now: START + 48 * 3_600_000, account: { marginUsagePct: 10 } },
      activeLongState(),
      config,
    );
    const marginLimit = evaluateRainbow20415Management(
      { currentPrice: 100, now: START + 60_000, account: { equity: 10_000, usedMargin: 7_000 } },
      activeLongState(),
      config,
    );
    expect(timeLimit).toMatchObject({ action: "close", closeReason: "MAX_HOLD" });
    expect(marginLimit).toMatchObject({ action: "close", closeReason: "MARGIN_LIMIT" });
  });

  it("只在最後有效層且帳戶虧損達 5% 時觸發最終鐵幕", () => {
    const config = createRainbow20415DefaultConfig();
    const beforeFinal = evaluateRainbow20415Management(
      { currentPrice: 100, now: START + 60_000, account: { marginUsagePct: 10, accountPnlPct: -6 } },
      activeLongState({ currentLayer: 10 }),
      config,
    );
    const atFinal = evaluateRainbow20415Management(
      { currentPrice: 100, now: START + 60_000, account: { marginUsagePct: 10, accountPnlPct: -5 } },
      activeLongState({ currentLayer: 11 }),
      config,
    );
    expect(beforeFinal.action).toBe("hold");
    expect(atFinal).toMatchObject({ action: "close", closeReason: "MAX_ACCOUNT_LOSS" });
  });

  it("平倉成交後才重置狀態，並依冷卻與最新七線結構無縫重入", () => {
    const config = compactSmaConfig();
    config.Reentry_Cooldown_Minutes = 300;
    const closed = applyRainbow20415CloseToState(activeLongState(), "TAKE_PROFIT", config, START + 60_000);
    expect(closed).toMatchObject({ currentLayer: 0, totalSize: 0, avgPrice: 0 });
    expect(closed.rainbow20415Runtime).toMatchObject({
      pendingReentry: true,
      lastCloseReason: "TAKE_PROFIT",
      reentryReadyAt: START + 301 * 60_000,
    });

    const market = candles([1, 2, 3, 4, 5, 6, 7, 8]);
    const inCooldown = evaluateRainbow20415Entry(market, closed, config);
    const readyState = createRainbow20415RuntimeState({
      ...closed,
      rainbow20415Runtime: { ...closed.rainbow20415Runtime!, reentryReadyAt: market.at(-1)!.timestamp },
    });
    const reentry = evaluateRainbow20415Entry(market, readyState, config);
    expect(inCooldown.action).toBe("hold");
    expect(inCooldown.reason).toMatch(/冷卻中/);
    expect(reentry.action).toBe("buy");
  });

  it("同一 M30 Bar 一般掃描只執行一次，但平倉後 pendingReentry 可立即重判一次", () => {
    const config = compactSmaConfig();
    config.Reentry_Cooldown_Minutes = 0;
    const market = candles([1, 2, 3, 4, 5, 6, 7, 8]);
    const entry = evaluateRainbow20415Entry(market, createRainbow20415RuntimeState(), config);
    const filled = applyRainbow20415FillToState(entry.nextState, {
      action: "buy",
      fillPrice: entry.price,
      fillQuantity: 0.01,
      timestamp: market.at(-1)!.timestamp,
      barTimestamp: market.at(-1)!.timestamp,
      accountEquity: 10_000,
    });
    const closed = applyRainbow20415CloseToState(
      filled,
      "TAKE_PROFIT",
      config,
      market.at(-1)!.timestamp,
    );
    const reentry = evaluateRainbow20415Entry(market, closed, config);
    const refilled = applyRainbow20415FillToState(reentry.nextState, {
      action: "buy",
      fillPrice: reentry.price,
      fillQuantity: 0.01,
      timestamp: market.at(-1)!.timestamp + 1,
      barTimestamp: market.at(-1)!.timestamp,
      accountEquity: 10_000,
    });
    const duplicate = evaluateRainbow20415Entry(market, applyRainbow20415CloseToState(
      refilled,
      "MANUAL",
      { ...config, Reentry_Enabled: false },
      market.at(-1)!.timestamp + 2,
    ), config);

    expect(entry.nextState.rainbow20415Runtime?.lastScanBarTimestamp).toBe(market.at(-1)!.timestamp);
    expect(reentry.action).toBe("buy");
    expect(duplicate.action).toBe("hold");
    expect(duplicate.reason).toMatch(/已完成七線掃描/);
  });

  it("統一決策入口在有持倉時直接走盲人管理，不再讀七線", () => {
    const decision = evaluateRainbow20415Decision(
      [],
      activeLongState(),
      createRainbow20415DefaultConfig(),
      { currentPrice: 100, now: START + 60_000, account: { marginUsagePct: 10 } },
    );
    expect(decision.action).toBe("hold");
    expect(decision.metrics.mode).toBe("BLIND");
  });
});
