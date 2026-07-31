export interface KamaRainbowMartinHeartbeatTrace {
  action: string | null;
  reasonCode: string | null;
  executionMode: string | null;
  cycleId: string | null;
  legId: string | null;
  layerNum: number | null;
  configRevision: string | null;
  eventKey: string | null;
}

const TRACE_PREFIX = "[KRM_TRACE:";
const TRACE_PATTERN = /\s*\[KRM_TRACE:([^\]]+)\]\s*/;

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTrace(input: Partial<KamaRainbowMartinHeartbeatTrace>): KamaRainbowMartinHeartbeatTrace {
  return {
    action: cleanString(input.action),
    reasonCode: cleanString(input.reasonCode),
    executionMode: cleanString(input.executionMode),
    cycleId: cleanString(input.cycleId),
    legId: cleanString(input.legId),
    layerNum: typeof input.layerNum === "number" && Number.isFinite(input.layerNum) ? input.layerNum : null,
    configRevision: cleanString(input.configRevision),
    eventKey: cleanString(input.eventKey),
  };
}

export function appendKamaRainbowMartinHeartbeatTrace(
  detail: string,
  input: Partial<KamaRainbowMartinHeartbeatTrace>,
): string {
  const trace = normalizeTrace(input);
  const encoded = encodeURIComponent(JSON.stringify(trace));
  return `${detail.trim()} ${TRACE_PREFIX}${encoded}]`;
}

export function parseKamaRainbowMartinHeartbeatDetail(detail: string | null | undefined): {
  detail: string;
  trace: KamaRainbowMartinHeartbeatTrace | null;
} {
  const source = detail ?? "";
  const match = source.match(TRACE_PATTERN);
  if (!match) return { detail: source.trim(), trace: null };
  const cleanDetail = source.replace(TRACE_PATTERN, " ").replace(/\s+/g, " ").trim();
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(match[1]));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return { detail: cleanDetail, trace: null };
    }
    return {
      detail: cleanDetail,
      trace: normalizeTrace(decoded as Partial<KamaRainbowMartinHeartbeatTrace>),
    };
  } catch {
    return { detail: cleanDetail, trace: null };
  }
}
