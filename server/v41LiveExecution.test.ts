import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createV41DefaultConfig,
  V41_STRATEGY_KEY,
} from "../shared/strategies/kama3kMartinV41";
import { evaluateV41EntryConditions } from "./strategies/v41/entryConditions";
import {
  createV41TrustedEntrySeal,
  verifyV41TrustedEntrySeal,
} from "./services/v41TrustedEntrySeal";

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

const originalJwtSecret = process.env.JWT_SECRET;

function passingEvaluation() {
  return evaluateV41EntryConditions({
    config: { ...createV41DefaultConfig(), enableThreeKFilter: true },
    closedBars: [
      { open: 100, high: 103, low: 99, close: 102, timestamp: 1_000 },
      { open: 102, high: 105, low: 101, close: 104, timestamp: 2_000 },
      { open: 103, high: 107, low: 102, close: 105, timestamp: 3_000 },
    ],
    decisionBarTimestamp: 3_000,
    decisionClose: 105,
    fastKama: 104,
    slowKama: 103,
    allowedDirection: "both",
    requestedDirection: "long",
  });
}

describe("V4.1 HMAC 可信封印", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "v41-test-only-secret";
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it("只為通過 evaluator 的 closed-bar 決策簽章並可完整驗證", () => {
    const evaluation = passingEvaluation();
    const seal = createV41TrustedEntrySeal({
      strategyId: 41,
      action: "buy",
      evaluation,
      issuedAt: 10_000,
    });

    expect(verifyV41TrustedEntrySeal({
      seal,
      strategyId: 41,
      action: "buy",
      barTimestamp: 3_000,
      expectedConfigHash: evaluation.configHash!,
      maxAgeMs: 60_000,
      now: 20_000,
    })).toMatchObject({ valid: true, claims: { strategyKey: V41_STRATEGY_KEY } });
  });

  it("拒絕 payload 竄改、錯 strategy、錯 action、錯 bar 與錯 config hash", () => {
    const evaluation = passingEvaluation();
    const seal = createV41TrustedEntrySeal({ strategyId: 41, action: "buy", evaluation, issuedAt: 10_000 });
    const tampered = {
      ...seal,
      claims: { ...seal.claims, decisionClose: seal.claims.decisionClose + 1 },
    };
    const base = {
      seal,
      strategyId: 41,
      action: "buy" as const,
      barTimestamp: 3_000,
      expectedConfigHash: evaluation.configHash!,
      maxAgeMs: 60_000,
      now: 20_000,
    };

    expect(verifyV41TrustedEntrySeal({ ...base, seal: tampered }).valid).toBe(false);
    expect(verifyV41TrustedEntrySeal({ ...base, strategyId: 42 }).valid).toBe(false);
    expect(verifyV41TrustedEntrySeal({ ...base, action: "sell" }).valid).toBe(false);
    expect(verifyV41TrustedEntrySeal({ ...base, barTimestamp: 4_000 }).valid).toBe(false);
    expect(verifyV41TrustedEntrySeal({ ...base, expectedConfigHash: "stale-config" }).valid).toBe(false);
  });

  it("拒絕過期／未來封印及缺少伺服器密鑰的簽發", () => {
    const evaluation = passingEvaluation();
    const seal = createV41TrustedEntrySeal({ strategyId: 41, action: "buy", evaluation, issuedAt: 10_000 });
    const verifyAt = (now: number) => verifyV41TrustedEntrySeal({
      seal,
      strategyId: 41,
      action: "buy",
      barTimestamp: 3_000,
      expectedConfigHash: evaluation.configHash!,
      maxAgeMs: 60_000,
      now,
    });

    expect(verifyAt(70_001).valid).toBe(false);
    expect(verifyAt(-50_001).valid).toBe(false);
    delete process.env.JWT_SECRET;
    expect(() => createV41TrustedEntrySeal({ strategyId: 41, action: "buy", evaluation }))
      .toThrow("fail-closed");
  });

  it("HOLD 決策與 evaluator 方向不一致時不可建立封印", () => {
    const hold = evaluateV41EntryConditions({
      config: createV41DefaultConfig(),
      closedBars: [],
      decisionBarTimestamp: 3_000,
      decisionClose: 105,
      fastKama: 104,
      slowKama: 103,
      allowedDirection: "both",
    });
    expect(() => createV41TrustedEntrySeal({ strategyId: 41, action: "buy", evaluation: hold }))
      .toThrow("只有通過 canonical evaluator");
    expect(() => createV41TrustedEntrySeal({
      strategyId: 41,
      action: "sell",
      evaluation: passingEvaluation(),
    })).toThrow("方向與 evaluator 決策不一致");
  });
});

