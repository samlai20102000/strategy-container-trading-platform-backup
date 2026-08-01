import {
  EXECUTION_POLICY_VERSION,
  type CandidateIntent,
  type ExecutionPolicy,
  type HedgeGuardedPolicy,
  type ModeDecision,
  type PositionLegRole,
  type PositionSide,
  type SingleExclusivePolicy,
} from "../../../shared/executionModes";
import {
  evaluateAdvancedMode,
  type ActiveModeLeg,
  type ModeRuntimeCapabilities,
} from "../advancedExecutionModeEngine";
import {
  BACKTEST_ACCOUNTING_TOLERANCE,
  BACKTEST_INTRABAR_EVENT_ORDER,
  type BacktestAccountingSnapshot,
  type BacktestEndPositionPolicy,
  type BacktestHedgeAttribution,
  type BacktestIntrabarEventKind,
  type BacktestLegAccounting,
  type BacktestLegAttribution,
  type BacktestModeResults,
  type BacktestOpenLegSnapshot,
  roundBacktestMoney,
} from "./backtestContracts";

const QUANTITY_EPSILON = 1e-10;
const MONEY_EPSILON = 1e-8;
const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.005;

export interface BacktestPortfolioCandidate extends CandidateIntent {
  /** 同 K 棒事件優先級；未提供時依 action 推導。 */
  eventKind?: BacktestIntrabarEventKind;
  sequence?: number;
}

export interface BacktestPortfolioBar {
  timestamp: number;
  price: number;
  high?: number;
  low?: number;
  /** 正值代表 LONG 支付、SHORT 收取；每次 processBar 最多套用一次。 */
  fundingRate?: number;
}

export interface ThreeModePortfolioConfig {
  deploymentId: number;
  executionPolicy: ExecutionPolicy;
  initialCapital: number;
  leverage: number;
  commissionRate: number;
  slippageRate: number;
  quantityPrecision?: number;
  /** 維持保證金率（notional 比例）；預設 0.5%，僅供回測強平邊界。 */
  maintenanceMarginRate?: number;
  capabilities?: ModeRuntimeCapabilities;
}

export interface BacktestPortfolioFill {
  fillId: string;
  candidateId: string;
  decisionId: string;
  legId: string;
  cycleId: string;
  side: PositionSide;
  role: PositionLegRole;
  action: "OPEN" | "ADD" | "REDUCE" | "CLOSE" | "REBALANCE";
  quantity: number;
  price: number;
  notional: number;
  fee: number;
  timestamp: number;
  reasonCode: string;
}

export interface BacktestPortfolioTrade {
  tradeId: string;
  legId: string;
  cycleId: string;
  side: PositionSide;
  role: PositionLegRole;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  fees: number;
  funding: number;
  pnl: number;
  exitReason: string;
  martinLayer: number;
}

export interface BacktestPortfolioEvent {
  eventId: string;
  timestamp: number;
  sequence: number;
  eventKind: BacktestIntrabarEventKind;
  candidateId: string;
  decisionId: string;
  decisionOutcome: ModeDecision["outcome"];
  reasonCode: string;
  legId?: string;
}

export interface BacktestPortfolioEquityPoint {
  timestamp: number;
  equity: number;
  price: number;
  grossExposure: number;
  netExposure: number;
  marginUsage: number;
}

export interface ThreeModePortfolioResult {
  decisions: ModeDecision[];
  fills: BacktestPortfolioFill[];
  trades: BacktestPortfolioTrade[];
  events: BacktestPortfolioEvent[];
  equityCurve: BacktestPortfolioEquityPoint[];
  accounting: BacktestAccountingSnapshot;
  legAccounting: BacktestLegAccounting;
  modeResults: BacktestModeResults;
}

interface PortfolioLayer {
  price: number;
  quantity: number;
  fee: number;
  timestamp: number;
}

interface PortfolioLeg {
  legId: string;
  cycleId: string;
  side: PositionSide;
  role: PositionLegRole;
  status: "OPEN" | "CLOSED";
  layers: PortfolioLayer[];
  quantity: number;
  averageEntryPrice: number;
  openedAt: number;
  closedAt: number | null;
  closePrice: number | null;
  exitReason: string | null;
  realizedGrossPnl: number;
  fees: number;
  entryFeeBalance: number;
  exitFees: number;
  funding: number;
  fundingBalance: number;
  turnover: number;
  maxNotional: number;
  mfePct: number;
  maePct: number;
  addCount: number;
  closeCount: number;
}

interface HedgeRelationshipState extends BacktestHedgeAttribution {
  status: "ACTIVE" | "UNWINDING" | "CLOSED";
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function signedDirection(side: PositionSide): 1 | -1 {
  return side === "LONG" ? 1 : -1;
}

function uiSide(side: PositionSide): "long" | "short" {
  return side === "LONG" ? "long" : "short";
}

function eventKindFor(candidate: BacktestPortfolioCandidate): BacktestIntrabarEventKind {
  if (candidate.eventKind) return candidate.eventKind;
  if (candidate.source === "RISK") return "FORCED_RISK_EXIT";
  if (candidate.action.startsWith("CLOSE_") || candidate.action.startsWith("REDUCE_") || candidate.action === "CLOSE_ALL") {
    return "REGULAR_EXIT";
  }
  if (candidate.action.startsWith("ADD_")) return "MARTIN_ADD";
  return "NEW_DIRECTION_OR_HEDGE";
}

function eventPriority(kind: BacktestIntrabarEventKind): number {
  return BACKTEST_INTRABAR_EVENT_ORDER.indexOf(kind);
}

function actionSide(action: CandidateIntent["action"]): PositionSide | undefined {
  if (action.endsWith("LONG")) return "LONG";
  if (action.endsWith("SHORT")) return "SHORT";
  return undefined;
}

function isCloseAction(action: CandidateIntent["action"]): boolean {
  return action === "CLOSE_ALL" || action.startsWith("CLOSE_") || action.startsWith("REDUCE_");
}

function decisionId(candidateId: string): string {
  return `decision:${candidateId}`.slice(0, 128);
}

function deterministicDecision(
  candidate: CandidateIntent,
  policy: ExecutionPolicy,
  input: Omit<ModeDecision, "decisionId" | "candidateId" | "deploymentId" | "executionMode" | "createdAt">,
): ModeDecision {
  return {
    decisionId: decisionId(candidate.candidateId),
    candidateId: candidate.candidateId,
    deploymentId: candidate.deploymentId,
    executionMode: policy.mode,
    ...input,
    createdAt: candidate.createdAt,
  };
}

function roundQuantity(value: number, precision: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.max(0, value).toFixed(precision));
}

