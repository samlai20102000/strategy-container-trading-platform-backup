/**
 * 倉位大小雙模式系統測試
 * 驗收標準：
 * 1. USDT 模式：輸入 10 USDT，根據當前 BTC 價格自動換算為數量
 * 2. 數量模式：輸入 0.001 BTC，直接使用該數量
 * 3. 馬丁加倉：每層根據當前價格動態換算，確保金額 = 上一層 × 1.5 倍
 * 4. 切換模式：輸入框 placeholder 和說明文字隨模式變更
 */

import { describe, it, expect } from "vitest";
import { strategyKama3kV35 } from "./strategies/v35/strategy_kama_3k_v35";
import { StrategyKama3kV50 } from "./strategies/v50/strategy_kama_3k_v50";

describe("倉位大小雙模式系統", () => {
  describe("calculateLotSize - 首單倉位計算", () => {
    it("數量模式：直接返回輸入值", async () => {
      const config = {
        Base_Lot_Size: {
          value: 0.001,
          mode: "quantity",
        },
      };
      const lotSize = await strategyKama3kV35.calculateLotSize(config, 50000);
      expect(lotSize).toBe(0.001);
    });

    it("USDT 模式：根據市價換算為 BTC 數量", async () => {
      const config = {
        Base_Lot_Size: {
          value: 10, // 10 USDT
          mode: "usdt",
        },
      };
      const lotSize = await strategyKama3kV35.calculateLotSize(config, 50000);
      // 10 / 50000 = 0.0002 BTC
      expect(lotSize).toBe(0.0002);
    });

    it("USDT 模式：確保不小於最小下單量 (0.00001)", async () => {
      const config = {
        Base_Lot_Size: {
          value: 0.0001, // 0.0001 USDT（非常小）
          mode: "usdt",
        },
      };
      const lotSize = await strategyKama3kV35.calculateLotSize(config, 50000);
      // 0.0001 / 50000 = 0.000000002，應被提升至 0.00001
      expect(lotSize).toBeGreaterThanOrEqual(0.00001);
    });

    it("向後相容：舊格式直接使用數值", async () => {
      const config = {
        Base_Lot_Size: 0.01, // 舊格式：直接是數值
      };
      const lotSize = await strategyKama3kV35.calculateLotSize(config, 50000);
      expect(lotSize).toBe(0.01);
    });

    it("USDT 模式：無效市價應拋出錯誤", async () => {
      const config = {
        Base_Lot_Size: {
          value: 10,
          mode: "usdt",
        },
      };
      await expect(
        strategyKama3kV35.calculateLotSize(config, 0)
      ).rejects.toThrow("無效的市價");
    });
  });

  describe("calculateMartingaleLotSize - 馬丁加倉計算", () => {
    it("第 0 層（首單）：返回基礎倉位", async () => {
      const config = {
        Base_Lot_Size: {
          value: 0.001,
          mode: "quantity",
        },
        Martin_Multiplier: 1.5,
      };
      const lotSize = await strategyKama3kV35.calculateMartingaleLotSize(
        config,
        50000,
        0
      );
      expect(lotSize).toBe(0.001);
    });

    it("第 1 層：返回 baseLot × 1.5", async () => {
      const config = {
        Base_Lot_Size: {
          value: 0.001,
          mode: "quantity",
        },
        Martin_Multiplier: 1.5,
      };
      const lotSize = await strategyKama3kV35.calculateMartingaleLotSize(
        config,
        50000,
        1
      );
      // 0.001 × 1.5 = 0.0015
      expect(lotSize).toBe(0.0015);
    });

    it("第 2 層：返回 baseLot × 1.5^2", async () => {
      const config = {
        Base_Lot_Size: {
          value: 0.001,
          mode: "quantity",
        },
        Martin_Multiplier: 1.5,
      };
      const lotSize = await strategyKama3kV35.calculateMartingaleLotSize(
        config,
        50000,
        2
      );
      // 0.001 × 1.5^2 = 0.001 × 2.25 = 0.00225
      expect(lotSize).toBe(0.00225);
    });

    it("USDT 模式馬丁加倉：每層金額 = 上一層 × 1.5", async () => {
      const config = {
        Base_Lot_Size: {
          value: 100, // 100 USDT
          mode: "usdt",
        },
        Martin_Multiplier: 1.5,
      };

      // 第 0 層：100 USDT / 50000 = 0.002 BTC
      const layer0 = await strategyKama3kV35.calculateMartingaleLotSize(
        config,
        50000,
        0
      );
      expect(layer0).toBe(0.002);

      // 第 1 層：150 USDT / 50000 = 0.003 BTC
      const layer1 = await strategyKama3kV35.calculateMartingaleLotSize(
        config,
        50000,
        1
      );
      expect(layer1).toBe(0.003);

      // 驗證金額關係：layer1 金額 = layer0 金額 × 1.5
      const layer0Cost = layer0 * 50000; // 0.002 × 50000 = 100 USDT
      const layer1Cost = layer1 * 50000; // 0.003 × 50000 = 150 USDT
      expect(layer1Cost).toBe(layer0Cost * 1.5);
    });

    it("市價變化時 USDT 模式馬丁加倉的動態調整", async () => {
      const config = {
        Base_Lot_Size: {
          value: 100, // 100 USDT
          mode: "usdt",
        },
        Martin_Multiplier: 1.5,
      };

      // 市價 50000 時
      const layer0At50k = await strategyKama3kV35.calculateMartingaleLotSize(
        config,
        50000,
        0
      );
      expect(layer0At50k).toBe(0.002); // 100 / 50000

      // 市價下跌至 40000 時，同一層應該下更多數量（因為金額不變）
      const layer0At40k = await strategyKama3kV35.calculateMartingaleLotSize(
        config,
        40000,
        0
      );
      expect(layer0At40k).toBe(0.0025); // 100 / 40000

      // 驗證：兩者的成本（USDT）應該相同
      expect(layer0At50k * 50000).toBe(layer0At40k * 40000);
    });
  });

  describe("邊界情況與精度", () => {
    it("極小的 USDT 金額應被提升至最小下單量", async () => {
      const config = {
        Base_Lot_Size: {
          value: 0.001, // 0.001 USDT
          mode: "usdt",
        },
      };
      const lotSize = await strategyKama3kV35.calculateLotSize(config, 50000);
      expect(lotSize).toBeGreaterThanOrEqual(0.00001);
    });

    it("大額 USDT 應正確換算", async () => {
      const config = {
        Base_Lot_Size: {
          value: 10000, // 10000 USDT
          mode: "usdt",
        },
      };
      const lotSize = await strategyKama3kV35.calculateLotSize(config, 50000);
      // 10000 / 50000 = 0.2 BTC
      expect(lotSize).toBe(0.2);
    });

    it("精度保持在 8 位小數", async () => {
      const config = {
        Base_Lot_Size: {
          value: 0.001,
          mode: "quantity",
        },
        Martin_Multiplier: 1.5,
      };
      const lotSize = await strategyKama3kV35.calculateMartingaleLotSize(
        config,
        50000,
        5
      );
      // 驗證精度不超過 8 位小數
      const decimalPlaces = (lotSize.toString().split(".")[1] || "").length;
      expect(decimalPlaces).toBeLessThanOrEqual(8);
    });
  });

  describe("配置相容性", () => {
    it("V3.5 非同步計算以實盤數量覆寫快照百分比控倉", async () => {
      const lotSize = await strategyKama3kV35.calculateLotSize({
        Position_Mode: "quantity",
        Position_Value: 0.003,
        Initial_Capital: 10000,
        First_Order_Pct: 50,
        Base_Lot_Size: 30,
      }, 50000);

      expect(lotSize).toBe(0.003);
    });

    it("V3.5 同步決策同樣以實盤 USDT 覆寫快照百分比控倉", () => {
      const action = strategyKama3kV35.generateActions(
        { action: "BUY", symbol: "BTCUSDT", price: 50000 },
        {
          id: 1,
          symbol: "BTCUSDT",
          direction: "both",
          positionSize: 999,
          leverage: 1,
          config: {
            Position_Mode: "usdt",
            Position_Value: 25,
            Initial_Capital: 10000,
            First_Order_Pct: 50,
            Base_Lot_Size: 30,
          },
        },
        null,
        { lossCount: 0, currentLot: 0, lastEntryPrice: 0 },
      );

      expect(action.action).toBe("OPEN_LONG");
      expect(action.lotSize).toBe(0.0005);
    });

    it("V5.0 也以實盤部署值高於快照百分比控倉", async () => {
      const strategy = new StrategyKama3kV50();
      const lotSize = await strategy.calculateLotSize({
        Position_Mode: "usdt",
        Position_Value: 40,
        Initial_Capital: 10000,
        First_Order_Pct: 50,
        Base_Lot_Size: 30,
      }, 50000);

      expect(lotSize).toBe(0.0008);
    });

    it("支持新格式配置", async () => {
      const config = {
        Base_Lot_Size: {
          value: 0.01,
          mode: "quantity" as const,
        },
      };
      const lotSize = await strategyKama3kV35.calculateLotSize(config, 50000);
      expect(lotSize).toBe(0.01);
    });

    it("支持舊格式配置（向後相容）", async () => {
      const config = {
        Base_Lot_Size: 0.01, // 舊格式
      };
      const lotSize = await strategyKama3kV35.calculateLotSize(config, 50000);
      expect(lotSize).toBe(0.01);
    });

    it("缺失配置應使用默認值", async () => {
      const config = {}; // 空配置
      const lotSize = await strategyKama3kV35.calculateLotSize(config, 50000);
      expect(lotSize).toBe(0.01); // 默認值
    });
  });
});
