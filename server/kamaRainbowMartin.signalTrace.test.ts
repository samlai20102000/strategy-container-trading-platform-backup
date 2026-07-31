import { describe, expect, it } from "vitest";
import { parseKamaRainbowMartinSignalPayload } from "../shared/observability/kamaRainbowMartinSignalTrace";

describe("Kama 彩虹馬丁 sealed signal trace", () => {
  it("decodes mode, cycle, leg, layer, revision and reason from a sealed payload", () => {
    const trace = parseKamaRainbowMartinSignalPayload(JSON.stringify({
      kamaRainbowMartinDecision: true,
      kamaRainbowMartinAction: "ADD_LONG",
      kamaRainbowMartinReasonCode: "KRM_MARTIN_NEXT_LAYER",
      kamaRainbowMartinExecutionMode: "MULTI_POSITION",
      kamaRainbowMartinCycleId: "cycle-1",
      kamaRainbowMartinLegId: "leg-long",
      kamaRainbowMartinLayerNum: 2,
      kamaRainbowMartinConfigRevision: "kamaRainbowMartin.v1",
      kamaRainbowMartinEventKey: "event-1",
      reason: "價格觸及下一層",
    }));

    expect(trace).toMatchObject({
      action: "ADD_LONG",
      reasonCode: "KRM_MARTIN_NEXT_LAYER",
      executionMode: "MULTI_POSITION",
      cycleId: "cycle-1",
      legId: "leg-long",
      layerNum: 2,
      configRevision: "kamaRainbowMartin.v1",
    });
  });

  it("rejects malformed, non-object and non-KRM payloads", () => {
    expect(parseKamaRainbowMartinSignalPayload("not-json")).toBeNull();
    expect(parseKamaRainbowMartinSignalPayload("[]")).toBeNull();
    expect(parseKamaRainbowMartinSignalPayload(JSON.stringify({ action: "buy" }))).toBeNull();
  });
});
