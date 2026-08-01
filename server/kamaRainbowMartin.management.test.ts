import { describe, expect, it } from "vitest";
import { createKamaRainbowMartinDefaultConfig } from "../shared/strategies/kamaRainbowMartin";
import { createKamaRainbowMartinRuntimeState } from "./strategies/kamaRainbowMartin/core";
import {
  applyKamaRainbowMartinCloseToState,
  applyKamaRainbowMartinFillToState,
  applyKamaRainbowMartinPartialCloseToState,
  calculateKamaRainbowMartinTrailing,
  evaluateKamaRainbowMartinManagement,
  releaseKamaRainbowMartinKill,
  requestKamaRainbowMartinKill,
} from "./strategies/kamaRainbowMartin/management";

function openLong(price = 100, quantity = 1, rawConfig?: unknown) {
  return applyKamaRainbowMartinFillToState(createKamaRainbowMartinRuntimeState(), {
    action: "OPEN_LONG",
    fillId: "fill-l1-a",
    fillPrice: price,
    fillQuantity: quantity,
    timestamp: 1,
    rawConfig,
    configRevision: "revision-a",
    positionSizeAtOpen: { mode: "usdt", value: 100 },
  });
}

function openShort(price = 100, quantity = 1) {
  return applyKamaRainbowMartinFillToState(createKamaRainbowMartinRuntimeState(), {
    action: "OPEN_SHORT",
    fillId: "fill-l1-short",
    fillPrice: price,
    fillQuantity: quantity,
    timestamp: 1,
  });
}

