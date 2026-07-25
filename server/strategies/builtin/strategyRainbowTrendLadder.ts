import {
  type MartinState,
  type MarketData,
  BaseStrategy,
  type StrategyAction,
  type StrategyInstanceConfig,
  type StrategySignal,
} from "../base";
import {
  createRainbowTrendLadderDefaultConfig,
  RAINBOW_TREND_LADDER_STRATEGY_KEY,
  RAINBOW_TREND_LADDER_STRATEGY_NAME,
  validateRainbowTrendLadderConfig,
} from "../../../shared/strategies/rainbowTrendLadder";

/**
 * 七彩虹線趨勢跟蹤階梯馬丁策略的內建註冊橋接。
 *
 * 七線進場、盲人模式、八層階梯與風控決策位於 rainbowTrendLadder 純核心；
 * 本類只提供策略工作室既有 BaseStrategy 契約，絕不引用 20415 的設定或狀態。
 */
export class StrategyRainbowTrendLadder extends BaseStrategy {
  readonly key = RAINBOW_TREND_LADDER_STRATEGY_KEY;
  readonly name = RAINBOW_TREND_LADDER_STRATEGY_NAME;
  readonly isBuiltIn = true;
  readonly defaultConfig = createRainbowTrendLadderDefaultConfig();

  validateConfig(userConfig: Record<string, unknown>): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const result = validateRainbowTrendLadderConfig(userConfig);
    return {
      valid: result.valid,
      errors: result.issues.map((issue) => `${issue.path}: ${issue.message}`),
      warnings: result.config.Live_Trading_Armed
        ? ["實盤武裝已開啟；仍須通過專用帳戶、持倉所有權、點差與滑點安全閘門"]
        : ["預設為模擬決策模式，不會送出交易所訂單"],
    };
  }

  generateActions(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    _marketData: MarketData | null,
    martinState: MartinState,
  ): StrategyAction {
    const validation = validateRainbowTrendLadderConfig(instance.config ?? this.defaultConfig);
    if (!validation.valid) {
      return {
        action: "HOLD",
        lotSize: 0,
        reason: `七彩虹線階梯策略配置無效：${validation.issues.map((issue) => issue.message).join("；")}`,
      };
    }

    if (signal.action === "CLOSE") {
      return { action: "CLOSE_ALL", lotSize: 0, reason: "七彩虹線階梯策略明確平倉指令" };
    }

    const stateContainer = martinState as unknown as {
      rainbowTrendLadderRuntime?: { currentLayer?: number; totalSize?: number; avgPrice?: number; killed?: boolean };
      currentLayer?: number;
      totalSize?: number;
      avgPrice?: number;
      killed?: boolean;
    };
    const runtime = stateContainer.rainbowTrendLadderRuntime ?? stateContainer;
    if (runtime.killed) {
      return { action: "HOLD", lotSize: 0, reason: "KILL 安全鎖已啟動，拒絕任何新交易" };
    }
    const hasPosition =
      (runtime.currentLayer ?? 0) > 0 &&
      (runtime.totalSize ?? 0) > 0 &&
      (runtime.avgPrice ?? 0) > 0;
    if (hasPosition) {
      return { action: "HOLD", lotSize: 0, reason: "盲人模式由新策略純核心依交易所真值管理" };
    }

    if (!validation.config.Live_Trading_Armed) {
      return { action: "HOLD", lotSize: 0, reason: "新策略尚未武裝，只記錄模擬決策" };
    }

    const price = Number(signal.price) || 0;
    const baseLot = validation.config.Base_Lot_Size;
    const quantity = baseLot.mode === "usdt" && price > 0 ? baseLot.value / price : baseLot.value;
    if (signal.action === "BUY") {
      return { action: "OPEN_LONG", lotSize: quantity, reason: "七彩虹線階梯策略做多底倉意圖" };
    }
    if (signal.action === "SELL") {
      return { action: "OPEN_SHORT", lotSize: quantity, reason: "七彩虹線階梯策略做空底倉意圖" };
    }
    return { action: "HOLD", lotSize: 0, reason: "七彩虹線階梯策略未識別指令" };
  }
}
