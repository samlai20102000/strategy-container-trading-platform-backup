# 交易對統一管理系統 & 資金計算修復文檔

## 概述

本文檔記錄了策略容器化自動交易平台中兩個核心子系統的設計、實現和維護指南：

1. **交易對統一管理系統** — 確保所有策略和模組使用一致的 OKX 標準交易對格式
2. **資金計算修復** — 修正首單開倉金額計算邏輯，確保正確使用百分比控倉

---

## 一、交易對統一管理系統

### 1.1 問題背景

系統中存在多種交易對命名格式（如 `ETHUSDT`、`ETH-USDT`、`ETH/USDT`、`ETH_USDT_SWAP`、`ETH-USDT-SWAP`），導致：

- K 線數據獲取失敗（格式不匹配 OKX API）
- 下單時交易對名稱錯誤
- 不同模組間交易對名稱不一致

### 1.2 架構設計

```
┌─────────────────────────────────────────────────────────┐
│                    前端層                                  │
│  TradingPairSelector → API → TradingPairManager          │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│                  中間件層（symbolMiddleware）               │
│  normalizeSymbolForStrategy()                            │
│  validateSymbolForStrategy()                             │
│  prepareSymbolForExecution()                             │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│                    核心層                                  │
│  TradingPairManager（單例）                               │
│  - OKX API 同步（SWAP/SPOT/FUTURES）                     │
│  - 1 小時緩存                                            │
│  - 格式標準化                                            │
│  - 交易對驗證                                            │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│                   應用層                                   │
│  executor.ts │ autoTradeSignalGenerator.ts │ backtest    │
└─────────────────────────────────────────────────────────┘
```

### 1.3 支持的格式轉換

| 輸入格式 | 標準化輸出 | 說明 |
|----------|-----------|------|
| `ETHUSDT` | `ETH-USDT-SWAP` | TradingView 常用格式 |
| `ETH-USDT` | `ETH-USDT-SWAP` | 簡寫格式 |
| `ETH/USDT` | `ETH-USDT-SWAP` | 通用分隔格式 |
| `ETH_USDT_SWAP` | `ETH-USDT-SWAP` | 下劃線格式 |
| `ETH-USDT-SWAP` | `ETH-USDT-SWAP` | OKX 標準格式（不變） |

### 1.4 核心文件

| 文件路徑 | 職責 |
|---------|------|
| `server/services/tradingPairManager.ts` | 單例管理器，同步 OKX 交易對，提供標準化/驗證/搜索 |
| `server/services/symbolSyncService.ts` | 交易對同步服務 |
| `server/services/symbolMiddleware.ts` | 統一中間件，所有策略通用 |
| `server/services/strategySymbolAdapter.ts` | 策略適配層 |
| `server/routers/tradingPairs.router.ts` | API 路由 |
| `client/src/components/TradingPairSelector.tsx` | 前端選擇器組件 |

### 1.5 集成點

**執行層（executor.ts）：**
- 在 `executeSignal()` 開始處自動驗證和標準化交易對
- 容錯設計：驗證失敗不中斷執行

**信號生成層（autoTradeSignalGenerator.ts）：**
- 使用 `TradingPairManager.normalizeSymbol()` 標準化
- K 線請求前驗證交易對有效性

**回測層（backtestEngine.ts）：**
- 回測開始時嘗試驗證和標準化
- 容錯設計：驗證失敗時使用原始名稱繼續（支持測試環境虛構交易對）

### 1.6 監控與維護

**日誌標記：**
- `[TradingPairManager]` — 管理器操作
- `[SymbolMiddleware]` — 中間件操作
- `[Backtest]` — 回測交易對驗證

**緩存刷新：**
- 自動：每 1 小時重新從 OKX 同步
- 手動：調用 `clearSymbolCache()` 或重啟服務

**故障排查：**
1. 交易對驗證失敗 → 檢查 OKX API 可達性
2. 格式轉換錯誤 → 檢查輸入是否為支持的 5 種格式之一
3. 緩存過期 → 等待自動刷新或手動清除

