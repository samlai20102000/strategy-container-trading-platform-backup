# V4.5 策略管理「新增策略」表單重構計劃

## 問題分析

用戶指出 Strategies.tsx 的「新增策略」彈窗存在以下問題：
1. **極限止損重複出現**：line 1070 的 `Max_Loss_Pct` 和 line 1100 的 `maxLossPct`（V3.7 硬止損）功能重疊
2. **馬丁參數分散**：line 992 有一個「馬丁參數」區塊，line 1088 又有「階梯式馬丁乘數分層」
3. **沒有使用 DynamicForm**：用戶多次要求使用 DynamicForm 組件替換硬編碼表單
4. **進階設定沒有折疊**：風控欄位應預設隱藏在折疊區

## 重構方案

### 目標結構（新增策略彈窗）：
1. **基礎設定**（保留不動）：策略名稱、API 金鑰、交易對、倉位大小（含模式切換）、槓桿、交易方向、下單類型
2. **策略引擎選擇**（保留不動）：策略引擎下拉
3. **策略參數區**（用 DynamicForm 替換）：
   - 當選擇 KAMA+3K 策略時，使用 KAMA_3K_SCHEMA 渲染 DynamicForm
   - 包含：初始本金、首單倉位(USDT)、馬丁模式(固定/階梯)、馬丁倍率(conditional)、加倉間距、最大層數、止盈、回撤、K線週期、順勢重入
   - 極限止損只出現 1 次（在 DynamicForm 的 Max_Loss_Pct 欄位）
   - 進階設定折疊：最大單筆倉位%、止損%、止盈%、每日最大虧損
   - 倉位預覽表格
4. **V35ConfigPanel**（保留）：馬丁倉位預覽表

### 需要刪除的區塊：
- line 942-990：「風險控管」硬編碼區塊 → 移入 DynamicForm 的進階設定折疊
- line 992-1031：「馬丁參數」硬編碼區塊 → 移入 DynamicForm
- line 1033-1183：「進階風控與馬丁優化」硬編碼區塊 → 移入 DynamicForm

### DynamicForm 的 STRATEGY_FORM_SCHEMA（策略管理專用）：
需要新建一個專門給策略管理用的 schema，包含：
- Initial_Capital (number, 初始本金)
- Base_Lot_Size (number, 首單倉位 USDT)  
- martin_mode (select, 固定乘數/階梯式分層)
- Martin_Multiplier (number, conditional on martin_mode=fixed)
- martinLayersJson (special, conditional on martin_mode=layered) → 保留 MartinLayersEditor
- Martin_Step_Pct (number, 加倉間距%)
- Max_Layers (number, 最大層數)
- Target_TP_Pct (number, 止盈觸發%)
- Callback_Pct (number, 回撤平倉%)
- Max_Loss_Pct (number, 極限止損% - 只出現這一次)
- K_Line_Period (number, K線週期)
- Reentry_On_Trend (boolean, 順勢重入)
- Max_Loss_USDT (number, 絕對金額限損)
- 進階設定（折疊）：maxPositionPct, stopLossPct, takeProfitPct, maxDailyLoss

### handleSubmit payload 映射：
DynamicForm 的 values 需要映射回現有 payload 結構：
- form.positionMode 和 form.positionValue → payload.positionSize, payload.positionMode
- v35Config.Initial_Capital ← DynamicForm values.Initial_Capital
- v35Config.First_Order_Pct ← 不再使用（改為固定金本位）
- v35Config.Max_Loss_Pct ← DynamicForm values.Max_Loss_Pct
- v35Config.Martin_Layers ← DynamicForm values.martinLayersJson
- v35Config.Callback_Pct ← DynamicForm values.Callback_Pct
- v35Config.K_Line_Period ← DynamicForm values.K_Line_Period
- payload.martinMultiplier ← DynamicForm values.Martin_Multiplier
- payload.maxMartinLevel ← DynamicForm values.Max_Layers
- payload.martinSpacingPct ← DynamicForm values.Martin_Step_Pct
- payload.maxPositionPct ← DynamicForm values.maxPositionPct (進階)
- payload.stopLossPct ← DynamicForm values.stopLossPct (進階)
- payload.takeProfitPct ← DynamicForm values.takeProfitPct (進階)
- payload.maxDailyLoss ← DynamicForm values.maxDailyLoss (進階)

## 文件修改清單
1. client/src/components/DynamicForm.tsx - 更新：新增 advancedFields 折疊區 + MartinLayersEditor 整合
2. client/src/pages/Strategies.tsx - 重構：刪除 942-1183 硬編碼區塊，替換為 DynamicForm
