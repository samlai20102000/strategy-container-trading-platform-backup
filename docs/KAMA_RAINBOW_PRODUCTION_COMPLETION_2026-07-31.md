# Kama彩虹馬丁策略生產完成報告

> **金融風險聲明：**本文件是軟體工程與量化系統驗收記錄，不構成投資建議、收益保證或實盤啟用授權。自動交易可能造成部分或全部本金損失；本次交付刻意維持策略未建立、未啟用、未送單。

| 文件欄位 | 完成狀態 |
|---|---|
| 專案 | `策略容器化自動交易平台-的副本` |
| 策略 | **Kama彩虹馬丁策略** |
| Canonical key | `KAMA_RAINBOW_MARTIN_V1` |
| Config version | `kamaRainbowMartin.v1` |
| Logic revision | `kama-rainbow-martin-v1` |
| 完成日期 | 2026-07-31 |
| 作者 | Manus AI |
| 工程狀態 | **生產功能、整合、測試與觀測已完成** |
| 交易狀態 | **未建立 instance、未啟用、未送單** |

## 1. 執行結論

原規劃已依批准值完成為一條獨立、版本化、可回測、可快照、可部署且可觀測的 canonical 策略鏈。新策略使用獨立 key、私有配置、runtime namespace 與 reason codes，不與來源「七彩虹線趨勢跟蹤階梯馬丁策略」共用 mutable state；策略數學、入場、馬丁、hard stop、stepped trailing 與模式決策均由同源 TypeScript 契約驅動。[1] [2]

| 最終判定 | 結果 | 證據摘要 |
|---|---|---|
| Canonical 策略是否完成 | **通過** | 獨立 key、config version、logic revision、normalizer、validator、stable line IDs 與 reason code 契約已建立[1] |
| S1／M2／H3 是否完成 | **通過** | S1 guarded executor、M2 independent legs、H3 primary／hedge guard、precise leg close 與 flat gate 已接入[3] [4] |
| 全平台是否貫通 | **通過** | 策略 CRUD、回測、快照、Dashboard、訊號／交易／輪詢日誌及部署工作台均接入[5] [6] [7] [8] [9] [10] |
| 來源策略是否隔離 | **通過** | 新檔、新 namespace、新 key；完整回歸測試承認 KRM 新增但維持既有 Rainbow／V4.1 契約[11] |
| 是否自動啟用或送單 | **否** | 最終唯讀資料庫稽核顯示 KRM instance 為 0；因此 enabled、ARMED／ACTIVE 與其 decision／intent／fill／signal／trade 關聯均為 0 |
| 是否已發布功能碼 | **是** | 穩定 checkpoint 建立後由專案既有自動發布流程上線；交付訊息記錄版本 ID |

## 2. 實際交付範圍

### 2.1 Canonical config、KAMA 與訊號核心

正式契約支援 2–32 條動態 KAMA 線，預設為 `Fast KAMA(10,2,30)` 與 `Slow KAMA(20,2,30)`。每條線具有 stable ID、名稱、顏色、ER、fast、slow 與啟用狀態；`fast > slow` fail closed，`fast = slow` 保留為退化 EMA 並產生警告。百分比統一以百分點保存，五層含底倉 L1，移除沒有執行語義的 target profit。[1]

| 核心能力 | 實作結果 |
|---|---|
| KAMA 計算 | 逐棒 ER／SC、固定 seed／warm-up、flat series 安全、batch／streaming 一致 |
| 市場資料 | OKX／Bybit exchange-aware closed-candle provider；M5、M15、M30、H1、H4、D1、W1 |
| Entry | 任意線對 cross／touch lock、全升／全降、mixed／not-ready fail closed、Bar-Lock |
| 持倉優先級 | `KILL／close-only → hard stop → trailing → martingale add`；持倉腿不再重跑入場 KAMA |
| 馬丁 | 固定間距指數層、上一層實際成交價錨定、每事件最多一層、成交後才更新 |
| Trailing | 以加權平均成本計算；實際加倉成交後重置 peak／trigger |

KRM 訊號會封印 action、reason code、execution mode、cycle／leg、layer、config revision 與 event key。歷史記錄缺欄時，UI 明示「未封印」，不以目前策略狀態反推，避免稽核失真。[5] [7]

### 2.2 S1、M2 與 H3 執行語義

三模式皆沿用 canonical deployment policy、owner/account guard、fresh quote、reduce-only、idempotency、reconciliation 與 flat gate。M2 的 LONG／SHORT 腿各自保存 martingale、平均成本與 trailing；H3 以 PRIMARY／HEDGE 關係狀態機運作，預設 `hedge trigger 4% < hard stop 5%`，且保護腿不會取代主腿 hard stop。[3] [4]

