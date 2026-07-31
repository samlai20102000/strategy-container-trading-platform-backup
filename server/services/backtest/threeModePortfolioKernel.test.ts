import { describe, expect, it } from "vitest";

import {
  createDefaultExecutionPolicy,
  type CandidateIntentAction,
  type ExecutionPolicy,
  type HedgeGuardedPolicy,
} from "../../../shared/executionModes";
import {
  BACKTEST_ENGINE_VERSION,
  BACKTEST_RISK_MODEL_VERSION,
  BACKTEST_SIMULATED_ADAPTER_VERSION,
  buildBacktestComparisonGroupId,
  buildBacktestHash,
  evaluateBacktestFairness,
} from "./backtestContracts";
import {
  createThreeModePortfolioKernel,
  type BacktestPortfolioCandidate,
  type ThreeModePortfolioConfig,
} from "./threeModePortfolioKernel";

function candidate(
  id: string,
  timestamp: number,
  action: CandidateIntentAction,
  quantity = 1,
  overrides: Partial<BacktestPortfolioCandidate> = {},
): BacktestPortfolioCandidate {
  const side = action.endsWith("LONG") ? "LONG" : action.endsWith("SHORT") ? "SHORT" : undefined;
  return {
    candidateId: id,
    deploymentId: 77,
    action,
    side,
    requestedQuantity: quantity,
    signalPrice: 100,
    barTimestamp: timestamp,
    source: "AUTO",
    reasonCode: `TEST_${action}`,
    reason: action,
    createdAt: timestamp,
    ...overrides,
  };
}

function kernel(
  policy: ExecutionPolicy,
  overrides: Partial<ThreeModePortfolioConfig> = {},
) {
  return createThreeModePortfolioKernel({
    deploymentId: 77,
    executionPolicy: policy,
    initialCapital: 10_000,
    leverage: 1,
    commissionRate: 0,
    slippageRate: 0,
    ...overrides,
  });
}

