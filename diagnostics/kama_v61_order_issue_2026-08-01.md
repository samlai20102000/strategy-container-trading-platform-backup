# KAMA 3K V6.1 馬丁層數與長掛限價委託唯讀診斷

> 本檔僅保存可核實證據與後續分析；排查過程禁止送單、撤單、改單或平倉。

## 截圖 1：策略卡片

來源：`/home/ubuntu/upload/pasted_file_g80RfE_image.png`（1246×1650）

- 策略：`KAMA 3K V6.1 高頻掃射 - 導入`；交易所 `OKX`；交易對 `BTCUSDT`；部署模式標籤 `SINGLE EXCLUSIVE · LEGACY`。
- API 帳戶：OKX 模擬帳戶；畫面顯示帳戶名稱 `OKX模擬子帳號SamLai01`。
- 最終部署倉位：`300.00000000 USDT`；槓桿 `5x`；方向 `雙向`；下單類型 `限價`。
- OKX 真實持倉：`0.1518 BTC` 空單；均價 `62705.14`；標記價 `63014.40`；名義價值 `9565.59 U`；持倉保證金 `1913.1172 U`；未實現盈虧 `-46.9454 U (-2.47%)`。
- 卡片右上顯示 `同步 00:00:00 · 第 1 層`，與下方馬丁逐層卡的 `已開 1/11 層` 一致於「只辨識出第一層」。
- 下一層提示為 `距第 2 層加倉`；基準上層價 `62634.70`；觸發價 `62947.87`；間距 `0.5%`；目前價 `63014.4`；已偏離 `0.61%`；畫面標示 `已達觸發條件`。
- 馬丁逐層持倉同時顯示 `唯讀成交稽核`、`數量不一致`、`已隱藏過期 PnL`；警告內容為逐層數量與交易所帳戶持倉未達精確一對一，系統已降級顯示並禁止偽精確盈虧。
- 唯一列出的層級：空單 `BTCUSDT`，開倉時間 `07/31 23:36:57`，成交價 `62,634.7`，剩餘數量 `0.0095`，品質 `數量不一致`。
- 對帳同步時間：`08/01 12:38:59`；逐層卡片剩餘 `0.0095 BTC`，但交易所真實持倉為 `0.1518 BTC`，未被逐層 ledger 精確歸屬的差額為 `0.1423 BTC`（後續需以程式計算與資料庫核實）。
- 策略交易模式 `自動`；分析週期 `30 分鐘`；輪詢頻率 `每 1 分鐘`；上次檢測 `7/31 下午11:36`；狀態 `運行中`。

## 初步觀察（尚未定論）

- 「層數開不到」更像是**持倉歸屬／成交 ledger 對帳失敗後的保守降級顯示**，不是單純 UI 無法增加層數；策略卡已明確因數量不一致禁止偽精確分層。
- 需核對未歸屬的 `0.1423 BTC` 來自其他策略、舊版本／舊部署、手動交易、部分成交／重掛、或同帳戶同交易對的共享淨持倉。
- `已達第 2 層觸發條件` 不等於第 2 層已成交；必須再核對是否存在仍掛著的第 2 層限價單、其訂單狀態、TTL／重掛紀錄與成交回報。

## 截圖 2：OKX 當前持倉（分區讀取）

來源：`/home/ubuntu/upload/pasted_file_Gd95RF_image.png`（2231×597，按左至右四區重疊讀取）。

前兩區可核實：頁籤顯示 `當前委託 (1)` 與 `當前倉位 (1)`；倉位為 `BTCUSDT 永續`、`5x`，持倉量 `0.1518 BTC`，標記價格 `63,023.5`，開倉均價 `62,705.2`，預估強平價 `95,471.4`，盈虧平衡價 `62,666.3`。第一、二區重疊邊界一致，沒有欄位錯位。

