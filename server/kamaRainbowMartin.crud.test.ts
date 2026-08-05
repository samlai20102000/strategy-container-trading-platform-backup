import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Strategy } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  getApiKeyById: vi.fn(),
  createStrategy: vi.fn(),
  getStrategyById: vi.fn(),
  updateStrategy: vi.fn(),
  requireStrategyCapabilityManifest: vi.fn(),
}));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  getApiKeyById: mocks.getApiKeyById,
  createStrategy: mocks.createStrategy,
  getStrategyById: mocks.getStrategyById,
  updateStrategy: mocks.updateStrategy,
}));

vi.mock("./services/strategyCapabilityRegistry", async importOriginal => ({
  ...(await importOriginal<typeof import("./services/strategyCapabilityRegistry")>()),
  requireStrategyCapabilityManifest: mocks.requireStrategyCapabilityManifest,
}));

import { appRouter } from "./routers";
import {
  KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
  KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY,
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
} from "../shared/strategies/kamaRainbowMartin";
import { RAINBOW_TREND_LADDER_STRATEGY_KEY } from "../shared/strategies/rainbowTrendLadder";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createContext(userId = 41): TrpcContext {
  const user: AuthenticatedUser = {
    id: userId,
    openId: `krm-crud-${userId}`,
    email: `krm-crud-${userId}@example.com`,
    name: "KRM CRUD User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(1),
    updatedAt: new Date(1),
    lastSignedIn: new Date(1),
  };
  return {
    user,
    req: {
      protocol: "https",
      headers: { host: "krm.example.test" },
    } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function validCreateInput() {
  return {
    name: "Kama 彩虹馬丁測試",
    description: "canonical CRUD regression",
    apiKeyId: 7,
    symbol: "btc-usdt-swap",
    positionSize: 100,
    positionMode: "usdt" as const,
    leverage: 3,
    direction: "both" as const,
    orderType: "market" as const,
    maxPositionPct: 0,
    stopLossPct: 99,
    takeProfitPct: 99,
    maxDailyLoss: 0,
    martinMultiplier: 9,
    maxMartinLevel: 99,
    martinSpacingPct: 99,
    strategyKey: KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
    kamaRainbowMartinConfig: {
      ...KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
      reentryEnabled: true,
    },
  };
}

function existingKrmStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: 88,
    userId: 41,
    name: "KRM existing",
    strategyKey: KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
    positionSize: "100",
    positionMode: "usdt",
    martinState: {
      runtimeMarker: "keep-me",
      [KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY]: KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
    },
    enabled: false,
    activationState: "LEGACY",
    ...overrides,
  } as Strategy;
}