export class ThreeModePortfolioKernel {
  private readonly config: Required<Omit<ThreeModePortfolioConfig, "capabilities">> & {
    capabilities: ModeRuntimeCapabilities;
  };
  private readonly legs = new Map<string, PortfolioLeg>();
  private readonly relationships = new Map<string, HedgeRelationshipState>();
  private readonly decisions: ModeDecision[] = [];
  private readonly fills: BacktestPortfolioFill[] = [];
  private readonly trades: BacktestPortfolioTrade[] = [];
  private readonly events: BacktestPortfolioEvent[] = [];
  private readonly equityCurve: BacktestPortfolioEquityPoint[] = [];
  private processedCandidateIds = new Set<string>();
  private fillSequence = 0;
  private eventSequence = 0;
  private legSequence = 0;
  private cycleSequence = 0;
  private rejectedDecisionCount = 0;
  private grossExposurePeak = 0;
  private netExposureAbsPeak = 0;
  private marginUsagePeak = 0;
  private marginHeadroomLow: number;
  private overlapDurationMs = 0;
  private lastMarkedAt: number | null = null;
  private lastPrice = 0;
  private lastHedgeClosedAt: number | undefined;
  private marginLiquidationCount = 0;
  private bankruptcyAdjustment = 0;
  private bankrupt = false;

  constructor(input: ThreeModePortfolioConfig) {
    if (!finitePositive(input.initialCapital)) throw new Error("initialCapital 必須大於 0");
    if (!finitePositive(input.leverage)) throw new Error("leverage 必須大於 0");
    if (input.maintenanceMarginRate !== undefined && (
      !Number.isFinite(input.maintenanceMarginRate)
      || input.maintenanceMarginRate < 0
      || input.maintenanceMarginRate >= 1
    )) {
      throw new Error("maintenanceMarginRate 必須介於 0（含）與 1（不含）之間");
    }
    if (input.executionPolicy.version !== EXECUTION_POLICY_VERSION) {
      throw new Error(`不支援的 execution policy version: ${input.executionPolicy.version}`);
    }
    const now = 0;
    this.config = {
      ...input,
      quantityPrecision: input.quantityPrecision ?? 8,
      maintenanceMarginRate: input.maintenanceMarginRate ?? DEFAULT_MAINTENANCE_MARGIN_RATE,
      capabilities: input.capabilities ?? {
        supportsIndependentLongShort: true,
        canPreciselyCloseLeg: true,
        capturedAt: now,
        expiresAt: Number.MAX_SAFE_INTEGER,
        blockerCodes: [],
      },
    };
    this.marginHeadroomLow = input.initialCapital;
  }

  processBar(bar: BacktestPortfolioBar, candidates: BacktestPortfolioCandidate[]): void {
    this.assertBar(bar);
    this.applyFunding(bar);
    this.markMarket(bar);
    if (this.applyMarginLiquidation(bar)) {
      this.markMarket(bar);
      return;
    }
    this.applyAutomaticHedgeLifecycle(bar);

    const ordered = [...candidates].sort((left, right) => {
      const kindDifference = eventPriority(eventKindFor(left)) - eventPriority(eventKindFor(right));
      if (kindDifference !== 0) return kindDifference;
      const sequenceDifference = (left.sequence ?? 0) - (right.sequence ?? 0);
      return sequenceDifference !== 0
        ? sequenceDifference
        : left.candidateId.localeCompare(right.candidateId);
    });

    for (const candidate of ordered) this.processCandidate(candidate, bar);
    this.rebalanceActiveHedge(bar);
    this.applyMarginLiquidation(bar);
    this.markMarket(bar);
  }

  finalize(policy: BacktestEndPositionPolicy, timestamp: number, price: number): ThreeModePortfolioResult {
    this.assertBar({ timestamp, price });
    if (policy === "force_close") {
      const open = this.openLegs();
      for (const leg of open) {
        const candidate: BacktestPortfolioCandidate = {
          candidateId: `finalize:${this.config.deploymentId}:${timestamp}:${leg.legId}`.slice(0, 128),
          deploymentId: this.config.deploymentId,
          action: leg.side === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT",
          side: leg.side,
          requestedQuantity: leg.quantity,
          signalPrice: price,
          barTimestamp: timestamp,
          source: "RISK",
          reasonCode: "END_OF_DATA_FORCE_CLOSE",
          reason: "回測全域終點強制平倉",
          createdAt: timestamp,
          eventKind: "FORCED_RISK_EXIT",
        };
        this.processCandidate(candidate, { timestamp, price });
      }
    }
    this.markMarket({ timestamp, price });
    return this.buildResult(policy);
  }

  /**
   * 提供策略模擬器唯讀的 canonical 逐腿快照；回傳新物件，呼叫端無法改寫帳本。
   * 這是多腿風控／馬丁候選產生器唯一允許讀取 portfolio 狀態的介面。
   */
  snapshotOpenLegs(price = this.lastPrice): BacktestOpenLegSnapshot[] {
    if (!finitePositive(price)) return [];
    return this.openLegs().map(leg => this.buildOpenLegSnapshot(leg, price));
  }

  /** 已實現交易的防禦性複本，用於策略級連虧縮倉與重入狀態。 */
  snapshotTrades(): BacktestPortfolioTrade[] {
    return this.trades.map(trade => ({ ...trade }));
  }

  private assertBar(bar: BacktestPortfolioBar): void {
    if (!Number.isFinite(bar.timestamp) || !finitePositive(bar.price)) {
      throw new Error("portfolio bar timestamp/price 無效");
    }
    if (this.lastMarkedAt !== null && bar.timestamp < this.lastMarkedAt) {
      throw new Error("portfolio bar 必須按時間遞增處理");
    }
  }

  private openLegs(): PortfolioLeg[] {
    return Array.from(this.legs.values()).filter(leg => leg.status === "OPEN" && leg.quantity > QUANTITY_EPSILON);
  }

  private toRuntimeLegs(price: number): ActiveModeLeg[] {
    return this.openLegs().map(leg => ({
      legId: leg.legId,
      side: leg.side,
      role: leg.role,
      status: "OPEN",
      quantity: leg.quantity,
      unrealizedPnlPct: this.pnlPct(leg, price),
      openedAt: leg.openedAt,
    }));
  }

