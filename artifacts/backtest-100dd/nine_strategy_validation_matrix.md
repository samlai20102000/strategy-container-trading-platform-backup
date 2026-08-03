# 九策略風險完整性覆蓋矩陣

本矩陣依 `strategyRunnerDescriptors.ts` 的九個內建策略單一真相，以及 `backtestEngine.ts` 的 S1 實際派發分支建立。此次修正沒有變更任何策略訊號或交易參數；它在全部 runner 的共用 `finalizeV25Result` 發布邊界執行相同的有限責任與政策一致性守門。

| 內建策略 key | S1 實際執行路徑 | 本次共用守門 | 驗證結論 |
|---|---|---|---|
| `strategy_20415` | `runRainbow20415Backtest` | `finalizeV25Result` | 已覆蓋；異常結果 fail closed |
| `RAINBOW_TREND_LADDER_V1` | `runRainbowTrendLadderBacktest` | `finalizeV25Result` | 已覆蓋；異常結果 fail closed |
| `KAMA_RAINBOW_MARTIN_V1` | `runKamaRainbowMartinBacktest` | `finalizeV25Result` | 已用真實事故 job 驗證會拒絕發布 |
| `KAMA_3K_BREAKOUT_V25` | `runV25Backtest` | `finalizeV25Result` | 已覆蓋；異常結果 fail closed |
| `20415_KAMA_MARTIN_V35` | 共用 KAMA 主 runner | `finalizeV25Result` | 已覆蓋；異常結果 fail closed |
| `20415_KAMA_MARTIN_V41` | 共用 KAMA 主 runner | `finalizeV25Result` | 已覆蓋；異常結果 fail closed |
| `KAMA_3K_ULTIMATE_V50` | 共用 KAMA 主 runner | `finalizeV25Result` | 已覆蓋；異常結果 fail closed |
| `KAMA_3K_HF_V61` | 共用 KAMA 主 runner | `finalizeV25Result` | 已覆蓋；異常結果 fail closed |
| `KAMA_3K_TORNADO_V70` | `runV70Backtest` | `finalizeV25Result` | 已覆蓋；異常結果 fail closed |

| 驗證層 | 結果 |
|---|---|
| 同一持久化 KRM job | `passed=false`，偵測 5 類風險完整性違約 |
| 新風險單元測試 | 4/4 通過 |
| 九策略派發覆蓋契約 | 2/2 通過；禁止直接 return runner 結果 |
| risk-aware 權益降採樣 | 4/4 通過；全期間最低、最大回撤峰谷、首次非正權益與首次恢復點必須保留 |
| 風險守門聚焦回歸 | 3 files、10 tests 全數通過 |
| 完整 Vitest | 142 files passed、2 skipped；1,129 tests passed、5 skipped |
| TypeScript | `tsc --noEmit` 通過 |
| Production build | Vite 與 server bundle 通過；僅保留既有 chunk-size 警告 |

> **修正邊界：** 本版本已保證報告曲線在降採樣後仍保留所有已知風險關鍵點，並不再把「破產後恢復」或明顯違反政策的 S1 結果標成 completed、顯示為可信 KPI。逐筆准入與逐 K 強制清算仍應由各 legacy runner 遷移至 `threeModePortfolioKernel` 的 runtime risk kernel；在遷移完成前，`enforcement=POSTHOC_ONLY` 會誠實標示證據強度。
