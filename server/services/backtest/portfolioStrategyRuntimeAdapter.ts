import type { ExecutionMode, ExecutionPolicy } from "../../../shared/executionModes";
import type { BaseStrategy } from "../../strategies/base";
import type { BacktestOpenLegSnapshot } from "./backtestContracts";
import type { OHLCVRow } from "./backtestDatabase";
import type { BacktestPortfolioCandidate } from "./threeModePortfolioKernel";

export interface PortfolioAdapterIndicators {
  kamaFast: number | null;
  kamaSlow: number | null;
  atr: number;
  atrAverage: number;
}

export interface PortfolioAdapterIntent {
  action: BacktestPortfolioCandidate["action"];
  reasonCode: string;
  quantity?: number;
  eventKind?: BacktestPortfolioCandidate["eventKind"];
}

export interface PortfolioAdapterBarContext {
  index: number;
  timestamp: number;
  candle: OHLCVRow;
  /** O(1) bounded history accessor. Offset 1 means the previous closed bar. */
  previousCandle(offset: number): OHLCVRow | undefined;
  config: Readonly<Record<string, unknown>>;
  strategy: BaseStrategy;
  executionMode: ExecutionMode;
  executionPolicy: ExecutionPolicy;
  initialCapital: number;
  baseLotUsdt: number;
  openLegs: readonly BacktestOpenLegSnapshot[];
  indicators: PortfolioAdapterIndicators;
  consecutiveLosses: number;
  closedTradeCount: number;
}

export interface PortfolioAdapterBarDecision {
  /** 策略專屬管理候選；runner 仍會先加入全域強制風控。 */
  management: readonly PortfolioAdapterIntent[];
  /** 策略專屬入場候選；不得由 runner 以 generic 指標猜測補齊。 */
  entries: readonly PortfolioAdapterIntent[];
}

export interface PortfolioAdapterCommitContext extends PortfolioAdapterBarContext {
  beforeLegs: readonly BacktestOpenLegSnapshot[];
  afterLegs: readonly BacktestOpenLegSnapshot[];
}

export interface PortfolioStrategyRuntimeAdapter {
  readonly adapterId: string;
  readonly adapterVersion: number;
  readonly ownsPositionManagement: boolean;
  evaluateBar(context: PortfolioAdapterBarContext): Promise<PortfolioAdapterBarDecision> | PortfolioAdapterBarDecision;
  onBarCommitted?(context: PortfolioAdapterCommitContext): Promise<void> | void;
}

export interface PortfolioStrategyRuntimeFactoryContext {
  strategy: BaseStrategy;
  config: Readonly<Record<string, unknown>>;
  candles: readonly OHLCVRow[];
  executionPolicy: ExecutionPolicy;
  initialCapital: number;
  baseLotUsdt: number;
}

export type PortfolioStrategyRuntimeFactory = (
  context: PortfolioStrategyRuntimeFactoryContext,
) => PortfolioStrategyRuntimeAdapter;

export function assertPortfolioStrategyRuntimeAdapter(
  adapter: PortfolioStrategyRuntimeAdapter,
  expectedId: string,
  expectedVersion: number,
): void {
  if (adapter.adapterId !== expectedId) {
    throw new Error(`PORTFOLIO_RUNTIME_ADAPTER_ID_MISMATCH:${expectedId}:${adapter.adapterId}`);
  }
  if (adapter.adapterVersion !== expectedVersion) {
    throw new Error(
      `PORTFOLIO_RUNTIME_ADAPTER_VERSION_MISMATCH:${expectedId}:expected=${expectedVersion}:actual=${adapter.adapterVersion}`,
    );
  }
  if (typeof adapter.evaluateBar !== "function") {
    throw new Error(`PORTFOLIO_RUNTIME_ADAPTER_EVALUATOR_MISSING:${expectedId}`);
  }
}