  private processCandidate(candidate: BacktestPortfolioCandidate, bar: BacktestPortfolioBar): void {
    if (candidate.deploymentId !== this.config.deploymentId) {
      throw new Error(`candidate deploymentId 不符: ${candidate.deploymentId}`);
    }
    if (this.processedCandidateIds.has(candidate.candidateId)) {
      const replayCandidate: BacktestPortfolioCandidate = {
        ...candidate,
        barTimestamp: bar.timestamp,
        signalPrice: bar.price,
        createdAt: bar.timestamp,
      };
      const duplicate = deterministicDecision(replayCandidate, this.config.executionPolicy, {
        outcome: "HOLD",
        reasonCode: "DUPLICATE_CANDIDATE_REPLAY",
        contextSnapshot: { idempotentReplay: true },
      });
      this.recordDecision(replayCandidate, duplicate, eventKindFor(replayCandidate));
      return;
    }
    this.processedCandidateIds.add(candidate.candidateId);

    const effectiveCandidate: BacktestPortfolioCandidate = {
      ...candidate,
      side: candidate.side ?? actionSide(candidate.action),
      signalPrice: candidate.signalPrice ?? bar.price,
      barTimestamp: candidate.barTimestamp ?? bar.timestamp,
      createdAt: candidate.createdAt ?? bar.timestamp,
    };
    const decision = this.evaluateCandidate(effectiveCandidate, bar);
    this.recordDecision(effectiveCandidate, decision, eventKindFor(effectiveCandidate));
    if (decision.outcome !== "APPROVED" && decision.outcome !== "CLOSE_ONLY") return;

    if (isCloseAction(effectiveCandidate.action)) {
      this.applyCloseCandidate(effectiveCandidate, decision, bar);
      return;
    }

    const closeLegIds = Array.isArray(decision.contextSnapshot.closeLegIds)
      ? decision.contextSnapshot.closeLegIds.filter((value): value is string => typeof value === "string")
      : [];
    for (const legId of closeLegIds) {
      const leg = this.legs.get(legId);
      if (leg?.status === "OPEN") this.closeLeg(leg, leg.quantity, bar, effectiveCandidate, decision, "CLOSE");
    }
    if (decision.outcome === "CLOSE_ONLY") return;

    const quantity = roundQuantity(
      decision.approvedQuantity ?? effectiveCandidate.requestedQuantity ?? 0,
      this.config.quantityPrecision,
    );
    if (!finitePositive(quantity) || !decision.targetSide || !decision.targetRole) return;
    const reserved = this.reserveRisk(decision.targetSide, quantity, bar.price);
    if (!reserved.approved) {
      decision.outcome = "REJECTED";
      decision.reasonCode = reserved.reasonCode;
      decision.contextSnapshot = { ...decision.contextSnapshot, ...reserved.context };
      this.rejectedDecisionCount += 1;
      const event = this.events[this.events.length - 1];
      if (event?.decisionId === decision.decisionId) {
        event.decisionOutcome = "REJECTED";
        event.reasonCode = decision.reasonCode;
      }
      return;
    }
    this.openOrAddLeg(effectiveCandidate, decision, bar, quantity);
  }

  private evaluateCandidate(candidate: BacktestPortfolioCandidate, bar: BacktestPortfolioBar): ModeDecision {
    if (isCloseAction(candidate.action)) return this.evaluateScopedClose(candidate);
    if (this.bankrupt) {
      return deterministicDecision(candidate, this.config.executionPolicy, {
        outcome: "REJECTED",
        reasonCode: "ACCOUNT_BANKRUPT",
        contextSnapshot: { equity: 0, newExposureBlocked: true },
      });
    }
    if (this.config.executionPolicy.mode === "SINGLE_EXCLUSIVE") {
      return this.evaluateS1(candidate, this.config.executionPolicy);
    }
    const raw = evaluateAdvancedMode(candidate, this.config.executionPolicy, {
      runtimeReady: true,
      openLegs: this.toRuntimeLegs(bar.price),
      capabilities: this.config.capabilities,
      lastHedgeClosedAt: this.lastHedgeClosedAt,
      now: bar.timestamp,
    });
    return { ...raw, createdAt: candidate.createdAt };
  }

  private evaluateScopedClose(candidate: BacktestPortfolioCandidate): ModeDecision {
    const side = actionSide(candidate.action);
    const targets = this.openLegs().filter(leg => candidate.action === "CLOSE_ALL" || !side || leg.side === side);
    if (targets.length === 0) {
      return deterministicDecision(candidate, this.config.executionPolicy, {
        outcome: "HOLD",
        reasonCode: "NO_MATCHING_OPEN_LEG",
        reduceOnly: true,
        contextSnapshot: { requestedSide: side ?? null },
      });
    }
    return deterministicDecision(candidate, this.config.executionPolicy, {
      outcome: "CLOSE_ONLY",
      reasonCode: candidate.action.startsWith("REDUCE_") ? "LEG_SCOPED_REDUCE" : "LEG_SCOPED_CLOSE",
      targetSide: side,
      reduceOnly: true,
      contextSnapshot: {
        closeLegIds: targets.map(leg => leg.legId),
        closeLegs: targets.map(leg => ({ legId: leg.legId, side: leg.side, quantity: leg.quantity })),
      },
    });
  }

  private evaluateS1(candidate: BacktestPortfolioCandidate, policy: SingleExclusivePolicy): ModeDecision {
    if (!candidate.side) {
      return deterministicDecision(candidate, policy, {
        outcome: "REJECTED",
        reasonCode: "TARGET_SIDE_REQUIRED",
        contextSnapshot: {},
      });
    }
    const open = this.openLegs();
    const existing = open[0];
    if (!existing) {
      if (candidate.action === "ADD_LONG" || candidate.action === "ADD_SHORT") {
        return deterministicDecision(candidate, policy, {
          outcome: "HOLD",
          reasonCode: "S1_ADD_TARGET_LEG_NOT_OPEN",
          targetSide: candidate.side,
          reduceOnly: false,
          contextSnapshot: { compatibilityPath: "legacy-s1", eventInvalidatedByEarlierExit: true },
        });
      }
      return deterministicDecision(candidate, policy, {
        outcome: "APPROVED",
        reasonCode: "S1_NEW_PRIMARY",
        targetLegId: this.nextLegId(candidate, "PRIMARY"),
        targetSide: candidate.side,
        targetRole: "PRIMARY",
        approvedQuantity: candidate.requestedQuantity,
        reduceOnly: false,
        contextSnapshot: { compatibilityPath: "legacy-s1" },
      });
    }
    if (existing.side === candidate.side) {
      return deterministicDecision(candidate, policy, {
        outcome: "APPROVED",
        reasonCode: "S1_EXISTING_LEG_ADD",
        targetLegId: existing.legId,
        targetSide: existing.side,
        targetRole: existing.role,
        approvedQuantity: candidate.requestedQuantity,
        reduceOnly: false,
        contextSnapshot: { compatibilityPath: "legacy-s1", martinScope: existing.legId },
      });
    }
    if (policy.oppositeSignalPolicy === "IGNORE") {
      return deterministicDecision(candidate, policy, {
        outcome: "HOLD",
        reasonCode: "S1_OPPOSITE_SIGNAL_IGNORED",
        contextSnapshot: { openLegId: existing.legId, openSide: existing.side },
      });
    }
    const reverse = policy.oppositeSignalPolicy === "CLOSE_THEN_REVERSE";
    return deterministicDecision(candidate, policy, {
      outcome: reverse ? "APPROVED" : "CLOSE_ONLY",
      reasonCode: reverse ? "S1_CLOSE_THEN_REVERSE" : "S1_CLOSE_THEN_WAIT",
      targetLegId: reverse ? this.nextLegId(candidate, "PRIMARY") : existing.legId,
      targetSide: reverse ? candidate.side : existing.side,
      targetRole: "PRIMARY",
      approvedQuantity: reverse ? candidate.requestedQuantity : existing.quantity,
      reduceOnly: !reverse,
      contextSnapshot: { closeLegIds: [existing.legId], compatibilityPath: "legacy-s1" },
    });
  }

