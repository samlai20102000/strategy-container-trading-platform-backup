import {
  createKamaRainbowMartinDefaultConfig,
  getKamaRainbowMartinCumulativeMultiplier,
  getKamaRainbowMartinLayerProtection,
  getLayerGapPct,
  validateKamaRainbowMartinConfig,
  type KamaRainbowMartinConfig,
} from "../../../shared/strategies/kamaRainbowMartin";
import type { StrategyState } from "../base";
import {
  createKamaRainbowMartinRuntimeMeta,
  createKamaRainbowMartinRuntimeState,
  multiplyKamaRainbowMartinPositionSize,
  type KamaRainbowMartinFillRecord,
  type KamaRainbowMartinPositionSize,
  type KamaRainbowMartinRuntimeMeta,
  type KamaRainbowMartinRuntimeState,
} from "./core";

export type KamaRainbowMartinManagementAction = "add_long" | "add_short" | "close" | "hold";
export type KamaRainbowMartinCloseReason = "HARD_STOP" | "TRAILING_TAKE_PROFIT" | "KILL" | "MANUAL" | "OTHER";
export type KamaRainbowMartinManagementReasonCode =
  | "KRM_MANAGE_NO_POSITION"
  | "KRM_MANAGE_PRICE_INVALID"
  | "KRM_RISK_EVENT_DUPLICATE"
  | "KRM_KILL_CLOSE"
  | "KRM_HARD_STOP"
  | "KRM_TRAILING_EXIT"
  | "KRM_MARTIN_ADD"
  | "KRM_MARTIN_WAIT"
  | "KRM_MARTIN_MAX_LAYER";

export interface KamaRainbowMartinManagementInput {
  currentPrice: number;
  now: number;
  /** Fresh-quote or deterministic backtest event identity. */
  riskEventKey?: string;
}

export interface KamaRainbowMartinManagementMetrics {
  profitPct: number;
  hardStopLossPct: number;
  trailingEnabled: boolean;
  trailingActive: boolean;
  peakProfitPct: number;
  triggerProfitPct: number | null;
  /** Internal position layer, where L1 is the base fill. */
  currentLayer: number;
  /** User-facing add layer, where L1 is the first add after the base fill. */
  currentAddLayer: number;
  /** Total internal position layers, including the base fill. */
  maxLayers: number;
  /** User-facing maximum number of add layers, excluding the base fill. */
  maxAddLayers: number;
  /** Next internal position layer, including the base fill offset. */
  nextLayer: number | null;
  /** Next user-facing add layer. */
  nextAddLayer: number | null;
  nextGapPct: number | null;
  nextTriggerPrice: number | null;
  distanceToNextLayerPct: number | null;
  averageCost: number;
  baseFillPrice: number;
  lastLayerFillPrice: number;
  totalQuantity: number;
  configRevisionAtOpen: string;
  killed: boolean;
}

export interface KamaRainbowMartinManagementDecision {
  action: KamaRainbowMartinManagementAction;
  reasonCode: KamaRainbowMartinManagementReasonCode;
  reason: string;
  price: number;
  layerNum?: number;
  orderSize?: KamaRainbowMartinPositionSize;
  closeReason?: KamaRainbowMartinCloseReason;
  eventKey: string;
  metrics: KamaRainbowMartinManagementMetrics;
  nextState: KamaRainbowMartinRuntimeState;
}

export interface KamaRainbowMartinFillInput {
  action: "OPEN_LONG" | "OPEN_SHORT" | "ADD_LONG" | "ADD_SHORT";
  fillId: string;
  orderId?: string | null;
  fillPrice: number;
  fillQuantity: number;
  timestamp: number;
  targetLayer?: number;
  rawConfig?: unknown;
  configRevision?: string;
  /** Pinned from the platform top-level strategy position contract on L1 fill. */
  positionSizeAtOpen?: KamaRainbowMartinPositionSize;
}

function hasActivePosition(state: StrategyState): boolean {
  return state.currentLayer > 0 && state.totalSize > 0 && state.avgPrice > 0;
}

