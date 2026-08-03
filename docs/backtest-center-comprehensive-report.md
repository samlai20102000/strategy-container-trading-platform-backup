# 回測中心功能與數據準確性全面排查報告

**作者：** Manus AI
**日期：** 2026年8月3日

## 摘要

本報告旨在回應使用者對 KAMA 彩虹馬丁策略回測結果的疑問，特別是關於「自動重新入市」功能未生效及「-100% 最大回撤」顯示錯誤的問題。透過對後端計算邏輯和前端顯示的深入排查，我們發現了導致這些問題的潛在原因，並提出了詳細的修復方案與優化建議。此外，我們也對每條策略的回測數據分析準備度進行了全面評估，以確保回測中心功能的完整性與準確性。

## 1. 自動重新入市功能排查

### 1.1 問題描述

使用者反映，儘管在策略配置中已啟用「自動重新入市」功能，但在回測結果中並未觀察到該功能生效，且策略卡片上亦未顯示其啟用狀態。

### 1.2 排查結果

經排查後端 `server/routers.ts` 中的 `strategiesRouter.list` 和 `create` 函數，發現 KAMA 彩虹馬丁策略的 `reentryEnabled` 字段在返回給前端時，被硬編碼為 `false`。這導致前端無法正確判斷該功能是否啟用，進而影響了回測引擎的行為以及策略卡片上的顯示。具體來說：

*   在 `create` 函數中，KAMA 彩虹馬丁策略的 `reentryEnabled` 應從 `kamaRainbowMartinConfig.reentryEnabled` 中獲取，但存在邏輯錯誤導致其未被正確傳遞。
*   在 `update` 函數中，`data.reentryEnabled` 也存在類似問題，未能正確從配置中讀取。

### 1.3 解決方案

*   **後端修正**：修改 `server/routers.ts`，確保 `strategiesRouter.list`、`create` 和 `update` 函數在處理 KAMA 彩虹馬丁策略時，能正確從 `kamaRainbowMartinConfig.reentryEnabled` 中讀取並傳遞重新入市的狀態。這將確保後端數據的準確性。
*   **前端修正**：在 `client/src/pages/Strategies.tsx` 中，新增一個通用的視覺化標籤，根據策略物件中 `reentryEnabled` 字段的布林值來顯示「自動重入：開啟」或「自動重入：關閉」狀態。此標籤將放置在交易對符號之後，並移除 KRM 策略專屬的重新入市徽章邏輯，實現通用化處理。

## 2. 最大回撤 100% 顯示錯誤排查

### 2.1 問題描述

使用者提供的回測結果 UI 顯示「-100% 最大回撤」，並澄清這指的是「單筆交易的最大虧損達到初始倉位的 100%（即爆倉風險）」。然而，根據原始 CSV 交易數據，實際最大單筆虧損僅為 -1.82 USDT，累積回撤率為 -3.05%。這表明 UI 顯示存在嚴重錯誤。

### 2.2 排查結果

我們對後端計算邏輯和前端顯示邏輯進行了分析：

*   **後端計算 (`server/services/backtest/performanceCalculator.ts`)**：
    *   在 `calculatePerformance` 函數中，最大回撤的計算邏輯（第 78-91 行）會將回撤百分比限制在 100% (`Math.min(100, (ddUSDT / peak) * 100)`)。這意味著如果計算出的回撤率超過 100%，它將被截斷為 100%。這本身不是錯誤，但可能與前端的顯示方式結合產生誤導。
    *   根據 CSV 數據，實際計算出的回撤遠未達到 100%，這表明後端計算的原始數據是合理的。

*   **前端顯示 (`client/src/components/backtest/BacktestReport.tsx`)**：
    *   在 `BacktestReport.tsx` 中，渲染最大回撤的代碼（第 473-480 行）硬編碼了一個負號：`-{metrics.maxDrawdown}%`。這是一個關鍵的顯示錯誤。即使後端計算出的 `maxDrawdown` 是一個正數（表示回撤的絕對百分比），前端也會在其前面加上一個負號，導致顯示為 `-100%`，這與實際意義不符。

### 2.3 結論與解決方案

UI 上顯示的「-100% 最大回撤」是一個**前端顯示錯誤**，而非後端計算錯誤或實際發生了 100% 的資金虧損。原始數據顯示策略表現並未導致爆倉。

*   **緊急修復**：移除 `client/src/components/backtest/BacktestReport.tsx` 中最大回撤顯示的硬編碼負號。讓前端直接顯示 `metrics.maxDrawdown` 的值，並確保其單位和含義與後端計算一致。
*   **後端驗證**：對 `performanceCalculator.ts` 中的最大回撤計算進行嚴格的單元測試，包括初始資金為 0、單筆巨額虧損等邊界情況，確保計算邏輯的健壯性。
*   **前端驗證**：確保前端顯示的百分比和 USDT 值與後端計算結果完全一致，並考慮增加工具提示，解釋最大回撤的計算方式。

## 3. 每條策略回測數據分析準備度排查

為了確保回測中心能準確、完整地支持所有策略，我們對系統中已註冊的策略進行了全面的準備度排查。排查範圍包括策略配置定義、回測引擎支持度以及運行時適配器的實現。

### 3.1 策略配置與元數據完整性

我們檢查了 `shared/strategies/` 目錄下的策略定義文件，確認每條策略是否具備完整的回測參數定義和驗證邏輯。

