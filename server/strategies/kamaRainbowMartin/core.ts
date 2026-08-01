import {
  KAMA_RAINBOW_MARTIN_CONFIG_VERSION,
  createKamaRainbowMartinDefaultConfig,
  getKamaRainbowMartinMinimumHistoryBars,
  validateKamaRainbowMartinConfig,
  type KamaRainbowMartinConfig,
} from "../../../shared/strategies/kamaRainbowMartin";
import { createInitialStrategyState, type KLineData, type StrategyState } from "../base";
import { calculateKamaSeries, latestReadyKamaPair } from "./kama";

export type KamaRainbowMartinAllowedDirection = "long" | "short" | "both";
export type KamaRainbowMartinEntryAction = "OPEN_LONG" | "OPEN_SHORT" | "HOLD" | "MANAGE_POSITION";
export type KamaRainbowMartinTrendDirection = "UP" | "DOWN" | "MIXED" | "INSUFFICIENT";

export type KamaRainbowMartinReasonCode =
  | "KRM_CONFIG_INVALID"
  | "KRM_DATA_NOT_READY"
  | "KRM_CANDLE_UNCLOSED"
  | "KRM_CROSS_LOCK"
  | "KRM_TOUCH_LOCK"
  | "KRM_MIXED_SLOPE"
  | "KRM_ALL_UP"
  | "KRM_ALL_DOWN"
  | "KRM_POSITION_MANAGEMENT"
  | "KRM_BAR_ALREADY_PROCESSED"
  | "KRM_DIRECTION_BLOCKED"
  | "KRM_KILLED";

export interface KamaRainbowMartinLineObservation {
  id: string;
  name: string;
  previous: number;
  current: number;
  slope: number;
}

export interface KamaRainbowMartinLineClassification {
  reasonCode: Extract<
    KamaRainbowMartinReasonCode,
    "KRM_CROSS_LOCK" | "KRM_TOUCH_LOCK" | "KRM_MIXED_SLOPE" | "KRM_ALL_UP" | "KRM_ALL_DOWN"
  >;
  direction: KamaRainbowMartinTrendDirection;
  lockedPair: [string, string] | null;
}

export interface KamaRainbowMartinSnapshot {
  lines: KamaRainbowMartinLineObservation[];
  ready: boolean;
  requiredBars: number;
  availableBars: number;
  barTimestamp: number;
  closePrice: number;
  direction: KamaRainbowMartinTrendDirection;
  lockedPair: [string, string] | null;
}

export interface KamaRainbowMartinFillRecord {
  fillId: string;
  orderId: string | null;
  layer: number;
  side: "long" | "short";
  price: number;
  quantity: number;
  timestamp: number;
}

export interface KamaRainbowMartinPositionSize {
  mode: "quantity" | "usdt";
  value: number;
}

export interface KamaRainbowMartinRuntimeMeta {
  configVersion: typeof KAMA_RAINBOW_MARTIN_CONFIG_VERSION;
  killed: boolean;
  killRequestedAt: number;
  entryTimestamp: number;
  baseFillPrice: number;
  lastLayerFillPrice: number;
  configRevisionAtOpen: string;
  configAtOpen: KamaRainbowMartinConfig | null;
  initialPositionSize: KamaRainbowMartinPositionSize | null;
  fills: KamaRainbowMartinFillRecord[];
  trailingActive: boolean;
  peakProfitPct: number;
  triggerProfitPct: number | null;
  lastRiskEventKey: string;
  lastActionTimestamp: number;
  lastActionSignature: string;
  lastCloseReason: string | null;
  lastProcessedBarKey: string;
  lastProcessedBarTimestamp: number;
  lastDecisionCode: KamaRainbowMartinReasonCode;
  lastDecisionReason: string;
  direction: KamaRainbowMartinTrendDirection;
  currentLineValues: Record<string, number>;
  previousLineValues: Record<string, number>;
  lineSlopes: Record<string, number>;
  lockedPair: [string, string] | null;
}

export interface KamaRainbowMartinRuntimeState extends StrategyState {
  kamaRainbowMartinRuntime?: KamaRainbowMartinRuntimeMeta;
}

export interface KamaRainbowMartinEntryInput {
  candles: readonly KLineData[];
  state: StrategyState;
  rawConfig?: unknown;
  allowedDirection?: KamaRainbowMartinAllowedDirection;
  /** Must be supplied by the exchange-aware candle provider. */
  lastBarClosed?: boolean;
  /** Stable artifact/config revision included in Bar-Lock identity. */
  configRevision?: string;
}

