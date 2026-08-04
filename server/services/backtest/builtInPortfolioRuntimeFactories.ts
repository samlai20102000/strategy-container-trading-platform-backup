import {
  createInitialStrategyState,
  type KLineData,
  type StrategyState,
} from "../../strategies/base";
import { validateKamaRainbowMartinConfig } from "../../../shared/strategies/kamaRainbowMartin";
import {
  createRainbow20415RuntimeMeta,
  createRainbow20415RuntimeState,
  calculateRainbow20415LineSnapshotSeries,
  evaluateRainbow20415Entry,
  evaluateRainbow20415Management,
  type Rainbow20415CoreDecision,
} from "../../strategies/rainbow20415/core";
import {
  createRainbowTrendLadderRuntimeMeta,
  createRainbowTrendLadderRuntimeState,
  calculateRainbowTrendLadderLineSnapshotSeries,
  evaluateRainbowTrendLadderEntry,
  type RainbowTrendLadderCoreDecision,
} from "../../strategies/rainbowTrendLadder/core";
import { evaluateRainbowTrendLadderManagement } from "../../strategies/rainbowTrendLadder/management";
import {
  createKamaRainbowMartinRuntimeMeta,
  createKamaRainbowMartinRuntimeState,
  calculateKamaRainbowMartinSnapshotSeries,
  evaluateKamaRainbowMartinEntry,
  type KamaRainbowMartinEntryDecision,
} from "../../strategies/kamaRainbowMartin/core";
import {
  evaluateKamaRainbowMartinManagement,
  type KamaRainbowMartinManagementDecision,
} from "../../strategies/kamaRainbowMartin/management";
import {
  calculateV25PrecomputedBarSeries,
  createV25RuntimeState,
  evaluateV25Decision,
  type V25CoreDecision,
} from "../../strategies/v25/core";
import { evaluateV40EntryGates } from "../../strategies/v35/entryGate";
import { evaluateV41EntryConditions } from "../../strategies/v41/entryConditions";
import {
  V41_CONFIG_KEY,
  assertValidV41Config,
} from "../../../shared/strategies/kama3kMartinV41";
import { calculateV61PrecomputedBarSeries, StrategyKama3kV61 } from "../../strategies/v61/strategy_kama_3k_v61";
import { StrategyKama3kV70 } from "../../strategies/v70/strategy_kama_3k_v70";
import {
  calculateLayerLot,
  getLayerStepPct,
  parseMartinLayers,
} from "../martingaleEngine";
import type { BacktestOpenLegSnapshot } from "./backtestContracts";
import {
  listExecutablePortfolioAdapterIds,
  registerPortfolioStrategyRuntimeFactory,
} from "./portfolioStrategyAdapterRegistry";
import type {
  PortfolioAdapterBarContext,
  PortfolioAdapterBarDecision,
  PortfolioAdapterIntent,
  PortfolioStrategyRuntimeAdapter,
  PortfolioStrategyRuntimeFactory,
  PortfolioStrategyRuntimeFactoryContext,
} from "./portfolioStrategyRuntimeAdapter";
import {
  createV41BacktestEntryDiagnostics,
  recordV41BacktestEntryEvaluation,
} from "./v41BacktestDiagnostics";

type AllowedDirection = "long" | "short" | "both";