  private applyCloseCandidate(
    candidate: BacktestPortfolioCandidate,
    decision: ModeDecision,
    bar: BacktestPortfolioBar,
  ): void {
    const ids = Array.isArray(decision.contextSnapshot.closeLegIds)
      ? decision.contextSnapshot.closeLegIds.filter((value): value is string => typeof value === "string")
      : [];
    const requested = roundQuantity(candidate.requestedQuantity ?? Number.POSITIVE_INFINITY, this.config.quantityPrecision);
    for (const legId of ids) {
      const leg = this.legs.get(legId);
      if (!leg || leg.status !== "OPEN") continue;
      const quantity = candidate.action.startsWith("REDUCE_")
        ? Math.min(leg.quantity, requested)
        : leg.quantity;
      this.closeLeg(
        leg,
        quantity,
        bar,
        candidate,
        decision,
        quantity + QUANTITY_EPSILON < leg.quantity ? "REDUCE" : "CLOSE",
      );
    }
  }

  private reserveRisk(
    side: PositionSide,
    quantity: number,
    price: number,
  ): { approved: true } | { approved: false; reasonCode: string; context: Record<string, unknown> } {
    const existing = this.openLegs();
    const proposedNotional = price * quantity;
    const gross = existing.reduce((sum, leg) => sum + leg.quantity * price, 0) + proposedNotional;
    const net = existing.reduce((sum, leg) => sum + signedDirection(leg.side) * leg.quantity * price, 0)
      + signedDirection(side) * proposedNotional;
    const margin = gross / this.config.leverage;
    const riskEquity = this.currentEquity(price);
    const grossLimit = riskEquity * this.config.executionPolicy.riskBudget.maxGrossNotionalPct / 100;
    const marginLimit = riskEquity * this.config.executionPolicy.riskBudget.maxMarginUsagePct / 100;
    if (gross > grossLimit + MONEY_EPSILON) {
      return {
        approved: false,
        reasonCode: "RISK_GROSS_NOTIONAL_LIMIT",
        context: { proposedGrossNotional: gross, grossLimit, proposedNetNotional: net },
      };
    }
    if (margin > marginLimit + MONEY_EPSILON) {
      return {
        approved: false,
        reasonCode: "RISK_MARGIN_USAGE_LIMIT",
        context: { proposedMarginUsage: margin, marginLimit, proposedGrossNotional: gross },
      };
    }
    return { approved: true };
  }

  private openOrAddLeg(
    candidate: BacktestPortfolioCandidate,
    decision: ModeDecision,
    bar: BacktestPortfolioBar,
    quantity: number,
  ): void {
    const side = decision.targetSide!;
    const role = decision.targetRole!;
    const targetId = decision.targetLegId || this.nextLegId(candidate, role);
    const existing = this.legs.get(targetId);
    const fillPrice = this.executionPrice(side, bar.price, false);
    const notional = fillPrice * quantity;
    const fee = notional * this.config.commissionRate;

    if (existing?.status === "OPEN") {
      if (existing.side !== side || existing.role !== role) throw new Error("target leg identity conflict");
      existing.layers.push({ price: fillPrice, quantity, fee, timestamp: bar.timestamp });
      existing.quantity = roundQuantity(existing.quantity + quantity, this.config.quantityPrecision);
      existing.averageEntryPrice = existing.layers.reduce((sum, layer) => sum + layer.price * layer.quantity, 0)
        / existing.quantity;
      existing.fees += fee;
      existing.entryFeeBalance += fee;
      existing.turnover += notional;
      existing.maxNotional = Math.max(existing.maxNotional, existing.quantity * fillPrice);
      existing.addCount += 1;
      this.recordFill(candidate, decision, existing, "ADD", quantity, fillPrice, fee, bar.timestamp);
      return;
    }

    const cycleId = role === "HEDGE"
      ? this.openLegs().find(leg => leg.role === "PRIMARY")?.cycleId ?? this.nextCycleId(bar.timestamp)
      : this.nextCycleId(bar.timestamp);
    const leg: PortfolioLeg = {
      legId: targetId,
      cycleId,
      side,
      role,
      status: "OPEN",
      layers: [{ price: fillPrice, quantity, fee, timestamp: bar.timestamp }],
      quantity,
      averageEntryPrice: fillPrice,
      openedAt: bar.timestamp,
      closedAt: null,
      closePrice: null,
      exitReason: null,
      realizedGrossPnl: 0,
      fees: fee,
      entryFeeBalance: fee,
      exitFees: 0,
      funding: 0,
      fundingBalance: 0,
      turnover: notional,
      maxNotional: notional,
      mfePct: 0,
      maePct: 0,
      addCount: 0,
      closeCount: 0,
    };
    this.legs.set(leg.legId, leg);
    this.recordFill(candidate, decision, leg, "OPEN", quantity, fillPrice, fee, bar.timestamp);
    if (role === "HEDGE") this.createHedgeRelationship(leg, bar.price, bar.timestamp);
  }

