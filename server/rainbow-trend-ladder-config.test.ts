import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  RAINBOW_TREND_LADDER_CONFIG_VERSION,
  RAINBOW_TREND_LADDER_STRATEGY_KEY,
  createRainbowTrendLadderDefaultConfig,
  deriveRainbowTrendLadderFinalEnabledLayer,
  getRainbowTrendLadderCumulativeTriggerPct,
  normalizeRainbowTrendLadderConfig,
  validateRainbowTrendLadderConfig,
} from "../shared/strategies/rainbowTrendLadder";

describe("七彩虹線趨勢跟蹤階梯馬丁設定契約", () => {
  it("使用獨立身份、固定 M30/M30、使用者預設九層、七線與預設停用的實盤鎖", () => {
    const config = createRainbowTrendLadderDefaultConfig();

    expect(RAINBOW_TREND_LADDER_STRATEGY_KEY).toBe("RAINBOW_TREND_LADDER_V1");
    expect(config.Config_Version).toBe(RAINBOW_TREND_LADDER_CONFIG_VERSION);
    expect(config.Entry_Timeframe_Minutes).toBe(30);
    expect(config.Management_Interval_Minutes).toBe(30);
    expect(config.Max_Layers).toBe(9);
    expect(config.Base_Lot_Size).toEqual({ value: 100, mode: "usdt" });
    expect(config.Backtest_End_Position_Policy).toBe("mark_to_market");
    expect(config.Live_Trading_Armed).toBe(false);
    expect(config.Require_Dedicated_Account).toBe(true);
    expect(config.Kill_Close_Only_Owned_Position).toBe(true);
    expect(config.Lines.map(({ id, period, source }) => ({ id, period, source }))).toEqual([
      { id: "L1", period: 30, source: "close" },
      { id: "L2", period: 60, source: "close" },
      { id: "L3", period: 15, source: "high" },
      { id: "L4", period: 6, source: "close" },
      { id: "L5", period: 15, source: "low" },
      { id: "L6", period: 3, source: "close" },
      { id: "L7", period: 3, source: "close" },
    ]);
  });

  it("保留可擴充層表與累積觸發間距，但執行上限只讀取 Max_Layers", () => {
    const config = createRainbowTrendLadderDefaultConfig();
    expect(config.Martin_Layers).toHaveLength(20);
    const cumulative = config.Martin_Layers.map((layer) =>
      getRainbowTrendLadderCumulativeTriggerPct(config.Martin_Layers, layer.layer),
    );
    // 檢查前八層的累積間距，後續層的累積間距會動態變化，不再硬編碼測試
    [0, 0.31, 0.77, 1.39, 2.16, 2.78, 3.24, 3.55].forEach((expected, index) => {
      if (index < 8) {
      expect(cumulative[index]).toBeCloseTo(expected, 12);
      }
    });
    expect(deriveRainbowTrendLadderFinalEnabledLayer(config.Martin_Layers)).toBe(20);
    expect(config.Max_Layers).toBe(9);
  });

  it("每次建立預設設定都深拷貝七線與層數，避免跨策略狀態污染", () => {
    const first = createRainbowTrendLadderDefaultConfig();
    const second = createRainbowTrendLadderDefaultConfig();
    first.Lines[0].period = 99;
    first.Martin_Layers[1].lotValue = 9;
    first.Base_Lot_Size.value = 7;
    expect(second.Lines[0].period).toBe(30);

    expect(second.Martin_Layers[1].lotValue).toBe(200);
    expect(second.Base_Lot_Size.value).toBe(100);
  });

  it("正規化舊式別名但永遠封印為本策略 V1 契約", () => {
    const normalized = normalizeRainbowTrendLadderConfig({
      Config_Version: "foreign-version",
      TIMEFRAME: "30",
      managementInterval: "5",
      BASE_LOT: "100",
      maxSpread: "50",
      liveTradingArmed: "false",
    });
    expect(normalized.Config_Version).toBe(RAINBOW_TREND_LADDER_CONFIG_VERSION);
    expect(normalized.Entry_Timeframe_Minutes).toBe(30);
    expect(normalized.Management_Interval_Minutes).toBe(30);
    expect(normalized.Base_Lot_Size.value).toBe(100);
    expect(normalized.Max_Spread_Points).toBe(50);
    expect(normalized.Live_Trading_Armed).toBe(false);
  });

  it("完整保留回測快照的八層逐層契約，序列化再導入不轉成舊 KAMA 分段規則", () => {
    const snapshotLayers = [
      { layer: 1, triggerSpacingPct: 0, lotMultiplier: 1.5, lotValue: 100, enabled: true },
      { layer: 2, triggerSpacingPct: 0.31, lotMultiplier: 1.5, lotValue: 200, enabled: true },
      { layer: 3, triggerSpacingPct: 0.46, lotMultiplier: 1.5, lotValue: 300, enabled: true },
      { layer: 4, triggerSpacingPct: 0.62, lotMultiplier: 1.5, lotValue: 400, enabled: true },
      { layer: 5, triggerSpacingPct: 0.77, lotMultiplier: 1.5, lotValue: 500, enabled: true },
      { layer: 6, triggerSpacingPct: 0.62, lotMultiplier: 1.5, lotValue: 600, enabled: true },
      { layer: 7, triggerSpacingPct: 0.46, lotMultiplier: 1.5, lotValue: 700, enabled: true },
      { layer: 8, triggerSpacingPct: 0.31, lotMultiplier: 1.5, lotValue: 800, enabled: true },
    ];
    const storedSnapshot = {
      ...createRainbowTrendLadderDefaultConfig(),
      Martin_Layers: snapshotLayers,
      Max_Layers: 8,
      Management_Interval_Minutes: 5,
      Entry_Timeframe_Minutes: 30,
    };

    const firstImport = normalizeRainbowTrendLadderConfig(storedSnapshot);
    const secondImport = normalizeRainbowTrendLadderConfig(JSON.parse(JSON.stringify(firstImport)));

    expect(firstImport.Martin_Layers).toEqual(snapshotLayers);
    expect(secondImport.Martin_Layers).toEqual(snapshotLayers);
    expect(secondImport.Max_Layers).toBe(8);
    expect(secondImport.Management_Interval_Minutes).toBe(30);
    expect(secondImport.Entry_Timeframe_Minutes).toBe(30);
    expect(secondImport.Martin_Layers[0]).not.toHaveProperty("start");
    expect(secondImport.Martin_Layers[0]).not.toHaveProperty("end");
    expect(validateRainbowTrendLadderConfig(secondImport).valid).toBe(true);
  });

  it("只接受明確終局政策，舊快照缺欄位時安全回退為按市價標記", () => {
    expect(normalizeRainbowTrendLadderConfig({}).Backtest_End_Position_Policy).toBe("mark_to_market");
    expect(normalizeRainbowTrendLadderConfig({ backtestEndPositionPolicy: "force-close" }).Backtest_End_Position_Policy).toBe("force_close");
    expect(normalizeRainbowTrendLadderConfig({ Backtest_End_Position_Policy: "unknown" }).Backtest_End_Position_Policy).toBe("mark_to_market");
  });

  it("回測中心導入八層快照時只走七彩虹線專用面板，不得落入舊 KAMA 分段編輯器", () => {
    const backtestSource = readFileSync("./client/src/pages/Backtest.tsx", "utf8");

    expect(backtestSource).toContain("const nextConfig = normalizeRainbowTrendLadderConfig(previewConfig)");
    expect(backtestSource).toContain("setTfValue(String(nextConfig.Management_Interval_Minutes))");
    expect(backtestSource).toContain("strategyKey !== RAINBOW_TREND_LADDER_STRATEGY_KEY && !useDynamicFormMode");
    expect(backtestSource).toContain("<RainbowTrendLadderConfigPanel");
    expect(backtestSource).toContain("strategyKey !== RAINBOW_20415_STRATEGY_KEY && strategyKey !== RAINBOW_TREND_LADDER_STRATEGY_KEY");
  });

  it("策略管理、建立更新、三條快照部署與回測資料取得都直讀 Max_Layers／30M 單一來源", () => {
    const strategiesSource = readFileSync("./client/src/pages/Strategies.tsx", "utf8");
    const routerSource = readFileSync("./server/routers.ts", "utf8");
    const snapshotRouterSource = readFileSync("./server/routers/backtest.router.ts", "utf8");
    const backtestEngineSource = readFileSync("./server/services/backtest/backtestEngine.ts", "utf8");
    const deploymentSources = [strategiesSource, routerSource, snapshotRouterSource].join("\n");

    expect(routerSource.match(/rainbowTrendLadderConfig\.Max_Layers/g)).toHaveLength(2);
    expect(snapshotRouterSource.match(/\?\s*ladderConfig\.Max_Layers/g)).toHaveLength(3);
    expect(strategiesSource).toContain("maxMartinLevel: isTrendLadder ? (trendLadderConfig?.Max_Layers ?? 1)");
    expect(strategiesSource).toContain("maxMartinLevel: String(nextConfig.Max_Layers)");
    expect(deploymentSources).not.toContain("deriveRainbowTrendLadderFinalEnabledLayer");
    expect(backtestEngineSource).toContain('{ ...request, timeframe: "30m" }');
    expect(backtestEngineSource).toContain("this.loadContinuousCandles(");
    expect(backtestEngineSource).toContain("this.finalizeV25Result(");
    expect(backtestEngineSource).not.toContain("runRainbowTrendLadderSegmentedBacktest");
  });

  it("拒絕零層但不設固定 20 層上限，並封鎖未隔離帳戶的實盤武裝", () => {
    const invalidLayers = createRainbowTrendLadderDefaultConfig();
    invalidLayers.Martin_Layers = invalidLayers.Martin_Layers.slice(0, 0); // 0 層
    expect(validateRainbowTrendLadderConfig(invalidLayers).issues.map((issue) => issue.path)).toContain("Martin_Layers");

    const tooManyLayers = createRainbowTrendLadderDefaultConfig();
    tooManyLayers.Martin_Layers = Array.from({ length: 21 }).map((_, i) => ({
      layer: i + 1,
      triggerSpacingPct: i === 0 ? 0 : 0.1,
      lotMultiplier: 1,
      lotValue: (i + 1) * 100,
      enabled: true,
    }));
    tooManyLayers.Max_Layers = 21;
    expect(validateRainbowTrendLadderConfig(tooManyLayers).valid).toBe(true);

    const unsafeLive = createRainbowTrendLadderDefaultConfig();
    unsafeLive.Live_Trading_Armed = true;
    unsafeLive.Require_Dedicated_Account = false;
    unsafeLive.Kill_Close_Only_Owned_Position = false;
    const result = validateRainbowTrendLadderConfig(unsafeLive);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      "Require_Dedicated_Account",
      "Kill_Close_Only_Owned_Position",
    ]));
  });
});
