import { describe, expect, it } from "vitest";
import {
  appendKamaRainbowMartinHeartbeatTrace,
  parseKamaRainbowMartinHeartbeatDetail,
} from "../shared/observability/kamaRainbowMartinTrace";

describe("Kama 彩虹馬丁 Heartbeat trace", () => {
  it("round-trips sealed KRM observability without changing the human-readable detail", () => {
    const detail = appendKamaRainbowMartinHeartbeatTrace(
      "BUY @ 100 → executed: accepted",
      {
        action: "ADD_LONG",
        reasonCode: "KRM_MARTIN_NEXT_LAYER",
        executionMode: "MULTI_POSITION",
        cycleId: "cycle-1",
        legId: "leg-long",
        layerNum: 3,
        configRevision: "kamaRainbowMartin.v1",
        eventKey: "okx:BTCUSDT:risk:123:100",
      },
    );

    const decoded = parseKamaRainbowMartinHeartbeatDetail(detail);
    expect(decoded.detail).toBe("BUY @ 100 → executed: accepted");
    expect(decoded.trace).toMatchObject({
      action: "ADD_LONG",
      reasonCode: "KRM_MARTIN_NEXT_LAYER",
      executionMode: "MULTI_POSITION",
      cycleId: "cycle-1",
      legId: "leg-long",
      layerNum: 3,
    });
  });

  it("keeps legacy non-KRM details unchanged", () => {
    expect(parseKamaRainbowMartinHeartbeatDetail("[strategy_hold] 尚無訊號")).toEqual({
      detail: "[strategy_hold] 尚無訊號",
      trace: null,
    });
  });

  it("fails closed on malformed trace payload while removing the unreadable token", () => {
    expect(parseKamaRainbowMartinHeartbeatDetail("訊號 [KRM_TRACE:not-json]")).toEqual({
      detail: "訊號",
      trace: null,
    });
  });
});
