# 20415 七彩虹／V4.0 KAMA 與 OKX 盈虧一致性最終修復報告

**日期：** 2026-07-25  
**作者：** Manus AI  
**範圍：** 20415 七彩虹馬丁、V4.0 KAMA+3K 動態馬丁，以及共用交易執行、持倉、盈虧與交易歷史管線

> **安全說明：** 本輪排查與驗證沒有手動觸發新訊號、下單、平倉、啟停策略或修改 OKX 帳戶模式。資料庫與交易所查詢均以唯讀核對為主；唯一資料庫變更是新增非破壞性的成交來源稽核欄位。

## 執行摘要

三個問題已定位為兩類不同事項。第一，20415 的「手動觸發信號生成」不是無條件下單；該按鈕會呼叫與自動輪詢相同的 20415 伺服器決策核心。此次成功開出空單，是因為已收盤 M30 K 棒同時符合 **七線斜率全部向下、前後兩根的七線排名完全一致、沒有交叉、沒有同值、方向允許做空、空倉及各項鎖均放行**。正式訊號 reason 為「七線全數向下且前後排名完全一致，建立空單底倉」，因此這次開倉屬於策略規則命中，不是按鈕繞過策略。

第二，20415 與 V4.0 在平台顯示盈利、OKX 顯示虧損，是同一個共用顯示旁路造成。舊策略卡片用公共 ticker 的 **last 成交價**，再以本地均價和數量重算毛浮盈虧；OKX 持倉頁則使用該帳戶持倉快照的 **mark price 與 unrealized PnL**。兩個價格來源與時間戳不同，恰好分處 Short 開倉均價兩側，於是盈虧符號相反。OKX 官方也明確以 mark price 計算 USDT 保證金永續合約的未實現盈虧，並以 PnL 除以開倉保證金計算 PnL ratio。[1]

本次修復已將策略卡片、首頁持倉總覽與獨立持倉頁統一接到同一筆交易所帳戶持倉快照；同時把所有主要執行與監控旁路的交易歷史改為 **交易所 filled price／filled size 優先**，並在交易所未回傳成交明細時明確標記回退來源。共享帳戶合併倉位不再被冒充為某一策略的精確盈虧。

| 使用者問題 | 最終判定 | 已完成處理 |
|---|---|---|
| 20415 一按後為何成功開倉 | 符合七線全向下、前後排名一致、無交叉等 Short 首倉條件 | 已核對正式訊號、成交及後續 Bar-Lock；保留策略核心原邏輯 |
| 20415 平台盈利、OKX 虧損 | 平台舊卡片用 last price，本地重算；OKX 用 mark price／upl | 策略卡片改用交易所持倉快照真值 |
| V4.0 出現同樣差異 | 與 20415 相同的共用 UI 資料來源錯誤，不是 V4.0 多空公式顛倒 | 首頁、策略頁、持倉頁全部統一；V4.0 執行與監控旁路同步修復 |
| 交易歷史與真實成交不一致 | `trades.price/size` 部分路徑保存訊號價／請求量 | 全系統改為 fill 優先並新增來源稽核欄位 |

## 一、20415 手動按鈕為何能開出空單

本次策略實例為 `strategyId=90003`，策略名稱「20415七彩虹馬丁策略－導入」，交易所 OKX，交易對 BTCUSDT，部署倉位 300 USDT、5x、雙向、M30。前端按鈕呼叫 `generateTradingSignal(..., { withReason: true })`；若核心回傳 HOLD，系統只會保存或顯示觀望原因，不會建立委託。只有核心回傳 buy、sell 或 close，才會以 `source=manual` 建立正式訊號並進入與自動輪詢相同的執行器。

### 已核對的正式事件

| 欄位 | 核對結果 |
|---|---|
| 訊號 | `signals.id=90005` |
| 時間 | 2026-07-25 08:31:14（資料庫時間；對應畫面本地下午 4:31） |
| 動作 | `sell`，建立 Short 第 1 層 |
| 已收盤 K 棒 | M30，`barTimestamp=1784966400000` |
| 策略評估價 | 63,961.4 |
| 核心封印 | `rainbow20415Decision=true`、`confidence=1` |
| 正式 reason | **七線全數向下且前後排名完全一致，建立空單底倉** |
| OKX 實際成交 | 0.0046 BTC，均價 64,058.4 |
| OKX orderId | `3773728616103051264` |