後兩區可核實：浮動收益為 `-48.33 USDT (-2.54%)`，維持保證金率顯示 `10,922.77%`，保證金為 `1,913.40 USDT`、模式 `全倉`。最右側提供 `平倉` 與 `市價全平` 操作；本次未觸發任何操作。四區合併後，OKX 持倉數量與策略卡的 `0.1518 BTC` 一致，均價僅因顯示精度不同為 `62,705.2` 對 `62,705.14`；標記價亦為近似同期的 `63,023.5` 對 `63,014.40`，可合理視為不同刷新秒數。

## 截圖 3：OKX 當前委託（分區讀取）

來源：`/home/ubuntu/upload/pasted_file_LW4goh_image.png`（2217×661，按左至右四區重疊讀取）。

前兩區可核實：頁籤顯示 `當前委託 (1)`，分類為 `限價｜市價 (1)`；交易對 `BTCUSDT 永續`，`全倉`、`5x`；委託時間顯示 `2026/07/31 15:08:57`；方向 `賣出開空`。成交均價為 `--`，委託價 `64,118.3`；已成交 `0.0000 BTC`，委託總量 `0.0093 BTC`。因此截圖時此單是**完全未成交且仍在簿上的開空限價單**，不是已成交後殘留的歷史紀錄。

後兩區可核實：該委託價值為 `$595.68`，未附加止盈止損；交易欄位為 `--`，右側仍提供 `追單`、`修改`、`撤單` 與 `批量撤單`，再次證明訂單仍是活動委託。四區欄位連續且重疊一致。

### 三張截圖的直接數量關係

策略卡的真實持倉與 OKX 持倉均為 `0.1518 BTC`；策略卡唯一可見逐層成交尚餘 `0.0095 BTC`，而 OKX 活動委託是 `0.0093 BTC` 的未成交 `賣出開空`。兩者差值為 `0.0002 BTC`，但**方向與生命週期不同**：`0.0095` 是卡片列出的已記錄逐層剩餘成交量，`0.0093` 是尚未成交的掛單總量，不能直接相抵或視為同一筆成交。這一點需要由訂單 ID／clientOrderId 與逐層成交明細再確認。

## 程式證據：Maker-First 委託生命週期

來源：`server/exchanges/makerFirstFacade.ts`。

- 全域政策版本為 `GLOBAL_MAKER_FIRST_B_V1`。標準開倉、加倉與正常平倉預設每次 post-only TTL 為 `30,000ms`，最多提交 `3` 次，查單間隔 `500ms`。
- 每次嘗試均以當前 bid／ask 與 tick size 建立 maker-safe 價格，送出 `limit + postOnly`。成功受理後，程式在 request 內輪詢交易所訂單真相。
- TTL 到期且未全成時，正常路徑會先寫入 `MAKER_CANCEL_REQUESTED`，再呼叫撤單、重新查最終成交真相；只有確認撤單後才會重掛剩餘量。撤單無法確認時會 `CANCEL_NOT_CONFIRMED` 並 fail-closed，避免同一 intent 同時存在兩張 live 訂單。
- 標準開倉／加倉三次均未成交後會寫入 `MAKER_EXPIRED / ENTRY_EXPIRED`，理論上剩餘量已取消且不轉市價；正常平倉亦不轉市價，只有明確的止損、日損限額或 kill switch 緊急退出才可在短暫 maker 嘗試後採用核准的 taker fallback。
- 例外路徑只會對當前記憶體中的 `activeOrder` 做 best-effort 撤單。跨 request／執行個體中斷，則依賴持久化恢復工作處理。

來源：`server/services/orderPolicyRecovery.ts` 與 `server/_core/index.ts`。

- 未終結 policy run 超過預設 `210,000ms` 會被視為 stale；恢復工作一次只掃描 `limit: 1`，取得租約後以 clientOrderId／orderId 查詢交易所權威訂單真相。
- 若發現仍存活的 maker 子單，恢復工作會先稽核、再撤單；撤單未確認時禁止建立第二張 live 訂單。安全後才以原 policyRunId 接續剩餘量。
- 此恢復工作不是常駐 worker，而是 `/api/scheduled/order-policy-recovery` 的 Heartbeat 端點；它還要求 cron 身分、`taskUid` 存在，且資料庫中的 recovery task 必須為啟用狀態。若排程未建立、已停用／孤兒化、未觸發或持續失敗，request 中斷留下的 live 限價單不會被此機制清理。

