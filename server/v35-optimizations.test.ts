/**
 * Pasted_content_21.txt 四項核心優化（O1-O4）單元測試
 *
 * O1：階梯式馬丁乘數分層（getLayerMultiplier / calculateLayerLot / validateMartinLayers / parseMartinLayers / MartingaleEngine）
 * O2：KAMA 反轉主動割肉（checkKamaReversal）
 *   ⚠️ V3.7（Pasted_content_23）：實盤與回測引擎已移除 O2 接線（改用 Max_Loss_Pct 硬止損），
 *   以下 O2 測試僅驗證純函數本身仍正確（保留供日後選用），引擎層不再調用。
 * O3：平倉分流與順勢重入（decideCloseSplit / buildReentryState）
 * O4：Max_Loss_USDT 絕對金額限損（RiskManager 條件 C）
 * 🆕 V3.7 硬止損測試見 server/v37-hard-stop.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  MartingaleEngine,
  calculateLayerLot,
  getLayerMultiplier,
  parseMartinLayers,
  validateMartinLayers,
  type MartinLayerRule,
} from "./services/martingaleEngine";
import {
  buildReentryState,
  checkKamaReversal,
  decideCloseSplit,
} from "./services/kamaReversalGuard";
import { RiskManager } from "./services/riskManager";
import { createInitialStrategyState } from "./strategies/base";

// 文件範例分層：第 1-3 層 ×1.5、第 4-6 層 ×1.2、第 7-11 層 ×1.0
const DOC_LAYERS: MartinLayerRule[] = [
  { start: 1, end: 3, multiplier: 1.5 },
  { start: 4, end: 6, multiplier: 1.2 },
  { start: 7, end: 11, multiplier: 1.0 },
];

describe("O1 階梯式馬丁乘數：getLayerMultiplier", () => {
  it("未定義規則時回退固定乘數", () => {
    expect(getLayerMultiplier(1, null, 1.5)).toBe(1.5);
    expect(getLayerMultiplier(5, [], 2)).toBe(2);
  });

  it("依層數區間回傳對應乘數（文件範例）", () => {
    expect(getLayerMultiplier(1, DOC_LAYERS)).toBe(1.5);
    expect(getLayerMultiplier(3, DOC_LAYERS)).toBe(1.5);
    expect(getLayerMultiplier(4, DOC_LAYERS)).toBe(1.2);
    expect(getLayerMultiplier(6, DOC_LAYERS)).toBe(1.2);
    expect(getLayerMultiplier(7, DOC_LAYERS)).toBe(1.0);
    expect(getLayerMultiplier(11, DOC_LAYERS)).toBe(1.0);
  });

  it("超出最後區間時沿用最後一層乘數（不再膨脹）", () => {
    expect(getLayerMultiplier(15, DOC_LAYERS)).toBe(1.0);
  });
});

describe("O1 階梯式馬丁乘數：calculateLayerLot 累乘", () => {
  it("layer=0（首單）不乘", () => {
    expect(calculateLayerLot(0.01, 0, DOC_LAYERS)).toBe(0.01);
  });

  it("文件範例：0.01 起步的前 6 層累乘正確", () => {
    // 第 1 層 = 0.01×1.5 = 0.015
    expect(calculateLayerLot(0.01, 1, DOC_LAYERS)).toBeCloseTo(0.015, 8);
    // 第 2 層 = 0.015×1.5 = 0.0225
    expect(calculateLayerLot(0.01, 2, DOC_LAYERS)).toBeCloseTo(0.0225, 8);
    // 第 3 層 = 0.0225×1.5 = 0.03375
    expect(calculateLayerLot(0.01, 3, DOC_LAYERS)).toBeCloseTo(0.03375, 8);
    // 第 4 層 = 0.03375×1.2 = 0.0405（乘數降檔，B1 cap=0.045，未觸頂）
    expect(calculateLayerLot(0.01, 4, DOC_LAYERS)).toBeCloseTo(0.0405, 8);
    // 第 5 層 = 0.0405×1.2 = 0.0486（超過 cap 0.045，封頂為 0.045）
    expect(calculateLayerLot(0.01, 5, DOC_LAYERS)).toBeCloseTo(0.045, 8);
    // 第 6 層 = 0.045（封頂）——但實際計算是 0.0486×1.2=0.05832，再 cap 到 0.045
    expect(calculateLayerLot(0.01, 6, DOC_LAYERS)).toBeCloseTo(0.045, 8);
  });

  it("第 7 層起乘數 1.0（倉位不再增加）", () => {
    const lot6 = calculateLayerLot(0.01, 6, DOC_LAYERS);
    const lot7 = calculateLayerLot(0.01, 7, DOC_LAYERS);
    const lot8 = calculateLayerLot(0.01, 8, DOC_LAYERS);
    expect(lot7).toBeCloseTo(lot6, 8);
    expect(lot8).toBeCloseTo(lot6, 8);
  });

  it("階梯式總倉位低於固定 1.5x（風險削減驗證）", () => {
    let tieredTotal = 0.01; // 首單
    let fixedTotal = 0.01;
    for (let i = 1; i <= 6; i++) {
      tieredTotal += calculateLayerLot(0.01, i, DOC_LAYERS);
      fixedTotal += 0.01 * Math.pow(1.5, i);
    }
    expect(tieredTotal).toBeLessThan(fixedTotal);
  });
});

describe("O1 階梯式馬丁乘數：validateMartinLayers / parseMartinLayers", () => {
  it("合法規則通過驗證", () => {
    expect(validateMartinLayers(DOC_LAYERS).valid).toBe(true);
    expect(validateMartinLayers(null).valid).toBe(true);
    expect(validateMartinLayers([]).valid).toBe(true);
  });

  it("重疊區間驗證失敗", () => {
    const overlap: MartinLayerRule[] = [
      { start: 1, end: 4, multiplier: 1.5 },
      { start: 3, end: 6, multiplier: 1.2 },
    ];
    const r = validateMartinLayers(overlap);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("重疊");
  });

  it("start > end、start < 1、multiplier <= 0 驗證失敗", () => {
    expect(validateMartinLayers([{ start: 5, end: 3, multiplier: 1.5 }]).valid).toBe(false);
    expect(validateMartinLayers([{ start: 0, end: 3, multiplier: 1.5 }]).valid).toBe(false);
    expect(validateMartinLayers([{ start: 1, end: 3, multiplier: 0 }]).valid).toBe(false);
    expect(validateMartinLayers([{ start: 1, end: 3, multiplier: -1 }]).valid).toBe(false);
  });

  it("parseMartinLayers 支援 JSON 字串與陣列，非法輸入回傳 null", () => {
    const json = JSON.stringify(DOC_LAYERS);
    expect(parseMartinLayers(json)).toEqual(DOC_LAYERS);
    expect(parseMartinLayers(DOC_LAYERS)).toEqual(DOC_LAYERS);
    expect(parseMartinLayers("")).toBeNull();
    expect(parseMartinLayers("not json")).toBeNull();
    expect(parseMartinLayers("[{\"start\":1}]")).toBeNull();
    // 重疊規則 → null
    expect(
      parseMartinLayers(
        JSON.stringify([
          { start: 1, end: 4, multiplier: 1.5 },
          { start: 3, end: 6, multiplier: 1.2 },
        ]),
      ),
    ).toBeNull();
  });
});

describe("O1 MartingaleEngine 整合階梯式乘數", () => {
  it("addLayer 使用階梯式累乘（與 calcLayerLot 一致）", () => {
    const engine = new MartingaleEngine({
      baseLot: 0.01,
      multiplier: 1.5,
      stepPct: 1.5,
      maxLayers: 8,
      martinLayers: DOC_LAYERS,
    });
    // 首單（currentLayer 0 → 1，馬丁層 0，不乘）
    expect(engine.addLayer(50000, true).lotSize).toBeCloseTo(0.01, 8);
    // 第 1 次馬丁加倉（馬丁層 1）= 0.015
    expect(engine.addLayer(49000, true).lotSize).toBeCloseTo(0.015, 8);
    // 第 2 次馬丁加倉 = 0.0225
    expect(engine.addLayer(48000, true).lotSize).toBeCloseTo(0.0225, 8);
    // 第 3 次 = 0.03375
    expect(engine.addLayer(47000, true).lotSize).toBeCloseTo(0.03375, 8);
    // 第 4 次（降檔 1.2）= 0.0405
    expect(engine.addLayer(46000, true).lotSize).toBeCloseTo(0.0405, 8);
  });

  it("未提供 martinLayers 時保持固定乘數行為（向後相容）", () => {
    const engine = new MartingaleEngine({ baseLot: 0.01, multiplier: 1.5, stepPct: 1.5, maxLayers: 5 });
    expect(engine.addLayer(50000, true).lotSize).toBeCloseTo(0.01, 8);
    expect(engine.addLayer(49000, true).lotSize).toBeCloseTo(0.015, 8);
    expect(engine.addLayer(48000, true).lotSize).toBeCloseTo(0.0225, 8);
  });

  it("calcLayerLot 靜態方法支援階梯式（前端預覽用）", () => {
    expect(MartingaleEngine.calcLayerLot(0.01, 1.5, 1, DOC_LAYERS)).toBeCloseTo(0.01, 8);
    expect(MartingaleEngine.calcLayerLot(0.01, 1.5, 2, DOC_LAYERS)).toBeCloseTo(0.015, 8);
    expect(MartingaleEngine.calcLayerLot(0.01, 1.5, 5, DOC_LAYERS)).toBeCloseTo(0.0405, 8);
  });
});

describe("O2 KAMA 反轉主動割肉：checkKamaReversal", () => {
  const base = {
    avgPrice: 50000,
    currentPrice: 48000,
    totalSize: 0.1,
    isLong: true,
  };

  it("馬丁層數 >= 3 且 KAMA 反轉 → 觸發割肉並估算虧損", () => {
    const r = checkKamaReversal({
      ...base,
      martinDepth: 3,
      entryTrendBull: true,
      currentKamaFast: 47000, // 快線 < 慢線 → 跌勢
      currentKamaSlow: 47500,
      minLayer: 3,
    });
    expect(r.triggered).toBe(true);
    expect(r.reason).toContain("KAMA 反轉主動割肉");
    // 多單浮虧 = (50000-48000)×0.1 = 200 USDT
    expect(r.estimatedLoss).toBeCloseTo(200, 2);
  });

  it("馬丁層數不足 → 不觸發", () => {
    const r = checkKamaReversal({
      ...base,
      martinDepth: 2,
      entryTrendBull: true,
      currentKamaFast: 47000,
      currentKamaSlow: 47500,
      minLayer: 3,
    });
    expect(r.triggered).toBe(false);
  });

  it("KAMA 方向未反轉 → 不觸發", () => {
    const r = checkKamaReversal({
      ...base,
      martinDepth: 4,
      entryTrendBull: true,
      currentKamaFast: 48500, // 快線 > 慢線 → 仍為升勢
      currentKamaSlow: 48000,
      minLayer: 3,
    });
    expect(r.triggered).toBe(false);
    expect(r.reason).toContain("未反轉");
  });

  it("minLayer = 0 → 功能停用", () => {
    const r = checkKamaReversal({
      ...base,
      martinDepth: 5,
      entryTrendBull: true,
      currentKamaFast: 47000,
      currentKamaSlow: 47500,
      minLayer: 0,
    });
    expect(r.triggered).toBe(false);
    expect(r.reason).toContain("停用");
  });

  it("入場方向未記錄（舊狀態相容）→ 跳過", () => {
    const r = checkKamaReversal({
      ...base,
      martinDepth: 4,
      entryTrendBull: undefined,
      currentKamaFast: 47000,
      currentKamaSlow: 47500,
      minLayer: 3,
    });
    expect(r.triggered).toBe(false);
    expect(r.reason).toContain("未記錄");
  });

  it("空單方向反轉也可觸發（入場跌勢 → 目前升勢）", () => {
    const r = checkKamaReversal({
      martinDepth: 3,
      entryTrendBull: false,
      currentKamaFast: 51000,
      currentKamaSlow: 50500,
      avgPrice: 50000,
      currentPrice: 51000,
      totalSize: 0.1,
      isLong: false,
      minLayer: 3,
    });
    expect(r.triggered).toBe(true);
    // 空單浮虧 = (50000-51000)×0.1 = -100 → 100 USDT
    expect(r.estimatedLoss).toBeCloseTo(100, 2);
  });
});

describe("O3 平倉分流：decideCloseSplit", () => {
  it("分流 A：第 0 層 + 止盈 + KAMA 方向未變 → 立即重入", () => {
    const d = decideCloseSplit({
      martinDepth: 0,
      exitReason: "trailing_stop",
      entryTrendBull: true,
      currentKamaFast: 50500,
      currentKamaSlow: 50000,
      kLinePeriod: 30,
    });
    expect(d.action).toBe("reenter");
    expect(d.cooldownMs).toBe(0);
  });

  it("分流 B：有馬丁（層數 >= 1）→ 強制冷卻 2 根 K 線", () => {
    const d = decideCloseSplit({
      martinDepth: 2,
      exitReason: "trailing_stop",
      entryTrendBull: true,
      currentKamaFast: 50500,
      currentKamaSlow: 50000,
      kLinePeriod: 30,
    });
    expect(d.action).toBe("cooldown");
    expect(d.cooldownMs).toBe(30 * 60 * 1000 * 2);
  });

  it("KAMA 方向已反轉 → 不重入", () => {
    const d = decideCloseSplit({
      martinDepth: 0,
      exitReason: "trailing_stop",
      entryTrendBull: true,
      currentKamaFast: 49000,
      currentKamaSlow: 50000,
      kLinePeriod: 30,
    });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("反轉");
  });

  it("止損退出 → 不重入", () => {
    const d = decideCloseSplit({
      martinDepth: 0,
      exitReason: "stop_loss",
      entryTrendBull: true,
      currentKamaFast: 50500,
      currentKamaSlow: 50000,
      kLinePeriod: 30,
    });
    expect(d.action).toBe("none");
  });

  it("Reentry_On_Trend = false → 功能停用", () => {
    const d = decideCloseSplit({
      martinDepth: 0,
      exitReason: "trailing_stop",
      entryTrendBull: true,
      currentKamaFast: 50500,
      currentKamaSlow: 50000,
      kLinePeriod: 30,
      reentryEnabled: false,
    });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("未啟用");
  });

  it("中文退出原因「移動止盈」也視為止盈", () => {
    const d = decideCloseSplit({
      martinDepth: 0,
      exitReason: "移動止盈",
      entryTrendBull: false,
      currentKamaFast: 49000,
      currentKamaSlow: 50000, // 快 < 慢 = 跌勢，與入場一致
      kLinePeriod: 30,
    });
    expect(d.action).toBe("reenter");
  });
});

describe("O3 buildReentryState：重入後狀態", () => {
  it("重入狀態為全新首單（層 1）並保留入場方向", () => {
    const s = buildReentryState({
      currentPrice: 51000,
      lotSize: 0.01,
      entryTrendBull: true,
      isLong: true,
      barTimestamp: 1234567890,
    });
    expect(s.currentLayer).toBe(1);
    expect(s.totalSize).toBe(0.01);
    expect(s.avgPrice).toBe(51000);
    expect(s.totalCost).toBeCloseTo(510, 6);
    expect(s.isTrailingActivated).toBe(false);
    expect(s.isCooldown).toBe(false);
    expect(s.entryTrendBull).toBe(true);
    expect(s.hasTriggeredKamaReversal).toBe(false);
    expect(s.lockedBarTimestamp).toBe(1234567890);
  });
});

describe("O4 Max_Loss_USDT 絕對金額限損：RiskManager 條件 C", () => {
  it("浮虧達 Max_Loss_USDT → 觸發（先於條件 B）", () => {
    const rm = new RiskManager({ initialCapital: 10000, maxDrawdownPct: 10, maxLossUsdt: 100 });
    // 多單：均價 50000、現價 48950、數量 0.1 → 浮虧 105 USDT（< 條件 A 上限 1000）
    const r = rm.checkLimitStop({
      totalSize: 0.1,
      avgPrice: 50000,
      currentPrice: 48950,
      lastLayerPrice: 49000,
      isLong: true,
    });
    expect(r.triggered).toBe(true);
    expect(r.reason).toContain("絕對金額限損");
    expect(r.estimatedLoss).toBeCloseTo(105, 2);
  });

  it("maxLossUsdt = 0 → 不啟用條件 C（向後相容）", () => {
    const rm = new RiskManager({ initialCapital: 10000, maxDrawdownPct: 10, maxLossUsdt: 0 });
    const r = rm.checkLimitStop({
      totalSize: 0.1,
      avgPrice: 50000,
      currentPrice: 48950, // 浮虧 105，但條件 C 停用；偏離最後層 0.1% < 3%
      lastLayerPrice: 49000,
      isLong: true,
    });
    expect(r.triggered).toBe(false);
  });

  it("浮虧未達門檻 → 不觸發", () => {
    const rm = new RiskManager({ initialCapital: 10000, maxDrawdownPct: 10, maxLossUsdt: 100 });
    const r = rm.checkLimitStop({
      totalSize: 0.01,
      avgPrice: 50000,
      currentPrice: 49500, // 浮虧 5 USDT
      lastLayerPrice: 49600,
      isLong: true,
    });
    expect(r.triggered).toBe(false);
    expect(r.estimatedLoss).toBeCloseTo(5, 2);
  });

  it("條件 A（百分比）仍優先且與條件 C 並行監聽", () => {
    const rm = new RiskManager({ initialCapital: 1000, maxDrawdownPct: 10, maxLossUsdt: 500 });
    // 浮虧 105 >= 條件 A 上限 100（1000×10%），條件 C 500 未達 → 觸發 A
    const r = rm.checkLimitStop({
      totalSize: 0.1,
      avgPrice: 50000,
      currentPrice: 48950,
      lastLayerPrice: 49000,
      isLong: true,
    });
    expect(r.triggered).toBe(true);
    expect(r.reason).toContain("條件 A");
  });
});

describe("StrategyState 擴展欄位（O2/O3 支援）", () => {
  it("createInitialStrategyState 包含 entryTrendBull / hasTriggeredKamaReversal 初始值", () => {
    const s = createInitialStrategyState();
    expect(s.entryTrendBull).toBeUndefined();
    expect(s.hasTriggeredKamaReversal).toBe(false);
  });
});