  private closeLeg(
    leg: PortfolioLeg,
    requestedQuantity: number,
    bar: BacktestPortfolioBar,
    candidate: BacktestPortfolioCandidate,
    decision: ModeDecision,
    action: "REDUCE" | "CLOSE",
  ): void {
    const quantity = roundQuantity(Math.min(leg.quantity, requestedQuantity), this.config.quantityPrecision);
    if (!finitePositive(quantity)) return;
    const price = this.executionPrice(leg.side, bar.price, true);
    const notional = price * quantity;
    const closeFee = notional * this.config.commissionRate;
    const grossPnl = signedDirection(leg.side) * (price - leg.averageEntryPrice) * quantity;
    const allocatedEntryFee = leg.quantity > 0 ? leg.entryFeeBalance * (quantity / leg.quantity) : 0;
    const allocatedFunding = leg.quantity > 0 ? leg.fundingBalance * (quantity / leg.quantity) : 0;
    const tradePnl = grossPnl + allocatedFunding - allocatedEntryFee - closeFee;

    leg.realizedGrossPnl += grossPnl;
    leg.fees += closeFee;
    leg.entryFeeBalance = Math.max(0, leg.entryFeeBalance - allocatedEntryFee);
    leg.exitFees += closeFee;
    leg.fundingBalance -= allocatedFunding;
    leg.turnover += notional;
    leg.quantity = roundQuantity(leg.quantity - quantity, this.config.quantityPrecision);
    leg.closeCount += 1;
    this.trades.push({
      tradeId: `trade:${candidate.candidateId}:${leg.legId}:${leg.closeCount}`.slice(0, 128),
      legId: leg.legId,
      cycleId: leg.cycleId,
      side: leg.side,
      role: leg.role,
      entryTime: leg.openedAt,
      exitTime: bar.timestamp,
      entryPrice: leg.averageEntryPrice,
      exitPrice: price,
      quantity,
      grossPnl: roundBacktestMoney(grossPnl),
      fees: roundBacktestMoney(allocatedEntryFee + closeFee),
      funding: roundBacktestMoney(allocatedFunding),
      pnl: roundBacktestMoney(tradePnl),
      exitReason: candidate.reasonCode,
      martinLayer: leg.layers.length,
    });
    this.recordFill(candidate, decision, leg, action, quantity, price, closeFee, bar.timestamp);

    if (leg.quantity <= QUANTITY_EPSILON) {
      leg.quantity = 0;
      leg.status = "CLOSED";
      leg.closedAt = bar.timestamp;
      leg.closePrice = price;
      leg.exitReason = candidate.reasonCode;
      this.closeRelationshipForLeg(leg, bar.timestamp, candidate.reasonCode);
    }
  }

  private executionPrice(side: PositionSide, mark: number, closing: boolean): number {
    const direction = signedDirection(side) * (closing ? -1 : 1);
    return mark * (1 + direction * this.config.slippageRate);
  }

  private recordDecision(
    candidate: BacktestPortfolioCandidate,
    decision: ModeDecision,
    eventKind: BacktestIntrabarEventKind,
  ): void {
    this.decisions.push(decision);
    if (decision.outcome === "REJECTED" || decision.outcome === "RECONCILIATION_REQUIRED") {
      this.rejectedDecisionCount += 1;
    }
    this.eventSequence += 1;
    this.events.push({
      eventId: `event:${this.config.deploymentId}:${candidate.barTimestamp ?? candidate.createdAt}:${this.eventSequence}`,
      timestamp: candidate.barTimestamp ?? candidate.createdAt,
      sequence: this.eventSequence,
      eventKind,
      candidateId: candidate.candidateId,
      decisionId: decision.decisionId,
      decisionOutcome: decision.outcome,
      reasonCode: decision.reasonCode,
      legId: decision.targetLegId,
    });
  }

  private recordFill(
    candidate: CandidateIntent,
    decision: ModeDecision,
    leg: PortfolioLeg,
    action: BacktestPortfolioFill["action"],
    quantity: number,
    price: number,
    fee: number,
    timestamp: number,
  ): void {
    this.fillSequence += 1;
    this.fills.push({
      fillId: `fill:${this.config.deploymentId}:${timestamp}:${this.fillSequence}`,
      candidateId: candidate.candidateId,
      decisionId: decision.decisionId,
      legId: leg.legId,
      cycleId: leg.cycleId,
      side: leg.side,
      role: leg.role,
      action,
      quantity,
      price,
      notional: price * quantity,
      fee,
      timestamp,
      reasonCode: decision.reasonCode,
    });
  }

  private applyFunding(bar: BacktestPortfolioBar): void {
    if (!bar.fundingRate || !Number.isFinite(bar.fundingRate)) return;
    for (const leg of this.openLegs()) {
      const payment = leg.quantity * bar.price * bar.fundingRate * (leg.side === "LONG" ? -1 : 1);
      leg.funding += payment;
      leg.fundingBalance += payment;
    }
  }

  private markMarket(bar: BacktestPortfolioBar): void {
    const open = this.openLegs();
    if (this.lastMarkedAt !== null && bar.timestamp > this.lastMarkedAt && open.length >= 2) {
      this.overlapDurationMs += bar.timestamp - this.lastMarkedAt;
    }
    let gross = 0;
    let net = 0;
    for (const leg of open) {
      const notional = leg.quantity * bar.price;
      gross += Math.abs(notional);
      net += signedDirection(leg.side) * notional;
      leg.maxNotional = Math.max(leg.maxNotional, notional);
      const high = bar.high ?? bar.price;
      const low = bar.low ?? bar.price;
      const favorable = leg.side === "LONG" ? high : low;
      const adverse = leg.side === "LONG" ? low : high;
      leg.mfePct = Math.max(leg.mfePct, this.priceMovePct(leg, favorable));
      leg.maePct = Math.min(leg.maePct, this.priceMovePct(leg, adverse));
    }
    const margin = gross / this.config.leverage;
    const equity = this.currentEquity(bar.price);
    const headroom = equity - margin;
    this.grossExposurePeak = Math.max(this.grossExposurePeak, gross);
    this.netExposureAbsPeak = Math.max(this.netExposureAbsPeak, Math.abs(net));
    this.marginUsagePeak = Math.max(this.marginUsagePeak, margin);
    this.marginHeadroomLow = Math.min(this.marginHeadroomLow, headroom);
    this.lastMarkedAt = bar.timestamp;
    this.lastPrice = bar.price;
    const point = {
      timestamp: bar.timestamp,
      equity: roundBacktestMoney(equity),
      price: bar.price,
      grossExposure: roundBacktestMoney(gross),
      netExposure: roundBacktestMoney(net),
      marginUsage: roundBacktestMoney(margin),
    };
    const previous = this.equityCurve[this.equityCurve.length - 1];
    if (previous?.timestamp === bar.timestamp) this.equityCurve[this.equityCurve.length - 1] = point;
    else this.equityCurve.push(point);
  }

  private priceMovePct(leg: PortfolioLeg, price: number): number {
    if (!finitePositive(leg.averageEntryPrice)) return 0;
    return signedDirection(leg.side) * (price - leg.averageEntryPrice) / leg.averageEntryPrice * 100;
  }

  private pnlPct(leg: PortfolioLeg, price: number): number {
    return this.priceMovePct(leg, price) * this.config.leverage;
  }

  private unrealizedGrossPnl(leg: PortfolioLeg, price: number): number {
    return signedDirection(leg.side) * (price - leg.averageEntryPrice) * leg.quantity;
  }

  private rawCurrentEquity(price: number): number {
    const legs = Array.from(this.legs.values());
    const realizedGross = legs.reduce((sum, leg) => sum + leg.realizedGrossPnl, 0);
    const fees = legs.reduce((sum, leg) => sum + leg.fees, 0);
    const funding = legs.reduce((sum, leg) => sum + leg.funding, 0);
    const unrealized = this.openLegs().reduce((sum, leg) => sum + this.unrealizedGrossPnl(leg, price), 0);
    return this.config.initialCapital + realizedGross + funding - fees + unrealized;
  }

