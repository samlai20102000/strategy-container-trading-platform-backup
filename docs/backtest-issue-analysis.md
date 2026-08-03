## 回測中心問題分析報告

### 1. 「自動重新入市」功能未生效問題

**問題描述**：用戶在策略配置中啟用了「自動重新入市」功能，但在回測結果中感覺不到該功能生效，且策略卡片上顯示該功能未開通。

**排查結果**：

經代碼審查，問題根源已定位於後端邏輯：

-   **回測引擎邏輯**：在 `server/services/backtest/kamaRainbowMartinBacktest.ts` 的 `runKamaRainbowMartinBacktest` 函數中，重新入市的邏輯判斷 (`if (config.reentryEnabled)`) 是存在的。這表明回測引擎本身具備處理重新入市的能力。
-   **策略創建邏輯**：在 `server/routers/backtest.router.ts` 的 `createStrategy` 函數中，當創建 KAMA 彩虹馬丁策略實例時，`reentryEnabled` 字段被硬編碼為 `false`：
    ```typescript
    reentryEnabled: v41Columns?.reentryEnabled
      ?? (kamaRainbowMartinConfig
        ? false // <-- 問題點：KAMA 彩虹馬丁策略的 reentryEnabled 預設為 false
        : ladderConfig?.Reentry_Wait_Next_M30_Close
          ?? rainbowConfig?.Reentry_Enabled
          ?? config.Reentry_On_Trend !== false),
    ```

**結論**：即使前端 UI 允許用戶配置並顯示「自動重新入市」為啟用狀態，後端在創建 KAMA 彩虹馬丁策略實例時，會強制將 `reentryEnabled` 設置為 `false`。這導致回測引擎接收到的 `config.reentryEnabled` 始終為 `false`，從而使重新入市功能在回測中無法生效。策略卡片上顯示未開通，也印證了後端數據的不一致性。

**修復建議**：修改 `server/routers/backtest.router.ts` 中 `createStrategy` 函數的相關邏輯，確保 KAMA 彩虹馬丁策略的 `reentryEnabled` 字段能夠正確地從 `kamaRainbowMartinConfig` 中讀取其配置值，而不是被硬編碼為 `false`。

### 2. 最大回撤 100% 問題與數據準確性排查

**問題描述**：回測結果 UI 顯示「-100% 最大回撤」，但用戶提供的 CSV 數據顯示實際最大單筆虧損僅為 -1.82 USDT，累積回撤為 -3.05%。用戶要求全面排查回測中心所有數據計算的準確性。

**初步排查結果**：

經審查 `server/services/backtest/performanceCalculator.ts` 中的 `calculatePerformance` 函數，發現最大回撤的計算邏輯存在以下特點：

-   **權益曲線限制**：`boundedEquity = Math.max(0, point.equity)` 這行代碼將 `equityCurve` 中的每個權益點限制為不小於 0。這意味著如果策略虧損導致實際權益為負，在計算回撤時會被視為 0。
-   **回撤百分比限制**：`dd = peak > 0 ? Math.min(100, (ddUSDT / peak) * 100) : 0` 這行代碼將計算出的回撤百分比限制在 100%。

**問題根源推測**：

-   如果 `equityCurve` 中的某個 `point.equity` 由於策略虧損而達到或低於 0（並被 `Math.max(0, ...)` 處理為 0），那麼在後續計算中，`ddUSDT` 將會是 `peak - 0`，而 `dd` 將會是 `(peak / peak) * 100 = 100`。這解釋了 UI 上顯示 100% 最大回撤的現象。
-   **這並非表示實際資金歸零**，而是計算邏輯在權益觸及或跌破零時的一種「截斷」處理，並將其視為最大可能回撤。然而，這種顯示方式容易讓用戶誤解為實際爆倉。

**進一步排查方向**：

1.  **`equityCurve` 的生成**：
    *   需要深入檢查 `server/services/backtest/backtestEngine.ts` 和 `server/services/backtest/kamaRainbowMartinBacktest.ts` 中 `equityCurve` 的生成邏輯。特別是當策略發生虧損時，`equity` 變化的精確追蹤，以及是否考慮了手續費、滑點和槓桿對實際權益的影響。
    *   確認 `equityCurve` 中的 `equity` 值是否能反映真實的賬戶淨值（包括已實現盈虧和未實現盈虧）。
2.  **`initialCapital` 的使用**：
    *   確保 `initialCapital` 在所有計算環節（包括 `performanceCalculator.ts` 和 `equityCurve` 的初始化）中保持一致，且與用戶輸入的初始資金相符。
3.  **其他績效指標的準確性**：
    *   全面審查 `performanceCalculator.ts` 中所有績效指標的計算公式，與行業標準進行比對，確保其準確性。特別關注：
        *   **總回報 (totalReturn)**：是否正確考慮了所有盈虧和費用。
        *   **勝率 (winRate)**：是否正確統計了盈利和虧損交易。
        *   **夏普比率 (sharpeRatio)** 和 **卡瑪比率 (calmarRatio)**：這些比率的計算依賴於權益曲線和年化因子，需要確保基礎數據的準確性。
        *   **利潤因子 (profitFactor)**：是否正確計算了總毛利潤和總毛虧損。
4.  **前端 UI 顯示邏輯**：
    *   檢查前端回測結果頁面如何接收和格式化這些數據。是否存在前端對數據的二次處理或顯示邏輯導致的誤解。

**總結**：

「-100% 最大回撤」的顯示問題很可能是一個計算邏輯上的「截斷」而非實際爆倉。但這種顯示方式具有誤導性，需要修正。同時，全面審查 `equityCurve` 的生成和所有績效指標的計算邏輯，是確保回測中心數據準確性的關鍵。