describe("ThreeModePortfolioKernel", () => {
  it("S1 在分層加倉後依加權均價與逐腿費用得出 golden parity", () => {
    const portfolio = kernel(createDefaultExecutionPolicy("SINGLE_EXCLUSIVE"), {
      commissionRate: 0.001,
    });

    portfolio.processBar({ timestamp: 1_000, price: 100 }, [candidate("s1-open", 1_000, "OPEN_LONG", 2)]);
    portfolio.processBar({ timestamp: 2_000, price: 90 }, [candidate("s1-add", 2_000, "ADD_LONG", 1)]);
    portfolio.processBar({ timestamp: 3_000, price: 110 }, [candidate("s1-close", 3_000, "CLOSE_LONG", 3)]);
    const result = portfolio.finalize("force_close", 4_000, 110);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      side: "LONG",
      role: "PRIMARY",
      quantity: 3,
      grossPnl: 40,
      fees: 0.62,
      pnl: 39.38,
    });
    expect(result.accounting).toMatchObject({
      realizedPnl: 39.38,
      unrealizedPnl: 0,
      finalEquity: 10_039.38,
      expectedFinalEquity: 10_039.38,
      openPositionCount: 0,
      reconciled: true,
    });
    expect(result.legAccounting.legs[0]).toMatchObject({ addCount: 1, tradeCount: 1 });
  });

  it("M2 同時維持 LONG／SHORT，僅同向腿接收加倉與精確關腿", () => {
    const portfolio = kernel(createDefaultExecutionPolicy("MULTI_POSITION"));

    portfolio.processBar({ timestamp: 1_000, price: 100 }, [candidate("m2-long", 1_000, "OPEN_LONG", 1)]);
    portfolio.processBar({ timestamp: 2_000, price: 101 }, [candidate("m2-short", 2_000, "OPEN_SHORT", 2)]);
    portfolio.processBar({ timestamp: 3_000, price: 99 }, [candidate("m2-add-long", 3_000, "ADD_LONG", 0.5)]);
    portfolio.processBar({ timestamp: 4_000, price: 103 }, [candidate("m2-close-long", 4_000, "CLOSE_LONG", 1.5)]);
    const result = portfolio.finalize("mark_to_market", 5_000, 102);

    expect(result.accounting.openPositionCount).toBe(1);
    expect(result.legAccounting.openLegs[0]).toMatchObject({
      sideCode: "SHORT",
      role: "INDEPENDENT",
      size: 2,
    });
    const longLeg = result.legAccounting.legs.find(leg => leg.sideCode === "LONG");
    const shortLeg = result.legAccounting.legs.find(leg => leg.sideCode === "SHORT");
    expect(longLeg).toMatchObject({ addCount: 1, tradeCount: 1, closedAt: 4_000 });
    expect(shortLeg).toMatchObject({ addCount: 0, tradeCount: 0, closedAt: null });
    expect(result.modeResults.overlapDurationMs).toBeGreaterThan(0);
    expect(result.accounting.reconciled).toBe(true);
  });

  it("H3 只在主腿達虧損門檻且有反向信號時建立固定比例保護腿", () => {
    const policy = {
      ...createDefaultExecutionPolicy("HEDGE_GUARDED"),
      hedgeCooldownSeconds: 30,
      minimumHedgeHoldSeconds: 0,
      unwindPolicy: "CLOSE_HEDGE_ON_RECOVERY",
    } satisfies HedgeGuardedPolicy;
    const portfolio = kernel(policy);

    portfolio.processBar({ timestamp: 1_000, price: 100 }, [candidate("h3-primary", 1_000, "OPEN_LONG", 2)]);
    portfolio.processBar({ timestamp: 2_000, price: 98 }, [candidate("h3-reverse-early", 2_000, "OPEN_SHORT", 2)]);
    portfolio.processBar({ timestamp: 3_000, price: 94 }, [candidate("h3-reverse-trigger", 3_000, "OPEN_SHORT", 2)]);
    let result = portfolio.finalize("mark_to_market", 3_500, 94);

    expect(result.decisions.find(item => item.candidateId === "h3-reverse-early")).toMatchObject({
      outcome: "HOLD",
      reasonCode: "H3_LOSS_THRESHOLD_NOT_MET",
    });
    expect(result.decisions.find(item => item.candidateId === "h3-reverse-trigger")).toMatchObject({
      outcome: "APPROVED",
      reasonCode: "H3_HEDGE_ARMED",
      targetRole: "HEDGE",
      approvedQuantity: 1,
    });
    expect(result.legAccounting.openLegs).toHaveLength(2);
    expect(result.legAccounting.hedgeRelationships[0]).toMatchObject({
      targetRatio: 0.5,
      actualRatio: 0.5,
      triggerLossPct: 6,
    });

    portfolio.processBar({ timestamp: 4_000, price: 101 }, []);
    result = portfolio.finalize("mark_to_market", 4_100, 101);
    expect(result.legAccounting.openLegs).toHaveLength(1);
    expect(result.legAccounting.openLegs[0]).toMatchObject({ role: "PRIMARY", sideCode: "LONG" });
    expect(result.legAccounting.hedgeRelationships[0]).toMatchObject({
      closedAt: 4_000,
      unwindOutcome: "H3_PRIMARY_RECOVERED",
    });

    portfolio.processBar({ timestamp: 5_000, price: 90 }, [candidate("h3-cooldown", 5_000, "OPEN_SHORT", 2)]);
    result = portfolio.finalize("mark_to_market", 5_100, 90);
    expect(result.decisions.find(item => item.candidateId === "h3-cooldown")).toMatchObject({
      outcome: "HOLD",
      reasonCode: "H3_COOLDOWN_ACTIVE",
    });
  });

  it("同 K 棒固定先關腿再加倉，且重播 candidate 不會產生第二次成交", () => {
    const portfolio = kernel(createDefaultExecutionPolicy("SINGLE_EXCLUSIVE"));
    portfolio.processBar({ timestamp: 1_000, price: 100 }, [candidate("order-open", 1_000, "OPEN_LONG", 1)]);

    const add = candidate("order-add", 2_000, "ADD_LONG", 1, { eventKind: "MARTIN_ADD" });
    const close = candidate("order-close", 2_000, "CLOSE_LONG", 1, { eventKind: "REGULAR_EXIT" });
    portfolio.processBar({ timestamp: 2_000, price: 99 }, [add, close]);
    portfolio.processBar({ timestamp: 3_000, price: 98 }, [add]);
    const result = portfolio.finalize("mark_to_market", 4_000, 98);

    const sameBarEvents = result.events.filter(event => event.timestamp === 2_000);
    expect(sameBarEvents.map(event => event.eventKind)).toEqual(["REGULAR_EXIT", "MARTIN_ADD"]);
    expect(result.fills.filter(fill => fill.candidateId === "order-add")).toHaveLength(0);
    expect(result.decisions.filter(decision => decision.candidateId === "order-add")).toHaveLength(2);
    expect(result.decisions.find(decision => decision.candidateId === "order-add")).toMatchObject({
      outcome: "HOLD",
      reasonCode: "S1_ADD_TARGET_LEG_NOT_OPEN",
    });
    expect(result.decisions.at(-1)).toMatchObject({
      outcome: "HOLD",
      reasonCode: "DUPLICATE_CANDIDATE_REPLAY",
    });
  });

  it("mark-to-market 與 force-close 都維持多腿單一權益帳本恆等式", () => {
    const mtm = kernel(createDefaultExecutionPolicy("MULTI_POSITION"), { commissionRate: 0.001 });
    mtm.processBar({ timestamp: 1_000, price: 100 }, [candidate("mtm-long", 1_000, "OPEN_LONG", 1)]);
    mtm.processBar({ timestamp: 2_000, price: 100 }, [candidate("mtm-short", 2_000, "OPEN_SHORT", 0.5)]);
    const mtmResult = mtm.finalize("mark_to_market", 3_000, 110);
    expect(mtmResult.accounting).toMatchObject({ openPositionCount: 2, reconciled: true });
    expect(mtmResult.accounting.finalEquity).toBe(mtmResult.accounting.expectedFinalEquity);

    const forced = kernel(createDefaultExecutionPolicy("MULTI_POSITION"), { commissionRate: 0.001 });
    forced.processBar({ timestamp: 1_000, price: 100 }, [candidate("forced-long", 1_000, "OPEN_LONG", 1)]);
    forced.processBar({ timestamp: 2_000, price: 100 }, [candidate("forced-short", 2_000, "OPEN_SHORT", 0.5)]);
    const forcedResult = forced.finalize("force_close", 3_000, 110);
    expect(forcedResult.accounting).toMatchObject({
      openPositionCount: 0,
      syntheticForceCloseCount: 2,
      reconciled: true,
    });
    expect(forcedResult.accounting.finalEquity).toBe(forcedResult.accounting.expectedFinalEquity);
  });
});

