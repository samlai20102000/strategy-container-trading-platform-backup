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
  createRainbow20415DefaultConfig,
  RAINBOW_20415_STRATEGY_KEY,
  RAINBOW_20415_STRATEGY_NAME,
} from "../shared/strategies/rainbow20415";
import {
  compileAndLoadStrategy,
  getStrategy,
  initStrategyStudio,
  isBuiltInKey,
  unregisterStrategy,
  validateStrategyCode,
} from "./services/strategyStudio";
import { StrategyKamaRainbowMartin } from "./strategies/builtin/strategyKamaRainbowMartin";
import {
  KAMA_RAINBOW_MARTIN_RUNTIME_NAMESPACE,
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  KAMA_RAINBOW_MARTIN_STRATEGY_NAME,
  createKamaRainbowMartinDefaultConfig,
} from "../shared/strategies/kamaRainbowMartin";

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

/* ==================== 內建策略 Strategy20415 七彩虹橋接 ==================== */

describe("Strategy20415 七彩虹註冊橋接", () => {
  const engine = new Strategy20415();
  const config = createRainbow20415DefaultConfig();
  const instance = {
    id: 1,
    symbol: "XAUUSD",
    direction: "both" as const,
    positionSize: 0.01,
    leverage: 10,
    config,
  };
  const freshMartin = { lossCount: 0, currentLot: 0.01, lastEntryPrice: 0 };

  it("維持穩定 key，並公開七彩虹名稱與完整預設配置", () => {
    expect(engine.key).toBe(RAINBOW_20415_STRATEGY_KEY);
    expect(engine.name).toBe(RAINBOW_20415_STRATEGY_NAME);
    expect(engine.validateConfig(engine.defaultConfig).valid).toBe(true);
    expect(engine.defaultConfig.Config_Version).toBe("rainbow20415.v1");
    expect(engine.defaultConfig.Lines).toHaveLength(7);
  });

  it("BUY 外部意圖在空倉時以七彩虹底倉開多", () => {
    const d = engine.generateActions(
      { action: "BUY", symbol: "XAUUSD", price: 2000 },
      instance,
      null,
      freshMartin,
    );
    expect(d.action).toBe("OPEN_LONG");
    expect(d.lotSize).toBeCloseTo(0.01);
  });

  it("SELL 外部意圖在空倉時以七彩虹底倉開空", () => {
    const d = engine.generateActions(
      { action: "SELL", symbol: "XAUUSD", price: 2000 },
      instance,
      null,
      freshMartin,
    );
    expect(d.action).toBe("OPEN_SHORT");
  });

  it("USDT 底倉依訊號價格換算成交易數量", () => {
    const d = engine.generateActions(
      { action: "BUY", symbol: "XAUUSD", price: 2000 },
      {
        ...instance,
        config: { ...config, Base_Lot_Size: { value: 100, mode: "usdt" as const } },
      },
      null,
      freshMartin,
    );
    expect(d.action).toBe("OPEN_LONG");
    expect(d.lotSize).toBeCloseTo(0.05);
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

  it("已有本策略有效持倉時由純核心盲人模式接管，不以外部訊號重複加倉", () => {
    const d = engine.generateActions(
      { action: "BUY", symbol: "XAUUSD", price: 2000 },
      instance,
      null,
      {
        lossCount: 0,
        currentLot: 0.01,
        lastEntryPrice: 2000,
        currentLayer: 1,
        totalSize: 0.01,
        avgPrice: 2000,
      } as MartinState,
    );
    expect(d.action).toBe("HOLD");
    expect(d.reason).toContain("盲人模式");
  });

  it("拒絕不完整的七線配置", () => {
    const result = engine.validateConfig({
      ...config,
      Lines: config.Lines.slice(0, 6),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("7 條");
  });
});

describe("Kama 彩虹馬丁註冊橋接", () => {
  const engine = new StrategyKamaRainbowMartin();
  const config = createKamaRainbowMartinDefaultConfig();
  const instance = {
    id: 91,
    symbol: "BTCUSDT",
    direction: "both" as const,
    positionSize: 100,
    leverage: 3,
    config,
  };

  it("公開獨立 key、名稱、V2 canonical config 與馬丁 capability", () => {
    expect(engine.key).toBe(KAMA_RAINBOW_MARTIN_STRATEGY_KEY);
    expect(engine.name).toBe(KAMA_RAINBOW_MARTIN_STRATEGY_NAME);
    expect(engine.defaultConfig.version).toBe(config.version);
    expect(engine.defaultConfig.kamaLines).toHaveLength(2);
    expect(engine.capabilities.martingaleLayers).toBe(true);
    expect(engine.validateConfig(engine.defaultConfig).valid).toBe(true);
  });

  it("明確手動 BUY／SELL 只在空倉且方向允許時橋接", () => {
    expect(engine.generateActions(
      { action: "BUY", symbol: "BTCUSDT", price: 50_000 },
      instance,
      null,
      { lossCount: 0, currentLot: 0, lastEntryPrice: 0 },
    )).toMatchObject({ action: "OPEN_LONG", lotSize: 100 });
    expect(engine.generateActions(
      { action: "SELL", symbol: "BTCUSDT", price: 50_000 },
      { ...instance, direction: "long" as const },
      null,
      { lossCount: 0, currentLot: 0, lastEntryPrice: 0 },
    )).toMatchObject({ action: "HOLD" });
  });

  it("專用 runtime 已持倉時由 fresh-quote 核心接管，不重複開倉", () => {
    const action = engine.generateActions(
      { action: "BUY", symbol: "BTCUSDT", price: 50_000 },
      instance,
      null,
      {
        lossCount: 0,
        currentLot: 100,
        lastEntryPrice: 50_000,
        [KAMA_RAINBOW_MARTIN_RUNTIME_NAMESPACE]: {
          currentLayer: 1,
          totalQuantity: 0.002,
        },
      } as MartinState,
    );
    expect(action).toMatchObject({ action: "HOLD" });
    expect(action.reason).toContain("KRM_POSITION_MANAGED");
  });

  it("拒絕只啟用一條 KAMA 的配置", () => {
    const invalid = {
      ...config,
      kamaLines: config.kamaLines.map((line, index) => ({ ...line, enabled: index === 0 })),
    };
    expect(engine.validateConfig(invalid).valid).toBe(false);
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
    expect(isBuiltInKey(KAMA_RAINBOW_MARTIN_STRATEGY_KEY)).toBe(true);
    expect(getStrategy(KAMA_RAINBOW_MARTIN_STRATEGY_KEY)).toBeInstanceOf(StrategyKamaRainbowMartin);
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
