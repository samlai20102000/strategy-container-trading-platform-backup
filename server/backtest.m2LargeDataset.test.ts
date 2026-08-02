import { describe, expect, it } from "vitest";
import { normalizeExecutionModePolicy } from "../shared/executionModes";
import { StrategyKamaRainbowMartin } from "./strategies/builtin/strategyKamaRainbowMartin";
import { getStrategyChannelCapabilities } from "./services/strategyRunnerDescriptors";
import { runAdvancedKamaPortfolioBacktest } from "./services/backtest/advancedKamaPortfolioBacktest";
import type { OHLCVRow } from "./services/backtest/backtestDatabase";
import type { BacktestJobCheckpoint, BacktestJobControl } from "./services/backtest/backtestJobControl";
import type { BacktestRequest } from "./services/backtest/backtestEngine";

const BAR_COUNT = 27_744;
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;

function createDeterministicCandles(): OHLCVRow[] {
  const start = Date.UTC(2024, 0, 1);
  return Array.from({ length: BAR_COUNT }, (_, index) => {
    const slowWave = Math.sin(index / 73) * 220;
    const fastWave = Math.sin(index / 11) * 35;
    const drift = index * 0.035;
    const close = 42_000 + drift + slowWave + fastWave;
    const open = close - Math.sin(index / 5) * 12;
    return {
      symbol: "BTC-USDT-SWAP",
      timeframe: "30m",
      timestamp: start + index * THIRTY_MINUTES_MS,
      open,
      high: Math.max(open, close) + 18,
      low: Math.min(open, close) - 18,
      close,
      volume: 100 + (index % 37),
    };
  });
}

describe("Kama 彩虹馬丁 M2 大型資料回測", () => {
  it("可線性處理 27,744 根 K 線並跨越舊 10,000 根／56% 停滯點", async () => {
    const candles = createDeterministicCandles();
    const strategy = new StrategyKamaRainbowMartin();
    const executionPolicy = normalizeExecutionModePolicy({ mode: "MULTI_POSITION" });
    const checkpoints: BacktestJobCheckpoint[] = [];
    const controller = new AbortController();
    const jobControl: BacktestJobControl = {
      signal: controller.signal,
      checkpoint: async checkpoint => {
        checkpoints.push({ ...checkpoint });
      },
      throwIfCancelled: async () => undefined,
    };
    const request: BacktestRequest = {
      strategyKey: strategy.key,
      symbol: "BTC-USDT-SWAP",
      timeframe: "30m",
      startDate: candles[0].timestamp,
      endDate: candles.at(-1)!.timestamp,
      initialCapital: 10_000,
      config: strategy.defaultConfig,
      commission: 0.0004,
      slippage: 0.0001,
      endPositionPolicy: "mark_to_market",
      executionMode: "MULTI_POSITION",
      executionPolicy,
      strategyModeCapabilities: getStrategyChannelCapabilities(strategy.key, "BACKTEST", true),
    };

    const startedAt = performance.now();
    const result = await runAdvancedKamaPortfolioBacktest({
      request,
      strategy,
      config: strategy.defaultConfig,
      candles,
      startMs: request.startDate,
      endMs: request.endDate,
      executionPolicy,
      endPositionPolicy: "mark_to_market",
      commission: request.commission!,
      slippage: request.slippage!,
      jobControl,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.candleCount).toBe(BAR_COUNT);
    expect(result.modeResults.executionMode).toBe("MULTI_POSITION");
    expect(checkpoints.some(checkpoint => checkpoint.processedBars >= 10_000)).toBe(true);
    expect(checkpoints.some(checkpoint => checkpoint.processedBars > 10_000)).toBe(true);
    expect(checkpoints.at(-1)?.phase).toBe("FINALIZING");
    expect(checkpoints.at(-1)?.processedBars).toBe(BAR_COUNT);
    for (let index = 1; index < checkpoints.length; index += 1) {
      expect(checkpoints[index].processedBars).toBeGreaterThanOrEqual(checkpoints[index - 1].processedBars);
      expect(checkpoints[index].progress).toBeGreaterThanOrEqual(checkpoints[index - 1].progress);
    }
    // O(n) 正式路徑應遠低於 Heartbeat 兩分鐘上限；保留 CI／共享 CPU 餘裕。
    expect(elapsedMs).toBeLessThan(30_000);
  }, 45_000);
});
