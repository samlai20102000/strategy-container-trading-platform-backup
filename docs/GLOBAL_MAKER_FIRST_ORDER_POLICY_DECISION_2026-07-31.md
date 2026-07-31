# 全系統 Maker-First 限價執行政策：根因、方案與決策報告

> **重要風險聲明：**以下是交易系統工程與風控分析，不保證降低總交易成本或避免損失。Maker-only 可以避免該筆訂單立即成為 taker，但不能保證成交；任何「保證 maker」與「保證立刻成交」的要求在撮合機制上互相衝突。最終政策由使用者決定並承擔交易風險。

## 一、結論先行

本次問題不是單一原因，而是三個層次同時存在：

| 層次 | 已核實事實 | 結論 |
|---|---|---|
| OKX 截圖 | 四筆手續費分別約為成交價值的 **0.05005%**，不是 0.5% | 四筆均呈現同一 taker 級別費率；不能把小數點誤讀為 0.5% |
| 訂單語義 | 兩筆「賣出開空」在 OKX 畫面明示「市價」；兩筆「買入平空」有委託價，但委託價會立即穿越委託簿 | 普通限價單仍可能立即成交並成為 taker；只有 post-only 才是 maker-only |
| 系統執行 | 資料庫四個策略目前均保存 `orderType=limit`，但 V4.0／V3.5、20415、Rainbow 等執行分支仍硬編碼 `market`；部分平倉先發普通 limit，再逾時改 market | UI／DB 設定未被所有執行路徑尊重，且目前的「limit」也沒有 maker 保證 |

**針對截圖中的 V4.0 KAMA+3K 動態馬丁策略，可以直接對上程式：**開倉分支在 [`executor.ts`](../server/services/executor.ts) 以 `orderType: "market"` 硬編碼送單；平倉分支呼叫 OKX `closePositionSmart`，先送普通限價，若未成交會撤單後用市價補平。這正好解釋畫面中「開空＝市價」及「平空＝有委託價但仍按 taker 收費」的組合。

## 二、圖片逐筆核對

| 時間 | 動作 | OKX 畫面委託／成交資訊 | 成交價值 | 手續費 | 畫面實際費率 |
|---|---|---:|---:|---:|---:|
| 15:44:08 | 買入平空 | 委託 63,891.7；成交均價 63,875.6 | 293.53 USDT | 0.14691388 USDT | 0.05005% |
| 15:30:34 | 賣出開空 | 市價；成交均價 63,932 | 293.79 USDT | 0.1470436 USDT | 0.05005% |
| 14:47:50 | 買入平空 | 委託 64,185.6；成交均價 64,176.1 | 294.91 USDT | 0.14760524 USDT | 0.05005% |
| 13:48:40 | 賣出開空 | 市價；成交均價 64,237.8 | 295.19 USDT | 0.14774673 USDT | 0.050051% |

兩筆平空都是**買入限價高於實際成交價**。買入限價代表「最高願意支付價格」；若目前賣盤低於該上限，訂單會立即吃掉賣盤，雖然 API 的 `ordType` 是 limit，撮合角色仍是 taker。因此「限價」不等於「maker」。

策略設定截圖在擷取當下，欄位本身顯示「市價單」，展開選單的勾號亦在「市價單」；「限價單（用訊號價格）」只是游標高亮。這只代表**截圖當刻**尚未顯示限價為已選值，不能排除之後已切換並保存。唯讀資料庫查詢則確認，目前四個策略均已保存 `orderType=limit`。

## 三、已核實的程式根因

### 3.1 普通限價沒有 maker-only 保護

OKX 一般下單目前只是把 `params.orderType` 映射為 `ordType`，限價時加入 `px`；沒有 `post_only`、maker-only 時效、client order id 或被動價格保護。參見 [`server/exchanges/okx.ts`](../server/exchanges/okx.ts)。Bybit 同樣只映射 `Market`／`Limit` 並加入價格，沒有 `PostOnly`。參見 [`server/exchanges/bybit.ts`](../server/exchanges/bybit.ts)。

OKX 官方文件說明，費率按實際 maker／taker 角色計算；`Post Only` 才能保證訂單不立即吃單，若會立即撮合，交易所會取消該單。[1][2]

### 3.2 多個現有策略硬編碼 market

服務層搜尋共找到 **51 個** `orderType: "market"` 命中，包含交易請求與交易紀錄。已確認的實際送單路徑包括：

