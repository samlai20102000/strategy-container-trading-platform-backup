import {
  createV25DefaultConfig,
  normalizeV25Config,
  V25_STRATEGY_KEY,
  V25_STRATEGY_NAME,
  V25_STRATEGY_VERSION,
} from "../../../shared/strategies/kama3kBreakoutV25";
import {
  BaseStrategyV35,
  createInitialStrategyState,
  type MarketData,
  type MartinState,
  type StrategyAction,
  type StrategyInstanceConfig,
  type StrategySignal,
  type StrategyState,
  type StrategyValidationResult,
} from "../base";
import {
  evaluateV25Decision,
  type V25AllowedDirection,
  type V25CoreDecision,
} from "./core";

function withLivePrice(marketData: MarketData, price: number) {
  const candles = marketData.candles.map((candle) => ({ ...candle }));
  if (candles.length > 0 && price > 0) {
    const current = candles[candles.length - 1];
    candles[candles.length - 1] = {
      ...current,
      close: price,
      high: Math.max(current.high, price),
      low: Math.min(current.low, price),
    };
  }
  return candles;
}

export class StrategyKama3kBreakoutV25 extends BaseStrategyV35 {
  readonly key = V25_STRATEGY_KEY;
  readonly name = V25_STRATEGY_NAME;
  readonly version = V25_STRATEGY_VERSION;
  override readonly isBuiltIn = true;
  readonly defaultConfig: Record<string, any> = createV25DefaultConfig();

  parseConfig(rawConfig: unknown) {
    return normalizeV25Config(rawConfig);
  }

  generateTradingSignal(
    marketData: MarketData,
    state: StrategyState,
    rawConfig: unknown,
    direction: V25AllowedDirection = "both",
    livePrice = marketData.lastPrice,
  ): V25CoreDecision {
    return evaluateV25Decision(
      withLivePrice(marketData, livePrice),
      state,
      rawConfig,
      direction,
    );
  }

  async validateSignal(
    signal: StrategySignal,
    marketData: MarketData,
    instance: StrategyInstanceConfig,
  ): Promise<StrategyValidationResult> {
    const state = instance.state ?? createInitialStrategyState();
    const hasPosition = state.currentLayer > 0 && state.totalSize > 0;
    if (signal.action === "CLOSE") {
      return hasPosition
        ? { valid: true }
        : { valid: false, reason: "V2.5 無持倉可平" };
    }

    try {
      const decision = this.generateTradingSignal(
        marketData,
        state,
        { ...this.defaultConfig, ...instance.config },
        instance.direction,
        signal.price,
      );
      if (signal.action === "NONE") {
        return decision.action === "hold"
          ? { valid: false, reason: decision.reason }
          : { valid: true };
      }
      const directionMatches = signal.action === "BUY"
        ? decision.action === "buy" || decision.action === "add_long"
        : decision.action === "sell" || decision.action === "add_short";
      return directionMatches
        ? { valid: true }
        : { valid: false, reason: `V2.5 底層條件未允許 ${signal.action}：${decision.reason}` };
    } catch (error) {
      return {
        valid: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async generateActionsV35(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    state: StrategyState,
  ): Promise<StrategyAction> {
    const hasPosition = state.currentLayer > 0 && state.totalSize > 0;
    if (signal.action === "CLOSE") {
      return hasPosition
        ? {
            action: "CLOSE_ALL",
            lotSize: state.totalSize,
            reason: "V2.5 收到外部平倉命令",
            price: signal.price,
          }
        : { action: "HOLD", lotSize: 0, reason: "V2.5 無持倉，忽略平倉命令" };
    }
    if (!marketData) {
      return { action: "HOLD", lotSize: 0, reason: "V2.5 缺少市場資料" };
    }

    const decision = this.generateTradingSignal(
      marketData,
      state,
      { ...this.defaultConfig, ...instance.config },
      instance.direction,
      signal.price,
    );
    if (signal.action === "BUY" && !["buy", "add_long"].includes(decision.action)) {
      return { action: "HOLD", lotSize: 0, reason: `BUY 未通過 V2.5 底層條件：${decision.reason}` };
    }
    if (signal.action === "SELL" && !["sell", "add_short"].includes(decision.action)) {
      return { action: "HOLD", lotSize: 0, reason: `SELL 未通過 V2.5 底層條件：${decision.reason}` };
    }
    return this.mapDecisionToStrategyAction(decision);
  }

  generateActions(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    martinState: MartinState,
  ): StrategyAction {
    const state = instance.state ?? {
      ...createInitialStrategyState(),
      currentLayer: martinState.currentLot > 0 ? Math.max(1, martinState.lossCount + 1) : 0,
      totalSize: Math.max(0, martinState.currentLot),
      avgPrice: Math.max(0, martinState.lastEntryPrice),
      totalCost: Math.max(0, martinState.currentLot * martinState.lastEntryPrice),
      lastLayerPrice: Math.max(0, martinState.lastEntryPrice),
      isLong: signal.action !== "SELL",
    };
    if (signal.action === "CLOSE") {
      return state.totalSize > 0
        ? { action: "CLOSE_ALL", lotSize: state.totalSize, reason: "V2.5 收到外部平倉命令" }
        : { action: "HOLD", lotSize: 0, reason: "V2.5 無持倉" };
    }
    if (!marketData) {
      return { action: "HOLD", lotSize: 0, reason: "V2.5 缺少市場資料" };
    }
    const decision = this.generateTradingSignal(
      marketData,
      state,
      { ...this.defaultConfig, ...instance.config },
      instance.direction,
      signal.price,
    );
    return this.mapDecisionToStrategyAction(decision);
  }

  private mapDecisionToStrategyAction(decision: V25CoreDecision): StrategyAction {
    if (decision.action === "close") {
      return {
        action: "CLOSE_ALL",
        lotSize: 0,
        reason: decision.reason,
        price: decision.price,
      };
    }
    if (decision.action === "buy" || decision.action === "add_long") {
      return {
        action: "OPEN_LONG",
        lotSize: decision.price > 0 ? (decision.lotUsdt ?? 0) / decision.price : 0,
        reason: decision.reason,
        price: decision.price,
      };
    }
    if (decision.action === "sell" || decision.action === "add_short") {
      return {
        action: "OPEN_SHORT",
        lotSize: decision.price > 0 ? (decision.lotUsdt ?? 0) / decision.price : 0,
        reason: decision.reason,
        price: decision.price,
      };
    }
    return {
      action: "HOLD",
      lotSize: 0,
      reason: decision.reason,
      price: decision.price,
    };
  }
}

export const strategyKama3kBreakoutV25 = new StrategyKama3kBreakoutV25();