function cloneState(state: StrategyState): KamaRainbowMartinRuntimeState {
  const source = state as KamaRainbowMartinRuntimeState;
  return {
    ...source,
    kamaRainbowMartinRuntime: createKamaRainbowMartinRuntimeMeta(source.kamaRainbowMartinRuntime),
  };
}

function getManagementConfig(runtime: KamaRainbowMartinRuntimeMeta, rawConfig: unknown): KamaRainbowMartinConfig {
  if (runtime.configAtOpen) return validateKamaRainbowMartinConfig(runtime.configAtOpen).config;
  return validateKamaRainbowMartinConfig(rawConfig ?? createKamaRainbowMartinDefaultConfig()).config;
}

export function calculateKamaRainbowMartinProfitPct(state: StrategyState, currentPrice: number): number {
  if (!(state.avgPrice > 0) || !(currentPrice > 0)) return 0;
  return state.isLong
    ? ((currentPrice - state.avgPrice) / state.avgPrice) * 100
    : ((state.avgPrice - currentPrice) / state.avgPrice) * 100;
}

export function calculateKamaRainbowMartinTrailing(
  profitPct: number,
  runtime: Pick<KamaRainbowMartinRuntimeMeta, "trailingActive" | "peakProfitPct">,
  config: KamaRainbowMartinConfig,
): { active: boolean; peakProfitPct: number; triggerProfitPct: number | null } {
  if (!config.trailing.enabled) return { active: false, peakProfitPct: 0, triggerProfitPct: null };
  const peakProfitPct = Math.max(runtime.peakProfitPct, profitPct);
  const active = runtime.trailingActive || profitPct >= config.trailing.activationPct;
  if (!active) return { active: false, peakProfitPct, triggerProfitPct: null };
  const steps = Math.floor(
    Math.max(0, peakProfitPct - config.trailing.activationPct) / config.trailing.stepPct + 1e-12,
  );
  const triggerProfitPct = config.trailing.activationPct
    - config.trailing.callbackPct
    + steps * config.trailing.stepPct;
  return { active: true, peakProfitPct, triggerProfitPct };
}

function calculateNextTriggerPrice(state: StrategyState, runtime: KamaRainbowMartinRuntimeMeta, gapPct: number): number | null {
  const anchor = runtime.lastLayerFillPrice > 0 ? runtime.lastLayerFillPrice : state.lastLayerPrice;
  if (!(anchor > 0) || state.currentLayer <= 0) return null;
  return state.isLong ? anchor * (1 - gapPct / 100) : anchor * (1 + gapPct / 100);
}

function calculateDistanceToTriggerPct(state: StrategyState, price: number, trigger: number | null): number | null {
  if (!(price > 0) || trigger == null || !(trigger > 0)) return null;
  const distance = state.isLong ? ((price - trigger) / price) * 100 : ((trigger - price) / price) * 100;
  return Math.max(0, distance);
}

function decide(
  state: KamaRainbowMartinRuntimeState,
  runtime: KamaRainbowMartinRuntimeMeta,
  eventKey: string,
  now: number,
  metrics: KamaRainbowMartinManagementMetrics,
  decision: Omit<KamaRainbowMartinManagementDecision, "eventKey" | "metrics" | "nextState">,
): KamaRainbowMartinManagementDecision {
  state.kamaRainbowMartinRuntime = createKamaRainbowMartinRuntimeMeta({
    ...runtime,
    trailingActive: metrics.trailingActive,
    peakProfitPct: metrics.peakProfitPct,
    triggerProfitPct: metrics.triggerProfitPct,
    lastRiskEventKey: eventKey,
    lastActionTimestamp: now,
    lastActionSignature: `${decision.action}:${decision.reasonCode}${decision.layerNum ? `:L${decision.layerNum}` : ""}`,
    lastDecisionReason: decision.reason,
  });
  return { ...decision, eventKey, metrics, nextState: state };
}

