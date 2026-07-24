# V3.5 KAMA+3K 馬丁策略系統 - 完整實作路線圖

## 📋 已完成的模組

✅ **Phase 1 - 架構分析**
- V35_SYSTEM_ANALYSIS.md（系統架構、流程圖、參數對應表）

✅ **Phase 2 - 核心策略引擎（部分）**
- server/strategies/base.ts（基底類別 - 已升級到 V3.5）
- server/strategies/v35/strategy_kama_3k_v35.ts（V3.5 主策略 - 完整實作）
- server/services/kamaCalculator.ts（KAMA 計算 + 3K 破位驗證）

---

## 🔧 待實作的模組（優先級排序）

### P0 - 核心（必須）

#### 1. Webhook 接收器 + Redis 雙重鎖
**文件位置**：`server/routers/webhook.router.ts`
**依據**：Pasted_content_17.txt B.2.3
**核心邏輯**：
```typescript
// 1. 提取 bar_timestamp
// 2. Redis 鎖檢查（K3_Locked）
// 3. 建立 Redis 鎖（TTL = K_Line_Period × 2）
// 4. 更新實例狀態
// 5. 記錄信號日誌
// 6. 觸發策略引擎
```

**關鍵點**：
- 鎖 TTL 必須 = K線週期 × 2 × 60 秒
- 重複信號返回 200 + "blocked" 狀態
- 鎖僅作用於初始開倉，不限制馬丁/止盈/止損

---

#### 2. 馬丁格爾引擎
**文件位置**：`server/services/martingaleEngine.ts`
**依據**：Pasted_content_17.txt B.2.4
**核心方法**：
```typescript
// shouldAddLayer(currentPrice, isLong): boolean
//   - 檢查層數是否 < maxLayers
//   - 計算價格偏離百分比
//   - 返回 deviation >= stepPct%

// addLayer(currentPrice, isLong): { lotSize, newState }
//   - 計算新倉位：baseLot × multiplier^(layer-1)
//   - 更新均價：(totalCost + newCost) / newTotalSize
//   - 返回新狀態

// reset(): void
//   - 重置所有馬丁狀態
```

**狀態結構**：
```typescript
{
  currentLayer: number;       // 當前層數
  totalSize: number;          // 總持倉
  avgPrice: number;           // 均價
  lastLayerPrice: number;     // 最後層進場價
  totalCost: number;          // 總成本
}
```

---

#### 3. 極限防爆倉止損
**文件位置**：`server/services/riskManager.ts`
**依據**：Pasted_content_17.txt B.2.5
**核心方法**：
```typescript
// checkLimitStop(position): { triggered, reason, estimatedLoss }
//   條件 A：totalLoss >= initialCapital × maxDrawdownPct%
//   條件 B：價格偏離最後層 >= 3%
//   返回 { triggered: boolean, reason, estimatedLoss }

// checkDailyLoss(dailyLoss, dailyLimit): { triggered, reason }
//   - 檢查今日累計虧損
```

**觸發邏輯**：
```
IF (浮虧 >= 初始資本 × 10%) OR (最後層偏離 >= 3%)
  THEN 全平 + 暫停策略 + 警報
```

---

### P1 - 集成（必須）

#### 4. 前端動態表單生成
**文件位置**：`client/src/components/StrategyForm.tsx`
**依據**：Pasted_content_17.txt B.2.6（strategySchema.json）
**功能**：
- 根據 JSON Schema 動態生成表單欄位
- 分組顯示（資金配置、KAMA 參數、馬丁參數、止盈參數、系統參數）
- 實時驗證與預覽

**表單分組**：
```json
{
  "capital_settings": { Initial_Capital, Base_Lot_Size, Max_Drawdown_Pct },
  "kama_settings": { KAMA_Fast_Length, p2_fastest, p3_slowest, ... },
  "martingale_settings": { Martin_Step_Pct, Martin_Multiplier, Max_Layers },
  "take_profit_settings": { Target_TP_Pct, Callback_Pct },
  "system_settings": { K_Line_Period }
}
```

---

#### 5. 策略狀態持久化
**文件位置**：`server/db/strategyStateManager.ts`
**功能**：
- 每次交易後保存 StrategyState 到 DB
- 重啟時恢復狀態
- 與交易所對賬（getBalance/getPositions）

**DB 操作**：
```typescript
// 保存狀態
await updateStrategyState(strategyId, state);

// 恢復狀態
const state = await getStrategyState(strategyId);

// 對賬
const positions = await exchange.getPositions();
if (positions.size !== state.totalSize) {
  // 修正本地狀態
}
```

---

#### 6. 信號日誌記錄
**文件位置**：`server/db/signalLogger.ts`
**功能**：
- 記錄每筆 Webhook 訊號
- 記錄驗證結果
- 記錄執行結果

**日誌結構**：
```typescript
{
  instanceId: string;
  rawPayload: object;
  parsedAction: 'BUY' | 'SELL' | 'CLOSE';
  status: 'received' | 'routed' | 'blocked' | 'executed' | 'failed';
  errorMessage?: string;
  executedAt?: Date;
}
```

---

### P2 - 增強（可選）

#### 7. 移動止盈追蹤
**文件位置**：`server/services/trailingStopManager.ts`
**邏輯**：
- 記錄持倉期間最高價
- 當價格回撤 >= Callback_Pct% 時平倉

#### 8. 分流冷卻機制
**文件位置**：`server/services/cooldownManager.ts`
**邏輯**：
- 馬丁解套平倉後進入冷卻期
- 冷卻期內不接受新信號