策略評估價與實際成交均價不同是正常的執行滑價／委託成交結果差異；真正持倉均價與數量已採用 OKX 成交回覆，而不是把 63,961.4 當成成交價。

### Short 首倉完整通過條件

| 關卡 | 必要條件 | 本次結果 |
|---|---|---|
| 身分與配置 | 登入使用者可存取策略及 API 金鑰；快照配置可正規化 | 通過 |
| 持倉狀態 | 本地狀態為空倉，不在持倉盲人管理模式 | 通過 |
| K 棒資料 | 至少 `max(七線週期)+1` 根有效已收盤 M30 K 棒 | 通過 |
| 重複掃描 | 當前 M30 K 棒尚未完成掃描，且未被 Bar-Lock 鎖定 | 通過 |
| 重入冷卻 | 不在尚未到期的無縫重入冷卻 | 通過 |
| 七線有效性 | 當前及前一根七線值完整、沒有同值，排名可判定 | 通過 |
| 趨勢 | 七條線的 `current - previous` 全部小於 0 | 通過，`slopeDirection=DOWN` |
| 無交叉 | 當前七線排名與前一根排名逐項完全一致 | 通過，`noCross=true` |
| 方向 | 策略方向不是 `long only` | 通過，策略為 `both` |
| 倉位與規格 | 部署倉位、價格有效，數量通過交易所最小量與精度正規化 | 通過 |
| 交易所確認 | OKX `placeOrder` 成功並回傳成交量、成交均價 | 通過 |

20415 核心會把七線 current／previous 值、slopes、前後排名、方向及 `noCross` 保存到 `rainbow20415Runtime`，同時把 bar timestamp、reason 與核心封印帶入訊號。預設配置為 EMA 5／8／13／21／34／55／89，但正式判斷永遠使用該策略快照中的 `Lines` 配置，不以預設值覆蓋使用者快照。

此次開倉後的行為亦與規則一致：`signals.id=90006` 在 08:43:52 由風控監控按標記價 63,993 判定 5x 空倉盈利約 +0.51%，達到 0.5% 止盈後成功平倉；其後 `signals.id=90007` 在同一 M30 bar 再次出現 sell 條件，但被 Bar-Lock 正確攔截。這證明「進場、止盈、同 bar 防重複」三段鏈路相互一致。

> **策略判定：** 就本次證據而言，20415 沒有因手動按鈕而繞過進場條件，也沒有把 Long／Short 方向判反。真正需要修復的是盈虧顯示與交易歷史的資料來源，而不是改動七彩虹進場核心。

## 二、為何平台顯示盈利而 OKX 顯示虧損

OKX 官方定義 USDT 保證金永續／期貨的未實現盈虧為：Long 使用「mark price − avg. open price」，Short 使用「avg. open price − mark price」，再乘以合約面值、合約數與乘數；PnL ratio 則為 PnL 除以初始／開倉保證金。[1]

> “USDT-margined futures/perpetual swap P&L of short positions = face value × |number of contracts| × multiplier × (avg. open price - mark price).” — OKX, *Futures PnL calculation rules*[1]

兩張策略卡片的舊公式本身沒有把 Short 寫反；真正問題是它輸入了與 OKX 不同的價格。圖片中的數字可精確重算如下。

| 策略與來源 | 均價 | 使用價格 | 數量 | Short 毛浮盈虧 | 顯示結果 |
|---|---:|---:|---:|---:|---:|
| 20415 舊平台卡片 | 64,058.4 | last 63,974.5 | 0.0046 BTC | `(64,058.4−63,974.5)×0.0046 = +0.38594` | +0.39 USDT／+0.65% |
| 20415 OKX | 64,058.4 | mark 64,091.6 | 0.0046 BTC | `(64,058.4−64,091.6)×0.0046 = −0.15272` | -0.16 USDT／-0.26% |
| V4.0 舊平台卡片 | 63,982.4 | last 63,936.4 | 0.0004 BTC | `(63,982.4−63,936.4)×0.0004 = +0.01840` | +0.02 USDT／+0.36% |
| V4.0 OKX | 63,982.4 | mark 64,072.3 | 0.0004 BTC | `(63,982.4−64,072.3)×0.0004 = −0.03596` | -0.04 USDT／約 -0.71% |

