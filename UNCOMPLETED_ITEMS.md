# V3.5 KAMA+3K 馬丁策略系統 - 未完成項目清單

## 📋 按優先級分類

### 🔴 P0 - 核心（必須完成）- 3 項

#### ❌ 1. Webhook 接收器 + Redis 雙重鎖
**文件**：`server/routers/webhook.router.ts`
**狀態**：未建立
**依據**：Pasted_content_17.txt B.2.3
**工作量**：2-3 小時

**必須實作的方法**：
```typescript
// POST /api/webhook/signal
// 1. 提取 bar_timestamp
// 2. Redis.get(`K3_Locked:${instanceId}:${barTimestamp}`)
// 3. 如果存在 → 返回 { status: 'blocked' }
// 4. 如果不存在 → Redis.set(key, '1', 'EX', ttlSeconds)
// 5. 驗證信號（調用 strategy.validateSignal()）
// 6. 生成動作（調用 strategy.generateActions()）
// 7. 執行交易（調用 exchange adapter）
// 8. 記錄日誌
// 9. 返回結果
```

**關鍵參數**：
- Redis key: `K3_Locked:{instanceId}:{barTimestamp}`
- TTL = K_Line_Period × 2 × 60 秒
- 預設：30 分鐘 K 線 → 3600 秒

**測試場景**：
- [ ] 首次 BUY 信號 → Redis 鎖建立 → 執行開倉
- [ ] 同 K 線重複 BUY 信號 → Redis 鎖攔截 → 返回 blocked
- [ ] 下一個 K 線新信號 → Redis 鎖過期 → 執行新開倉

---

#### ❌ 2. 馬丁格爾引擎
**文件**：`server/services/martingaleEngine.ts`
**狀態**：未建立
**依據**：Pasted_content_17.txt B.2.4
**工作量**：1-2 小時

**必須實作的類**：
```typescript
export class MartingaleEngine {
  constructor(config: {
    baseLot: number;           // 0.01
    multiplier: number;        // 1.5
    stepPct: number;           // 1.5%
    maxLayers: number;         // 5
  }, initialState?: StrategyState)

  // 檢查是否應該加倉
  shouldAddLayer(currentPrice: number, isLong: boolean): boolean

  // 執行加倉
  addLayer(currentPrice: number, isLong: boolean): {
    lotSize: number;
    newState: StrategyState;
  }

  // 重置馬丁狀態
  reset(): void

  // 獲取當前狀態
  getState(): StrategyState
}
```

**核心邏輯**：
```
shouldAddLayer():
  IF currentLayer >= maxLayers → return false
  deviation = (avgPrice - currentPrice) / avgPrice × 100  // 多頭
  IF deviation >= stepPct% → return true
  ELSE → return false

addLayer():
  newLayer = currentLayer + 1
  newLotSize = baseLot × multiplier^(newLayer-1)
  newTotalSize = totalSize + newLotSize
  newTotalCost = totalCost + (currentPrice × newLotSize)
  newAvgPrice = newTotalCost / newTotalSize
  return { lotSize: newLotSize, newState: {...} }
```

**測試場景**：
- [ ] 首層開倉 @ 50000，倉位 0.01 BTC
- [ ] 價格跌至 49250（偏離 1.5%）→ shouldAddLayer = true
- [ ] 執行第 2 層加倉 @ 49250，倉位 0.015 BTC
- [ ] 驗證新均價 = 49600
- [ ] 繼續加倉至第 5 層（上限）
- [ ] 第 6 層信號被拒絕

---

#### ❌ 3. 極限防爆倉止損
**文件**：`server/services/riskManager.ts`
**狀態**：未建立
**依據**：Pasted_content_17.txt B.2.5
**工作量**：1 小時

**必須實作的類**：
```typescript
export class RiskManager {
  constructor(config: {
    initialCapital: number;      // 1000 USDT
    maxDrawdownPct: number;      // 10%
    lastLayerDeviationPct: number; // 3% (固定)
  })

  // 檢查極限止損
  checkLimitStop(position: {
    totalSize: number;
    avgPrice: number;
    currentPrice: number;
    lastLayerPrice: number;
    isLong: boolean;
  }): {
    triggered: boolean;
    reason: string;
    estimatedLoss: number;
  }

  // 檢查每日虧損
  checkDailyLoss(dailyLoss: number, dailyLimit: number): {
    triggered: boolean;
    reason: string;
  }
}
```

**觸發條件**：
```
條件 A：浮虧 >= initialCapital × maxDrawdownPct%
        例：1000 × 10% = 100 USDT 虧損

條件 B：價格偏離最後層 >= 3%
        例：最後層 @ 50000，當前 < 48500
        偏離 = (50000 - 48500) / 50000 = 3%
```

