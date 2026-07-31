import * as db from "../db";
import {
  BUILT_IN_KEYS,
  getStrategy,
  getStrategyModeCapabilities,
  isBuiltInKey,
} from "./strategyStudio";
import {
  buildStrategyLogicHash,
  createVersionedCapabilityManifest,
  normalizeVersionedCapabilityManifest,
  type VersionedStrategyCapabilityManifest,
} from "./strategyArtifacts";

interface BuiltInRelease {
  version: number;
  logicRevision: string;
  advancedCertified: boolean;
}

const BUILT_IN_RELEASES: Readonly<Record<(typeof BUILT_IN_KEYS)[number], BuiltInRelease>> = Object.freeze({
  strategy_20415: { version: 1, logicRevision: "strategy-20415-v2-runtime", advancedCertified: false },
  RAINBOW_TREND_LADDER_V1: { version: 1, logicRevision: "rainbow-trend-ladder-v1", advancedCertified: false },
  KAMA_RAINBOW_MARTIN_V1: {
    version: 1,
    logicRevision: "kama-rainbow-martin-v1-leg-scoped-advanced-runtime-v1",
    advancedCertified: true,
  },
  KAMA_3K_BREAKOUT_V25: { version: 1, logicRevision: "kama-breakout-v25", advancedCertified: false },
  "20415_KAMA_MARTIN_V35": { version: 1, logicRevision: "advanced-kama-v35-portfolio-v1", advancedCertified: true },
  "20415_KAMA_MARTIN_V41": { version: 1, logicRevision: "kama-v41-source-parity", advancedCertified: false },
  KAMA_3K_ULTIMATE_V50: { version: 1, logicRevision: "advanced-kama-v50-portfolio-v1", advancedCertified: true },
  KAMA_3K_HF_V61: { version: 1, logicRevision: "advanced-kama-v61-portfolio-v1", advancedCertified: true },
  KAMA_3K_TORNADO_V70: { version: 1, logicRevision: "kama-v70-source-parity", advancedCertified: false },
});

function builtInManifest(
  key: (typeof BUILT_IN_KEYS)[number],
  versionOverride?: number,
): VersionedStrategyCapabilityManifest {
  const release = BUILT_IN_RELEASES[key];
  const strategyVersion = versionOverride ?? release.version;
  const strategyLogicHash = buildStrategyLogicHash({
    strategyKey: key,
    strategyVersion,
    logicSource: release.logicRevision,
  });
  return createVersionedCapabilityManifest({
    strategyKey: key,
    strategyVersion,
    strategyLogicHash,
    certification: release.advancedCertified ? "CERTIFIED" : "S1_ONLY",
    capabilities: getStrategyModeCapabilities(key),
  });
}

export async function getStrategyCapabilityManifest(
  strategyKey: string,
): Promise<VersionedStrategyCapabilityManifest | null> {
  const definition = await db.getStrategyDefinitionByKey(strategyKey);
  if (isBuiltInKey(strategyKey)) {
    return builtInManifest(
      strategyKey as (typeof BUILT_IN_KEYS)[number],
      definition?.version ?? undefined,
    );
  }

  const runtimeStrategy = getStrategy(strategyKey);
  if (!definition && !runtimeStrategy) return null;
  const strategyVersion = definition?.version ?? 1;
  const strategyLogicHash = buildStrategyLogicHash({
    strategyKey,
    strategyVersion,
    logicSource: definition?.sourceCode ?? {
      runtimeName: runtimeStrategy?.constructor.name ?? "unloaded-custom-strategy",
      defaultConfig: runtimeStrategy?.defaultConfig ?? definition?.defaultConfig ?? {},
    },
  });
  const fallback = createVersionedCapabilityManifest({
    strategyKey,
    strategyVersion,
    strategyLogicHash,
    certification: "S1_ONLY",
    capabilities: getStrategyModeCapabilities(strategyKey),
  });
  if (!definition?.capabilityManifest) return fallback;

  const stored = normalizeVersionedCapabilityManifest(definition.capabilityManifest, fallback);
  if (
    stored.strategyKey !== strategyKey
    || stored.strategyVersion !== strategyVersion
    || stored.strategyLogicHash !== strategyLogicHash
  ) {
    return fallback;
  }
  return stored;
}

export async function requireStrategyCapabilityManifest(
  strategyKey: string,
): Promise<VersionedStrategyCapabilityManifest> {
  const manifest = await getStrategyCapabilityManifest(strategyKey);
  if (!manifest) throw new Error(`策略引擎「${strategyKey}」未註冊 capability manifest`);
  return manifest;
}

export async function listStrategyCapabilityManifests(
  strategyKeys: string[],
): Promise<VersionedStrategyCapabilityManifest[]> {
  const manifests = await Promise.all(strategyKeys.map(getStrategyCapabilityManifest));
  return manifests.filter((manifest): manifest is VersionedStrategyCapabilityManifest => manifest !== null);
}