describe("Kama 彩虹馬丁腿級 management", () => {
  it("成交後才更新層數，fillId 冪等且部分成交以層 VWAP 錨定", () => {
    const l1 = openLong(100, 1);
    const l2a = applyKamaRainbowMartinFillToState(l1, {
      action: "ADD_LONG",
      fillId: "fill-l2-a",
      fillPrice: 98,
      fillQuantity: 1,
      timestamp: 2,
      targetLayer: 2,
    });
    const l2b = applyKamaRainbowMartinFillToState(l2a, {
      action: "ADD_LONG",
      fillId: "fill-l2-b",
      fillPrice: 97,
      fillQuantity: 2,
      timestamp: 3,
      targetLayer: 2,
    });
    const duplicate = applyKamaRainbowMartinFillToState(l2b, {
      action: "ADD_LONG",
      fillId: "fill-l2-b",
      fillPrice: 97,
      fillQuantity: 2,
      timestamp: 3,
      targetLayer: 2,
    });
    expect(l2b.currentLayer).toBe(2);
    expect(l2b.totalSize).toBe(4);
    expect(l2b.avgPrice).toBeCloseTo(98, 12);
    expect(l2b.lastLayerPrice).toBeCloseTo(97.33333333333333, 12);
    expect(duplicate.totalSize).toBe(4);
    expect(duplicate.kamaRainbowMartinRuntime?.fills).toHaveLength(3);
  });

  it("分層間距由上一層實際 fill 錨定，L1 採 1.5 倍且單一 event 只批准一次", () => {
    const state = openLong();
    const add = evaluateKamaRainbowMartinManagement({ currentPrice: 98, now: 2, riskEventKey: "quote-1" }, state);
    expect(add.action).toBe("add_long");
    expect(add.layerNum).toBe(2);
    expect(add.orderSize).toEqual({ mode: "usdt", value: 150 });
    expect(add.nextState.currentLayer).toBe(1);
    const duplicate = evaluateKamaRainbowMartinManagement(
      { currentPrice: 97, now: 3, riskEventKey: "quote-1" },
      add.nextState,
    );
    expect(duplicate.reasonCode).toBe("KRM_RISK_EVENT_DUPLICATE");
  });

  it("自訂分層間距與乘數依目標加倉層套用，內部層號保留底倉偏移", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    config.layerConfigs = [
      { layerStart: 1, layerEnd: 1, multiplier: 1.25, gapPct: 3 },
      { layerStart: 2, layerEnd: 3, multiplier: 1.1, gapPct: 4 },
    ];
    const state = openLong(100, 1, config);
    const wait = evaluateKamaRainbowMartinManagement(
      { currentPrice: 98, now: 2, riskEventKey: "tier-wait" },
      state,
    );
    expect(wait.reasonCode).toBe("KRM_MARTIN_WAIT");
    expect(wait.metrics.nextAddLayer).toBe(1);
    expect(wait.metrics.nextLayer).toBe(2);
    expect(wait.metrics.nextGapPct).toBe(3);
    const add = evaluateKamaRainbowMartinManagement(
      { currentPrice: 97, now: 3, riskEventKey: "tier-add" },
      state,
    );
    expect(add.reasonCode).toBe("KRM_MARTIN_ADD");
    expect(add.layerNum).toBe(2);
    expect(add.orderSize).toEqual({ mode: "usdt", value: 125 });
  });

  it("hard stop 優先於同價位馬丁加倉且多空鏡像", () => {
    const longDecision = evaluateKamaRainbowMartinManagement(
      { currentPrice: 94, now: 2, riskEventKey: "long-hard-stop" },
      openLong(),
    );
    const shortDecision = evaluateKamaRainbowMartinManagement(
      { currentPrice: 106, now: 2, riskEventKey: "short-hard-stop" },
      openShort(),
    );
    expect(longDecision.reasonCode).toBe("KRM_HARD_STOP");
    expect(shortDecision.reasonCode).toBe("KRM_HARD_STOP");
    expect(longDecision.action).toBe("close");
    expect(shortDecision.action).toBe("close");
  });

  it("階梯 trailing 使用唯一公式並於實際加倉成交後重置", () => {
    const config = createKamaRainbowMartinDefaultConfig();
    expect(calculateKamaRainbowMartinTrailing(4.2, { trailingActive: false, peakProfitPct: 0 }, config)).toEqual({
      active: true,
      peakProfitPct: 4.2,
      triggerProfitPct: 2.5,
    });
    const peak = evaluateKamaRainbowMartinManagement({ currentPrice: 104.2, now: 2, riskEventKey: "peak" }, openLong());
    const exit = evaluateKamaRainbowMartinManagement(
      { currentPrice: 102.5, now: 3, riskEventKey: "callback" },
      peak.nextState,
    );
    expect(exit.reasonCode).toBe("KRM_TRAILING_EXIT");

    const reset = applyKamaRainbowMartinFillToState(peak.nextState, {
      action: "ADD_LONG",
      fillId: "fill-l2-reset",
      fillPrice: 98,
      fillQuantity: 1,
      timestamp: 4,
      targetLayer: 2,
    });
    expect(reset.kamaRainbowMartinRuntime?.trailingActive).toBe(false);
    expect(reset.kamaRainbowMartinRuntime?.peakProfitPct).toBe(0);
    expect(reset.kamaRainbowMartinRuntime?.triggerProfitPct).toBeNull();
  });

  it("pinned config 不受後續 raw config 漂移影響", () => {
    const state = openLong();
    const changed = createKamaRainbowMartinDefaultConfig();
    changed.gapPct = 10;
    const decision = evaluateKamaRainbowMartinManagement(
      { currentPrice: 98, now: 2, riskEventKey: "pinned" },
      state,
      changed,
    );
    expect(decision.reasonCode).toBe("KRM_MARTIN_ADD");
    expect(decision.metrics.configRevisionAtOpen).toBe("revision-a");
  });

  it("KILL 優先 close-only；平倉重置後仍鎖定且有倉不可解除", () => {
    const killed = requestKamaRainbowMartinKill(openLong(), 2);
    expect(() => releaseKamaRainbowMartinKill(killed, 3)).toThrow(/不可解除 KILL/);
    const close = evaluateKamaRainbowMartinManagement(
      { currentPrice: Number.NaN, now: 3, riskEventKey: "kill" },
      killed,
    );
    expect(close.reasonCode).toBe("KRM_KILL_CLOSE");
    const flat = applyKamaRainbowMartinCloseToState(close.nextState, "KILL", 4);
    expect(flat.totalSize).toBe(0);
    expect(flat.kamaRainbowMartinRuntime?.fills).toEqual([]);
    expect(flat.kamaRainbowMartinRuntime?.killed).toBe(true);
    const released = releaseKamaRainbowMartinKill(flat, 5);
    expect(released.kamaRainbowMartinRuntime?.killed).toBe(false);
  });

  it("maxLayers 僅計加倉層，完成 L11 後持倉內部 L12 不再加倉", () => {
    let state = openLong();
    for (let layer = 2; layer <= 12; layer += 1) {
      state = applyKamaRainbowMartinFillToState(state, {
        action: "ADD_LONG",
        fillId: `fill-l${layer}`,
        fillPrice: 100,
        fillQuantity: 1,
        timestamp: layer,
        targetLayer: layer,
      });
    }
    const decision = evaluateKamaRainbowMartinManagement(
      { currentPrice: 80, now: 10, riskEventKey: "max" },
      state,
    );
    expect(decision.reasonCode).toBe("KRM_HARD_STOP");
    const safePrice = state.avgPrice * 0.99;
    const hold = evaluateKamaRainbowMartinManagement(
      { currentPrice: safePrice, now: 11, riskEventKey: "max-safe" },
      state,
    );
    expect(hold.reasonCode).toBe("KRM_MARTIN_MAX_LAYER");
  });

  it("部分 reduce-only 成交只扣腿級數量，完整成交才重置 runtime", () => {
    const state = openLong(100, 2);
    const partial = applyKamaRainbowMartinPartialCloseToState(state, 0.75, "TRAILING_TAKE_PROFIT", 2);
    expect(partial.totalSize).toBeCloseTo(1.25, 12);
    expect(partial.totalCost).toBeCloseTo(125, 12);
    expect(partial.currentLayer).toBe(1);
    expect(partial.kamaRainbowMartinRuntime?.fills).toHaveLength(1);
    const flat = applyKamaRainbowMartinPartialCloseToState(partial, 1.25, "TRAILING_TAKE_PROFIT", 3);
    expect(flat.totalSize).toBe(0);
    expect(flat.currentLayer).toBe(0);
    expect(flat.kamaRainbowMartinRuntime?.fills).toEqual([]);
  });
});
