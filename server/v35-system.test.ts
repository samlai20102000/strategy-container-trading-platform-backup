/**
 * V3.5 KAMA+3K 馬丁系統測試
 * 覆蓋：馬丁引擎、風險管理器、移動止盈、V3.5 策略驗證、Bar-Lock 記憶體層
 */
import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { MartingaleEngine } from "./services/martingaleEngine";
import { RiskManager } from "./services/riskManager";
import { updateTrailingStop } from "./services/trailingStopManager";
import { createInitialStrategyState, StrategyState } from "./strategies/base";
import { StrategyKama3kV35 } from "./strategies/v35/strategy_kama_3k_v35";
import {
  buildV35CloseIntentId,
  classifyV35CloseFailure,
  computeV35CloseRetryDelayMs,
  readV35CloseRetryState,
  resolveV35PositionTruth,
  selectV35ExpectedPosition,
} from "./services/v35Monitor";

const MARTIN_CFG = { baseLot: 0.01, multiplier: 1.5, stepPct: 1.5, maxLayers: 5 };

describe("MartingaleEngine 馬丁引擎", () => {
  it("首單開倉：第 1 層 = baseLot，均價 = 進場價", () => {
    const engine = new MartingaleEngine(MARTIN_CFG);
    const { lotSize, newState } = engine.addLayer(50000, true);
    expect(lotSize).toBe(0.01);
    expect(newState.currentLayer).toBe(1);
    expect(newState.avgPrice).toBe(50000);
    expect(newState.totalSize).toBe(0.01);
    expect(newState.isLong).toBe(true);
  });

  it("倉位公式：lotSize = baseLot × multiplier^(layer-1)", () => {
    expect(MartingaleEngine.calcLayerLot(0.01, 1.5, 1)).toBe(0.01);
    expect(MartingaleEngine.calcLayerLot(0.01, 1.5, 2)).toBe(0.015);
    expect(MartingaleEngine.calcLayerLot(0.01, 1.5, 3)).toBe(0.0225);
    expect(MartingaleEngine.calcLayerLot(0.01, 1.5, 5)).toBeCloseTo(0.050625, 6);
  });

  it("shouldAddLayer：多頭價格下跌 >= stepPct% 觸發加倉", () => {
    const engine = new MartingaleEngine(MARTIN_CFG);
    engine.addLayer(50000, true);
    // 下跌 1.5% → 49250
    expect(engine.shouldAddLayer(49250, true)).toBe(true);
    // 下跌 1% → 49500，未達 1.5%
    expect(engine.shouldAddLayer(49500, true)).toBe(false);
    // 上漲不加倉
    expect(engine.shouldAddLayer(51000, true)).toBe(false);
  });

  it("shouldAddLayer：空頭價格上漲 >= stepPct% 觸發加倉", () => {
    const engine = new MartingaleEngine(MARTIN_CFG);
    engine.addLayer(50000, false);
    expect(engine.shouldAddLayer(50750, false)).toBe(true); // +1.5%
    expect(engine.shouldAddLayer(50300, false)).toBe(false); // +0.6%
  });

  it("加倉更新均價：兩層後均價 = 總成本/總數量", () => {
    const engine = new MartingaleEngine(MARTIN_CFG);
    engine.addLayer(50000, true); // 0.01 @ 50000
    const { newState } = engine.addLayer(49250, true); // 0.015 @ 49250
    // 均價 = (50000×0.01 + 49250×0.015) / 0.025 = 49550
    expect(newState.avgPrice).toBeCloseTo(49550, 0);
    expect(newState.currentLayer).toBe(2);
    expect(newState.totalSize).toBe(0.025);
    expect(newState.lastLayerPrice).toBe(49250);
  });

  it("最大層數限制：超過 maxLayers 拋出錯誤且 shouldAddLayer 返回 false", () => {
    const engine = new MartingaleEngine({ ...MARTIN_CFG, maxLayers: 2 });
    engine.addLayer(50000, true);
    engine.addLayer(49250, true);
    expect(engine.shouldAddLayer(48000, true)).toBe(false);
    expect(() => engine.addLayer(48000, true)).toThrow();
  });

  it("reset 重置狀態但保留冷卻資訊", () => {
    const engine = new MartingaleEngine(MARTIN_CFG, {
      ...createInitialStrategyState(),
      currentLayer: 3,
      totalSize: 0.0475,
      avgPrice: 49000,
      totalCost: 2327.5,
      isCooldown: true,
      cooldownUntil: 9999999999999,
    });
    const reset = engine.reset();
    expect(reset.currentLayer).toBe(0);
    expect(reset.totalSize).toBe(0);
    expect(reset.isCooldown).toBe(true);
    expect(reset.cooldownUntil).toBe(9999999999999);
  });

  it("previewLayers 生成完整倉位預覽表", () => {
    const rows = MartingaleEngine.previewLayers(0.01, 1.5, 5, 50000);
    expect(rows).toHaveLength(5);
    expect(rows[0].lotSize).toBe(0.01);
    expect(rows[4].lotSize).toBeCloseTo(0.050625, 6);
    expect(rows[4].cumulativeSize).toBeCloseTo(0.131875, 6);
  });
});

