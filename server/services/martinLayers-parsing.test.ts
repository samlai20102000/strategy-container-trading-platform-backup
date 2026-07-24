import { describe, it, expect } from "vitest";
import { parseMartinLayersStrict } from "./parameterValidator";
import { getLayerStepPct } from "./martingaleEngine";

describe("馬丁分層間距解析修復驗證", () => {
  const layersJsonString = JSON.stringify([
    { start: 1, end: 3, multiplier: 1.3, stepPct: 1.5 },
    { start: 4, end: 20, multiplier: 1.1, stepPct: 9 },
  ]);

  it("parseMartinLayersStrict 應正確解析 JSON 字串格式的 Martin_Layers", () => {
    const result = parseMartinLayersStrict(layersJsonString);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].stepPct).toBe(1.5);
    expect(result![1].stepPct).toBe(9);
  });

  it("parseMartinLayersStrict 應正確解析 array 格式的 Martin_Layers", () => {
    const layersArray = [
      { start: 1, end: 3, multiplier: 1.3, stepPct: 1.5 },
      { start: 4, end: 20, multiplier: 1.1, stepPct: 9 },
    ];
    const result = parseMartinLayersStrict(layersArray);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].stepPct).toBe(1.5);
    expect(result![1].stepPct).toBe(9);
  });

  it("getLayerStepPct 應根據層數返回正確的分層間距", () => {
    const layers = parseMartinLayersStrict(layersJsonString)!;
    const globalStep = 2.0;

    // 第 1-3 層應返回 1.5%
    expect(getLayerStepPct(1, layers, globalStep)).toBe(1.5);
    expect(getLayerStepPct(2, layers, globalStep)).toBe(1.5);
    expect(getLayerStepPct(3, layers, globalStep)).toBe(1.5);

    // 第 4-20 層應返回 9%
    expect(getLayerStepPct(4, layers, globalStep)).toBe(9);
    expect(getLayerStepPct(10, layers, globalStep)).toBe(9);
    expect(getLayerStepPct(20, layers, globalStep)).toBe(9);
  });

  it("getLayerStepPct 超出分層範圍時應 fallback 到全局間距", () => {
    const layers = parseMartinLayersStrict(layersJsonString)!;
    const globalStep = 2.0;

    // 第 21 層超出範圍，應返回全局 2.0%
    expect(getLayerStepPct(21, layers, globalStep)).toBe(globalStep);
  });

  it("parseMartinLayersStrict 空字串應返回 null", () => {
    expect(parseMartinLayersStrict("")).toBeNull();
    expect(parseMartinLayersStrict("[]")).toBeNull();
    expect(parseMartinLayersStrict(null)).toBeNull();
    expect(parseMartinLayersStrict(undefined)).toBeNull();
  });

  it("getLayerStepPct 無分層時應返回全局間距", () => {
    expect(getLayerStepPct(1, null, 2.0)).toBe(2.0);
    expect(getLayerStepPct(5, [], 3.5)).toBe(3.5);
  });

  it("模擬用戶場景：V4.0 策略第 1 層持倉，下一層（第 2 層）間距應為 1.5%（非全局 2%）", () => {
    // 模擬 __v35Config 中 Martin_Layers 是 JSON 字串
    const v35Config = {
      Martin_Step_Pct: undefined, // v35Config schema 中沒有這個字段
      Martin_Layers: layersJsonString, // 存入 DB 時是 string
    };

    // 修復前：Array.isArray(v35Config.Martin_Layers) → false → fallback 到 2.0%
    // 修復後：parseMartinLayersStrict(v35Config.Martin_Layers) → 正確解析
    const parsed = parseMartinLayersStrict(v35Config.Martin_Layers);
    expect(parsed).not.toBeNull();

    const globalStep = 2.0; // 全局加倉間距
    const currentLayer = 1; // 當前第 1 層
    const nextLayer = currentLayer + 1; // 下一層是第 2 層

    const stepPct = getLayerStepPct(nextLayer, parsed, globalStep);
    expect(stepPct).toBe(1.5); // 應該是 1.5%，不是 2.0%
  });
});
