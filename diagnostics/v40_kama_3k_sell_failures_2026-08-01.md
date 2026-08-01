# V4.0 KAMA+3K 動態馬丁連續賣出失敗唯讀診斷

> 本檔只保存可核實證據與推論邊界；本輪禁止送單、撤單、改單、平倉、修改策略或改寫交易資料。

## 截圖 1：訊號日誌

來源：`/home/ubuntu/upload/pasted_file_xMP3w6_image.webp`（2048×1346）。

畫面可核實共有 19 筆連續事件，時間由 `2026/8/1 04:14:35` 至 `05:02:25`。每筆策略名稱均為 `V4.0 KAMA+3K 動態馬丁策略（百分比控倉）- 導入`，來源均標為 `自動交易`，動作均為紅色 `賣出`，交易對均為 `BTCUSDT`，狀態均為 `失敗`。右側全部顯示 `0.00 USDT`、資料品質 `unknown` 與摘要 `交易執行失敗`。

可見價格依時間由舊至新為：`62970.2`、`62989.1`、`62989.1`、`62987.4`、`62974.3`、`62977.1`、`62973.9`、`62975.7`、`62972.7`、`62950.7`、`62956.8`、`62953.9`、`62970.5`、`62975.8`、`62946.0`、`62904.5`、`62909.2`、`62930.5`、`62895.9`。單看折疊列表無法看到 exchangeResponse、錯誤碼、orderId、clientOrderId、requestedSize、reduceOnly 或 posSide，因此目前不能把「失敗」直接判定為交易所拒單、未成交到期或數量歸零。

這 19 筆不是同一分鐘固定重試；相鄰間隔約 1–4 分鐘不等。畫面證明策略持續產生賣出意圖並被日誌標成失敗，但沒有證明是否曾向交易所送出有效訂單，也沒有證明其語義是開空、平多或減倉。

## 截圖 2：OKX 當前持倉，第 1 區

來源：`/home/ubuntu/upload/pasted_file_hTiQUs_image.png`（2230×706）；依 manifest 左至右切成四區，本段為第 1 區。

頁籤可核實 `當前委託 (0)`、`當前倉位 (2)`。兩列交易品種均為 `BTCUSDT 永續`、槓桿均為 `5x`，標記價格均為 `63,068.2`。第一列以綠色標示，持倉量 `0.0079 BTC`；第二列以紅色標示，持倉量 `0.1159 BTC`。這是交易所同時保留兩個方向腿的強烈畫面證據，符合 OKX long/short（雙向／hedge）持倉呈現，而不是單一淨持倉列；最終方向、均價與是否可被 V4.0 歸屬，仍需其餘分區及資料庫／API 證據核實。

### 第 2、3 區

第 2 區可核實第一列開倉均價 `63,014.4`、預估強平價 `108,750.6`、盈虧平衡價 `63,058.6`；第二列開倉均價 `63,015.5`、預估強平價 `108,750.7`、盈虧平衡價 `62,971.8`。結合第 1 區共同標記價 `63,068.2`，第一列價格高於其開倉均價、第二列價格亦高於其開倉均價。

第 3 區可核實第一列浮動收益 `+0.42 USDT (+0.42%)`，第二列浮動收益 `-6.11 USDT (-0.42%)`；兩列維持保證金率均顯示 `14,214.45%`。盈虧符號與價格關係相互驗證：第一列是多腿（價格上升獲利），第二列是空腿（價格上升虧損）。因此 OKX 畫面已可確定同一 BTCUSDT 永續帳戶同時持有 `long 0.0079 BTC` 與 `short 0.1159 BTC`，而非僅靠顏色推測。

### 第 4 區與全景複核

第 4 區可核實第一列保證金 `99.65 USDT`、第二列保證金 `1,461.93 USDT`，兩列均為 `全倉`；右側各自提供 `平倉` 與 `市價全平`。全景原圖複核後，四區欄位由交易品種、持倉量、標記價、開倉均價、預估強平價、盈虧平衡價、浮動收益、維持保證金率、保證金到平倉操作均連續一致，重疊邊界沒有錯列。

兩腿名義價值依畫面數量與標記價粗算約為：多腿 `0.0079 × 63,068.2 ≈ 498.24 USDT`，空腿 `0.1159 × 63,068.2 ≈ 7,309.60 USDT`；空腿約為多腿的 `14.67` 倍，淨方向仍明顯偏空。此計算只用於理解畫面風險比例，不能替代交易所持倉 API 的合約面值、費率與帳戶真相。

## 目前僅可提出的初步假說