describe("Kama 彩虹馬丁策略 CRUD router", () => {
  beforeEach(() => {
    mocks.getApiKeyById.mockReset().mockResolvedValue({
      id: 7,
      userId: 41,
      exchange: "okx",
    });
    mocks.createStrategy.mockReset().mockResolvedValue([{ insertId: 123 }]);
    mocks.getStrategyById.mockReset();
    mocks.updateStrategy.mockReset().mockResolvedValue(undefined);
    mocks.requireStrategyCapabilityManifest.mockReset().mockResolvedValue({
      strategyKey: KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
      strategyVersion: 1,
      strategyLogicHash: "krm-logic-v1",
      manifestHash: "krm-manifest-v1",
      certification: "CERTIFIED",
      capabilities: { supportedModes: ["SINGLE_EXCLUSIVE"] },
    });
  });

  it("建立時只寫入 KRM 私有 canonical config、保存自動重入並以 LEGACY 狀態預設停用", async () => {
    const result = await appRouter.createCaller(createContext()).strategies.create(validCreateInput());

    expect(mocks.getApiKeyById).toHaveBeenCalledWith(7, 41);
    expect(mocks.createStrategy).toHaveBeenCalledTimes(1);
    const payload = mocks.createStrategy.mock.calls[0][0] as Record<string, any>;
    expect(payload).toMatchObject({
      userId: 41,
      exchange: "okx",
      symbol: "BTC-USDT-SWAP",
      strategyKey: KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
      enabled: false,
      activationState: "LEGACY",
      executionMode: "SINGLE_EXCLUSIVE",
      positionSize: "100",
      positionMode: "usdt",
      stopLossPct: String(KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG.hardStopLossPct),
      takeProfitPct: "0",
      martinMultiplier: String(KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG.multiplier),
      maxMartinLevel: KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG.maxLayers,
      martinSpacingPct: String(KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG.gapPct),
      kLinePeriod: 30,
      reentryEnabled: true,
    });
    expect(payload.martinState[KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY]).toEqual(
      { ...KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG, reentryEnabled: true },
    );
    expect(payload.martinState.__rainbowTrendLadderConfig).toBeUndefined();
    expect(result).toMatchObject({
      success: true,
      id: 123,
      enabled: false,
      activationState: "LEGACY",
    });
  });

  it("拒絕把 KRM 配置寫入其他策略 key", async () => {
    await expect(appRouter.createCaller(createContext()).strategies.create({
      ...validCreateInput(),
      strategyKey: RAINBOW_TREND_LADDER_STRATEGY_KEY,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.createStrategy).not.toHaveBeenCalled();
  });

  it("拒絕建立未明確提供 canonical config 的 KRM 策略", async () => {
    const input = validCreateInput();
    delete (input as Partial<typeof input>).kamaRainbowMartinConfig;

    await expect(appRouter.createCaller(createContext()).strategies.create(input))
      .rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("KRM_CONFIG_MISSING"),
      });

    expect(mocks.createStrategy).not.toHaveBeenCalled();
  });

  it("更新時保留 runtime、覆寫 canonical config 與衍生欄位", async () => {
    mocks.getStrategyById.mockResolvedValue(existingKrmStrategy());
    const nextConfig = {
      ...KAMA_RAINBOW_MARTIN_DEFAULT_CONFIG,
      hardStopLossPct: 7,
      gapPct: 2.5,
      multiplier: 1.8,
      maxLayers: 6,
      reentryEnabled: true,
      layerConfigs: [
        { layerStart: 1, layerEnd: 2, multiplier: 2.25, gapPct: 0.75 },
        { layerStart: 3, layerEnd: 6, multiplier: 1.2, gapPct: 1.4 },
      ],
    };

    const result = await appRouter.createCaller(createContext()).strategies.update({
      id: 88,
      kamaRainbowMartinConfig: nextConfig,
    });

    expect(mocks.getStrategyById).toHaveBeenCalledWith(88, 41);
    expect(mocks.updateStrategy).toHaveBeenCalledTimes(1);
    const [, ownerId, data] = mocks.updateStrategy.mock.calls[0];
    expect(ownerId).toBe(41);
    expect(data).toMatchObject({
      stopLossPct: "7",
      takeProfitPct: "0",
      martinMultiplier: "2.25",
      maxMartinLevel: nextConfig.maxLayers,
      martinSpacingPct: "0.75",
      kLinePeriod: 30,
      reentryEnabled: true,
    });
    expect(data.martinState.runtimeMarker).toBe("keep-me");
    expect(data.martinState[KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY]).toEqual(nextConfig);
    expect(result).toEqual({ success: true });
  });

  it("拒絕更新缺失 canonical 綁定的既有 KRM 策略", async () => {
    mocks.getStrategyById.mockResolvedValue(existingKrmStrategy({
      martinState: { runtimeMarker: "orphaned-runtime" },
    }));

    await expect(appRouter.createCaller(createContext()).strategies.update({
      id: 88,
      name: "不得以兩線預設修復",
    })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("KRM_CONFIG_MISSING"),
    });

    expect(mocks.updateStrategy).not.toHaveBeenCalled();
  });

  it("以 owner-scoped lookup 阻擋他人策略更新", async () => {
    mocks.getStrategyById.mockResolvedValue(undefined);

    await expect(appRouter.createCaller(createContext(77)).strategies.update({
      id: 88,
      name: "not-owned",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.getStrategyById).toHaveBeenCalledWith(88, 77);
    expect(mocks.updateStrategy).not.toHaveBeenCalled();
  });

  it("允許 LEGACY 一般策略由策略卡片直接啟用", async () => {
    mocks.getStrategyById.mockResolvedValue(existingKrmStrategy());

    const result = await appRouter.createCaller(createContext()).strategies.toggle({
      id: 88,
      enabled: true,
    });

    expect(result).toEqual({ success: true });
    expect(mocks.updateStrategy).toHaveBeenCalledWith(88, 41, {
      enabled: true,
      disabledReason: null,
    });
  });

  it("canonical deployment 仍拒絕 legacy toggle 啟用", async () => {
    mocks.getStrategyById.mockResolvedValue(existingKrmStrategy({
      activationState: "DISABLED",
    }));

    await expect(appRouter.createCaller(createContext()).strategies.toggle({
      id: 88,
      enabled: true,
    })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(mocks.updateStrategy).not.toHaveBeenCalled();
  });

  it("阻擋既有 KRM 實例切換引擎 key", async () => {
    mocks.getStrategyById.mockResolvedValue(existingKrmStrategy());

    await expect(appRouter.createCaller(createContext()).strategies.update({
      id: 88,
      strategyKey: RAINBOW_TREND_LADDER_STRATEGY_KEY,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.updateStrategy).not.toHaveBeenCalled();
  });
});
