# 快照導入策略引擎綁定修復筆記

## 使用者回報與影像證據

- 使用者從參數快照建立新策略，表單已顯示快照帶入的策略名稱與回測參數。
- 建立表單底部的「策略引擎」仍顯示「不使用（訊號直接執行）」。
- 建立後策略卡片只顯示 Webhook 模式，而且「啟用自動」按鈕為停用狀態。
- 使用者期望：快照本身已記錄回測所用策略與最佳參數，因此導入時不應再次手動選擇策略；系統應自動綁定快照原策略引擎，且必須使用快照參數而不是內建預設值。

## 已確認根因

1. `client/src/pages/Strategies.tsx` 的快照導入點擊處會帶入 `snap.config` 與 `snap.backtestSettings`，但沒有把 `snap.strategyKey` 寫入 `form.strategyKey`，所以保留 `emptyForm.strategyKey = "none"`。
2. `handleSubmit` 會把 `"none"` 轉為 `strategyKey: null`，因此策略實例沒有執行引擎。
3. 提交邏輯仍可能建立版本化配置，形成「有參數、無引擎」的不一致狀態。
4. `AutoTradeModeSection` 在 `strategy.strategyKey` 不存在時停用「啟用自動」，因此建立後按鈕變灰。
5. 後端快照資料本身已有 `strategyKey`；`server/routers/backtest.router.ts` 的 `importSnapshotAsNew` 也已支援回退使用 `snapshot.strategyKey`，問題主要在策略頁的手動導入流程。
6. `server/routers.ts` 的一般 `strategies.create` 允許 `strategyKey` 為空，缺乏防禦性驗證。
7. 快照的 `backtestSettings.tradeAmount` 在回測頁明確是 **USDT 金額**，且新快照會保存 `baseLotSizeMode: "usdt"`；但策略頁導入時沿用 `emptyForm.positionMode = "quantity"`，有把例如 100 USDT 誤解成 100 BTC 數量的高風險。導入時必須讀取 `baseLotSizeMode`，舊快照未保存模式時亦應以 `usdt` 作安全預設。
8. 現有導入大量使用 `||`，會把快照中的合法 `0`／`false` 替換成內建預設值；應改用 nullish 邏輯 (`??`) 並保留完整原始版本配置。
9. 專案已有 `backtest.importSnapshotAsNew` 專用端點，可由伺服器按 `snapshotId + userId` 重新讀取快照並建立策略，天然較一般 `strategies.create` 安全；但目前只區分 V6.1 與一般 V3.5，尚未將 V5.0、EMA V2.0、V7.0 分流至各自的 `__v50Config`／`__v2_0Config`／`__v70Config`，亦允許前端傳入不同 `strategyKey` 覆蓋快照引擎。
10. 策略頁雖已匯入 `getSchemaForStrategy`，實際仍固定使用 `STRATEGIES_DYNAMIC_SCHEMA`；因此 V6.1 等引擎即使綁定正確，也可能顯示通用參數欄位而非該引擎 schema。快照原始 config 應作為動態表單資料底稿，且按 strategyKey 選擇 schema。
11. 最安全的建立流程：快照導入時表單只允許調整部署層欄位（名稱、API 金鑰、交易對、倉位與方向），提交改走專用 `importSnapshotAsNew`；伺服器以快照自身 `strategyKey` 與原始 `config` 為唯一來源，禁止前端換引擎，並按引擎保存完整版本配置。

## 修復原則

- 從快照導入：自動、明確、不可含糊地綁定快照原策略引擎；不要求使用者重選。
- 顯示「由快照鎖定」及策略引擎名稱，避免誤以為會使用內建預設參數。
- 完整保留快照版本化配置；不得以 `||` 將合法的 `0`、`false` 或空值誤換成預設值。
- 普通手動建立仍可選擇「只使用 Webhook」，但若要啟用自動交易則必須有策略引擎。
- 建立端與後端都應防止「快照參數存在但 strategyKey 為空」的不一致資料。
- 快照回測金額預設以 USDT 模式導入，禁止在未明示的情況下當作幣種數量，避免實盤風險放大。
- 快照導入後的參數編輯應有清楚語意；若採「原樣導入」，策略參數須鎖定並提示建立後可另行編輯，避免畫面顯示一套、後端保存另一套。
- 所有修改先以測試帳戶驗證，不直接執行真實交易。

## 實作與驗證結果

- 已新增通用快照配置契約：以快照原 `strategyKey` 作唯一引擎身份，完整保存原始配置與來源中繼資料，並為現有版本保留相容配置鍵。
- 快照建立端點不再接受前端覆蓋引擎；伺服器會確認原引擎已註冊，未註冊時拒絕建立並回傳明確錯誤。
- 策略頁改走專用快照建立端點；導入後顯示唯讀快照來源與鎖定引擎，不再要求重新選擇內建策略。
- 回測金額按 `baseLotSizeMode` 還原；舊快照缺少模式時採 `usdt` 安全預設，並保留合法 `0`／`false`。
- 自動交易訊號產生器、策略停止／重置及運行狀態保存均會保留並使用身份一致的完整快照配置，未知未來策略亦沿用同一契約。
- 完整回歸驗證從空白可重建回測快取通過：31 個測試檔案、387 項測試全部成功；`pnpm check` 成功；生產建置成功。僅有既有前端 bundle 體積警告，與本次修復無關。
- 已把 SQLite `*.db-wal`／`*.db-shm` 執行期快取加入忽略規則，並從版本控制移除舊檔；避免未追蹤主資料庫與舊 WAL／SHM 被拼成不一致組合而令完整測試誤報資料庫損壞。
- 本機 HTTP 頁面與前端入口均回應 200；自動化瀏覽器在未登入狀態會被既有 OAuth 流程導向，預覽代理亦一度回傳限流，因此無法在無憑證工作階段完成快照對話框的最終視覺點擊驗證。此限制不是 React 編譯或路由錯誤，正式環境仍需由已登入帳戶以測試帳戶資料執行一次人工驗收。
