import { listRegisteredStrategies } from "../strategyStudio";
import { requireStrategyCapabilityManifest } from "../strategyCapabilityRegistry";
import { getBacktestReadinessEntry } from "./backtestReadinessRegistry";

/**
 * 回測中心的唯一策略 fallback 目錄。
 * 無論主要 registry API 是否可用，都只能公開 BACKTEST channel 的能力，
 * 禁止以 LIVE／SIMULATION capability 或 S1 猜測值代替。
 */
export async function getBacktestStrategyCatalog() {
  return Promise.all(listRegisteredStrategies().map(async strategy => {
    const backtestCapabilityManifest = await requireStrategyCapabilityManifest(strategy.key, "BACKTEST");
    return {
      key: strategy.key,
      name: strategy.name,
      defaultConfig: strategy.defaultConfig,
      backtestCapabilityManifest,
      backtestModeCapabilities: backtestCapabilityManifest.capabilities,
      readiness: getBacktestReadinessEntry(strategy.key),
    };
  }));
}