export interface KamaRainbowMartinEntryDecision {
  action: KamaRainbowMartinEntryAction;
  reasonCode: KamaRainbowMartinReasonCode;
  reason: string;
  price: number;
  barTimestamp: number;
  config: KamaRainbowMartinConfig;
  snapshot: KamaRainbowMartinSnapshot;
  nextState: KamaRainbowMartinRuntimeState;
}

function hasActivePosition(state: StrategyState): boolean {
  return state.currentLayer > 0 && state.totalSize > 0 && state.avgPrice > 0;
}

function relativeEpsilon(...values: number[]): number {
  return Math.max(1, ...values.map(value => Math.abs(value))) * 1e-10;
}

export function classifyKamaRainbowMartinLines(
  lines: readonly KamaRainbowMartinLineObservation[],
): KamaRainbowMartinLineClassification {
  for (let leftIndex = 0; leftIndex < lines.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < lines.length; rightIndex += 1) {
      const left = lines[leftIndex];
      const right = lines[rightIndex];
      const previousDelta = left.previous - right.previous;
      const currentDelta = left.current - right.current;
      const epsilon = relativeEpsilon(left.previous, right.previous, left.current, right.current);
      if (Math.abs(previousDelta) <= epsilon || Math.abs(currentDelta) <= epsilon) {
        return {
          reasonCode: "KRM_TOUCH_LOCK",
          direction: "MIXED",
          lockedPair: [left.id, right.id],
        };
      }
      if (previousDelta * currentDelta < 0) {
        return {
          reasonCode: "KRM_CROSS_LOCK",
          direction: "MIXED",
          lockedPair: [left.id, right.id],
        };
      }
    }
  }

  const allUp = lines.length >= 2 && lines.every(line => line.slope > relativeEpsilon(line.previous, line.current));
  if (allUp) return { reasonCode: "KRM_ALL_UP", direction: "UP", lockedPair: null };
  const allDown = lines.length >= 2 && lines.every(line => line.slope < -relativeEpsilon(line.previous, line.current));
  if (allDown) return { reasonCode: "KRM_ALL_DOWN", direction: "DOWN", lockedPair: null };
  return { reasonCode: "KRM_MIXED_SLOPE", direction: "MIXED", lockedPair: null };
}

function emptySnapshot(candles: readonly KLineData[], requiredBars: number): KamaRainbowMartinSnapshot {
  return {
    lines: [],
    ready: false,
    requiredBars,
    availableBars: candles.length,
    barTimestamp: candles.at(-1)?.timestamp ?? 0,
    closePrice: candles.at(-1)?.close ?? 0,
    direction: "INSUFFICIENT",
    lockedPair: null,
  };
}

export function calculateKamaRainbowMartinSnapshot(
  candles: readonly KLineData[],
  config: KamaRainbowMartinConfig,
): KamaRainbowMartinSnapshot {
  const enabledLines = config.kamaLines.filter(line => line.enabled);
  const requiredBars = getKamaRainbowMartinMinimumHistoryBars(config);
  const snapshot = emptySnapshot(candles, requiredBars);
  if (candles.length < requiredBars) return snapshot;
  if (candles.some(candle => !Number.isFinite(candle.close) || candle.close <= 0)) return snapshot;

  const closes = candles.map(candle => candle.close);
  const lines: KamaRainbowMartinLineObservation[] = [];
  for (const line of enabledLines) {
    const pair = latestReadyKamaPair(calculateKamaSeries(closes, line));
    if (!pair) return snapshot;
    lines.push({
      id: line.id,
      name: line.name,
      previous: pair.previous,
      current: pair.current,
      slope: pair.current - pair.previous,
    });
  }

  const classification = classifyKamaRainbowMartinLines(lines);
  return {
    lines,
    ready: true,
    requiredBars,
    availableBars: candles.length,
    barTimestamp: candles.at(-1)?.timestamp ?? 0,
    closePrice: candles.at(-1)?.close ?? 0,
    direction: classification.direction,
    lockedPair: classification.lockedPair,
  };
}

