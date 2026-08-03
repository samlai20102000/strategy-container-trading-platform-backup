import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { listBacktestReadinessMatrix } from "./backtestReadinessRegistry";

type OracleEvidence = { file: string; marker: string };

const EVIDENCE: Readonly<Record<string, OracleEvidence>> = Object.freeze({
  RAINBOW_20415_ENTRY: { file: "server/rainbow20415-core.test.ts", marker: "七線全部向上且前後排名完全一致" },
  RAINBOW_20415_MANAGE: { file: "server/rainbow20415-core.test.ts", marker: "統一決策入口在有持倉時直接走盲人管理" },
  MULTI_LEG_ACCOUNTING: { file: "server/services/backtest/threeModePortfolioKernel.test.ts", marker: "mark-to-market 與 force-close 都維持多腿單一權益帳本恆等式" },
  MARTINGALE_LAYER_ISOLATION: { file: "server/services/backtest/threeModePortfolioKernel.test.ts", marker: "M2 同時維持 LONG／SHORT，僅同向腿接收加倉與精確關腿" },

  RAINBOW_LADDER_ENTRY: { file: "server/rainbow-trend-ladder-core.test.ts", marker: "進場決策基於排名序列和全部同向" },
  RAINBOW_LADDER_MANAGEMENT: { file: "server/rainbow-trend-ladder-management.test.ts", marker: "底倉成交後進入盲人模式" },
  M30_CLOSED_BAR_SEMANTICS: { file: "server/rainbow-trend-ladder-backtest.test.ts", marker: "同一 30M 桶內不執行持倉管理" },

  KRM_ENTRY_LONG: { file: "server/kamaRainbowMartin.entry.test.ts", marker: "單調資料產生 long／short 候選" },
  KRM_ENTRY_SHORT: { file: "server/kamaRainbowMartin.entry.test.ts", marker: "單調資料產生 long／short 候選" },
  KRM_HARD_STOP: { file: "server/kamaRainbowMartin.management.test.ts", marker: "hard stop 優先於同價位馬丁加倉且多空鏡像" },
  KRM_TRAILING_EXIT: { file: "server/kamaRainbowMartin.management.test.ts", marker: "實際加倉後使用該層 trailing 覆蓋" },
  KRM_MARTIN_ADD: { file: "server/kamaRainbowMartin.management.test.ts", marker: "分層間距由上一層實際 fill 錨定" },
  KRM_CROSS_LOCK: { file: "server/kamaRainbowMartin.entry.test.ts", marker: "previous/current delta 判定 cross 與 touch" },
  KRM_TOUCH_LOCK: { file: "server/kamaRainbowMartin.entry.test.ts", marker: "previous/current delta 判定 cross 與 touch" },
  KRM_MIXED_SLOPE: { file: "server/kamaRainbowMartin.entry.test.ts", marker: "只有所有啟用線嚴格同向" },
  KRM_REENTRY: { file: "server/kamaRainbowMartin.backtest.test.ts", marker: "追蹤止盈平倉後，開啟自動重入" },

  V25_ENTRY_LONG: { file: "server/v25-strategy.test.ts", marker: "前兩根陽 K＋當前影線突破會真實開多" },
  V25_ENTRY_SHORT: { file: "server/v25-strategy.test.ts", marker: "前兩根陰 K＋當前影線跌破會真實開空" },
  V25_HARD_STOP: { file: "server/v25-strategy.test.ts", marker: "硬止損採名義價格百分比並優先平倉" },
  V25_MARTIN_RANGES: { file: "server/v25-strategy.test.ts", marker: "動態馬丁沒有固定十層上限" },
  V25_TRAILING_TP: { file: "server/v25-strategy.test.ts", marker: "追蹤止盈達啟動門檻並回撤時優先平倉" },
  V25_REENTRY_ON_TREND: { file: "server/v25-strategy.test.ts", marker: "止盈平倉保存重入旗標" },

  V35_ENTRY_GATE: { file: "server/strategies/v35/entryGate.test.ts", marker: "breakout 模式沿用前兩根同向" },
  V35_SINGLE_LEDGER: { file: "server/services/backtest/threeModePortfolioKernel.test.ts", marker: "S1 在分層加倉後依加權均價" },
  V35_M2_OPPOSITE_LEGS: { file: "server/services/backtest/advancedKamaPortfolioBacktest.test.ts", marker: "M2 在趨勢反轉後保留 LONG／SHORT" },
  V35_H3_HEDGE_GUARD: { file: "server/services/backtest/advancedKamaPortfolioBacktest.test.ts", marker: "H3 只有主腿浮虧且出現反向信號" },

  V41_ENTRY_OPEN: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V41_ENTRY_OPEN：" },
  V41_NO_PATTERN: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V41_NO_PATTERN / V41_FAST_SLOW_EQUAL" },
  V41_FAST_SLOW_EQUAL: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V41_FAST_SLOW_EQUAL" },
  V41_PRICE_EQUALS_SLOW: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V41_PRICE_EQUALS_SLOW" },
  V41_DIRECTION_CONFLICT: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V41_DIRECTION_CONFLICT" },
  V41_AND_WAITING_FOR_ALL: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V41_AND_WAITING_FOR_ALL" },
  V41_OR_NO_DIRECTION: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V41_OR_NO_DIRECTION" },
  V41_REENTRY: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V41_REENTRY：" },

  V50_ENTRY: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V50_ENTRY：" },
  V50_F1_REGIME: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V50_F1_REGIME / V50_PARTIAL_TP" },
  V50_TRAILING_EXIT: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V50_TRAILING_EXIT：" },
  V50_DYNAMIC_MARTIN: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V50_DYNAMIC_MARTIN：" },
  V50_PARTIAL_TP: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V50_F1_REGIME / V50_PARTIAL_TP" },
  V50_MULTI_MODE_ACCOUNTING: { file: "server/services/backtest/advancedKamaPortfolioBacktest.test.ts", marker: "維持單一權益帳本" },

  V61_BACKTEST_ORACLE: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V61_LIVE_ORACLE / V61_BACKTEST_ORACLE" },
  V61_LIVE_ORACLE: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V61_LIVE_ORACLE / V61_BACKTEST_ORACLE" },
  V61_ZONE_TRIGGER_PARITY: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V61_ZONE_TRIGGER_PARITY：" },
  V61_DIRECTION_MODE_PARITY: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V61_DIRECTION_MODE_PARITY：" },
  V61_NEGATIVE_EQUITY: { file: "server/services/backtest/threeModePortfolioKernel.test.ts", marker: "gap loss 觸發 margin liquidation，權益以零為下限" },

  V70_MA200: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V70_MA200 / V70_KAMA_CROSS" },
  V70_KAMA_CROSS: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V70_MA200 / V70_KAMA_CROSS" },
  V70_S_CURVE_LAYER: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V70_S_CURVE_LAYER / V70_MARTIN_TRIGGER" },
  V70_HARD_STOP: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V70_HARD_STOP / V70_REVERSE_CROSS_CLOSE / V70_LAYER_TP" },
  V70_REVERSE_CROSS_CLOSE: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V70_HARD_STOP / V70_REVERSE_CROSS_CLOSE / V70_LAYER_TP" },
  V70_LAYER_TP: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V70_HARD_STOP / V70_REVERSE_CROSS_CLOSE / V70_LAYER_TP" },
  V70_MARTIN_TRIGGER: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V70_S_CURVE_LAYER / V70_MARTIN_TRIGGER" },
  V70_PATH_PARITY: { file: "server/services/backtest/strategyHighRiskOracle.test.ts", marker: "V70_PATH_PARITY：" },
});

