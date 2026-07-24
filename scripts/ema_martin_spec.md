# EMA 馬丁策略規格（來源：pasted_content_3.txt）

## 策略名稱
EMA 均線回歸馬丁格爾（優化版）- strategy_ema_martin

## 核心邏輯
- EMA3/EMA6 交叉判斷方向
- EMA15 為中心定義可買賣區域（±Buffer）
- 首單在區域內順勢開倉
- 逆勢時啟動馬丁加倉（動態間距 ATR），最多 12 層
- 出場：移動止盈（盤整/趨勢分別設定）+ 動態硬止損

## 模組
- A：動態止盈（EMA3-EMA6 差值區分盤整/趨勢）
- B：動態加倉間距（ATR × 0.15，限幅 200~800 USD）
- D：EMA 斜率濾網（避免盤整假信號）
- E：動態硬止損（持倉手數 × ATR × 0.6，下限 -1200 USD）

## 參數配置（defaultConfig）
```
symbol: "BTCUSDT"
ema_killer: 3          // Killer MA
ema_wave: 6            // Wave MA
ema_enter: 15          // Enter MA
buffer_points: 8000    // 緩衝區（點數），BTC 8000 = 80 USD
pip_step_base: 500.0   // 基準加倉間距（USD）
enable_dynamic_pip: true  // 動態間距開關
base_lot: 0.01         // 起始手數
multiplier: 1.5        // 馬丁倍數
max_layers: 12         // 最大層數
tp_normal: 150.0       // 止盈（盤整）USD
tp_trend: 250.0        // 止盈（趨勢）USD
trail_normal: 25.0     // 追蹤回撤（盤整）USD
trail_trend: 30.0      // 追蹤回撤（趨勢）USD
trend_threshold: 50.0  // EMA3-EMA6 差值門檻
slope_threshold: 3.0   // EMA15 斜率門檻（USD/5根）
atr_period: 14         // ATR 週期
pipstep_atr_multiplier: 0.15  // ATR 乘數
pipstep_min: 200.0     // 動態間距下限
pipstep_max: 800.0     // 動態間距上限
hard_stop_max: -1200.0 // 硬止損上限
hard_stop_atr_multiplier: 0.6  // 硬止損 ATR 乘數
```

## XAUUSD 預設
```
buffer_points: 50, pip_step: 1000, enable_dynamic_pip: false
max_layers: 6, tp_normal: 8, tp_trend: 15
trail_normal: 1.5, trail_trend: 2.5
hard_stop_max: -100, slope_threshold: 0.5
```

## 信號邏輯（get_signal）
### 無持倉時：
1. 斜率濾網：EMA15 近 5 根變化 >= slope_threshold
2. 做多：EMA3 > EMA6 且 price >= (EMA15 - buffer_usd)
3. 做空：EMA3 < EMA6 且 price <= (EMA15 + buffer_usd)

### 有持倉時：
1. 動態硬止損：total_profit <= hard_stop → CLOSE_ALL
2. 追蹤止盈：profit >= tp_target 且 peak - profit >= trail → CLOSE_ALL
3. 馬丁加倉：layer < max 且 distance >= pipstep → ADD（lot = base * mult^layer）
4. 否則 HOLD

## 實作計劃
1. 創建 server/strategies/builtin/strategyEmaMartin.ts（取替原有 SMA v3.00）
2. 在 strategyStudio 中註冊 key = "strategy_ema_martin"
3. 前端：在策略表單中添加 EMA 馬丁策略的參數面板
4. 確保不動到 KAMA 馬丁策略（20415_KAMA_MARTIN_V35）
