import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertValidV41Config,
  createV41DefaultConfig,
  V41_STRATEGY_KEY,
} from "../shared/strategies/kama3kMartinV41";
import {
  evaluateV41EntryConditions,
  evaluateV41SameDirectionReentry,
} from "./strategies/v41/entryConditions";
import {
  createV41BacktestEntryDiagnostics,
  recordV41BacktestEntryEvaluation,
  recordV41BacktestReentryEvaluation,
} from "./services/backtest/v41BacktestDiagnostics";
import {
  backtestRequestSchema,
  validateBacktestRequest,
} from "./routers/backtest.router";
import { buildBacktestResultPersistence } from "./services/backtest/backtestJobManager";
import type { BacktestRequest, BacktestResult } from "./services/backtest/backtestEngine";

function validFastSlowConfig() {
  return assertValidV41Config({
    ...createV41DefaultConfig(),
    enableKamaFastSlowCross: true,
    enableSameDirectionReentry: true,
  });
}

describe("V4.1 回測同源 evaluator 與診斷", () => {
  it("累計初始入場票數、開倉數與 config hash", () => {
    const config = validFastSlowConfig();
    const diagnostics = createV41BacktestEntryDiagnostics(config);
    const result = evaluateV41EntryConditions({
      config,
      closedBars: [
        { open: 100, high: 102, low: 99, close: 101, timestamp: 1 },
        { open: 101, high: 103, low: 100, close: 102, timestamp: 2 },
        { open: 102, high: 104, low: 101, close: 103, timestamp: 3 },
      ],
      decisionBarTimestamp: 3,
      decisionClose: 103,
      fastKama: 102,
      slowKama: 100,
      allowedDirection: "both",
    });

    recordV41BacktestEntryEvaluation(diagnostics, result);

    expect(result.direction).toBe("long");
    expect(diagnostics.strategyKey).toBe(V41_STRATEGY_KEY);
    expect(diagnostics.configHash).toBe(result.configHash);
    expect(diagnostics.evaluatedBars).toBe(1);
    expect(diagnostics.openedSignals).toBe(1);
    expect(diagnostics.voteStatusCounts.kama_fast_slow.long).toBe(1);
  });

  it("原地重入只重驗持續方向條件並記錄拒絕理由", () => {
    const config = validFastSlowConfig();
    const diagnostics = createV41BacktestEntryDiagnostics(config);
    const result = evaluateV41SameDirectionReentry({
      config,
      closedBars: [],
      decisionBarTimestamp: 4,
      decisionClose: 99,
      fastKama: 98,
      slowKama: 100,
      allowedDirection: "both",
      requestedDirection: "long",
      originalDirection: "long",
    });

    recordV41BacktestReentryEvaluation(diagnostics, result);

    expect(result.allowed).toBe(false);
    expect(diagnostics.reentryEvaluations).toBe(1);
    expect(diagnostics.reentryOpened).toBe(0);
    expect(diagnostics.holdReasonCounts.V41_REENTRY_DIRECTION_NOT_SUPPORTED).toBe(1);
  });

  it("引擎明確排除 generic fallback 並呼叫 V4.1 初始入場與重入 evaluator", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./services/backtest/backtestEngine.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("const isV41 = request.strategyKey === V41_STRATEGY_KEY");
    expect(source).toContain("!isV35 && !isV41 && !isV50");
    expect(source).toContain("evaluateV41EntryConditions({");
    expect(source).toContain("evaluateV41SameDirectionReentry({");
    expect(source).toContain("v41EntryDiagnostics");
  });

  it("背景 job 排隊前凍結 flat 與 nested canonical 配置", () => {
    const config = validFastSlowConfig();
    const base = {
      strategyKey: V41_STRATEGY_KEY,
      symbol: "BTC-USDT-SWAP",
      timeframe: "30m",
      startDate: 1_700_000_000_000,
      endDate: 1_700_086_400_000,
      initialCapital: 10_000,
      exchange: "okx" as const,
      endPositionPolicy: "mark_to_market" as const,
    };

    const flat = validateBacktestRequest(backtestRequestSchema.parse({ ...base, config }));
    const nested = validateBacktestRequest(backtestRequestSchema.parse({
      ...base,
      config: { __v41Config: config },
    }));

    expect(flat.config).toEqual(config);
    expect(nested.config).toEqual(config);
    expect(flat.config).not.toHaveProperty("__v41Config");
  });

  it("回測排隊前拒絕 V4.1 的 0/3 與錯 strategyKey 配置", () => {
    const draft = createV41DefaultConfig();
    const base = {
      strategyKey: V41_STRATEGY_KEY,
      symbol: "BTC-USDT-SWAP",
      timeframe: "30m",
      startDate: 1_700_000_000_000,
      endDate: 1_700_086_400_000,
      initialCapital: 10_000,
      config: draft,
      exchange: "okx" as const,
      endPositionPolicy: "mark_to_market" as const,
    };

    expect(() => validateBacktestRequest(backtestRequestSchema.parse(base))).toThrow(
      "V41_NO_ENTRY_CONDITION_ENABLED",
    );
    expect(() => validateBacktestRequest(backtestRequestSchema.parse({
      ...base,
      config: { ...draft, enableKamaFastSlowCross: true, strategyKey: "wrong" },
    }))).toThrow();
  });

  it("背景任務持久化會保留 V4.1 三票診斷", () => {
    const config = validFastSlowConfig();
    const diagnostics = createV41BacktestEntryDiagnostics(config);
    const result = {
      summary: "V4.1 diagnostic persistence",
      metrics: {},
      trades: [],
      equityCurve: [],
      config,
      candleCount: 3,
      environment: {
        engineVersion: "test",
        strategyKey: V41_STRATEGY_KEY,
        configHash: diagnostics.configHash,
        startDate: 1,
        endDate: 3,
        candleCount: 3,
        initialCapital: 10_000,
        v41EntryDiagnostics: diagnostics,
      },
    } as unknown as BacktestResult;
    const request = {
      strategyKey: V41_STRATEGY_KEY,
      symbol: "BTC-USDT-SWAP",
      timeframe: "30m",
      startDate: 1,
      endDate: 3,
      initialCapital: 10_000,
      config,
      exchange: "okx",
      endPositionPolicy: "mark_to_market",
    } as BacktestRequest;

    const persisted = buildBacktestResultPersistence(result, request);

    expect(persisted.environment?.v41EntryDiagnostics).toEqual(diagnostics);
  });
});