describe("三模式回測公平比較身份", () => {
  it("stable hash 不受物件鍵順序影響，comparison group 刻意排除 mode/policy", () => {
    expect(buildBacktestHash({ b: 2, a: 1 })).toBe(buildBacktestHash({ a: 1, b: 2 }));
    const common = {
      strategyKey: "KAMA_3K_ULTIMATE_V50",
      strategyVersion: "5.0.0",
      strategyLogicHash: "logic-1",
      configHash: "config-1",
      dataHash: "data-1",
      symbol: "BTC-USDT-SWAP",
      timeframe: "15m",
      startDate: 1_000,
      endDate: 2_000,
      commission: 0.0004,
      slippage: 0.0001,
      intrabarEventPolicy: "risk_first" as const,
      endPositionPolicy: "mark_to_market" as const,
    };
    const s1Group = buildBacktestComparisonGroupId(common);
    const h3Group = buildBacktestComparisonGroupId({ ...common, contractSpecification: undefined });
    expect(s1Group).toBe(h3Group);

    const context = {
      comparisonGroupId: s1Group,
      strategyLogicHash: common.strategyLogicHash,
      configHash: common.configHash,
      dataHash: common.dataHash,
      engineVersion: BACKTEST_ENGINE_VERSION,
      simulatedAdapterVersion: BACKTEST_SIMULATED_ADAPTER_VERSION,
      riskModelVersion: BACKTEST_RISK_MODEL_VERSION,
    };
    expect(evaluateBacktestFairness([context, { ...context }])).toEqual({ eligible: true, blockers: [] });
    expect(evaluateBacktestFairness([context, { ...context, dataHash: "data-2" }])).toEqual({
      eligible: false,
      blockers: ["MISMATCH_DATA_HASH"],
    });
  });
});
