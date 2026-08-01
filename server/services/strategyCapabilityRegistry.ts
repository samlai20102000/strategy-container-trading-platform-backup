import * as db from "../db";
import {
  BUILT_IN_KEYS,
  getStrategy,
  isBuiltInKey,
} from "./strategyStudio";
import {
  getBuiltInStrategyRunnerDescriptor,
  getStrategyChannelCapabilities,
  getStrategyRunnerDescriptor,
  type StrategyRunnerChannel,
} from "./strategyRunnerDescriptors";
import {
  buildStrategyLogicHash,
  createVersionedCapabilityManifest,
  normalizeVersionedCapabilityManifest,
  type VersionedStrategyCapabilityManifest,
} from "./strategyArtifacts";

function builtInManifest(
  key: (typeof BUILT_IN_KEYS)[number],
  channel: StrategyRunnerChannel,
  versionOverride?: number,
): VersionedStrategyCapabilityManifest {
  const descriptor = getBuiltInStrategyRunnerDescriptor(key);
  const strategyVersion = versionOverride ?? descriptor.strategyVersion;
  const strategyLogicHash = buildStrategyLogicHash({
    strategyKey: key,
    strategyVersion,
    logicSource: {
      logicRevision: descriptor.logicRevision,
      adapterId: descriptor.adapterId,
      adapterVersion: descriptor.adapterVersion,
      channel,
    },
  });
  const channelCertification = descriptor.certifications[channel];
  return createVersionedCapabilityManifest({
    strategyKey: key,
    strategyVersion,
    strategyLogicHash,
    certification: channelCertification.status === "CERTIFIED" ? "CERTIFIED" : "S1_ONLY",
    capabilities: getStrategyChannelCapabilities(key, channel),
  });
}

export async function getStrategyCapabilityManifest(
  strategyKey: string,
  channel: StrategyRunnerChannel = "LIVE",
): Promise<VersionedStrategyCapabilityManifest | null> {
  const definition = await db.getStrategyDefinitionByKey(strategyKey);
  if (isBuiltInKey(strategyKey)) {
    return builtInManifest(
      strategyKey as (typeof BUILT_IN_KEYS)[number],
      channel,
      definition?.version ?? undefined,
    );
  }

  const runtimeStrategy = getStrategy(strategyKey);
  if (!definition && !runtimeStrategy) return null;
  const strategyVersion = definition?.version ?? 1;
  const strategyLogicHash = buildStrategyLogicHash({
    strategyKey,
    strategyVersion,
    logicSource: {
      channel,
      descriptor: getStrategyRunnerDescriptor(strategyKey),
      source: definition?.sourceCode ?? {
      runtimeName: runtimeStrategy?.constructor.name ?? "unloaded-custom-strategy",
      defaultConfig: runtimeStrategy?.defaultConfig ?? definition?.defaultConfig ?? {},
      },
    },
  });
  const fallback = createVersionedCapabilityManifest({
    strategyKey,
    strategyVersion,
    strategyLogicHash,
    certification: "S1_ONLY",
    capabilities: getStrategyChannelCapabilities(
      strategyKey,
      channel,
      runtimeStrategy?.capabilities.martingaleLayers === true,
    ),
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
  channel: StrategyRunnerChannel = "LIVE",
): Promise<VersionedStrategyCapabilityManifest> {
  const manifest = await getStrategyCapabilityManifest(strategyKey, channel);
  if (!manifest) throw new Error(`策略引擎「${strategyKey}」未註冊 capability manifest`);
  return manifest;
}

export async function listStrategyCapabilityManifests(
  strategyKeys: string[],
  channel: StrategyRunnerChannel = "LIVE",
): Promise<VersionedStrategyCapabilityManifest[]> {
  const manifests = await Promise.all(strategyKeys.map(key => getStrategyCapabilityManifest(key, channel)));
  return manifests.filter((manifest): manifest is VersionedStrategyCapabilityManifest => manifest !== null);
}
