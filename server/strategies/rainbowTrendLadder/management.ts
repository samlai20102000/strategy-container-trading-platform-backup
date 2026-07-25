import {
  assertValidRainbowTrendLadderConfig,
  createRainbowTrendLadderDefaultConfig,
  getRainbowTrendLadderCumulativeTriggerPct,
  getRainbowTrendLadderNextEnabledLayer,
  type RainbowTrendLadderLayerConfig,
} from "../../../shared/strategies/rainbowTrendLadder";
import type { StrategyState } from "../base";
import {
  createRainbowTrendLadderRuntimeMeta,
  createRainbowTrendLadderRuntimeState,
  type RainbowTrendLadderAccountMetrics,
  type RainbowTrendLadderCloseReason,
  type RainbowTrendLadderCoreDecision,
  type RainbowTrendLadderFillInput,
  type RainbowTrendLadderManagementInput,
  type RainbowTrendLadderManagementMetrics,
  type RainbowTrendLadderRuntimeMeta,
  type RainbowTrendLadderRuntimeState,
} from "./core";

function hasActivePosition(state: StrategyState): boolean {
  return state.currentLayer > 0 && state.totalSize > 0 && state.avgPrice > 0;
}

function cloneState(state: StrategyState): RainbowTrendLadderRuntimeState {
  const source = state as RainbowTrendLadderRuntimeState;
  return {
    ...source,
    rainbowTrendLadderRuntime: createRainbowTrendLadderRuntimeMeta(source.rainbowTrendLadderRuntime),
  };
}

function calculateProfitPct(state: StrategyState, currentPrice: number): number {
  if (!(state.avgPrice > 0) || !(currentPrice > 0)) return 0;
  return state.isLong
    ? ((currentPrice - state.avgPrice) / state.avgPrice) * 100
    : ((state.avgPrice - currentPrice) / state.avgPrice) * 100;
}

function calculateMarginUsagePct(account?: RainbowTrendLadderAccountMetrics): number | null {
  if (!account) return null;
  if (typeof account.marginUsagePct === "number" && Number.isFinite(account.marginUsagePct)) {
    return account.marginUsagePct;
  }
  if (
    typeof account.usedMargin === "number" && Number.isFinite(account.usedMargin) &&
    typeof account.equity === "number" && Number.isFinite(account.equity) && account.equity > 0
  ) {
    return (account.usedMargin / account.equity) * 100;
  }
  return null;
}

