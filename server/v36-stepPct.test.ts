/**
 * V3.6 動態間距 (stepPct) 測試
 * 驗證 getLayerStepPct、shouldAddLayer 動態間距、parseMartinLayers stepPct 解析
 */
import { describe, it, expect } from "vitest";
import {
  getLayerStepPct,
  parseMartinLayers,
  MartingaleEngine,
  type MartinLayerRule,
} from "./services/martingaleEngine";

describe("V3.6 getLayerStepPct", () => {
  const layers: MartinLayerRule[] = [
    { start: 1, end: 3, multiplier: 1.2, stepPct: 1.5 },
    { start: 4, end: 6, multiplier: 1.1, stepPct: 2.0 },
    { start: 7, end: 11, multiplier: 1.0, stepPct: 3.0 },
  ];
  const globalStep = 1.0;

  it("returns layer-specific stepPct for layer 1 (1.5%)", () => {
    expect(getLayerStepPct(1, layers, globalStep)).toBe(1.5);
  });

  it("returns layer-specific stepPct for layer 5 (2.0%)", () => {
    expect(getLayerStepPct(5, layers, globalStep)).toBe(2.0);
  });

  it("returns layer-specific stepPct for layer 9 (3.0%)", () => {
    expect(getLayerStepPct(9, layers, globalStep)).toBe(3.0);
  });

  it("returns global stepPct when layers is null", () => {
    expect(getLayerStepPct(3, null, globalStep)).toBe(globalStep);
  });

  it("returns global stepPct when layers is empty", () => {
    expect(getLayerStepPct(3, [], globalStep)).toBe(globalStep);
  });

  it("returns global stepPct when layer has no stepPct defined", () => {
    const noStep: MartinLayerRule[] = [
      { start: 1, end: 5, multiplier: 1.5 }, // stepPct undefined
    ];
    expect(getLayerStepPct(3, noStep, globalStep)).toBe(globalStep);
  });

  it("returns global stepPct when layer stepPct is 0", () => {
    const zeroStep: MartinLayerRule[] = [
      { start: 1, end: 5, multiplier: 1.5, stepPct: 0 },
    ];
    expect(getLayerStepPct(3, zeroStep, globalStep)).toBe(globalStep);
  });

  it("returns global stepPct for layer beyond all rules", () => {
    expect(getLayerStepPct(15, layers, globalStep)).toBe(globalStep);
  });
});

describe("V3.6 parseMartinLayers with stepPct", () => {
  it("parses stepPct from JSON string", () => {
    const json = '[{"start":1,"end":3,"multiplier":1.2,"stepPct":1.5},{"start":4,"end":6,"multiplier":1.1,"stepPct":2.0}]';
    const result = parseMartinLayers(json);
    expect(result).not.toBeNull();
    expect(result![0].stepPct).toBe(1.5);
    expect(result![1].stepPct).toBe(2.0);
  });

  it("stepPct is undefined when not provided", () => {
    const json = '[{"start":1,"end":3,"multiplier":1.2}]';
    const result = parseMartinLayers(json);
    expect(result).not.toBeNull();
    expect(result![0].stepPct).toBeUndefined();
  });

  it("stepPct 0 is treated as undefined", () => {
    const json = '[{"start":1,"end":3,"multiplier":1.2,"stepPct":0}]';
    const result = parseMartinLayers(json);
    expect(result).not.toBeNull();
    expect(result![0].stepPct).toBeUndefined();
  });
});

describe("V3.6 MartingaleEngine.shouldAddLayer with dynamic stepPct", () => {
  it("uses layer-specific stepPct (1.5%) for layer 2 add-layer decision", () => {
    const layers: MartinLayerRule[] = [
      { start: 1, end: 3, multiplier: 1.2, stepPct: 1.5 },
      { start: 4, end: 6, multiplier: 1.1, stepPct: 3.0 },
    ];
    const engine = new MartingaleEngine({
      maxLayers: 6,
      stepPct: 1.0, // global (should be overridden)
      baseLot: 0.01,
      martinLayers: layers,
    });
    // Simulate layer 1 open at 100 (addLayer takes price, isLong)
    engine.addLayer(100, true);
    // Price drops 1.2% from avg (100) → 98.8 → should NOT trigger (need 1.5%)
    expect(engine.shouldAddLayer(98.8, true)).toBe(false);
    // Price drops 1.6% → 98.4 → should trigger (>= 1.5%)
    expect(engine.shouldAddLayer(98.4, true)).toBe(true);
  });

  it("uses global stepPct when layer has no specific stepPct", () => {
    const layers: MartinLayerRule[] = [
      { start: 1, end: 3, multiplier: 1.2 }, // no stepPct
    ];
    const engine = new MartingaleEngine({
      maxLayers: 3,
      stepPct: 2.0, // global
      baseLot: 0.01,
      martinLayers: layers,
    });
    engine.addLayer(100, true);
    // Price drops 1.8% → should NOT trigger (need 2.0%)
    expect(engine.shouldAddLayer(98.2, true)).toBe(false);
    // Price drops 2.1% → should trigger
    expect(engine.shouldAddLayer(97.9, true)).toBe(true);
  });

  it("uses wider stepPct for higher layers (layer 5 needs 3.0%)", () => {
    const layers: MartinLayerRule[] = [
      { start: 1, end: 3, multiplier: 1.2, stepPct: 1.5 },
      { start: 4, end: 6, multiplier: 1.1, stepPct: 3.0 },
    ];
    const engine = new MartingaleEngine({
      maxLayers: 6,
      stepPct: 1.0,
      baseLot: 0.01,
      martinLayers: layers,
    });
    // Build up to layer 4 (shouldAddLayer checks deviation from avgPrice)
    engine.addLayer(100, true);
    engine.addLayer(98, true);
    engine.addLayer(96, true);
    engine.addLayer(94, true);
    // Now at layer 4, next layer (5) needs 3.0% from avgPrice
    const avg = engine.getState().avgPrice;
    // 2.5% drop from avg → should NOT trigger
    const price25 = avg * (1 - 0.025);
    expect(engine.shouldAddLayer(price25, true)).toBe(false);
    // 3.5% drop from avg → should trigger (>= 3.0%)
    const price35 = avg * (1 - 0.035);
    expect(engine.shouldAddLayer(price35, true)).toBe(true);
  });
});
