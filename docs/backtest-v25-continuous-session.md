# 回測引擎 V2.5 連續 Session 技術規格與驗收報告

**作者：Manus AI**  
**日期：2026-07-29**  
**狀態：已完成實作與程式級驗收**

## 1. 目標與結論

本次改造將回測資料載入、策略執行、終點持倉處理、權益帳本、背景任務、主資料庫與前端報告統一到 **V2.5 連續 Session** 契約。引擎版本固定為 `2.5.0-continuous`；資料切片採半開區間 `[start,end)`；策略狀態只建立一次並連續運行至全域終點，不再因資料分片而重置資金、持倉或指標。[1]

終點持倉預設使用 `mark_to_market`，保留未平倉部位並以最後有效價格估值；使用者亦可選擇 `force_close`，由引擎僅在全域資料終點合成一次平倉。兩種政策共用同一權益帳本與對帳守門器，最終權益必須符合初始資金、已實現損益與未實現損益的單一等式。[1]

## 2. 中央契約

| 契約項目 | V2.5 規格 | 實務效果 |
|---|---|---|
| 引擎版本 | `2.5.0-continuous` | 報告、歷史紀錄與環境快照可辨識新舊口徑 |
| Session 模式 | `continuous` | 單次策略生命週期，資料分片不重置狀態 |
| 資料區間 | `[start,end)` | 相鄰資料片不重複包含邊界 K 棒 |
| 終結範圍 | `global_end_only` | 只允許全域資料終點執行持倉終結 |
| 預設終點政策 | `mark_to_market` | 不製造虛構已實現交易，保留未平倉估值 |
| 可選終點政策 | `force_close` | 在全域終點以統一原因合成一次平倉 |
| 對帳容差 | `0.02` | 金額四捨五入後容許最多兩分差異 |

中央契約由 `backtestContracts.ts` 提供正規化、資料品質、未平倉快照、權益帳本與不可繞過的對帳斷言；所有專用策略與通用策略分支都在主入口套用同一政策與結果守門器。[1] [2]

## 3. 資料正規化與品質稽核

每次回測在進入策略引擎前，會先排除非有限數值、OHLC 關係錯誤、負成交量、範圍外資料與尚未收盤的 K 棒，再依時間戳去重並嚴格遞增排序。區間判斷統一為 `timestamp >= startMs && timestamp < endMs`，可避免相鄰資料片的結束邊界被下一片重複計入。[1]

| 品質欄位 | 含義 |
|---|---|
| `inputCandles` / `returnedCandles` | 正規化前後的 K 棒數量 |
| `duplicateCandlesRemoved` | 重複時間戳移除數 |
| `outOfRangeCandlesRemoved` | 半開區間外移除數 |
| `invalidCandlesRemoved` | 數值或 OHLC 結構無效移除數 |
| `unclosedCandlesRemoved` | 未收盤 K 棒移除數 |
| `firstTimestamp` / `lastTimestamp` | 有效資料邊界 |
| `sortedAscending` | 是否為嚴格遞增時間序列 |

## 4. 單一權益帳本

V2.5 以同一帳本計算所有策略的回測終值。核心關係為：

> `expectedFinalEquity = initialCapital + realizedPnl + unrealizedPnl`

`mark_to_market` 會保留 `openPosition`，以最後標記價格計算未實現損益及入場手續費；`force_close` 則把全域終點的合成平倉納入交易損益，未平倉數回到零。引擎比較 `finalEquity` 與 `expectedFinalEquity`，若差異超過 `0.02` 即拋出錯誤，防止任一策略以獨立計算路徑繞過對帳。[1]

| 帳本欄位 | 稽核用途 |
|---|---|
| `realizedPnl` | 所有已完成交易損益總和 |
| `unrealizedPnl` | 終點仍持有部位的淨估值 |
| `finalEquity` | 引擎實際回傳終值 |
| `expectedFinalEquity` | 依單一等式重算的終值 |
| `reconciliationDifference` | 實際終值與重算終值差異 |
| `reconciled` / `balanced` | 是否通過容差守門器 |
| `openPositionCount` | 終點未平倉數 |
| `syntheticForceCloseCount` | 全域終點合成平倉數 |

## 5. 背景任務、API 與主資料庫