interface DecisionLike {
  action: string;
  reason: string;
  price?: number;
  orderSize?: { mode?: unknown; value?: unknown };
  lotUsdt?: number;
  layerNum?: number;
  nextState?: StrategyState;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function allowedDirection(config: Readonly<Record<string, unknown>>): AllowedDirection {
  const value = String(config.direction ?? config.Direction ?? "both").trim().toLowerCase();
  return value === "long" || value === "short" ? value : "both";
}

function projectLegState(leg: BacktestOpenLegSnapshot, previous?: StrategyState): StrategyState {
  return {
    ...createInitialStrategyState(),
    ...(previous ?? {}),
    currentLayer: Math.max(1, leg.martinLayer + 1),
    totalSize: leg.size,
    avgPrice: leg.averageEntryPrice,
    totalCost: leg.averageEntryPrice * leg.size,
    lastLayerPrice: leg.lastEntryPrice,
    highestPrice: leg.side === "long"
      ? Math.max(previous?.highestPrice ?? leg.averageEntryPrice, leg.markPrice)
      : previous?.highestPrice ?? leg.averageEntryPrice,
    lowestPrice: leg.side === "short"
      ? Math.min(previous?.lowestPrice && previous.lowestPrice > 0 ? previous.lowestPrice : leg.averageEntryPrice, leg.markPrice)
      : previous?.lowestPrice ?? leg.averageEntryPrice,
    isLong: leg.side === "long",
    lockedBarTimestamp: previous?.lockedBarTimestamp || leg.openedAt,
  };
}

function orderSizeQuantity(
  orderSize: DecisionLike["orderSize"],
  price: number,
  initialCapital: number,
  fallbackUsdt: number,
): number {
  if (!orderSize || typeof orderSize !== "object") return fallbackUsdt / price;
  const value = numberValue(orderSize.value, 0);
  if (!(value > 0)) return fallbackUsdt / price;
  const mode = String(orderSize.mode ?? "quantity").trim().toLowerCase();
  if (["usdt", "quote", "notional"].includes(mode)) return value / price;
  if (["percent", "pct", "equity_percent"].includes(mode)) return (initialCapital * value / 100) / price;
  return value;
}

function entryQuantity(
  context: PortfolioAdapterBarContext,
  desiredQuantity?: number,
): number {
  let quantity = desiredQuantity && desiredQuantity > 0
    ? desiredQuantity
    : context.baseLotUsdt / context.candle.close;
  if (booleanValue(context.config.enable_loss_shrink ?? context.config.Enable_Loss_Shrink, true)) {
    const level1 = numberValue(context.config.loss_shrink_level1 ?? context.config.Loss_Shrink_Level1, 3);
    const level2 = numberValue(context.config.loss_shrink_level2 ?? context.config.Loss_Shrink_Level2, 5);
    if (context.consecutiveLosses >= level2) {
      quantity *= numberValue(context.config.loss_shrink_level2_pct ?? context.config.Loss_Shrink_Level2_Pct, 50) / 100;
    } else if (context.consecutiveLosses >= level1) {
      quantity *= numberValue(context.config.loss_shrink_level1_pct ?? context.config.Loss_Shrink_Level1_Pct, 70) / 100;
    }
  }
  return quantity;
}

function makeEntryIntent(
  context: PortfolioAdapterBarContext,
  side: "long" | "short",
  reasonCode: string,
  desiredQuantity?: number,
): PortfolioAdapterIntent | null {
  if (!booleanValue(context.config.enable_continuous_entry ?? context.config.Enable_Continuous_Entry, true)
      && context.closedTradeCount > 0) return null;
  const sideCode = side === "long" ? "LONG" : "SHORT";
  if (context.openLegs.some(leg => leg.sideCode === sideCode || leg.role === "HEDGE")) return null;
  return {
    action: side === "long" ? "OPEN_LONG" : "OPEN_SHORT",
    reasonCode: context.executionMode === "HEDGE_GUARDED" && context.openLegs.length > 0
      ? "H3_REVERSE_SIGNAL_CANDIDATE"
      : reasonCode,
    quantity: entryQuantity(context, desiredQuantity),
    eventKind: "NEW_DIRECTION_OR_HEDGE",
  };
}

function makeLegIntent(
  leg: BacktestOpenLegSnapshot,
  decision: DecisionLike,
  reasonCode: string,
  context: PortfolioAdapterBarContext,
): PortfolioAdapterIntent | null {
  const action = decision.action.toLowerCase();
  if (action === "close") {
    return {
      action: leg.sideCode === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT",
      reasonCode,
      quantity: leg.size,
      eventKind: "REGULAR_EXIT",
    };
  }
  if (action === "add" || action === "add_long" || action === "add_short") {
    const quantity = decision.lotUsdt && decision.lotUsdt > 0
      ? decision.lotUsdt / context.candle.close
      : orderSizeQuantity(decision.orderSize, context.candle.close, context.account.equity, context.baseLotUsdt);
    return {
      action: leg.sideCode === "LONG" ? "ADD_LONG" : "ADD_SHORT",
      reasonCode,
      quantity,
      eventKind: "MARTIN_ADD",
    };
  }
  return null;
}

function synchronizeStates(
  states: Map<string, StrategyState>,
  legs: readonly BacktestOpenLegSnapshot[],
  seed: (
    leg: BacktestOpenLegSnapshot,
    previous: StrategyState | undefined,
    account: PortfolioAdapterBarContext["account"],
  ) => StrategyState,
  account: PortfolioAdapterBarContext["account"],
): void {
  const openIds = new Set(legs.map(leg => leg.legId));
  for (const id of states.keys()) if (!openIds.has(id)) states.delete(id);
  for (const leg of legs) states.set(leg.legId, seed(leg, states.get(leg.legId), account));
}

function createCoreRuntime(
  factoryContext: PortfolioStrategyRuntimeFactoryContext,
  options: {
    adapterId: string;
    adapterVersion: number;
    seedState: (
      leg: BacktestOpenLegSnapshot,
      previous: StrategyState | undefined,
      account: PortfolioAdapterBarContext["account"],
    ) => StrategyState;
    evaluateEntry: (context: PortfolioAdapterBarContext, flatState: StrategyState) => DecisionLike;
    evaluateManagement: (context: PortfolioAdapterBarContext, leg: BacktestOpenLegSnapshot, state: StrategyState) => DecisionLike;
    entryCode: string;
    managementCode: string;
  },
): PortfolioStrategyRuntimeAdapter {
  const legStates = new Map<string, StrategyState>();
  let flatState = createInitialStrategyState();
  return {
    adapterId: options.adapterId,
    adapterVersion: options.adapterVersion,
    ownsPositionManagement: true,
    evaluateBar(context) {
      synchronizeStates(legStates, context.openLegs, options.seedState, context.account);
      const management: PortfolioAdapterIntent[] = [];
      for (const leg of context.openLegs) {
        const decision = options.evaluateManagement(context, leg, legStates.get(leg.legId)!);
        if (decision.nextState) legStates.set(leg.legId, projectLegState(leg, decision.nextState));
        const intent = makeLegIntent(leg, decision, `${options.managementCode}_${decision.action.toUpperCase()}`, context);
        if (intent) management.push(intent);
      }
      const entryDecision = options.evaluateEntry(context, flatState);
      if (entryDecision.nextState) flatState = entryDecision.nextState;
      const normalizedAction = entryDecision.action.toLowerCase();
      const side = normalizedAction === "buy" || normalizedAction === "open_long"
        ? "long"
        : normalizedAction === "sell" || normalizedAction === "open_short"
          ? "short"
          : null;
      const entries: PortfolioAdapterIntent[] = [];
      if (side) {
        const desired = entryDecision.lotUsdt && entryDecision.lotUsdt > 0
          ? entryDecision.lotUsdt / context.candle.close
          : orderSizeQuantity(entryDecision.orderSize, context.candle.close, context.account.equity, context.baseLotUsdt);
        const intent = makeEntryIntent(context, side, `${options.entryCode}_${side.toUpperCase()}`, desired);
        if (intent) entries.push(intent);
      }
      return { management, entries };
    },
    onBarCommitted(context) {
      synchronizeStates(legStates, context.afterLegs, options.seedState, context.account);
      if (context.afterLegs.length > context.beforeLegs.length) flatState = createInitialStrategyState();
    },
  };
}

function rainbow20415Factory(factoryContext: PortfolioStrategyRuntimeFactoryContext): PortfolioStrategyRuntimeAdapter {
  const snapshots = calculateRainbow20415LineSnapshotSeries(factoryContext.candles, factoryContext.config);
  return createCoreRuntime(factoryContext, {
    adapterId: "rainbow-20415-portfolio",
    adapterVersion: 1,
    seedState: (leg, previous, account) => createRainbow20415RuntimeState({
      ...projectLegState(leg, previous),
      rainbow20415Runtime: createRainbow20415RuntimeMeta({
        blindMode: true,
        entryTimestamp: leg.openedAt,
        entryAccountEquity: account.equity,
      }),
    }),
    evaluateEntry: context => evaluateRainbow20415Entry(
      [],
      createRainbow20415RuntimeState(),
      context.config,
      allowedDirection(context.config),
      { snapshot: snapshots[context.index], currentPrice: context.candle.close },
    ) as Rainbow20415CoreDecision,
    evaluateManagement: (context, _leg, state) => evaluateRainbow20415Management({
      currentPrice: context.candle.close,
      now: context.timestamp,
      account: { equity: context.account.equity, marginUsagePct: context.account.marginUsagePct },
    }, state, context.config) as Rainbow20415CoreDecision,
    entryCode: "RAINBOW_20415_ENTRY",
    managementCode: "RAINBOW_20415_MANAGE",
  });
}

function rainbowTrendLadderFactory(factoryContext: PortfolioStrategyRuntimeFactoryContext): PortfolioStrategyRuntimeAdapter {
  const snapshots = calculateRainbowTrendLadderLineSnapshotSeries(factoryContext.candles, factoryContext.config);
  return createCoreRuntime(factoryContext, {
    adapterId: "rainbow-trend-ladder-portfolio",
    adapterVersion: 1,
    seedState: (leg, previous, account) => createRainbowTrendLadderRuntimeState({
      ...projectLegState(leg, previous),
      rainbowTrendLadderRuntime: createRainbowTrendLadderRuntimeMeta({
        blindMode: true,
        entryTimestamp: leg.openedAt,
        initialEntryPrice: leg.averageEntryPrice,
        entryAccountEquity: account.equity,
      }),
    }),
    evaluateEntry: context => evaluateRainbowTrendLadderEntry({
      state: createRainbowTrendLadderRuntimeState(),
      rawConfig: context.config,
      allowedDirection: allowedDirection(context.config),
      precomputedSnapshot: snapshots[context.index],
      precomputedCurrentPrice: context.candle.close,
      spreadPoints: 0,
    }) as RainbowTrendLadderCoreDecision,
    evaluateManagement: (context, _leg, state) => evaluateRainbowTrendLadderManagement({
      currentPrice: context.candle.close,
      now: context.timestamp,
      barTimestamp: context.timestamp,
      account: { equity: context.account.equity, marginUsagePct: context.account.marginUsagePct },
      spreadPoints: 0,
    }, state, context.config) as RainbowTrendLadderCoreDecision,
    entryCode: "RAINBOW_TREND_ENTRY",
    managementCode: "RAINBOW_TREND_MANAGE",
  });
}

function kamaRainbowMartinFactory(factoryContext: PortfolioStrategyRuntimeFactoryContext): PortfolioStrategyRuntimeAdapter {
  const validation = validateKamaRainbowMartinConfig(factoryContext.config);
  const snapshots = calculateKamaRainbowMartinSnapshotSeries(factoryContext.candles, validation.config);
  const legStates = new Map<string, StrategyState>();
  const m2OpenedCycles = new Set<string>();
  let flatState = createKamaRainbowMartinRuntimeState();
  const seedState = (leg: BacktestOpenLegSnapshot, previous?: StrategyState) => createKamaRainbowMartinRuntimeState({
      ...projectLegState(leg, previous),
      kamaRainbowMartinRuntime: createKamaRainbowMartinRuntimeMeta({
        entryTimestamp: leg.openedAt,
        baseFillPrice: leg.averageEntryPrice,
        lastLayerFillPrice: leg.lastEntryPrice,
        initialPositionSize: {
          mode: "quantity",
          value: Math.max(leg.size / Math.max(1, leg.martinLayer + 1), Number.EPSILON),
        },
      }),
    });

  const evaluateEntry = (context: PortfolioAdapterBarContext) => evaluateKamaRainbowMartinEntry({
      state: flatState,
      rawConfig: context.config,
      allowedDirection: allowedDirection(context.config),
      precomputedSnapshot: snapshots[context.index],
      lastBarClosed: true,
      configRevision: `backtest:${context.timestamp}`,
    }) as KamaRainbowMartinEntryDecision;

  return {
    adapterId: "kama-rainbow-martin-portfolio",
    adapterVersion: 3,
    ownsPositionManagement: true,
    evaluateBar(context) {
      synchronizeStates(legStates, context.openLegs, seedState, context.account);
      for (const leg of context.openLegs) {
        if (leg.role === "INDEPENDENT") m2OpenedCycles.add(leg.cycleId);
      }

      const management: PortfolioAdapterIntent[] = [];
      for (const leg of context.openLegs) {
        // H3 是平台管理的保護腿：只可由自動回復／主腿退出／強制風控解除，禁止進入 KRM 馬丁管理。
        if (leg.role === "HEDGE") continue;
        const decision = evaluateKamaRainbowMartinManagement({
          currentPrice: context.candle.close,
          now: context.timestamp,
          riskEventKey: `backtest:${context.timestamp}:${leg.legId}`,
        }, legStates.get(leg.legId)!, context.config) as KamaRainbowMartinManagementDecision;
        if (decision.nextState) legStates.set(leg.legId, projectLegState(leg, decision.nextState));
        const intent = makeLegIntent(leg, decision, `KRM_MANAGE_${decision.action.toUpperCase()}`, context);
        if (intent) management.push({
          ...intent,
          roleHint: leg.role,
          cycleIdHint: leg.cycleId,
        });
      }

      const primary = context.openLegs.find(leg => leg.role === "PRIMARY");
      const independent = context.openLegs.find(leg => leg.role === "INDEPENDENT");
      const hedge = context.openLegs.find(leg => leg.role === "HEDGE");
      const entries: PortfolioAdapterIntent[] = [];

      // H3 的保護候選完全由主腿浮虧驅動；mode engine 以 canonical policy 門檻再次核准。
      if (context.executionMode === "HEDGE_GUARDED" && primary && !hedge) {
        entries.push({
          action: primary.sideCode === "LONG" ? "OPEN_SHORT" : "OPEN_LONG",
          reasonCode: "KRM_H3_AUTO_PROTECTION_CANDIDATE",
          roleHint: "HEDGE",
          cycleIdHint: primary.cycleId,
          quantity: entryQuantity(context),
          eventKind: "NEW_DIRECTION_OR_HEDGE",
        });
        return { management, entries };
      }

      // 尚有非主腿的孤立狀態時禁止開新 S1，交由對帳／既有腿退出收斂。
      if (!primary && context.openLegs.length > 0) return { management, entries };

      const entryDecision = evaluateEntry(context);
      if (entryDecision.nextState) flatState = entryDecision.nextState;
      const normalizedAction = entryDecision.action.toLowerCase();
      const side = normalizedAction === "buy" || normalizedAction === "open_long"
        ? "long"
        : normalizedAction === "sell" || normalizedAction === "open_short"
          ? "short"
          : null;
      if (!side) return { management, entries };

      const sizingDecision = entryDecision as DecisionLike;
      const desired = sizingDecision.lotUsdt && sizingDecision.lotUsdt > 0
        ? sizingDecision.lotUsdt / context.candle.close
        : orderSizeQuantity(sizingDecision.orderSize, context.candle.close, context.account.equity, context.baseLotUsdt);

      if (!primary) {
        const intent = makeEntryIntent(context, side, `KRM_S1_PRIMARY_${side.toUpperCase()}`, desired);
        if (intent) entries.push({ ...intent, roleHint: "PRIMARY" });
        return { management, entries };
      }

      if (context.executionMode !== "MULTI_POSITION"
          || independent
          || m2OpenedCycles.has(primary.cycleId)
          || primary.unrealizedGrossPnl >= 0
          || (side === "long" ? "LONG" : "SHORT") === primary.sideCode) {
        return { management, entries };
      }

      const intent = makeEntryIntent(context, side, `KRM_M2_LOSS_REVERSE_${side.toUpperCase()}`, desired);
      if (intent) entries.push({
        ...intent,
        reasonCode: `KRM_M2_LOSS_REVERSE_${side.toUpperCase()}`,
        roleHint: "INDEPENDENT",
        cycleIdHint: primary.cycleId,
      });
      return { management, entries };
    },
    onBarCommitted(context) {
      synchronizeStates(legStates, context.afterLegs, seedState, context.account);
      for (const leg of context.afterLegs) {
        if (leg.role === "INDEPENDENT") m2OpenedCycles.add(leg.cycleId);
      }
      if (context.afterLegs.length > context.beforeLegs.length) {
        flatState = createKamaRainbowMartinRuntimeState();
      }
    },
  };
}

function v25Factory(factoryContext: PortfolioStrategyRuntimeFactoryContext): PortfolioStrategyRuntimeAdapter {
  const bars = calculateV25PrecomputedBarSeries(factoryContext.candles, factoryContext.config);
  return createCoreRuntime(factoryContext, {
    adapterId: "kama-3k-v25-portfolio",
    adapterVersion: 1,
    seedState: (leg, previous) => createV25RuntimeState(projectLegState(leg, previous)),
    evaluateEntry: context => evaluateV25Decision(
      [],
      createV25RuntimeState(),
      context.config,
      allowedDirection(context.config),
      bars[context.index],
    ) as V25CoreDecision,
    evaluateManagement: (context, _leg, state) => evaluateV25Decision(
      [],
      state,
      context.config,
      allowedDirection(context.config),
      bars[context.index],
    ) as V25CoreDecision,
    entryCode: "V25_ENTRY",
    managementCode: "V25_MANAGE",
  });
}

function classicManagement(
  context: PortfolioAdapterBarContext,
  leg: BacktestOpenLegSnapshot,
  code: string,
): PortfolioAdapterIntent[] {
  const pnlPct = leg.entryNotional > 0 ? (leg.unrealizedGrossPnl / leg.entryNotional) * 100 : 0;
  const target = numberValue(context.config.Target_TP_Pct, 1);
  const callback = numberValue(context.config.Callback_Pct, 0.1);
  if (leg.mfePct >= target && leg.mfePct - pnlPct >= callback) {
    return [{
      action: leg.sideCode === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT",
      reasonCode: `${code}_TRAILING_EXIT`,
      quantity: leg.size,
      eventKind: "REGULAR_EXIT",
    }];
  }
  const maxLayers = Math.max(1, Math.trunc(numberValue(context.config.Max_Layers ?? context.config.MaxMartinLevels, 15)));
  if (leg.role === "HEDGE" || leg.martinLayer + 1 >= maxLayers) return [];
  const deviation = leg.side === "long"
    ? ((leg.lastEntryPrice - context.candle.close) / leg.lastEntryPrice) * 100
    : ((context.candle.close - leg.lastEntryPrice) / leg.lastEntryPrice) * 100;
  const rules = parseMartinLayers(context.config.Martin_Layers) ?? null;
  const nextLayer = leg.martinLayer + 2;
  const step = getLayerStepPct(nextLayer, rules, numberValue(context.config.Martin_Step_Pct, 1.5));
  if (deviation < step) return [];
  const lotUsdt = calculateLayerLot(
    context.baseLotUsdt,
    leg.martinLayer + 1,
    rules,
    numberValue(context.config.Martin_Multiplier, 1.5),
  );
  return [{
    action: leg.sideCode === "LONG" ? "ADD_LONG" : "ADD_SHORT",
    reasonCode: `${code}_MARTIN_DISTANCE_TRIGGER`,
    quantity: lotUsdt / context.candle.close,
    eventKind: "MARTIN_ADD",
  }];
}

function createClassicKamaFactory(
  adapterId: string,
  adapterVersion: number,
  semantic: "V35" | "V41" | "V50",
): PortfolioStrategyRuntimeFactory {
  return factoryContext => {
    const v41Diagnostics = semantic === "V41"
      ? createV41BacktestEntryDiagnostics(assertValidV41Config(
          factoryContext.config[V41_CONFIG_KEY] ?? factoryContext.config,
        ))
      : undefined;
    return {
      adapterId,
      adapterVersion,
      ownsPositionManagement: true,
      async evaluateBar(context): Promise<PortfolioAdapterBarDecision> {
      const management = context.openLegs.flatMap(leg => classicManagement(context, leg, semantic));
      const fast = context.indicators.kamaFast;
      const slow = context.indicators.kamaSlow;
      if (fast == null || slow == null || context.index < 2) return { management, entries: [] };
      const previous2 = context.previousCandle(2);
      const previous1 = context.previousCandle(1);
      if (!previous2 || !previous1) return { management, entries: [] };
      let side: "long" | "short" | null = null;
      let reasonCode = `${semantic}_KAMA_3K_ENTRY`;
      if (semantic === "V35") {
        const gate = evaluateV40EntryGates({
          candles: [previous2, previous1, context.candle],
          rawConfig: context.config,
          currentPrice: context.candle.close,
          slowKama: slow,
          allowedDirection: allowedDirection(context.config),
        });
        if (gate.passed) side = gate.direction;
      } else if (semantic === "V41") {
        const evaluation = evaluateV41EntryConditions({
          config: context.config,
          closedBars: [previous2, previous1, context.candle],
          decisionBarTimestamp: context.timestamp,
          decisionClose: context.candle.close,
          fastKama: fast,
          slowKama: slow,
          allowedDirection: allowedDirection(context.config),
        });
        if (v41Diagnostics) recordV41BacktestEntryEvaluation(v41Diagnostics, evaluation);
        if (evaluation.passed) {
          side = evaluation.direction;
          reasonCode = evaluation.primaryReasonCode;
        }
      } else {
        const longPattern = previous2.close > previous2.open
          && previous1.close > previous1.open
          && context.candle.close >= Math.max(previous2.high, previous1.high);
        const shortPattern = previous2.close < previous2.open
          && previous1.close < previous1.open
          && context.candle.close <= Math.min(previous2.low, previous1.low);
        if (fast > slow && longPattern) side = "long";
        else if (fast < slow && shortPattern) side = "short";
        if (side && booleanValue(context.config.enable_ai_filter, false)) {
          const threshold = numberValue(context.config.kama_slope_min, 0.02);
          const slopePct = fast > 0 ? ((fast - slow) / fast) * 100 : 0;
          if ((side === "long" && slopePct < threshold) || (side === "short" && slopePct > -threshold)) side = null;
        }
      }
      if (!side) return { management, entries: [] };
      let desired = context.baseLotUsdt / context.candle.close;
      if (semantic === "V50" && booleanValue(context.config.enable_vol_position, true) && context.indicators.atr > 0) {
        const atrPct = (context.indicators.atr / context.candle.close) * 100;
        const scale = Math.max(
          numberValue(context.config.vol_min_scale, 0.5),
          Math.min(numberValue(context.config.vol_max_scale, 2), numberValue(context.config.target_vol_pct, 1.5) / atrPct),
        );
        desired *= scale;
      }
      const entry = makeEntryIntent(context, side, reasonCode, desired);
      return { management, entries: entry ? [entry] : [] };
      },
      getDiagnostics: v41Diagnostics
        ? () => ({ v41EntryDiagnostics: v41Diagnostics })
        : undefined,
    };
  };
}

function v61Factory(factoryContext: PortfolioStrategyRuntimeFactoryContext): PortfolioStrategyRuntimeAdapter {
  const engine = new StrategyKama3kV61(factoryContext.config);
  const bars = calculateV61PrecomputedBarSeries(factoryContext.candles, factoryContext.config);
  return {
    adapterId: "kama-3k-v61-portfolio",
    adapterVersion: 2,
    ownsPositionManagement: true,
    evaluateBar(context) {
      const precomputed = bars[context.index];
      const management: PortfolioAdapterIntent[] = [];
      for (const leg of context.openLegs) {
        const pnlPct = leg.entryNotional > 0 ? (leg.unrealizedGrossPnl / leg.entryNotional) * 100 : 0;
        const decision = engine.generateSignalV61(
          [],
          true,
          leg.side,
          Math.max(1, leg.martinLayer + 1),
          leg.averageEntryPrice,
          pnlPct,
          precomputed,
        );
        const intent = makeLegIntent(leg, decision, `V61_${decision.action.toUpperCase()}`, context);
        if (intent) management.push(intent);
      }
      const signal = engine.generateSignalV61([], false, undefined, undefined, undefined, undefined, precomputed);
      const side = signal.action === "buy" ? "long" : signal.action === "sell" ? "short" : null;
      const desired = signal.lotUsdt && signal.lotUsdt > 0 ? signal.lotUsdt / context.candle.close : undefined;
      const entry = side ? makeEntryIntent(context, side, "V61_ZONE_ENTRY", desired) : null;
      return { management, entries: entry ? [entry] : [] };
    },
  };
}

function v70Factory(factoryContext: PortfolioStrategyRuntimeFactoryContext): PortfolioStrategyRuntimeAdapter {
  const engine = new StrategyKama3kV70(factoryContext.config);
  const bars = engine.calculatePrecomputedBarSeries(factoryContext.candles, factoryContext.config);
  return {
    adapterId: "kama-3k-v70-portfolio",
    adapterVersion: 1,
    ownsPositionManagement: true,
    evaluateBar(context) {
      const precomputed = bars[context.index];
      const management: PortfolioAdapterIntent[] = [];
      for (const leg of context.openLegs) {
        const signal = engine.generateTradingSignal(
          [],
          projectLegState(leg),
          context.config,
          precomputed,
        );
        const intent = makeLegIntent(leg, signal, `V70_${signal.action.toUpperCase()}`, context);
        if (intent) management.push(intent);
      }
      const signal = engine.generateTradingSignal([], createInitialStrategyState(), context.config, precomputed);
      const side = signal.action === "buy" ? "long" : signal.action === "sell" ? "short" : null;
      const desired = signal.lotUsdt && signal.lotUsdt > 0 ? signal.lotUsdt / context.candle.close : undefined;
      const entry = side ? makeEntryIntent(context, side, "V70_MA200_KAMA_ENTRY", desired) : null;
      return { management, entries: entry ? [entry] : [] };
    },
  };
}

const BUILT_IN_FACTORIES = [
  ["rainbow-20415-portfolio", 1, rainbow20415Factory],
  ["rainbow-trend-ladder-portfolio", 1, rainbowTrendLadderFactory],
  ["kama-rainbow-martin-portfolio", 3, kamaRainbowMartinFactory],
  ["kama-3k-v25-portfolio", 1, v25Factory],
  ["kama-3k-v35-portfolio", 2, createClassicKamaFactory("kama-3k-v35-portfolio", 2, "V35")],
  ["kama-3k-v41-portfolio", 1, createClassicKamaFactory("kama-3k-v41-portfolio", 1, "V41")],
  ["kama-3k-v50-portfolio", 2, createClassicKamaFactory("kama-3k-v50-portfolio", 2, "V50")],
  ["kama-3k-v61-portfolio", 2, v61Factory],
  ["kama-3k-v70-portfolio", 1, v70Factory],
] as const satisfies readonly (readonly [string, number, PortfolioStrategyRuntimeFactory])[];

export function ensureBuiltInPortfolioRuntimeFactoriesRegistered(): void {
  const executable = new Set(listExecutablePortfolioAdapterIds());
  for (const [adapterId, adapterVersion, factory] of BUILT_IN_FACTORIES) {
    if (!executable.has(adapterId)) registerPortfolioStrategyRuntimeFactory(adapterId, adapterVersion, factory);
  }
}