### 此段對截圖的直接含義

截圖中的 `2026/07/31 15:08:57`、`0.0093 BTC` 未成交開空單若確由目前 Maker-First 路徑建立，正常情況下不應跨越數分鐘仍存活，更不應掛至隔日。因此至少存在以下其一：該單不是由新版門面建立、建立時沒有被全域代理攔截、request／instance 中斷且恢復 Heartbeat 未生效，或交易所查單／撤單映射未能定位該訂單。後續必須用 order-policy 事件鏈、交易紀錄與交易所 orderId／clientOrderId 核實，不能只從畫面斷言單一原因。

## 程式證據：V6.1 開倉／加倉與中央代理包裝鏈

來源：`server/services/executor.ts`、`server/exchanges/runtimeGuardedAdapter.ts`、`server/exchanges/factory.ts`、`server/exchanges/makerFirstFacade.ts`。

- V6.1 的開倉／加倉段落確實依 `strategy.orderType` 呼叫 `adapter.placeOrder`；限價時把訊號價作為 `price`。其後以 `orderResult.success` 寫入交易，並以 `orderResult.filledSize ?? 理論下單量`、`orderResult.filledPrice ?? 訊號價` 推進馬丁狀態。
- 單看 `executor.ts` 會出現一個高風險語義：如果底層 adapter 把「交易所已受理但未成交」回傳為 `success=true` 且沒有 `filledSize`，V6.1 就會過早記為 `filled` 並用理論量增加 `currentLayer/totalSize`。
- 但**目前發布版不能直接下結論為「V6.1 繞過 Maker-First」**。執行器取得的 adapter 先由 `createAdapter()` 建立；工廠把原生 OKX／Bybit adapter 強制包成 `createMakerFirstAdapter`，之後才再由三模式 runtime gate 包裝。runtime gate 最後呼叫的 `target.placeOrder`，其 target 正是 Maker-First proxy。
- `createMakerFirstAdapter.placeOrder` 不依賴呼叫者傳入的 `market/limit` 直接成交，而是把參數轉成 intent 後呼叫 `executeMakerFirst`；標準流程只有在完整成交時才回 `success=true`，未成交或部分成交至上限會回 `success=false`。因此在**目前全域代理確實生效**的版本中，V6.1 上述 fallback 不應被未成交 live limit 單觸發。
- 這表示 `executor.ts` 的 `filledSize ?? 理論量` 仍是應修的防禦性缺陷，但它是否造成截圖中的歷史不一致，必須結合訂單建立版本與事件鏈判定，不能僅憑目前源碼倒推。

## 部署時間線證據

- `bc1cabfc`（Maker-First durable recovery）checkpoint：`2026/07/31 21:42:47 HKT`。
- `2f787864`（全域 Maker-First 最終交付）checkpoint：`2026/07/31 22:17:31 HKT`。
- 截圖中的活動限價委託建立時間為 `2026/07/31 15:08:57`。若 OKX 畫面採使用者本地時間（香港／GMT+8，需由帳戶時區設定最終確認），該單分別早於兩個新版部署約 `6小時34分` 與 `7小時09分`。

因此目前最強的時間線解釋是：**該 15:08 掛單是全域 Maker-First 與 durable recovery 上線前，由舊的普通限價路徑建立的遺留活動委託**。新版恢復引擎以 order-policy 事件為入口，未必能發現一張沒有 policyRunId／事件鏈的舊單；這可同時解釋為何新版部署後它仍掛著。此結論仍需資料庫事件鏈與訂單 ID 核實。

## 最新核實：V6.1 第 2 層沒有開出的直接根因

### 資料庫與執行時間線