任務提交時，`endPositionPolicy` 會先進入背景任務記錄，再傳入實際策略請求。任務完成後，管理器集中映射 `candleCount`、`accounting`、`dataQuality`、`engineSemantics` 與 `environment`，同時供完整結果回讀與歷史清單查詢，避免即時結果與持久化結果採用不同欄位口徑。[3] [4]

| `backtest_jobs` 欄位 | 型別 | 用途 |
|---|---|---|
| `endPositionPolicy` | `varchar(20)`，非空，預設 `mark_to_market` | 保存使用者選擇的終點政策 |
| `candleCount` | `int`，可空 | 規範化後有效 K 棒數 |
| `accounting` | `json`，可空 | 單一帳本與未平倉估值 |
| `dataQuality` | `json`，可空 | 半開區間、排序、去重與未收盤過濾統計 |
| `engineSemantics` | `json`，可空 | 連續 Session 與全域終點語義 |
| `environment` | `json`，可空 | 可重現性環境快照 |

資料庫的實際欄位與 Drizzle schema 已同步；新欄位均允許舊紀錄保持 `null`，因此歷史資料不需回填即可相容。[5]

## 6. 前端行為

回測中心新增全域終點持倉政策控制，預設 `mark_to_market`，並把選擇同步納入任務提交、設定快照保存與快照載入。即時結果與歷史結果共用相同報告元件，會顯示引擎版本、政策、有效 K 棒、單一帳本、對帳差異、未平倉估值、資料品質、連續 Session 語義及環境快照。[6] [7]

歷史列表及多策略比較會優先顯示 V2.5 引擎版本、終點政策、對帳狀態與有效 K 棒；缺少新欄位的舊紀錄顯示為 `legacy`，不會因可空欄位造成渲染失敗。[8]

## 7. 回歸驗證

| 驗證層級 | 覆蓋內容 | 結果 |
|---|---|---|
| 中央契約 | 政策正規化、連續 Session 語義、帳本容差 | 通過 |
| 資料邊界 | `[start,end)`、排序、去重、無效與未收盤過濾 | 通過 |
| 終點政策 | `mark_to_market` 與 `force_close` | 通過 |
| 全策略守門器 | 所有已註冊策略鍵共用 V2.5 對帳與語義 | 通過 |
| API／持久化 | 預設政策、快照 round-trip、資料庫欄位映射 | 通過 |
| 全專案 | TypeScript、555 項 Vitest、正式建置 | 通過 |

專門回歸套件位於 `server/backtest-v25-continuity.test.ts`，並與既有 OKX、七彩虹及回測驗證套件一併執行。[9]

## 8. 視覺驗收限制

開發預覽工作階段可透過 HTTP 讀取 Vite 入口及相依模組，但自動瀏覽器未能建立 ES 模組圖，因此 `/backtest` 顯示空白。使用已通過建置的正式單一 bundle 進行替代驗證時，React、深色主題與登入閘門均可正常掛載；受保護頁面隨後停在 Manus OAuth 與真人驗證，未使用任何繞過方式。詳細診斷與證據保存在視覺驗收紀錄中。[10]

此限制不影響已完成的型別、測試、建置與資料契約驗證。使用者登入已發布版本後，建議以一筆 `mark_to_market` 與一筆 `force_close` 回測人工複核報告版面及實際資料內容。

## References

[1]: ../server/services/backtest/backtestContracts.ts "V2.5 中央契約"
[2]: ../server/services/backtest/backtestEngine.ts "回測引擎主入口與全策略守門器"
[3]: ../server/services/backtest/backtestJobManager.ts "背景回測任務與持久化映射"
[4]: ../server/routers/backtest.router.ts "回測 API 與快照契約"
[5]: ../drizzle/schema.ts "Drizzle 資料庫 schema"
[6]: ../client/src/pages/Backtest.tsx "回測中心頁面"
[7]: ../client/src/components/backtest/BacktestReport.tsx "V2.5 回測報告"
[8]: ../client/src/components/backtest/BacktestHistory.tsx "歷史與比較列表"
[9]: ../server/backtest-v25-continuity.test.ts "V2.5 連續 Session 回歸套件"
[10]: ./backtest-v25-visual-validation.md "V2.5 視覺驗收紀錄"
