import { describe, expect, it } from "vitest";
import { createKamaRainbowMartinDefaultConfig } from "../shared/strategies/kamaRainbowMartin";
import { createInitialStrategyState, type KLineData } from "./strategies/base";
import {
  classifyKamaRainbowMartinLines,
  createKamaRainbowMartinRuntimeState,
  evaluateKamaRainbowMartinEntry,
  type KamaRainbowMartinLineObservation,
  type KamaRainbowMartinSnapshot,
} from "./strategies/kamaRainbowMartin/core";

function line(id: string, previous: number, current: number): KamaRainbowMartinLineObservation {
  return { id, name: id, previous, current, slope: current - previous };
}

function candlesFromCloses(closes: number[]): KLineData[] {
  return closes.map((close, index) => ({
    timestamp: 1_700_000_000_000 + index * 1_800_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
  }));
}

describe("Kama 彩虹馬丁交叉鎖與 entry evaluator", () => {
  it("以任意線對的 previous/current delta 判定 cross 與 touch", () => {
    expect(classifyKamaRainbowMartinLines([line("A", 1, 3), line("B", 2, 2)]).reasonCode).toBe(
      "KRM_CROSS_LOCK",
    );
    expect(classifyKamaRainbowMartinLines([line("A", 1, 2), line("B", 1, 3)])).toEqual({
      reasonCode: "KRM_TOUCH_LOCK",
      direction: "MIXED",
      lockedPair: ["A", "B"],
    });
  });

  it("只有所有啟用線嚴格同向才產生 ALL_UP／ALL_DOWN", () => {
    expect(classifyKamaRainbowMartinLines([line("A", 1, 2), line("B", 3, 4)]).reasonCode).toBe("KRM_ALL_UP");
    expect(classifyKamaRainbowMartinLines([line("A", 2, 1), line("B", 4, 3)]).reasonCode).toBe("KRM_ALL_DOWN");
    expect(classifyKamaRainbowMartinLines([line("A", 1, 2), line("B", 4, 3)]).reasonCode).toBe(
      "KRM_MIXED_SLOPE",
    );
  });

  it("目標腿有持倉時優先跳過 KAMA，即使沒有 candles 仍進入管理", () => {
    const state = createInitialStrategyState();
    Object.assign(state, { currentLayer: 1, totalSize: 0.01, avgPrice: 100, totalCost: 1 });
    const decision = evaluateKamaRainbowMartinEntry({ candles: [], state, lastBarClosed: false });
    expect(decision.action).toBe("MANAGE_POSITION");
    expect(decision.reasonCode).toBe("KRM_POSITION_MANAGEMENT");
    expect(decision.snapshot.lines).toEqual([]);
  });

  it("配置、未收線及資料不足全部 fail closed", () => {
    const state = createInitialStrategyState();
    const config = createKamaRainbowMartinDefaultConfig();
    config.kamaLines[0].fastEma = 31;
    expect(evaluateKamaRainbowMartinEntry({ candles: [], state, rawConfig: config }).reasonCode).toBe(
      "KRM_CONFIG_INVALID",
    );
    expect(evaluateKamaRainbowMartinEntry({ candles: [], state, lastBarClosed: false }).reasonCode).toBe(
      "KRM_CANDLE_UNCLOSED",
    );
    expect(evaluateKamaRainbowMartinEntry({ candles: [], state }).reasonCode).toBe("KRM_DATA_NOT_READY");
  });

  it("單調資料產生 long／short 候選，方向限制仍可阻擋", () => {
    const upCandles = candlesFromCloses(Array.from({ length: 30 }, (_, index) => 100 + index));
    const downCandles = candlesFromCloses(Array.from({ length: 30 }, (_, index) => 200 - index));
    const state = createInitialStrategyState();
    expect(evaluateKamaRainbowMartinEntry({ candles: upCandles, state, lastBarClosed: true }).reasonCode).toBe(
      "KRM_ALL_UP",
    );
    expect(evaluateKamaRainbowMartinEntry({ candles: downCandles, state, lastBarClosed: true }).reasonCode).toBe(
      "KRM_ALL_DOWN",
    );
    expect(
      evaluateKamaRainbowMartinEntry({
        candles: upCandles,
        state,
        lastBarClosed: true,
        allowedDirection: "short",
      }).reasonCode,
    ).toBe("KRM_DIRECTION_BLOCKED");
  });

  it("完整平倉後僅在開關啟用且當下條件仍成立時允許同棒重新入市", () => {
    const barTimestamp = 1_900_000_000_000;
    const barKey = `revision-a:${barTimestamp}`;
    const trendingSnapshot: KamaRainbowMartinSnapshot = {
      lines: [line("A", 100, 101), line("B", 90, 91)],
      ready: true,
      requiredBars: 21,
      availableBars: 30,
      barTimestamp,
      closePrice: 101,
      direction: "UP",
      lockedPair: null,
    };
    const closedState = createKamaRainbowMartinRuntimeState();
    Object.assign(closedState.kamaRainbowMartinRuntime!, {
      lastCloseReason: "TRAILING_TAKE_PROFIT",
      reentryPending: true,
      lastProcessedBarKey: barKey,
      lastProcessedBarTimestamp: barTimestamp,
    });

    const enabledConfig = createKamaRainbowMartinDefaultConfig();
    enabledConfig.reentryEnabled = true;
    const enabled = evaluateKamaRainbowMartinEntry({
      state: closedState,
      rawConfig: enabledConfig,
      configRevision: "revision-a",
      precomputedSnapshot: trendingSnapshot,
      lastBarClosed: true,
    });
    expect(enabled.action).toBe("OPEN_LONG");
    expect(enabled.reasonCode).toBe("KRM_ALL_UP");
    expect(enabled.nextState.kamaRainbowMartinRuntime?.reentryPending).toBe(false);

    const disabled = evaluateKamaRainbowMartinEntry({
      state: closedState,
      rawConfig: createKamaRainbowMartinDefaultConfig(),
      configRevision: "revision-a",
      precomputedSnapshot: trendingSnapshot,
      lastBarClosed: true,
    });
    expect(disabled.action).toBe("HOLD");
    expect(disabled.reasonCode).toBe("KRM_REENTRY_DISABLED");

    const mixedSnapshot: KamaRainbowMartinSnapshot = {
      ...trendingSnapshot,
      lines: [line("A", 100, 101), line("B", 91, 90)],
      direction: "MIXED",
    };
    const conditionsFailed = evaluateKamaRainbowMartinEntry({
      state: closedState,
      rawConfig: enabledConfig,
      configRevision: "revision-a",
      precomputedSnapshot: mixedSnapshot,
      lastBarClosed: true,
    });
    expect(conditionsFailed.action).toBe("HOLD");
    expect(conditionsFailed.reasonCode).toBe("KRM_MIXED_SLOPE");
  });

  it("同 config revision／bar 只掃描一次，revision 改變才可重新評估", () => {
    const candles = candlesFromCloses(Array.from({ length: 30 }, (_, index) => 100 + index));
    const first = evaluateKamaRainbowMartinEntry({
      candles,
      state: createKamaRainbowMartinRuntimeState(),
      configRevision: "revision-a",
      lastBarClosed: true,
    });
    const duplicate = evaluateKamaRainbowMartinEntry({
      candles,
      state: first.nextState,
      configRevision: "revision-a",
      lastBarClosed: true,
    });
    const changedRevision = evaluateKamaRainbowMartinEntry({
      candles,
      state: first.nextState,
      configRevision: "revision-b",
      lastBarClosed: true,
    });
    expect(duplicate.reasonCode).toBe("KRM_BAR_ALREADY_PROCESSED");
    expect(changedRevision.reasonCode).toBe("KRM_ALL_UP");
  });
});
