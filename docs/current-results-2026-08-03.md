# 現有成果封存報告

**日期：** 2026-08-03  
**作者：** Manus AI  
**範圍決定：** 依使用者指示，停止其餘未完成任務，不再擴充功能；本文件只記錄目前已完成、已驗證及尚未完成的內容。

## 一、目前已完成成果

| 項目 | 現有結果 | 主要證據 |
|---|---|---|
| KAMA 彩虹馬丁自動重新入市單一真相來源 | 已建立 canonical 配置綁定，`reentryEnabled` 不再由各路徑各自推導或硬編碼 | `server/services/kamaRainbowMartinStrategyConfig.ts` |
| 策略交易一般新建與編輯 | 新建、編輯及策略列表投影均使用 canonical 配置；策略卡只對 KRM 顯示實際保存狀態 | `server/routers.ts`、`client/src/pages/Strategies.tsx` |
| 參數快照庫 | 快照預覽、套用既有策略、複製為新策略與直接套用配置均保留 `reentryEnabled`；已移除匯入時強制寫成 `false` 的錯誤 | `server/routers/backtest.router.ts`、`client/src/pages/ParameterSnapshots.tsx` |
| 回測重新入市資料流 | 回測 runner 逐 cycle 記錄初次入市、同向重入、反向重入、平倉原因與事件時間 | `server/services/backtest/kamaRainbowMartinBacktest.ts`、`backtestReentryDiagnostics.ts` |
| 回測報告可稽核證據 | 報告顯示重新入市開關、cycle、同方向次序、分類與最近事件；舊結果無證據時顯示無資料而非偽造零值 | `client/src/components/backtest/BacktestReport.tsx` |
| 策略卡成交級觀測 | S1 從 runtime 成交真相、M2/H3 從 position ledger 彙整 cycle、方向、同向序號與累計重入；無可信資料時顯示「尚無紀錄」 | `server/services/kamaRainbowMartinReentryObservability.ts`、`shared/observability/kamaRainbowMartinReentry.ts` |
| 績效指標 v2 | 建立可稽核規格版本，統一 Sharpe 年化取樣、正值最大回撤、回測天數、勝率分母與 profit factor 邊界語意 | `shared/backtest/performanceMetricSpec.ts`、`server/services/backtest/performanceCalculator.ts` |
| 最大回撤顯示 | 前端以回撤幅度顯示並兼容舊負值資料，避免重複負號或誤導顯示 | `client/src/components/backtest/BacktestReport.tsx` |
| 多品種摘要 | 最大回撤、無虧損 profit factor 與指標口徑版本改用同一 v2 顯示契約 | `server/services/backtest/multiSymbolEngine.ts` |

## 二、跨模組重新入市傳播結果

| 使用路徑 | 結果 |
|---|---|
| 回測中心開啟「自動重新入市」後執行回測 | 已傳入 KRM canonical config，並輸出事件級診斷 |
| 回測結果建立新策略 | 已保留 `reentryEnabled` |
| 參數快照套用到既有策略 | 已保留 `reentryEnabled` |
| 參數快照複製為新策略 | 已保留 `reentryEnabled`，不再強制關閉 |
| 策略交易一般新建 | 已由 canonical config 同步寫入 |
| 策略交易編輯 | 已由 canonical config 同步更新 |
| 策略列表與策略卡 | 已顯示實際保存狀態，不以名稱或前端暫存值猜測 |

## 三、現有測試與技術驗證

| 驗證 | 現有結果 |
|---|---|
| TypeScript 嚴格型別檢查 | 最近一次 `pnpm exec tsc --noEmit` 通過 |
| 績效公式 oracle | 7/7 通過，涵蓋和局勝率、正值回撤、無虧損／零交易 profit factor、Sharpe 取樣、零時長與規格版本 |
| 回測驗證與績效 oracle 合併測試 | 18/18 通過，其中回測驗證 11 項、績效 oracle 7 項 |
| KRM canonical 與路由傳播測試 | 已新增並通過新建、編輯、快照套用、快照複製及列表投影契約測試 |
| KRM 回測重入診斷測試 | 已新增並通過事件分類、cycle 與同方向序號測試 |
| KRM 策略卡觀測測試 | 已新增並通過首次入市、同向重入、反向重入及 M2/H3 ledger 彙整測試 |

> 注意：主要重新入市修正後，完整 Vitest 套件曾通過。其後新增的績效 v2 與策略卡成交級觀測已完成聚焦測試及型別檢查；依使用者最新指示停止未完成工作，因此沒有再執行最後一輪完整 Vitest、正式 build、桌面／手機及 console／network 驗收。

## 四、逐策略準備度初步結果

此部分原定建立完整機器可讀矩陣，但使用者要求停止未完成任務。現有平行稽核完成 **7/9**，只可視為初步工程盤點，不是已接入回測中心的正式守門規則。

| 策略 | 初步狀態 | 主要結論 |
|---|---|---|
| `KAMA_RAINBOW_MARTIN_V1` | READY | 實盤與回測共用 KRM core／management；canonical config 完整；S1/M2/H3 有 runner 證據 |
| `KAMA_3K_BREAKOUT_V25` | READY | 實盤與回測共用 `evaluateV25Decision`，配置映射完整 |
| `20415_KAMA_MARTIN_V35` | READY | 實盤與 portfolio 回測共用 V3.5 決策核心，S1/M2/H3 有 runner 證據 |
| `KAMA_3K_TORNADO_V70` | READY（需注意） | 有專屬回測及模式能力，但實盤與回測不是同一函式核心，後續仍宜加 parity oracle |
| `RAINBOW_TREND_LADDER_V1` | PARTIAL | 專用 runner 與共享 core／management 存在，但本次稽核未完成 manifest 與完整測試證據核實 |
| `KAMA_3K_ULTIMATE_V50` | PARTIAL | 實盤使用 V5.0 專屬邏輯，回測仍降級到通用 runner，專屬參數與 F1–F6 邏輯未完全對齊 |
| `KAMA_3K_HF_V61` | PARTIAL | M2/H3 較接近實盤核心；S1 回測仍有自行重寫邏輯、daily limits 與預設配置分歧 |
| `strategy_20415` | 未完成稽核 | 平行稽核未返回結果，依指示不再補做 |
| `20415_KAMA_MARTIN_V41` | 未完成稽核 | 平行稽核未返回結果，依指示不再補做 |

## 五、依指示保留為未完成的項目

| 未完成項目 | 目前狀態 |
|---|---|
| 回測所有指標的完整唯一規格 | 已完成核心 v2，但尚未逐一完成期初／期末權益、未實現損益、Calmar、回撤金額、cycle／fill 等全欄位稽核 |
| 九個策略完整準備度矩陣 | 只完成 7/9 初步稽核，尚未轉成機器可讀正式守門 |
| 回測中心 unsupported／not-ready 阻擋 UI | 未實作 |
| 全策略固定資料集與 parity oracle | 未完成 |
| 最終完整 Vitest、正式 build、桌面／手機及瀏覽器日誌驗收 | 未執行最後一輪 |

## 六、安全邊界

本輪變更與驗證未主動觸發實盤下單、撤單、平倉或策略啟停。現有版本適合先進行模擬盤／測試帳戶驗證；初步標記為 PARTIAL 或尚未稽核的策略，不應因本文件而被視為已完成實盤等價認證。
