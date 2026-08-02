# 全策略統一限價與平倉執行契約

## 目的與適用範圍

本契約適用於所有現有策略、內建策略、匯入策略、Webhook、RiskMonitor、V35-family Monitor，以及未來由策略工作室新增的策略。策略只負責產生交易意圖；任何會改變交易所狀態的操作都必須經過 **Runtime Mode Guard → Maker-First Facade → Exchange Adapter**，不得由策略直接呼叫原生 OKX／Bybit adapter。

## 一、風險增加與風險退出必須分流

開倉、加倉、反向開倉及任何可能增加曝險的操作，必須通過完整 canonical deployment、artifact、能力 manifest、execution mode 與 execution policy 驗證；任一不一致均維持 fail-closed。

平倉只能以明確的 `close`／`reduceOnly=true` 意圖進入。當舊部署只因程式升版造成策略邏輯 hash、策略版本、能力 manifest 或 capability snapshot 漂移時，可進入 **reduce-only exit compatibility**；此路徑只能減少既有倉位，不能建立、增加或反轉倉位。

下列情況即使是平倉也必須拒絕：artifact hash／config hash 被竄改、strategy key 不符、能力被撤銷、execution mode／policy 與封印 artifact 不符、部署不存在、持倉方向或數量無法證明。

## 二、策略持倉所有權

平倉前必須取得策略本地持倉真相：`strategyId`、`apiKeyId`、正規化商品鍵、`posSide`、策略擁有數量及平均價。交易所帳戶持倉只用作存在性及後驗確認，不可把同帳戶同商品的整筆合併倉位直接歸給任一策略。

同帳戶、同商品、同方向有多個策略時，每個策略最多只能平自己的本地數量；反向腿、其他策略持倉及未歸屬持倉不得作 fallback。數量或方向無法可靠歸屬時，建立 reconciliation case 並停止自動平倉。

監控器只能把交易所 `size／avgPrice` 用作唯讀漂移證據，不得覆寫單一策略的 `totalSize／avgPrice`。交易所聚合腿大於本地策略數量時，必須保留差額並標示為其他策略或未歸屬持倉；不得由目前策略自動認領。

## 三、限價 Maker-First

一般開倉、加倉與止盈平倉一律使用中央 Maker-First：以最新最佳買賣價建立 Post-Only 限價單，按中央 TTL 觀察成交，未完全成交時撤銷、重新取得行情並只對剩餘數量重掛。策略不得自行改寫下單類型、價格偏移或直接降級為市價。

市價兜底只允許 `EMERGENCY_EXIT`，且理由必須為 `STOP_LOSS`、`DAILY_LOSS_LIMIT` 或 `KILL_SWITCH`。一般止盈超時不得靜默轉市價；應回傳剩餘數量與可重試狀態。

## 四、精確平倉 payload

所有平倉必須同時攜帶正規化 `symbol`、正確 `side`、明確 `posSide`、`reduceOnly=true`、策略擁有的 `requestedSize`、穩定 `clientOrderId／intentId` 及結構化 `policyContext`。不得以相反方向腿代替，也不得省略雙向持倉模式所需的 `posSide`。

`requestedSize` 必須是由策略本地 ownership 證明的有限正數，且不得大於交易所對應腿。它只能經 `CloseExecutionOptions.requestedSize` 傳遞；`closePositionSmart` 的既有第三參數仍是 `timeoutMs`，禁止再把策略數量塞入 timeout 位置。省略、無效或超額時必須在送單前零 mutation 拒絕，亦不得退回「平整個交易所聚合腿」的舊行為。

相同平倉意圖的重試必須沿用穩定識別；同一策略只允許一個 in-flight 平倉。失敗採持久化指數退避，跨程序及重新部署後仍有效，禁止每個輪詢週期建立新意圖。

## 五、成交與後驗真相

`success=true` 只能代表中央執行層已確認指定方向的策略擁有數量完成減倉，或交易所已證明該方向歸零。部分成交必須回傳 `filledSize`、`remainingSize`、逐筆子結果及 `partially_filled`，後續只處理剩餘數量。

共享聚合腿的平倉後驗以 `initialExchangeSize - requestedSize` 為預期剩餘量；其他策略持倉仍存在並不是本次策略平倉失敗。只有實際剩餘量高於容差後仍大於預期值，才可判定本次 requested size 未完成。

限價送單、接受、等待、部分成交、撤單、重掛、市價緊急兜底及持倉後驗都必須寫入 order policy events。失敗訊號必須保存 Gate／Maker／Exchange 層級、`reasonCode`、交易所錯誤、intent、方向、數量及下一次允許重試時間，不得只顯示泛化「平倉失敗」。

## 六、新策略接入門檻

未來策略只能透過共用 executor 或認證 runner 呼叫交易；註冊時必須宣告 capability manifest、支援 execution mode、持倉狀態 schema 與平倉所有權解析方式。架構測試需阻擋直接實例化交易所 adapter、繞過 Maker-First、缺少穩定 intent、未傳 `posSide／reduceOnly` 或自行實作市價 fallback 的新程式碼。

任何新策略若未通過 one-way／hedge、long／short、limit／market、partial fill、TTL、重複命令、版本漂移安全退出與後驗確認測試，不得標記為 LIVE-ready。