describe("V4.1 auto／Raw Webhook／executor／Heartbeat 實盤接線契約", () => {
  it("auto 只用已收盤 100 根 K、單一 evaluator 並在通過後簽發 HMAC 封印", () => {
    const source = readSource("server/services/autoTradeSignalGenerator.ts");
    expect(source).toContain("strategy.strategyKey === V41_STRATEGY_KEY");
    expect(source).toContain("strategy.strategyKey === V40_STRATEGY_KEY || strategy.strategyKey === V41_STRATEGY_KEY");
    expect(source).toContain('.filter((candle: string[]) => !closedOnly || candle[8] === "1")');
    expect(source).toContain("const evaluation = engine.evaluateEntryConditions(initialSignal, marketData, v41Instance)");
    expect(source).toContain("createV41TrustedEntrySeal");
    expect(source).toContain("v41TrustedEntrySeal: trustedSeal");
  });

  it("Raw parser 不映射外部封印；executor 對 auto 驗 HMAC，無封印則現場重抓 closed bars", () => {
    const source = readSource("server/services/executor.ts");
    const parserStart = source.indexOf("export function parseSignalPayload");
    const parserEnd = source.indexOf("export async function executeSignal", parserStart);
    const parserSource = source.slice(parserStart, parserEnd);

    expect(parserSource).not.toContain("v41TrustedEntrySeal");
    expect(source).toContain("verifyV41TrustedEntrySeal({");
    expect(source).toContain("expectedConfigHash: getV41ConfigHash(v41Config)");
    expect(source).toContain("V4.1 Raw Webhook closed-bar evaluator 未通過");
    expect(source).toContain("V4.1 Raw Webhook 行情重驗失敗（fail-closed）");
    expect(source).toContain("validateExecutionState(engineSignal, instance)");
  });

  it("V4.1 與 V3.5 family 共用既有 DB process lease 與唯一 monitor；monitor 失敗禁止新入場", () => {
    const heartbeat = readSource("server/_core/index.ts");
    const monitor = readSource("server/services/v35Monitor.ts");
    const riskMonitor = readSource("server/services/riskMonitor.ts");

    expect(monitor).toContain("strategyKey === V35_STRATEGY_KEY || strategyKey === V41_STRATEGY_KEY");
    expect(heartbeat).toContain('acquireProcessLease("v35-auto-trade", strategyId, 180_000)');
    expect(heartbeat).toContain("if (strategyKey === V41_STRATEGY_KEY)");
    expect(heartbeat).toContain("entry generation blocked (fail-closed)");
    expect(monitor).toContain("evaluateV41SameDirectionReentry");
    expect(monitor).toContain("allowExpansion && shouldAddLayer");
    expect(riskMonitor).toContain("export function shouldSkipGenericRiskMonitor");
    expect(riskMonitor).toContain("return isV35StrategyKey(strategyKey)");
  });

  it("V5／V6.1／V7／20415／七彩虹策略核心不引用 V4.1 evaluator 或可信封印", () => {
    const isolatedSources = [
      "server/strategies/v50/strategy_kama_3k_v50.ts",
      "server/strategies/v61/strategy_kama_3k_v61.ts",
      "server/strategies/v70/strategy_kama_3k_v70.ts",
      "server/strategies/builtin/strategy20415.ts",
      "server/strategies/builtin/strategyRainbowTrendLadder.ts",
    ].map(readSource);

    for (const source of isolatedSources) {
      expect(source).not.toContain("evaluateV41EntryConditions");
      expect(source).not.toContain("evaluateV41SameDirectionReentry");
      expect(source).not.toContain("v41TrustedEntrySeal");
      expect(source).not.toContain("V41_STRATEGY_KEY");
    }
  });
});
