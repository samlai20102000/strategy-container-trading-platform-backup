# KAMA V4.0／V6.1 雙策略聯合唯讀診斷與修復決策報告

**作者：Manus AI**  
**日期：2026-08-01（香港時間）**

> 本輪只進行截圖精讀、資料庫查詢、程式追蹤與交易所唯讀 API 核對。沒有送單、撤單、改單、平倉、停用策略、修改設定或改寫交易資料。

## 一、先回答核心問題

**目前不能判定為「全部正常」。** 兩個策略都已確認存在真實問題，而且不是同一個故障。V4.0 的問題是「部分成交被整筆標為失敗、重複加空、平倉無實際送單卻被標為成功」；V6.1 的問題是「監控畫面與正式信號引擎使用兩套不同加倉門檻、歷史持倉無法逐層歸屬、舊版普通限價單仍長時間掛在 OKX」。

| 策略／流程 | 最新判定 | 嚴重度 | 直接結論 |
|---|---:|---:|---|
| V4.0 加空（截圖中的 19 次賣出） | **異常** | P0 | 不是完全賣不出；16 次已各部分成交 `0.001 BTC`，但尾數未全成後整筆被標失敗，策略沒有吸收部分成交，反覆重送同一層 |
| V4.0 平空 | **嚴重異常** | P0 | 系統因 symbol 正規化錯誤找不到真實空腿，卻把空集合聚合為成功；實際沒有平倉訂單，`0.1159 BTC` 空腿仍在 OKX |
| V4.0 目前活動委託 | **目前為 0** | 觀察 | 2026-08-01 13:13:40 HKT 唯讀查詢顯示帳戶 1 沒有活動委託，但同時有多、空兩腿 |
| V6.1 第 2 層觸發 | **異常** | P1 | UI／監控器依 `Martin_Layers=0.5%` 顯示已達條件，正式引擎卻依硬編碼 regime `1.0%–2.0%` 判定 HOLD，因此根本沒有產生第 2 層 signal |
| V6.1 分層數量 | **異常／保守降級正確** | P1 | OKX 真實空腿 `0.1518 BTC`，逐層 ledger 只可證實 `0.0095 BTC`，差額 `0.1423 BTC` 無法精確歸屬；卡片顯示「數量不一致」是在避免偽造層級 |
| V6.1 15:08 舊限價單 | **仍然異常且仍活動** | P0 | 2026-08-01 13:16:28 HKT 唯讀查詢確認訂單 `3790957489019392000` 仍為 live、完全未成交；已存活約 `22 小時 7 分 31 秒` |
| 新版 Maker-First 主流程 | **近期事件鏈正常，但不能覆蓋舊單** | 部分正常 | V6.1 最新可追溯新單已完成受理、撤單重掛與成交；恢復排程正常，但無法發現沒有 policyRunId 的舊版遺留單 |

## 二、兩張 V4.0 圖片的直接含義

第一張訊號日誌共有 19 筆連續 `sell`，時間為 `2026-08-01 04:14:35–05:02:25 HKT`，全部被前端顯示為「失敗、0.00 USDT、unknown」。資料庫與 policy event 交叉核實後，這些是 V4.0 空頭趨勢的**第 2 層加空**，不是平多，也不是 OKX 因 `posSide` 拒單。

| 指標 | 已核實結果 |
|---|---:|
| policy run 數 | `20` |
| 被 OKX 接受 | `20/20` |
| 發生部分成交 | `16/20` |
| 每個 run 最大可證實成交 | `0.001 BTC` |
| 可證實部分成交合計上限 | `0.016 BTC` |
| 完整成交 | `0` |
| 最終 `MAKER_EXPIRED` | `17` |
| 最終 `CANCEL_NOT_CONFIRMED` | `3` |

因此，「一直未能賣出」是**日誌語義錯誤**。真實情況是多數訂單已成交主要部分，只剩約 `0.0000716–0.0000732 BTC` 尾數未成交或撤單終局未確認；Maker-First 回傳整體 `success=false` 後，V4.0 沒有處理 `filledSize>0` 的部分成交，也沒有鎖住同一個「策略＋方向＋第 2 層」intent，20 秒後又重送一次，令真實空倉累積而層數不前進。

第二張 OKX 圖片顯示帳戶 1 同時有 `long 0.0079 BTC` 與 `short 0.1159 BTC`。2026-08-01 13:13:40 HKT 的交易所唯讀 API 再次確認兩腿仍存在，且沒有活動委託。