export function evaluateKamaRainbowMartinManagement(
  input: KamaRainbowMartinManagementInput,
  state: StrategyState,
  rawConfig: unknown = createKamaRainbowMartinDefaultConfig(),
): KamaRainbowMartinManagementDecision {
  const nextState = cloneState(state);
  const runtime = createKamaRainbowMartinRuntimeMeta(nextState.kamaRainbowMartinRuntime);
  const config = getManagementConfig(runtime, rawConfig);
  const currentPrice = input.currentPrice;
  const eventKey = input.riskEventKey?.trim() || String(input.now);
  const profitPct = calculateKamaRainbowMartinProfitPct(nextState, currentPrice);
  const currentAddLayer = Math.max(0, nextState.currentLayer - 1);
  const activeProtection = getKamaRainbowMartinLayerProtection(
    currentAddLayer,
    config.layerConfigs,
    config.hardStopLossPct,
    config.trailing,
  );
  const trailing = calculateKamaRainbowMartinTrailing(profitPct, runtime, {
    ...config,
    hardStopLossPct: activeProtection.hardStopLossPct,
    trailing: activeProtection.trailing,
  });
  const nextAddLayer = currentAddLayer < config.maxLayers ? currentAddLayer + 1 : null;
  const nextLayer = nextAddLayer == null ? null : nextAddLayer + 1;
  const nextGapPct = nextAddLayer == null
    ? null
    : getLayerGapPct(nextAddLayer, config.layerConfigs, config.gapPct);
  const nextTriggerPrice = nextGapPct == null
    ? null
    : calculateNextTriggerPrice(nextState, runtime, nextGapPct);
  const metrics: KamaRainbowMartinManagementMetrics = {
    profitPct,
    hardStopLossPct: activeProtection.hardStopLossPct,
    trailingEnabled: activeProtection.trailing.enabled,
    trailingActive: trailing.active,
    peakProfitPct: trailing.peakProfitPct,
    triggerProfitPct: trailing.triggerProfitPct,
    currentLayer: nextState.currentLayer,
    currentAddLayer,
    maxLayers: config.maxLayers + 1,
    maxAddLayers: config.maxLayers,
    nextLayer,
    nextAddLayer,
    nextGapPct,
    nextTriggerPrice,
    distanceToNextLayerPct: calculateDistanceToTriggerPct(nextState, currentPrice, nextTriggerPrice),
    averageCost: nextState.avgPrice,
    baseFillPrice: runtime.baseFillPrice,
    lastLayerFillPrice: runtime.lastLayerFillPrice || nextState.lastLayerPrice,
    totalQuantity: nextState.totalSize,
    configRevisionAtOpen: runtime.configRevisionAtOpen,
    killed: runtime.killed,
  };

  if (!hasActivePosition(nextState)) {
    return decide(nextState, runtime, eventKey, input.now, metrics, {
      action: "hold",
      reasonCode: "KRM_MANAGE_NO_POSITION",
      reason: runtime.killed ? "KILL 鎖定中且目標腿無持倉" : "目標腿無有效持倉",
      price: currentPrice,
    });
  }
  // KILL is close-only and outranks quote validation, alpha, hard stop and add-layer logic.
  if (runtime.killed) {
    return decide(nextState, runtime, eventKey, input.now, metrics, {
      action: "close",
      reasonCode: "KRM_KILL_CLOSE",
      reason: "KILL 已鎖定：僅平此 deployment leg 可證明擁有的精確數量",
      price: currentPrice,
      closeReason: "KILL",
    });
  }
  if (!(currentPrice > 0) || !Number.isFinite(currentPrice)) {
    return decide(nextState, runtime, eventKey, input.now, metrics, {
      action: "hold",
      reasonCode: "KRM_MANAGE_PRICE_INVALID",
      reason: "fresh quote／mark price 無效，禁止新增曝險",
      price: currentPrice,
    });
  }
  if (runtime.lastRiskEventKey === eventKey) {
    return decide(nextState, runtime, eventKey, input.now, metrics, {
      action: "hold",
      reasonCode: "KRM_RISK_EVENT_DUPLICATE",
      reason: "相同腿級風險事件已處理，阻止重複委託",
      price: currentPrice,
    });
  }
  if (profitPct <= -activeProtection.hardStopLossPct) {
    return decide(nextState, runtime, eventKey, input.now, metrics, {
      action: "close",
      reasonCode: "KRM_HARD_STOP",
      reason: `硬止損：浮盈 ${profitPct.toFixed(4)}% ≤ -${activeProtection.hardStopLossPct}%`,
      price: currentPrice,
      closeReason: "HARD_STOP",
    });
  }
  if (trailing.active && trailing.triggerProfitPct != null && profitPct <= trailing.triggerProfitPct) {
    return decide(nextState, runtime, eventKey, input.now, metrics, {
      action: "close",
      reasonCode: "KRM_TRAILING_EXIT",
      reason: `階梯移動止盈：浮盈 ${profitPct.toFixed(4)}% ≤ 觸發線 ${trailing.triggerProfitPct.toFixed(4)}%`,
      price: currentPrice,
      closeReason: "TRAILING_TAKE_PROFIT",
    });
  }

  if (nextLayer != null && nextAddLayer != null && nextGapPct != null && nextTriggerPrice != null) {
    const triggered = nextState.isLong ? currentPrice <= nextTriggerPrice : currentPrice >= nextTriggerPrice;
    if (triggered) {
      const cumulativeMultiplier = getKamaRainbowMartinCumulativeMultiplier(
        nextAddLayer,
        config.layerConfigs,
        config.multiplier,
      );
      return decide(nextState, runtime, eventKey, input.now, metrics, {
        action: nextState.isLong ? "add_long" : "add_short",
        reasonCode: "KRM_MARTIN_ADD",
        reason: `分層馬丁加倉 L${nextAddLayer}（持倉層 L${nextLayer}）：相對上一層實際成交價逆向 ${nextGapPct}%，累積倍率 ${cumulativeMultiplier.toFixed(4)}x`,
        price: currentPrice,
        layerNum: nextLayer,
        orderSize: multiplyKamaRainbowMartinPositionSize(
          runtime.initialPositionSize ?? { mode: "quantity", value: runtime.fills.filter(fill => fill.layer === 1).reduce((sum, fill) => sum + fill.quantity, 0) },
          cumulativeMultiplier,
        ),
      });
    }
  }

  if (nextLayer == null) {
    return decide(nextState, runtime, eventKey, input.now, metrics, {
      action: "hold",
      reasonCode: "KRM_MARTIN_MAX_LAYER",
      reason: `已完成最大加倉層 L${config.maxLayers}（連同底倉共 ${config.maxLayers + 1} 層）；只監控 KILL、硬止損與 trailing`,
      price: currentPrice,
    });
  }
  return decide(nextState, runtime, eventKey, input.now, metrics, {
    action: "hold",
    reasonCode: "KRM_MARTIN_WAIT",
    reason: `目前完成加倉 L${currentAddLayer}（持倉層 L${nextState.currentLayer}）；下一加倉 L${nextAddLayer} 尚未達上一層 fill 的 ${nextGapPct}% 逆向偏離`,
    price: currentPrice,
  });
}

