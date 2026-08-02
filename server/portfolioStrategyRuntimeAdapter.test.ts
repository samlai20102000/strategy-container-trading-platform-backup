import { afterEach, describe, expect, it } from "vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPortfolioStrategyRuntimeAdapter,
  registerPortfolioStrategyRuntimeFactory,
  resolvePortfolioStrategyAdapter,
  unregisterPortfolioStrategyRuntimeFactory,
} from "./services/backtest/portfolioStrategyAdapterRegistry";
import { ensureBuiltInPortfolioRuntimeFactoriesRegistered } from "./services/backtest/builtInPortfolioRuntimeFactories";
import type { BacktestOpenLegSnapshot } from "./services/backtest/backtestContracts";
import type { OHLCVRow } from "./services/backtest/backtestDatabase";
import type { PortfolioAdapterBarContext } from "./services/backtest/portfolioStrategyRuntimeAdapter";
import {
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  createKamaRainbowMartinDefaultConfig,
} from "../shared/strategies/kamaRainbowMartin";
import { createDefaultStrategyExecutionPolicy } from "../shared/strategies/kamaRainbowMartinExecutionPolicy";

function candlesFromCloses(closes: number[]): OHLCVRow[] {
  return closes.map((close, index) => ({
    symbol: "BTC-USDT",
    timeframe: "30m",
    timestamp: 1_700_000_000_000 + index * 1_800_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
  }));
}

function openLeg(input: {
  legId: string;
  cycleId: string;
  role: BacktestOpenLegSnapshot["role"];
  side: "long" | "short";
  entryPrice: number;
  markPrice: number;
  size?: number;
  martinLayer?: number;
}): BacktestOpenLegSnapshot {
  const size = input.size ?? 1;
  const unrealizedGrossPnl = input.side === "long"
    ? (input.markPrice - input.entryPrice) * size
    : (input.entryPrice - input.markPrice) * size;
  return {
    legId: input.legId,
    cycleId: input.cycleId,
    role: input.role,
    side: input.side,
    sideCode: input.side === "long" ? "LONG" : "SHORT",
    entryTime: 1_700_000_000_000,
    averageEntryPrice: input.entryPrice,
    lastEntryPrice: input.entryPrice,
    size,
    markPrice: input.markPrice,
    entryNotional: input.entryPrice * size,
    entryFees: 0,
    unrealizedGrossPnl,
    unrealizedPnl: unrealizedGrossPnl,
    martinLayer: input.martinLayer ?? 0,
    openedAt: 1_700_000_000_000,
    mfePct: 0,
    maePct: Math.min(0, (unrealizedGrossPnl / (input.entryPrice * size)) * 100),
  };
}

function barContext(input: {
  candles: OHLCVRow[];
  index: number;
  mode: "MULTI_POSITION" | "HEDGE_GUARDED";
  openLegs: BacktestOpenLegSnapshot[];
}): PortfolioAdapterBarContext {
  const policy = createDefaultStrategyExecutionPolicy(KAMA_RAINBOW_MARTIN_STRATEGY_KEY, input.mode);
  return {
    index: input.index,
    timestamp: input.candles[input.index].timestamp,
    candle: input.candles[input.index],
    previousCandle: offset => input.candles[input.index - offset],
    config: createKamaRainbowMartinDefaultConfig(),
    strategy: {} as PortfolioAdapterBarContext["strategy"],
    executionMode: input.mode,
    executionPolicy: policy,
    initialCapital: 10_000,
    baseLotUsdt: 100,
    openLegs: input.openLegs,
    indicators: { kamaFast: null, kamaSlow: null, atr: 1, atrAverage: 1 },
    consecutiveLosses: 0,
    closedTradeCount: 0,
  };
}