| 路徑 | 開倉／加倉 | 平倉／風控 |
|---|---|---|
| 20415 七彩虹馬丁 | 硬編碼 market | smart close／其他 market 記錄路徑 |
| V4.0／V3.5 KAMA+3K | 硬編碼 market | `closePositionSmart`：普通 limit 後可 market fallback |
| Rainbow Trend Ladder | 硬編碼 market | market／adapter close |
| V5.0、V2.5、V7.0 等內建分支 | 硬編碼 market | 多個 market close |
| V6.1 | 開倉有讀取 `strategy.orderType` | 平倉仍有 market；limit 也不是 post-only |
| KRM S1／M2／H3 | 開倉與腿級平倉均硬編碼 market | market |
| V4.0 初始倉服務 | [`positionManager.ts`](../server/services/positionManager.ts) 硬編碼 market | 不適用 |
| 手動平倉／Martin reset／Emergency close | 不適用 | [`server/routers.ts`](../server/routers.ts) 有直接 market 或 smart close |
| runtime guarded advanced close | 不適用 | [`runtimeGuardedAdapter.ts`](../server/exchanges/runtimeGuardedAdapter.ts) 逐腿直接 market |

### 3.3 中央 guard 只授權，不規範訂單政策

目前 `runtimeGuardedAdapter` 會驗證三模式授權、腿級數量與 reduce-only，但一般 `placeOrder` 最後仍把呼叫者的 `orderType` 原樣送給 adapter；進階平倉甚至直接寫死 market。只逐個修策略會留下未來策略及手動／風控入口再次繞過的風險。

### 3.4 現有 smart close 會明確回退市價

OKX `closePositionSmart` 的現行流程是：送普通 limit、等待、查詢狀態、取消剩餘量，最後對剩餘數量發 `ordType: "market"`。Bybit 的 `closePositionSmart` 目前直接委派到 market `closePosition`。所以「所有平倉保持限價」在現行架構中沒有成立。

## 四、不可迴避的撮合取捨

| 目標 | 可否同時保證 | 原因 |
|---|---|---|
| 保證 maker | 可以，用 post-only | 若會立即成交，交易所取消而不是成交 |
| 保證立即成交 | 只能用 market 或可穿價的 aggressive limit | 會吃掉現有流動性，通常是 taker |
| 保證 maker 且保證立即成交 | **不可能** | 委託簿當下可能沒有人主動來吃你的單 |

因此未成交方案的核心不是「如何兩者都保證」，而是明確決定：**哪些情境寧可不成交，哪些緊急風控情境允許支付 taker 費換取退出確定性。**

## 五、建議的中央架構

### 5.1 策略只產生交易意圖

未來所有策略只輸出 `OrderIntent`：方向、數量、目標價格、是否 reduce-only、原因、風險級別、cycle／leg。策略不得直接指定 exchange `market`／`limit`，也不得直接取得原始 adapter。

中央 `OrderExecutionPolicyService` 負責：

1. 讀取全域政策及策略例外，但例外不得放寬為未授權 market。
2. 取得 best bid／ask 與 tick size，計算不穿價的 maker-safe 價格。
3. 對 OKX 使用 `post_only`，對 Bybit 使用 `timeInForce=PostOnly`。
4. 以唯一 client order id 建立冪等訂單。
5. 持久化 intent、每次 submit、live、partial fill、cancel、reprice、fill、expire、failure。
6. 撤單確認後才重掛，任何時刻每個 intent 只允許一張 live child order。
7. 重啟後從資料庫恢復未完成 intent，不依賴記憶體 `setTimeout`。

### 5.2 Maker-safe 價格

| 動作 | 初始被動價格 | 風險界線 |
|---|---|---|
| 買入開倉／加倉 | best bid；不得高於策略最高接受價 | 不穿 best ask |
| 賣出開倉／加倉 | best ask；不得低於策略最低接受價 | 不穿 best bid |
| 賣出平多 | best ask 或不低於策略最低退出價 | `reduceOnly=true`、腿級數量上限 |
| 買入平空 | best bid 或不高於策略最高退出價 | `reduceOnly=true`、腿級數量上限 |

若 post-only 被交易所取消，必須重新讀取 order book 並重新計算，不得悄悄改成普通 limit 或 market。

### 5.3 未成交、部分成交與重掛

建議初始參數如下，之後可在 UI 調整：

