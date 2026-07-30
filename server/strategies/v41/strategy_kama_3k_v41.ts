import {
  V41_CONFIG_KEY,
  V41_CONFIG_VERSION,
  V41_STRATEGY_KEY,
  createV41DefaultConfig,
  validateV41Config,
  type NormalizedV41Config,
} from "../../../shared/strategies/kama3kMartinV41";
import { calculateKAMA } from "../../services/backtest/kama";
import type {
  MartinState,
  MarketData,
  StrategyAction,
  StrategyInstanceConfig,
  StrategySignal,
  StrategyState,
  StrategyValidationResult,
} from "../base";
import { BaseStrategyV35, createInitialStrategyState } from "../base";
import { StrategyKama3kV35 } from "../v35/strategy_kama_3k_v35";
import {
  evaluateV41EntryConditions,
  type V41ClosedBar,
  type V41EntryDirection,
  type V41EntryEvaluationResult,
} from "./entryConditions";

const V41_DEFAULT_CONFIG = createV41DefaultConfig();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveV41RuntimeConfig(source: unknown): {
  valid: boolean;
  config: NormalizedV41Config | null;
  raw: unknown;
  reason: string;
} {
  const raw = isRecord(source) && V41_CONFIG_KEY in source
    ? source[V41_CONFIG_KEY]
    : source;
  const validation = validateV41Config(raw);
  return {
    valid: validation.valid,
    config: validation.config,
    raw,
    reason: validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"),
  };
}

function calculateV41Kamas(
  candles: readonly V41ClosedBar[],
  config: NormalizedV41Config,
): { fastKama: number | null; slowKama: number | null } {
  const closes = candles.map((candle) => candle.close);
  return {
    fastKama: calculateKAMA(closes, config.KAMA_Fast_Length, config.p2_fastest, config.p3_slowest),
    slowKama: calculateKAMA(closes, config.KAMA_Slow_Length, config.q2_fastest, config.q3_slowest),
  };
}

export class StrategyKama3kV41 extends BaseStrategyV35 {
  readonly key = V41_STRATEGY_KEY;
  readonly name = "V4.1 KAMA+3K 三條件動態馬丁（AND／OR）";
  readonly version = "4.1.0";
  override readonly isBuiltIn = true;
  override readonly capabilities = Object.freeze({ martingaleLayers: true });
  private readonly v40PositionCore = new StrategyKama3kV35();

  readonly defaultConfig: Record<string, any> = Object.freeze({
    ...V41_DEFAULT_CONFIG,
    [V41_CONFIG_KEY]: Object.freeze({ ...V41_DEFAULT_CONFIG }),
  });

  evaluateEntryConditions(
    signal: StrategySignal,
    marketData: MarketData,
    instance: StrategyInstanceConfig,
  ): V41EntryEvaluationResult {
    const runtime = resolveV41RuntimeConfig(instance.config);
    if (!runtime.valid || !runtime.config) {
      return evaluateV41EntryConditions({
        config: runtime.raw,
        closedBars: [],
        decisionBarTimestamp: signal.barTimestamp ?? 0,
        decisionClose: null,
        fastKama: null,
        slowKama: null,
        allowedDirection: instance.direction,
        requestedDirection: signal.action === "BUY" ? "long" : signal.action === "SELL" ? "short" : null,
      });
    }

    // 呼叫端必須只傳入已收盤 K；此處絕不使用即時 ticker／signal.price 代替決策 close。
    const closedBars: V41ClosedBar[] = marketData.candles.map((candle) => ({
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      timestamp: candle.timestamp,
    }));
    const decisionBar = closedBars.at(-1);
    const { fastKama, slowKama } = calculateV41Kamas(closedBars, runtime.config);
    const requestedDirection: V41EntryDirection | null = signal.action === "BUY"
      ? "long"
      : signal.action === "SELL"
        ? "short"
        : null;

    return evaluateV41EntryConditions({
      config: runtime.config,
      closedBars,
      decisionBarTimestamp: signal.barTimestamp ?? decisionBar?.timestamp ?? 0,
      decisionClose: decisionBar?.close ?? null,
      fastKama,
      slowKama,
      allowedDirection: instance.direction,
      requestedDirection,
    });
  }

