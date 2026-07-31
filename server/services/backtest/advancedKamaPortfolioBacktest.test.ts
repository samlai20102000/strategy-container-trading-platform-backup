import { describe, expect, it } from "vitest";
import type { BaseStrategy } from "../../strategies/base";
import {
  createDefaultExecutionPolicy,
  type ExecutionPolicy,
  type StrategyModeCapabilities,
} from "../../../shared/executionModes";
import type { OHLCVRow } from "./backtestDatabase";
import {
  runAdvancedKamaPortfolioBacktest,
} from "./advancedKamaPortfolioBacktest";
import type { BacktestRequest } from "./backtestEngine";

const strategy = {
  name: "KAMA three-mode test strategy",
} as BaseStrategy;

const capabilities: StrategyModeCapabilities = {
  contractVersion: "strategy-mode-capabilities-v1",
  supportedModes: ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"],
  martingaleLayers: true,
  independentLegState: true,
  hedgeGuard: true,
  preciseLegClose: true,
};

function candlesFromCloses(closes: number[]): OHLCVRow[] {
  return closes.map((close, index) => {
    const previous = index === 0 ? close : closes[index - 1];
    return {
      timestamp: 1_700_000_000_000 + index * 60_000,
      open: previous,
      high: Math.max(previous, close) + 0.25,
      low: Math.min(previous, close) - 0.25,
      close,
      volume: 100,
    };
  });
}

function requestFor(policy: ExecutionPolicy, candles: OHLCVRow[]): BacktestRequest {
  return {
    strategyKey: "20415_KAMA_MARTIN_V35",
    symbol: "BTC-USDT-SWAP",
    timeframe: "1m",
    startDate: candles[0].timestamp,
    endDate: candles[candles.length - 1].timestamp + 60_000,
    initialCapital: 10_000,
    commission: 0.0004,
    slippage: 0.0001,
    executionMode: policy.mode,
    executionPolicy: policy,
    strategyModeCapabilities: capabilities,
    strategyVersion: "test-v1",
    strategyLogicHash: "sha256:test-kama-three-mode-v1",
    endPositionPolicy: "mark_to_market",
    config: {
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
    },
  };
}

async function run(policy: ExecutionPolicy, candles: OHLCVRow[]) {
  const request = requestFor(policy, candles);
  return runAdvancedKamaPortfolioBacktest({
    request,
    strategy,
    config: request.config,
    candles,
    startMs: request.startDate,
    endMs: request.endDate,
    executionPolicy: policy,
    endPositionPolicy: "mark_to_market",
    commission: request.commission ?? 0,
    slippage: request.slippage ?? 0,
  });
}

describe("advanced KAMA portfolio runner", () => {
  it("M2 在趨勢反轉後保留 LONG／SHORT 兩條獨立腿並維持單一權益帳本", async () => {
    const candles = candlesFromCloses([
      100, 101, 102, 103, 104, 105, 106, 105, 103, 101, 99, 97, 95, 94,
    ]);
    const result = await run(createDefaultExecutionPolicy("MULTI_POSITION"), candles);

    expect(result.modeResults?.executionMode).toBe("MULTI_POSITION");
    expect(new Set(result.legAccounting?.openLegs.map(leg => leg.sideCode))).toEqual(new Set(["LONG", "SHORT"]));
    expect(result.legAccounting?.openLegs.every(leg => leg.role === "INDEPENDENT")).toBe(true);
    expect(result.accounting?.balanced).toBe(true);
    expect(result.accounting?.openPositionCount).toBe(2);
  });

  it("H3 只有主腿浮虧且出現反向信號時建立受 ratio 約束的 HEDGE 腿", async () => {
    const candles = candlesFromCloses([
      100, 101, 102, 103, 104, 105, 106, 104, 101, 98, 95, 92, 90, 88,
    ]);
    const policy = {
      ...createDefaultExecutionPolicy("HEDGE_GUARDED"),
      primaryLossTriggerPct: 0.2,
      hedgeRatio: 0.5,
      maxHedgeRatio: 0.5,
      hedgeCooldownSeconds: 0,
      minimumHedgeHoldSeconds: 0,
    } as ExecutionPolicy;
    const result = await run(policy, candles);

    const primary = result.legAccounting?.openLegs.find(leg => leg.role === "PRIMARY");
    const hedge = result.legAccounting?.openLegs.find(leg => leg.role === "HEDGE");
    expect(primary).toBeDefined();
    expect(hedge).toBeDefined();
    expect(primary?.sideCode).not.toBe(hedge?.sideCode);
    expect((hedge?.size ?? 0) / (primary?.size ?? 1)).toBeCloseTo(0.5, 6);
    expect(result.legAccounting?.hedgeRelationships).toHaveLength(1);
    expect(result.accounting?.balanced).toBe(true);
  });

  it("相同 candles／policy 重播產生相同逐腿成交、事件與會計", async () => {
    const candles = candlesFromCloses([
      100, 101, 102, 103, 104, 103, 101, 99, 97, 96, 98, 100, 102, 104,
    ]);
    const policy = createDefaultExecutionPolicy("MULTI_POSITION");
    const first = await run(policy, candles);
    const second = await run(policy, candles);

    expect(second.trades).toEqual(first.trades);
    expect(second.equityCurve).toEqual(first.equityCurve);
    expect(second.accounting).toEqual(first.accounting);
    expect(second.legAccounting).toEqual(first.legAccounting);
    expect(second.modeResults).toEqual(first.modeResults);
  });
});