---

## 二、資金計算修復

### 2.1 問題背景

修復前，`calculateLotSize` 在 `Position_Mode='quantity'` 時直接返回 `positionSize`（如 100），被誤解為 100 ETH（實際應為 100 USDT 等值的幣數量）。這導致：

- 開倉金額遠超預期（如 100 ETH ≈ 350,000 USDT）
- 觸發「沒有足夠資金」錯誤
- 風險管理失效

### 2.2 修復邏輯

**修復後的計算公式：**

```
首單幣數量 = Initial_Capital × First_Order_Pct / 100 / currentPrice
```

**範例：**
- Initial_Capital = 10,000 USDT
- First_Order_Pct = 0.3（%）
- currentPrice = 50,000（BTC）
- 首單幣數量 = 10,000 × 0.3 / 100 / 50,000 = **0.0006 BTC**（≈ 30 USDT）

### 2.3 各策略版本處理方式

| 策略版本 | 修復狀態 | 計算邏輯 |
|---------|---------|---------|
| V2.0 | 使用 executor 層 normalizeQty | 由 executor 統一處理 |
| V3.5 | 已修復 | `Initial_Capital × First_Order_Pct% / price` |
| V5.0 | 已修復 | 同 V3.5 邏輯 |
| V6.1 | 不受影響 | 使用獨立的 `base_lot_size`（USDT）路徑 |

### 2.4 calculateLotSize 優先級

修復後的 `calculateLotSize` 函數遵循以下優先級：

1. **百分比控倉**（最高優先）：如果配置了 `Initial_Capital` 和 `First_Order_Pct`，使用百分比計算
2. **USDT 金額模式**：如果 `Position_Mode === 'usdt'`，將 USDT 金額除以當前價格
3. **幣數量模式**：直接使用配置的數量值
4. **回退**：使用 `Base_Lot_Size` 作為最後手段

### 2.5 回測引擎影響

回測引擎中的 `resolveInitialLot` 函數同樣遵循上述邏輯，確保回測結果與實盤一致。回測日誌會輸出：

```
[Backtest] 首單模式: 固定金本位 30 USDT，Initial_Capital=10000
```

### 2.6 驗證方法

在 OKX 模擬盤上驗證：

1. 設定策略：Initial_Capital=10000, First_Order_Pct=0.3
2. 觸發 BUY 信號
3. 確認下單數量 ≈ 30 USDT 等值的幣數量
4. 確認不再出現「沒有足夠資金」錯誤

---

## 三、未來策略開發指南

### 3.1 交易對處理

所有新策略自動受益於交易對統一管理系統，無需額外配置。系統會在以下時機自動處理：

- **executor 層**：下單前自動驗證和標準化
- **信號生成層**：K 線請求前自動轉換
- **回測層**：回測開始時自動驗證

### 3.2 資金計算

新策略應遵循以下模式：

```typescript
calculateLotSize(config: StrategyConfig, price: number): number {
  // 優先使用百分比控倉
  if (config.Initial_Capital && config.First_Order_Pct) {
    return (config.Initial_Capital * config.First_Order_Pct / 100) / price;
  }
  // 回退到其他模式...
}
```

### 3.3 測試要求

- 使用 Vitest 編寫單元測試
- 測試中可使用虛構交易對（如 `FIXTEST-USDT`）
- 回測引擎會自動容錯處理虛構交易對

---

## 四、測試狀態

| 測試文件 | 測試數 | 狀態 |
|---------|--------|------|
| v35-system.test.ts | 32 | 全部通過 |
| backtest-fixes.test.ts | 17 | 全部通過 |
| backtest-verification.test.ts | 10 | 全部通過 |
| 其他測試文件 | 283 | 全部通過 |
| **總計** | **342** | **全部通過** |

---

*文檔版本：2026-07-20 | 作者：Manus AI*
