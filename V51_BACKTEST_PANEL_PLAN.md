# V5.1 回測中心面板修改計劃

## 用戶需求（四張截圖）

### 截圖 1：趨勢與形態參數
- Initial_Capital 在左，Base_Lot_Size（首單倉位）在右邊
- Base_Lot_Size 有 USDT 金額 / BTC 數量 下拉選擇
- 這已經實現了（行 464-500 renderParam 中 Base_Lot_Size 雙模式）

### 截圖 2：馬丁加倉與分層參數
- Martin_Multiplier（已鎖定）| Max_Layers（自動計算）| Martin_Step_Pct（全局加倉間距%）
- 階梯式馬丁分層表格（起始/結束/乘數/間距%/累積）
- 新增分層按鈕
- 這已經實現了（MartinLayersEditor 組件 + renderParam 中 Martin_Multiplier/Max_Layers/Martin_Step_Pct 特殊處理）

### 截圖 3：主動風控與止盈參數
- Max_Loss_Pct | Max_Drawdown_Pct | Target_TP_Pct | Callback_Pct | K_Line_Period
- 5 個欄位一行排列

## 問題分析

strategy_20415 (EMATrendMartingale) 的 defaultConfig 使用 EMA 風格 keys：
- FirstLot, MartinMultiplier, AddOrderStep, MaxMartinLevels, TargetProfitPercent, MinEMADistancePips, MaxSpread, etc.

但用戶想要的面板使用 V4/KAMA 風格 keys：
- Base_Lot_Size, Martin_Multiplier, Martin_Step_Pct, Martin_Layers, Max_Layers, Max_Loss_Pct, Max_Drawdown_Pct, Target_TP_Pct, Callback_Pct, K_Line_Period

## 解決方案

需要更新 strategy_20415 的 defaultConfig 以包含 V4 風格的 keys，使面板能正確渲染：
1. 在 strategySchemas.ts 中更新 STRATEGY_20415_SCHEMA 的 defaultConfig，加入 V4 風格 keys
2. 在 strategy20415.ts 的 defaultConfig 中加入 V4 風格 keys（Initial_Capital, Base_Lot_Size, Martin_Multiplier, Martin_Step_Pct, Martin_Layers, Max_Layers, Max_Loss_Pct, Max_Drawdown_Pct, Target_TP_Pct, Callback_Pct, K_Line_Period）
3. 在 backtestEngine.ts 中確保 strategy_20415 回測路徑能正確讀取這些 V4 風格 keys
4. 更新 MARTIN_KEYS 和 RISK_KEYS 確保分組正確

## 關鍵文件和行號

- Backtest.tsx 行 271: MARTIN_KEYS
- Backtest.tsx 行 273-291: RISK_KEYS
- Backtest.tsx 行 292-296: groupOfParam
- Backtest.tsx 行 430-441: initialCapital 渲染位置（需要把 FirstLot 移到這裡旁邊）
- Backtest.tsx 行 464-500: Base_Lot_Size 雙模式渲染（已有，就是 FirstLot 的替代）
- Backtest.tsx 行 502-611: Martin_Layers/Max_Layers/Martin_Multiplier/Martin_Step_Pct 渲染
- Backtest.tsx 行 657-689: 三大區塊分組渲染

## 執行步驟

1. 更新 strategy20415.ts defaultConfig：加入 V4 風格 keys（Base_Lot_Size, Martin_Multiplier, Martin_Step_Pct, Martin_Layers, Max_Layers, Max_Loss_Pct, Max_Drawdown_Pct, Target_TP_Pct, Callback_Pct, K_Line_Period）
2. 更新 strategySchemas.ts：修改 groups 和 fields 以使用 V4 風格 keys
3. 更新 strategy20415.ts generateActions：讀取 V4 風格 keys 並映射到引擎邏輯
4. 確保 MARTIN_KEYS 和 RISK_KEYS 包含正確的 keys
5. 在 backtestEngine.ts 中確保 V4 keys 正確傳遞
