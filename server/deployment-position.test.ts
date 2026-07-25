import { describe, expect, it } from "vitest";
import {
  createDeploymentPosition,
  deploymentPositionColumns,
  resolveDeploymentPosition,
  withNumericDeploymentBaseLot,
  withObjectDeploymentBaseLot,
} from "./services/deploymentPosition";

describe("實盤部署倉位契約", () => {
  describe("createDeploymentPosition", () => {
    it.each([
      ["35", "usdt", { value: 35, mode: "usdt" }],
      [0.001, "quantity", { value: 0.001, mode: "quantity" }],
    ] as const)("接受合法值 %s / %s", (value, mode, expected) => {
      expect(createDeploymentPosition(value, mode)).toEqual(expected);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "不是數字"])(
      "拒絕無效倉位值 %s",
      (value) => {
        expect(() => createDeploymentPosition(value, "usdt")).toThrow(
          "實盤倉位大小必須為大於 0 的有限數值",
        );
      },
    );

    it("拒絕快照或未知來源提供的非法單位", () => {
      expect(() => createDeploymentPosition(35, "contracts")).toThrow(
        "實盤倉位單位必須為 quantity 或 usdt",
      );
    });
  });

  describe("resolveDeploymentPosition", () => {
    const fallback = { value: 0.01, mode: "quantity" as const };

    it("以頂層部署欄位為最高優先，不受舊物件或快照語義覆蓋", () => {
      expect(resolveDeploymentPosition({
        positionSize: "35",
        positionMode: "usdt",
        positionSizeObject: { value: 9, mode: "quantity" },
      }, fallback)).toEqual({ value: 35, mode: "usdt" });
    });

    it("舊策略缺少頂層欄位時，逐欄回退到 positionSizeObject", () => {
      expect(resolveDeploymentPosition({
        positionSizeObject: { value: 0.002, mode: "quantity" },
      }, fallback)).toEqual({ value: 0.002, mode: "quantity" });
    });

    it("損壞或不完整的舊資料安全回退，不自動改動策略狀態", () => {
      expect(resolveDeploymentPosition({
        positionSize: "0",
        positionMode: "invalid",
        positionSizeObject: { value: 80, mode: "usdt" },
      }, fallback)).toEqual({ value: 80, mode: "usdt" });
    });
  });

  it("持久化時同步 positionSize、positionMode 與 positionSizeObject", () => {
    expect(deploymentPositionColumns({ value: 35, mode: "usdt" })).toEqual({
      positionSize: "35",
      positionMode: "usdt",
      positionSizeObject: { value: 35, mode: "usdt" },
    });
  });

  it("數值型策略以部署欄位覆寫本次執行配置，但不修改原始快照", () => {
    const snapshot = {
      Base_Lot_Size: 100,
      Position_Mode: "usdt",
      Position_Value: 100,
      Keep_Logic: true,
    };
    const effective = withNumericDeploymentBaseLot(snapshot, {
      value: 0.003,
      mode: "quantity",
    });

    expect(effective).toMatchObject({
      Base_Lot_Size: 0.003,
      Position_Mode: "quantity",
      Position_Value: 0.003,
      Keep_Logic: true,
    });
    expect(snapshot).toEqual({
      Base_Lot_Size: 100,
      Position_Mode: "usdt",
      Position_Value: 100,
      Keep_Logic: true,
    });
  });

  it("20415 物件型底倉可由實盤改成另一單位，原始快照仍保持 USDT", () => {
    const snapshot = {
      Base_Lot_Size: { value: 35, mode: "usdt" as const },
      Take_Profit_Pct: 1.2,
    };
    const effective = withObjectDeploymentBaseLot(snapshot, {
      value: 0.001,
      mode: "quantity",
    });

    expect(effective).toMatchObject({
      Base_Lot_Size: { value: 0.001, mode: "quantity" },
      Position_Mode: "quantity",
      Position_Value: 0.001,
      Take_Profit_Pct: 1.2,
    });
    expect(snapshot.Base_Lot_Size).toEqual({ value: 35, mode: "usdt" });
    expect(effective.Base_Lot_Size).not.toBe(snapshot.Base_Lot_Size);
  });
});
