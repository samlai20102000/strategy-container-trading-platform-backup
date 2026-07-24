## 📈 Manus 策略自動化交易方案：從信號生成到 OKX 執行

### 概述

您已在 Manus 平台成功開發並回測了 EMA 馬丁策略，現在的目標是實現一個**可靠、24/7 運行、全自動化**的交易系統，將您的策略信號精準傳遞至 OKX 交易所並執行交易，同時確保完善的風控管理。本方案將利用 Manus 平台的強大功能，構建一個從策略信號生成到交易執行的端到端解決方案，替代 TradingView Webhook 的不穩定性。

### 核心架構設計

我們將採用以下核心架構，確保信號的準確性、執行的可靠性及系統的穩定性：

```mermaid
graph TD
    A[Manus 策略容器化交易系統] --> B(Heartbeat 定時任務)
    B --> C{實時行情數據獲取}
    C --> D[策略引擎 (backtestEngine.ts)]
    D -- 生成交易信號 (ParsedSignal) --> E[執行器 (executor.ts)]
    E -- 風控檢查 & 倉位管理 --> F[交易所適配器 (OKX API)]
    F --> G[OKX 交易所]
    G -- 交易結果 --> E
    E -- 記錄交易 & 狀態更新 --> H[數據庫 (Drizzle ORM)]
    E -- 關鍵事件 --> I[通知服務 (Owner Notifications)]
    subgraph Manus Platform
        A
        B
        C
        D
        E
        H
        I
    end
    subgraph External
        G
    end
```

### 方案詳情

#### 1. 自動信號生成引擎 (替代 TradingView Webhook)

**問題**：TradingView Webhook 存在不穩定性，且信號生成與您的 Manus 策略邏輯可能不完全一致。

**解決方案**：在您的 Manus 項目中實現一個**內置的實時信號生成引擎**。

*   **Heartbeat 定時任務**：利用 Manus 的 `manus-config schedule` 功能，設置一個定時任務（例如每 1 分鐘或每 5 分鐘運行一次，與您的 K 線週期匹配）。這個任務將作為策略的「心跳」，定期觸發信號檢查。
*   **實時行情數據獲取**：在 Heartbeat 任務中，通過 Manus 內置的數據 API 或直接使用 OKX API，獲取最新的 K 線數據。這將確保策略始終基於最新的市場信息進行判斷。
*   **策略引擎調用**：將 `backtestEngine.ts` 中的核心策略判斷邏輯（例如 `checkEntry`、`checkGridAdd`）提取出來，或者直接在 Heartbeat 任務中調用一個輕量級的策略執行函數。這個函數將接收實時 K 線數據，並根據您的 EMA 馬丁策略判斷是否生成買入、賣出或平倉信號。
*   **信號格式化**：將生成的信號格式化為 `ParsedSignal` 類型，與 `executor.ts` 的輸入接口保持一致。

#### 2. OKX 自動交易執行器 (完整風控與倉位管理)

您的 `executor.ts` 已經具備了強大的交易執行能力，我們將在此基礎上進行優化和整合。

*   **內部調用**：Heartbeat 任務生成的 `ParsedSignal` 將直接調用 `executor.ts` 中的 `executeSignal` 或 `executeSignalV20` 函數，而不是等待外部 Webhook。
*   **現有風控機制**：`executor.ts` 已包含 `maxDailyLoss`（每日虧損上限）、`maxPositionPct`（最大倉位比例）、`normalizeQtyForSymbol`（數量正規化）等重要風控措施。確保這些參數在您的策略配置中設置合理。
*   **倉位管理**：`executor.ts` 能夠處理初始開倉、馬丁加倉（通過 `strategy.strategyKey` 調用策略引擎）、平倉等操作，並更新數據庫中的 `MartinState`。這將確保您的馬丁策略在實盤中正確執行。
*   **API 連接**：`executor.ts` 通過 `createAdapter` 建立與 OKX 的連接，確保交易指令能可靠發送。

#### 3. 24/7 可靠運行方案 (最便宜最穩當的部署策略)

**問題**：Manus 默認的 Autoscale 模式可能因不活動而導致冷啟動延遲，不適合 24/7 自動交易。

**解決方案**：**升級到 Manus 的「Reserved」託管模式**。

*   **Reserved 模式**：Reserved 模式提供專用的、始終運行的實例，消除了冷啟動問題，確保您的 Heartbeat 任務能準時觸發，並實時響應市場信號。雖然會產生額外費用，但對於 24/7 自動交易的穩定性和可靠性而言，這是最經濟且穩定的選擇。
*   **Manus 平台優勢**：您的 `strategy-container-trading-system` 部署在 Manus 平台上，享受其內置的環境管理、依賴項處理、自動部署和監控功能，無需您額外配置伺服器。

#### 4. 完整的監控、日誌和告警系統

**問題**：全自動交易需要實時監控交易狀態和潛在問題。

**解決方案**：利用 Manus 平台功能和自定義告警。

*   **Manus 日誌**：所有 `executor.ts` 和 Heartbeat 任務的輸出都將記錄在 Manus 平台的日誌中，您可以通過 `manus-webdev-logs` CLI 或管理界面查看。
*   **交易記錄**：`createTrade` 函數會將每筆交易的詳細信息記錄到數據庫中，便於後續分析和審計。
*   **關鍵事件通知**：集成 Manus 的 `owner-notifications.md` 技能，在以下關鍵事件發生時向您發送實時告警（例如通過 Email 或 Telegram）：
    *   策略被停用（例如達到每日虧損上限）。
    *   交易下單失敗或被拒絕。
    *   API 連接異常。
    *   Heartbeat 任務長時間未運行。
*   **儀表板**：考慮在前端開發一個簡單的儀表板，顯示策略的實時狀態、當前持倉、盈虧、以及最近的交易記錄。

### 實施步驟 (高層次)

1.  **配置 Heartbeat 任務**：
    *   在 `server/_core/heartbeat.ts` 中創建一個新的 Heartbeat 任務。
    *   任務邏輯：獲取實時 K 線數據 → 調用策略判斷信號 → 調用 `executor.ts` 執行交易。
    *   使用 `manus-config schedule` 命令配置任務的運行頻率。
2.  **優化 `executor.ts`**：
    *   確保 `executor.ts` 能夠接收來自內部 Heartbeat 任務的信號，並正確處理。
    *   仔細審查並配置所有風控參數（`maxDailyLoss`, `maxPositionPct`, `Dollar_Loss`, `Max_Equity_Drawdown` 等）。
3.  **升級託管模式**：
    *   在 Manus 管理界面將您的項目託管模式從「Autoscale」升級為「Reserved」，確保 24/7 運行。
4.  **集成通知服務**：
    *   根據 `references/owner-notifications.md` 文檔，配置關鍵事件的通知告警。
5.  **測試**：
    *   在測試帳戶上進行全面的端到端測試，包括信號生成、交易執行、風控觸發和通知接收。

這個方案將為您提供一個高度自動化、穩定且可控的量化交易系統，讓您的 EMA 馬丁策略能夠 24/7 不間斷地在 OKX 上運行。