| 帳戶 1 即時持倉 | 數量 | 均價 | 標記價 | 未實現盈虧 |
|---|---:|---:|---:|---:|
| Long | `0.0079 BTC` | `63014.4` | `63095.9` | `+0.64385 USDT` |
| Short | `0.1159 BTC` | `63015.494477998276` | `63095.9` | `-9.3190 USDT` |

資料庫目前只有策略 `120011` 在帳戶 1／BTCUSDT 啟用，其 martinState 只認領新的 `long 0.0079 BTC`。因此 `short 0.1159 BTC` 不是另一條啟用策略合法認領的倉位，而是 V4.0 的**歷史未平空腿／未歸屬空腿**。

## 三、V4.0「假成功平倉」的已證實根因

V4.0 在 `2026-08-01 05:07:19 HKT` 寫出一筆平掉 `0.1159 BTC` 空腿的成功紀錄，但該 signal 沒有 orderId，trade 沒有 orderId，成交價為 `0`，同時段亦沒有 order-policy event；OKX 其後及目前仍保留該空腿。

| 程式步驟 | 實際錯誤 |
|---|---|
| `closePositionSmart("BTCUSDT", "short")` 查持倉 | OKX adapter 回傳 symbol `BTC-USDT-SWAP` |
| Maker-First facade 過濾 symbol | 只移除連字號後比較，得到 `BTCUSDTSWAP != BTCUSDT`，錯誤過濾掉真實空腿 |
| 聚合空結果 | `aggregateCloseResults([])` 回傳 `success=true / filled / NO_OPEN_POSITION` |
| V4.0 monitor 判定 | 只看 `success`，不要求 orderId、`filledSize>0` 或平倉後持倉減少 |
| 最終後果 | 沒有送出平倉單，卻寫入 `exchange_confirmed`、清空 martinState，之後又開出新的多腿 |

這是 P0 級錯誤：**平台顯示平倉成功不代表交易所真的平倉。** 在修正並驗收前，不能把 V4.0 的成功平倉日誌視為交易所成交真相。

## 四、V6.1 第 2 層開不到的已證實根因

V6.1 不是因 OKX 拒單，也不是因 Maker-First 超時。正式 Heartbeat 沒有建立第 2 層 policy run，原因是同一策略存在兩套互相矛盾的規則。

| 判斷來源 | 價格基準 | 第 2 層門檻 | 結果 |
|---|---|---:|---|
| 卡片／`v61Monitor` | `lastLayerPrice=62634.7` | `Martin_Layers.stepPct=0.5%` | 價格偏離約 `0.65%–0.74%`，反覆顯示「已達第 2 層」 |
| 正式 `StrategyKama3kV61` | `avgEntryPrice=62705.14` | regime 硬編碼 `1.0% / 1.5% / 2.0%` | 未達最低 `1.0%`，回傳 HOLD，不產生 signal |

`v61Monitor` 的「條件滿足」分支只打印日誌，實際加倉由 `autoTradeSignalGenerator` 處理。因此 UI 顯示已達條件並不會觸發訂單；正式引擎仍按另一套門檻等待。這就是「層數開不到」的直接原因。

## 五、V6.1 長掛單目前仍未消失

V6.1 綁定的是 API 帳戶 `2`；V4.0 綁定的是 API 帳戶 `1`，所以兩張 OKX 畫面來自**兩個不同帳戶**，不應把 V4.0 的 `0.1159/0.0079` 雙向持倉與 V6.1 的 `0.1518` 空腿合併計算。

2026-08-01 13:16:28 HKT 對帳戶 2 執行唯讀查詢，結果如下：

| V6.1 帳戶 2 項目 | 交易所真相 |
|---|---|
| 持倉模式 | `HEDGE / long_short_mode`，支援指定方向腿精確平倉 |
| 空腿 | `0.1518 BTC`，均價 `62705.14183135705` |
| 當前活動委託 | `1` |
| orderId | `3790957489019392000` |
| clientOrderId | 空字串 |
| 建立時間 | `2026-07-31 15:08:57 HKT` |
| 方向 | `sell / short / reduceOnly=false`，即開空 |
| 類型 | 普通 `limit`，不是新版 post-only 子單 |
| 委託量 | `0.93` 張，即 `0.0093 BTC` |
| 已成交 | `0` |
| 狀態 | `live` |
| 截至快照存活時間 | 約 `22 小時 7 分 31 秒` |