function roundOrderValue(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function getFinalEnabledLayer(layers: readonly RainbowTrendLadderLayerConfig[]): number {
  return layers.reduce((result, layer) => layer.enabled ? Math.max(result, layer.layer) : result, 0);
}

function managementDecision(
  decision: Omit<RainbowTrendLadderCoreDecision, "nextState" | "metrics">,
  state: RainbowTrendLadderRuntimeState,
  metrics: RainbowTrendLadderManagementMetrics,
  runtime: RainbowTrendLadderRuntimeMeta,
  now: number,
): RainbowTrendLadderCoreDecision {
  state.rainbowTrendLadderRuntime = createRainbowTrendLadderRuntimeMeta({
    ...runtime,
    blindMode: hasActivePosition(state),
    highestProfitPct: metrics.highestProfitPct,
    trailingActive: metrics.trailingActive,
    lastManagedAt: now,
    lastDecisionReason: decision.reason,
  });
  return { ...decision, nextState: state, metrics };
}

export function evaluateRainbowTrendLadderManagement(
  input: RainbowTrendLadderManagementInput,
  state: StrategyState,
  rawConfig: unknown = createRainbowTrendLadderDefaultConfig(),
): RainbowTrendLadderCoreDecision {
  const config = assertValidRainbowTrendLadderConfig(rawConfig);
  const nextState = cloneState(state);
  const runtime = createRainbowTrendLadderRuntimeMeta(nextState.rainbowTrendLadderRuntime);
  const currentPrice = input.currentPrice;
  const profitPct = calculateProfitPct(nextState, currentPrice);
  const highestProfitPct = Math.max(runtime.highestProfitPct, profitPct);
  const trailingActive = runtime.trailingActive || profitPct >= config.Trailing_Activation_Pct;
  const trailingDrawdownPct = trailingActive ? Math.max(0, highestProfitPct - profitPct) : 0;
  const marginUsagePct = calculateMarginUsagePct(input.account);
  const spreadPoints = typeof input.spreadPoints === "number" && Number.isFinite(input.spreadPoints)
    ? input.spreadPoints
    : null;
  const spreadAllowed = spreadPoints != null && spreadPoints < config.Max_Spread_Points;
  const initialEntryPrice = runtime.initialEntryPrice > 0 ? runtime.initialEntryPrice : nextState.avgPrice;
  const nextLayer = getRainbowTrendLadderNextEnabledLayer(config.Martin_Layers, nextState.currentLayer);
  const nextCumulativeTriggerPct = nextLayer
    ? getRainbowTrendLadderCumulativeTriggerPct(config.Martin_Layers, nextLayer.layer)
    : null;
  const nextTriggerPrice = nextCumulativeTriggerPct == null || !(initialEntryPrice > 0)
    ? null
    : nextState.isLong
      ? initialEntryPrice * (1 - nextCumulativeTriggerPct / 100)
      : initialEntryPrice * (1 + nextCumulativeTriggerPct / 100);
  const trendBaseValue = input.trendSnapshot?.current[config.Trend_Base_Line] ?? null;
  const trendBaseSlope = input.trendSnapshot?.slopes[config.Trend_Base_Line] ?? null;
  const trendDeviationPoints = trendBaseValue != null && currentPrice > 0
    ? Math.abs(currentPrice - trendBaseValue) / config.Point_Value
    : null;
  const trendTurnedAgainstPosition = trendBaseSlope != null
    ? nextState.isLong ? trendBaseSlope < 0 : trendBaseSlope > 0
    : false;
  const metrics: RainbowTrendLadderManagementMetrics = {
    mode: "BLIND",
    profitPct,
    highestProfitPct,
    trailingActive,
    trailingDrawdownPct,
    marginUsagePct,
    spreadPoints,
    spreadAllowed,
    currentLayer: nextState.currentLayer,
    finalLayer: getFinalEnabledLayer(config.Martin_Layers),
    nextLayer: nextLayer?.layer ?? null,
    nextCumulativeTriggerPct,
    nextTriggerPrice,
    initialEntryPrice,
    trendBaseValue,
    trendBaseSlope,
    trendDeviationPoints,
    trendTurnedAgainstPosition,
    killed: runtime.killed,
  };

  if (!hasActivePosition(nextState)) {
    return managementDecision(
      { action: "hold", reason: runtime.killed ? "KILL 鎖定中且無持倉" : "無有效新策略持倉，等待 M30 收盤掃描", price: currentPrice },
      nextState,
      metrics,
      runtime,
      input.now,
    );
  }
  if (!(currentPrice > 0) || !Number.isFinite(currentPrice)) {
    return managementDecision(
      { action: "hold", reason: "即時價格無效，安全封鎖加倉；KILL 需由持倉處置服務直接處理", price: currentPrice },
      nextState,
      metrics,
      runtime,
      input.now,
    );
  }
  if (runtime.killed) {
    return managementDecision(
      { action: "close", reason: "收到 KILL：僅平掉本策略可證明擁有的持倉並永久鎖定", price: currentPrice, closeReason: "KILL" },
      nextState,
      metrics,
      runtime,
      input.now,
    );
  }
  if (marginUsagePct != null && marginUsagePct >= config.Max_Margin_Usage_Pct) {
    return managementDecision(
      config.Close_On_Margin_Breach
        ? {
            action: "close",
            reason: `保證金鐵幕：使用率 ${marginUsagePct.toFixed(2)}% ≥ ${config.Max_Margin_Usage_Pct}%`,
            price: currentPrice,
            closeReason: "MARGIN_LIMIT",
          }
        : {
            action: "hold",
            reason: `保證金使用率 ${marginUsagePct.toFixed(2)}% 已達鐵幕，禁止所有加倉`,
            price: currentPrice,
          },
      nextState,
      metrics,
      runtime,
      input.now,
    );
  }
  if (trailingActive && trailingDrawdownPct >= config.Trailing_Callback_Pct) {
    return managementDecision(
      {
        action: "close",
        reason: `動態止盈：最高盈利 ${highestProfitPct.toFixed(4)}%，回撤 ${trailingDrawdownPct.toFixed(4)}% ≥ ${config.Trailing_Callback_Pct}%`,
        price: currentPrice,
        closeReason: "TRAILING_TAKE_PROFIT",
      },
      nextState,
      metrics,
      runtime,
      input.now,
    );
  }
  if (
    trendDeviationPoints != null &&
    trendDeviationPoints >= config.Trend_Deviation_Points &&
    trendTurnedAgainstPosition
  ) {
    return managementDecision(
      {
        action: "close",
        reason: `趨勢反轉：價格偏離 ${config.Trend_Base_Line} ${trendDeviationPoints.toFixed(2)} 點且基礎線已反向`,
        price: currentPrice,
        closeReason: "TREND_REVERSAL",
      },
      nextState,
      metrics,
      runtime,
      input.now,
    );
  }

  if (nextLayer && nextTriggerPrice != null) {
    const triggered = nextState.isLong ? currentPrice <= nextTriggerPrice : currentPrice >= nextTriggerPrice;
    if (triggered) {
      if (marginUsagePct == null) {
        return managementDecision(
          { action: "hold", reason: "缺少交易所真實保證金資料，安全封鎖階梯加倉", price: currentPrice },
          nextState,
          metrics,
          runtime,
          input.now,
        );
      }
      if (!spreadAllowed) {
        const reason = spreadPoints == null
          ? "缺少交易所即時點差，安全封鎖階梯加倉"
          : `點差 ${spreadPoints.toFixed(2)} 點未低於上限 ${config.Max_Spread_Points} 點，禁止加倉`;
        return managementDecision(
          { action: "hold", reason, price: currentPrice },
          nextState,
          metrics,
          runtime,
          input.now,
        );
      }
      return managementDecision(
        {
          action: nextState.isLong ? "add_long" : "add_short",
          reason: `盲人模式階梯加倉 L${nextLayer.layer}：相對初始進場價逆向累積 ${nextCumulativeTriggerPct?.toFixed(2)}%`,
          price: currentPrice,
          orderSize: { value: roundOrderValue(nextLayer.lotValue), mode: config.Base_Lot_Size.mode },
          layerNum: nextLayer.layer,
        },
        nextState,
        metrics,
        runtime,
        input.now,
      );
    }
  }

  const reason = trailingActive
    ? `盲人模式：動態止盈已啟動，距回撤閾值尚有 ${Math.max(0, config.Trailing_Callback_Pct - trailingDrawdownPct).toFixed(4)}%`
    : nextLayer
      ? `盲人模式持倉 L${nextState.currentLayer}：下一層 L${nextLayer.layer} 尚未達累積 ${nextCumulativeTriggerPct?.toFixed(2)}% 逆向偏離`
      : `盲人模式持倉：已達最後有效層 L${metrics.finalLayer}，只監控動態止盈與風控鐵幕`;
  return managementDecision({ action: "hold", reason, price: currentPrice }, nextState, metrics, runtime, input.now);
}

export function applyRainbowTrendLadderFillToState(
  state: StrategyState,
  fill: RainbowTrendLadderFillInput,
): RainbowTrendLadderRuntimeState {
  if (!(fill.fillPrice > 0) || !Number.isFinite(fill.fillPrice)) throw new Error("新七彩虹策略成交價格必須是大於 0 的有限數值");
  if (!(fill.fillQuantity > 0) || !Number.isFinite(fill.fillQuantity)) throw new Error("新七彩虹策略成交數量必須是大於 0 的有限數值");
  if (!(fill.timestamp > 0) || !Number.isFinite(fill.timestamp)) throw new Error("新七彩虹策略成交時間戳無效");
  const nextState = cloneState(state);
  const runtime = createRainbowTrendLadderRuntimeMeta(nextState.rainbowTrendLadderRuntime);
  const initialFill = fill.action === "buy" || fill.action === "sell";
  const longFill = fill.action === "buy" || fill.action === "add_long";
  if (runtime.killed) throw new Error("新七彩虹策略已被 KILL 鎖定，不可套用任何新成交");

  if (initialFill) {
    if (hasActivePosition(nextState)) throw new Error("新七彩虹策略已有持倉時不可套用底倉成交");
    nextState.currentLayer = 1;
    nextState.totalSize = fill.fillQuantity;
    nextState.totalCost = fill.fillPrice * fill.fillQuantity;
    nextState.avgPrice = fill.fillPrice;
    nextState.lastLayerPrice = fill.fillPrice;
    nextState.highestPrice = fill.fillPrice;
    nextState.lowestPrice = fill.fillPrice;
    nextState.isLong = longFill;
    nextState.isTrailingActivated = false;
    nextState.lockedBarTimestamp = fill.barTimestamp ?? fill.timestamp;
    nextState.rainbowTrendLadderRuntime = createRainbowTrendLadderRuntimeMeta({
      ...runtime,
      blindMode: true,
      entryTimestamp: fill.timestamp,
      initialEntryPrice: fill.fillPrice,
      entryAccountEquity: Number.isFinite(fill.accountEquity) ? fill.accountEquity ?? 0 : 0,
      highestProfitPct: 0,
      trailingActive: false,
      nextEntryBarTimestamp: 0,
      lastActionTimestamp: fill.timestamp,
      lastActionSignature: `${fill.action}:L1`,
      lastDecisionReason: `底倉成交：${longFill ? "多" : "空"} L1 @ ${fill.fillPrice}`,
    });
    return nextState;
  }

  if (!hasActivePosition(nextState)) throw new Error("新七彩虹策略無底倉時不可套用階梯加倉成交");
  if (nextState.isLong !== longFill) throw new Error("新七彩虹策略加倉方向與既有持倉不一致");
  const targetLayer = fill.targetLayer ?? nextState.currentLayer + 1;
  if (!Number.isSafeInteger(targetLayer) || targetLayer <= nextState.currentLayer) {
    throw new Error("新七彩虹策略目標加倉層必須大於目前層且為安全整數");
  }
  nextState.totalCost += fill.fillPrice * fill.fillQuantity;
  nextState.totalSize += fill.fillQuantity;
  nextState.avgPrice = nextState.totalCost / nextState.totalSize;
  nextState.lastLayerPrice = fill.fillPrice;
  nextState.currentLayer = targetLayer;
  nextState.highestPrice = nextState.isLong ? Math.max(nextState.highestPrice || fill.fillPrice, fill.fillPrice) : nextState.highestPrice;
  nextState.lowestPrice = nextState.isLong ? nextState.lowestPrice : Math.min(nextState.lowestPrice || fill.fillPrice, fill.fillPrice);
  nextState.rainbowTrendLadderRuntime = createRainbowTrendLadderRuntimeMeta({
    ...runtime,
    blindMode: true,
    lastManagedAt: fill.timestamp,
    lastActionTimestamp: fill.timestamp,
    lastActionSignature: `${fill.action}:L${targetLayer}`,
    lastDecisionReason: `階梯馬丁成交：L${targetLayer} @ ${fill.fillPrice}`,
  });
  return nextState;
}

export function applyRainbowTrendLadderCloseToState(
  state: StrategyState,
  closeReason: RainbowTrendLadderCloseReason,
  rawConfig: unknown,
  timestamp: number,
): RainbowTrendLadderRuntimeState {
  const config = assertValidRainbowTrendLadderConfig(rawConfig);
  const previous = state as RainbowTrendLadderRuntimeState;
  const previousRuntime = createRainbowTrendLadderRuntimeMeta(previous.rainbowTrendLadderRuntime);
  const killed = closeReason === "KILL" || previousRuntime.killed;
  return createRainbowTrendLadderRuntimeState({
    capital: state.capital,
    lockedBarTimestamp: timestamp,
    rainbowTrendLadderRuntime: {
      ...previousRuntime,
      blindMode: false,
      killed,
      killRequestedAt: killed ? previousRuntime.killRequestedAt || timestamp : 0,
      entryTimestamp: 0,
      initialEntryPrice: 0,
      entryAccountEquity: 0,
      highestProfitPct: 0,
      trailingActive: false,
      nextEntryBarTimestamp: !killed && config.Reentry_Wait_Next_M30_Close
        ? timestamp + config.Entry_Timeframe_Minutes * 60_000
        : 0,
      lastManagedAt: timestamp,
      lastActionTimestamp: timestamp,
      lastActionSignature: `close:${closeReason}`,
      lastDecisionReason: killed ? "KILL 平倉完成，策略維持永久鎖定" : `平倉完成：${closeReason}`,
      lastCloseReason: closeReason,
    },
  });
}

export function requestRainbowTrendLadderKill(state: StrategyState, timestamp: number): RainbowTrendLadderRuntimeState {
  const nextState = cloneState(state);
  const runtime = createRainbowTrendLadderRuntimeMeta(nextState.rainbowTrendLadderRuntime);
  nextState.rainbowTrendLadderRuntime = createRainbowTrendLadderRuntimeMeta({
    ...runtime,
    killed: true,
    killRequestedAt: timestamp,
    lastActionTimestamp: timestamp,
    lastActionSignature: "kill:requested",
    lastDecisionReason: hasActivePosition(nextState)
      ? "KILL 已鎖定；等待只平本策略已驗證持倉"
      : "KILL 已鎖定；目前無本策略持倉",
  });
  return nextState;
}

export function releaseRainbowTrendLadderKill(state: StrategyState, timestamp: number): RainbowTrendLadderRuntimeState {
  if (hasActivePosition(state)) throw new Error("尚有本策略持倉時不可解除 KILL");
  const nextState = cloneState(state);
  const runtime = createRainbowTrendLadderRuntimeMeta(nextState.rainbowTrendLadderRuntime);
  nextState.rainbowTrendLadderRuntime = createRainbowTrendLadderRuntimeMeta({
    ...runtime,
    killed: false,
    killRequestedAt: 0,
    nextEntryBarTimestamp: timestamp,
    lastActionTimestamp: timestamp,
    lastActionSignature: "kill:released",
    lastDecisionReason: "KILL 已由人工解除，等待下一根 M30 收盤掃描",
  });
  return nextState;
}