#### 9. WebSocket 實時價格監聽
**文件位置**：`server/services/websocketMonitor.ts`
**功能**：
- 實時監聽交易所價格
- 觸發止損/止盈/馬丁加倉

#### 10. 告警通知系統
**文件位置**：`server/services/alertService.ts`
**功能**：
- 極限止損觸發警報
- 每日虧損超限警報
- 策略暫停警報

---

## 🚀 快速實作指南

### 步驟 1：實作 Webhook 接收器（2-3 小時）

```bash
# 1. 安裝 Redis 客戶端
pnpm add ioredis

# 2. 創建文件
touch server/routers/webhook.router.ts

# 3. 實作核心邏輯（參考 B.2.3）
# 關鍵點：
# - 時間戳提取
# - Redis.get(lockKey)
# - Redis.set(lockKey, '1', 'EX', ttlSeconds)
# - 信號日誌記錄
```

### 步驟 2：實作馬丁引擎（1-2 小時）

```bash
# 1. 創建文件
touch server/services/martingaleEngine.ts

# 2. 實作 MartingaleEngine 類
# 關鍵方法：
# - constructor(config, initialState)
# - shouldAddLayer(currentPrice, isLong)
# - addLayer(currentPrice, isLong)
# - reset()
# - getState()
```

### 步驟 3：實作風險管理器（1 小時）

```bash
# 1. 創建文件
touch server/services/riskManager.ts

# 2. 實作 RiskManager 類
# 關鍵方法：
# - checkLimitStop(position)
# - checkDailyLoss(dailyLoss, dailyLimit)
```

### 步驟 4：前端表單（2-3 小時）

```bash
# 1. 創建 StrategyForm 組件
touch client/src/components/StrategyForm.tsx

# 2. 實作表單生成邏輯
# - 讀取 strategySchema.json
# - 動態生成表單欄位
# - 實時驗證
```

### 步驟 5：集成測試（2-3 小時）

```bash
# 1. 編寫集成測試
touch server/v35.integration.test.ts

# 2. 測試場景：
# - 首次 BUY 信號 + Redis 鎖
# - 重複信號被攔截
# - 馬丁加倉
# - 極限止損觸發
# - 平倉後狀態重置
```

---

## 📊 測試驗收清單

| 序號 | 測試項目 | 預期結果 | 狀態 |
|------|---------|--------|------|
| 1 | TradingView Alert 觸發 | 收到 Webhook 信號 | ⏳ |
| 2 | 首次信號通過 Bar-Lock | Redis 鎖建立，執行開倉 | ⏳ |
| 3 | 同 K 線重複信號 | Redis 鎖攔截，日誌顯示 Blocked | ⏳ |
| 4 | 首單止盈（分流 A） | 平倉後立即重入 | ⏳ |
| 5 | 馬丁解套（分流 B） | 平倉後冷卻，等待新 3K | ⏳ |
| 6 | 極限止損觸發 | 全平 + 策略暫停 + 警報 | ⏳ |
| 7 | 狀態持久化 | 重啟後狀態恢復 | ⏳ |
| 8 | 交易所對賬 | 本地狀態與交易所一致 | ⏳ |

---

## 🔗 文件依賴關係

```
strategy_kama_3k_v35.ts
  ├─ base.ts (BaseStrategy)
  ├─ kamaCalculator.ts (KAMA + 3K 驗證)
  └─ martingaleEngine.ts (馬丁計算)

webhook.router.ts
  ├─ strategy_kama_3k_v35.ts (策略驗證 + 決策)
  ├─ martingaleEngine.ts (倉位計算)
  ├─ riskManager.ts (風險檢查)
  ├─ signalLogger.ts (日誌記錄)
  └─ Redis (K3_Locked)

前端表單
  ├─ strategySchema.json (表單定義)
  ├─ StrategyForm.tsx (表單生成)
  └─ API 路由 (保存配置)
```

---

## ⚠️ 實作注意事項

1. **Redis 連接**：確保 REDIS_URL 環境變數已設定
2. **時間戳精度**：bar_timestamp 必須精確到毫秒
3. **浮點精度**：倉位計算使用 `Math.round(lot * 1e8) / 1e8`
4. **狀態同步**：每次交易後立即更新 DB
5. **交易所對賬**：每 5 分鐘執行一次對賬
6. **錯誤處理**：所有 API 調用必須有 try-catch

---

## 📝 下一步行動

1. **立即實作**：Webhook 接收器（最關鍵）
2. **並行實作**：馬丁引擎 + 風險管理器
3. **前端集成**：表單生成 + 參數保存
4. **測試驗收**：逐項通過測試清單
5. **部署上線**：保存 checkpoint 並發佈

---

## 💡 快速參考

### 馬丁倉位計算
```
Layer 0: 0.01 BTC
Layer 1: 0.01 × 1.5 = 0.015 BTC
Layer 2: 0.01 × 1.5² = 0.0225 BTC
Layer 3: 0.01 × 1.5³ = 0.03375 BTC
Layer 4: 0.01 × 1.5⁴ = 0.050625 BTC
Layer 5: 0.01 × 1.5⁵ = 0.0759375 BTC (上限)
```

### 極限止損條件
```
IF (浮虧 >= 1000 × 10% = 100 USDT) THEN 全平
OR
IF (價格偏離最後層 >= 3%) THEN 全平
```

### Redis 鎖 TTL
```
TTL = K_Line_Period × 2 × 60 秒
預設：30 × 2 × 60 = 3600 秒 = 1 小時
```