20415 的平台 last price 比 OKX mark price 低 117.1 USDT/BTC；V4.0 則低 135.9 USDT/BTC。對 Short 而言，last price 位於均價下方會顯示盈利，mark price 位於均價上方會顯示虧損，因此兩者符號相反。這是 **資料來源與快照時間分叉**，不是算術精度、槓桿或方向公式錯誤。

OKX 的盈虧平衡價還可能反映手續費等成本；平台舊卡片只算價格差毛浮盈虧，不能把它稱為扣除所有費用後的淨利。修復後介面以交易所 `upl`／`uplRatio` 為第一真相來源，避免自行混合 mark price、last price、均價、數量與保證金。OKX API 的帳戶持倉資料需使用私有讀取權限，並透過認證請求取得。[2]

## 三、已落地的全系統修復

### 1. 單一交易所持倉真值契約

後端新增受保護、唯讀的策略持倉快照服務。每個使用者的策略按 API 金鑰批次查詢交易所持倉，並在同一快照中保留交易所持倉量、方向、均價、mark price、unrealized PnL、原生 PnL ratio、槓桿、持倉保證金與交易所更新時間。OKX 與 Bybit adapter 均正規化到同一型別，前端不再自行從公共 ticker 重建「交易所盈虧」。

| 歸屬狀態 | 判定 | 介面行為 |
|---|---|---|
| `exact` | 同一帳戶、標準化交易對及方向只有一個候選策略，且本地量／均價與交易所持倉吻合 | 直接顯示交易所 `upl`、`uplRatio`、mark price、margin 與同步時間 |
| `account_aggregate` | 多個策略共用同一帳戶、交易對及方向，或量／均價不足以證明唯一歸屬 | 明確標示「帳戶合併持倉」；只顯示可解釋的策略毛浮盈虧估算，不把整筆帳戶 UPL 重複歸給每個策略 |
| `unavailable`／`stale` | 無交易所持倉、憑證或網路錯誤、欄位不完整、快照過期 | 顯示不可用或過期，不再靜默回退成 public last price 冒充 OKX 數值 |

這項設計處理了交易所 API 的客觀限制：OKX 對同一帳戶、同一合約、同一方向通常只提供合併持倉，不知道平台內部的策略 ID。若兩個策略共享同一 API 金鑰、BTCUSDT 與 Short 方向，系統不能誠實地把帳戶總 UPL 拆成兩筆「精確策略盈虧」。目前的 `account_aggregate` 是防止重複計算與誤歸屬的安全答案；若業務上要求每個策略都與 OKX 一對一精確，應為策略使用不同子帳戶或不同 API 金鑰。

### 2. 三個主要介面統一

| 介面 | 修復內容 |
|---|---|
| 策略管理頁 `Strategies.tsx` | 移除以 `livePriceMap + martinState` 自行重算浮盈虧的旁路；新增來源、歸屬、同步時間、交易所原生盈虧與不可用狀態 |
| 首頁 `Home.tsx` | 使用交易所原生 `uplRatio`；只對已確認的策略 ID 顯示策略歸屬；帳戶合併倉位禁止被誤當成單一策略平倉 |
| 持倉頁 `Positions.tsx` | 與首頁採同一安全歸屬及交易所真值；持倉詳情顯示 mark price、margin、更新時間與成交來源 |

### 3. 成交真值與交易歷史修復

新增共用 `tradeFillTruth` 解析器，所有主要開倉、加倉、部分平倉、全平倉與風控平倉路徑都採用「交易所回傳的 filled price／filled size 優先；只有缺失時才使用委託價格／請求量」的契約。資料庫交易表新增成交價與成交量來源稽核欄位；歷史資料使用安全的舊資料標記，不被誤稱為已核實的交易所 fill。

修復範圍包含通用 executor、20415、V3.5／V4.0、V5.0、V6.1、V7.0、position manager 及 risk monitor。V5.0／V6.1 的部分與全平倉亦新增成功閘門：**交易所未確認平倉成功時，不再清空本地狀態、停用策略或顯示已獲利平倉**。風控平倉同時修正空倉應使用買單關閉，而不是一律賣出。

### 4. 資料庫遷移

