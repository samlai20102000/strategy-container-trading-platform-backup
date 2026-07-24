/**
 * Pasted_content_22.txt 驗收測試：參數驗證與聯動（BE-1 / BE-2）
 *
 * 驗收標準對應：
 * 1. Max_Layers 自動計算 = 分層最後一層 end（calculateMaxLayersFromConfig / validateAndProcessMartinConfig）
 * 2. 有分層時忽略固定 Martin_Multiplier（usedMode = layered，effectiveMultiplier 按層取值）
 * 3. 無分層時回退固定乘數（usedMode = fixed）
 * 4. 層數範圍重疊 → 拋錯
 * 5. 層數範圍不連續（間隙）→ 拋錯
 * 6. Max_Layers 與分層不一致 → 以分層為準（警告不拋錯）
 * 7. 超出定義範圍的層數 → 使用最後一層乘數
 * 8. 非法格式（非 JSON / 非陣列 / start > end / multiplier <= 0）→ 拋錯
 */
import { describe, expect, it } from "vitest";
import {
  calculateMaxLayersFromConfig,
  getMartinConfig,
  parseMartinLayersStrict,
  validateAndProcessMartinConfig,
} from "./services/parameterValidator";

const LAYERS_JSON = JSON.stringify([
  { start: 1, end: 3, multiplier: 1.5 },
  { start: 4, end: 6, multiplier: 1.2 },
  { start: 7, end: 11, multiplier: 1.0 },
]);

describe("BE-1 validateAndProcessMartinConfig（用戶提供代碼）", () => {
  it("驗收 1：有分層時 Max_Layers 自動 = 最後一層 end（11）", () => {
    const r = validateAndProcessMartinConfig({
      Max_Layers: 5,
      Martin_Multiplier: 1.5,
      Martin_Layers: LAYERS_JSON,
    });
    expect(r.usedMode).toBe("layered");
    expect(r.maxLayers).toBe(11);
  });

  it("驗收 2：layered 模式下按層取乘數（忽略固定乘數 9.9）", () => {
    const r = validateAndProcessMartinConfig({
      Martin_Multiplier: 9.9,
      Martin_Layers: LAYERS_JSON,
    });
    expect(r.effectiveMultiplier(1)).toBe(1.5);
    expect(r.effectiveMultiplier(3)).toBe(1.5);
    expect(r.effectiveMultiplier(4)).toBe(1.2);
    expect(r.effectiveMultiplier(7)).toBe(1.0);
    expect(r.effectiveMultiplier(11)).toBe(1.0);
  });

  it("驗收 3：無分層回退 fixed 模式（乘數 2.0、Max_Layers 8）", () => {
    const r = validateAndProcessMartinConfig({
      Max_Layers: 8,
      Martin_Multiplier: 2.0,
      Martin_Layers: "",
    });
    expect(r.usedMode).toBe("fixed");
    expect(r.maxLayers).toBe(8);
    expect(r.effectiveMultiplier(1)).toBe(2.0);
    expect(r.effectiveMultiplier(99)).toBe(2.0);
  });

  it("驗收 3b：fixed 模式缺省值（Max_Layers=5、乘數=1.5）", () => {
    const r = validateAndProcessMartinConfig({});
    expect(r.usedMode).toBe("fixed");
    expect(r.maxLayers).toBe(5);
    expect(r.effectiveMultiplier(2)).toBe(1.5);
  });

  it("驗收 4：層數範圍重疊拋錯（1-3 與 3-6）", () => {
    const overlap = JSON.stringify([
      { start: 1, end: 3, multiplier: 1.5 },
      { start: 3, end: 6, multiplier: 1.2 },
    ]);
    expect(() =>
      validateAndProcessMartinConfig({ Martin_Layers: overlap }),
    ).toThrow(/重疊/);
  });

  it("驗收 5：層數範圍間隙拋錯（1-3 與 5-8）", () => {
    const gap = JSON.stringify([
      { start: 1, end: 3, multiplier: 1.5 },
      { start: 5, end: 8, multiplier: 1.2 },
    ]);
    expect(() => validateAndProcessMartinConfig({ Martin_Layers: gap })).toThrow(/不連續|間隙/);
  });

  it("驗收 6：Max_Layers 與分層不一致時以分層為準（不拋錯）", () => {
    const r = validateAndProcessMartinConfig({
      Max_Layers: 99,
      Martin_Layers: LAYERS_JSON,
    });
    expect(r.maxLayers).toBe(11);
  });

  it("驗收 7：超出定義範圍的層數使用最後一層乘數", () => {
    const r = validateAndProcessMartinConfig({ Martin_Layers: LAYERS_JSON });
    expect(r.effectiveMultiplier(15)).toBe(1.0);
  });

  it("驗收 8a：非法 JSON 拋錯", () => {
    expect(() =>
      validateAndProcessMartinConfig({ Martin_Layers: "{not json" }),
    ).toThrow(/JSON/);
  });

  it("驗收 8b：start > end 拋錯", () => {
    const bad = JSON.stringify([{ start: 5, end: 3, multiplier: 1.5 }]);
    expect(() => validateAndProcessMartinConfig({ Martin_Layers: bad })).toThrow(/不可大於/);
  });

  it("驗收 8c：multiplier <= 0 拋錯", () => {
    const bad = JSON.stringify([{ start: 1, end: 3, multiplier: 0 }]);
    expect(() => validateAndProcessMartinConfig({ Martin_Layers: bad })).toThrow(/乘數必須/);
  });

  it("驗收 8d：start < 1 拋錯", () => {
    const bad = JSON.stringify([{ start: 0, end: 3, multiplier: 1.5 }]);
    expect(() => validateAndProcessMartinConfig({ Martin_Layers: bad })).toThrow(/>= 1/);
  });
});

