import {
  createDefaultExecutionPolicy,
  normalizeExecutionModePolicy,
  type ExecutionMode,
  type ExecutionPolicy,
} from "../executionModes";
import { KAMA_RAINBOW_MARTIN_STRATEGY_KEY } from "./kamaRainbowMartin";

export const KAMA_RAINBOW_MARTIN_H3_PRIMARY_LOSS_TRIGGER_PCT = 4 as const;

/**
 * KRM 的 H3 風險順序是策略契約，而不是可由前端 payload 覆蓋的偏好：
 * 主腿 -4% 先開保護腿，保護腿永遠禁止馬丁；KRM 預設硬止損為 -5%。
 */
export function normalizeStrategyExecutionPolicy(
  strategyKey: string | null | undefined,
  input: unknown,
): ExecutionPolicy {
  const policy = normalizeExecutionModePolicy(input);
  if (
    strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY
    && policy.mode === "HEDGE_GUARDED"
  ) {
    return {
      ...policy,
      primaryLossTriggerPct: KAMA_RAINBOW_MARTIN_H3_PRIMARY_LOSS_TRIGGER_PCT,
      hedgeMartinEnabled: false,
    };
  }
  return policy;
}

export function createDefaultStrategyExecutionPolicy(
  strategyKey: string | null | undefined,
  mode: ExecutionMode,
): ExecutionPolicy {
  return normalizeStrategyExecutionPolicy(
    strategyKey,
    createDefaultExecutionPolicy(mode),
  );
}
