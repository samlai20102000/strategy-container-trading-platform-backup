/**
 * V4.2 策略註冊中心整合測試
 * 驗證 RegistryManager + registry 路由端點 + 前端組件數據源一致性
 */
import { describe, it, expect, beforeAll } from "vitest";
import { registryManager } from "./services/registryManager";
import { initStrategyStudio, listRegisteredStrategies } from "./services/strategyStudio";
import { getBacktestStrategyCatalog } from "./services/backtest/backtestStrategyCatalog";

describe("V4.2 RegistryManager", () => {
  beforeAll(async () => {
    await initStrategyStudio();
  });

  describe("getStrategyDefinitions", () => {
    it("應返回至少一個策略定義", async () => {
      const defs = await registryManager.getStrategyDefinitions();
      expect(defs.length).toBeGreaterThan(0);
    });

    it("應包含內建策略 20415_KAMA_MARTIN_V35", async () => {
      const defs = await registryManager.getStrategyDefinitions();
      const kama = defs.find((d) => d.key === "20415_KAMA_MARTIN_V35");
      expect(kama).toBeDefined();
      expect(kama!.isBuiltIn).toBe(true);
      expect(kama!.loaded).toBe(true);
      expect(kama!.name).toContain("KAMA");
    });

    it("每個定義應有 key/name/defaultConfig", async () => {
      const defs = await registryManager.getStrategyDefinitions();
      for (const d of defs) {
        expect(d.key).toBeTruthy();
        expect(d.name).toBeTruthy();
        expect(d.defaultConfig).toBeDefined();
        expect(d.capabilityManifest.strategyKey).toBe(d.key);
        expect(d.capabilityManifest.strategyVersion).toBe(d.version);
        expect(d.modeCapabilities).toEqual(d.capabilityManifest.capabilities);
        expect(d.backtestModeCapabilities).toEqual(d.backtestCapabilityManifest.capabilities);
        expect(d.simulationModeCapabilities).toEqual(d.simulationCapabilityManifest.capabilities);
        expect(d.liveModeCapabilities).toEqual(d.liveCapabilityManifest.capabilities);
        expect(d.capabilityManifest).toEqual(d.liveCapabilityManifest);
        expect(d.modeCapabilities).toEqual(d.liveModeCapabilities);
      }
    });

    it("已認證 advanced KAMA 明確公開 S1／M2／H3 與逐腿能力", async () => {
      const defs = await registryManager.getStrategyDefinitions();
      const kama = defs.find((d) => d.key === "20415_KAMA_MARTIN_V35");

      expect(kama?.capabilityManifest.certification).toBe("CERTIFIED");
      expect(kama?.modeCapabilities.supportedModes).toEqual([
        "SINGLE_EXCLUSIVE",
        "MULTI_POSITION",
        "HEDGE_GUARDED",
      ]);
      expect(kama?.modeCapabilities).toMatchObject({
        independentLegState: true,
        preciseLegClose: true,
        hedgeGuard: true,
      });
    });

    it("未完成 advanced 認證的策略 fail closed 為 S1-only", async () => {
      const defs = await registryManager.getStrategyDefinitions();
      const legacy = defs.find((d) => d.key === "strategy_20415");

      expect(legacy?.capabilityManifest.certification).toBe("CERTIFIED");
      expect(legacy?.modeCapabilities.supportedModes).toEqual(["SINGLE_EXCLUSIVE"]);
      expect(legacy?.modeCapabilities).toMatchObject({
        independentLegState: false,
        preciseLegClose: false,
        hedgeGuard: false,
      });
    });

    it("V4.1 回測公開 S1／M2／H3，但模擬與實盤仍 fail closed 為 S1", async () => {
      const defs = await registryManager.getStrategyDefinitions();
      const v41 = defs.find((d) => d.key === "20415_KAMA_MARTIN_V41");

      expect(v41?.backtestModeCapabilities.supportedModes).toEqual([
        "SINGLE_EXCLUSIVE",
        "MULTI_POSITION",
        "HEDGE_GUARDED",
      ]);
      expect(v41?.backtestModeCapabilities).toMatchObject({
        independentLegState: true,
        preciseLegClose: true,
        hedgeGuard: true,
      });
      expect(v41?.simulationModeCapabilities.supportedModes).toEqual(["SINGLE_EXCLUSIVE"]);
      expect(v41?.liveModeCapabilities.supportedModes).toEqual(["SINGLE_EXCLUSIVE"]);
    });

    it("內建策略的 defaultConfig 應包含 V4.0 固定金本位參數", async () => {
      const defs = await registryManager.getStrategyDefinitions();
      const kama = defs.find((d) => d.key === "20415_KAMA_MARTIN_V35");
      expect(kama).toBeDefined();
      const cfg = kama!.defaultConfig;
      expect(cfg.Initial_Capital).toBe(10000);
      expect(cfg.Base_Lot_Size).toBe(30);
      expect(cfg.Martin_Step_Pct).toBe(2.0);
      expect(cfg.Target_TP_Pct).toBe(1.0);
      expect(cfg.Callback_Pct).toBe(0.1);
      expect(cfg.Max_Loss_Pct).toBe(5.0);
    });
  });

  describe("getStrategyDefinition (單個)", () => {
    it("應返回指定 key 的策略定義", async () => {
      const def = await registryManager.getStrategyDefinition("20415_KAMA_MARTIN_V35");
      expect(def).not.toBeNull();
      expect(def!.key).toBe("20415_KAMA_MARTIN_V35");
    });

    it("不存在的 key 應返回 null", async () => {
      const def = await registryManager.getStrategyDefinition("nonexistent_key_xyz");
      expect(def).toBeNull();
    });
  });

  describe("getStrategySchema", () => {
    it("應返回策略的參數結構（schemaConfig 或 defaultConfig）", async () => {
      const schema = await registryManager.getStrategySchema("20415_KAMA_MARTIN_V35");
      expect(schema).not.toBeNull();
      // 至少包含核心參數
      expect(schema).toHaveProperty("Initial_Capital");
    });
  });

  describe("getStrategyDefaults", () => {
    it("應返回策略的預設參數", async () => {
      const defaults = await registryManager.getStrategyDefaults("20415_KAMA_MARTIN_V35");
      expect(defaults).not.toBeNull();
      expect(defaults!.Initial_Capital).toBe(10000);
      expect(defaults!.Base_Lot_Size).toBe(30);
    });
  });

  describe("clearCache", () => {
    it("清除快取後重新查詢應正常", async () => {
      registryManager.clearCache();
      const defs = await registryManager.getStrategyDefinitions();
      expect(defs.length).toBeGreaterThan(0);
    });
  });

  describe("與 strategyStudio 一致性", () => {
    it("registry 列表應包含所有 strategyStudio 記憶體中的策略", async () => {
      const registered = listRegisteredStrategies();
      const defs = await registryManager.getStrategyDefinitions();

      for (const reg of registered) {
        const found = defs.find((d) => d.key === reg.key);
        expect(found).toBeDefined();
        expect(found!.name).toBe(reg.name);
        expect(found!.isBuiltIn).toBe(reg.isBuiltIn);
      }
    });
  });
});

