# KAMA 三K突破 V2.5 文件規格摘錄

來源：`/home/ubuntu/upload/pasted_file_kiky4g_kama26線3K馬丁策略執行命令.txt`（共 1215 行）。此筆記保存使用者提供文件的外部需求；實作須依目前 React／tRPC／策略註冊中心架構轉譯，不直接嵌入不相容的裸 HTML/DOM 腳本，也不得修改既有策略邏輯。

## 交付範圍

文件包含四包：PACK 1 TypeScript 策略核心、PACK 2 六分區深色 UI 與動態馬丁範圍表、PACK 3 UI→`context.params` 映射、PACK 4 七階段部署與回測驗收 SOP。使用者要求新策略必須獨立接入策略工作室、策略交易、回測、參數快照與自動／手動／Webhook 執行鏈路，介面不可只是空殼。

## 策略身份與預設值

- 文件名稱：`KAMA_3K_Breakout_V2.5`；程式類別：`KAMA_3K_Breakout_V2_5`。
- 平台穩定 key 定為 `KAMA_3K_BREAKOUT_V25`，顯示名稱為 `KAMA 三K突破 V2.5｜階梯式馬丁`，版本為 `2.5.0`；前後端共享契約位於 `shared/strategies/kama3kBreakoutV25.ts`。
- KAMA 快線：`er=50, fastest=10, slowest=2`。
- KAMA 慢線：`er=50, fastest=10, slowest=6`。
- `baseLot=100.0`；硬止損 `slPct=3.0`；固定止盈 `tpPct=1.0`。
- 追蹤止盈預設開啟：啟動 `0.8%`、回撤 `0.4%`。
- 馬丁預設開啟，範圍為 `1–3: 1.2x / 0.8%`、`4–6: 1.1x / 1.2%`、`7–10: 1.0x / 2.0%`。
- 原地重入預設開啟。

## 核心交易邏輯

1. 每次決策讀取至少三根 K 線；前兩根為已完成 K 線，第三根為當前 K 線，突破判斷包含影線。
2. 多頭入場：快 KAMA > 慢 KAMA、前兩根皆陽線、當前高點突破前兩根最高價。
3. 空頭入場：快 KAMA < 慢 KAMA、前兩根皆陰線、當前低點跌破前兩根最低價。
4. 出場優先級：硬止損 > 追蹤止盈 > 固定止盈。百分比以持倉均價與當前價格的名義價格變動計算，不乘槓桿。
5. 追蹤止盈以持倉期間最高浮盈為峰值，峰值達啟動門檻後，回撤達 callback 即平倉。
6. 固定止盈只在追蹤止盈關閉，或尚未達追蹤啟動門檻時觸發。
7. 止盈平倉後若入場條件仍成立且無持倉，可原地重入；硬止損或其他平倉不可觸發止盈重入。
8. 馬丁下一層依 `martinRanges` 查找；多單從上次入場價下跌指定 gap 加倉，空單從上次入場價上漲指定 gap 加倉。
9. 文件示例的 `addSize = baseLot * range.multiplier` 是每層範圍倍率語義；UI 另顯示範圍累積倍數供曝險預覽。實作時須明確區分「該層下單量」與「累積曝險」，並以實際成交資料更新持倉狀態。

## 參數契約

| 參數 | 類型 | 文件 UI 範圍／語義 |
|---|---:|---|
| `kamaFast.er` | number | 5–200，整數 |
| `kamaFast.fastest` | number | 2–20，整數 |
| `kamaFast.slowest` | number | 1–10，整數 |
| `kamaSlow.er` | number | 5–200，整數 |
| `kamaSlow.fastest` | number | 2–20，整數 |
| `kamaSlow.slowest` | number | 1–10，整數；文件提示須大於快線 slowest |
| `baseLot` | number | ≥1 USDT，0.1 精度 |
| `slPct` | number | 0–10%；0 關閉 |
| `tpPct` | number | 0–10%；0 關閉 |
| `trailingTpEnabled` | boolean | 追蹤止盈開關 |
| `trailingTpActivation` | number | 0.1–5.0% |
| `trailingTpCallback` | number | 0.05–3.0% |
| `martinEnabled` | boolean | 馬丁開關 |
| `martinRanges` | array | 至少一段；第一段 start=1；每段 end≥start；下一段 start=上一段 end+1；multiplier 0.1–5.0；gap 0.1–20.0% |
| `reentryEnabled` | boolean | 止盈後原地重入開關 |