  async validateSignal(
    signal: StrategySignal,
    marketData: MarketData,
    instance: StrategyInstanceConfig,
  ): Promise<StrategyValidationResult> {
    if (signal.action === "CLOSE") return { valid: true };
    if (signal.action !== "BUY" && signal.action !== "SELL") {
      return { valid: false, reason: "V4.1 只接受 BUY／SELL／CLOSE 訊號" };
    }
    const result = this.evaluateEntryConditions(signal, marketData, instance);
    return {
      valid: result.passed,
      reason: `${result.primaryReasonCode}｜${result.reason}`,
    };
  }

  /**
   * Entry evaluator 通過（或 HMAC 封印驗證完成）後的非行情安全檢查。
   * 刻意不讀 Price／KAMA，避免 executor 再套用 V4.0 的隱性方向 gate。
   */
  validateExecutionState(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
  ): StrategyValidationResult {
    if (signal.action === "CLOSE") return { valid: true };
    const state = instance.state ?? createInitialStrategyState();
    if (state.isCooldown && state.cooldownUntil > Date.now()) {
      return {
        valid: false,
        reason: `冷卻期中（剩餘 ${Math.ceil((state.cooldownUntil - Date.now()) / 1000)}s）`,
      };
    }
    if (state.currentLayer > 0 && state.totalSize > 0) {
      if (signal.action === "BUY" && !state.isLong) {
        return { valid: false, reason: "持有空倉，拒絕做多訊號" };
      }
      if (signal.action === "SELL" && state.isLong) {
        return { valid: false, reason: "持有多倉，拒絕做空訊號" };
      }
    }
    return { valid: true };
  }

  private withMergedConfig(instance: StrategyInstanceConfig): StrategyInstanceConfig {
    return {
      ...instance,
      config: this.mergeConfig(instance) as StrategyInstanceConfig["config"],
    };
  }

  async calculateLotSize(config: Record<string, any>, price: number): Promise<number> {
    return this.v40PositionCore.calculateLotSize(config, price);
  }

  async calculateMartingaleLotSize(
    config: Record<string, any>,
    price: number,
    layer: number,
  ): Promise<number> {
    return this.v40PositionCore.calculateMartingaleLotSize(config, price, layer);
  }

  async checkMartingaleAdd(
    state: StrategyState,
    currentPrice: number,
    config: any,
    instance: any,
  ) {
    return this.v40PositionCore.checkMartingaleAdd(state, currentPrice, config, instance);
  }

  async checkLimitStop(
    state: StrategyState,
    currentPrice: number,
    config: any,
    instance: any,
    closeAll: Function,
    pause: Function,
  ) {
    return this.v40PositionCore.checkLimitStop(state, currentPrice, config, instance, closeAll, pause);
  }

  getFirstOrderValue(config: any): number {
    return this.v40PositionCore.getFirstOrderValue(config);
  }

  getMaxLossAmount(config: any): number {
    return this.v40PositionCore.getMaxLossAmount(config);
  }

  async generateActionsV35(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    state: StrategyState,
  ): Promise<StrategyAction> {
    return this.v40PositionCore.generateActionsV35(
      signal,
      this.withMergedConfig(instance),
      marketData,
      state,
    );
  }

  generateActions(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    martinState: MartinState,
  ): StrategyAction {
    return this.v40PositionCore.generateActions(
      signal,
      this.withMergedConfig(instance),
      marketData,
      martinState,
    );
  }
}

export const strategyKama3kV41 = new StrategyKama3kV41();

export { V41_CONFIG_KEY, V41_CONFIG_VERSION, V41_STRATEGY_KEY };
