export type KamaRainbowMartinTraceMode = "SINGLE_EXCLUSIVE" | "MULTI_POSITION" | "HEDGE_GUARDED";

export interface KamaRainbowMartinSignalTrace {
  action: string | null;
  reasonCode: string | null;
  reason: string | null;
  executionMode: KamaRainbowMartinTraceMode | null;
  cycleId: string | null;
  legId: string | null;
  layerNum: number | null;
  configRevision: string | null;
  eventKey: string | null;
  closeReason: string | null;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseKamaRainbowMartinSignalPayload(rawPayload: string | null | undefined): KamaRainbowMartinSignalTrace | null {
  if (!rawPayload) return null;
  try {
    const parsed: unknown = JSON.parse(rawPayload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payload = parsed as Record<string, unknown>;
    if (payload.kamaRainbowMartinDecision !== true) return null;
    const rawMode = stringField(payload, "kamaRainbowMartinExecutionMode");
    const executionMode = rawMode === "SINGLE_EXCLUSIVE"
      || rawMode === "MULTI_POSITION"
      || rawMode === "HEDGE_GUARDED"
      ? rawMode
      : null;
    const rawLayer = payload.kamaRainbowMartinLayerNum;
    return {
      action: stringField(payload, "kamaRainbowMartinAction"),
      reasonCode: stringField(payload, "kamaRainbowMartinReasonCode"),
      reason: stringField(payload, "reason"),
      executionMode,
      cycleId: stringField(payload, "kamaRainbowMartinCycleId"),
      legId: stringField(payload, "kamaRainbowMartinLegId"),
      layerNum: typeof rawLayer === "number" && Number.isFinite(rawLayer) ? rawLayer : null,
      configRevision: stringField(payload, "kamaRainbowMartinConfigRevision"),
      eventKey: stringField(payload, "kamaRainbowMartinEventKey"),
      closeReason: stringField(payload, "kamaRainbowMartinCloseReason"),
    };
  } catch {
    return null;
  }
}
