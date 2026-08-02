export type BacktestJobPhase = "QUEUED" | "PREPARING" | "RUNNING" | "FINALIZING";

export interface BacktestJobCheckpoint {
  phase: BacktestJobPhase;
  processedBars: number;
  totalBars: number;
  progress: number;
  message: string;
  force?: boolean;
}

/**
 * 所有現有與未來回測 runner 的共用控制面。
 * 策略核心不得直接讀寫 backtest_jobs；只能在安全邊界回報 checkpoint。
 */
export interface BacktestJobControl {
  readonly signal: AbortSignal;
  checkpoint(input: BacktestJobCheckpoint): Promise<void>;
  throwIfCancelled(): Promise<void>;
}

export class BacktestExecutionCancelledError extends Error {
  readonly code = "BACKTEST_CANCELLED";

  constructor(message = "回測已取消") {
    super(message);
    this.name = "BacktestExecutionCancelledError";
  }
}

export function throwIfBacktestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BacktestExecutionCancelledError();
}