function validateFill(fill: KamaRainbowMartinFillInput): void {
  if (!fill.fillId.trim()) throw new Error("Kama 彩虹馬丁 fillId 不可為空");
  if (!(fill.fillPrice > 0) || !Number.isFinite(fill.fillPrice)) throw new Error("Kama 彩虹馬丁成交價必須大於 0");
  if (!(fill.fillQuantity > 0) || !Number.isFinite(fill.fillQuantity)) throw new Error("Kama 彩虹馬丁成交量必須大於 0");
  if (!(fill.timestamp > 0) || !Number.isFinite(fill.timestamp)) throw new Error("Kama 彩虹馬丁成交時間無效");
}

function layerVwap(fills: readonly KamaRainbowMartinFillRecord[], layer: number): number {
  const selected = fills.filter(fill => fill.layer === layer);
  const quantity = selected.reduce((sum, fill) => sum + fill.quantity, 0);
  return quantity > 0 ? selected.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) / quantity : 0;
}

export function applyKamaRainbowMartinFillToState(
  state: StrategyState,
  fill: KamaRainbowMartinFillInput,
): KamaRainbowMartinRuntimeState {
  validateFill(fill);
  const nextState = cloneState(state);
  const runtime = createKamaRainbowMartinRuntimeMeta(nextState.kamaRainbowMartinRuntime);
  if (runtime.killed) throw new Error("Kama 彩虹馬丁已被 KILL 鎖定，不可套用新增曝險成交");
  if (runtime.fills.some(item => item.fillId === fill.fillId)) return nextState;

  const longFill = fill.action === "OPEN_LONG" || fill.action === "ADD_LONG";
  const initialAction = fill.action === "OPEN_LONG" || fill.action === "OPEN_SHORT";
  const active = hasActivePosition(nextState);
  const targetLayer = fill.targetLayer ?? (initialAction ? 1 : nextState.currentLayer + 1);
  if (!Number.isSafeInteger(targetLayer) || targetLayer < 1) throw new Error("Kama 彩虹馬丁成交層數無效");
  if (active && nextState.isLong !== longFill) throw new Error("Kama 彩虹馬丁成交方向與既有腿不一致");
  if (!active && targetLayer !== 1) throw new Error("Kama 彩虹馬丁無底倉時只可套用 L1 成交");
  if (active && targetLayer < nextState.currentLayer) throw new Error("Kama 彩虹馬丁不可把成交套用到已完成的舊層");
  if (active && targetLayer > nextState.currentLayer + 1) throw new Error("Kama 彩虹馬丁不可跳層套用成交");

  const configValidation = validateKamaRainbowMartinConfig(
    active && runtime.configAtOpen ? runtime.configAtOpen : fill.rawConfig ?? createKamaRainbowMartinDefaultConfig(),
  );
  if (!active && !configValidation.valid) {
    throw new Error(`Kama 彩虹馬丁底倉配置無效：${configValidation.issues.map(issue => issue.path).join(", ")}`);
  }
  const config = configValidation.config;
  if (targetLayer > config.maxLayers + 1) {
    throw new Error("Kama 彩虹馬丁成交層數超過 pinned 最大加倉層（含底倉偏移）");
  }

  const record: KamaRainbowMartinFillRecord = {
    fillId: fill.fillId,
    orderId: fill.orderId?.trim() || null,
    layer: targetLayer,
    side: longFill ? "long" : "short",
    price: fill.fillPrice,
    quantity: fill.fillQuantity,
    timestamp: fill.timestamp,
  };
  const fills = [...runtime.fills, record];
  nextState.totalCost += fill.fillPrice * fill.fillQuantity;
  nextState.totalSize += fill.fillQuantity;
  nextState.avgPrice = nextState.totalCost / nextState.totalSize;
  nextState.currentLayer = Math.max(nextState.currentLayer, targetLayer);
  nextState.lastLayerPrice = layerVwap(fills, nextState.currentLayer);
  nextState.isLong = longFill;
  nextState.highestPrice = !active ? fill.fillPrice : nextState.isLong ? Math.max(nextState.highestPrice, fill.fillPrice) : nextState.highestPrice;
  nextState.lowestPrice = !active ? fill.fillPrice : nextState.isLong ? nextState.lowestPrice : Math.min(nextState.lowestPrice, fill.fillPrice);
  nextState.isTrailingActivated = false;

  const baseFillPrice = layerVwap(fills, 1);
  nextState.kamaRainbowMartinRuntime = createKamaRainbowMartinRuntimeMeta({
    ...runtime,
    entryTimestamp: active ? runtime.entryTimestamp : fill.timestamp,
    baseFillPrice,
    lastLayerFillPrice: nextState.lastLayerPrice,
    configRevisionAtOpen: active ? runtime.configRevisionAtOpen : fill.configRevision?.trim() || config.version,
    configAtOpen: active ? runtime.configAtOpen : config,
    initialPositionSize: active
      ? runtime.initialPositionSize
      : fill.positionSizeAtOpen && fill.positionSizeAtOpen.value > 0
        ? { ...fill.positionSizeAtOpen }
        : { mode: "quantity", value: fill.fillQuantity },
    fills,
    trailingActive: false,
    peakProfitPct: 0,
    triggerProfitPct: null,
    lastActionTimestamp: fill.timestamp,
    lastActionSignature: `${fill.action}:L${targetLayer}:${fill.fillId}`,
    lastDecisionReason: `成交已確認：${longFill ? "多" : "空"} L${targetLayer} @ ${fill.fillPrice} × ${fill.fillQuantity}`,
  });
  return nextState;
}

