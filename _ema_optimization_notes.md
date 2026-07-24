# EMA 馬丁策略優化需求摘要（來自 Pasted_content_31.txt）

## 核心命令

### 命令 1：Base_Lot_Size 必須為 lot/volume 模式
- Base_Lot_Size 應為對象格式 `{ value: number, mode: 'usdt' | 'quantity' }`
- 已完成：backtestEngine.ts 和 executor.ts 已支援

### 命令 2：入場條件僅依賴 EMA1/2/3（嚴格 AND 邏輯）
- 做多：EMA1(Killer) 上穿 EMA2(Wave) AND EMA1 > EMA3(Trend) AND price < EMA_Enter
- 做空：EMA1(Killer) 下穿 EMA2(Wave) AND EMA1 < EMA3(Trend) AND price > EMA_Enter
- 已完成：checkEntry 函數已修改

### 命令 3：平倉後循環再入場
- 平倉後如果 EMA 條件仍然滿足，應在冷卻期後重新入場
- Reentry_Enabled: boolean
- Reentry_Cooldown_Bars: number（冷卻 K 線數）
- 已完成：closePos 函數和主迴圈已修改

### 命令 4：網格加倉獨立於 EMA 信號
- 加倉只看價格偏離（PipStep），不需要 EMA 交叉
- 已完成：checkGridAdd 函數獨立運作

### 命令 5：方向轉換停用
- 持倉時收到反向 EMA 交叉信號，不平倉、不轉向
- 只有止盈/止損才會平倉
- 已完成：方向轉換邏輯已移除

### 命令 6：Max_Layers 從 Martin_Tiers 最後一層 end 自動推導
- 不再寫死 5 層
- 已完成：maxMartinLevels 從 Martin_Tiers 推導

## 當前狀態
- emaPeriods 已擴展為 6 條 EMA（Killer, Wave, Trend, Enter, Lower, Upper）
- checkEntry 已使用 trendSeries[2] 和 enterSeries[3]
- reentryCooldownCounter 在主迴圈中處理
- 需要確認：reentryCooldownCounter 在無持倉時也要遞減
- 需要確認：TypeScript 編譯無錯誤