describe("V4.2 前端數據源一致性驗證", () => {
  it("registry.listDefinitions 與 backtest.getStrategies 應返回相同策略及 BACKTEST capability", async () => {
    // 模擬前端邏輯：registry 數據源 vs backtest 數據源
    const registryDefs = await registryManager.getStrategyDefinitions();
    const backtestCatalog = await getBacktestStrategyCatalog();

    // 兩者應包含相同的 key 集合
    const registryKeys = new Set(registryDefs.map((d) => d.key));
    const backtestKeys = new Set(backtestCatalog.map((s) => s.key));

    for (const key of backtestKeys) {
      expect(registryKeys.has(key)).toBe(true);
      const primary = registryDefs.find(item => item.key === key)!;
      const fallback = backtestCatalog.find(item => item.key === key)!;
      expect(fallback.backtestModeCapabilities).toEqual(primary.backtestModeCapabilities);
      expect(fallback.backtestCapabilityManifest).toEqual(primary.backtestCapabilityManifest);
    }

    const v41 = backtestCatalog.find(item => item.key === "20415_KAMA_MARTIN_V41");
    expect(v41?.backtestModeCapabilities.supportedModes).toEqual([
      "SINGLE_EXCLUSIVE",
      "MULTI_POSITION",
      "HEDGE_GUARDED",
    ]);
  });
});
