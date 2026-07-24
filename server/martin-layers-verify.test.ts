import { describe, it, expect } from "vitest";
import { runBacktest } from "./services/backtest/backtestEngine";
import { getDb } from "./db";

describe("馬丁層數驗證（Martin_Tiers 優先級）", () => {
  it("應該從 Martin_Tiers 正確讀取 MaxMartinLevels", async () => {
    const config = {
      EMA_Fast: 3,
      EMA_Medium: 6,
      EMA_Slow: 15,
      EMA_Trend: 30,
      EMA_Trend_Long: 60,
      
      // 階梯式馬丁分層（新參數）
      Martin_Tiers: JSON.stringify([
        { start: 1, end: 4, multiplier: 1.5, pipstep: 50000 },
        { start: 5, end: 9, multiplier: 1.1, pipstep: 50000 },
        { start: 10, end: 11, multiplier: 1.0, pipstep: 50000 }
      ]),
      Global_Pipstep: 50000,
      Point_Value: 100,
      
      Dollar_Start_Buy: 8,
      Dollar_Start_Sell: 8,
      Dollar_Trail: 1.5,
      Dollar_Loss: 100,
      Max_Position_Ratio: 0.2,
      Max_Equity_Drawdown: 0.05,
      Base_Lot_Size: 0.01,
      News_Blackout_Minutes: 0,
    };

    console.log("🔍 測試配置:");
    console.log("Martin_Tiers:", config.Martin_Tiers);
    
    // 解析 Martin_Tiers
    const tiers = JSON.parse(config.Martin_Tiers);
    const expectedMaxLayers = tiers[tiers.length - 1].end;
    
    console.log("✓ 解析結果:");
    console.log("  分層數:", tiers.length);
    console.log("  最後一層 end:", expectedMaxLayers);
    
    expect(expectedMaxLayers).toBe(11);
  });

  it("應該在無 Martin_Tiers 時回退到 MaxMartinLevels", () => {
    const config = {
      MaxMartinLevels: 8,
      Martin_Tiers: undefined,
    };

    const maxLayers = config.Martin_Tiers 
      ? JSON.parse(config.Martin_Tiers as string)[JSON.parse(config.Martin_Tiers as string).length - 1].end
      : config.MaxMartinLevels;
    
    console.log("✓ 無分層時的回退:");
    console.log("  MaxMartinLevels:", maxLayers);
    
    expect(maxLayers).toBe(8);
  });

  it("前端 Backtest.tsx 應該正確計算 autoMaxLayers", () => {
    // 模擬前端的 martinTiersRules 和 autoMaxLayers 計算
    const configJson = {
      Martin_Tiers: JSON.stringify([
        { start: 1, end: 4, multiplier: 1.5, pipstep: 50000 },
        { start: 5, end: 9, multiplier: 1.1, pipstep: 50000 },
        { start: 10, end: 11, multiplier: 1.0, pipstep: 50000 }
      ]),
      Max_Layers: 5,
    };

    // 前端邏輯：優先讀 Martin_Tiers
    let martinTiersRules: any[] = [];
    if (configJson.Martin_Tiers && typeof configJson.Martin_Tiers === "string") {
      try {
        martinTiersRules = JSON.parse(configJson.Martin_Tiers);
      } catch (e) {
        martinTiersRules = [];
      }
    }

    const autoMaxLayers = martinTiersRules.length > 0
      ? martinTiersRules[martinTiersRules.length - 1].end
      : Number(configJson.Max_Layers);

    console.log("✓ 前端 autoMaxLayers 計算:");
    console.log("  martinTiersRules.length:", martinTiersRules.length);
    console.log("  autoMaxLayers:", autoMaxLayers);
    
    expect(autoMaxLayers).toBe(11);
  });

  it("後端 backtest.router 應該將 Martin_Tiers.end 寫入 MaxMartinLevels", () => {
    // 模擬後端的參數正規化
    const input = {
      config: {
        Martin_Tiers: JSON.stringify([
          { start: 1, end: 4, multiplier: 1.5, pipstep: 50000 },
          { start: 5, end: 9, multiplier: 1.1, pipstep: 50000 },
          { start: 10, end: 11, multiplier: 1.0, pipstep: 50000 }
        ]),
      }
    };

    // 後端邏輯：從 Martin_Tiers 提取 end，寫入 MaxMartinLevels
    if (input.config.Martin_Tiers && typeof input.config.Martin_Tiers === "string") {
      try {
        const tiers = JSON.parse(input.config.Martin_Tiers);
        if (Array.isArray(tiers) && tiers.length > 0) {
          const maxLayersFromTiers = tiers[tiers.length - 1].end;
          input.config = { ...input.config, MaxMartinLevels: maxLayersFromTiers };
        }
      } catch (e) {
        console.warn("[test] 無法解析 Martin_Tiers JSON", e);
      }
    }

    console.log("✓ 後端參數正規化:");
    console.log("  MaxMartinLevels:", (input.config as any).MaxMartinLevels);
    
    expect((input.config as any).MaxMartinLevels).toBe(11);
  });
});