  private currentEquity(price: number): number {
    return Math.max(0, this.rawCurrentEquity(price) + this.bankruptcyAdjustment);
  }

  private applyMarginLiquidation(bar: BacktestPortfolioBar): boolean {
    const open = this.openLegs();
    const rawEquity = this.rawCurrentEquity(bar.price);
    const maintenanceMargin = open.reduce(
      (sum, leg) => sum + leg.quantity * bar.price * this.config.maintenanceMarginRate,
      0,
    );
    const mustLiquidate = open.length > 0 && (
      rawEquity <= MONEY_EPSILON
      || rawEquity <= maintenanceMargin + MONEY_EPSILON
    );
    if (!mustLiquidate) {
      if (open.length === 0 && rawEquity <= MONEY_EPSILON && !this.bankrupt) {
        this.bankruptcyAdjustment += Math.max(0, -rawEquity);
        this.bankrupt = true;
      }
      return false;
    }

    this.marginLiquidationCount += 1;
    for (const leg of [...open]) {
      const candidate: BacktestPortfolioCandidate = {
        candidateId: `margin-liquidation:${this.config.deploymentId}:${bar.timestamp}:${leg.legId}`.slice(0, 128),
        deploymentId: this.config.deploymentId,
        action: leg.side === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT",
        side: leg.side,
        requestedQuantity: leg.quantity,
        signalPrice: bar.price,
        barTimestamp: bar.timestamp,
        source: "RISK",
        reasonCode: "MARGIN_LIQUIDATION",
        reason: "權益不足以維持保證金，回測強制平倉",
        createdAt: bar.timestamp,
        eventKind: "FORCED_RISK_EXIT",
      };
      const decision = deterministicDecision(candidate, this.config.executionPolicy, {
        outcome: "CLOSE_ONLY",
        reasonCode: "MARGIN_LIQUIDATION",
        targetLegId: leg.legId,
        targetSide: leg.side,
        targetRole: leg.role,
        approvedQuantity: leg.quantity,
        reduceOnly: true,
        contextSnapshot: {
          closeLegIds: [leg.legId],
          rawEquity,
          maintenanceMargin,
        },
      });
      this.recordDecision(candidate, decision, "FORCED_RISK_EXIT");
      this.closeLeg(leg, leg.quantity, bar, candidate, decision, "CLOSE");
    }

    const postLiquidationEquity = this.rawCurrentEquity(bar.price);
    if (postLiquidationEquity <= MONEY_EPSILON) {
      this.bankruptcyAdjustment += Math.max(0, -postLiquidationEquity);
      this.bankrupt = true;
    }
    return true;
  }

  private applyAutomaticHedgeLifecycle(bar: BacktestPortfolioBar): void {
    if (this.config.executionPolicy.mode !== "HEDGE_GUARDED") return;
    const policy = this.config.executionPolicy;
    const primary = this.openLegs().find(leg => leg.role === "PRIMARY");
    const hedge = this.openLegs().find(leg => leg.role === "HEDGE");
    if (!primary || !hedge || policy.unwindPolicy !== "CLOSE_HEDGE_ON_RECOVERY") return;
    const heldMs = bar.timestamp - hedge.openedAt;
    if (heldMs < policy.minimumHedgeHoldSeconds * 1_000 || this.pnlPct(primary, bar.price) < 0) return;
    const candidate: BacktestPortfolioCandidate = {
      candidateId: `auto-unwind:${this.config.deploymentId}:${bar.timestamp}:${hedge.legId}`.slice(0, 128),
      deploymentId: this.config.deploymentId,
      action: hedge.side === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT",
      side: hedge.side,
      requestedQuantity: hedge.quantity,
      signalPrice: bar.price,
      barTimestamp: bar.timestamp,
      source: "RISK",
      reasonCode: "H3_PRIMARY_RECOVERED",
      reason: "主腿恢復，解除保護腿",
      createdAt: bar.timestamp,
      eventKind: "HEDGE_UNWIND",
    };
    this.processCandidate(candidate, bar);
  }

  private rebalanceActiveHedge(bar: BacktestPortfolioBar): void {
    if (this.config.executionPolicy.mode !== "HEDGE_GUARDED") return;
    const policy = this.config.executionPolicy;
    const primary = this.openLegs().find(leg => leg.role === "PRIMARY");
    const hedge = this.openLegs().find(leg => leg.role === "HEDGE");
    if (!primary || !hedge) return;
    const target = roundQuantity(primary.quantity * policy.hedgeRatio, this.config.quantityPrecision);
    const difference = roundQuantity(target - hedge.quantity, this.config.quantityPrecision);
    if (Math.abs(difference) <= QUANTITY_EPSILON) return;
    const relation = Array.from(this.relationships.values()).find(item => item.hedgeLegId === hedge.legId && item.status !== "CLOSED");
    if (difference > 0) {
      const reservation = this.reserveRisk(hedge.side, difference, bar.price);
      if (!reservation.approved) return;
      const candidate = this.syntheticRebalanceCandidate(hedge, bar, "ADD");
      const decision = deterministicDecision(candidate, policy, {
        outcome: "APPROVED",
        reasonCode: "H3_RATIO_REBALANCE_ADD",
        targetLegId: hedge.legId,
        targetSide: hedge.side,
        targetRole: "HEDGE",
        approvedQuantity: difference,
        reduceOnly: false,
        contextSnapshot: { targetRatio: policy.hedgeRatio, primaryQuantity: primary.quantity },
      });
      this.recordDecision(candidate, decision, "HEDGE_UNWIND");
      this.openOrAddLeg(candidate, decision, bar, difference);
    } else {
      const candidate = this.syntheticRebalanceCandidate(hedge, bar, "REDUCE");
      const decision = deterministicDecision(candidate, policy, {
        outcome: "CLOSE_ONLY",
        reasonCode: "H3_RATIO_REBALANCE_REDUCE",
        targetLegId: hedge.legId,
        targetSide: hedge.side,
        targetRole: "HEDGE",
        approvedQuantity: Math.abs(difference),
        reduceOnly: true,
        contextSnapshot: { closeLegIds: [hedge.legId], targetRatio: policy.hedgeRatio },
      });
      this.recordDecision(candidate, decision, "HEDGE_UNWIND");
      this.closeLeg(hedge, Math.abs(difference), bar, candidate, decision, "REDUCE");
    }
    if (relation) relation.actualRatio = primary.quantity > 0 ? hedge.quantity / primary.quantity : 0;
  }