describe("RiskManager 極限防爆倉止損", () => {
  const rm = new RiskManager({ initialCapital: 1000, maxDrawdownPct: 10 });

  it("條件 A：浮虧 >= 初始資本 × 10% 觸發", () => {
    // 多頭 0.05 BTC 均價 50000，現價 48000 → 浮虧 = 2000×0.05 = 100 USDT = 1000×10%
    const result = rm.checkLimitStop({
      totalSize: 0.05,
      avgPrice: 50000,
      currentPrice: 48000,
      lastLayerPrice: 49000,
      isLong: true,
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("條件 A");
  });

  it("條件 B：價格偏離最後層 >= 3% 觸發", () => {
    // 多頭最後層 @ 49000，現價 47530 → 偏離 3%
    const result = rm.checkLimitStop({
      totalSize: 0.01,
      avgPrice: 50000,
      currentPrice: 47530,
      lastLayerPrice: 49000,
      isLong: true,
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("條件 B");
  });

  it("未達任一條件不觸發", () => {
    const result = rm.checkLimitStop({
      totalSize: 0.01,
      avgPrice: 50000,
      currentPrice: 49600, // 浮虧 4 USDT < 100；偏離最後層 (49000-49600)<0 不觸發
      lastLayerPrice: 49000,
      isLong: true,
    });
    expect(result.triggered).toBe(false);
  });

  it("空頭方向：價格上漲觸發條件 B", () => {
    const result = rm.checkLimitStop({
      totalSize: 0.01,
      avgPrice: 50000,
      currentPrice: 51530, // 最後層 50000 → +3.06%
      lastLayerPrice: 50000,
      isLong: false,
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("條件 B");
  });

  it("每日虧損限額檢查", () => {
    expect(rm.checkDailyLoss(150, 100).triggered).toBe(true);
    expect(rm.checkDailyLoss(50, 100).triggered).toBe(false);
    expect(rm.checkDailyLoss(500, 0).triggered).toBe(false); // 0 = 不限制
  });
});

describe("TrailingStop 移動止盈", () => {
  const cfg = { targetTpPct: 1.0, callbackPct: 0.2 };

  function makeState(overrides: Partial<StrategyState> = {}): StrategyState {
    return {
      ...createInitialStrategyState(),
      currentLayer: 1,
      totalSize: 0.01,
      avgPrice: 50000,
      totalCost: 500,
      isLong: true,
      ...overrides,
    };
  }

  it("盈利 >= 1% 激活追蹤", () => {
    const result = updateTrailingStop(makeState(), 50500, cfg); // +1%
    expect(result.shouldClose).toBe(false);
    expect(result.newState.isTrailingActivated).toBe(true);
    expect(result.newState.highestPrice).toBe(50500);
  });

  it("盈利不足不激活", () => {
    const result = updateTrailingStop(makeState(), 50300, cfg); // +0.6%
    expect(result.newState.isTrailingActivated).toBe(false);
  });

  it("激活後更新最優價", () => {
    const state = makeState({ isTrailingActivated: true, highestPrice: 50500 });
    const result = updateTrailingStop(state, 50800, cfg);
    expect(result.shouldClose).toBe(false);
    expect(result.newState.highestPrice).toBe(50800);
  });

  it("回撤 >= 0.2% 觸發平倉", () => {
    const state = makeState({ isTrailingActivated: true, highestPrice: 50800 });
    // 50800 × (1 - 0.002) = 50698.4
    const result = updateTrailingStop(state, 50695, cfg);
    expect(result.shouldClose).toBe(true);
    expect(result.reason).toContain("移動止盈觸發");
  });

  it("空頭：追蹤最低價，反彈觸發平倉", () => {
    const state = makeState({
      isLong: false,
      isTrailingActivated: true,
      highestPrice: 49200, // 空頭的最優價 = 最低價
    });
    // 反彈 0.25% → 49323
    const result = updateTrailingStop(state, 49325, cfg);
    expect(result.shouldClose).toBe(true);
  });
});

describe("V35／V4.0 成交後持倉方向真相", () => {
  it("舊資料 entryTrendBull 與 isLong 不一致時，多單仍只加多、賣出平多", () => {
    const legacyImportedState = { isLong: true, entryTrendBull: false };

    expect(resolveV35PositionTruth(legacyImportedState.isLong)).toEqual({
      posSide: "long",
      increaseSide: "buy",
      closeSide: "sell",
      pnlMultiplier: 1,
    });
  });

  it("舊資料 entryTrendBull 與 isLong 不一致時，空單仍只加空、買入平空", () => {
    const legacyImportedState = { isLong: false, entryTrendBull: true };

    expect(resolveV35PositionTruth(legacyImportedState.isLong)).toEqual({
      posSide: "short",
      increaseSide: "sell",
      closeSide: "buy",
      pnlMultiplier: -1,
    });
  });

  it("本地 long 只能匹配交易所 long；只有 short 時禁止反向腿 fallback", () => {
    const long = { symbol: "BTC-USDT-SWAP", side: "long", size: 0.0079 };
    const short = { symbol: "BTC-USDT-SWAP", side: "short", size: 0.1159 };

    expect(selectV35ExpectedPosition([long, short], true)).toBe(long);
    expect(selectV35ExpectedPosition([short], true)).toBeUndefined();
    expect(selectV35ExpectedPosition([long], false)).toBeUndefined();
  });

  it("同一持倉循環產生穩定關閉意圖，失敗以 1/2/4/8/15 分鐘退避並可持久化還原", () => {
    const state = {
      ...createInitialStrategyState(),
      totalSize: 0.0079,
      avgPrice: 63_000,
      isLong: true,
    };
    const intent = buildV35CloseIntentId(120011, state);

    expect(intent).toBe(buildV35CloseIntentId(120011, { ...state }));
    expect(intent.length).toBeLessThanOrEqual(32);
    expect([1, 2, 3, 4, 5, 6].map(computeV35CloseRetryDelayMs)).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      900_000,
      900_000,
    ]);

    const persisted = {
      ...state,
      closeRetry: { closeIntentId: intent, failureCount: 2, nextRetryAt: 123_456, lastError: "timeout" },
    };
    expect(readV35CloseRetryState(persisted)).toEqual(persisted.closeRetry);
  });

  it("平倉失敗會分類為可查詢 reasonCode，而不是只留下泛化訊息", () => {
    expect(classifyV35CloseFailure("INTENT_ALREADY_ACTIVE")).toBe("V35_CLOSE_INTENT_ACTIVE");
    expect(classifyV35CloseFailure("NO_MATCHING_POSITION")).toBe("V35_CLOSE_NO_MATCHING_LEG");
    expect(classifyV35CloseFailure("交易所後驗：持倉仍存在")).toBe("V35_CLOSE_POSITION_STILL_OPEN");
    expect(classifyV35CloseFailure("訂單政策稽核不可用")).toBe("V35_CLOSE_AUDIT_UNAVAILABLE");
    expect(classifyV35CloseFailure("timeout")).toBe("V35_CLOSE_TIMEOUT");
  });
});

describe("StrategyKama3kV35 五層驗證", () => {
  let strategy: StrategyKama3kV35;

  beforeEach(() => {
    strategy = new StrategyKama3kV35();
  });

  const instance = {
    id: 1,
    symbol: "BTCUSDT",
    direction: "both" as const,
    positionSize: 0.01,
    leverage: 10,
    config: strategy?.defaultConfig ?? {},
  };

  it("策略 key 與預設參數正確", () => {
    expect(strategy.key).toBe("20415_KAMA_MARTIN_V35");
    expect(strategy.defaultConfig.Base_Lot_Size).toBe(30); // V4.0 固定金本位 30 USDT
    expect(strategy.defaultConfig.Martin_Multiplier).toBe(1.5);
    expect(strategy.defaultConfig.Max_Layers).toBe(11); // V4.0 階梯式 11 層
    expect(strategy.defaultConfig.Target_TP_Pct).toBe(1.0); // V4.0 更新為 1.0
    expect(strategy.defaultConfig.Callback_Pct).toBe(0.1); // V4.0 更新為 0.1
    expect(strategy.defaultConfig.Max_Drawdown_Pct).toBe(10);
  });

  it("冷卻期內拒絕開倉信號", async () => {
    const state = {
      ...createInitialStrategyState(),
      isCooldown: true,
      cooldownUntil: Date.now() + 60_000,
    };
    const result = await strategy.validateSignal(
      { action: "BUY", symbol: "BTCUSDT", price: 50000 },
      { lastPrice: 50000 },
      { ...instance, config: strategy.defaultConfig, state },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("冷卻");
  });

  it("冷卻期已過允許開倉", async () => {
    const state = {
      ...createInitialStrategyState(),
      isCooldown: true,
      cooldownUntil: Date.now() - 1000, // 已過期
    };
    const result = await strategy.validateSignal(
      { action: "BUY", symbol: "BTCUSDT", price: 50000 },
      { lastPrice: 50000 },
      { ...instance, config: strategy.defaultConfig, state },
    );
    expect(result.valid).toBe(true);
  });

  it("KAMA 方向鎖：價格低於 KAMA 拒絕 BUY", async () => {
    const state = createInitialStrategyState();
    const result = await strategy.validateSignal(
      { action: "BUY", symbol: "BTCUSDT", price: 50000 },
      { lastPrice: 50000, kamaValue: 51000 }, // 價格 < KAMA → 空頭趨勢
      { ...instance, config: strategy.defaultConfig, state },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("KAMA");
  });

  it("KAMA 方向鎖：價格高於 KAMA 允許 BUY", async () => {
    const state = createInitialStrategyState();
    const result = await strategy.validateSignal(
      { action: "BUY", symbol: "BTCUSDT", price: 51000 },
      { lastPrice: 51000, kamaValue: 50000 },
      { ...instance, config: strategy.defaultConfig, state },
    );
    expect(result.valid).toBe(true);
  });

  it("反向持倉：持多倉時拒絕 SELL 開倉", async () => {
    const state = {
      ...createInitialStrategyState(),
      currentLayer: 1,
      totalSize: 0.01,
      avgPrice: 50000,
      isLong: true,
    };
    const result = await strategy.validateSignal(
      { action: "SELL", symbol: "BTCUSDT", price: 50000 },
      { lastPrice: 50000 },
      { ...instance, config: strategy.defaultConfig, state },
    );
    expect(result.valid).toBe(false);
  });

  it("CLOSE 信號始終有效", async () => {
    const state = {
      ...createInitialStrategyState(),
      isCooldown: true,
      cooldownUntil: Date.now() + 60_000,
    };
    const result = await strategy.validateSignal(
      { action: "CLOSE", symbol: "BTCUSDT", price: 50000 },
      { lastPrice: 50000 },
      { ...instance, config: strategy.defaultConfig, state },
    );
    expect(result.valid).toBe(true);
  });

  it("generateActionsV35：BUY 信號首單返回 OPEN_LONG 與正確倉位", async () => {
    const state = createInitialStrategyState();
    const decision = await strategy.generateActionsV35(
      { action: "BUY", symbol: "BTCUSDT", price: 50000 },
      { ...instance, config: strategy.defaultConfig, state },
      { lastPrice: 50000 },
      state,
    );
    expect(decision.action).toBe("OPEN_LONG");
    // 修復後：lotSize 是幣數量（Initial_Capital 10000 × First_Order_Pct 0.3% / price 50000 = 0.0006）
    expect(decision.lotSize).toBeCloseTo(0.0006, 4); // 30 USDT / 50000 = 0.0006 BTC
  });

  it("generateActionsV35：最終部署 500 USDT 會轉成實際委託數量", async () => {
    const state = createInitialStrategyState();
    const deploymentConfig = {
      ...strategy.defaultConfig,
      Base_Lot_Size: 500,
      Position_Mode: "usdt",
      Position_Value: 500,
    };
    const decision = await strategy.generateActionsV35(
      { action: "BUY", symbol: "BTCUSDT", price: 50000 },
      { ...instance, config: deploymentConfig, state },
      { lastPrice: 50000 },
      state,
    );

    expect(decision.action).toBe("OPEN_LONG");
    expect(decision.lotSize).toBeCloseTo(0.01, 8);
  });

  it("generateActionsV35：CLOSE 信號有持倉時返回 CLOSE_ALL", async () => {
    const state = {
      ...createInitialStrategyState(),
      currentLayer: 2,
      totalSize: 0.025,
      avgPrice: 49550,
      isLong: true,
    };
    const decision = await strategy.generateActionsV35(
      { action: "CLOSE", symbol: "BTCUSDT", price: 50000 },
      { ...instance, config: strategy.defaultConfig, state },
      { lastPrice: 50000 },
      state,
    );
    expect(decision.action).toBe("CLOSE_ALL");
  });

  it("generateActionsV35：CLOSE 信號無持倉時返回 HOLD", async () => {
    const state = createInitialStrategyState();
    const decision = await strategy.generateActionsV35(
      { action: "CLOSE", symbol: "BTCUSDT", price: 50000 },
      { ...instance, config: strategy.defaultConfig, state },
      { lastPrice: 50000 },
      state,
    );
    expect(decision.action).toBe("HOLD");
  });
});

// ============================================================
// Bar-Lock 記憶體層測試（同 K 線去重防禦）
// ============================================================
import { acquireBarLock, releaseAllLocks, __clearMemoryLocks } from "./services/barLock";

describe("BarLock 同 K 線去重（記憶體層）", () => {
  // 使用每次執行唯一的 bar_timestamp，避免 DB 殘留舊鎖導致測試不可重入
  const runTs = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    __clearMemoryLocks();
  });

  afterAll(async () => {
    // 清理測試產生的 DB 鎖記錄，保持測試可重複執行
    for (const id of [9001, 9002, 9003, 9004, 9005]) {
      await releaseAllLocks(id).catch(() => {});
    }
  });

  it("首次獲取鎖應成功", async () => {
    const r = await acquireBarLock(9001, runTs, 30);
    expect(r).toBe(true);
  });

  it("同一策略同一 bar_timestamp 第二次獲取應被攜截", async () => {
    await acquireBarLock(9002, runTs, 30);
    const r2 = await acquireBarLock(9002, runTs, 30);
    expect(r2).toBe(false);
  });

  it("不同 bar_timestamp 應可分別獲取", async () => {
    const a = await acquireBarLock(9003, runTs, 30);
    const b = await acquireBarLock(9003, runTs + 1800, 30);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it("不同策略同一 bar_timestamp 互不影響", async () => {
    const a = await acquireBarLock(9004, runTs, 30);
    const b = await acquireBarLock(9005, runTs, 30);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});
