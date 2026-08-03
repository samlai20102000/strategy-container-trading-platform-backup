import { describe, expect, it } from "vitest";

import { BUILT_IN_STRATEGY_KEYS } from "../strategyRunnerDescriptors";
import {
  BACKTEST_READINESS_REASON_TEXT_ZH_TW,
  describeBacktestReadinessReason,
} from "../../../shared/backtest/backtestReadiness";
import type { BacktestDataQuality } from "./backtestContracts";
import type { OHLCVRow } from "./backtestDatabase";
import {
  assessBacktestAdmission,
  assessBacktestDataQuality,
  assertBacktestReadinessMatrixIntegrity,
  listBacktestReadinessMatrix,
  resolveBacktestMinimumClosedBars,
} from "./backtestReadinessRegistry";

const MINUTE_MS = 60_000;

function candles(count: number, gapAt: number | null = null): OHLCVRow[] {
  let timestamp = 0;
  return Array.from({ length: count }, (_, index) => {
    if (index > 0) timestamp += gapAt === index ? MINUTE_MS * 10 : MINUTE_MS;
    return {
      symbol: "BTC-USDT-SWAP",
      timeframe: "1m",
      timestamp,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
    };
  });
}

function quality(inputCandles: number, overrides: Partial<BacktestDataQuality> = {}): BacktestDataQuality {
  return {
    intervalContract: "[start,end)",
    requestedStartMs: 0,
    requestedEndMs: Math.max(1, inputCandles) * MINUTE_MS,
    inputCandles,
    returnedCandles: inputCandles,
    candleCount: inputCandles,
    duplicateCandlesRemoved: 0,
    duplicateTimestampCount: 0,
    outOfRangeCandlesRemoved: 0,
    outOfRangeCount: 0,
    invalidCandlesRemoved: 0,
    invalidCandleCount: 0,
    unclosedCandlesRemoved: 0,
    unclosedCandleCount: 0,
    firstTimestamp: inputCandles > 0 ? 0 : null,
    lastTimestamp: inputCandles > 0 ? (inputCandles - 1) * MINUTE_MS : null,
    sortedAscending: true,
    ...overrides,
  };
}

describe("backtest readiness registry", () => {
  it("每個機器原因碼都有非空白的繁中 fail-closed 說明", () => {
    for (const [code, message] of Object.entries(BACKTEST_READINESS_REASON_TEXT_ZH_TW)) {
      expect(message.trim().length).toBeGreaterThan(0);
      expect(describeBacktestReadinessReason(code as keyof typeof BACKTEST_READINESS_REASON_TEXT_ZH_TW)).toBe(message);
    }
  });

  it("以 descriptor 的九個 canonical key 建立完整且可執行的 9/9 矩陣", () => {
    expect(() => assertBacktestReadinessMatrixIntegrity()).not.toThrow();
    const matrix = listBacktestReadinessMatrix();
    expect(matrix.map(entry => entry.strategyKey)).toEqual([...BUILT_IN_STRATEGY_KEYS]);
    expect(matrix).toHaveLength(9);
    for (const entry of matrix) {
      expect(entry.readiness).toBe("READY");
      expect(entry.certification).toBe("CERTIFIED");
      expect(entry.minimumClosedBars).toBeGreaterThan(0);
      expect(entry.baselineOracleTargets.length).toBeGreaterThan(0);
    }
  });

  it("未知策略、未認證 mode 與不支援 timeframe 均 fail closed", () => {
    expect(assessBacktestAdmission({
      strategyKey: "UNKNOWN_STRATEGY",
      timeframe: "15m",
      executionMode: "SINGLE_EXCLUSIVE",
    })).toMatchObject({ allowed: false, reasonCodes: ["BACKTEST_STRATEGY_NOT_AUDITED"] });

    expect(assessBacktestAdmission({
      strategyKey: "KAMA_RAINBOW_MARTIN_V1",
      timeframe: "15m",
      executionMode: "MULTI_SAME_SIDE",
    }).reasonCodes).toContain("BACKTEST_MODE_NOT_CERTIFIED");

    expect(assessBacktestAdmission({
      strategyKey: "strategy_20415",
      timeframe: "2m",
      executionMode: "SINGLE_EXCLUSIVE",
    }).reasonCodes).toContain("BACKTEST_TIMEFRAME_NOT_SUPPORTED");
  });

  it("依策略 canonical 參數提高最低已收盤 K 線需求", () => {
    expect(resolveBacktestMinimumClosedBars("KAMA_3K_TORNADO_V70", {
      ma200_period: 320,
    })).toBeGreaterThanOrEqual(340);
    expect(resolveBacktestMinimumClosedBars("KAMA_RAINBOW_MARTIN_V1", {
      kamaLines: [
        { enabled: true, erPeriod: 12 },
        { enabled: true, erPeriod: 24 },
        { enabled: true, erPeriod: 480 },
      ],
    })).toBeGreaterThanOrEqual(481);
  });

  it("拒絕空資料、資料量不足、未排序與過高拒收比例", () => {
    expect(assessBacktestDataQuality({
      quality: quality(0),
      candles: [],
      minimumClosedBars: 120,
      timeframeMs: MINUTE_MS,
    }).reasonCodes).toContain("BACKTEST_DATA_EMPTY");

    expect(assessBacktestDataQuality({
      quality: quality(100),
      candles: candles(100),
      minimumClosedBars: 120,
      timeframeMs: MINUTE_MS,
    }).reasonCodes).toContain("BACKTEST_DATA_INSUFFICIENT");

    expect(assessBacktestDataQuality({
      quality: quality(120, { sortedAscending: false }),
      candles: candles(120),
      minimumClosedBars: 120,
      timeframeMs: MINUTE_MS,
    }).reasonCodes).toContain("BACKTEST_DATA_NOT_SORTED");

    expect(assessBacktestDataQuality({
      quality: quality(120, { invalidCandleCount: 2, invalidCandlesRemoved: 2 }),
      candles: candles(120),
      minimumClosedBars: 120,
      timeframeMs: MINUTE_MS,
    }).reasonCodes).toContain("BACKTEST_DATA_REJECTION_RATIO_EXCEEDED");
  });

  it("資料缺口比例超過 5% 時 fail closed，少量缺口只發出 warning", () => {
    const failed = assessBacktestDataQuality({
      quality: quality(10),
      candles: candles(10, 2).map((row, index) => ({
        ...row,
        timestamp: index * MINUTE_MS * 10,
      })),
      minimumClosedBars: 1,
      timeframeMs: MINUTE_MS,
    });
    expect(failed.passed).toBe(false);
    expect(failed.reasonCodes).toContain("BACKTEST_DATA_GAP_RATIO_EXCEEDED");

    const warned = assessBacktestDataQuality({
      quality: quality(100),
      candles: candles(100, 50),
      minimumClosedBars: 1,
      timeframeMs: MINUTE_MS,
    });
    expect(warned.passed).toBe(true);
    expect(warned.warnings.some(message => message.includes("時間缺口"))).toBe(true);
  });
});
