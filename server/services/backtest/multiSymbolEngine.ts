/**
 * 多品種同時回測（pasted_content_4.txt 任務 15）
 * 串行逐個回測多個交易對，按總回報排序，生成 Markdown 摘要
 */

import { backtestEngine, type BacktestRequest, type BacktestResult } from "./backtestEngine";
import type { PerformanceMetrics } from "./performanceCalculator";

export interface MultiSymbolResultItem {
  symbol: string;
  success: boolean;
  metrics?: PerformanceMetrics;
  runId?: string;
  execution?: BacktestResult["execution"];
  modeResults?: BacktestResult["modeResults"];
  legAccounting?: BacktestResult["legAccounting"];
  error?: string;
}

export interface MultiSymbolSummary {
  results: MultiSymbolResultItem[];
  bestSymbol: string | null;
  worstSymbol: string | null;
  reportMarkdown: string;
  executionTimeMs: number;
}

/**
 * 執行多品種回測（串行，避免資源競爭與 API 限速）
 */
export async function runMultiSymbolBacktest(
  symbols: string[],
  baseRequest: Omit<BacktestRequest, "symbol">,
  onProgress?: (pct: number, message: string) => void,
): Promise<MultiSymbolSummary> {
  const started = Date.now();
  if (symbols.length === 0) throw new Error("請至少提供一個交易對");
  if (symbols.length > 10) throw new Error("多品種回測最多支持 10 個交易對");

  const results: MultiSymbolResultItem[] = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    onProgress?.(
      Math.round((i / symbols.length) * 100),
      `回測 ${symbol}（${i + 1}/${symbols.length}）...`,
    );
    try {
      const result = await backtestEngine.runBacktest({ ...baseRequest, symbol });
      results.push({
        symbol,
        success: true,
        metrics: result.metrics,
        runId: result.runId,
        execution: result.execution,
        modeResults: result.modeResults,
        legAccounting: result.legAccounting,
      });
    } catch (e) {
      results.push({
        symbol,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 按總回報排序
  const succeeded = results.filter((r) => r.success && r.metrics);
  succeeded.sort((a, b) => (b.metrics?.totalReturn ?? 0) - (a.metrics?.totalReturn ?? 0));
  const failed = results.filter((r) => !r.success);
  const sorted = [...succeeded, ...failed];

  onProgress?.(100, "多品種回測完成");

  return {
    results: sorted,
    bestSymbol: succeeded[0]?.symbol ?? null,
    worstSymbol: succeeded[succeeded.length - 1]?.symbol ?? null,
    reportMarkdown: generateSummaryReport(sorted),
    executionTimeMs: Date.now() - started,
  };
}

/** 生成 Markdown 摘要報告 */
export function generateSummaryReport(results: MultiSymbolResultItem[]): string {
  const lines: string[] = [
    "# 多品種回測摘要",
    "",
    "| 排名 | 交易對 | 總回報 | 勝率 | 最大回撤 | 夏普 | 利潤因子 | 交易數 |",
    "|---|---|---|---|---|---|---|---|",
  ];
  let rank = 1;
  for (const r of results) {
    if (r.success && r.metrics) {
      const m = r.metrics;
      lines.push(
        `| ${rank++} | ${r.symbol} | ${m.totalReturn}% | ${m.winRate}% | ${m.maxDrawdown}% | ${m.sharpeRatio} | ${m.profitFactor} | ${m.totalTrades} |`,
      );
    } else {
      lines.push(`| - | ${r.symbol} | 失敗：${r.error ?? "未知錯誤"} | - | - | - | - | - |`);
    }
  }
  return lines.join("\n");
}