- `order_policy_events` 中策略 `60008` 共 `117` 筆事件：`27` 次 maker accepted、`15` 次 filled、`1` 次 expired、`7` 次 failed。第一筆事件為 `2026-07-31 21:50:30 HKT`，最後一筆為 `2026-07-31 23:36:56 HKT`。
- OKX 活動委託建立於 `2026-07-31 15:08:57`，比策略 `60008` 的第一筆 Maker-First 事件早約 `6 小時 42 分`；因此該舊單**沒有新版 policy event 可供 durable recovery 掃描**。這把「舊版遺留單」由高機率假說提升為有資料庫時間線支持的結論。
- 最新 V6.1 policy run `mfpms93ue3w08788da70` 於 `23:36:07–23:36:56 HKT` 走完 `INTENT_RECEIVED → MAKER_SUBMIT → MAKER_ACCEPTED → MAKER_CANCEL_REQUESTED → MAKER_CANCELLED → MAKER_SUBMIT → MAKER_ACCEPTED → MAKER_FILLED`，最終成交 `0.0095 BTC`、剩餘 `0`。這正好對應卡片唯一可追溯的 `23:36:57 / 0.0095 BTC` 層級。
- recovery schedule 已啟用，最近一次於 `2026-08-01 13:05:59 HKT` 回報 `SUCCESS`，摘要為 `scanned=0, recovered=0, resumed=0, failed=0`。所以恢復排程本身目前有運行，但它沒有可掃描的 stale policy run；這不代表它能發現無 policyRunId 的 15:08 舊單。

### 當前狀態與兩套互相矛盾的加倉門檻

- 策略 `60008` 的當前 `martinState` 為：`currentLayer=1`、`totalSize=0.1518`、`avgPrice=62705.14183135705`、`lastLayerPrice=62634.7`、`isLong=false`。
- 綁定配置 `Martin_Layers` 將第 `1–4` 層的 `stepPct` 設為 `0.5%`，最大層數 `11`。`v61Monitor.ts` 使用這份配置及 `lastLayerPrice`，因此在價格偏離 `0.65%–0.74%` 時每 15 秒持續打印「馬丁加倉條件滿足，層=2/11」。但該分支第 278 行只留下註解「加倉由 autoTradeSignalGenerator 觸發」，**本身沒有送單**。
- 正式 Heartbeat 的 `autoTradeSignalGenerator` 另建 `StrategyKama3kV61`，其 `handlePositionManagement` **完全不讀 `Martin_Layers` 的 0.5%**，而是讀硬編碼 `V61_REGIME_PARAMS`：ranging `1.0%`、weak trend `1.5%`、strong trend `2.0%`，並以 `avgEntryPrice` 而非 `lastLayerPrice` 計算距離。
- 在觀察到的 `0.65%–0.74%` 偏離下，監控器的 `0.5%` 門檻已達，但信號引擎連最低的 `1.0%` 門檻仍未達。資料庫最近 20 筆 V6.1 Heartbeat 均因此記錄 `hold / [strategy_hold] V6.1 策略判斷觀望: 持倉中，無動作`，且最後一筆 policy event 仍停在 `23:36:56 HKT`。

**已確認結論：第 2 層「開不到」的直接原因不是 OKX 拒單，也不是 Maker-First TTL；而是 V6.1 同時存在兩套加倉規則。UI／本機監控器依用戶分層表判定已達 `0.5%`，正式信號引擎卻依硬編碼市場制度門檻判定未達，故沒有產生 signal，也沒有送單。**

### 與「數量不一致」的關係

`v61Monitor` 會把策略層級總量自動校準成 OKX 該方向整腿 `0.1518 BTC`，但逐層成交 ledger 只有新版可證實的 `0.0095 BTC`。因此 state 總量雖與交易所一致，逐層 ledger 仍有 `0.1423 BTC` 無法歸屬。這是**第二個獨立問題**：它造成卡片降級為「數量不一致／只顯示 1 層」，但不是本輪 Heartbeat 沒有產生第 2 層 signal 的直接原因。
