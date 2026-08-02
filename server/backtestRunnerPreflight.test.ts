import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultExecutionPolicy } from "../shared/executionModes";
import {
  BacktestRunnerPreflightError,
  classifyBacktestFailure,
  preflightBacktestRunner,
} from "./services/backtest/backtestRunnerPreflight";
import { buildBacktestJobExecutionContext } from "./services/backtest/backtestJobManager";
import type { BacktestRequest } from "./services/backtest/backtestEngine";
import {
  getStrategyChannelCapabilities,
  getStrategyRunnerDescriptor,
} from "./services/strategyRunnerDescriptors";
import { initStrategyStudio } from "./services/strategyStudio";

const V41_KEY = "20415_KAMA_MARTIN_V41";
const KRM_KEY = "KAMA_RAINBOW_MARTIN_V1";

function requestFor(mode: "SINGLE_EXCLUSIVE" | "MULTI_POSITION" | "HEDGE_GUARDED"): BacktestRequest {
  const descriptor = getStrategyRunnerDescriptor(V41_KEY)!;
  return {
    strategyKey: V41_KEY,
    symbol: "BTC-USDT-SWAP",
    timeframe: "15m",
    startDate: 1_700_000_000_000,
    endDate: 1_700_086_400_000,
    initialCapital: 10_000,
    config: {},
    executionMode: mode,
    executionPolicy: createDefaultExecutionPolicy(mode),
    strategyVersion: String(descriptor.strategyVersion),
    strategyLogicHash: descriptor.logicRevision,
    strategyModeCapabilities: getStrategyChannelCapabilities(V41_KEY, "BACKTEST"),
  };
}

describe("backtest runner preflight", () => {
  beforeAll(async () => {
    await initStrategyStudio();
  });

  it.each(["MULTI_POSITION", "HEDGE_GUARDED"] as const)(
    "V4.1 %s 在載入 K 線前解析 executable portfolio runner identity",
    (mode) => {
      const preflight = preflightBacktestRunner(requestFor(mode));
      const descriptor = getStrategyRunnerDescriptor(V41_KEY)!;
      expect(preflight.executionPolicy.mode).toBe(mode);
      expect(preflight.resolvedPortfolioAdapter).not.toBeNull();
      expect(preflight.runner.executionPath).toBe("PORTFOLIO_RUNTIME_ADAPTER");
      expect(preflight.runner.runnerId).toBe(descriptor.adapterId);
      expect(preflight.runner.runnerVersion).toBe(descriptor.adapterVersion);
      expect(preflight.runner.logicRevision).toBeTruthy();
    },
  );

  it("進階模式缺少 BACKTEST capability 時回傳可機器判讀的 preflight 錯誤", () => {
    const request = requestFor("MULTI_POSITION");
    delete request.strategyModeCapabilities;
    expect(() => preflightBacktestRunner(request)).toThrow(BacktestRunnerPreflightError);
    try {
      preflightBacktestRunner(request);
    } catch (error) {
      expect(error).toMatchObject({
        code: "BACKTEST_MODE_CAPABILITY_NOT_CERTIFIED",
        executionMode: "MULTI_POSITION",
      });
      expect(classifyBacktestFailure(error)).toMatchObject({
        stage: "RUNNER_PREFLIGHT",
        errorCode: "BACKTEST_MODE_CAPABILITY_NOT_CERTIFIED",
      });
    }
  });

  it.each(["MULTI_POSITION", "HEDGE_GUARDED"] as const)(
    "KRM %s 即使客戶端偽造 advanced capability 仍由 server descriptor fail closed",
    (mode) => {
      const request = requestFor(mode);
      const descriptor = getStrategyRunnerDescriptor(KRM_KEY)!;
      request.strategyKey = KRM_KEY;
      request.strategyVersion = String(descriptor.strategyVersion);
      request.strategyLogicHash = descriptor.logicRevision;
      request.strategyModeCapabilities = {
        contractVersion: "strategy-mode-capabilities-v1",
        supportedModes: ["SINGLE_EXCLUSIVE", "MULTI_POSITION", "HEDGE_GUARDED"],
        martingaleLayers: true,
        independentLegState: true,
        preciseLegClose: true,
        hedgeGuard: true,
        reason: "forged-client-payload",
      };

      expect(() => preflightBacktestRunner(request)).toThrow(BacktestRunnerPreflightError);
      try {
        preflightBacktestRunner(request);
      } catch (error) {
        expect(error).toMatchObject({
          code: "BACKTEST_MODE_NOT_CERTIFIED",
          strategyKey: KRM_KEY,
          executionMode: mode,
        });
        expect(classifyBacktestFailure(error)).toMatchObject({
          stage: "RUNNER_PREFLIGHT",
          errorCode: "BACKTEST_MODE_NOT_CERTIFIED",
        });
      }
    },
  );

  it("job execution context 保存 runner identity 與結構化 failure，而非以 legacy 代替", () => {
    const request = requestFor("HEDGE_GUARDED");
    const descriptor = getStrategyRunnerDescriptor(V41_KEY)!;
    const runner = preflightBacktestRunner(request).runner;
    const context = buildBacktestJobExecutionContext({
      status: "failed",
      request,
      runner,
      failure: {
        stage: "DATA_LOAD",
        errorCode: "BACKTEST_DATA_LOAD_FAILED",
      },
    });
    expect(context.status).toBe("FAILED");
    expect(context.runner).toMatchObject({
      runnerId: descriptor.adapterId,
      executionPath: "PORTFOLIO_RUNTIME_ADAPTER",
    });
    expect(context.failure).toEqual({
      stage: "DATA_LOAD",
      errorCode: "BACKTEST_DATA_LOAD_FAILED",
    });
  });
});