所有合法 `0` 與 `false` 必須在表單、API、資料庫、快照、回測與實盤往返中保留，不可用 `|| default` 覆蓋。`martinRanges` 為陣列，不以 JSON 字串作為系統內部真相；僅在複製摘要或相容邊界序列化。

## 六大 UI 分區

1. KAMA 動能參數：快／慢線各三欄。
2. 交易與資金：底倉金額；時間框架由回測／部署設定控制。
3. 三重出場：硬止損、固定止盈、追蹤止盈開關、啟動門檻、回撤幅度。
4. 階梯式馬丁：開關、總層數／底倉+加倉摘要、範圍表（起始、結束、乘數、間距、累積倍數、刪除）、新增範圍、曝險警示。
5. 原地重入：開關與同 K 線風險說明。
6. 參數摘要：即時 JSON 與複製功能。

文件視覺基調為深藍黑、紫藍聚焦、綠色狀態、橙色警示。實作應沿用現有 shadcn/Tailwind 設計 token、可存取焦點、響應式表格、明確錯誤與風險摘要，而非貼入裸 `<style>`／`<script>`。

## 動態馬丁表需求

- 預設三段；總層數取最後一段 end。
- 新增範圍自動接續前段 end+1；至少保留一段。
- 調整或刪除後自動重新編號以維持連續，不產生重疊或斷層。
- 累積顯示算法：從 1.0 開始，對每段計算 `cumulative *= multiplier^(end-start+1)`；預設三段顯示約 `1.73x`、`2.30x`、`2.30x`。
- UI 必須顯示「底倉 + N 次加倉」及高曝險警示；文件建議不超過 10 層與帳戶資金 20%，但使用者既有偏好要求系統不可硬性固定 20 層上限，因此僅警示，不設固定層數上限。

## 文件 SOP 驗收

- 策略能在策略工作室／註冊中心辨識並編譯。
- 回測中心下拉可選新策略；回測、實盤不可疊加另一套內建止盈／止損／馬丁造成雙重邏輯。
- UI 預設三段、動態新增／刪除／修改、連續編號、累積倍數、JSON 摘要與複製都需可用。
- 回測交易明細需能辨識追蹤止盈、階梯式馬丁加倉與原地重入原因。
- 文件示例回測條件為 BTCUSDT、15m、2026-01-01～2026-07-20、初始資金 10,000 USDT；其 `總回報 >15%` 與 `最大單筆虧損 < -80 USDT` 是資料依賴的示例門檻，不能作為無條件軟體正確性保證，應以可重現數據與邏輯斷言驗收。

## 架構與安全決策

- 此為確定性量化策略，不需要 LLM 判斷；沿用站內 tRPC、交易所 API、Webhook 與平台 Heartbeat。
- Autoscale 環境禁止新增 `setInterval`、`node-cron` 或常駐子程序；自動策略應由既有 `/api/scheduled/*` Heartbeat 入口驅動。
- 不建立新的真實交易或啟用自動模式作為開發驗收；瀏覽器驗收只檢查 UI、回測、快照與控制可用性。
- 必須新增 Vitest，並執行完整 TypeScript、測試與生產建置，證明未回歸既有策略。

## 現有系統接入面稽核