該訂單早於策略 `60008` 第一筆 Maker-First event 約 6 小時 42 分，亦早於全域 Maker-First／durable recovery 部署。它沒有 clientOrderId、沒有 policyRunId、沒有新版 append-only 事件鏈，因此現行恢復排程即使正常執行，也沒有入口辨識或清理它。

## 六、限價優先更新目前正常到甚麼程度

**新流程是部分正常，歷史與策略狀態仍不正常。** V6.1 最新可追溯 policy run 已完成 `INTENT_RECEIVED → MAKER_SUBMIT → MAKER_ACCEPTED → MAKER_CANCEL_REQUESTED → MAKER_CANCELLED → 重掛 → MAKER_FILLED`，最終成交 `0.0095 BTC`；recovery schedule 最近亦回報成功且沒有 stale run。這證明新版 Maker-First 主路徑正在工作。

| 範圍 | 是否正常 | 說明 |
|---|---:|---|
| 新版開倉／加倉使用 post-only limit | 大致正常 | 最新 V6.1 事件鏈可完整追蹤並有最終成交 |
| 新版未成交後 TTL／撤單／重掛 | 大致正常 | 最新事件鏈顯示撤單確認後才重掛 |
| 新版 recovery 排程 | 正常運行 | 最近 `SUCCESS`，但只處理有 policy event 的 run |
| 舊版普通 limit 活動單 | **不正常** | 15:08 單仍 live，無 clientOrderId／policyRunId，現行 recovery 看不到 |
| V4.0 部分成交狀態機 | **不正常** | `success=false + filledSize>0` 被整筆當失敗，會重複加倉 |
| V4.0 平倉交易所確認 | **嚴重不正常** | 可在沒有訂單與成交的情況下標記成功 |
| V6.1 加倉門檻一致性 | **不正常** | 顯示層與執行層使用不同規則 |
| 馬丁逐層 ledger | **不正常** | 歷史成交與交易所整腿不能精確一對一 |

## 七、建議修復設計

### P0：先阻止新增錯誤風險

建議先把 V4.0 與 V6.1 的自動交易視為**不具備無人值守資格**，直到 P0 驗收通過。若您授權執行，應先暫停策略，而不是先平倉或撤單；15:08 舊單和兩個帳戶的現有持倉要另列清單，由您逐項確認處置，避免系統擅自改變倉位。

| P0 修復 | 必須做到的行為 |
|---|---|
| 統一 symbol canonicalization | `BTCUSDT`、`BTC-USDT-SWAP`、`BTCUSDTSWAP` 必須映射為同一 instrument identity；不可用簡單字串相等判斷 |
| 禁止空集合假成功 | 指定方向平倉若找不到持倉，應回 `success=false / NO_MATCHING_POSITION`；只有呼叫者明確接受 idempotent no-op 時才可標 skipped，絕不能標 filled |
| 強制平倉後驗證 | 平倉成功必須同時具備交易所 order／fill 真相，且重查該方向持倉已減少到容差內；否則保持 pending／failed |
| 部分成交即時入帳 | `success=false` 但 `filledSize>0` 必須按實際成交量推進持倉與 ledger；只對 remainingSize 重試 |
| intent 冪等鎖 | 使用 `strategyId + deploymentKey + cycleId + layer + side` 建唯一 intent；未終結前不得每 20 秒建立新 cycle |
| 歷史孤兒委託掃描 | 增加只讀 orphan scanner，比對 OKX open orders 與 policy events；沒有 clientOrderId 的舊單只報告，禁止自動撤單 |

### P1：消除 V6.1 雙門檻與成交真相缺口

V6.1 應只保留一個加倉規則來源。依您既有偏好，建議**分層表 `Martin_Layers` 優先**；若某層沒有配置，才使用 regime 預設值。卡片、監控器、正式 signal engine、回測與「距下一層」提示必須呼叫同一個純函式，並回傳同一組 `referencePrice / stepPct / triggerPrice / remainingPct / ruleSource`。