**測試場景**：
- [ ] 多頭持倉，浮虧 50 USDT → 未觸發
- [ ] 多頭持倉，浮虧 100 USDT → 觸發條件 A
- [ ] 多頭持倉，最後層偏離 2.5% → 未觸發
- [ ] 多頭持倉，最後層偏離 3.5% → 觸發條件 B
- [ ] 全平後狀態重置

---

### 🟡 P1 - 集成（必須）- 3 項

#### ❌ 4. 前端動態表單生成
**文件**：`client/src/components/StrategyForm.tsx`
**狀態**：未建立
**依據**：Pasted_content_17.txt B.2.6（strategySchema.json）
**工作量**：2-3 小時

**必須實作的功能**：
```typescript
// 1. 讀取 strategySchema.json
// 2. 根據 JSON Schema 動態生成表單欄位
// 3. 分組顯示：
//    - 資金配置（Initial_Capital, Base_Lot_Size, Max_Drawdown_Pct）
//    - KAMA 參數（KAMA_Fast_Length, p2_fastest, p3_slowest, ...）
//    - 馬丁參數（Martin_Step_Pct, Martin_Multiplier, Max_Layers）
//    - 止盈參數（Target_TP_Pct, Callback_Pct）
//    - 系統參數（K_Line_Period）
// 4. 實時驗證（min/max/step）
// 5. 預覽馬丁倉位計算結果
// 6. 保存配置到 DB
```

**表單欄位範例**：
```json
{
  "Initial_Capital": {
    "type": "number",
    "default": 1000,
    "min": 100,
    "step": 100,
    "label": "初始風控本金 (USDT)"
  },
  "Base_Lot_Size": {
    "type": "number",
    "default": 0.01,
    "min": 0.001,
    "step": 0.001,
    "label": "首單下單大小 (BTC)"
  }
}
```

**測試場景**：
- [ ] 表單載入時顯示所有欄位
- [ ] 修改 Initial_Capital，預覽止損金額變化
- [ ] 修改 Martin_Multiplier，預覽馬丁倉位變化
- [ ] 保存配置，重新載入驗證持久化

---

#### ❌ 5. 策略狀態持久化
**文件**：`server/db/strategyStateManager.ts`
**狀態**：未建立
**依據**：Pasted_content_17.txt 隱含要求
**工作量**：1-2 小時

**必須實作的方法**：
```typescript
// 1. 保存狀態到 DB
async updateStrategyState(strategyId: number, state: StrategyState): Promise<void>

// 2. 從 DB 恢復狀態
async getStrategyState(strategyId: number): Promise<StrategyState | null>

// 3. 與交易所對賬
async reconcileWithExchange(strategyId: number, exchange: ExchangeAdapter): Promise<{
  matched: boolean;
  localState: StrategyState;
  exchangePosition: Position;
  corrections?: string[];
}>

// 4. 重置狀態
async resetStrategyState(strategyId: number): Promise<void>
```

**對賬邏輯**：
```
1. 從 DB 讀取本地 martinState
2. 調用 exchange.getPositions()
3. 比較 totalSize 和 avgPrice
4. 如果不一致，記錄差異並修正本地狀態
5. 記錄對賬日誌
```

**測試場景**：
- [ ] 開倉後保存狀態
- [ ] 重啟服務，狀態自動恢復
- [ ] 加倉後狀態更新
- [ ] 與交易所對賬，發現差異時修正

---

#### ❌ 6. 信號日誌記錄
**文件**：`server/db/signalLogger.ts`
**狀態**：未建立
**依據**：Pasted_content_17.txt B.2.3
**工作量**：1 小時

**必須記錄的信息**：
```typescript
{
  instanceId: number;
  barTimestamp: number;
  rawPayload: string;           // 原始 Webhook payload
  parsedAction: 'BUY' | 'SELL' | 'CLOSE';
  validationStatus: 'valid' | 'invalid';
  validationReason?: string;    // 驗證失敗原因
  executionStatus: 'executed' | 'blocked' | 'failed';
  executionReason?: string;     // 執行失敗原因
  tradeId?: string;             // 交易所返回的訂單 ID
  createdAt: Date;
}
```

**測試場景**：
- [ ] 有效信號 → 記錄 executed
- [ ] 重複信號 → 記錄 blocked
- [ ] 驗證失敗 → 記錄 invalid + reason
- [ ] 查詢日誌，驗證完整性

---

### 🟢 P2 - 增強（可選）- 4 項

#### ❌ 7. 移動止盈追蹤
**文件**：`server/services/trailingStopManager.ts`
**狀態**：未建立
**依據**：Pasted_content_17.txt B.1.5
**工作量**：1-2 小時

