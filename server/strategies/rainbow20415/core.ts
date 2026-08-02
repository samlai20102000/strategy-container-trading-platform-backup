import {
  RAINBOW_20415_CONFIG_VERSION,
  RAINBOW_20415_LINE_IDS,
  assertValidRainbow20415Config,
  createRainbow20415DefaultConfig,
  deriveRainbow20415FinalEnabledLayer,
  getRainbow20415EffectiveSpacing,
  getRainbow20415NextEnabledLayer,
  type Rainbow20415BaseLot,
  type Rainbow20415Config,
  type Rainbow20415LineConfig,
  type Rainbow20415LineId,
} from "../../../shared/strategies/rainbow20415";
import {
  createInitialStrategyState,
  type KLineData,
  type StrategyState,
} from "../base";

export type Rainbow20415AllowedDirection = "long" | "short" | "both";
export type Rainbow20415SlopeDirection = "UP" | "DOWN" | "MIXED" | "INSUFFICIENT";
export type Rainbow20415CoreAction = "buy" | "sell" | "add_long" | "add_short" | "close" | "hold";
export type Rainbow20415CloseReason =
  | "TAKE_PROFIT"
  | "MAX_HOLD"
  | "MARGIN_LIMIT"
  | "MAX_ACCOUNT_LOSS"
  | "MANUAL"
  | "OTHER";

export interface Rainbow20415LineSnapshot {
  current: Partial<Record<Rainbow20415LineId, number>>;
  previous: Partial<Record<Rainbow20415LineId, number>>;
  slopes: Partial<Record<Rainbow20415LineId, number>>;
  currentRank: Rainbow20415LineId[];
  previousRank: Rainbow20415LineId[];
  slopeDirection: Rainbow20415SlopeDirection;
  noCross: boolean;
  hasTies: boolean;
  ready: boolean;
  requiredBars: number;
  availableBars: number;
  barTimestamp: number;
}

export interface Rainbow20415PrecomputedBar {
  snapshot: Rainbow20415LineSnapshot;
  currentPrice: number;
}

export interface Rainbow20415RuntimeMeta {
  configVersion: typeof RAINBOW_20415_CONFIG_VERSION;
  blindMode: boolean;
  entryTimestamp: number;
  entryAccountEquity: number;
  pendingReentry: boolean;
  reentryReadyAt: number;
  lastCloseReason: Rainbow20415CloseReason | null;
  lastScanBarTimestamp: number;
  lastEntryBarTimestamp: number;
  lastManagedAt: number;
  lastActionTimestamp: number;
  lastActionSignature: string;
  lastDecisionReason: string;
  currentRank: Rainbow20415LineId[];
  previousRank: Rainbow20415LineId[];
  slopeDirection: Rainbow20415SlopeDirection;
  noCross: boolean;
  currentLineValues: Partial<Record<Rainbow20415LineId, number>>;
  previousLineValues: Partial<Record<Rainbow20415LineId, number>>;
  lineSlopes: Partial<Record<Rainbow20415LineId, number>>;
}

export interface Rainbow20415RuntimeState extends StrategyState {
  rainbow20415Runtime?: Rainbow20415RuntimeMeta;
}

export interface Rainbow20415AccountMetrics {
  /** 帳戶權益；實盤由交易所帳戶回報，回測由模擬權益提供。 */
  equity?: number;
  /** 帳戶餘額；僅作診斷，不取代真實權益。 */
  balance?: number;
  /** 已用保證金。 */
  usedMargin?: number;
  /** 已計算的保證金使用率；若提供則優先使用。 */
  marginUsagePct?: number;
  /** 帳戶損益百分比，盈利為正、虧損為負；若提供則優先使用。 */
  accountPnlPct?: number;
}

export interface Rainbow20415EntryMetrics {
  mode: "SCAN";
  lines: Rainbow20415LineSnapshot;
  isLongEntry: boolean;
  isShortEntry: boolean;
}

export interface Rainbow20415ManagementMetrics {
  mode: "BLIND";
  profitPct: number;
  holdHours: number;
  marginUsagePct: number | null;
  accountPnlPct: number | null;
  accountLossPct: number | null;
  currentLayer: number;
  finalEnabledLayer: number;
  nextLayer: number | null;
  nextSpacingPct: number | null;
  nextTriggerPrice: number | null;
}