| 模式 | 完成語義 | 安全限制 |
|---|---|---|
| S1 `SINGLE_EXCLUSIVE` | 單一方向、帳戶級排他、持倉期間只執行風控 | 未 flat 不開新反向腿 |
| M2 `MULTI_POSITION` | LONG／SHORT independent leg state、獨立 layer／PnL／trailing | action 必須帶 target leg；精確 reduce-only 關腿 |
| H3 `HEDGE_GUARDED` | PRIMARY／HEDGE guard、關係狀態、hedge-first unwind | hedge trigger 必須小於 hard stop；保護腿馬丁預設關閉 |

### 2.3 CRUD、回測、快照與 UI

策略新建、編輯、readback 與快照導入均使用 `__kamaRainbowMartinConfig`；新建與導入預設 disabled，key mutation 與跨 key snapshot 套用會被拒絕。回測中心使用同源 evaluator，納入費用、滑點、確定性 intrabar 事件、終點會計、mode results 與 leg accounting。[6] [12]

| 產品入口 | 交付內容 |
|---|---|
| 策略交易／工作室 | 專用 KAMA 動態表、風控欄、驗證摘要、初始數量估算、disabled 安全提示[6] |
| 回測中心 | Canonical KRM 表單、同源策略分派、三模式結果與 KRM 報告區[12] |
| 參數快照庫 | key／version／revision／checksum 相容性、round-trip、從快照導入 disabled instance |
| Dashboard | KRM runtime、mode、cycle／leg、layer、均價、最後 fill、PnL、trailing、KAMA values／slopes／lock、reason code[8] |
| 訊號日誌 | 封印決策稽核面板；reason、mode、cycle／leg、layer、revision、event key[7] |
| 交易日誌 | 只透過 `trades.signalId` owner-scoped 關聯封印 payload；成交與 PnL 仍以 trade row 為真相[9] |
| Heartbeat 日誌 | 無 schema 變更的 KRM trace envelope；非 KRM 舊日誌相容不變[5] |
| 三模式工作台 | 最近 canonical decisions、mode、outcome、reason、cycle、target leg 與 decision identity[10] |

## 3. 測試與發布驗收

完整驗收在最終程式碼上執行。Vitest 共 **106 個測試檔，其中 105 通過、1 個既有檔略過；894 個案例中 890 通過、4 個略過**。TypeScript 檢查與 production build 均通過；來源 Rainbow、V4.1 與其他內建策略回歸測試同步通過。[11] [13]

| 驗收類別 | 最終結果 |
|---|---|
| TypeScript | **通過**，無型別錯誤 |
| 全套 Vitest | **通過**，105 files passed／1 skipped；890 tests passed／4 skipped |
| Production build | **通過** |
| Targeted KRM | Config、math、entry、management、market data、backtest、snapshot、CRUD、isolation、S1／M2／H3、observability 均通過 |
| 桌面 UI | Dashboard、Signals、Positions、Strategies、Deployments 五頁完成 1280×720 全頁驗收 |
| 行動 UI | 同五頁完成 390×844 全頁驗收；側欄折疊、卡片、表格與工作台可達 |
| Secret scan | 新增 diff 未發現 API key、Bearer token 或雲端 access key literal |
| Diff hygiene | `git diff --check` 通過；未加入大型本地媒體資產 |

近期瀏覽器歷史記錄中曾有一筆 OKX ticker 外部 fetch 失敗與一筆逾時，時間早於最終多頁驗收；最終桌面與行動頁面擷取後未產生新的 4xx／5xx 或 KRM 前端例外。此類外部行情暫時錯誤仍由既有 query error／重試路徑處理，未被誤判為 KRM 決策。

## 4. 零副作用與交易安全證據

最終資料庫檢查只使用 `SHOW COLUMNS` 與 `SELECT`。Canonical lifecycle、mode transition、position cycle、layer event、position leg、hedge relationship、execution decision、order intent、fill 與 Heartbeat 欄位均存在；本輪沒有 schema migration，也沒有新增常駐 daemon 或 `setInterval`，而是接入既有 Heartbeat 週期。[3] [5]

| 唯讀稽核項 | 最終值 |
|---|---:|
| `KAMA_RAINBOW_MARTIN_V1` strategy instances | **0** |
| Enabled instances | **0** |
| `ARMED`／`ACTIVE` instances | **0** |
| 關聯 position cycles／legs | **0** |
| 關聯 decisions／order intents／fills | **0** |
| 關聯 signals／trades | **0** |