export function createKamaRainbowMartinRuntimeMeta(
  seed?: Partial<KamaRainbowMartinRuntimeMeta>,
): KamaRainbowMartinRuntimeMeta {
  return {
    configVersion: KAMA_RAINBOW_MARTIN_CONFIG_VERSION,
    killed: false,
    killRequestedAt: 0,
    entryTimestamp: 0,
    baseFillPrice: 0,
    lastLayerFillPrice: 0,
    configRevisionAtOpen: "",
    trailingActive: false,
    peakProfitPct: 0,
    triggerProfitPct: null,
    lastRiskEventKey: "",
    lastActionTimestamp: 0,
    lastActionSignature: "",
    lastCloseReason: null,
    lastProcessedBarKey: "",
    lastProcessedBarTimestamp: 0,
    lastDecisionCode: "KRM_DATA_NOT_READY",
    lastDecisionReason: "尚未執行 Kama 彩虹馬丁決策",
    direction: "INSUFFICIENT",
    ...seed,
    configAtOpen: seed?.configAtOpen
      ? {
          ...seed.configAtOpen,
          trailing: { ...seed.configAtOpen.trailing },
          kamaLines: seed.configAtOpen.kamaLines.map(line => ({ ...line })),
          layerConfigs: (seed.configAtOpen.layerConfigs ?? []).map(layer => ({ ...layer })),
        }
      : null,
    initialPositionSize: seed?.initialPositionSize ? { ...seed.initialPositionSize } : null,
    fills: (seed?.fills ?? []).map(fill => ({ ...fill })),
    currentLineValues: { ...(seed?.currentLineValues ?? {}) },
    previousLineValues: { ...(seed?.previousLineValues ?? {}) },
    lineSlopes: { ...(seed?.lineSlopes ?? {}) },
    lockedPair: seed?.lockedPair ? [...seed.lockedPair] : null,
  };
}

export function createKamaRainbowMartinRuntimeState(
  seed?: Partial<KamaRainbowMartinRuntimeState>,
): KamaRainbowMartinRuntimeState {
  const source = seed ?? {};
  return {
    ...createInitialStrategyState(),
    ...source,
    kamaRainbowMartinRuntime: createKamaRainbowMartinRuntimeMeta(source.kamaRainbowMartinRuntime),
  };
}

function cloneRuntimeState(state: StrategyState): KamaRainbowMartinRuntimeState {
  const source = state as KamaRainbowMartinRuntimeState;
  return {
    ...source,
    kamaRainbowMartinRuntime: createKamaRainbowMartinRuntimeMeta(source.kamaRainbowMartinRuntime),
  };
}

function withObservation(
  state: KamaRainbowMartinRuntimeState,
  snapshot: KamaRainbowMartinSnapshot,
  reasonCode: KamaRainbowMartinReasonCode,
  reason: string,
  processedBarKey?: string,
): KamaRainbowMartinRuntimeState {
  state.kamaRainbowMartinRuntime = createKamaRainbowMartinRuntimeMeta({
    ...state.kamaRainbowMartinRuntime,
    lastProcessedBarKey: processedBarKey ?? state.kamaRainbowMartinRuntime?.lastProcessedBarKey ?? "",
    lastProcessedBarTimestamp: processedBarKey
      ? snapshot.barTimestamp
      : state.kamaRainbowMartinRuntime?.lastProcessedBarTimestamp ?? 0,
    lastDecisionCode: reasonCode,
    lastDecisionReason: reason,
    direction: snapshot.direction,
    currentLineValues: Object.fromEntries(snapshot.lines.map(line => [line.id, line.current])),
    previousLineValues: Object.fromEntries(snapshot.lines.map(line => [line.id, line.previous])),
    lineSlopes: Object.fromEntries(snapshot.lines.map(line => [line.id, line.slope])),
    lockedPair: snapshot.lockedPair,
  });
  return state;
}

function makeDecision(
  action: KamaRainbowMartinEntryAction,
  reasonCode: KamaRainbowMartinReasonCode,
  reason: string,
  config: KamaRainbowMartinConfig,
  snapshot: KamaRainbowMartinSnapshot,
  state: KamaRainbowMartinRuntimeState,
  processedBarKey?: string,
): KamaRainbowMartinEntryDecision {
  return {
    action,
    reasonCode,
    reason,
    price: snapshot.closePrice,
    barTimestamp: snapshot.barTimestamp,
    config,
    snapshot,
    nextState: withObservation(state, snapshot, reasonCode, reason, processedBarKey),
  };
}

export function scaleKamaRainbowMartinPositionSize(
  size: KamaRainbowMartinPositionSize,
  multiplier: number,
  layer: number,
): KamaRainbowMartinPositionSize {
  return multiplyKamaRainbowMartinPositionSize(size, multiplier ** Math.max(0, layer - 1));
}

