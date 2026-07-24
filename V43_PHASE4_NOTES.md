# Phase 4: 快照庫「導入新策略」實現筆記

## 後端 API 需求
在 `server/routers/backtest.router.ts` 新增 `importSnapshotAsNew` 端點：
1. 讀取快照的 config
2. 接收用戶提供的 instance-level 欄位（name, apiKeyId, symbol, positionMode, positionSize, leverage）
3. 調用 strategies.create 的相同邏輯建立新策略實例
4. 將快照 config 寫入 martinState.__v35Config

## 後端 create 策略所需欄位（server/routers.ts L239-273）
```
strategyInputSchema:
  name: string (required)
  apiKeyId: number (required)
  symbol: string (required)
  positionSize: number (required, positive)
  positionMode: 'quantity' | 'usdt' (default 'quantity')
  leverage: number (1-125, default 1)
  direction: 'long' | 'short' | 'both' (default 'both')
  orderType: 'market' | 'limit' (default 'market')
  maxPositionPct, stopLossPct, takeProfitPct, maxDailyLoss: numbers (defaults 0)
  martinMultiplier: number (1-10, default 1)
  maxMartinLevel: number (1-10, default 1)
  martinSpacingPct: number (0-50, default 0)
  strategyKey: string (optional)
  v35Config: { Martin_Layers, Reentry_On_Trend, Max_Loss_USDT, Max_Loss_Pct, Callback_Pct, K_Line_Period } (optional)
```

## 前端需求
在 ParameterSnapshots.tsx 新增：
1. 「導入為新策略」按鈕（每行操作列）
2. 導入對話框：用戶填寫 name, apiKeyId, symbol, positionSize, positionMode, leverage
3. 調用新的 importSnapshotAsNew API

## 現有 applySnapshot 位置
backtest.router.ts L295-336，新端點可放在其後面