  private syntheticRebalanceCandidate(
    hedge: PortfolioLeg,
    bar: BacktestPortfolioBar,
    action: "ADD" | "REDUCE",
  ): BacktestPortfolioCandidate {
    return {
      candidateId: `rebalance:${this.config.deploymentId}:${bar.timestamp}:${hedge.legId}:${action}`.slice(0, 128),
      deploymentId: this.config.deploymentId,
      action: action === "ADD"
        ? hedge.side === "LONG" ? "ADD_LONG" : "ADD_SHORT"
        : hedge.side === "LONG" ? "REDUCE_LONG" : "REDUCE_SHORT",
      side: hedge.side,
      signalPrice: bar.price,
      barTimestamp: bar.timestamp,
      source: "RISK",
      reasonCode: `H3_RATIO_REBALANCE_${action}`,
      reason: "H3 固定比例再平衡",
      createdAt: bar.timestamp,
      eventKind: "HEDGE_UNWIND",
    };
  }

  private createHedgeRelationship(hedge: PortfolioLeg, price: number, timestamp: number): void {
    if (this.config.executionPolicy.mode !== "HEDGE_GUARDED") return;
    const primary = this.openLegs().find(leg => leg.role === "PRIMARY");
    if (!primary) throw new Error("H3 hedge 不得缺少 primary");
    const relationshipId = `hedge:${primary.legId}:${hedge.legId}`.slice(0, 128);
    this.relationships.set(relationshipId, {
      relationshipId,
      primaryLegId: primary.legId,
      hedgeLegId: hedge.legId,
      triggeredAt: timestamp,
      closedAt: null,
      triggerLossPct: Math.abs(this.pnlPct(primary, price)),
      targetRatio: this.config.executionPolicy.hedgeRatio,
      actualRatio: hedge.quantity / primary.quantity,
      pairPnl: 0,
      hedgeCost: hedge.fees,
      unwindOutcome: null,
      counterfactualWithoutHedgePnl: 0,
      status: "ACTIVE",
    });
  }

  private closeRelationshipForLeg(leg: PortfolioLeg, timestamp: number, reason: string): void {
    for (const relation of Array.from(this.relationships.values())) {
      if (relation.status === "CLOSED") continue;
      if (relation.primaryLegId !== leg.legId && relation.hedgeLegId !== leg.legId) continue;
      const primary = this.legs.get(relation.primaryLegId);
      const hedge = this.legs.get(relation.hedgeLegId);
      if (leg.role === "HEDGE" || (!primary || primary.status === "CLOSED") && (!hedge || hedge.status === "CLOSED")) {
        relation.status = "CLOSED";
        relation.closedAt = timestamp;
        relation.unwindOutcome = reason;
        this.lastHedgeClosedAt = timestamp;
      } else {
        relation.status = "UNWINDING";
      }
    }
  }

  private nextLegId(candidate: CandidateIntent, role: PositionLegRole): string {
    this.legSequence += 1;
    return `btleg:${this.config.deploymentId}:${candidate.createdAt}:${this.legSequence}:${role}`.slice(0, 128);
  }

  private nextCycleId(timestamp: number): string {
    this.cycleSequence += 1;
    return `btcycle:${this.config.deploymentId}:${timestamp}:${this.cycleSequence}`.slice(0, 128);
  }

  private buildResult(policy: BacktestEndPositionPolicy): ThreeModePortfolioResult {
    const price = this.lastPrice;
    const attributions = this.buildLegAttributions(price);
    const openLegs = this.openLegs().map(leg => this.buildOpenLegSnapshot(leg, price));
    const relationships = Array.from(this.relationships.values()).map(relation => {
      const primary = this.legs.get(relation.primaryLegId);
      const hedge = this.legs.get(relation.hedgeLegId);
      const primaryPnl = primary ? this.totalLegPnl(primary, price) : 0;
      const hedgePnl = hedge ? this.totalLegPnl(hedge, price) : 0;
      const hedgeCost = hedge ? hedge.fees - hedge.funding : 0;
      return {
        ...relation,
        actualRatio: primary && hedge && primary.quantity > 0 ? hedge.quantity / primary.quantity : relation.actualRatio,
        pairPnl: roundBacktestMoney(primaryPnl + hedgePnl),
        hedgeCost: roundBacktestMoney(hedgeCost),
        counterfactualWithoutHedgePnl: roundBacktestMoney(primaryPnl),
      } satisfies HedgeRelationshipState;
    });
    const realizedPnl = this.trades.reduce((sum, trade) => sum + trade.pnl, 0);
    const unrealizedPnl = openLegs.reduce((sum, leg) => sum + leg.unrealizedPnl, 0);
    const finalEquity = roundBacktestMoney(this.currentEquity(price));
    const expectedFinalEquity = roundBacktestMoney(
      this.config.initialCapital + realizedPnl + unrealizedPnl + this.bankruptcyAdjustment,
    );
    const difference = roundBacktestMoney(finalEquity - expectedFinalEquity);
    const grossExposure = openLegs.reduce((sum, leg) => sum + leg.markPrice * leg.size, 0);
    const netExposure = openLegs.reduce(
      (sum, leg) => sum + signedDirection(leg.sideCode) * leg.markPrice * leg.size,
      0,
    );
    const accounting: BacktestAccountingSnapshot = {
      initialCapital: roundBacktestMoney(this.config.initialCapital),
      realizedPnl: roundBacktestMoney(realizedPnl),
      unrealizedPnl: roundBacktestMoney(unrealizedPnl),
      finalEquity,
      expectedFinalEquity,
      reconciliationDifference: difference,
      balanced: Math.abs(difference) <= BACKTEST_ACCOUNTING_TOLERANCE,
      reconciled: Math.abs(difference) <= BACKTEST_ACCOUNTING_TOLERANCE,
      tolerance: BACKTEST_ACCOUNTING_TOLERANCE,
      openPosition: openLegs[0] ?? null,
      openPositions: openLegs,
      openPositionCount: openLegs.length,
      syntheticForceCloseCount: policy === "force_close"
        ? this.trades.filter(trade => trade.exitReason === "END_OF_DATA_FORCE_CLOSE").length
        : 0,
      grossExposure: roundBacktestMoney(grossExposure),
      netExposure: roundBacktestMoney(netExposure),
      bankruptcyAdjustment: roundBacktestMoney(this.bankruptcyAdjustment),
      marginLiquidationCount: this.marginLiquidationCount,
      bankrupt: this.bankrupt,
    };
    if (!accounting.reconciled) {
      throw new Error(
        `三模式回測帳本對帳失敗：final=${finalEquity}, expected=${expectedFinalEquity}, diff=${difference}`,
      );
    }

    const legAccounting: BacktestLegAccounting = {
      version: "backtest-leg-accounting-v1",
      executionMode: this.config.executionPolicy.mode,
      legs: attributions,
      openLegs,
      hedgeRelationships: relationships.map(({ status: _status, ...relationship }) => relationship),
      grossExposurePeak: roundBacktestMoney(this.grossExposurePeak),
      netExposureAbsPeak: roundBacktestMoney(this.netExposureAbsPeak),
      marginUsagePeak: roundBacktestMoney(this.marginUsagePeak),
      marginHeadroomLow: roundBacktestMoney(this.marginHeadroomLow),
      turnover: roundBacktestMoney(attributions.reduce((sum, leg) => sum + leg.turnover, 0)),
      fees: roundBacktestMoney(attributions.reduce((sum, leg) => sum + leg.fees, 0)),
      funding: roundBacktestMoney(attributions.reduce((sum, leg) => sum + leg.funding, 0)),
      overlapDurationMs: this.overlapDurationMs,
      eventCount: this.events.length,
      decisionCount: this.decisions.length,
      rejectedDecisionCount: this.rejectedDecisionCount,
      marginLiquidationCount: this.marginLiquidationCount,
      bankrupt: this.bankrupt,
    };
    const byRole = (role: PositionLegRole) => attributions
      .filter(leg => leg.role === role)
      .reduce((sum, leg) => sum + leg.realizedPnl, 0);
    const bySide = (side: PositionSide) => attributions
      .filter(leg => leg.sideCode === side)
      .reduce((sum, leg) => sum + leg.realizedPnl, 0);
    const modeResults: BacktestModeResults = {
      version: "backtest-mode-results-v1",
      executionMode: this.config.executionPolicy.mode,
      comparisonGroupId: "",
      fairComparisonEligible: false,
      fairnessBlockers: ["COMPARISON_CONTEXT_NOT_ATTACHED"],
      intrabarEventPolicy: "risk_first",
      intrabarEventOrder: BACKTEST_INTRABAR_EVENT_ORDER,
      grossExposurePeak: legAccounting.grossExposurePeak,
      netExposureAbsPeak: legAccounting.netExposureAbsPeak,
      marginHeadroomLow: legAccounting.marginHeadroomLow,
      turnover: legAccounting.turnover,
      fees: legAccounting.fees,
      funding: legAccounting.funding,
      longRealizedPnl: roundBacktestMoney(bySide("LONG")),
      shortRealizedPnl: roundBacktestMoney(bySide("SHORT")),
      primaryRealizedPnl: roundBacktestMoney(byRole("PRIMARY")),
      hedgeRealizedPnl: roundBacktestMoney(byRole("HEDGE")),
      pairPnl: roundBacktestMoney(relationships.reduce((sum, item) => sum + item.pairPnl, 0)),
      hedgeCost: roundBacktestMoney(relationships.reduce((sum, item) => sum + item.hedgeCost, 0)),
      counterfactualWithoutHedgePnl: roundBacktestMoney(
        relationships.reduce((sum, item) => sum + item.counterfactualWithoutHedgePnl, 0),
      ),
      overlapDurationMs: this.overlapDurationMs,
      marginLiquidationCount: this.marginLiquidationCount,
      bankrupt: this.bankrupt,
    };
    return {
      decisions: [...this.decisions],
      fills: [...this.fills],
      trades: [...this.trades],
      events: [...this.events],
      equityCurve: [...this.equityCurve],
      accounting,
      legAccounting,
      modeResults,
    };
  }

