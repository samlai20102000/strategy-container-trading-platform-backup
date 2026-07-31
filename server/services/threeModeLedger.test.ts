import { describe, expect, it } from "vitest";
import {
  canTransitionHedgeRelationship,
  canTransitionOrderIntent,
  canTransitionPositionLeg,
  createOrderIntent,
  evaluateRiskReservation,
} from "./threeModeLedger";

describe("threeModeLedger safety invariants", () => {
  it("只允許受控 position leg 狀態轉移", () => {
    expect(canTransitionPositionLeg("PENDING", "OPEN")).toBe(true);
    expect(canTransitionPositionLeg("OPEN", "REDUCING")).toBe(true);
    expect(canTransitionPositionLeg("REDUCING", "CLOSED")).toBe(true);
    expect(canTransitionPositionLeg("CLOSED", "OPEN")).toBe(false);
  });

  it("禁止已成交 order intent 回到可提交狀態", () => {
    expect(canTransitionOrderIntent("CREATED", "SUBMITTING")).toBe(true);
    expect(canTransitionOrderIntent("SUBMITTED", "PARTIALLY_FILLED")).toBe(true);
    expect(canTransitionOrderIntent("PARTIALLY_FILLED", "FILLED")).toBe(true);
    expect(canTransitionOrderIntent("FILLED", "SUBMITTING")).toBe(false);
  });

  it("H3 relationship 只允許受控建立、解除與封閉路徑", () => {
    expect(canTransitionHedgeRelationship("ARMING", "ACTIVE")).toBe(true);
    expect(canTransitionHedgeRelationship("ACTIVE", "UNWINDING")).toBe(true);
    expect(canTransitionHedgeRelationship("UNWINDING", "ACTIVE")).toBe(true);
    expect(canTransitionHedgeRelationship("UNWINDING", "CLOSED")).toBe(true);
    expect(canTransitionHedgeRelationship("BLOCKED", "CLOSED")).toBe(true);
  });

  it("H3 relationship CLOSED 後不可重啟，ARMING 不可跳至 UNWINDING", () => {
    expect(canTransitionHedgeRelationship("CLOSED", "ACTIVE")).toBe(false);
    expect(canTransitionHedgeRelationship("CLOSED", "ARMING")).toBe(false);
    expect(canTransitionHedgeRelationship("ARMING", "UNWINDING")).toBe(false);
  });

  it("能力快照過期時 fail closed", () => {
    const result = evaluateRiskReservation({
      equity: 10_000,
      currentGrossNotional: 1_000,
      currentMargin: 100,
      outstandingReservedGross: 0,
      outstandingReservedMargin: 0,
      requestedGrossNotional: 500,
      requestedMargin: 50,
      maxGrossNotionalPct: 100,
      maxMarginUsagePct: 40,
      capabilityExpiresAt: 999,
      now: 1_000,
    });
    expect(result).toMatchObject({ approved: false, reasonCode: "CAPABILITY_STALE" });
  });

  it("帳戶 gross Gate 計入尚未送單的預留", () => {
    const result = evaluateRiskReservation({
      equity: 10_000,
      currentGrossNotional: 7_000,
      currentMargin: 1_000,
      outstandingReservedGross: 2_000,
      outstandingReservedMargin: 100,
      requestedGrossNotional: 1_500,
      requestedMargin: 50,
      maxGrossNotionalPct: 100,
      maxMarginUsagePct: 40,
      capabilityExpiresAt: 2_000,
      now: 1_000,
    });
    expect(result).toMatchObject({
      approved: false,
      reasonCode: "GROSS_BUDGET_EXCEEDED",
      projectedGrossNotional: 10_500,
    });
  });

  it("gross 與 margin 均在預算內才批准", () => {
    const result = evaluateRiskReservation({
      equity: 10_000,
      currentGrossNotional: 2_000,
      currentMargin: 500,
      outstandingReservedGross: 500,
      outstandingReservedMargin: 100,
      requestedGrossNotional: 1_000,
      requestedMargin: 200,
      maxGrossNotionalPct: 80,
      maxMarginUsagePct: 30,
      capabilityExpiresAt: 2_000,
      now: 1_000,
    });
    expect(result).toMatchObject({
      approved: true,
      reasonCode: "RISK_RESERVED",
      projectedGrossNotional: 3_500,
      projectedMargin: 800,
    });
  });

  it("REDUCE／CLOSE intent 未標記 reduceOnly 時在接觸資料庫前拒絕", async () => {
    await expect(createOrderIntent({
      idempotencyKey: "close-without-reduce-only",
      decisionId: "decision-1",
      userId: 1,
      strategyId: 1,
      action: "CLOSE",
      side: "sell",
      positionSide: "LONG",
      reduceOnly: false,
      requestedQuantity: 1,
      reasonCode: "TEST",
    })).rejects.toThrow("必須 reduceOnly");
  });
});
