# 修復計劃：reconcile 軟隔離持倉混亂

## 問題根因

1. **持倉顯示 100 BTC** — reconcile 的減法邏輯 `expectedLocalSize = exchangeTotalSize - otherStrategiesTotalSize`
   當其他策略的 totalSize 被錯誤重置為 0 時，本策略會被分配到交易所全部持倉。
   策略配置 positionSize=100（USDT金額）不是問題來源。

2. **0.0045000000000000005** — MartingaleEngine.addLayer 中浮點累加精度問題 ✅ 已修復

3. **開倉後立即顯示無持倉** — reconcile 的減法邏輯在多策略共享帳戶時互相干擾：
   - V5.0 開倉 0.0015 → 交易所持倉 0.003（V3.5 也有 0.0015）
   - reconcile V5.0 時：expectedLocalSize = 0.003 - V3.5的totalSize(0.0015) = 0.0015 ✓
   - 但如果 V3.5 先被 reconcile 恢復了 totalSize=0.003（因為 V5.0 此時 totalSize=0），
     那 V5.0 的 expectedLocalSize = 0.003 - 0.003 = 0 → 被重置為無持倉 ✗

## 修復方案：改為「信任本地記錄」策略

核心原則：**本地 martinState 是唯一真相來源**（因為每次下單成功後都會精確更新）。
reconcile 只在以下明確場景才介入：
1. 交易所完全無持倉（size=0）但本地有 → 外部平倉，重置本地
2. 本地 totalSize > 0 但方向與交易所不一致 → 修正方向
3. 其他情況：信任本地記錄，不做修正

**不再使用減法推算**，因為多策略共享帳戶時減法會互相干擾。

## 前端修復
- 持倉數字格式化：用 `parseFloat(sz.toPrecision(10))` 避免顯示長小數