describe("portfolio strategy runtime adapter boundary", () => {
  const adapterId = "kama-3k-v41-portfolio";

  beforeEach(() => ensureBuiltInPortfolioRuntimeFactoriesRegistered());
  afterEach(() => ensureBuiltInPortfolioRuntimeFactoriesRegistered());

  it("沒有 executable factory 時 fail explicit，不會落入 generic 指標策略", () => {
    unregisterPortfolioStrategyRuntimeFactory(adapterId);
    const resolved = resolvePortfolioStrategyAdapter("20415_KAMA_MARTIN_V41", "MULTI_POSITION");
    expect(() => createPortfolioStrategyRuntimeAdapter(resolved, {
      strategy: {} as never,
      config: {},
      candles: [],
      executionPolicy: {
        mode: "MULTI_POSITION",
        grossExposureCapPct: 100,
        marginUsageCapPct: 40,
        capabilityTtlSeconds: 60,
        hedge: { reverseSignalBehavior: "WAIT_FOR_FLAT", triggerLossPct: 3, targetRatio: 0.5, unwindRecoveryPct: 1 },
      },
      initialCapital: 10_000,
      baseLotUsdt: 100,
    })).toThrow("PORTFOLIO_ADAPTER_IMPLEMENTATION_MISSING");
  });

  it("runtime factory 必須與 descriptor／metadata 版本完全一致", () => {
    expect(() => registerPortfolioStrategyRuntimeFactory(adapterId, 99, () => ({
      adapterId,
      adapterVersion: 99,
      ownsPositionManagement: false,
      evaluateBar: () => ({ management: [], entries: [] }),
    }))).toThrow("PORTFOLIO_RUNTIME_FACTORY_VERSION_MISMATCH");
  });

  it("KRM M2 只在 S1 浮虧的反向訊號開一次，關閉 M2 後同 cycle 仍不得重開", async () => {
    const candles = candlesFromCloses(Array.from({ length: 31 }, (_, index) => 200 - index));
    const policy = createDefaultStrategyExecutionPolicy(KAMA_RAINBOW_MARTIN_STRATEGY_KEY, "MULTI_POSITION");
    const resolved = resolvePortfolioStrategyAdapter(KAMA_RAINBOW_MARTIN_STRATEGY_KEY, "MULTI_POSITION");
    const adapter = createPortfolioStrategyRuntimeAdapter(resolved, {
      strategy: {} as PortfolioAdapterBarContext["strategy"],
      config: createKamaRainbowMartinDefaultConfig(),
      candles,
      executionPolicy: policy,
      initialCapital: 10_000,
      baseLotUsdt: 100,
    });
    const primary = openLeg({
      legId: "krm-primary-1",
      cycleId: "krm-cycle-1",
      role: "PRIMARY",
      side: "long",
      entryPrice: 180,
      markPrice: candles[29].close,
    });
    const firstContext = barContext({ candles, index: 29, mode: "MULTI_POSITION", openLegs: [primary] });
    const first = await adapter.evaluateBar(firstContext);
    expect(first.entries).toEqual([
      expect.objectContaining({
        action: "OPEN_SHORT",
        roleHint: "INDEPENDENT",
        cycleIdHint: primary.cycleId,
        reasonCode: "KRM_M2_LOSS_REVERSE_SHORT",
      }),
    ]);

    const independent = openLeg({
      legId: "krm-independent-1",
      cycleId: primary.cycleId,
      role: "INDEPENDENT",
      side: "short",
      entryPrice: candles[29].close,
      markPrice: candles[29].close,
    });
    await adapter.onBarCommitted?.({ ...firstContext, beforeLegs: [primary], afterLegs: [primary, independent] });
    await adapter.onBarCommitted?.({
      ...firstContext,
      openLegs: [primary, independent],
      beforeLegs: [primary, independent],
      afterLegs: [primary],
    });
    const repeated = await adapter.evaluateBar(firstContext);
    expect(repeated.entries).toEqual([]);

    const nextPrimary = openLeg({
      legId: "krm-primary-2",
      cycleId: "krm-cycle-2",
      role: "PRIMARY",
      side: "long",
      entryPrice: 180,
      markPrice: candles[30].close,
    });
    const nextCycle = await adapter.evaluateBar(barContext({
      candles,
      index: 30,
      mode: "MULTI_POSITION",
      openLegs: [nextPrimary],
    }));
    expect(nextCycle.entries).toEqual([
      expect.objectContaining({ roleHint: "INDEPENDENT", cycleIdHint: "krm-cycle-2" }),
    ]);
  });

  it("KRM H3 由主腿保護條件自動產生候選，不等待 KAMA 反向訊號", async () => {
    const candles = candlesFromCloses(Array.from({ length: 31 }, () => 100));
    const policy = createDefaultStrategyExecutionPolicy(KAMA_RAINBOW_MARTIN_STRATEGY_KEY, "HEDGE_GUARDED");
    const resolved = resolvePortfolioStrategyAdapter(KAMA_RAINBOW_MARTIN_STRATEGY_KEY, "HEDGE_GUARDED");
    const adapter = createPortfolioStrategyRuntimeAdapter(resolved, {
      strategy: {} as PortfolioAdapterBarContext["strategy"],
      config: createKamaRainbowMartinDefaultConfig(),
      candles,
      executionPolicy: policy,
      initialCapital: 10_000,
      baseLotUsdt: 100,
    });
    const primary = openLeg({
      legId: "krm-h3-primary",
      cycleId: "krm-h3-cycle",
      role: "PRIMARY",
      side: "long",
      entryPrice: 105,
      markPrice: 100,
      size: 2,
    });
    const decision = await adapter.evaluateBar(barContext({
      candles,
      index: 30,
      mode: "HEDGE_GUARDED",
      openLegs: [primary],
    }));
    expect(decision.entries).toEqual([
      expect.objectContaining({
        action: "OPEN_SHORT",
        roleHint: "HEDGE",
        cycleIdHint: primary.cycleId,
        reasonCode: "KRM_H3_AUTO_PROTECTION_CANDIDATE",
      }),
    ]);
  });
});
