# V4.5 用戶要求：策略管理新增策略表單優化

## 核心要求
用戶要求在 Strategies.tsx 的「新增策略」彈窗中：
1. **極限止損只出現 1 次**（目前出現了 2 次：一次在「風險控管」區、一次在「進階風控與馬丁優化」區）
2. **馬丁模式二選一**：固定乘數 vs 階梯式分層，用 select 切換
3. **進階設定折疊**：風控欄位（最大單筆倉位%、止損%、止盈%、每日最大虧損）預設隱藏在折疊區
4. **倉位預覽顯示**：根據參數即時計算並顯示各層觸發價、倉位、累計倉位、均價

## 用戶提供的 KAMA_3K_SCHEMA 結構
```
fields: [
  { key: 'Base_Lot_Size', type: 'number', label: '倉位大小 (BTC)', default: 0.01 },
  { key: 'position_mode', type: 'select', label: '倉位模式', options: quantity/usdt },
  { key: 'Initial_Capital', type: 'number', label: '初始本金 (USDT)', default: 100 },
  { key: 'Max_Loss_Pct', type: 'number', label: '極限止損 (%)', default: 6 },
  { key: 'martin_mode', type: 'select', label: '馬丁模式', options: fixed/layered },
  { key: 'Martin_Step_Pct', type: 'number', label: '加倉間距 (%)', default: 1.5 },
  { key: 'Martin_Multiplier', type: 'number', label: '馬丁倍率', default: 1.5, condition: martin_mode==fixed },
  { key: 'Max_Layers', type: 'number', label: '最大層數', default: 5 },
  { key: 'Target_TP_Pct', type: 'number', label: '止盈觸發 (%)', default: 1.0 },
  { key: 'Callback_Pct', type: 'number', label: '回撤平倉 (%)', default: 0.2 },
  { key: 'trade_direction', type: 'select', label: '交易方向', options: both/long/short },
  // 進階設定（預設隱藏）
  { key: 'max_single_position_pct', label: '最大單筆倉位 (%)' },
  { key: 'stop_loss_pct', label: '止損 (%)' },
  { key: 'take_profit_pct', label: '止盈 (%)' },
  { key: 'daily_loss_limit', label: '每日最大虧損 (USDT)' },
]
```

## 現有 Strategies.tsx 結構（需要修改的部分）
- 行 942-990：硬編碼「風險控管」區塊（maxPositionPct, stopLossPct, takeProfitPct, maxDailyLoss）→ 改為折疊在「進階設定」中
- 行 992-1031：硬編碼「馬丁參數」區塊（martinMultiplier, maxMartinLevel, martinSpacingPct）→ 整合到 DynamicForm 的馬丁模式
- 行 1033-1183：硬編碼「進階風控與馬丁優化 V3.5」區塊（Initial_Capital, First_Order_Pct, Max_Loss_Pct, martinLayersJson, maxLossPct, callbackPct, kLinePeriod, reentryOnTrend, maxLossUsdt）→ 整合到 DynamicForm
- 行 1185-1207：策略引擎綁定（保留）
- 行 1209-1219：V35ConfigPanel 條件顯示（保留倉位預覽功能）

## 實現策略
將行 942-1183 的三個硬編碼區塊替換為一個 DynamicForm 組件調用，同時：
- 保留基礎設定（策略名稱、API金鑰、交易對、倉位大小、槓桿、方向、下單類型）不動（行 800-940）
- 保留策略引擎綁定（行 1185-1207）不動
- 保留 V35ConfigPanel 倉位預覽（行 1209-1219）不動
- 用 DynamicForm 替換中間的風控+馬丁+進階風控三個區塊

## 欄位映射（DynamicForm key → form state key）
- Base_Lot_Size → positionValue（已在上方「倉位大小」處理，DynamicForm 不需重複）
- Initial_Capital → Initial_Capital
- Max_Loss_Pct → Max_Loss_Pct（極限止損，只出現 1 次）
- martin_mode → 新欄位（fixed=使用 martinMultiplier, layered=使用 martinLayersJson）
- Martin_Step_Pct → martinSpacingPct
- Martin_Multiplier → martinMultiplier（condition: martin_mode==fixed）
- Max_Layers → maxMartinLevel
- Target_TP_Pct → takeProfitPct（但語義不同，需注意）
- Callback_Pct → callbackPct
- max_single_position_pct → maxPositionPct（進階）
- stop_loss_pct → stopLossPct（進階）
- take_profit_pct → takeProfitPct（進階，注意與 Target_TP_Pct 區分）
- daily_loss_limit → maxDailyLoss（進階）
