# 訊號盈虧與交易報告根治工程：最終技術報告

**作者：Manus AI**  
**日期：2026-07-29**  
**狀態：根因修復與真實資料驗收已完成；最終發布閘門驗收中**

## 一、執行結論

本次故障已依「**全策略共用契約，而非單點補丁**」完成根治。原始問題並非只有 CSV 按鍵失效，也不是 20415 的個別策略錯誤，而是訊號、成交、已實現盈虧、列表與匯出分別使用不同資料路徑。修復後，所有既有及未來策略均透過共用交易真相層記錄成交；訊號日誌、生成前預檢、CSV 與 Excel 共用同一份後端 journal 查詢；交易所尚未結算的項目則進入具冪等性與批次上限的每分鐘對帳流程。[1] [2] [3]

歷史資料修復採取保守原則：只有具備精確鍵或安全唯一候選的成交才回填 `signalId`；其餘成交不猜測、不刪除，而是以 `signalId = NULL`、`linkage = orphan_trade` 及 `dataQuality = legacy_orphan_trade` 納入 journal 與資料品質報告。[1] [4]

> **最終資料語義：毛利、費用、資金費與淨已實現盈虧分欄保存。UI 以費用後淨值為主要 PnL；報告同時保留所有原始交易真相。**

## 二、原始根因與完成後狀態

| 原始根因 | 原始影響 | 完成後狀態 |
|---|---|---|
| 「全部策略」匯出被改成第一個策略 | 畫面有數百筆，匯出卻可能為 0 筆 | `strategyId` 改為可選；未指定時真正查詢所有策略 |
| 列表、預檢、CSV 與循環報告各自查詢 | 相同篩選得到不同筆數 | 全部改用 `tradeJournalQuery` 的同一契約與分頁批次來源 [1] |
| 0 筆仍生成表頭並提示成功 | 使用者下載到「假成功」空檔 | 預檢為 0 時禁止生成，畫面顯示零筆原因 [3] |
| 策略各自建立 signal／trade | 部分平倉缺 `signalId`、`orderId` 或 PnL | 所有生產交易寫入統一經 `tradeExecutionLedger` [2] |
| 交易所回應型別未完整保留結算資訊 | PnL、費用或成交真值在型別層遺失 | 共用結果包含成交價量、毛利、費用、資金費、淨值、來源與品質 |
| 晚到成交／結算沒有可靠補查 | 已執行平倉長期顯示破折號 | 建立每分鐘 Heartbeat 對帳，僅處理待補項目 [5] [6] |
| 舊資料以文字與時間形成斷鏈 | trade 已有數值但 signal 查不到 | 安全預演後回填唯一候選；無法確定者明確標記孤兒成交 |

## 三、共用交易真相契約

### 3.1 寫入順序

所有交易路徑改為由共用服務執行下列順序：先建立訊號／執行識別，再下單及保存原始回應，之後取得實際成交價量與結算欄位，最後以 `executionId`、交易所訂單／成交識別及資料庫唯一鍵完成冪等寫入。平倉資料尚未完整時，記錄為待對帳，而不是假填 `0`。[2]

| 契約欄位 | 規則 |
|---|---|
| `executionId` | 跨 signal、trade 與重試流程的穩定冪等識別 |
| `signalId` | 新成交必須關聯；歷史不確定成交允許保持 `NULL`，禁止猜測 |
| `orderId`／`exchangeTradeId` | 保存交易所真實識別並供精確對帳使用 |
| `requestedPrice`／`requestedSize` | 保存交易意圖，不冒充實際成交 |
| `price`／`size` | 保存交易所 fill；另以 `priceSource`／`sizeSource` 標示來源 |
| `grossPnl` | 毛利；舊資料缺少新欄位時安全回退既有 `realizedPnl` |
| `fee`／`fundingFee` | 分欄保存，不混入文字訊息 |
| `netRealizedPnl` | 費用後淨已實現盈虧；UI 與摘要以此為主要值 |
| `pnlSource`／`dataQuality` | 揭露交易所確認、計算、待對帳或歷史品質 |
| `reconciliationStatus` | `confirmed`、`pending`、`unresolved` 等可操作狀態 |

### 3.2 PnL 四態顯示

訊號日誌不再以單一破折號涵蓋所有情況。查詢端輸出 `known`、`pending`、`unresolved` 與 `not_applicable` 四態；前端分別顯示已確認數值、待對帳、歷史無法判定及不適用。開倉／加倉尚未形成已實現盈虧，失敗、拒絕與跳過亦不會被假造為 `0`。[1] [3]

## 四、歷史回填與孤兒成交

### 4.1 回填安全層級

| 層級 | 判定方式 | 實際處理 |
|---|---|---|
| 精確關聯 | 相同使用者、策略、交易所及 `orderId` | 回填 `signalId`／`orderId` 並保留稽核欄位 |
| 安全唯一候選 | 缺少 orderId，但相同策略、時間與方向，且只有唯一相容候選 | 回填並標記歷史匹配品質 |
| 證據不足 | 多候選、方向不一致或缺少足夠交易事實 | 不回填；以孤兒成交列納入 journal |

