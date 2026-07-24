/**
 * EMA 均線回歸馬丁格爾策略 — 動態風控整合測試
 * 驗證：
 * 1. 參數一致性（schema/defaultConfig/backtest/executor 參數名稱一致）
 * 2. 回測引擎中動態風控邏輯的靜態掃描
 * 3. 止盈參數正確（tp_normal/tp_trend/trail_normal/trail_trend）
 * 4. 動態硬止損和加倉間距參數存在且正確
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initStrategyStudio, getStrategy } from "./services/strategyStudio";
import * as fs from "fs";
import * as path from "path";

describe("EMA 馬丁動態風控整合測試", () => {
  beforeAll(() => {
    initStrategyStudio();
  });

  it("命令 6：參數一致性 — defaultConfig 包含所有動態風控參數", () => {
    const eng = getStrategy("strategy_20415");
    expect(eng).toBeDefined();
    const cfg = eng!.defaultConfig;

    // 核心 EMA 參數
    expect(cfg.ema_killer).toBe(3);
    expect(cfg.ema_wave).toBe(6);
    expect(cfg.ema_enter).toBe(15);
    expect(cfg.Point_Value).toBe(0.01);
    expect(cfg.Base_Lot_Size).toEqual({ value: 0.01, mode: "quantity" });

    // 馬丁加倉參數
    expect(cfg.multiplier).toBe(1.5);
    expect(cfg.max_layers).toBe(12);
    expect(cfg.pip_step_base).toBe(500.0);
    expect(cfg.enable_dynamic_pip).toBe(true);
    expect(cfg.pipstep_atr_multiplier).toBeDefined();
    expect(cfg.pipstep_min).toBeDefined();
    expect(cfg.pipstep_max).toBeDefined();

    // 止盈參數
    expect(cfg.tp_normal).toBeDefined();
    expect(cfg.tp_trend).toBeDefined();
    expect(cfg.trail_normal).toBeDefined();
    expect(cfg.trail_trend).toBeDefined();
    expect(cfg.trend_threshold).toBeDefined();

    // 硬止損參數
    expect(cfg.hard_stop_max).toBeDefined();
    expect(cfg.hard_stop_atr_multiplier).toBeDefined();
  });

  it("命令 1：起始手數 EntryLot = 0.01", () => {
    const eng = getStrategy("strategy_20415");
    expect(eng!.defaultConfig.Base_Lot_Size).toEqual({ value: 0.01, mode: "quantity" });
  });

  it("命令 2：無硬編碼止損 — 回測引擎中不存在 -100 或 maxLayers=5 硬編碼", () => {
    const enginePath = path.resolve(__dirname, "services/backtest/backtestEngine.ts");
    const src = fs.readFileSync(enginePath, "utf-8");

    // 在 runGenericBacktest 區域中搜索
    const genericStart = src.indexOf("private runGenericBacktest");
    expect(genericStart).toBeGreaterThan(0);
    const genericSrc = src.slice(genericStart);

    // 不應有 -100 硬編碼止損
    expect(genericSrc).not.toMatch(/totalProfit\s*<=?\s*-100[^0]/);
    // 不應有 maxLayers = 5 硬編碼
    expect(genericSrc).not.toMatch(/maxLayers\s*=\s*5[^0]/);
    // 不應有 maxMartinLevels = 5 硬編碼
    expect(genericSrc).not.toMatch(/maxMartinLevels\s*=\s*5[^0]/);
  });

  it("命令 3：持倉比例限制 — 回測引擎中有 maxPositionRatio 檢查邏輯", () => {
    const enginePath = path.resolve(__dirname, "services/backtest/backtestEngine.ts");
    const src = fs.readFileSync(enginePath, "utf-8");
    const genericStart = src.indexOf("private runGenericBacktest");
    const genericSrc = src.slice(genericStart);

    // 必須有持倉比例超限的邏輯
    expect(genericSrc).toContain("maxPositionRatio");
    // 必須在加倉前檢查
    expect(genericSrc).toContain("currentNotional + newNotional");
  });

  it("命令 4：權益回撤止損 — 回測引擎中有 peakEquity 追踪和回撤檢查", () => {
    const enginePath = path.resolve(__dirname, "services/backtest/backtestEngine.ts");
    const src = fs.readFileSync(enginePath, "utf-8");
    const genericStart = src.indexOf("private runGenericBacktest");
    const genericSrc = src.slice(genericStart);

    // 必須追踪 peakEquity
    expect(genericSrc).toContain("peakEquity");
    // 必須有回撤計算
    expect(genericSrc).toContain("drawdown");
  });

  it("命令 5：動態加倉間距 — 回測引擎使用 ATR-based 動態 pipstep", () => {
    const enginePath = path.resolve(__dirname, "services/backtest/backtestEngine.ts");
    const src = fs.readFileSync(enginePath, "utf-8");
    const genericStart = src.indexOf("private runGenericBacktest");
    const genericSrc = src.slice(genericStart);

    // 必須有 getGridStep 函數
    expect(genericSrc).toContain("getGridStep");
    // 必須有 ATR 相關計算
    expect(genericSrc).toContain("atr");
  });

  it("命令 7：止盈參數正確 — tp_normal/tp_trend/trail_normal/trail_trend", () => {
    const eng = getStrategy("strategy_20415");
    const cfg = eng!.defaultConfig;
    expect(cfg.tp_normal).toBeDefined();
    expect(cfg.tp_trend).toBeDefined();
    expect(cfg.trail_normal).toBeDefined();
    expect(cfg.trail_trend).toBeDefined();
    // trail 必須小於 tp
    expect(Number(cfg.trail_normal)).toBeLessThan(Number(cfg.tp_normal));
    expect(Number(cfg.trail_trend)).toBeLessThan(Number(cfg.tp_trend));
  });

  it("命令 4（executor）：實盤執行器中有動態風控檢查", () => {
    const executorPath = path.resolve(__dirname, "services/executor.ts");
    const src = fs.readFileSync(executorPath, "utf-8");

    // 必須有持倉比例超限的拒絕邏輯
    expect(src).toContain("持倉比例超限");
    // 必須有權益回撤止損的拒絕邏輯
    expect(src).toContain("權益回撤止損觸發");
    // 必須追踪 peakEquity
    expect(src).toContain("peakEquity");
  });

  it("命令 6（schema）：strategySchemas.ts 包含新 EMA 馬丁欄位", () => {
    const schemaPath = path.resolve(__dirname, "config/strategySchemas.ts");
    const src = fs.readFileSync(schemaPath, "utf-8");

    // 必須有新 EMA 馬丁參數欄位
    expect(src).toContain("max_layers");
    expect(src).toContain("multiplier");
    expect(src).toContain("pip_step_base");
    expect(src).toContain("tp_normal");
    expect(src).toContain("tp_trend");
    expect(src).toContain("hard_stop_max");
  });
});