export type Rainbow20415DecisionMetrics = Rainbow20415EntryMetrics | Rainbow20415ManagementMetrics;

export interface Rainbow20415CoreDecision {
  action: Rainbow20415CoreAction;
  reason: string;
  price: number;
  orderSize?: Rainbow20415BaseLot;
  layerNum?: number;
  closeReason?: Rainbow20415CloseReason;
  nextState: Rainbow20415RuntimeState;
  metrics: Rainbow20415DecisionMetrics;
}

export interface Rainbow20415ManagementInput {
  currentPrice: number;
  now: number;
  account?: Rainbow20415AccountMetrics;
}

export interface Rainbow20415FillInput {
  action: "buy" | "sell" | "add_long" | "add_short";
  fillPrice: number;
  fillQuantity: number;
  timestamp: number;
  barTimestamp?: number;
  targetLayer?: number;
  accountEquity?: number;
}

const EMPTY_LINE_SNAPSHOT: Rainbow20415LineSnapshot = {
  current: {},
  previous: {},
  slopes: {},
  currentRank: [],
  previousRank: [],
  slopeDirection: "INSUFFICIENT",
  noCross: false,
  hasTies: false,
  ready: false,
  requiredBars: 0,
  availableBars: 0,
  barTimestamp: 0,
};

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function roundOrderValue(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function hasActivePosition(state: StrategyState): boolean {
  return state.currentLayer > 0 && state.totalSize > 0 && state.avgPrice > 0;
}

export function createRainbow20415RuntimeMeta(
  seed?: Partial<Rainbow20415RuntimeMeta>,
): Rainbow20415RuntimeMeta {
  return {
    configVersion: RAINBOW_20415_CONFIG_VERSION,
    blindMode: false,
    entryTimestamp: 0,
    entryAccountEquity: 0,
    pendingReentry: false,
    reentryReadyAt: 0,
    lastCloseReason: null,
    lastScanBarTimestamp: 0,
    lastEntryBarTimestamp: 0,
    lastManagedAt: 0,
    lastActionTimestamp: 0,
    lastActionSignature: "",
    lastDecisionReason: "尚未執行 20415 決策",
    slopeDirection: "INSUFFICIENT",
    noCross: false,
    ...seed,
    currentRank: [...(seed?.currentRank ?? [])],
    previousRank: [...(seed?.previousRank ?? [])],
    currentLineValues: { ...(seed?.currentLineValues ?? {}) },
    previousLineValues: { ...(seed?.previousLineValues ?? {}) },
    lineSlopes: { ...(seed?.lineSlopes ?? {}) },
  };
}

export function createRainbow20415RuntimeState(
  seed?: Partial<Rainbow20415RuntimeState>,
): Rainbow20415RuntimeState {
  const source = seed ?? {};
  return {
    ...createInitialStrategyState(),
    ...source,
    rainbow20415Runtime: createRainbow20415RuntimeMeta(source.rainbow20415Runtime),
  };
}

function cloneRainbow20415State(state: StrategyState): Rainbow20415RuntimeState {
  const source = state as Rainbow20415RuntimeState;
  return {
    ...source,
    rainbow20415Runtime: createRainbow20415RuntimeMeta(source.rainbow20415Runtime),
  };
}

function calculateSmaSeries(values: readonly number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return result;
  let rolling = 0;
  for (let index = 0; index < values.length; index += 1) {
    rolling += values[index];
    if (index >= period) rolling -= values[index - period];
    if (index >= period - 1) result[index] = rolling / period;
  }
  return result;
}

function calculateEmaSeries(values: readonly number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return result;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = seed;
  const alpha = 2 / (period + 1);
  let previous = seed;
  for (let index = period; index < values.length; index += 1) {
    previous = values[index] * alpha + previous * (1 - alpha);
    result[index] = previous;
  }
  return result;
}

function calculateWmaSeries(values: readonly number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return result;
  const denominator = (period * (period + 1)) / 2;
  for (let index = period - 1; index < values.length; index += 1) {
    let weighted = 0;
    for (let offset = 0; offset < period; offset += 1) {
      weighted += values[index - period + 1 + offset] * (offset + 1);
    }
    result[index] = weighted / denominator;
  }
  return result;
}

export function calculateRainbow20415LineSeries(
  closes: readonly number[],
  line: Rainbow20415LineConfig,
): Array<number | null> {
  if (line.type === "SMA") return calculateSmaSeries(closes, line.period);
  if (line.type === "WMA") return calculateWmaSeries(closes, line.period);
  return calculateEmaSeries(closes, line.period);
}

function valuesAreTied(first: number, second: number): boolean {
  const scale = Math.max(1, Math.abs(first), Math.abs(second));
  return Math.abs(first - second) <= Number.EPSILON * scale * 16;
}

function rankLineIds(values: Record<Rainbow20415LineId, number>): {
  rank: Rainbow20415LineId[];
  hasTies: boolean;
} {
  const rank = [...RAINBOW_20415_LINE_IDS].sort((left, right) => {
    const difference = values[right] - values[left];
    if (difference !== 0) return difference;
    return left.localeCompare(right);
  });
  let hasTies = false;
  for (let index = 1; index < rank.length; index += 1) {
    if (valuesAreTied(values[rank[index - 1]], values[rank[index]])) {
      hasTies = true;
      break;
    }
  }
  return { rank, hasTies };
}

export function calculateRainbow20415LineSnapshot(
  candles: readonly KLineData[],
  rawConfig: unknown = createRainbow20415DefaultConfig(),
): Rainbow20415LineSnapshot {
  const config = assertValidRainbow20415Config(rawConfig);
  const requiredBars = Math.max(...config.Lines.map((line) => line.period)) + 1;
  const barTimestamp = candles.at(-1)?.timestamp ?? 0;
  if (candles.length < requiredBars) {
    return {
      ...EMPTY_LINE_SNAPSHOT,
      requiredBars,
      availableBars: candles.length,
      barTimestamp,
    };
  }

  const closes = candles.map((candle) => candle.close);
  if (closes.some((close) => !Number.isFinite(close) || close <= 0)) {
    return {
      ...EMPTY_LINE_SNAPSHOT,
      requiredBars,
      availableBars: candles.length,
      barTimestamp,
    };
  }

  const currentIndex = candles.length - 1;
  const previousIndex = currentIndex - 1;
  const current = {} as Record<Rainbow20415LineId, number>;
  const previous = {} as Record<Rainbow20415LineId, number>;
  const slopes = {} as Record<Rainbow20415LineId, number>;

  for (const line of config.Lines) {
    const series = calculateRainbow20415LineSeries(closes, line);
    const currentValue = series[currentIndex];
    const previousValue = series[previousIndex];
    if (currentValue == null || previousValue == null) {
      return {
        ...EMPTY_LINE_SNAPSHOT,
        requiredBars,
        availableBars: candles.length,
        barTimestamp,
      };
    }
    current[line.id] = currentValue;
    previous[line.id] = previousValue;
    slopes[line.id] = currentValue - previousValue;
  }

  const slopeValues = RAINBOW_20415_LINE_IDS.map((lineId) => slopes[lineId]);
  const slopeDirection: Rainbow20415SlopeDirection = slopeValues.every((value) => value > 0)
    ? "UP"
    : slopeValues.every((value) => value < 0)
      ? "DOWN"
      : "MIXED";
  const currentRankResult = rankLineIds(current);
  const previousRankResult = rankLineIds(previous);
  const noCross =
    !currentRankResult.hasTies &&
    !previousRankResult.hasTies &&
    currentRankResult.rank.every((lineId, index) => previousRankResult.rank[index] === lineId);

  return {
    current,
    previous,
    slopes,
    currentRank: currentRankResult.rank,
    previousRank: previousRankResult.rank,
    slopeDirection,
    noCross,
    hasTies: currentRankResult.hasTies || previousRankResult.hasTies,
    ready: true,
    requiredBars,
    availableBars: candles.length,
    barTimestamp,
  };
}

export function calculateRainbow20415LineSnapshotSeries(
  candles: readonly KLineData[],
  rawConfig: unknown = createRainbow20415DefaultConfig(),
): Rainbow20415LineSnapshot[] {
  const config = assertValidRainbow20415Config(rawConfig);
  const requiredBars = Math.max(...config.Lines.map(line => line.period)) + 1;
  const emptyAt = (index: number): Rainbow20415LineSnapshot => ({
    ...EMPTY_LINE_SNAPSHOT,
    current: {},
    previous: {},
    slopes: {},
    currentRank: [],
    previousRank: [],
    requiredBars,
    availableBars: index + 1,
    barTimestamp: candles[index]?.timestamp ?? 0,
  });
  const snapshots = candles.map((_candle, index) => emptyAt(index));
  const firstInvalidIndex = candles.findIndex(
    candle => !Number.isFinite(candle.close) || candle.close <= 0,
  );
  const validLength = firstInvalidIndex < 0 ? candles.length : firstInvalidIndex;
  if (validLength < requiredBars) return snapshots;

  const closes = candles.slice(0, validLength).map(candle => candle.close);
  const lineSeries = config.Lines.map(line => ({
    line,
    series: calculateRainbow20415LineSeries(closes, line),
  }));
  for (let index = requiredBars - 1; index < validLength; index += 1) {
    const current = {} as Record<Rainbow20415LineId, number>;
    const previous = {} as Record<Rainbow20415LineId, number>;
    const slopes = {} as Record<Rainbow20415LineId, number>;
    let ready = true;
    for (const { line, series } of lineSeries) {
      const currentValue = series[index];
      const previousValue = series[index - 1];
      if (currentValue == null || previousValue == null) {
        ready = false;
        break;
      }
      current[line.id] = currentValue;
      previous[line.id] = previousValue;
      slopes[line.id] = currentValue - previousValue;
    }
    if (!ready) continue;
    const slopeValues = RAINBOW_20415_LINE_IDS.map(lineId => slopes[lineId]);
    const slopeDirection: Rainbow20415SlopeDirection = slopeValues.every(value => value > 0)
      ? "UP"
      : slopeValues.every(value => value < 0)
        ? "DOWN"
        : "MIXED";
    const currentRankResult = rankLineIds(current);
    const previousRankResult = rankLineIds(previous);
    const noCross = !currentRankResult.hasTies
      && !previousRankResult.hasTies
      && currentRankResult.rank.every((lineId, rankIndex) => previousRankResult.rank[rankIndex] === lineId);
    snapshots[index] = {
      current,
      previous,
      slopes,
      currentRank: currentRankResult.rank,
      previousRank: previousRankResult.rank,
      slopeDirection,
      noCross,
      hasTies: currentRankResult.hasTies || previousRankResult.hasTies,
      ready: true,
      requiredBars,
      availableBars: index + 1,
      barTimestamp: candles[index]?.timestamp ?? 0,
    };
  }
  return snapshots;
}

function updateObservationState(
  state: Rainbow20415RuntimeState,
  snapshot: Rainbow20415LineSnapshot,
  reason: string,
): Rainbow20415RuntimeState {
  state.rainbow20415Runtime = createRainbow20415RuntimeMeta({
    ...state.rainbow20415Runtime,
    blindMode: hasActivePosition(state),
    lastScanBarTimestamp: snapshot.ready
      ? snapshot.barTimestamp
      : state.rainbow20415Runtime?.lastScanBarTimestamp ?? 0,
    lastDecisionReason: reason,
    currentRank: snapshot.currentRank,
    previousRank: snapshot.previousRank,
    slopeDirection: snapshot.slopeDirection,
    noCross: snapshot.noCross,
    currentLineValues: snapshot.current,
    previousLineValues: snapshot.previous,
    lineSlopes: snapshot.slopes,
  });
  return state;
}

function entryHold(
  reason: string,
  price: number,
  state: Rainbow20415RuntimeState,
  snapshot: Rainbow20415LineSnapshot,
  isLongEntry = false,
  isShortEntry = false,
): Rainbow20415CoreDecision {
  return {
    action: "hold",
    reason,
    price,
    nextState: updateObservationState(state, snapshot, reason),
    metrics: { mode: "SCAN", lines: snapshot, isLongEntry, isShortEntry },
  };
}

export function evaluateRainbow20415Entry(
  candles: readonly KLineData[],
  state: StrategyState,
  rawConfig: unknown = createRainbow20415DefaultConfig(),
  allowedDirection: Rainbow20415AllowedDirection = "both",
  precomputed?: Rainbow20415PrecomputedBar,
): Rainbow20415CoreDecision {
  const config = assertValidRainbow20415Config(rawConfig);
  const nextState = cloneRainbow20415State(state);
  const currentPrice = precomputed?.currentPrice ?? candles.at(-1)?.close ?? 0;
  const snapshot = precomputed?.snapshot ?? calculateRainbow20415LineSnapshot(candles, config);

  if (hasActivePosition(nextState)) {
    return entryHold("持倉盲人模式中：七線不干預既有倉位", currentPrice, nextState, snapshot);
  }
  if (!snapshot.ready) {
    return entryHold(
      `M30 七線數據不足：需要 ${snapshot.requiredBars} 根，現有 ${snapshot.availableBars} 根`,
      currentPrice,
      nextState,
      snapshot,
    );
  }

  const runtime = createRainbow20415RuntimeMeta(nextState.rainbow20415Runtime);
  if (runtime.lastScanBarTimestamp === snapshot.barTimestamp && !runtime.pendingReentry) {
    return entryHold("此 M30 收盤 K 棒已完成七線掃描", currentPrice, nextState, snapshot);
  }
  if (runtime.pendingReentry && snapshot.barTimestamp < runtime.reentryReadyAt) {
    return entryHold(
      `無縫重入冷卻中，最早可於 ${new Date(runtime.reentryReadyAt).toISOString()} 再評估`,
      currentPrice,
      nextState,
      snapshot,
    );
  }

  const isLongEntry =
    snapshot.slopeDirection === "UP" && snapshot.noCross && allowedDirection !== "short";
  const isShortEntry =
    snapshot.slopeDirection === "DOWN" && snapshot.noCross && allowedDirection !== "long";
  const metrics: Rainbow20415EntryMetrics = {
    mode: "SCAN",
    lines: snapshot,
    isLongEntry,
    isShortEntry,
  };

  if (!isLongEntry && !isShortEntry) {
    if (runtime.pendingReentry && snapshot.barTimestamp >= runtime.reentryReadyAt) {
      nextState.rainbow20415Runtime = createRainbow20415RuntimeMeta({
        ...runtime,
        pendingReentry: false,
        reentryReadyAt: 0,
        lastDecisionReason: "七線結構已破壞，取消無縫重入並回到空倉掃描",
      });
    }
    const reason = snapshot.hasTies
      ? "七線出現同值，排名不可判定，等待下一根 M30"
      : !snapshot.noCross
        ? "七線排名序列改變，檢出交叉，禁止進場"
        : snapshot.slopeDirection === "MIXED"
          ? "七線斜率未全同向，禁止進場"
          : "策略方向限制阻擋本次七線訊號";
    return {
      action: "hold",
      reason,
      price: currentPrice,
      nextState: updateObservationState(nextState, snapshot, reason),
      metrics,
    };
  }

  const action = isLongEntry ? "buy" : "sell";
  const reason = `${isLongEntry ? "七線全數向上" : "七線全數向下"}且前後排名完全一致，${isLongEntry ? "建立多單底倉" : "建立空單底倉"}`;
  return {
    action,
    reason,
    price: currentPrice,
    orderSize: { ...config.Base_Lot_Size },
    layerNum: 1,
    nextState: updateObservationState(nextState, snapshot, reason),
    metrics,
  };
}

export function calculateRainbow20415ProfitPct(state: StrategyState, currentPrice: number): number {
  if (!(state.avgPrice > 0) || !(currentPrice > 0)) return 0;
  return state.isLong
    ? ((currentPrice - state.avgPrice) / state.avgPrice) * 100
    : ((state.avgPrice - currentPrice) / state.avgPrice) * 100;
}

function calculateMarginUsagePct(account?: Rainbow20415AccountMetrics): number | null {
  if (!account) return null;
  if (typeof account.marginUsagePct === "number" && Number.isFinite(account.marginUsagePct)) {
    return account.marginUsagePct;
  }
  if (
    typeof account.usedMargin === "number" &&
    Number.isFinite(account.usedMargin) &&
    typeof account.equity === "number" &&
    Number.isFinite(account.equity) &&
    account.equity > 0
  ) {
    return (account.usedMargin / account.equity) * 100;
  }
  return null;
}

function calculateAccountPnlPct(
  account: Rainbow20415AccountMetrics | undefined,
  entryAccountEquity: number,
): number | null {
  if (!account) return null;
  if (typeof account.accountPnlPct === "number" && Number.isFinite(account.accountPnlPct)) {
    return account.accountPnlPct;
  }
  if (
    entryAccountEquity > 0 &&
    typeof account.equity === "number" &&
    Number.isFinite(account.equity)
  ) {
    return ((account.equity - entryAccountEquity) / entryAccountEquity) * 100;
  }
  return null;
}

function managementDecision(
  decision: Omit<Rainbow20415CoreDecision, "nextState" | "metrics">,
  state: Rainbow20415RuntimeState,
  metrics: Rainbow20415ManagementMetrics,
  now: number,
): Rainbow20415CoreDecision {
  state.rainbow20415Runtime = createRainbow20415RuntimeMeta({
    ...state.rainbow20415Runtime,
    blindMode: hasActivePosition(state),
    lastManagedAt: now,
    lastDecisionReason: decision.reason,
  });
  return { ...decision, nextState: state, metrics };
}

export function evaluateRainbow20415Management(
  input: Rainbow20415ManagementInput,
  state: StrategyState,
  rawConfig: unknown = createRainbow20415DefaultConfig(),
): Rainbow20415CoreDecision {
  const config = assertValidRainbow20415Config(rawConfig);
  const nextState = cloneRainbow20415State(state);
  const currentPrice = input.currentPrice;
  const now = input.now;
  const runtime = createRainbow20415RuntimeMeta(nextState.rainbow20415Runtime);
  const finalEnabledLayer = deriveRainbow20415FinalEnabledLayer(config.Martin_Ranges);
  const nextLayerResult = getRainbow20415NextEnabledLayer(config.Martin_Ranges, nextState.currentLayer);
  const nextSpacingPct = nextLayerResult
    ? getRainbow20415EffectiveSpacing(config, nextLayerResult.range)
    : null;
  const nextTriggerPrice = nextSpacingPct == null || !(nextState.avgPrice > 0)
    ? null
    : nextState.isLong
      ? nextState.avgPrice * (1 - nextSpacingPct / 100)
      : nextState.avgPrice * (1 + nextSpacingPct / 100);
  const entryTimestamp = runtime.entryTimestamp > 0
    ? runtime.entryTimestamp
    : finiteOr(nextState.lockedBarTimestamp, 0);
  const holdHours = entryTimestamp > 0 && now >= entryTimestamp
    ? (now - entryTimestamp) / 3_600_000
    : 0;
  const profitPct = calculateRainbow20415ProfitPct(nextState, currentPrice);
  const marginUsagePct = calculateMarginUsagePct(input.account);
  const accountPnlPct = calculateAccountPnlPct(input.account, runtime.entryAccountEquity);
  const accountLossPct = accountPnlPct == null ? null : Math.max(0, -accountPnlPct);
  const metrics: Rainbow20415ManagementMetrics = {
    mode: "BLIND",
    profitPct,
    holdHours,
    marginUsagePct,
    accountPnlPct,
    accountLossPct,
    currentLayer: nextState.currentLayer,
    finalEnabledLayer,
    nextLayer: nextLayerResult?.layer ?? null,
    nextSpacingPct,
    nextTriggerPrice,
  };

  if (!hasActivePosition(nextState)) {
    return managementDecision(
      { action: "hold", reason: "無有效 20415 持倉，等待 M30 七線掃描", price: currentPrice },
      nextState,
      metrics,
      now,
    );
  }
  if (!(currentPrice > 0) || !Number.isFinite(currentPrice)) {
    return managementDecision(
      { action: "hold", reason: "即時價格無效，禁止產生平倉或加倉指令", price: currentPrice },
      nextState,
      metrics,
      now,
    );
  }

  if (profitPct >= config.Take_Profit_Pct) {
    return managementDecision(
      {
        action: "close",
        reason: `平均成本止盈：名義價格盈利 ${profitPct.toFixed(4)}% ≥ ${config.Take_Profit_Pct}%`,
        price: currentPrice,
        closeReason: "TAKE_PROFIT",
      },
      nextState,
      metrics,
      now,
    );
  }
  if (holdHours >= config.Max_Hold_Hours) {
    return managementDecision(
      {
        action: "close",
        reason: `持倉超時：${holdHours.toFixed(2)} 小時 ≥ ${config.Max_Hold_Hours} 小時`,
        price: currentPrice,
        closeReason: "MAX_HOLD",
      },
      nextState,
      metrics,
      now,
    );
  }
  if (marginUsagePct != null && marginUsagePct >= config.Max_Margin_Usage_Pct) {
    return managementDecision(
      {
        action: "close",
        reason: `保證金鐵幕：使用率 ${marginUsagePct.toFixed(2)}% ≥ ${config.Max_Margin_Usage_Pct}%`,
        price: currentPrice,
        closeReason: "MARGIN_LIMIT",
      },
      nextState,
      metrics,
      now,
    );
  }
  if (
    finalEnabledLayer > 0 &&
    nextState.currentLayer >= finalEnabledLayer &&
    accountLossPct != null &&
    accountLossPct >= config.Max_Account_Loss_Pct
  ) {
    return managementDecision(
      {
        action: "close",
        reason: `最終層帳戶虧損鐵幕：${accountLossPct.toFixed(2)}% ≥ ${config.Max_Account_Loss_Pct}%`,
        price: currentPrice,
        closeReason: "MAX_ACCOUNT_LOSS",
      },
      nextState,
      metrics,
      now,
    );
  }

  if (config.Martingale_Enabled && nextLayerResult && nextSpacingPct != null && nextTriggerPrice != null) {
    const triggered = nextState.isLong
      ? currentPrice <= nextTriggerPrice
      : currentPrice >= nextTriggerPrice;
    if (triggered) {
      if (marginUsagePct == null) {
        return managementDecision(
          {
            action: "hold",
            reason: "缺少真實保證金資料，安全封鎖馬丁加倉",
            price: currentPrice,
          },
          nextState,
          metrics,
          now,
        );
      }
      return managementDecision(
        {
          action: nextState.isLong ? "add_long" : "add_short",
          reason: `盲人模式加倉 L${nextLayerResult.layer}：現價相對加權均價逆向偏離至少 ${nextSpacingPct}%`,
          price: currentPrice,
          orderSize: {
            value: roundOrderValue(config.Base_Lot_Size.value * nextLayerResult.range.multiplier),
            mode: config.Base_Lot_Size.mode,
          },
          layerNum: nextLayerResult.layer,
        },
        nextState,
        metrics,
        now,
      );
    }
  }

  return managementDecision(
    {
      action: "hold",
      reason: nextLayerResult
        ? `盲人模式持倉：L${nextState.currentLayer}，下一層 L${nextLayerResult.layer} 尚未達 ${nextSpacingPct}% 逆向間距`
        : `盲人模式持倉：已達最後有效層 L${finalEnabledLayer}，僅監控止盈與三道風控`,
      price: currentPrice,
    },
    nextState,
    metrics,
    now,
  );
}

export function applyRainbow20415FillToState(
  state: StrategyState,
  fill: Rainbow20415FillInput,
): Rainbow20415RuntimeState {
  if (!(fill.fillPrice > 0) || !Number.isFinite(fill.fillPrice)) {
    throw new Error("20415 成交價格必須是大於 0 的有限數值");
  }
  if (!(fill.fillQuantity > 0) || !Number.isFinite(fill.fillQuantity)) {
    throw new Error("20415 成交數量必須是大於 0 的有限數值");
  }
  if (!Number.isFinite(fill.timestamp) || fill.timestamp <= 0) {
    throw new Error("20415 成交時間戳無效");
  }

  const nextState = cloneRainbow20415State(state);
  const runtime = createRainbow20415RuntimeMeta(nextState.rainbow20415Runtime);
  const isInitial = fill.action === "buy" || fill.action === "sell";
  const isLongFill = fill.action === "buy" || fill.action === "add_long";

  if (isInitial) {
    if (hasActivePosition(nextState)) throw new Error("20415 已有持倉時不可套用底倉成交");
    nextState.currentLayer = 1;
    nextState.totalSize = fill.fillQuantity;
    nextState.totalCost = fill.fillPrice * fill.fillQuantity;
    nextState.avgPrice = fill.fillPrice;
    nextState.lastLayerPrice = fill.fillPrice;
    nextState.highestPrice = fill.fillPrice;
    nextState.lowestPrice = fill.fillPrice;
    nextState.isLong = isLongFill;
    nextState.isTrailingActivated = false;
    nextState.lockedBarTimestamp = fill.barTimestamp ?? fill.timestamp;
    nextState.rainbow20415Runtime = createRainbow20415RuntimeMeta({
      ...runtime,
      blindMode: true,
      entryTimestamp: fill.timestamp,
      entryAccountEquity: finiteOr(fill.accountEquity, 0),
      pendingReentry: false,
      reentryReadyAt: 0,
      lastCloseReason: null,
      lastEntryBarTimestamp: fill.barTimestamp ?? fill.timestamp,
      lastActionTimestamp: fill.timestamp,
      lastActionSignature: `${fill.action}:L1`,
      lastDecisionReason: `底倉成交：${fill.action === "buy" ? "多" : "空"} L1 @ ${fill.fillPrice}`,
    });
    return nextState;
  }

  if (!hasActivePosition(nextState)) throw new Error("20415 無底倉時不可套用馬丁加倉成交");
  if (nextState.isLong !== isLongFill) throw new Error("20415 加倉方向與既有持倉不一致");
  const targetLayer = fill.targetLayer ?? nextState.currentLayer + 1;
  if (!Number.isSafeInteger(targetLayer) || targetLayer <= nextState.currentLayer) {
    throw new Error("20415 目標加倉層必須大於目前層且為安全整數");
  }

  nextState.totalCost += fill.fillPrice * fill.fillQuantity;
  nextState.totalSize += fill.fillQuantity;
  nextState.avgPrice = nextState.totalCost / nextState.totalSize;
  nextState.lastLayerPrice = fill.fillPrice;
  nextState.currentLayer = targetLayer;
  nextState.highestPrice = nextState.isLong
    ? Math.max(nextState.highestPrice || nextState.avgPrice, fill.fillPrice)
    : nextState.highestPrice;
  nextState.lowestPrice = nextState.isLong
    ? nextState.lowestPrice
    : Math.min(nextState.lowestPrice > 0 ? nextState.lowestPrice : nextState.avgPrice, fill.fillPrice);
  nextState.rainbow20415Runtime = createRainbow20415RuntimeMeta({
    ...runtime,
    blindMode: true,
    lastManagedAt: fill.timestamp,
    lastActionTimestamp: fill.timestamp,
    lastActionSignature: `${fill.action}:L${targetLayer}`,
    lastDecisionReason: `馬丁成交：L${targetLayer} @ ${fill.fillPrice}`,
  });
  return nextState;
}

export function applyRainbow20415CloseToState(
  state: StrategyState,
  closeReason: Rainbow20415CloseReason,
  rawConfig: unknown,
  timestamp: number,
): Rainbow20415RuntimeState {
  const config = assertValidRainbow20415Config(rawConfig);
  const previous = state as Rainbow20415RuntimeState;
  const previousRuntime = createRainbow20415RuntimeMeta(previous.rainbow20415Runtime);
  const pendingReentry = config.Reentry_Enabled;
  return createRainbow20415RuntimeState({
    capital: state.capital,
    lockedBarTimestamp: timestamp,
    rainbow20415Runtime: {
      ...previousRuntime,
      blindMode: false,
      entryTimestamp: 0,
      entryAccountEquity: 0,
      pendingReentry,
      reentryReadyAt: pendingReentry
        ? timestamp + config.Reentry_Cooldown_Minutes * 60_000
        : 0,
      lastCloseReason: closeReason,
      lastManagedAt: timestamp,
      lastActionTimestamp: timestamp,
      lastActionSignature: `close:${closeReason}`,
      lastDecisionReason: `平倉完成：${closeReason}${pendingReentry ? "，等待七線重判" : ""}`,
    },
  });
}

export function evaluateRainbow20415Decision(
  candles: readonly KLineData[],
  state: StrategyState,
  rawConfig: unknown,
  options?: {
    allowedDirection?: Rainbow20415AllowedDirection;
    now?: number;
    currentPrice?: number;
    account?: Rainbow20415AccountMetrics;
  },
): Rainbow20415CoreDecision {
  if (hasActivePosition(state)) {
    return evaluateRainbow20415Management(
      {
        currentPrice: options?.currentPrice ?? candles.at(-1)?.close ?? 0,
        now: options?.now ?? candles.at(-1)?.timestamp ?? Date.now(),
        account: options?.account,
      },
      state,
      rawConfig,
    );
  }
  return evaluateRainbow20415Entry(
    candles,
    state,
    rawConfig,
    options?.allowedDirection ?? "both",
  );
}