**必須實作的邏輯**：
```
1. 記錄持倉期間最高價
2. 當價格回撤 >= Callback_Pct% 時平倉
3. 例：Target_TP_Pct = 1.0%, Callback_Pct = 0.2%
   - 開倉 @ 50000
   - 價格漲至 50500（+1.0%）→ 激活移動止盈
   - 記錄最高價 = 50500
   - 價格跌至 50399（回撤 0.2%）→ 平倉
```

---

#### ❌ 8. 分流冷卻機制
**文件**：`server/services/cooldownManager.ts`
**狀態**：未建立
**依據**：Pasted_content_17.txt B.1.6
**工作量**：1 小時

**必須實作的邏輯**：
```
1. 馬丁解套平倉後進入冷卻期
2. 冷卻期內不接受新信號
3. 冷卻時長 = K_Line_Period × 2 × 60 秒
4. 例：30 分鐘 K 線 → 冷卻 1 小時
```

---

#### ❌ 9. WebSocket 實時價格監聽
**文件**：`server/services/websocketMonitor.ts`
**狀態**：未建立
**依據**：Pasted_content_17.txt 隱含要求
**工作量**：2-3 小時

**必須實作的功能**：
```
1. 連接交易所 WebSocket
2. 訂閱策略交易對的實時價格
3. 檢查止損/止盈/馬丁加倉條件
4. 自動觸發相應動作
```

---

#### ❌ 10. 告警通知系統
**文件**：`server/services/alertService.ts`
**狀態**：未建立
**依據**：Pasted_content_17.txt 隱含要求
**工作量**：1-2 小時

**必須通知的事件**：
```
1. 極限止損觸發 → 發送警報
2. 每日虧損超限 → 發送警報
3. 策略暫停 → 發送通知
4. 馬丁層數達上限 → 發送通知
```

---

## 📊 完成進度統計

| 優先級 | 模組數 | 已完成 | 未完成 | 進度 |
|-------|-------|-------|-------|------|
| P0 | 3 | 0 | 3 | 0% |
| P1 | 3 | 0 | 3 | 0% |
| P2 | 4 | 0 | 4 | 0% |
| **總計** | **10** | **3** | **7** | **30%** |

---

## 🎯 建議執行順序

### 第 1 天（4-5 小時）
1. ✅ Webhook 接收器 + Redis 鎖（最關鍵）
2. ✅ 馬丁格爾引擎（倉位計算）

### 第 2 天（3-4 小時）
3. ✅ 風險管理器（極限止損）
4. ✅ 前端表單（參數配置）

### 第 3 天（2-3 小時）
5. ✅ 狀態持久化（DB 同步）
6. ✅ 信號日誌（審計追蹤）

### 第 4 天（2-3 小時）
7. ✅ 移動止盈（可選）
8. ✅ 冷卻機制（可選）

### 第 5 天（2-3 小時）
9. ✅ WebSocket 監聽（可選）
10. ✅ 告警系統（可選）

---

## 💻 快速開始命令

```bash
# 1. 創建所有待實作文件
mkdir -p server/db server/routers
touch server/routers/webhook.router.ts
touch server/services/martingaleEngine.ts
touch server/services/riskManager.ts
touch server/db/strategyStateManager.ts
touch server/db/signalLogger.ts
touch client/src/components/StrategyForm.tsx
touch server/services/trailingStopManager.ts
touch server/services/cooldownManager.ts
touch server/services/websocketMonitor.ts
touch server/services/alertService.ts

# 2. 安裝必要依賴
pnpm add ioredis @types/ioredis

# 3. 啟動開發伺服器
pnpm dev

# 4. 運行測試
pnpm test
```

---

## ⚠️ 實作注意事項

1. **Redis 連接**：確保 `REDIS_URL` 環境變數已設定
2. **時間戳精度**：`bar_timestamp` 必須精確到毫秒
3. **浮點精度**：使用 `Math.round(lot * 1e8) / 1e8`
4. **狀態同步**：每次交易後立即更新 DB
5. **交易所對賬**：每 5 分鐘執行一次
6. **錯誤處理**：所有 API 調用必須有 try-catch
7. **日誌記錄**：記錄所有關鍵決策點

---

## 📝 驗收清單

- [ ] Webhook 接收器完成並通過測試
- [ ] 馬丁引擎完成並通過測試
- [ ] 風險管理器完成並通過測試
- [ ] 前端表單完成並通過測試
- [ ] 狀態持久化完成並通過測試
- [ ] 信號日誌完成並通過測試
- [ ] 端到端測試通過
- [ ] 保存 checkpoint
- [ ] 部署上線