第一優先需檢查 V4.0 的 `賣出` 在雙向持倉模式下究竟被封印為 `sell + posSide=short`（開／加空）或 `sell + posSide=long + reduceOnly`（平多）。若策略意圖是平掉畫面中的 `0.0079 BTC` 多腿，但下單缺少或錯用 `posSide=long`／`reduceOnly`，OKX 可拒絕；若意圖是繼續開空，則需檢查三模式 runtime gate 是否因既有相反腿、deployment ownership 或單倉排他規則而 fail-closed。另一種可能是 Maker-First 正常未成交至 TTL 後回傳 `success=false`，但前端把 `ENTRY_EXPIRED`／`MAKER_EXPIRED` 粗略顯示為「交易執行失敗」。上述均為待驗證假說，不是結論。

## 資料庫與事件鏈核實（已確認）

### 策略真相

策略 ID 為 `120011`，API key ID 為 `1`，交易所 `okx`，交易對 `BTCUSDT`，策略 key `20415_KAMA_MARTIN_V35`。目前資料庫配置為 `enabled=1`、`activationState=LEGACY`、`preflightStatus=NOT_RUN`、`executionMode=SINGLE_EXCLUSIVE`，但 `deploymentKey=null`、`executionPolicy=null`；方向 `both`、策略訂單類型 `limit`、自動交易、USDT 倉位模式、5x 槓桿、最大 20 層。這代表它仍是未完成新部署治理回填的舊策略，並非已通過新版 preflight 的正式部署。

目前 `martinState` 顯示一個之後建立的多腿：`isLong=true`、`entryTrendBull=true`、`currentLayer=1`、`totalSize=0.0079 BTC`、`avgPrice=63014.4`，與 OKX 截圖第一列多腿完全吻合。策略狀態只追蹤這個多腿，沒有追蹤同帳戶仍存在的 `short 0.1159 BTC`。

### 04:14:35–05:02:25（香港時間）19 筆「賣出失敗」

資料庫 UTC 時間範圍為 `2026-07-31 20:14:35` 至 `21:02:25`，共 19 個 signal、19 個 trade，全部是 `sell`、`triggerSource=martin_add_layer`、`reduceOnly=false`、`tradeStatus=failed`。這些不是平多，而是沿用當時空頭趨勢的**第 2 層加空意圖**。每次都有不同 `executionId` 與 `cycleId`，證明監控器在每輪重新建立新交易循環，未對同一未完成 layer intent 做冪等鎖定。

前端的 `0.00 USDT / unknown / 交易執行失敗` 是資訊遺失後的粗略投影。19 筆 signal 中只有 3 筆保存 `orderId`，所有 `exchangeResponse` 為空；19 筆 trade 均沒有 `filledAt`、沒有 `positionSide`，卻把 `priceSource` 與 `sizeSource` 寫成 `exchange_fill`。這是資料品質標籤錯誤：未獲完整成交確認卻標成交易所成交來源。

### Maker-First 真實結果

擴大至 UTC `20:10:43–21:02:25`，`order_policy_events` 有 20 個 policy run、133 個 append-only 事件。**20/20 均被 OKX 接受**，不是一般拒單；16/20 出現 `MAKER_PARTIAL`，每個最多成交 `0.001 BTC`，各 run 最大成交量合計 `0.016 BTC`；沒有任何 `MAKER_FILLED`。17 個 run 最終為 `ENTRY_EXPIRED / MAKER_EXPIRED`，3 個 run 為 `CANCEL_NOT_CONFIRMED / FAILED`。每次要求約 `0.0010716–0.0010732 BTC`，部分成交 `0.001 BTC` 後只剩約 `0.0000716–0.0000732 BTC`，剩餘量落入極小尾數；政策最終回傳 `success=false`，上層遂把整筆 trade 標為失敗。

因此核心不是「一直完全賣不出去」，而是：**多數掛單已部分賣出 0.001 BTC，但尾數未成交／撤單未完全確認；上層忽略 partial fill、不推進馬丁層狀態，20 秒後再次重送同一第 2 層，造成實際空倉累積，同時 UI 全部顯示失敗。** 這是 P0 級成交真相與狀態機錯位。

其中 3 筆保存 order ID 的紀錄是：signal `270621`／OKX `3792592141426343936`（UTC 20:41:26）、signal `270622`／OKX `3792599456091193344`（UTC 20:45:04）、signal `270628`／OKX `3792634373336449024`（UTC 21:02:25）。三者 DB trade 均為 failed、無 filledAt，但事件鏈說明它們已被交易所接受；不能把 signal/trade 的 failed 等同於「沒有成交」。

### 21:07:19 UTC 的假成功平倉

