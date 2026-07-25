import {
  type MartinState,
  type MarketData,
  BaseStrategy,
  type StrategyAction,
  type StrategyInstanceConfig,
  type StrategySignal,
} from "../base";
import {
  createRainbow20415DefaultConfig,
  RAINBOW_20415_STRATEGY_KEY,
  RAINBOW_20415_STRATEGY_NAME,
  validateRainbow20415Config,
} from "../../../shared/strategies/rainbow20415";

/**
 * 20415 七彩虹馬丁策略的註冊橋接類別。
 *
 * 真正的七線、盲人模式、階梯與風控決策位於 rainbow20415/core.ts，
 * 自動交易與回測共用該純核心。本類只維持策略工作室既有 BaseStrategy 契約。
 */
export class Strategy20415 extends BaseStrategy {
  readonly key = RAINBOW_20415_STRATEGY_KEY;
  readonly name = RAINBOW_20415_STRATEGY_NAME;
  readonly isBuiltIn = true;
  readonly defaultConfig = createRainbow20415DefaultConfig();

  validateConfig(userConfig: Record<string, unknown>): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const result = validateRainbow20415Config(userConfig);
    return {
      valid: result.valid,
      errors: result.issues.map((issue) => `${issue.path}: ${issue.message}`),
      warnings: [],
    };
  }

  generateActions(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    _marketData: MarketData | null,
    martinState: MartinState,
  ): StrategyAction {
    const validation = validateRainbow20415Config(instance.config ?? this.defaultConfig);
    if (!validation.valid) {
      return {
        action: "HOLD",
        lotSize: 0,
        reason: `20415 七彩虹配置無效：${validation.issues.map((issue) => issue.message).join("；")}`,
      };
    }
    if (signal.action === "CLOSE") {
      return { action: "CLOSE_ALL", lotSize: 0, reason: "20415 七彩虹明確平倉指令" };
    }
    const runtimeState = martinState as unknown as {
      currentLayer?: number;
      totalSize?: number;
      avgPrice?: number;
    };
    const hasPosition =
      (runtimeState.currentLayer ?? 0) > 0 &&
      (runtimeState.totalSize ?? 0) > 0 &&
      (runtimeState.avgPrice ?? 0) > 0;
    if (hasPosition) {
      return { action: "HOLD", lotSize: 0, reason: "盲人模式由七彩虹純核心依真實價格與帳戶資料管理" };
    }
    const price = Number(signal.price) || 0;
    const baseLot = validation.config.Base_Lot_Size;
    const quantity = baseLot.mode === "usdt" && price > 0 ? baseLot.value / price : baseLot.value;
    if (signal.action === "BUY") {
      return { action: "OPEN_LONG", lotSize: quantity, reason: "20415 七彩虹外部做多底倉意圖" };
    }
    if (signal.action === "SELL") {
      return { action: "OPEN_SHORT", lotSize: quantity, reason: "20415 七彩虹外部做空底倉意圖" };
    }
    return { action: "HOLD", lotSize: 0, reason: "20415 七彩虹未識別指令" };
  }
}