*   **KAMA 彩虹馬丁 (`KAMA_RAINBOW_MARTIN_V1`)**：配置定義完整 (`kamaRainbowMartin.ts`)，包含 `reentryEnabled`、`kamaLines`、`layerConfigs` 等關鍵參數，並具備嚴格的 `zod` 驗證。
*   **KAMA 3K 突破 V2.5 (`KAMA_3K_BREAKOUT_V25`)**：配置定義完整 (`kama3kBreakoutV25.ts`)，包含 `Reentry_On_Trend`、`Martin_Ranges` 等參數，並具備自定義的驗證邏輯。
*   **KAMA 3K 馬丁 V4.1 (`20415_KAMA_MARTIN_V41`)**：配置定義完整 (`kama3kMartinV41.ts`)，包含 `enableSameDirectionReentry`、`Martin_Layers` 等參數，並具備嚴格的 `zod` 驗證。
*   **其他策略 (V35, V50, V61, V70, Rainbow 20415, Rainbow Trend Ladder)**：這些策略的配置定義也已存在，並具備相應的驗證機制。

**結論**：所有已註冊策略在配置定義和元數據層面均具備良好的完整性，為回測提供了堅實的數據基礎。

### 3.2 回測引擎支持度與認證狀態

我們審查了 `server/services/strategyRunnerDescriptors.ts`，該文件定義了每條策略在不同通道（BACKTEST, SIMULATION, LIVE）下的認證狀態和支持模式。

*   **KAMA 彩虹馬丁 (`KAMA_RAINBOW_MARTIN_V1`)**：在 BACKTEST 模式下被認證為 `S1_ONLY`（單向專屬）。這意味著它目前不支持多頭/空頭雙向 (`MULTI_POSITION`) 或對沖 (`HEDGE_GUARDED`) 模式的回測。
*   **KAMA 3K 突破 V2.5 (`KAMA_3K_BREAKOUT_V25`)**：在 BACKTEST 模式下被認證為支持所有模式 (`ALL_MODES`)，包括 `SINGLE_EXCLUSIVE`, `MULTI_POSITION`, `HEDGE_GUARDED`。
*   **KAMA 3K 馬丁 V4.1 (`20415_KAMA_MARTIN_V41`)**：在 BACKTEST 模式下被認證為支持所有模式 (`ALL_MODES`)。
*   **其他策略 (V35, V50, V61, V70, Rainbow 20415, Rainbow Trend Ladder)**：在 BACKTEST 模式下均被認證為支持所有模式 (`ALL_MODES`)。

**結論**：除了 KAMA 彩虹馬丁策略目前受限於 `S1_ONLY` 模式外，其他主要策略均已獲得全模式回測認證。這表明回測引擎在架構上已準備好支持複雜的多模式策略。

### 3.3 運行時適配器 (Runtime Adapter) 實現

我們審查了 `server/services/backtest/builtInPortfolioRuntimeFactories.ts`，確認每條被認證的策略是否都有對應的運行時適配器實現。

*   **KAMA 彩虹馬丁 (`kama-rainbow-martin-portfolio`)**：已實現 `kamaRainbowMartinFactory`，負責處理 KRM 策略的入場和管理邏輯。
*   **KAMA 3K 突破 V2.5 (`kama-3k-v25-portfolio`)**：已實現 `v25Factory`。
*   **KAMA 3K 馬丁 V4.1 (`kama-3k-v41-portfolio`)**：已實現 `createClassicKamaFactory` 用於 V41。
*   **其他策略**：均已在 `BUILT_IN_FACTORIES` 中註冊了對應的工廠函數。

**結論**：所有被認證的策略都已具備實際可執行的回測適配器，確保了回測任務能夠被正確調度和執行。

### 3.4 綜合評估與優化建議

總體而言，回測中心在策略準備度方面表現良好，具備完整的配置定義、明確的認證機制和實際的執行適配器。然而，為了進一步提升準確性和用戶體驗，我們提出以下優化建議：

1.  **明確提示策略模式限制**：對於如 KAMA 彩虹馬丁這樣在回測中受限於 `S1_ONLY` 模式的策略，應在前端 UI（如策略選擇下拉選單、回測配置面板）中提供清晰的提示，告知用戶該策略目前不支持多向或對沖回測，避免用戶產生誤解。
2.  **統一「自動重新入市」參數命名**：不同策略對「自動重新入市」的參數命名不一致（如 `reentryEnabled`, `Reentry_On_Trend`, `enableSameDirectionReentry`）。建議在前端顯示和後端處理時，建立一個統一的映射機制，確保該功能在所有策略中都能被一致地識別和處理。
3.  **持續驗證多模式回測準確性**：對於支持 `MULTI_POSITION` 和 `HEDGE_GUARDED` 的策略，需持續進行嚴格的數據比對和邊界測試，確保在複雜模式下的盈虧計算、回撤統計和交易記錄與預期邏輯完全一致。

## 4. 結論與下一步行動

本次排查明確了「自動重新入市」功能未生效和「-100% 最大回撤」顯示錯誤的根本原因，並提出了具體的修復方案。同時，我們也對每條策略的回測準備度進行了全面評估，確認了系統的整體健全性，並提出了進一步的優化建議。

**下一步行動**：

1.  **實施修復**：優先實施「自動重新入市」功能和「最大回撤」顯示錯誤的後端與前端修正。
2.  **優化實施**：根據本報告的建議，逐步實施策略模式限制提示、參數命名統一等優化措施，提升回測中心的準確性、穩定性和使用者體驗。
3.  **持續監控**：在修復和優化上線後，持續監控回測中心的運行狀態，並收集用戶反饋，以便及時發現和解決潛在問題。