export function applyKamaRainbowMartinCloseToState(
  state: StrategyState,
  closeReason: KamaRainbowMartinCloseReason,
  timestamp: number,
): KamaRainbowMartinRuntimeState {
  const previous = state as KamaRainbowMartinRuntimeState;
  const runtime = createKamaRainbowMartinRuntimeMeta(previous.kamaRainbowMartinRuntime);
  const killed = closeReason === "KILL" || runtime.killed;
  return createKamaRainbowMartinRuntimeState({
    capital: state.capital,
    lockedBarTimestamp: timestamp,
    kamaRainbowMartinRuntime: {
      ...runtime,
      killed,
      killRequestedAt: killed ? runtime.killRequestedAt || timestamp : 0,
      entryTimestamp: 0,
      baseFillPrice: 0,
      lastLayerFillPrice: 0,
      configRevisionAtOpen: "",
      configAtOpen: null,
      initialPositionSize: null,
      fills: [],
      trailingActive: false,
      peakProfitPct: 0,
      triggerProfitPct: null,
      lastRiskEventKey: "",
      lastActionTimestamp: timestamp,
      lastActionSignature: `close:${closeReason}`,
      lastCloseReason: closeReason,
      lastDecisionReason: killed ? "KILL 平倉完成，策略維持鎖定" : `腿級平倉完成：${closeReason}`,
    },
  });
}

