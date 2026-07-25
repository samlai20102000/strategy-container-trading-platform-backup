import { describe, expect, it } from "vitest";
import { createRainbowTrendLadderDefaultConfig } from "../shared/strategies/rainbowTrendLadder";
import { createRainbowTrendLadderRuntimeState } from "./strategies/rainbowTrendLadder/core";
import {
  applyRainbowTrendLadderCloseToState,
  applyRainbowTrendLadderFillToState,
  evaluateRainbowTrendLadderManagement,
  releaseRainbowTrendLadderKill,
  requestRainbowTrendLadderKill,
} from "./strategies/rainbowTrendLadder/management";

const config = createRainbowTrendLadderDefaultConfig();

function longL1() {
  return applyRainbowTrendLadderFillToState(createRainbowTrendLadderRuntimeState(), {
    action: "buy",
    fillPrice: 100,
    fillQuantity: 0.06,
    timestamp: 1_000,
    barTimestamp: 900,
    accountEquity: 10_000,
  });
}

describe("七彩虹線盲人模式、八層階梯與安全狀態", () => {
  it("底倉成交後進入盲人模式，L2 以初始進場價累積 0.31% 觸發並更新加權平均成本", () => {
    const l1 = longL1();
    expect(l1.currentLayer).toBe(1);
    expect(l1.rainbowTrendLadderRuntime?.blindMode).toBe(true);
    expect(l1.rainbowTrendLadderRuntime?.initialEntryPrice).toBe(100);

    const decision = evaluateRainbowTrendLadderManagement({
      currentPrice: 99.69,
      now: 2_000,
      account: { equity: 10_000, usedMargin: 1_000 },
      spreadPoints: 1,
    }, l1, config);
    expect(decision.action).toBe("add_long");
    expect(decision.layerNum).toBe(2);
    expect(decision.orderSize).toEqual({ value: 0.09, mode: "quantity" });
    expect(decision.metrics).toMatchObject({ nextCumulativeTriggerPct: 0.31, initialEntryPrice: 100 });

    const l2 = applyRainbowTrendLadderFillToState(l1, {
      action: "add_long",
      fillPrice: 99.69,
      fillQuantity: 0.09,
      timestamp: 2_100,
      targetLayer: 2,
    });
    expect(l2.currentLayer).toBe(2);
    expect(l2.totalSize).toBeCloseTo(0.15, 12);
    expect(l2.avgPrice).toBeCloseTo((100 * 0.06 + 99.69 * 0.09) / 0.15, 12);
    expect(l2.rainbowTrendLadderRuntime?.initialEntryPrice).toBe(100);
  });

  it("加倉條件成立但缺保證金真值或點差不合格時保持封鎖", () => {
    const state = longL1();
    const missingMargin = evaluateRainbowTrendLadderManagement({
      currentPrice: 99.69,
      now: 2_000,
      spreadPoints: 1,
    }, state, config);
    expect(missingMargin.action).toBe("hold");
    expect(missingMargin.reason).toContain("保證金");

    const spreadBlocked = evaluateRainbowTrendLadderManagement({
      currentPrice: 99.69,
      now: 2_000,
      account: { marginUsagePct: 10 },
      spreadPoints: 50,
    }, state, config);
    expect(spreadBlocked.action).toBe("hold");
    expect(spreadBlocked.reason).toContain("禁止加倉");
  });

  it("保證金使用率達 70% 時優先全平", () => {
    const decision = evaluateRainbowTrendLadderManagement({
      currentPrice: 99,
      now: 2_000,
      account: { marginUsagePct: 70 },
      spreadPoints: 1,
    }, longL1(), config);
    expect(decision.action).toBe("close");
    expect(decision.closeReason).toBe("MARGIN_LIMIT");
  });

  it("盈利達 1.1% 後從最高盈利回撤 0.1% 即觸發動態止盈", () => {
    const activated = {
      ...longL1(),
      rainbowTrendLadderRuntime: {
        ...longL1().rainbowTrendLadderRuntime!,
        highestProfitPct: 1.3,
        trailingActive: true,
      },
    };
    const decision = evaluateRainbowTrendLadderManagement({
      currentPrice: 101.1,
      now: 3_000,
      account: { marginUsagePct: 10 },
      spreadPoints: 1,
    }, activated, config);
    expect(decision.action).toBe("close");
    expect(decision.closeReason).toBe("TRAILING_TAKE_PROFIT");
  });

  it("價格偏離基礎線至少 50 點且基礎線反向時全平", () => {
    const decision = evaluateRainbowTrendLadderManagement({
      currentPrice: 49,
      now: 4_000,
      account: { marginUsagePct: 10 },
      spreadPoints: 1,
      trendSnapshot: {
        current: { L2: 100 },
        previous: { L2: 101 },
        slopes: { L2: -1 },
      } as any,
    }, longL1(), config);
    expect(decision.action).toBe("close");
    expect(decision.closeReason).toBe("TREND_REVERSAL");
  });

  it("KILL 先鎖定；有持倉時要求全平，平倉後仍永久鎖定，無倉才可人工解除", () => {
    const active = longL1();
    const killed = requestRainbowTrendLadderKill(active, 5_000);
    expect(killed.rainbowTrendLadderRuntime?.killed).toBe(true);
    expect(() => releaseRainbowTrendLadderKill(killed, 5_100)).toThrow("尚有本策略持倉");

    const decision = evaluateRainbowTrendLadderManagement({
      currentPrice: 100,
      now: 5_200,
      account: { marginUsagePct: 10 },
      spreadPoints: 1,
    }, killed, config);
    expect(decision.action).toBe("close");
    expect(decision.closeReason).toBe("KILL");

    const closed = applyRainbowTrendLadderCloseToState(killed, "KILL", config, 5_300);
    expect(closed.currentLayer).toBe(0);
    expect(closed.totalSize).toBe(0);
    expect(closed.rainbowTrendLadderRuntime?.killed).toBe(true);

    const released = releaseRainbowTrendLadderKill(closed, 5_400);
    expect(released.rainbowTrendLadderRuntime?.killed).toBe(false);
    expect(released.rainbowTrendLadderRuntime?.nextEntryBarTimestamp).toBe(5_400);
  });

  it("一般平倉重置層級與平均成本，並等待下一根 M30 收盤", () => {
    const closed = applyRainbowTrendLadderCloseToState(longL1(), "MANUAL", config, 10_000);
    expect(closed.currentLayer).toBe(0);
    expect(closed.totalSize).toBe(0);
    expect(closed.avgPrice).toBe(0);
    expect(closed.rainbowTrendLadderRuntime?.blindMode).toBe(false);
    expect(closed.rainbowTrendLadderRuntime?.nextEntryBarTimestamp).toBe(10_000 + 30 * 60_000);
  });
});