| P1 修復 | 設計要求 |
|---|---|
| 單一加倉規則解析器 | UI、monitor、Heartbeat、回測共用；禁止各自硬編碼 |
| V6.1 executor 成交防線 | 移除 `filledSize ?? 理論下單量` 與 `filledPrice ?? signalPrice` 的成交回退；沒有交易所 fill 不得推進 layer |
| legacy inventory 遷移 | 用 OKX 歷史成交／訂單真相回填可證實層級；無法證實的 `0.1423 BTC` 只能標成 `legacy_unattributed` 聚合庫存，不得偽造每層成交價 |
| clientOrderId 強制化 | 所有新單必須帶策略、policy run 與 attempt 身分；禁止空 clientOrderId |
| 活動單所有權 | 每個 live order 必須能歸屬至 strategy／intent；無歸屬即告警且阻止同方向新 intent |

### P2：可觀測性與測試網驗收

前端不可再把 `PARTIAL_FILLED`、`ENTRY_EXPIRED`、`CANCEL_NOT_CONFIRMED`、`NO_MATCHING_POSITION` 全部壓成「交易執行失敗」。訊號日誌應分開顯示 requested、filled、remaining、order state、policyRunId、clientOrderId、reasonCode 與持倉變化，並把「已跳過／等待／部分成交」作為可篩選狀態。

| 驗收項 | 通過標準 |
|---|---|
| V4.0 partial-fill 回歸測試 | 部分成交只入帳一次，只重試 remainingSize，層級與交易所增量一致 |
| V4.0 close 回歸測試 | `BTCUSDT` 能匹配 `BTC-USDT-SWAP`；空集合不能回 filled；持倉未減少不能標成功 |
| V6.1 門檻一致性測試 | 同一價格下 UI、monitor、Heartbeat、backtest 的 trigger 結果完全相同 |
| Maker-First 活動單測試 | TTL 後不存在未終結 child order；撤單未確認時禁止重掛 |
| orphan scanner 測試 | 能列出 `3790957489019392000` 為 legacy unmanaged，但不自動撤單 |
| 交易所真相測試 | 每筆 `filled` 都有非零 filledSize、交易所訂單／成交依據與持倉變化證據 |
| 測試網觀察 | 修復後在 OKX 模擬帳戶連續觀察至少 48 小時，再決定是否恢復 7×24 自動交易 |

## 八、供您選擇的三個方案

| 方案 | 內容 | 優點 | 限制／風險 |
|---|---|---|---|
| **A．只做安全隔離** | 只暫停兩策略、產生現有持倉與孤兒委託處置清單；不改程式、不碰交易 | 最快停止新增錯誤 | 根因仍在，不能恢復自動交易 |
| **B．P0＋P1 根治（建議）** | 修正 V4.0 平倉與部分成交、建立 intent 冪等鎖、統一 V6.1 加倉規則、增加 legacy orphan／inventory 對帳；完成單元與整合測試，但不自動處置現有委託／持倉 | 直接解決本次兩個策略的根因，且可泛化到其他策略 | 仍需您對現有 15:08 掛單及兩個帳戶持倉另行授權 |
| **C．完整修復＋測試網驗收** | 先完成 B，再做只讀 dry-run、由您確認後處置測試帳戶孤兒單／未歸屬腿，最後跑 48 小時受控測試 | 最接近恢復 7×24 前的完整驗收 | 時間較長；任何撤單／平倉／送單均需另行明確確認 |

**建議選 B，並把現有交易所資產處置與程式修復分開授權。** 這樣可以先修正平台，避免修復過程中把現有持倉或掛單誤當成測試資料；完成 dry-run 後，再由您決定是否撤銷 V6.1 的舊單、如何處理 V4.0 的 `short 0.1159 BTC`、以及是否保留兩個策略現有方向腿。

## 九、此次排查沒有做的事

此次沒有停用策略、撤銷訂單 `3790957489019392000`、平掉任何持倉、補寫 V4.0 的 16 次部分成交、重建 V6.1 的 `0.1423 BTC` 歷史層級或修改任何下單邏輯。這些均屬下一階段，需要您選定方案並明確授權。

## References

[1]: ./v40_kama_3k_sell_failures_2026-08-01.md "V4.0 KAMA+3K 動態馬丁連續賣出失敗唯讀診斷"
[2]: ./kama_v61_order_issue_2026-08-01.md "KAMA 3K V6.1 馬丁層數與長掛限價委託唯讀診斷"
[3]: /home/ubuntu/tmp/current_okx_state_2026-08-01.json "V4.0 帳戶 1 去敏感化交易所唯讀快照"
[4]: /home/ubuntu/tmp/current_okx_state_v61_api2_2026-08-01.json "V6.1 帳戶 2 去敏感化交易所唯讀快照"
