# 實盤交易問題分析

## 問題 1：V5.0 BTC 虧損 2% 未開馬丁

**根本原因**：V5.0 馬丁邏輯中缺少 Max_Drawdown_Pct 檢查

**現象**：
- OKX 顯示：0.0015 BTC，均價 64248.00，當前虧損 -0.67 USDT（-3.45%）
- 但未觸發馬丁加倉

**修復**：已在 V5.0 generateActionsV35 中添加 Max_Drawdown_Pct 檢查
- 檢查邏輯：如果 state.maxDrawdownPct >= Max_Drawdown_Pct，則停止加倉
- 位置：server/strategies/v50/strategy_kama_3k_v50.ts 第 324-332 行

**待驗證**：
- 確認 StrategyState 中 maxDrawdownPct 是否正確計算和更新
- 確認 V5.0 Monitor 是否正確傳遞 maxDrawdownPct 到 state

---

## 問題 2：ETH 交易金額過低（0.0016 ETH ≈ 3 USDT）

**現象**：
- 預期交易金額：base_lot_size = 100 USDT
- 實際交易金額：0.0016 ETH ≈ 3 USDT（只有 3% 的預期金額）

**可能原因**：
1. base_lot_size 設置不正確或未被正確讀取
2. 交易對規格限制（最小訂單量、精度限制）
3. 首單計算邏輯未正確應用 base_lot_size

**待調查**：
- 檢查 V4.0 策略的 calculateLotSize 邏輯
- 確認 OKX ETH-USDT-SWAP 的交易對規格
- 驗證 base_lot_size 在前端和後端的傳遞

---

## 問題 3：持倉卡片缺少實時 USDT 升跌顯示

**需求**：
- 當前市值（USDT）
- 入場成本（USDT）
- 未實現盈虧（USDT 和 %）

**應用範圍**：所有策略（V3.5、V4.0、V5.0、V6.1）

**實現方式**：
- 從 OKX 實時獲取當前價格
- 計算當前市值 = 持倉量 × 當前價格
- 計算未實現盈虧 = 當前市值 - 入場成本

---

## 修復進度

- [x] V5.0 馬丁 Max_Drawdown_Pct 檢查已添加
- [ ] 分析 ETH 交易金額過低的根本原因
- [ ] 修復持倉卡片新增實時 USDT 升跌顯示
- [ ] 測試驗證所有修復
