/**
 * EMA 馬丁核心修正驗證
 * 確認回測引擎和策略引擎的核心邏輯正確
 */
import { describe, it, expect } from "vitest";

describe("EMA 馬丁核心修正驗證", () => {
  it("1. 回測引擎主迴圈中不存在 checkReverse 方向轉換", async () => {
    const fs = await import("fs");
    const engineCode = fs.readFileSync(
      "./server/services/backtest/backtestEngine.ts",
      "utf-8"
    );
    const genericStart = engineCode.indexOf("private runGenericBacktest");
    const mainLoopCode = engineCode.slice(genericStart);

    // 確認沒有 checkReverse 的調用
    expect(mainLoopCode).not.toContain("checkReverse(");
    // 確認沒有 reverseTimer
    expect(mainLoopCode).not.toContain("reverseTimer");
  });

  it("2. checkGridAdd 函數存在且使用 maxMartinLevels 限制", async () => {
    const fs = await import("fs");
    const engineCode = fs.readFileSync(
      "./server/services/backtest/backtestEngine.ts",
      "utf-8"
    );
    
    // 確認 checkGridAdd 函數存在（新簽名帶 idx 參數）
    expect(engineCode).toContain("const checkGridAdd = (price: number, idx: number): boolean =>");
    // 確認使用 maxMartinLevels 做層數限制
    expect(engineCode).toContain("if (layerCount >= maxMartinLevels) return false");
    // 確認有 price 與 lastPrice 的比較邏輯（pipstep 間距）
    expect(engineCode).toContain("lastPrice - step");
    expect(engineCode).toContain("lastPrice + step");
  });

  it("3. maxMartinLevels 從 config 動態讀取，無硬編碼", async () => {
    const fs = await import("fs");
    const engineCode = fs.readFileSync(
      "./server/services/backtest/backtestEngine.ts",
      "utf-8"
    );
    
    // 確認 maxMartinLevels 從 config 動態讀取（新策略用 max_layers）
    expect(engineCode).toContain("maxMartinLevels");
    // 確認沒有 maxMartinLevels = 5 的硬編碼
    expect(engineCode).not.toMatch(/maxMartinLevels\s*=\s*5/);
  });

  it("4. 止盈條件為追蹤止盈（checkTakeProfit 使用金額）", async () => {
    const fs = await import("fs");
    const engineCode = fs.readFileSync(
      "./server/services/backtest/backtestEngine.ts",
      "utf-8"
    );
    
    // 確認 checkTakeProfit 存在
    expect(engineCode).toContain("checkTakeProfit");
    // 確認止盈是金額比較（totalProfit >= target）
    expect(engineCode).toContain("if (totalProfit >= target)");
    // 確認有追踪止盈邏輯（peakProfit 回撤）
    expect(engineCode).toContain("peakProfit - totalProfit >= trail");
  });

  it("5. 實盤執行器：收到反向信號時直接忽略（不平倉、不轉向）", async () => {
    const fs = await import("fs");
    const executorCode = fs.readFileSync(
      "./server/services/executor.ts",
      "utf-8"
    );
    
    // 確認有方向轉換攔截
    expect(executorCode).toContain("已停用方向轉換");
    // 確認反向信號直接返回 skipped
    expect(executorCode).toContain("等待 DollarAmount 止盈或止損觸發");
    // 確認沒有 closePos + 開反向倉的邏輯
    expect(executorCode).not.toContain("浮盈保護觸發");
    expect(executorCode).not.toContain("反轉計時器生效中");
  });

  it("6. Strategy20415 defaultConfig 參數完整性", async () => {
    const { getStrategy, initStrategyStudio: init } = await import("./services/strategyStudio");
    init();
    const strategy = getStrategy("strategy_20415");
    expect(strategy).not.toBeNull();
    
    const config = strategy!.defaultConfig;
    // 確認新 EMA 馬丁關鍵參數存在
    expect(config.ema_killer).toBeDefined();
    expect(config.ema_wave).toBeDefined();
    expect(config.ema_enter).toBeDefined();
    expect(config.multiplier).toBeDefined();
    expect(config.max_layers).toBeDefined();
    expect(config.pip_step_base).toBeDefined();
    expect(config.tp_normal).toBeDefined();
    expect(config.tp_trend).toBeDefined();
    expect(config.trail_normal).toBeDefined();
    expect(config.trail_trend).toBeDefined();
    expect(config.hard_stop_max).toBeDefined();
    expect(config.hard_stop_atr_multiplier).toBeDefined();
    expect(config.Point_Value).toBeDefined();
    expect(config.Base_Lot_Size).toBeDefined();
    
    // 確認 max_layers 是合理的數字
    expect(Number(config.max_layers)).toBeGreaterThan(0);
    expect(Number(config.max_layers)).toBeLessThanOrEqual(50);
  });

  it("7. 回測引擎主迴圈中 addMartinLayer 被正確調用", async () => {
    const fs = await import("fs");
    const engineCode = fs.readFileSync(
      "./server/services/backtest/backtestEngine.ts",
      "utf-8"
    );
    const genericStart = engineCode.indexOf("private runGenericBacktest");
    const mainLoopCode = engineCode.slice(genericStart);

    // 確認有加倉邏輯
    expect(mainLoopCode).toContain("addMartinLayer");
    // 確認加倉使用 calculateTierLot
    expect(mainLoopCode).toContain("calculateTierLot");
  });
});