由於資料庫中沒有 KRM instance，程式發布不會自行開始模擬盤或實盤交易。未來由 UI 建立時仍會以 `enabled=false` 與 disabled lifecycle 起始，必須另外完成 API 帳戶、preflight、模擬驗證及明確啟用操作。[5] [6]

## 5. 原計畫最終驗收對帳

原報告第 21 節要求所有入口讀寫同一 canonical config、來源策略無行為差異、回測與 runtime 同源、快照 round-trip、三模式按能力解鎖、新建維持 disabled，以及模擬盤前不得有未授權 mutation。上述條件均已由程式、測試、UI 與唯讀資料庫稽核覆蓋。[14]

| 原驗收條件 | 狀態 | 對帳結果 |
|---|---|---|
| 新 key 全鏈路可見 | **完成** | Studio、Backtest、Snapshots、Dashboard、Logs、Workbench 均接入 |
| 單一 canonical config | **完成** | Shared normalizer／validator、runtime、backtest、snapshot 共用版本契約 |
| 來源策略零行為差異 | **完成** | Source regression 全套通過；只更新過時的脆弱字串斷言，不改來源交易規則 |
| KAMA／entry／risk 同源 | **完成** | Pure core 與 server evaluator 被 runtime／backtest 共用 |
| Snapshot fail closed | **完成** | Round-trip、wrong key／version／revision／checksum rejection |
| S1／M2／H3 能力認證 | **完成** | Manifest、leg ledger、hedge guard、preflight、flat gate 與 targeted tests |
| 新建／導入保持 disabled | **完成** | UI、mutation contract 與資料庫最終零 instance 證據 |
| 無未授權實盤 mutation | **完成** | Final decisions／intents／fills／signals／trades 皆為 0 |

## 6. 發布狀態與下一步

本次發布範圍是**生產功能碼與安全契約**，不是交易啟用。穩定 checkpoint 建立後會依專案設定自動發布；版本 ID 由最終交付訊息提供，並可用於版本檢視或回滾。

建議後續先在 OKX 或 Bybit **模擬帳戶**建立 disabled instance，核對商品、帳戶模式、最小量、精度、槓桿、margin budget 與 fresh quote，然後至少持續觀察 48 小時。應人工抽查 closed-bar KAMA、reason code、layer fill、平均成本、trailing、M2 腿隔離及 H3 hedge-first unwind；完成後若要啟用，需另行明確批准，且實盤應再採分階段放量與 kill-switch 演練。

| 後續階段 | 本次是否執行 | 必要條件 |
|---|---|---|
| 建立 disabled KRM instance | 否 | 使用者選擇交易所、API 帳戶、商品、模式與參數 |
| 模擬盤 48 小時驗證 | 否 | Disabled instance 經 preflight 後，由使用者另行批准啟用模擬交易 |
| 實盤 canary | 否 | 模擬驗收通過、另行風險批准、最小倉位、人工監控與 kill-switch |
| 全量實盤 | 否 | Canary 穩定、營運審批、風險限額與回滾演練完成 |

## References

[1]: ../shared/strategies/kamaRainbowMartin.ts "KRM canonical config、normalizer 與 validator"
[2]: ../server/strategies/kamaRainbowMartin/core.ts "KRM deterministic strategy core"
[3]: ../server/services/kamaRainbowMartinAdvancedExecutor.ts "KRM M2／H3 advanced executor"
[4]: ../server/services/kamaRainbowMartinAdvancedSignal.ts "KRM advanced signal sealing"
[5]: ../server/services/autoTradeSignalGenerator.ts "KRM auto signal integration"
[6]: ../client/src/pages/Strategies.tsx "KRM 策略 CRUD 與專用配置接線"
[7]: ../client/src/pages/Signals.tsx "KRM 訊號稽核面板"
[8]: ../client/src/pages/Home.tsx "KRM Dashboard runtime monitor"
[9]: ../client/src/pages/Positions.tsx "KRM 交易日誌 evidence enrichment"
[10]: ../client/src/pages/DeploymentWorkbench.tsx "Canonical recent mode decisions 工作台"
[11]: ../server/kamaRainbowMartin.contract.test.ts "KRM 與來源隔離契約測試"
[12]: ../server/services/backtest/kamaRainbowMartinBacktest.ts "KRM 同源回測器"
[13]: ../server/kamaRainbowMartin.advancedExecutor.test.ts "M2／H3 執行與精確關腿測試"
[14]: ./KAMA_RAINBOW_EXECUTION_PLAN_2026-07-31.md "原始完整規劃與最終驗收定義"
