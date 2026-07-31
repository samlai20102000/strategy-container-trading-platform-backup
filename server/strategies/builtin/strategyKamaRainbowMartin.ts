import {
  type MartinState,
  type MarketData,
  BaseStrategy,
  type StrategyAction,
  type StrategyInstanceConfig,
  type StrategySignal,
} from "../base";
import {
  createKamaRainbowMartinDefaultConfig,
  KAMA_RAINBOW_MARTIN_RUNTIME_NAMESPACE,
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  KAMA_RAINBOW_MARTIN_STRATEGY_NAME,
  validateKamaRainbowMartinConfig,
} from "../../../shared/strategies/kamaRainbowMartin";

/**
 * Kama 彩虹馬丁策略的 Strategy Studio 註冊橋接。
 *
 * 自動交易的 KAMA entry、腿級管理與成交狀態均由專用 pure core + guarded executor 處理；
 * 本類只提供內建策略 metadata、配置驗證與使用者明確手動訊號的通用橋接。
 */
export class StrategyKamaRainbowMartin extends BaseStrategy {
  readonly key = KAMA_RAINBOW_MARTIN_STRATEGY_KEY;
  readonly name = KAMA_RAINBOW_MARTIN_STRATEGY_NAME;
  readonly isBuiltIn = true;
  readonly capabilities = Object.freeze({ martingaleLayers: true });
  readonly defaultConfig = createKamaRainbowMartinDefaultConfig();

  validateConfig(userConfig: Record<string, unknown>): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const result = validateKamaRainbowMartinConfig(userConfig);
    return {
      valid: result.valid,
      errors: result.issues.map(issue => `${issue.path}: ${issue.message}`),
      warnings: result.warnings.map(issue => `${issue.path}: ${issue.message}`),
    };
  }

  generateActions(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    _marketData: MarketData | null,
    martinState: MartinState,
  ): StrategyAction {
    const validation = validateKamaRainbowMartinConfig(instance.config ?? this.defaultConfig);
    if (!validation.valid) {
      return {
        action: "HOLD",
        lotSize: 0,
        reason: `Kama 彩虹馬丁配置無效：${validation.issues.map(issue => issue.message).join("；")}`,
      };
    }

    const state = martinState as unknown as Record<string, unknown>;
    const runtime = (
      typeof state[KAMA_RAINBOW_MARTIN_RUNTIME_NAMESPACE] === "object"
      && state[KAMA_RAINBOW_MARTIN_RUNTIME_NAMESPACE] !== null
    )
      ? state[KAMA_RAINBOW_MARTIN_RUNTIME_NAMESPACE] as Record<string, unknown>
      : state;
    if (runtime.killed === true) {
      return { action: "HOLD", lotSize: 0, reason: "KRM_KILL_LOCKED：KILL 安全鎖已啟動" };
    }

    if (signal.action === "CLOSE") {
      return { action: "CLOSE_ALL", lotSize: 0, reason: "使用者明確要求平倉" };
    }

    const hasPosition = Number(runtime.currentLayer ?? 0) > 0 && Number(runtime.totalQuantity ?? 0) > 0;
    if (hasPosition) {
      return {
        action: "HOLD",
        lotSize: 0,
        reason: "KRM_POSITION_MANAGED：持倉腿由專用 fresh-quote 風控核心管理",
      };
    }

    const requestedSize = Number(instance.positionSize);
    if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
      return { action: "HOLD", lotSize: 0, reason: "KRM_INVALID_POSITION_SIZE：初始倉位必須大於 0" };
    }
    if (signal.action === "BUY") {
      if (instance.direction === "short") {
        return { action: "HOLD", lotSize: 0, reason: "KRM_DIRECTION_BLOCKED：實例只允許做空" };
      }
      return { action: "OPEN_LONG", lotSize: requestedSize, reason: "KRM_MANUAL_OPEN_LONG：明確手動做多" };
    }
    if (signal.action === "SELL") {
      if (instance.direction === "long") {
        return { action: "HOLD", lotSize: 0, reason: "KRM_DIRECTION_BLOCKED：實例只允許做多" };
      }
      return { action: "OPEN_SHORT", lotSize: requestedSize, reason: "KRM_MANUAL_OPEN_SHORT：明確手動做空" };
    }
    return { action: "HOLD", lotSize: 0, reason: "KRM_NO_MANUAL_ACTION：未收到明確手動交易指令" };
  }
}
