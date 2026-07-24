# Max_Drawdown_Pct 參數化規劃

## 1. Max_Drawdown_Pct vs Max_Loss_Pct 的區別

| 參數 | 定義 | 觸發條件 | 適用場景 | 計算基準 |
|------|------|--------|--------|--------|
| **Max_Loss_Pct** | 硬止損（單筆交易虧損限制） | 浮虧 ≥ 初始資金 × Max_Loss_Pct% | KAMA 馬丁 V3.5 | 單筆交易的平均成本 |
| **Max_Drawdown_Pct** | 回撤保護（整體權益曲線回撤） | 權益曲線回撤 ≥ 峰值 × Max_Drawdown_Pct% | EMA 馬丁 V5.2 | 整體帳戶權益 |

### 核心差異：
- **Max_Loss_Pct**：保護單筆交易，防止馬丁加倉無限擴大
- **Max_Drawdown_Pct**：保護整體帳戶，防止連續虧損掏空本金

### 例子：
- 初始資金 10,000 USDT，Max_Loss_Pct = 5%
  - 觸發：單筆交易虧損 ≥ 500 USDT
  
- 初始資金 10,000 USDT，Max_Drawdown_Pct = 10%
  - 峰值權益 12,000 USDT，觸發：權益 ≤ 10,800 USDT（回撤 1,200 USDT）

---

## 2. 當前代碼問題

### EMA 馬丁（strategy_20415）回撤保護現狀：

**backtestEngine.ts 第 678 行：**
```typescript
const maxDrawdownPct = num(config.MaxDrawdownPercent, num(config.Max_Loss_Pct, 5.0)) / 100;
```

**問題：**
1. 優先級混亂：優先讀 `MaxDrawdownPercent`，再讀 `Max_Loss_Pct`，最後用 5.0 預設值
2. 前端無法獨立配置 Max_Drawdown_Pct
3. 用戶無法區分兩個參數的作用

---

## 3. 參數化方案（僅涉及 EMA 馬丁 strategy_20415）

### Phase 1：後端改造（backtestEngine.ts）

**修改位置**：第 678 行

**改前：**
```typescript
const maxDrawdownPct = num(config.MaxDrawdownPercent, num(config.Max_Loss_Pct, 5.0)) / 100;
```

**改後：**
```typescript
// V5.8 EMA 馬丁專屬：Max_Drawdown_Pct 獨立參數化（不受 Max_Loss_Pct 影響）
const maxDrawdownPct = num(config.Max_Drawdown_Pct ?? 10, 10) / 100;
```

**說明：**
- 使用 `Max_Drawdown_Pct` 作為獨立參數
- 預設值 10%（比 KAMA 馬丁的 10% 一致，避免混淆）
- 完全獨立於 Max_Loss_Pct

### Phase 2：前端表單更新（Backtest.tsx）

**新增參數說明**（第 255-256 行附近）：
```typescript
Max_Drawdown_Pct: "回撤保護 %（EMA 馬丁專用：整體權益曲線回撤率，獨立於硬止損）",
```

**確保 RISK_KEYS 中已包含**：
```typescript
const RISK_KEYS = [
  "Max_Loss_Pct",        // KAMA 馬丁用
  "Max_Drawdown_Pct",    // EMA 馬丁用
  "Max_Deviation_Pct",   // KAMA 馬丁用
  "Target_TP_Pct",
  "Callback_Pct",
  // ...
];
```

### Phase 3：前端表單渲染

**Backtest.tsx 策略參數區塊**：
- 選擇 `strategy_20415`（EMA 馬丁）時，顯示 `Max_Drawdown_Pct` 輸入框
- 選擇 `20415_KAMA_MARTIN_V35`（KAMA 馬丁）時，顯示 `Max_Drawdown_Pct` 和 `Max_Deviation_Pct` 輸入框
- 兩個策略都顯示 `Max_Loss_Pct`

---

## 4. 實現步驟

### ✅ 步驟 1：確認修改範圍
- **僅涉及**：EMA 馬丁（strategy_20415）
- **不涉及**：KAMA 馬丁（20415_KAMA_MARTIN_V35）、其他策略
- **共享代碼修改**：backtestEngine.ts 第 678 行（需隔離到 generic 路徑判斷）

### ⏳ 步驟 2：後端修改
1. backtestEngine.ts 第 678 行：改為 `num(config.Max_Drawdown_Pct ?? 10, 10) / 100`
2. 確保修改只在 `runGenericBacktest` 函數內（EMA 馬丁專用路徑）
3. 不修改 `runBacktest` 函數（KAMA 馬丁路徑）

### ⏳ 步驟 3：前端修改
1. Backtest.tsx 第 255 行：新增 Max_Drawdown_Pct 參數說明
2. 確保 RISK_KEYS 中已有 Max_Drawdown_Pct
3. 驗證表單渲染

### ⏳ 步驟 4：測試
1. TypeScript 編譯零錯誤
2. 回測 EMA 馬丁：設置 Max_Drawdown_Pct = 15%，驗證觸發邏輯
3. 回測 KAMA 馬丁：確認不受影響

### ⏳ 步驟 5：Checkpoint

---

## 5. 預期效果

| 場景 | 改前 | 改後 |
|------|------|------|
| EMA 馬丁回測 | 回撤保護固定 5%（或依賴 Max_Loss_Pct） | 可在回測表單設置 Max_Drawdown_Pct（預設 10%） |
| KAMA 馬丁回測 | 不受影響 | 不受影響（獨立隔離） |
| 前端表單 | 無 Max_Drawdown_Pct 欄位 | 新增 Max_Drawdown_Pct 輸入框 |

---

## 6. 風險評估

| 風險 | 等級 | 緩解措施 |
|------|------|--------|
| 修改影響 KAMA 馬丁 | 🔴 高 | 修改僅在 `runGenericBacktest` 內，不涉及 `runBacktest` |
| 參數名稱混淆 | 🟡 中 | 前端表單明確標註「EMA 馬丁專用」 |
| 預設值不合理 | 🟡 中 | 預設 10%，與 KAMA 馬丁一致 |

---

## 7. 用戶操作流程

### 回測 EMA 馬丁：
1. 策略選擇：`EvoMartingale_EMA v2.0`
2. 參數設置區塊顯示：
   - Max_Loss_Pct（硬止損）= 5
   - **Max_Drawdown_Pct（回撤保護）= 15** ← 新增可配置
   - Target_TP_Pct（止盈）= 1
   - Callback_Pct（回調）= 0.3
3. 點擊「開始回測」
4. 結果 CSV 顯示：「回撤保護（回撤 12.5% > 15%）」或「目標止盈」

---

## 8. 後續優化（非本次範圍）

1. 新增「風控預設方案」（激進/平衡/保守）
2. 回測報告新增「風控觸發分析」面板
3. 實盤前「風控模擬器」
