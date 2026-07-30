import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideCloseSplit } from "./kamaReversalGuard";

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

const levelZeroTrendExit = {
  martinDepth: 0,
  exitReason: "trailing_stop",
  entryTrendBull: true,
  currentKamaFast: 105,
  currentKamaSlow: 100,
  kLinePeriod: 5,
} as const;

describe("V4.0 特殊原地重入契約", () => {
  it("啟用時允許第 0 層順勢止盈後原地重入", () => {
    expect(decideCloseSplit({
      ...levelZeroTrendExit,
      reentryEnabled: true,
    })).toMatchObject({ action: "reenter", cooldownMs: 0 });
  });

  it("停用時禁止第 0 層原地重入", () => {
    const decision = decideCloseSplit({
      ...levelZeroTrendExit,
      reentryEnabled: false,
    });

    expect(decision.action).toBe("none");
    expect(decision.reason).toContain("順勢重入未啟用");
  });

  it("停用原地重入不會取消有馬丁部位的懲罰冷卻", () => {
    expect(decideCloseSplit({
      ...levelZeroTrendExit,
      martinDepth: 1,
      reentryEnabled: false,
    })).toMatchObject({ action: "cooldown", cooldownMs: 600_000 });
  });
});

describe("V4.0 live／Webhook／回測安全鏈契約", () => {
  it("自動分析只在同源 gate 通過後附加內部驗證證據", () => {
    const source = readSource("server/services/autoTradeSignalGenerator.ts");

    expect(source).toContain("evaluateV40EntryGates");
    expect(source).toContain("v40Gate?.passed");
    expect(source).toContain("v40EntryGateValidated: true as const");
    expect(source).toContain("v40EntryGateDirection: v40Gate.direction!");
    expect(source).toContain("v40EntryGateBarTimestamp: gateBarTimestamp");
  });

  it("executor 僅信任方向與 K 線時間完全相符的內部證據，否則 raw Webhook 重驗且失敗時關閉", () => {
    const source = readSource("server/services/executor.ts");

    expect(source).toContain("signal.v40EntryGateValidated === true");
    expect(source).toContain("signal.v40EntryGateDirection === requestedDirection");
    expect(source).toContain("signal.v40EntryGateBarTimestamp === signal.barTimestamp");
    expect(source).toContain("const gate = evaluateV40EntryGates({");
    expect(source).toContain("V4.0 入場安全閘行情取得失敗（fail-closed）");
    expect(source).toContain('const isInitialEntry = engineSignal.action !== "CLOSE"');
  });

  it("回測與 live 原地重入共用同一 V4.0 設定值", () => {
    const backtest = readSource("server/services/backtest/backtestEngine.ts");
    const monitor = readSource("server/services/v35Monitor.ts");

    expect(backtest).toContain("request.strategyKey === V40_STRATEGY_KEY");
    expect(backtest).toContain("v40EntryGateConfig.enableSameDirectionReentry");
    expect(backtest).toContain("const gate = evaluateV40EntryGates({");
    expect(backtest).toContain("reentryBox.req = null");
    expect(monitor).toContain("reentryEnabled: cfg.enableSameDirectionReentry");
  });
});

describe("V4.0 策略隔離契約", () => {
  it("V5、V6.1、V7、原 20415 與七彩虹核心不引用 V4.0 新 gate", () => {
    const isolatedStrategySources = [
      "server/strategies/v50/strategy_kama_3k_v50.ts",
      "server/strategies/v61/strategy_kama_3k_v61.ts",
      "server/strategies/v70/strategy_kama_3k_v70.ts",
      "server/strategies/builtin/strategy20415.ts",
      "server/strategies/builtin/strategyRainbowTrendLadder.ts",
    ].map(readSource);

    for (const source of isolatedStrategySources) {
      expect(source).not.toContain("evaluateV40EntryGates");
      expect(source).not.toContain("enableThreeKFilter");
      expect(source).not.toContain("threeKPatternMode");
      expect(source).not.toContain("enableSameDirectionReentry");
    }
  });
});
