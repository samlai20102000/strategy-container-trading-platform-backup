import {
  assertValidV41Config,
  type NormalizedV41Config,
  V41_CONFIG_KEY,
  V41_STRATEGY_KEY,
} from "../../shared/strategies/kama3kMartinV41";
import { attachSnapshotConfig } from "./strategySnapshotConfig";

export interface ResolveV41ConfigOptions {
  required?: boolean;
}

export function assertV41ConfigIsolation(
  strategyKey: string,
  foreignConfigs: Record<string, unknown>,
): void {
  if (strategyKey !== V41_STRATEGY_KEY) return;
  const conflict = Object.entries(foreignConfigs).find(([, value]) => value !== undefined);
  if (conflict) {
    throw new Error(`V4.1 策略不可夾帶其他版本配置：${conflict[0]}`);
  }
}

/**
 * 策略 create／update 的單一 V4.1 寫入閘門。
 * V4.1 必須攜帶完整 canonical config；其他引擎不得夾帶 v41Config。
 */
export function resolveV41ConfigForStrategy(
  strategyKey: string,
  rawConfig: unknown,
  options: ResolveV41ConfigOptions = {},
): NormalizedV41Config | undefined {
  if (strategyKey !== V41_STRATEGY_KEY) {
    if (rawConfig !== undefined) {
      throw new Error(`v41Config 僅可用於 ${V41_STRATEGY_KEY}`);
    }
    return undefined;
  }

  if (rawConfig === undefined) {
    if (options.required) {
      throw new Error("V4.1 策略必須提供完整 v41Config；0/3 草稿不可儲存或啟用");
    }
    return undefined;
  }

  return assertValidV41Config(rawConfig);
}

/** 同步寫入通用配置與 V4.1 版本鍵，避免快照導入後被舊配置遮蔽。 */
export function attachV41StrategyConfig(
  currentState: Record<string, unknown> | null | undefined,
  config: NormalizedV41Config,
  sourceName: string,
): Record<string, unknown> {
  const validated = assertValidV41Config(config);
  const state = attachSnapshotConfig(currentState, V41_STRATEGY_KEY, validated, {
    snapshotName: sourceName,
  });
  return {
    ...state,
    [V41_CONFIG_KEY]: validated,
  };
}

/** 將 canonical 配置投影到 strategies 表的相容查詢欄位。 */
export function deriveV41StrategyColumns(config: NormalizedV41Config) {
  const firstLayer = config.Martin_Layers[0];
  return {
    stopLossPct: String(config.Max_Loss_Pct),
    takeProfitPct: String(config.Target_TP_Pct),
    martinMultiplier: String(firstLayer?.multiplier ?? config.Martin_Multiplier),
    maxMartinLevel: config.Max_Layers,
    martinSpacingPct: String(firstLayer?.stepPct ?? config.Martin_Step_Pct),
    kLinePeriod: config.K_Line_Period,
    reentryEnabled: config.enableSameDirectionReentry,
  } as const;
}
