import { describe, expect, it } from "vitest";
import {
  BaseStrategy,
  MarketData,
  MartinState,
  StrategyAction,
  StrategyInstanceConfig,
  StrategySignal,
} from "./strategies/base";
import { Strategy20415 } from "./strategies/builtin/strategy20415";
import {
  compileAndLoadStrategy,
  getStrategy,
  initStrategyStudio,
  isBuiltInKey,
  unregisterStrategy,
  validateStrategyCode,
} from "./services/strategyStudio";

/* ==================== 馬丁倉位計算 ==================== */

/** 測試用子類：暴露 protected calcMartinLot */
class MartinProbe extends BaseStrategy {
  readonly key = "martin_probe";
  readonly name = "馬丁探針";
  readonly defaultConfig = {};
  generateActions(
    _s: StrategySignal,
    _i: StrategyInstanceConfig,
    _m: MarketData | null,
    _ms: MartinState,
  ): StrategyAction {
    return { action: "HOLD", lotSize: 0 };
  }
  calc(initial: number, mult: number, losses: number, maxLevel: number) {
    return this.calcMartinLot(initial, mult, losses, maxLevel);
  }
}

describe("calcMartinLot 馬丁加倉計算", () => {
  const probe = new MartinProbe();

  it("零虧損時使用初始倉位", () => {
    expect(probe.calc(0.01, 2, 0, 5)).toBeCloseTo(0.01);
  });

  it("每次虧損後按倍數加倉", () => {
    expect(probe.calc(0.01, 2, 1, 5)).toBeCloseTo(0.02);
    expect(probe.calc(0.01, 2, 2, 5)).toBeCloseTo(0.04);
    expect(probe.calc(0.01, 1.5, 2, 5)).toBeCloseTo(0.0225);
  });

  it("超過最大馬丁層數時封頂（level 上限為 maxLevel-1）", () => {
    // lossCount=10 但 maxLevel=3 → level 封頂 2 → 2^2 = 4 倍
    expect(probe.calc(0.01, 2, 10, 3)).toBeCloseTo(0.04);
  });

  it("maxLevel=1 時永遠使用初始倉位", () => {
    expect(probe.calc(0.01, 2, 5, 1)).toBeCloseTo(0.01);
  });
});

/* ==================== 內建策略 Strategy20415 (EMATrendMartingale v1.0) ==================== */

describe("Strategy20415 內建策略決策", () => {
  const engine = new Strategy20415();
  const instance = {
    id: 1,
    symbol: "XAUUSD",
    direction: "both" as const,
    positionSize: 0.01,
    leverage: 10,
    config: { MartinMultiplier: 1.5, MaxMartinLevels: 10, FirstLot: 0.01 },
  };
  const freshMartin = { lossCount: 0, currentLot: 0.01, lastEntryPrice: 0 };

  it("BUY 訊號產生開多動作（無 EMA 資料時信任訊號）", () => {
    const d = engine.generateActions(
      { action: "BUY", symbol: "XAUUSD", price: 2000 },
      instance,
      null,
      freshMartin,
    );
    expect(d.action).toBe("OPEN_LONG");
    expect(d.lotSize).toBeCloseTo(0.01);
  });

  it("SELL 訊號產生開空動作（無 EMA 資料時信任訊號）", () => {
    const d = engine.generateActions(
      { action: "SELL", symbol: "XAUUSD", price: 2000 },
      instance,
      null,
      freshMartin,
    );
    expect(d.action).toBe("OPEN_SHORT");
  });

  it("CLOSE 訊號產生全平動作", () => {
    const d = engine.generateActions(
      { action: "CLOSE", symbol: "XAUUSD", price: 2000 },
      instance,
      null,
      freshMartin,
    );
    expect(d.action).toBe("CLOSE_ALL");
  });

  it("連續虧損後馬丁加倉（MartinMultiplier=1.5, lossCount=2）", () => {
    const d = engine.generateActions(
      { action: "BUY", symbol: "XAUUSD", price: 2000 },
      instance,
      null,
      { lossCount: 2, currentLot: 0.0225, lastEntryPrice: 2050 },
    );
    expect(d.action).toBe("OPEN_LONG");
    // 0.01 * 1.5^2 = 0.0225
    expect(d.lotSize).toBeCloseTo(0.0225);
  });

  it("SMA v3.00：信任 Webhook 訊號，SELL 產生開空（即使有 EMA 資料）", () => {
    const d = engine.generateActions(
      { action: "SELL", symbol: "XAUUSD", price: 2000 },
      instance,
      {
        lastPrice: 2000,
        ema: { ema3: 2050, ema6: 2040, ema15: 2030, ema30: 2020, ema60: 2010 },
      },
      freshMartin,
    );
    // SMA v3.00: generateActions 信任 Webhook 訊號，不做 EMA 過濾
    expect(d.action).toBe("OPEN_SHORT");
  });

  it("SMA v3.00：信任 Webhook 訊號，BUY 產生開多（即使有 EMA 資料）", () => {
    const d = engine.generateActions(
      { action: "BUY", symbol: "XAUUSD", price: 2000 },
      instance,
      {
        lastPrice: 2000,
        ema: { ema3: 1950, ema6: 1960, ema15: 1970, ema30: 1980, ema60: 1990 },
      },
      freshMartin,
    );
    // SMA v3.00: 信任 Webhook 訊號，不做 EMA 過濾
    expect(d.action).toBe("OPEN_LONG");
  });

  it("EMA 馬丁：層數已滿時返回 HOLD", () => {
    // 新策略 max_layers 默認 12，lossCount 必須 >= 12 才觸發
    const d = engine.generateActions(
      { action: "BUY", symbol: "XAUUSD", price: 2000 },
      instance,
      null,
      { lossCount: 12, currentLot: 0.5, lastEntryPrice: 1900 },
    );
    expect(d.action).toBe("HOLD");
    expect(d.reason).toContain("最大層數");
  });
});