遷移 `drizzle/0016_peaceful_hardball.sql` 只新增成交來源稽核欄位，不刪除或重寫既有交易資料。遷移已審核並成功套用；TypeScript schema、Drizzle metadata 與實際資料庫保持同步。

## 四、驗證結果

| 驗證 | 結果 |
|---|---|
| TypeScript 全量檢查 | 通過，無型別錯誤 |
| 完整 Vitest | **40 個測試檔通過、1 個依既有條件跳過；498 項通過、4 項跳過** |
| 新成交真值測試 | 覆蓋 exchange fill 優先、價格／數量回退來源與無效值處理 |
| 新持倉快照測試 | 覆蓋 exact、量／均價不吻合降級、共享帳戶 aggregate、不可用狀態 |
| 20415 回歸 | 七線同向且排名不變可在已收盤 M30 進場；止盈、持倉時間、盲人模式與最終層限制均通過 |
| 正式 production build | Vite 前端及 Node 伺服器 bundle 成功 |
| 測試殘留 | 測試產生的臨時自訂策略檔已清理，未納入發布 |

開發預覽的自動畫面擷取受到環境限制：曾出現 Vite 入口模組未掛載、公開預覽 `Too many requests` 及空白根節點。資源 HTTP、TypeScript、完整測試與 production build 均成功，但沒有把白畫面擷取當成 UI 通過證據。發布後仍應在使用者實際登入狀態下做一次人工畫面核對；詳細過程保存在 `docs/visual-qa-pnl-reconciliation-2026-07-25.md`。

## 五、上線後核對方式

請先在 OKX 模擬盤或低風險測試帳戶核對。打開策略卡片時，應能看到「交易所持倉」來源、mark price、未實現盈虧、盈虧率、持倉保證金及同步時間；如果同帳戶有多個同方向 BTCUSDT 策略，畫面應明確顯示「帳戶合併持倉」，而不是把整筆 OKX UPL 複製到每張卡片。

同一時刻比較平台與 OKX 時，需核對交易對、方向、持倉量、均價、mark price 與更新時間。數字可能在下一次快照刷新時因市場變動而改變，但同一快照口徑不應再出現平台用 last price 顯示盈利、OKX 用 mark price 顯示虧損的結構性矛盾。

| 建議檢查 | 正常結果 | 需立即停止並回報的情況 |
|---|---|---|
| 策略卡片來源 | `exchange_position`／交易所持倉 | 顯示 OKX 數字卻沒有來源或時間 |
| 精確歸屬 | 量、均價、方向與 OKX 同一持倉一致 | 多策略共享倉位卻仍標示 exact |
| 盈虧 | 與同時間 OKX `upl`／`uplRatio` 同口徑 | 同 mark price 下仍符號相反 |
| 平倉 | 只有交易所成功後才更新本地狀態 | 下單失敗但本地顯示已平倉／已停用 |
| 交易歷史 | 新成交顯示 exchange fill 來源 | 新交易仍把策略訊號價當成交價 |

## 六、主要程式位置

| 責任 | 路徑 |
|---|---|
| 統一策略持倉快照 | `server/services/strategyPositionSnapshot.ts` |
| 持倉快照回歸 | `server/services/strategyPositionSnapshot.test.ts` |
| 交易所 adapter 契約 | `server/exchanges/types.ts`、`server/exchanges/okx.ts`、`server/exchanges/bybit.ts` |
| 受保護快照端點 | `server/routers/exchange.router.ts` |
| 成交真值解析 | `server/services/tradeFillTruth.ts` |
| 成交真值回歸 | `server/services/tradeFillTruth.test.ts` |
| 執行與監控 | `server/services/executor.ts`、`positionManager.ts`、`riskMonitor.ts`、`v35Monitor.ts`、`v50Monitor.ts`、`v61Monitor.ts` |
| 前端真值顯示 | `client/src/pages/Strategies.tsx`、`Home.tsx`、`Positions.tsx` |
| 資料庫契約 | `drizzle/schema.ts`、`drizzle/0016_peaceful_hardball.sql` |

## References

[1]: https://www.okx.com/help/futures-pnl-calculation-rules "OKX — Futures PnL calculation rules"
[2]: https://www.okx.com/docs-v5/en/ "OKX API guide — Account positions and authenticated REST requests"