export function applyKamaRainbowMartinPartialCloseToState(
  state: StrategyState,
  closedQuantity: number,
  closeReason: KamaRainbowMartinCloseReason,
  timestamp: number,
): KamaRainbowMartinRuntimeState {
  if (!(closedQuantity > 0) || !Number.isFinite(closedQuantity)) {
    throw new Error("Kama 彩虹馬丁部分平倉數量必須大於 0");
  }
  if (!(state.totalSize > 0) || closedQuantity >= state.totalSize - 1e-12) {
    return applyKamaRainbowMartinCloseToState(state, closeReason, timestamp);
  }

  const nextState = cloneState(state);
  const runtime = createKamaRainbowMartinRuntimeMeta(nextState.kamaRainbowMartinRuntime);
  const remainingQuantity = nextState.totalSize - closedQuantity;
  nextState.totalSize = remainingQuantity;
  nextState.totalCost = nextState.avgPrice * remainingQuantity;
  nextState.kamaRainbowMartinRuntime = createKamaRainbowMartinRuntimeMeta({
    ...runtime,
    lastActionTimestamp: timestamp,
    lastActionSignature: `partial-close:${closeReason}:${closedQuantity}`,
    lastCloseReason: closeReason,
    lastDecisionReason: `腿級部分平倉 ${closedQuantity}；剩餘 ${remainingQuantity}`,
  });
  return nextState;
}

export function requestKamaRainbowMartinKill(state: StrategyState, timestamp: number): KamaRainbowMartinRuntimeState {
  const nextState = cloneState(state);
  const runtime = createKamaRainbowMartinRuntimeMeta(nextState.kamaRainbowMartinRuntime);
  nextState.kamaRainbowMartinRuntime = createKamaRainbowMartinRuntimeMeta({
    ...runtime,
    killed: true,
    killRequestedAt: timestamp,
    lastActionTimestamp: timestamp,
    lastActionSignature: "kill:requested",
    lastDecisionReason: hasActivePosition(nextState) ? "KILL 已鎖定；等待精確關閉此腿" : "KILL 已鎖定；此腿目前無持倉",
  });
  return nextState;
}

export function releaseKamaRainbowMartinKill(state: StrategyState, timestamp: number): KamaRainbowMartinRuntimeState {
  if (hasActivePosition(state)) throw new Error("Kama 彩虹馬丁尚有持倉時不可解除 KILL");
  const nextState = cloneState(state);
  const runtime = createKamaRainbowMartinRuntimeMeta(nextState.kamaRainbowMartinRuntime);
  nextState.kamaRainbowMartinRuntime = createKamaRainbowMartinRuntimeMeta({
    ...runtime,
    killed: false,
    killRequestedAt: 0,
    lastActionTimestamp: timestamp,
    lastActionSignature: "kill:released",
    lastDecisionReason: "KILL 已人工解除；等待下一根已收盤 K 線",
  });
  return nextState;
}