export function multiplyKamaRainbowMartinPositionSize(
  size: KamaRainbowMartinPositionSize,
  cumulativeMultiplier: number,
): KamaRainbowMartinPositionSize {
  const value = size.value * cumulativeMultiplier;
  return { mode: size.mode, value: Math.round(value * 1e12) / 1e12 };
}

export function evaluateKamaRainbowMartinEntry(
  input: KamaRainbowMartinEntryInput,
): KamaRainbowMartinEntryDecision {
  const validation = validateKamaRainbowMartinConfig(input.rawConfig ?? createKamaRainbowMartinDefaultConfig());
  const config = validation.config;
  const state = cloneRuntimeState(input.state);
  const snapshot = emptySnapshot(input.candles, getKamaRainbowMartinMinimumHistoryBars(config));

  if (!validation.valid) {
    const reason = validation.issues.map(issue => `${issue.path}: ${issue.message}`).join("；");
    return makeDecision("HOLD", "KRM_CONFIG_INVALID", reason, config, snapshot, state);
  }
  if (state.kamaRainbowMartinRuntime?.killed) {
    return makeDecision("HOLD", "KRM_KILLED", "策略已由 KILL 鎖定，禁止新增曝險", config, snapshot, state);
  }
  if (hasActivePosition(state)) {
    return makeDecision(
      "MANAGE_POSITION",
      "KRM_POSITION_MANAGEMENT",
      "目標腿已有持倉：跳過 KAMA，僅進入腿級風控管理",
      config,
      snapshot,
      state,
    );
  }
  if (input.lastBarClosed === false) {
    return makeDecision("HOLD", "KRM_CANDLE_UNCLOSED", "最後一根 K 線尚未收盤，禁止掃描入場", config, snapshot, state);
  }

  const calculated = calculateKamaRainbowMartinSnapshot(input.candles, config);
  if (!calculated.ready) {
    return makeDecision(
      "HOLD",
      "KRM_DATA_NOT_READY",
      `KAMA 數據不足：需要 ${calculated.requiredBars} 根，現有 ${calculated.availableBars} 根`,
      config,
      calculated,
      state,
    );
  }

  const configRevision = input.configRevision?.trim() || config.version;
  const barKey = `${configRevision}:${calculated.barTimestamp}`;
  if (state.kamaRainbowMartinRuntime?.lastProcessedBarKey === barKey) {
    return makeDecision(
      "HOLD",
      "KRM_BAR_ALREADY_PROCESSED",
      "相同配置修訂與已收盤 K 棒已完成掃描",
      config,
      calculated,
      state,
    );
  }

  const classification = classifyKamaRainbowMartinLines(calculated.lines);
  calculated.direction = classification.direction;
  calculated.lockedPair = classification.lockedPair;
  if (classification.reasonCode === "KRM_TOUCH_LOCK") {
    return makeDecision(
      "HOLD",
      "KRM_TOUCH_LOCK",
      `KAMA 線對 ${classification.lockedPair?.join("/")} 接觸或近似相等，封鎖新底倉`,
      config,
      calculated,
      state,
      barKey,
    );
  }
  if (classification.reasonCode === "KRM_CROSS_LOCK") {
    return makeDecision(
      "HOLD",
      "KRM_CROSS_LOCK",
      `KAMA 線對 ${classification.lockedPair?.join("/")} 本棒交叉，封鎖新底倉`,
      config,
      calculated,
      state,
      barKey,
    );
  }
  if (classification.reasonCode === "KRM_MIXED_SLOPE") {
    return makeDecision(
      "HOLD",
      "KRM_MIXED_SLOPE",
      "啟用中的 KAMA 未全部同向",
      config,
      calculated,
      state,
      barKey,
    );
  }

  const allowedDirection = input.allowedDirection ?? "both";
  if (
    (classification.reasonCode === "KRM_ALL_UP" && allowedDirection === "short")
    || (classification.reasonCode === "KRM_ALL_DOWN" && allowedDirection === "long")
  ) {
    return makeDecision(
      "HOLD",
      "KRM_DIRECTION_BLOCKED",
      "策略方向限制阻擋本次候選訊號",
      config,
      calculated,
      state,
      barKey,
    );
  }

  const action = classification.reasonCode === "KRM_ALL_UP" ? "OPEN_LONG" : "OPEN_SHORT";
  const reason = classification.reasonCode === "KRM_ALL_UP"
    ? "全部啟用 KAMA 上升且無交叉／接觸，產生多頭候選"
    : "全部啟用 KAMA 下降且無交叉／接觸，產生空頭候選";
  return makeDecision(action, classification.reasonCode, reason, config, calculated, state, barKey);
}
