import { describe, expect, it } from "vitest";
import {
  assertExplicitKamaRainbowMartinConfig,
  createKamaRainbowMartinDefaultConfig,
  createKamaRainbowMartinLineSetReceipt,
  type KamaRainbowMartinConfig,
} from "../shared/strategies/kamaRainbowMartin";

function createLineConfig(lineCount = 6, disabledIndexes: readonly number[] = [3]): KamaRainbowMartinConfig {
  const config = createKamaRainbowMartinDefaultConfig();
  config.kamaLines = Array.from({ length: lineCount }, (_, index) => ({
    id: `KAMA_${index + 1}`,
    name: `KAMA ${10 + index * 10}`,
    enabled: !disabledIndexes.includes(index),
    erPeriod: 10 + index * 10,
    fastEma: 2,
    slowEma: 30,
    color: `#${(index + 1).toString(16).padStart(6, "0")}`,
  }));
  return config;
}

describe("KRM line-set receipt", () => {
  it("記錄完整六線集合、啟用 ID、版本、來源及 deterministic hashes", () => {
    const config = createLineConfig();
    const first = createKamaRainbowMartinLineSetReceipt(config, "backtest-input");
    const second = createKamaRainbowMartinLineSetReceipt(
      JSON.parse(JSON.stringify(config)),
      "snapshot",
    );

    expect(first).toMatchObject({
      schemaVersion: "krm-line-set-receipt.v1",
      source: "backtest-input",
      inputVersion: "kamaRainbowMartin.v2",
      configVersion: "kamaRainbowMartin.v2",
      migrated: false,
      totalLineCount: 6,
      enabledLineCount: 5,
      enabledLineIds: ["KAMA_1", "KAMA_2", "KAMA_3", "KAMA_5", "KAMA_6"],
      entrySemantics: "ALL_ENABLED_SAME_SLOPE_WITH_PAIR_LOCK",
    });
    expect(first.lineSetHash).toMatch(/^krm-lines-[0-9a-f]{8}$/);
    expect(first.configHash).toMatch(/^krm-config-[0-9a-f]{8}$/);
    expect(second.lineSetHash).toBe(first.lineSetHash);
    expect(second.configHash).toBe(first.configHash);
  });

  it("線參數變更會改變 line-set 與 config hash，非線參數只改 config hash", () => {
    const config = createLineConfig();
    const baseline = createKamaRainbowMartinLineSetReceipt(config, "strategy-binding");

    const lineChanged = createLineConfig();
    lineChanged.kamaLines[5].erPeriod = 99;
    const lineReceipt = createKamaRainbowMartinLineSetReceipt(lineChanged, "strategy-binding");
    expect(lineReceipt.lineSetHash).not.toBe(baseline.lineSetHash);
    expect(lineReceipt.configHash).not.toBe(baseline.configHash);

    const nonLineChanged = createLineConfig();
    nonLineChanged.reentryEnabled = true;
    const configReceipt = createKamaRainbowMartinLineSetReceipt(nonLineChanged, "strategy-binding");
    expect(configReceipt.lineSetHash).toBe(baseline.lineSetHash);
    expect(configReceipt.configHash).not.toBe(baseline.configHash);
  });

  it.each([2, 3, 6, 32])("%i 條 KAMA 經 explicit 驗證與 JSON round-trip 後完整保留", (lineCount) => {
    const config = createLineConfig(lineCount, []);
    const restored = assertExplicitKamaRainbowMartinConfig(JSON.parse(JSON.stringify(config)));
    const before = createKamaRainbowMartinLineSetReceipt(config, "backtest-input");
    const after = createKamaRainbowMartinLineSetReceipt(restored, "snapshot");

    expect(restored.kamaLines).toHaveLength(lineCount);
    expect(restored.kamaLines.map(line => line.id)).toEqual(config.kamaLines.map(line => line.id));
    expect(after).toMatchObject({
      totalLineCount: lineCount,
      enabledLineCount: lineCount,
      enabledLineIds: config.kamaLines.map(line => line.id),
    });
    expect(after.lineSetHash).toBe(before.lineSetHash);
    expect(after.configHash).toBe(before.configHash);
  });

  it("32 條是合法上限，33 條會在 execution contract fail-closed", () => {
    expect(() => assertExplicitKamaRainbowMartinConfig(createLineConfig(32, []))).not.toThrow();
    expect(() => assertExplicitKamaRainbowMartinConfig(createLineConfig(33, []))).toThrow(/2 至 32 條/);
  });
});
