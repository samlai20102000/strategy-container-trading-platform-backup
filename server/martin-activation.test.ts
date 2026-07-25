/**
 * 通用馬丁基礎設施與 20415 七彩虹執行邊界驗證
 * 確認通用回測引擎及七彩虹專用管線的核心邏輯正確
 */
import { describe, it, expect } from "vitest";

describe("馬丁基礎設施與 20415 七彩虹核心修正驗證", () => {
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

  it("5. 七彩虹實盤執行器：封印內部決策並在盲人模式拒絕反向指令", async () => {
    const fs = await import("fs");
    const executorCode = fs.readFileSync(
      "./server/services/executor.ts",
      "utf-8"
    );
    
    expect(executorCode).toContain("rainbow20415Decision?: boolean");
    expect(executorCode).toContain("20415 盲人模式拒絕反向指令");
    expect(executorCode).toContain("20415 已有持倉，禁止重複底倉");
    expect(executorCode).toContain("所有狀態轉移都發生在交易所成功回報之後");
    expect(executorCode).not.toContain("等待 DollarAmount 止盈或止損觸發");
  });

  it("6. Strategy20415 defaultConfig 參數完整性", async () => {
    const { getStrategy, initStrategyStudio: init } = await import("./services/strategyStudio");
    init();
    const strategy = getStrategy("strategy_20415");
    expect(strategy).not.toBeNull();
    
    const config = strategy!.defaultConfig;
    expect(config.Config_Version).toBe("rainbow20415.v1");
    expect(config.Entry_Timeframe_Minutes).toBe(30);
    expect(config.Management_Interval_Minutes).toBe(1);
    expect(config.Lines).toHaveLength(7);
    expect(config.Martin_Ranges.length).toBeGreaterThan(0);
    expect(config.Take_Profit_Pct).toBe(0.2);
    expect(config.Max_Hold_Hours).toBe(48);
    expect(config.Max_Margin_Usage_Pct).toBe(70);
    expect(config.Max_Account_Loss_Pct).toBe(5);
    expect(config.Base_Lot_Size).toBeDefined();

    const finalLayer = Math.max(...config.Martin_Ranges.map((range: { endLayer: number }) => range.endLayer));
    expect(finalLayer).toBeGreaterThan(0);
    expect(finalLayer).toBeLessThanOrEqual(200);
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
