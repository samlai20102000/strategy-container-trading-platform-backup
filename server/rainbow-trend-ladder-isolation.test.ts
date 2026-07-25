import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RAINBOW_20415_CONFIG_VERSION,
  RAINBOW_20415_STRATEGY_KEY,
  createRainbow20415DefaultConfig,
} from "../shared/strategies/rainbow20415";
import {
  RAINBOW_TREND_LADDER_CONFIG_VERSION,
  RAINBOW_TREND_LADDER_STRATEGY_KEY,
  createRainbowTrendLadderDefaultConfig,
} from "../shared/strategies/rainbowTrendLadder";
import { Strategy20415 } from "./strategies/builtin/strategy20415";
import { StrategyRainbowTrendLadder } from "./strategies/builtin/strategyRainbowTrendLadder";

const ORIGINAL_20415_HASHES: Record<string, string> = {
  "client/src/components/Rainbow20415ConfigPanel.tsx": "9c745603078cad68f94d2612113ba51a7e31b6ae3f06f142b5133c89f8ed4bb9",
  "server/rainbow20415-config.test.ts": "efaa8347c238ba4fa55aa2bd7a7986fc5ad713b3e01d3a50624c42149cfdd4d0",
  "server/rainbow20415-core.test.ts": "67a21f5753ec13785a24f9ede227f24a85415dd5c9fb1e3e46a078e51d82b871",
  "server/strategies/builtin/strategy20415.ts": "25004d029e97b6ab742594ac146c474633ae2235bfd0a8b73292b6244637eea2",
  "server/strategies/rainbow20415/core.ts": "245ef4c48a2423e0b4044bab45afb990e3c322e98dd1d79b204cf9eeb749d650",
  "shared/strategies/rainbow20415.ts": "84e5cb8aeb4024b3bf4f309e060b85eb1e31b70e899a4abfef65105a8bc664ca",
};

function sha256(relativePath: string): string {
  return createHash("sha256").update(readFileSync(resolve(process.cwd(), relativePath))).digest("hex");
}

describe("20415 不變性與新策略隔離", () => {
  it("20415 六個專屬檔案與建置前不可變基線逐位元一致", () => {
    for (const [relativePath, expectedHash] of Object.entries(ORIGINAL_20415_HASHES)) {
      expect(sha256(relativePath), relativePath).toBe(expectedHash);
    }
  });

  it("20415 原 key、版本、預設值與類別身份保持不變", () => {
    const originalConfig = createRainbow20415DefaultConfig();
    expect(RAINBOW_20415_STRATEGY_KEY).toBe("strategy_20415");
    expect(originalConfig.Config_Version).toBe(RAINBOW_20415_CONFIG_VERSION);
    expect(new Strategy20415().key).toBe(RAINBOW_20415_STRATEGY_KEY);
  });

  it("新策略使用不同 key、版本、設定物件、類別與註冊實例", () => {
    const originalConfig = createRainbow20415DefaultConfig();
    const newConfig = createRainbowTrendLadderDefaultConfig();
    expect(RAINBOW_TREND_LADDER_STRATEGY_KEY).not.toBe(RAINBOW_20415_STRATEGY_KEY);
    expect(RAINBOW_TREND_LADDER_CONFIG_VERSION).not.toBe(RAINBOW_20415_CONFIG_VERSION);
    expect(newConfig).not.toBe(originalConfig);
    expect(new StrategyRainbowTrendLadder().key).toBe(RAINBOW_TREND_LADDER_STRATEGY_KEY);
    const registrySource = readFileSync(resolve(process.cwd(), "server/services/strategyStudio.ts"), "utf8");
    expect(registrySource).toContain("register(new Strategy20415())");
    expect(registrySource).toContain("register(new StrategyRainbowTrendLadder())");
  });

  it("新策略純核心與管理模組不引用 20415 程式或狀態鍵", () => {
    for (const relativePath of [
      "shared/strategies/rainbowTrendLadder.ts",
      "server/strategies/rainbowTrendLadder/core.ts",
      "server/strategies/rainbowTrendLadder/management.ts",
      "server/strategies/builtin/strategyRainbowTrendLadder.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      expect(source, relativePath).not.toContain("rainbow20415");
      expect(source, relativePath).not.toContain("__v2_0Config");
    }
  });

  it("中央執行器保留 20415 原路徑並以新 key 分派至不同函式", () => {
    const source = readFileSync(resolve(process.cwd(), "server/services/executor.ts"), "utf8");
    expect(source).toContain("executeSignalRainbow20415(strategy, signal, signalId, engine, adapter)");
    expect(source).toContain("executeSignalRainbowTrendLadder(strategy, signal, signalId, adapter)");
    expect(source).toContain("strategy.strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY");
  });

  it("新策略設定面板約束自身寬度，寬表只在專屬區塊內水平捲動", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/components/RainbowTrendLadderConfigPanel.tsx"),
      "utf8",
    );
    expect(source).toContain("relative w-full min-w-0 max-w-full [contain:inline-size] overflow-hidden");
    expect(source).toContain('data-testid="rtl-lines-scroll"');
    expect(source).toContain('data-testid="rtl-layers-scroll"');
    expect(source.match(/w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain/g)).toHaveLength(2);
    expect(source).toContain('aria-label="七線 SMA 設定表，可水平捲動"');
    expect(source).toContain('aria-label="八層階梯馬丁設定表，可水平捲動"');
  });
});