| 模組 | 現況 | V2.5 接入決策 |
|---|---|---|
| `server/strategies/base.ts` | `BaseStrategyV35` 已定義非同步決策、完整 `StrategyState` 與 `StrategyAction` | V2.5 建立獨立子類；KAMA、三K、出場、馬丁與重入判斷放入可被實盤和回測共用的純核心 |
| `server/services/strategyStudio.ts` | 內建策略以明確 import、保護 key 清單與初始化註冊 | 使用穩定 key `KAMA_3K_BREAKOUT_V25` 加入保護清單與初始化，不覆寫任何既有 key |
| `server/services/registryManager.ts` | 記憶體內建策略會出現在工作室、回測與策略建立清單 | 由 V2.5 `defaultConfig` 提供真實預設；前端另有專用面板，不依賴空殼式動態表單 |
| `server/routers.ts` | 各版本配置存入 `martinState.__v*Config`；建立與更新均需明確版本契約 | 新增 `v25Config` Zod 契約與 `__v25Config` 持久化，建立／更新共用同一正規化及校驗器 |
| `server/services/strategySnapshotConfig.ts` | `__snapshotConfig`／`__snapshotMeta` 已支援新引擎及合法 `0`／`false` | 通用快照為真相來源；另映射 `__v25Config`，讓直接建立與快照建立讀取同一配置 |
| `server/services/autoTradeSignalGenerator.ts` | 自動模式在一次 Heartbeat 中取 K 線、對賬並按 key 產生訊號 | 新增 V2.5 分支呼叫共用純核心，不建立額外常駐程序 |
| `server/services/executor.ts` | 專用版本管線負責 Bar-Lock、真實成交狀態、交易紀錄與落單 | 新增隔離 V2.5 管線；手動、Webhook、自動訊號共用落單／平倉／數量正規化／狀態更新 |
| `server/services/backtest/backtestEngine.ts` | 未知策略會落入通用回測，無法覆蓋 V2.5 交易語義 | 新增專用回測，逐 K 呼叫同一純核心並保留各事件原因 |
| `client/src/pages/Strategies.tsx` | 策略建立表單已有版本配置、編輯回填及快照引擎鎖定 | 加入 `v2_5` 狀態、`v25Config` 提交／回填與專用面板；快照模式只讀原始配置 |
| `client/src/pages/Backtest.tsx` | 策略清單來自註冊中心；特定策略可使用深度面板 | V2.5 使用同一專用面板與序列化器，鍵名與新增策略、快照完全一致 |

## 單一配置與持倉語義決策

V2.5 唯一扁平配置鍵為 `KAMA_Fast_Length`、`p2_fastest`、`p3_slowest`、`KAMA_Slow_Length`、`q2_fastest`、`q3_slowest`、`Hard_Stop_Loss_Pct`、`Take_Profit_Pct`、`Trailing_TP_Enabled`、`Trailing_Activation_Pct`、`Trailing_Callback_Pct`、`Base_Lot_Size`、`Martin_Enabled`、`Martin_Ranges`、`Reentry_On_Trend`、`K_Line_Period`。`Martin_Ranges` 在系統內部一律為結構化陣列，不建立另一份倍率或間距真相來源。

第一筆成交是**第 0 層底倉**；`Martin_Ranges` 從第 1 層描述後續加倉，最大加倉層數由最後一段 `end` 動態推導，不設固定 20 層上限。下一層金額為 `Base_Lot_Size × 該層 multiplier`，觸發價以最後一次實際成交價為基準，價格不利偏移達該層 `gap%` 時觸發，避免把文件倍率誤作遞迴指數倉位。

## 自動化驗收紀錄

2026-07-25 新增 `server/v25-strategy.test.ts`，共 17 項確定性測試，覆蓋參數正規化、合法 `0`／`false`、動態馬丁、KAMA 三K多空入場、三重出場、實際成交狀態、止盈重入、同 K 棒去重、註冊、快照綁定與公開回測引擎。V2.5 專屬測試為 17／17 通過；全專案 Vitest 為 32 個測試檔、404／404 項通過。

## 視覺驗收診斷紀錄

2026-07-25 首次以專案預覽網址擷取 `/strategies` 與 `/backtest` 桌面完整頁面時得到純白畫面；以已連線瀏覽器重開 `/strategies` 後只解析到頁面標題，沒有互動元素。前端錯誤與網路日誌未命中 `Uncaught`、`TypeError`、`401／403／404／500`。此項暫列為預覽／載入診斷中，不能把純白截圖當成 UI 驗收通過證據。

進一步以無頭 Chromium 直接讀取同一預覽網址後，實際 DOM 為代理回應 `Too many requests. Please try again later.`，證實白畫面來自預覽代理限流，而非 V2.5 React 例外；同時伺服器日誌顯示 V2.5 已註冊，tRPC 策略清單與回測活動查詢均為 HTTP 200。因本機無頭 Chromium 在沙箱 GPU 行程限制下無法穩定完成登入頁面渲染，後續改採安全候選版本自動發布後，在使用者已登入的生產網域做桌面與手機驗收。