資料庫遷移、唯一鍵與索引透過兩個 Drizzle 遷移檔建立，並在套用前完成備份、預演與候選集合核對。[7] [8]

### 4.2 20415 範例的精確結果

歷史成交 `trade.id = 180001` 已由安全唯一候選回填至 `signal.id = 180001`。其交易真相不是單一數字，而是：

| 欄位 | 真實值 | 顯示／報告語義 |
|---|---:|---|
| 毛利 | `+1.56986000 USDT` | 報告 `grossPnl`，完整保留原始交易成果 |
| 手續費 | `-0.75652193 USDT` | 報告獨立費用欄 |
| 淨已實現盈虧 | `+0.81333807 USDT` | UI 主要 PnL 與摘要加總值 |
| 關聯 | `signal_id` | 已安全回填，並非時間查詢時動態猜測 |
| 品質 | `exchange_confirmed` | 表示交易所確認資料 |

因此，原先顯示 `—` 的根因已消除；同時避免把毛利錯當作扣費後淨利。journal 對舊欄位採 `COALESCE(grossPnl, realizedPnl)` 保留 `+1.56986`，而主要已實現盈虧採 `COALESCE(netRealizedPnl, realizedPnl)`。[1]

### 4.3 未解孤兒成交

真實資料庫只讀驗收中，使用者範圍共有 **343 筆 journal 列**，其中 **3 筆**為無安全候選的歷史孤兒成交。三筆均符合下列不變條件：

| 不變條件 | 驗收結果 |
|---|---:|
| `signalId` 必須為 `NULL` | 3／3 通過 |
| `linkage` 必須為 `orphan_trade` | 3／3 通過 |
| `dataQuality` 必須為 `legacy_orphan_trade` | 3／3 通過 |
| 可進入列表、預檢、批次匯出與資料品質工作表 | 通過 |
| 不得計入訊號總數或已執行訊號數 | 通過 |

孤兒成交使用負值的內部 journal row id 避免與 signal row key 衝突；真實 `tradeId`、訂單資訊、成交價量與資料品質仍完整保留。這個負值只存在於合併查詢的展示識別，不修改資料庫主鍵。[1]

## 五、訊號日誌與交易報告

### 5.1 唯一資料來源

`tradeJournalQuery` 以兩個分支組成同一個 `UNION ALL` 資料集：第一分支是 signal 及其明確關聯 trade，第二分支是 `trades.signalId IS NULL` 的孤兒成交。全域排序、分頁、總筆數、預檢統計與批次匯出都在同一衍生表上執行，避免畫面與下載再次分裂。[1]

真實 MySQL 煙霧測試亦驗證所有衍生表欄位均有唯一 alias；這避免 signal 與 trade 同時帶有 `id`／`status` 時造成 `Duplicate column name`，並鎖定實際資料庫方言行為，而不只依賴 mock 測試。

### 5.2 使用者互動

訊號日誌標題右上角提供單一 **「生成交易報告」** 按鍵。彈窗可沿用當前篩選或調整日期、策略、交易對、動作、狀態、來源與 PnL 狀態；預檢先顯示總筆數、日期範圍、四態 PnL 與估算檔案大小。若結果為 0，前端不會建立下載；大量資料則要求明確確認。[3] [9]

孤兒成交在表格中顯示「歷史成交」與「孤兒成交」徽章，展開列明確告知未偽造 signal 關聯；React row key 使用 `signalId` 或 `orphan-tradeId`，因此不會因 `signalId = NULL` 發生展開衝突。[9]

### 5.3 輸出格式

| 輸出 | 粒度與內容 |
|---|---|
| CSV | 規格化交易明細；標準 escaping；不把摘要混入資料列底部 |
| `交易明細` | signal、trade、execution、成交價量、毛利、費用、資金費、淨值、來源與品質 |
| `交易循環` | 開倉、加倉與多段退出配對；不完整循環保留原因 |
| `策略摘要` | 訊號、成交、勝負、毛利、費用、淨利及完整率；孤兒成交計入交易，不冒充訊號 |
| `資料品質` | 待對帳、歷史孤兒、缺失欄位、來源與錯誤原因 |

批次擷取採穩定游標及安全邊界，不再靜默截斷於舊有 10,000 筆上限。生成器及四工作表契約由單元測試固定。[10] [11]

## 六、延遲盈虧對帳

平台採用已確認的 **方案 B：即時寫入＋每分鐘批次對帳**。Heartbeat 透過受保護的 HTTP 端點觸發，不使用 Autoscale 環境中不可靠的程序內 `setInterval`。每批只讀取待處理候選，透過既有交易所 adapter 取得成交／結算真相，再以冪等條件更新原 trade；批次上限與錯誤隔離可避免單一帳戶或交易所故障阻塞其他策略。[5] [6]