describe("backtest oracle evidence manifest", () => {
  it("9/9 內建策略的 baseline 與高風險 targets 都有可執行 Vitest 證據", () => {
    const matrix = listBacktestReadinessMatrix();
    expect(matrix).toHaveLength(9);
    expect(new Set(matrix.map(entry => entry.strategyKey)).size).toBe(9);

    const requiredTargets = matrix.flatMap(entry => [
      ...entry.baselineOracleTargets,
      ...entry.highRiskOracleTargets,
    ]);
    expect(requiredTargets).toHaveLength(54);
    const targetCounts = requiredTargets.reduce<Record<string, number>>((counts, target) => {
      counts[target] = (counts[target] ?? 0) + 1;
      return counts;
    }, {});
    expect(Object.entries(targetCounts).filter(([, count]) => count > 1)).toEqual([
      ["MULTI_LEG_ACCOUNTING", 2],
    ]);
    expect(Object.keys(EVIDENCE).sort()).toEqual([...new Set(requiredTargets)].sort());

    for (const target of requiredTargets) {
      const evidence = EVIDENCE[target];
      expect(evidence, `${target} 缺少 oracle evidence`).toBeDefined();
      expect(evidence.file.endsWith(".test.ts"), `${target} evidence 必須是 Vitest`).toBe(true);
      const absolutePath = path.resolve(process.cwd(), evidence.file);
      expect(fs.existsSync(absolutePath), `${target} evidence file 不存在: ${evidence.file}`).toBe(true);
      expect(fs.readFileSync(absolutePath, "utf8"), `${target} evidence marker 不存在`).toContain(evidence.marker);
    }
  });
});
