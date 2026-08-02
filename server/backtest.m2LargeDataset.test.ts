import { describe, expect, it } from "vitest";
import { normalizeExecutionModePolicy } from "../shared/executionModes";
import type { BaseStrategy } from "./strategies/base";
import { getStrategyChannelCapabilities } from "./services/strategyRunnerDescriptors";
import { runAdvancedKamaPortfolioBacktest } from "./services/backtest/advancedKamaPortfolioBacktest";
import type { OHLCVRow } from "./services/backtest/backtestDatabase";
import type { BacktestJobCheckpoint, BacktestJobControl } from "./services/backtest/backtestJobControl";
import type { BacktestRequest } from "./services/backtest/backtestEngine";

const BAR_COUNT = 27_744;
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const CERTIFIED_ADVANCED_STRATEGY_KEY = "20415_KAMA_MARTIN_V35";
const strategy = { name: "V3.5 advanced large-dataset guard" } as BaseStrategy;
const config = {
  KAMA_Fast_Length: 3,
  KAMA_Slow_Length: 3,
  p2_fastest: 2,
  p3_slowest: 5,
  q2_fastest: 10,
  q3_slowest: 20,
  enableThreeKFilter: false,
  enableKamaDirectionLock: true,
  Base_Lot_Size: { mode: "usdt", value: 100 },
  Max_Layers: 1,
  Max_Loss_Pct: 90,
  Max_Drawdown_Pct: 90,
  Max_Deviation_Pct: 90,
  Target_TP_Pct: 90,
  Callback_Pct: 1,
  enable_loss_shrink: false,
  enable_continuous_entry: true,
};

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

describe("認證 advanced portfolio runner 大型資料回測", () => {
  it("V3.5 可線性處理 27,744 根 K 線，保留共用 O(n) 預計算與 checkpoint 基礎設施", async () => {
    const candles = createDeterministicCandles();
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
      strategyKey: CERTIFIED_ADVANCED_STRATEGY_KEY,
      symbol: "BTC-USDT-SWAP",
      timeframe: "30m",
      startDate: candles[0].timestamp,
      endDate: candles.at(-1)!.timestamp,
      initialCapital: 10_000,
      config,
      commission: 0.0004,
      slippage: 0.0001,
      endPositionPolicy: "mark_to_market",
      executionMode: "MULTI_POSITION",
      executionPolicy,
      strategyModeCapabilities: getStrategyChannelCapabilities(CERTIFIED_ADVANCED_STRATEGY_KEY, "BACKTEST", true),
    };

    const startedAt = performance.now();
    const result = await runAdvancedKamaPortfolioBacktest({
      request,
      strategy,
      config,
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
    expect(elapsedMs).toBeLessThan(30_000);
  }, 45_000);
});
