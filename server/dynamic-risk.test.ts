/**
 * 20415 七彩虹馬丁策略 — 動態風控與基礎設施整合測試
 * 驗證：
 * 1. 參數一致性（schema/defaultConfig/backtest/executor 參數名稱一致）
 * 2. 回測引擎中動態風控邏輯的靜態掃描
 * 3. 百分比止盈與三道鐵幕參數正確
 * 4. 七線與動態連續階梯契約存在且正確
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initStrategyStudio, getStrategy } from "./services/strategyStudio";
import * as fs from "fs";
import * as path from "path";

describe("20415 七彩虹馬丁動態風控整合測試", () => {
  beforeAll(() => {
    initStrategyStudio();
  });

  it("命令 6：參數一致性 — defaultConfig 包含完整七彩虹與三道鐵幕參數", () => {
    const eng = getStrategy("strategy_20415");
    expect(eng).toBeDefined();
    const cfg = eng!.defaultConfig;

    expect(cfg.Config_Version).toBe("rainbow20415.v1");
    expect(cfg.Entry_Timeframe_Minutes).toBe(30);
    expect(cfg.Management_Interval_Minutes).toBe(1);
    expect(cfg.Lines).toHaveLength(7);
    expect(cfg.Lines.map((line: { period: number }) => line.period)).toEqual([
      5, 8, 13, 21, 34, 55, 89,
    ]);
    expect(cfg.Base_Lot_Size).toEqual({ value: 0.01, mode: "quantity" });

    expect(cfg.Martin_Ranges.length).toBeGreaterThan(0);
    expect(cfg.Martin_Ranges[0].startLayer).toBe(1);
    for (let index = 1; index < cfg.Martin_Ranges.length; index += 1) {
      expect(cfg.Martin_Ranges[index].startLayer).toBe(
        cfg.Martin_Ranges[index - 1].endLayer + 1,
      );
    }

    expect(cfg.Take_Profit_Pct).toBe(0.2);
    expect(cfg.Max_Hold_Hours).toBe(48);
    expect(cfg.Max_Margin_Usage_Pct).toBe(70);
    expect(cfg.Max_Account_Loss_Pct).toBe(5);
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

  it("命令 7：止盈與三道鐵幕參數使用百分比／小時單位", () => {
    const eng = getStrategy("strategy_20415");
    const cfg = eng!.defaultConfig;
    expect(cfg.Take_Profit_Pct).toBeGreaterThan(0);
    expect(cfg.Max_Hold_Hours).toBeGreaterThan(0);
    expect(cfg.Max_Margin_Usage_Pct).toBeGreaterThan(0);
    expect(cfg.Max_Margin_Usage_Pct).toBeLessThanOrEqual(100);
    expect(cfg.Max_Account_Loss_Pct).toBeGreaterThan(0);
    expect(cfg.Max_Account_Loss_Pct).toBeLessThanOrEqual(100);
  });

  it("命令 4（executor）：七彩虹實盤執行器在下單前使用同源風控與真實保證金", () => {
    const executorPath = path.resolve(__dirname, "services/executor.ts");
    const src = fs.readFileSync(executorPath, "utf-8");

    expect(src).toContain("evaluateRainbow20415Management");
    expect(src).toContain("20415 執行前風控取消加倉");
    expect(src).toContain("20415 缺少交易所真實已用保證金，安全封鎖加倉");
    expect(src).toContain("所有狀態轉移都發生在交易所成功回報之後");
  });

  it("命令 6（schema）：strategySchemas.ts 只公開真實七彩虹標量欄位", () => {
    const schemaPath = path.resolve(__dirname, "config/strategySchemas.ts");
    const src = fs.readFileSync(schemaPath, "utf-8");

    expect(src).toContain("Entry_Timeframe_Minutes");
    expect(src).toContain("Management_Interval_Minutes");
    expect(src).toContain("Take_Profit_Pct");
    expect(src).toContain("Max_Hold_Hours");
    expect(src).toContain("Max_Margin_Usage_Pct");
    expect(src).toContain("Max_Account_Loss_Pct");
    expect(src).toContain("Reentry_Cooldown_Minutes");
  });
});
