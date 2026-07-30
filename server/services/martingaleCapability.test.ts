import { beforeEach, describe, expect, it, vi } from "vitest";

const { getStrategyMock, getStrategyCapabilitiesMock } = vi.hoisted(() => ({
  getStrategyMock: vi.fn(),
  getStrategyCapabilitiesMock: vi.fn(),
}));

vi.mock("./strategyStudio", () => ({
  getStrategy: getStrategyMock,
  getStrategyCapabilities: getStrategyCapabilitiesMock,
}));

import {
  evaluateMartingaleCapability,
  evaluateMartingaleStrategyInstance,
} from "./martingaleCapability";

describe("martingaleCapability", () => {
  beforeEach(() => {
    getStrategyMock.mockReset();
    getStrategyCapabilitiesMock.mockReset();
    getStrategyCapabilitiesMock.mockImplementation((key: string) => ({
      martingaleLayers: key === "MARTIN",
    }));
    getStrategyMock.mockImplementation((key: string) => {
      if (key === "PLAIN") {
        return {
          capabilities: { martingaleLayers: false },
          defaultConfig: {},
        };
      }
      if (key === "MARTIN") {
        return {
          capabilities: { martingaleLayers: true },
          defaultConfig: { Martingale_Enabled: true, Max_Layers: 7 },
        };
      }
      return undefined;
    });
  });

  it("未知策略必須 fail-closed，不顯示馬丁逐層功能", () => {
    expect(evaluateMartingaleCapability("UNKNOWN", { Max_Layers: 9 })).toEqual({
      isMartingale: false,
      supportsMartingale: false,
      enabled: false,
      maxLayers: 0,
      reason: "strategy_not_registered",
    });
  });

  it("已註冊但未明確宣告 capability 的策略仍固定拒絕", () => {
    expect(evaluateMartingaleCapability("PLAIN", { Max_Layers: 9 })).toMatchObject({
      isMartingale: false,
      reason: "capability_not_declared",
    });
  });

  it("具 capability 但使用者配置停用時不接入", () => {
    expect(evaluateMartingaleCapability("MARTIN", {
      Martingale_Enabled: false,
      Max_Layers: 7,
    })).toMatchObject({
      isMartingale: false,
      supportsMartingale: true,
      enabled: false,
      reason: "disabled_by_config",
    });
  });

  it("只有一層的畸形配置不被當成馬丁策略", () => {
    expect(evaluateMartingaleCapability("MARTIN", { Max_Layers: 1 })).toMatchObject({
      isMartingale: false,
      maxLayers: 1,
      reason: "invalid_layer_config",
    });
  });

  it("資料列私有配置會被正規化，並由 maxMartinLevel 限制有效層數", () => {
    expect(evaluateMartingaleStrategyInstance({
      strategyKey: "MARTIN",
      maxMartinLevel: 3,
      martinState: {
        __v70Config: {
          Martingale_Enabled: true,
          Max_Layers: 7,
        },
      },
    })).toMatchObject({
      isMartingale: true,
      maxLayers: 3,
      reason: "enabled",
    });
  });
});