describe("parseMartinLayersStrict（入口嚴格解析）", () => {
  it("空字串 / 空陣列 → null（回退 fixed）", () => {
    expect(parseMartinLayersStrict("")).toBeNull();
    expect(parseMartinLayersStrict("[]")).toBeNull();
    expect(parseMartinLayersStrict(undefined)).toBeNull();
    expect(parseMartinLayersStrict(null)).toBeNull();
  });

  it("陣列物件直接傳入亦可解析", () => {
    const rules = parseMartinLayersStrict([{ start: 1, end: 3, multiplier: 1.5 }]);
    expect(rules).toEqual([{ start: 1, end: 3, multiplier: 1.5 }]);
  });

  it("非陣列拋錯", () => {
    expect(() => parseMartinLayersStrict('{"start":1}')).toThrow(/陣列/);
  });
});

describe("calculateMaxLayersFromConfig（BE-2 引擎接線）", () => {
  it("有分層 → 最後一層 end", () => {
    expect(calculateMaxLayersFromConfig({ Max_Layers: 5, Martin_Layers: LAYERS_JSON })).toBe(11);
  });

  it("無分層 → 回退 Max_Layers", () => {
    expect(calculateMaxLayersFromConfig({ Max_Layers: 7 })).toBe(7);
  });

  it("無分層且無 Max_Layers → 預設 5", () => {
    expect(calculateMaxLayersFromConfig({})).toBe(5);
  });

  it("亂序分層排序後取最後一層 end", () => {
    const unordered = JSON.stringify([
      { start: 4, end: 6, multiplier: 1.2 },
      { start: 1, end: 3, multiplier: 1.5 },
    ]);
    expect(calculateMaxLayersFromConfig({ Martin_Layers: unordered })).toBe(6);
  });
});

describe("getMartinConfig（引擎啟動日誌接線，用戶提供代碼）", () => {
  it("layered 模式回傳完整結果", () => {
    const r = getMartinConfig({ Martin_Layers: LAYERS_JSON });
    expect(r.usedMode).toBe("layered");
    expect(r.maxLayers).toBe(11);
    expect(r.sortedLayers).toHaveLength(3);
  });
});