signal `270629` 由 `trailing_take_profit` 觸發，payload 要求平掉 `0.1159 BTC` 空腿。資料庫卻在**沒有 signal orderId、沒有 trade orderId、成交價為 0、同時段沒有任何 order_policy_event**的情況下，把它寫成 `signal=executed`、`trade=filled`、`filledAt=21:07:19`、`dataQuality=exchange_confirmed`、`reconciliationStatus=confirmed`，訊息為「平倉已執行」。OKX 截圖仍有 `short 0.1159 BTC`，與這筆假成交紀錄直接矛盾。這不是交易所已平後又開回的既有證據；目前證據更符合「本地把未實際送出／未確認的 close 錯標成功並清空狀態」。

## 程式路徑初步核對

`server/services/v35Monitor.ts` 的監控週期為 20 秒。加倉路徑在 `shouldAddLayer` 後每輪直接建立 `adapter.placeOrder`；方向由 `state.entryTrendBull ? buy : sell` 決定，reason code 是 `v35_monitor_martin_layer_${nextLayer}`。trade 在任何結果下都先寫入；只有 `orderResult.success=true` 才解析 fill 並更新 `currentLayer/totalSize/avgPrice`。目前程式沒有在 `success=false` 但 `filledSize>0` 時吸收部分成交，也沒有以「策略＋layer＋方向」鎖住未完成 intent，因此與上述 16 次部分成交後重送完全吻合。

### 假成功平倉的完整程式根因（已證實）

`executeFullClose()` 只以 `result.success` 判定 `positionClosed`，不要求 order ID、非零成交量／成交價，也不做平倉後持倉再查詢。V4.0 的 `closePositionSmart(BTCUSDT, short)` 經 Maker-First facade 進入 `executeClosePositions()`：它先呼叫 OKX `getPositions(BTCUSDT)`，但 OKX adapter 回傳的 `Position.symbol` 是原始 `p.instId`，即 `BTC-USDT-SWAP`；facade 以移除連字號後的字串與輸入 `BTCUSDT` 嚴格比較，得到 `BTCUSDTSWAP != BTCUSDT`，因此把真實 short 腿錯誤過濾掉。

其後 `aggregateCloseResults([])` 明確回傳 `success:true`、`executionStatus:"filled"`、`skipped:"NO_OPEN_POSITION"`、空 `childResults`。這個「空集合成功」被 V35 monitor 當成真平倉，遂寫出 orderId=null、filledPrice=0 的 `exchange_confirmed` filled trade，並清空 martinState。**所以 0.1159 BTC 空腿一直留在 OKX，不是畫面延遲，而是系統根本沒有送出平倉單。** 這也解釋了之後策略又能建立並追蹤新的 0.0079 BTC 多腿，最終在同一 OKX 雙向帳戶同時保留一個未歸屬空腿與一個新多腿。

### V4.0 賣出方向與三模式 Gate（已證實）

V35 monitor 的第 2 層加倉以 `sell`、`reduceOnly=false` 呼叫 runtime-guarded adapter。`executionModeEngine` 把 sell 標準化為 `OPEN_SHORT`／`targetSide=SHORT`；策略是 `LEGACY + SINGLE_EXCLUSIVE`，因此決策為 `S1_LEGACY_PIPELINE_APPROVED`。runtime adapter 將 `posSide=short` 補入後，再交給 Maker-First facade；OKX adapter 最終送出 `side=sell`、`posSide=short`、`reduceOnly` 不啟用的 post-only limit。因此 19 次並非平多參數錯誤，也不是 S1 gate 拒絕；20/20 policy runs 被 OKX 接受已與此程式路徑交叉驗證。

### 為何部分成交仍沒有層級（已證實）

`martingalePositionLedger.resolveMartingaleCycle()` 與 `appendMartingaleExecution()` 均在 `execution.status !== "filled"` 時直接返回。Maker-First 的 16 次 run 雖各有 `filledSize=0.001 BTC`，但只要尾數未全成，V35 便把整筆 status 寫為 failed；所以逐層 ledger 完全忽略這些真實 partial fills。這是「交易所空倉增加、馬丁層數不增加」的直接資料層原因。

此外，V35 先呼叫 `tradeFillRecordFields()`，再把其輸出傳入 `recordExistingTradeExecution()`。相容入口又以 `exchangeResult.filledSize ?? input.size` 推斷 filledSize；對完全未成交 run，`input.size` 已回退為請求量，仍被當作非空 filledSize，故 failed trade 會錯標 `sizeSource=exchange_fill`。這些 trade 不可用來代表實際成交數量，必須以 order-policy 事件或交易所 fill truth 對帳。
