# SMA v3.00 對稱統一版 策略分析

## 修改範圍：僅涉及 EMA 馬丁（strategy_20415），不影響 KAMA 馬丁

## 策略核心邏輯（來自文件）

### 1. EMA 指標系統
- Killer EMA (3)：最快線
- Wave EMA (6)：次快線
- Enter EMA (15)：入場參考線
- Lower EMA (30)：慢線
- Upper EMA (60)：最慢線
- 時間框架：30 分鐘

### 2. 入場條件（交叉信號）
- **做多**：Killer 上穿 Wave（cross_up）且 price < Enter
- **做空**：Killer 下穿 Wave（cross_down）且 price > Enter

### 3. 加倉邏輯（網格馬丁）
- 最大層數：8 層
- 乘數：1.5x
- 網格間距（點數）：200, 300, 400, 500, 400, 300, 200
- 做多加倉：價格下跌至 last_price - step
- 做空加倉：價格上漲至 last_price + step

### 4. 止盈邏輯（金額追踪止盈）
- 做多啟動閾值：$2.0
- 做空啟動閾值：$2.0
- 追踪回撤：$0.1
- 邏輯：浮盈達到閾值後追踪，從峰值回撤 $0.1 即平倉

### 5. 風控
- 硬止損：-$100
- 新聞禁開倉：指定時間前後 360 分鐘

### 6. 方向轉換
- 持多時：Killer 下穿 Wave 且 price > Enter → 平倉轉空
- 持空時：Killer 上穿 Wave 且 price < Enter → 平倉轉多

## 與現有 EMA 馬丁（strategy_20415）的差異

| 特性 | 現有 strategy_20415 | SMA v3.00 |
|------|---------------------|-----------|
| 入場條件 | 五線排列（太嚴格） | 雙線交叉 + 價格位置（更寬鬆） |
| 加倉間距 | 固定百分比 | 非對稱網格（點數） |
| 止盈方式 | 百分比止盈 | 金額追踪止盈 |
| 方向轉換 | 無 | 有（交叉信號觸發） |
| 新聞禁開 | 無 | 有 |
| 最大層數 | 15 | 8 |

## 實施計劃

### 後端改動
1. 重寫 strategy_20415 的回測邏輯（backtestEngine.ts 中 EMA 馬丁路徑）
2. 入場條件改為：Killer/Wave 交叉 + 價格位置判斷
3. 加倉邏輯改為：非對稱網格間距（config 可配置）
4. 止盈改為：金額追踪止盈（dollar_start + dollar_trail）
5. 新增方向轉換邏輯
6. 新增新聞禁開倉功能

### 前端改動
1. 更新 strategy_20415 的 defaultConfig 和 schema
2. 更新回測表單參數輸入
3. 更新回測結果顯示

### 配置參數對應
- ema_params → EMA1_Period(3), EMA2_Period(6), EMA3_Period(15), EMA4_Period(30), EMA5_Period(60)
- lot_params → Base_Lot_Size, Martin_Multiplier, MaxMartinLevels
- grid_steps → Step_Level_1_2, Step_Level_2_3, ... Step_Level_7_8
- take_profit → Dollar_Start_Buy, Dollar_Start_Sell, Dollar_Trail
- risk_control → Dollar_Loss, News_Blackout_Minutes, News_Times