| 類型 | 單次 TTL | 最大重掛 | 重掛方式 | 超限結果 |
|---|---:|---:|---|---|
| 開倉／加倉 | 8 秒 | 3 次 | 每次撤單確認後，重新掛 best bid／ask | 取消剩餘量，標記 `ENTRY_EXPIRED`；絕不 market |
| 正常止盈／策略平倉 | 5 秒 | 12 次 | 被動跟價，剩餘量繼續 reduce-only | 進入 `PENDING_CLOSE`、高優先告警、持續由持久 worker 管理 |
| 風險／止損／Kill Switch | 2 秒 | 2 次 post-only | 先嘗試 maker-only | 依使用者決定：嚴格不 market，或明確 emergency taker fallback |

部分成交只重掛**剩餘量**；每次重掛前重新核對交易所真實持倉，避免超平、反向開倉或重啟後重複送單。開倉訊號超過有效時間應取消，不應無限追價。

### 5.4 持久化執行環境

秒級撤單／重掛不能可靠依賴 Autoscale 內的常駐記憶體 timer，因為實例可縮至零或重啟。建議使用**Reserved／always-on worker**管理 live order；資料庫是唯一狀態來源，Heartbeat 只做恢復掃描與告警。若維持 Autoscale，應避免承諾 2–8 秒 TTL，且只能接受較慢、較不確定的恢復頻率。

### 5.5 阻止未來策略繞過

1. 原始 `ExchangeAdapter.placeOrder` 改接收品牌化 `AuthorizedOrderRequest`，只有中央政策服務能建立。
2. `closePosition`／`closePositionSmart` 不再暴露給策略與 router；手動、風控、KRM 也建立相同 intent。
3. 架構測試掃描 `server/services`、`server/routers*`：除中央模組與 adapter 內部外，發現 `.placeOrder(`、`closePosition(`、`orderType: "market"` 即失敗。
4. 新策略模板只提供 `emitOrderIntent`。
5. UI 把「限價單」改成不含糊的選項：`Maker-only（Post-only）`、`普通限價（可能 Taker）`；market 只在經批准的緊急政策中出現。

## 六、三個可選政策

| 方案 | 開倉／加倉 | 正常平倉 | 緊急止損／Kill | 優點 | 主要風險 |
|---|---|---|---|---|---|
| **A. 嚴格 Maker-only** | Post-only | Post-only，持續重掛 | 仍只 Post-only | 不會主動送 taker | 極端行情可能長時間無法平倉，虧損可遠高於手續費 |
| **B. 分層 Maker-first（建議）** | 永不 market | Post-only，長時間持續重掛 | 先 post-only；超時後僅在已批准的 emergency gate 使用 taker | 平常控制費用，真正風控事件保留退出能力 | 緊急時仍可能有 taker 費與滑價 |
| **C. 普通限價追價** | 普通 limit | 普通 limit | aggressive limit | 成交率較高、修改較小 | 仍會穿價成為 taker，不能達成 maker 費率目標 |

**我的工程與風控建議是方案 B。** 開倉／加倉沒有必要為了成交而 market；正常止盈可耐心 maker-only；但真正的止損、最大日虧、Kill Switch 若永不允許 taker，可能失去風控功能。Emergency fallback 必須是獨立、預設關閉、明確授權、完整告警與稽核的政策，不能由策略自行決定。

## 七、請使用者決定的項目

請回覆以下其中一組：

1. **方案 A：任何情況永不市價／永不 taker fallback。** 接受緊急平倉可能長時間未成交。
2. **方案 B（建議）：**開倉、加倉、正常平倉全部 post-only；只有止損、最大日虧及 Kill Switch 在「2 秒 × 2 次 post-only 仍未成交」後，可對剩餘量做一次明確記錄的 taker emergency fallback。
3. 自訂：請指定 emergency 等待秒數、重掛次數，以及哪些風控原因可 fallback。

另請確認是否同意將生產託管升級為 Reserved／always-on，以支援秒級撤單、重掛及重啟恢復。若不同意，實作可完成，但不能誠實保證 Autoscale 環境下的秒級處理時效。

在取得上述決定前，不會修改目前實盤送單行為，也不會送出任何交易。

## 參考資料

[1]: https://www.okx.com/en-us/help/trading-fee-rules-faq "OKX Trading Fee Rules FAQ"
[2]: https://www.okx.com/help/x-basic-order-types "OKX Basic Order Types"
[3]: https://www.okx.com/docs-v5/en/ "OKX API Guide"
