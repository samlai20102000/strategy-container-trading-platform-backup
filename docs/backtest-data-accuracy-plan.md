## 回測中心數據計算準確性排查規劃

### 1. 問題概述

用戶回報 KAMA 彩虹馬丁策略回測結果顯示「-100% 最大回撤」，但根據提供的 CSV 交易數據，實際最大單筆虧損僅為 -1.82 USDT，累積最大回撤為 -3.05%。這表明 UI 顯示與實際計算結果存在嚴重不符。同時，用戶要求全面排查回測中心所有數據計算的準確性，以確保其作為部署參考的可靠性。

### 2. 排查範圍

本次排查將涵蓋回測中心的所有關鍵數據計算邏輯，包括但不限於：

-   **最大回撤 (Max Drawdown)**：重點排查其計算邏輯與數據源，特別是 `equityCurve` 的生成。
-   **總回報 (Total Return)**
-   **勝率 (Win Rate)**
-   **夏普比率 (Sharpe Ratio)**
-   **利潤因子 (Profit Factor)**
-   **卡瑪比率 (Calmar Ratio)**
-   **交易數量 (Total Trades)**
-   **平均盈虧 (Avg Win/Loss)**
-   **馬丁觸發次數 (Martin Trigger Count)**
-   **最大馬丁層級 (Max Martin Layer)**

### 3. 排查步驟與分析方向

1.  **分析 `server/services/backtest/performanceCalculator.ts`**：
    *   **最大回撤計算邏輯**：已初步審查 `calculatePerformance` 函數中的 `maxDrawdown` 計算邏輯。該邏輯基於 `equityCurve` 進行計算，並將回撤百分比限制在 100%。
    *   **潛在問題點**：
        *   `equityCurve` 的生成是否正確？是否存在數據缺失、錯誤或不合理的初始值？
        *   `initialCapital` 在計算和 UI 顯示中是否一致？
        *   是否存在邊界條件處理不當，導致 `peak` 值異常或除以零的風險？
        *   UI 層面是否存在顯示錯誤，將特定負值或錯誤標記為 -100%？

2.  **追溯 `equityCurve` 和 `TradeRecord` 的生成**：
    *   查找 `server/services/backtest/backtestEngine.ts`、`multiSymbolEngine.ts`、`optimizer.ts` 或 `scanEngine.ts` 等文件，了解 `TradeRecord[]` 和 `EquityPoint[]` 是如何從原始交易數據中生成並傳遞給 `performanceCalculator.ts` 的。
    *   檢查數據轉換和聚合過程中是否存在錯誤，導致 `equityCurve` 無法準確反映實際資金變化。

3.  **數據一致性驗證**：
    *   將回測引擎生成的原始交易數據（如 CSV 文件）與 `performanceCalculator.ts` 的輸入進行比對，確保數據在傳遞過程中沒有被篡改或丟失。
    *   針對用戶提供的 CSV 數據，手動模擬 `maxDrawdown` 的計算過程，與 UI 顯示的 -100% 進行對比，以確認問題根源。

4.  **其他指標計算審查**：
    *   逐一審查 `performanceCalculator.ts` 中其他績效指標的計算公式，確保其符合金融行業標準和預期邏輯。
    *   特別關注涉及除法、百分比轉換和邊界條件（如交易數量為零、初始資金為零）的計算。

5.  **UI 顯示層面排查**：
    *   檢查前端回測結果頁面（可能在 `client/src/pages/BacktestResult.tsx` 或相關組件）如何接收和渲染後端計算的績效指標。
    *   是否存在數據類型轉換錯誤、格式化錯誤或顯示邏輯錯誤，導致後端正確的數據在前端顯示異常。

### 4. 預期成果

-   一份詳細的排查報告，明確指出「-100% 最大回撤」問題的根本原因。
-   對回測中心所有關鍵數據計算邏輯的審查結果，包括發現的任何不準確或潛在問題。
-   針對發現的問題，提供具體的修復方案和代碼修改建議。
-   確保回測中心數據的準確性、可靠性和功能健全性，使其成為用戶可信賴的策略部署參考工具。

---