/* ==================== 代碼安全驗證 ==================== */

describe("validateStrategyCode 安全驗證", () => {
  // 需超過 50 字元的基底代碼，確保進入禁用 API 檢查而非長度檢查
  const pad = `\n// padding: strategy class implementation details for length requirement\n`;

  it("拒絕使用 child_process 的代碼", () => {
    const r = validateStrategyCode(
      `import { exec } from "child_process"; exec("ls"); generateActions(${pad}`,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain("禁止");
  });

  it("拒絕使用 fs 的代碼", () => {
    const r = validateStrategyCode(
      `const fs = require("fs"); fs.readFileSync("/etc/passwd"); generateActions(${pad}`,
    );
    expect(r.ok).toBe(false);
  });

  it("拒絕使用 eval 的代碼", () => {
    const r = validateStrategyCode(`eval("console.log(1)"); generateActions(${pad}`);
    expect(r.ok).toBe(false);
  });

  it("拒絕使用 process.env 的代碼", () => {
    const r = validateStrategyCode(`const key = process.env.SECRET; generateActions(${pad}`);
    expect(r.ok).toBe(false);
  });

  it("拒絕使用 fetch 網路請求的代碼", () => {
    const r = validateStrategyCode(`await fetch("https://evil.com"); generateActions(${pad}`);
    expect(r.ok).toBe(false);
  });

  it("拒絕缺少 generateActions 的代碼", () => {
    const r = validateStrategyCode(`export class X { key = "x"; name = "x"; }${pad}`);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("generateActions");
  });

  it("允許純計算策略代碼", () => {
    const r = validateStrategyCode(
      `export class X { generateActions() { return { action: "HOLD", lotSize: 0 }; } }${pad}`,
    );
    expect(r.ok).toBe(true);
  });
});

/* ==================== 內建策略保護 ==================== */

describe("內建策略保護機制", () => {
  it("strategy_20415 屬於內建 key", async () => {
    await initStrategyStudio();
    expect(isBuiltInKey("strategy_20415")).toBe(true);
    expect(isBuiltInKey("my_custom")).toBe(false);
  });

  it("編譯試圖覆蓋內建 key 的代碼會被拒絕", async () => {
    const code = `
export class FakeStrategy {
  key = "strategy_20415";
  name = "假冒內建";
  defaultConfig = {};
  generateActions() { return { action: "HOLD", lotSize: 0 }; }
}`;
    const r = await compileAndLoadStrategy(code, "paste");
    expect(r.success).toBe(false);
    expect(r.message).toContain("內建");
  });
});

/* ==================== 動態編譯與熱重載 ==================== */

describe("compileAndLoadStrategy 動態編譯載入", () => {
  const validCode = `
export class TestUnitStrategy {
  key = "unit_test_strategy";
  name = "單元測試策略";
  defaultConfig = { initial_lot: 0.02 };
  generateActions(signal, instance, marketData, martinState) {
    if (signal.action === "BUY") return { action: "OPEN_LONG", lotSize: 0.02, reason: "test" };
    return { action: "HOLD", lotSize: 0 };
  }
}`;

  it("合法代碼編譯註冊成功且可取得實例", async () => {
    const r = await compileAndLoadStrategy(validCode, "paste");
    expect(r.success).toBe(true);
    expect(r.key).toBe("unit_test_strategy");

    const engine = getStrategy("unit_test_strategy");
    expect(engine).toBeDefined();
    const d = engine!.generateActions(
      { action: "BUY", symbol: "BTCUSDT", price: 1 },
      { id: 1, symbol: "BTCUSDT", direction: "both", positionSize: 0.02, leverage: 1, config: {} },
      null,
      { lossCount: 0, currentLot: 0.02, lastEntryPrice: 0 },
    );
    expect(d.action).toBe("OPEN_LONG");

    unregisterStrategy("unit_test_strategy");
    expect(getStrategy("unit_test_strategy")).toBeUndefined();
  });

  it("缺少 generateActions 的代碼被拒絕", async () => {
    const r = await compileAndLoadStrategy(
      `export class NoAction { key = "no_action"; name = "x"; defaultConfig = {}; }`,
      "paste",
    );
    expect(r.success).toBe(false);
  });

  it("語法錯誤的代碼被拒絕且回傳錯誤訊息", async () => {
    const r = await compileAndLoadStrategy(`export class Broken { key = `, "paste");
    expect(r.success).toBe(false);
    expect(r.message.length).toBeGreaterThan(0);
  });
});