  private buildLegAttributions(price: number): BacktestLegAttribution[] {
    return Array.from(this.legs.values()).map(leg => {
      const realizedPnl = this.trades
        .filter(trade => trade.legId === leg.legId)
        .reduce((sum, trade) => sum + trade.pnl, 0);
      const unrealizedPnl = leg.status === "OPEN"
        ? this.unrealizedGrossPnl(leg, price) + leg.fundingBalance - leg.entryFeeBalance
        : 0;
      return {
        legId: leg.legId,
        side: uiSide(leg.side),
        sideCode: leg.side,
        role: leg.role,
        cycleId: leg.cycleId,
        tradeCount: leg.closeCount,
        addCount: leg.addCount,
        realizedPnl: roundBacktestMoney(realizedPnl),
        unrealizedPnl: roundBacktestMoney(unrealizedPnl),
        grossPnl: roundBacktestMoney(leg.realizedGrossPnl + (leg.status === "OPEN" ? this.unrealizedGrossPnl(leg, price) : 0)),
        fees: roundBacktestMoney(leg.fees),
        funding: roundBacktestMoney(leg.funding),
        turnover: roundBacktestMoney(leg.turnover),
        maxNotional: roundBacktestMoney(leg.maxNotional),
        mfePct: Number(leg.mfePct.toFixed(6)),
        maePct: Number(leg.maePct.toFixed(6)),
        openedAt: leg.openedAt,
        closedAt: leg.closedAt,
        exitReason: leg.exitReason,
      };
    });
  }

  private buildOpenLegSnapshot(leg: PortfolioLeg, price: number): BacktestOpenLegSnapshot {
    const entryNotional = leg.layers.reduce((sum, layer) => sum + layer.price * layer.quantity, 0);
    const unrealizedGrossPnl = this.unrealizedGrossPnl(leg, price);
    return {
      legId: leg.legId,
      role: leg.role,
      sideCode: leg.side,
      martinLayer: Math.max(0, leg.layers.length - 1),
      lastEntryPrice: leg.layers[leg.layers.length - 1]?.price ?? leg.averageEntryPrice,
      openedAt: leg.openedAt,
      mfePct: Number(leg.mfePct.toFixed(6)),
      maePct: Number(leg.maePct.toFixed(6)),
      side: uiSide(leg.side),
      entryTime: leg.openedAt,
      averageEntryPrice: leg.averageEntryPrice,
      size: leg.quantity,
      markPrice: price,
      entryNotional: roundBacktestMoney(entryNotional),
      entryFees: roundBacktestMoney(leg.entryFeeBalance),
      unrealizedGrossPnl: roundBacktestMoney(unrealizedGrossPnl),
      unrealizedPnl: roundBacktestMoney(unrealizedGrossPnl + leg.fundingBalance - leg.entryFeeBalance),
    };
  }

  private totalLegPnl(leg: PortfolioLeg, price: number): number {
    const realized = this.trades
      .filter(trade => trade.legId === leg.legId)
      .reduce((sum, trade) => sum + trade.pnl, 0);
    const unrealized = leg.status === "OPEN"
      ? this.unrealizedGrossPnl(leg, price) + leg.fundingBalance - leg.entryFeeBalance
      : 0;
    return realized + unrealized;
  }
}

export function createThreeModePortfolioKernel(config: ThreeModePortfolioConfig): ThreeModePortfolioKernel {
  return new ThreeModePortfolioKernel(config);
}