> **安全邊界：對帳流程只讀取既有訂單／成交並更新資料庫，沒有建立訂單、修改策略或觸發下單的程式路徑。**

## 七、回歸防線

| 防線 | 覆蓋範圍 |
|---|---|
| 共用交易記錄測試 | 開倉、加倉、全平、部分平倉、冪等、費用與品質狀態 [12] |
| journal 契約測試 | 全策略、四態 PnL、分頁、孤兒成交 `NULL signalId` 與穩定 row id [13] |
| 報告生成測試 | CSV escaping、四工作表、循環配對、策略摘要與資料品質 [11] |
| Heartbeat 測試 | 一分鐘排程、端點、驗證與批次執行 [14] |
| 架構防線 | 阻止策略模組新增繞過共用 ledger 的直接交易寫入 |
| 真實 DB 只讀煙霧 | MySQL UNION alias、343 列、3 孤兒成交、毛利／淨利與實體報告生成 [15] |

## 八、真實資料與產物驗收

最近一次只讀煙霧驗收結果如下。此流程只查詢資料庫並在記憶體生成檔案，未匯入交易所下單服務，也未呼叫任何下單 API。[15]

| 驗收項目 | 結果 |
|---|---:|
| journal 總列數 | 343 |
| 未解孤兒成交 | 3 |
| 孤兒成交已知 PnL | 0；明確標示，不假填數字 |
| 淨已實現盈虧合計 | `41.98638719 USDT` |
| 20415 範例毛利 | `+1.56986000 USDT` |
| 20415 範例淨已實現盈虧 | `+0.81333807 USDT` |
| CSV 實際大小 | 150,287 bytes |
| XLSX 實際大小 | 105,197 bytes |
| Excel 工作表 | `交易明細`、`交易循環`、`策略摘要`、`資料品質` |

## 九、資料與操作安全

本工程未刪除任何 signal、trade、策略或交易所資料。歷史回填只更新具備可證明關聯的欄位；未解項目保持原始成交事實。資料庫異動均採 schema-first 遷移、事前備份與預演；生成報告及 smoke test 均為只讀流程。最終發布前仍須通過全量 Vitest、TypeScript、production build、桌面與行動版 UI、登入後流程及正式環境 console／network 檢查。

## 十、最終驗收矩陣

| 驗收條件 | 狀態 |
|---|---|
| 相同篩選下列表、預檢與匯出筆數一致 | 已通過真實 DB 煙霧 |
| 不指定策略時涵蓋全部現有與未來策略 | 已由共用可選 `strategyId` 契約實作 |
| 20415 成交同時保留毛利、費用及淨值 | 已通過 |
| 平倉顯示數值或明確待對帳／無法判定 | 已實作 |
| 開倉、加倉、失敗與跳過不假造 PnL | 已實作 |
| 0 筆禁止下載 | 已實作 |
| 大量資料採完整分頁批次並要求確認 | 已實作 |
| OKX／Bybit 共用成交真相與延遲對帳 | 已實作並有回歸測試 |
| 未解孤兒成交可稽核且不偽造 signal | 已通過真實 DB 煙霧 |
| 最終全量測試、建置、正式 UI 與發布 | 最終發布閘門驗收中 |

## References

[1]: ../server/services/tradeJournalQuery.ts "Signal 與 orphan trade 共用 journal 查詢"
[2]: ../server/services/tradeExecutionLedger.ts "全策略共用交易真相與冪等記錄服務"
[3]: ../server/routers/tradeJournal.router.ts "journal 列表、預檢與報告生成路由"
[4]: ./signal-export-pnl-analysis-notes.md "附件、程式與歷史資料交叉稽核筆記"
[5]: ../server/services/tradePnlReconciliation.ts "待對帳候選與交易所結算回填"
[6]: ../server/services/tradeReconciliationHeartbeat.ts "每分鐘 Heartbeat 排程契約"
[7]: ../drizzle/0018_minor_sheva_callister.sql "交易真相欄位、索引與約束遷移"
[8]: ../drizzle/0019_robust_prism.sql "後續一致性遷移"
[9]: ../client/src/pages/Home.tsx "訊號日誌、報告生成與孤兒成交介面"
[10]: ../server/services/tradeReportGenerator.ts "CSV 與 Excel 四工作表生成器"
[11]: ../server/services/tradeReportGenerator.test.ts "報告生成回歸測試"
[12]: ../server/services/tradeExecutionLedger.test.ts "共用交易記錄回歸測試"
[13]: ../server/services/tradeJournalQuery.test.ts "journal 與孤兒成交契約測試"
[14]: ../server/services/tradeReconciliationHeartbeat.test.ts "Heartbeat 排程回歸測試"
[15]: ../scripts/phase14_readonly_orphan_smoke.ts "真實資料庫只讀 journal／CSV／XLSX 煙霧驗收"
