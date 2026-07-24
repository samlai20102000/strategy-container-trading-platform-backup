/**
 * 參數掃描優化器（pasted_content_4.txt 任務 11）
 * 笛卡爾積組合掃描 + 批次併發控制 + 目標函數排序 + 2 參數熱力圖
 */

import { backtestEngine, type BacktestRequest } from "./backtestEngine";
import type { PerformanceMetrics } from "./performanceCalculator";

export interface ParameterRange {
  name: string;
  min: number;
  max: number;
  step: number;
}

export type ObjectiveKey =
  | "sharpeRatio"
  | "totalReturn"
  | "profitFactor"
  | "calmarRatio"
  | "winRate";

export interface OptimizationRequest {
  baseRequest: BacktestRequest;
  parameterRanges: ParameterRange[];
  objective: ObjectiveKey;
  maxCombinations?: number;
}

export interface OptimizationResultItem {
  rank: number;
  params: Record<string, number>;
  metrics: PerformanceMetrics;
  objectiveValue: number;
}

export interface OptimizationSummary {
  best: OptimizationResultItem | null;
  worst: OptimizationResultItem | null;
  allResults: OptimizationResultItem[];
  totalCombinations: number;
  executionTimeMs: number;
  heatmapData: Array<{ param1: number; param2: number; value: number }> | null;
  param1Name: string | null;
  param2Name: string | null;
}

const MAX_CONCURRENT = 2; // 沙盒/部署資源保護（原提供代碼為 4）
const DEFAULT_MAX_COMBINATIONS = 60;

/** 生成參數組合（笛卡爾積） */
export function generateCombinations(ranges: ParameterRange[]): Array<Record<string, number>> {
  if (ranges.length === 0) return [];

  const valueLists = ranges.map((r) => {
    const values: number[] = [];
    // 避免浮點誤差
    const steps = Math.floor((r.max - r.min) / r.step + 1e-9);
    for (let i = 0; i <= steps; i++) {
      values.push(Math.round((r.min + i * r.step) * 1e8) / 1e8);
    }
    return values;
  });

  let combos: Array<Record<string, number>> = [{}];
  for (let idx = 0; idx < ranges.length; idx++) {
    const next: Array<Record<string, number>> = [];
    for (const combo of combos) {
      for (const v of valueLists[idx]) {
        next.push({ ...combo, [ranges[idx].name]: v });
      }
    }
    combos = next;
  }
  return combos;
}

/**
 * 執行參數掃描優化
 */
export async function runOptimization(
  request: OptimizationRequest,
  onProgress?: (pct: number, message: string) => void,
): Promise<OptimizationSummary> {
  const started = Date.now();
  const combos = generateCombinations(request.parameterRanges);
  const maxCombos = request.maxCombinations ?? DEFAULT_MAX_COMBINATIONS;

  if (combos.length === 0) throw new Error("未提供有效的參數範圍");
  if (combos.length > maxCombos) {
    throw new Error(
      `參數組合數 ${combos.length} 超過上限 ${maxCombos}，請增大步長或縮小範圍`,
    );
  }

  const results: OptimizationResultItem[] = [];
  let completed = 0;

  // 批次併發執行
  for (let i = 0; i < combos.length; i += MAX_CONCURRENT) {
    const batch = combos.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.allSettled(
      batch.map(async (params) => {
        const req: BacktestRequest = {
          ...request.baseRequest,
          config: { ...request.baseRequest.config, ...params },
        };
        const result = await backtestEngine.runBacktest(req);
        return { params, metrics: result.metrics };
      }),
    );

    for (const br of batchResults) {
      completed++;
      if (br.status === "fulfilled") {
        const objectiveValue = br.value.metrics[request.objective];
        results.push({
          rank: 0,
          params: br.value.params,
          metrics: br.value.metrics,
          objectiveValue: Number.isFinite(objectiveValue) ? objectiveValue : -Infinity,
        });
      }
    }
    onProgress?.(
      Math.round((completed / combos.length) * 100),
      `已完成 ${completed}/${combos.length} 組參數回測`,
    );
  }

  // 按目標函數排序並標記排名
  results.sort((a, b) => b.objectiveValue - a.objectiveValue);
  results.forEach((r, idx) => (r.rank = idx + 1));

  // 2 參數時生成熱力圖數據
  let heatmapData: Array<{ param1: number; param2: number; value: number }> | null = null;
  let param1Name: string | null = null;
  let param2Name: string | null = null;
  if (request.parameterRanges.length === 2) {
    param1Name = request.parameterRanges[0].name;
    param2Name = request.parameterRanges[1].name;
    heatmapData = results.map((r) => ({
      param1: r.params[param1Name as string],
      param2: r.params[param2Name as string],
      value: r.metrics.sharpeRatio,
    }));
  }

  return {
    best: results[0] ?? null,
    worst: results[results.length - 1] ?? null,
    allResults: results,
    totalCombinations: combos.length,
    executionTimeMs: Date.now() - started,
    heatmapData,
    param1Name,
    param2Name,
  };
}
