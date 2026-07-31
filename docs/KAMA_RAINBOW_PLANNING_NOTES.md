# Kama彩虹馬丁策略規劃工作底稿

> 狀態：**僅規劃分析**。本文件不是投產規格，也不構成任何功能、資料庫、排程、部署或交易所狀態變更。

## 1. 任務邊界

使用者要求在現有「策略容器化自動交易平台-的副本」中新增獨立策略「Kama彩虹馬丁策略」，以「七彩虹線趨勢跟蹤階梯馬丁策略」的完整功能與 UI 為複製基礎，再依 `/home/ubuntu/upload/pasted_content.txt` 全面更換策略邏輯、移除文件未要求的多餘功能，並同步更新策略交易、策略新建／編輯、回測中心、參數快照庫、從快照導入、策略工作室及 S1／M2／H3 三模式部署。來源策略不得被修改，新策略不得自動啟用或送單。

## 2. 規格文件需求摘錄

### 2.1 動態 KAMA

- KAMA 清單由 UI 動態增刪，每列包括：`enabled`、`name`、`er`、`fast`、`slow`、`color`。
- 啟用線最少兩條；UI 修改後配置需持久化並在下一根所選週期的已收盤 K 線生效。
- 每條 KAMA 均需保留當前值與前一根值，所有啟用線使用同一交易對、同一時間週期、同一組已收盤 close 序列。
- 文件提供的週期選項為 M5、M15、M30、H1、H4、D1、W1，預設 M30。

### 2.2 無持倉入場

- 只在無持倉時判斷新入場。
- 任意兩條啟用 KAMA 在前一根與當前已收盤 K 線之間發生相對位置反轉時，入場鎖定。
- 沒有交叉時，所有啟用 KAMA 均向上才建立多向候選；所有均向下才建立空向候選；混合方向不入場。
- 文件用語「持倉豁免交叉」的實質含義是：持倉期間 KAMA 交叉不觸發平倉、不阻止馬丁、不改變風控；並非允許同一 S1 持倉重複開底倉。

### 2.3 持倉管理

- 有持倉時，最高優先級分支完全跳過 KAMA 入場／交叉判斷，只執行馬丁、移動止盈與硬止損。
- 多單在價格相對上一層成交價向下達 `gap_percent` 時加倉；空單對稱地向上達間距時加倉。
- 加倉量為初始量乘以 `multiplier ** layer`，並重新計算加權平均成本。
- 文件 UI 預設：層數 5、乘數 2.0、間距 2.0%、目標利潤 1.5%；但「目標利潤」未在提供的風控示例中被實際使用。
- 移動止盈 UI 預設：啟動 3.0%、回撤 1.5%、步長 0.5%、開關 ON。
- 硬止損示例為 5.0%，並註明 UI 可調；多空需完全對稱。

### 2.4 UI 與可觀測性

- 動態 KAMA 表格需支援新增、刪除、啟用、名稱、三參數與顏色；刪除後至少保留兩條有效線。
- 監控區顯示每條 KAMA 當前值與方向、入場權限／交叉鎖定、持倉方向、馬丁層數、移動止盈狀態及今日盈虧。
- 所有交易事件需包含底倉、加倉、平倉、價格與損益追蹤。

### 2.5 驗證要求

- KAMA 數學需有獨立單元測試，並與可信基準實作交叉驗證。
- 至少使用 100 根歷史 K 線，刻意覆蓋 KAMA 交叉；驗證持倉期間交叉不影響馬丁與離場管理。
- 回測、實盤／模擬盤、快照 round-trip 與 UI 配置必須使用同一 canonical config 與同源 evaluator。

## 3. 已確認的來源策略身份

- 顯示名稱：**七彩虹線趨勢跟蹤階梯馬丁策略**。
- canonical `strategyKey`：**`RAINBOW_TREND_LADDER_V1`**。
- 來源策略能力目前在 `server/services/strategyCapabilityRegistry.ts` 登記為 version 1、logic revision `rainbow-trend-ladder-v1`、`advancedCertified: false`。
- 來源策略在 `server/services/strategyStudio.ts` 被列為內建保護策略，並宣告 `martingaleLayers: true`。
- 專用快照配置鍵為 `__rainbowTrendLadderConfig`。

## 4. 已發現的主要實作觸點

| 層級 | 已確認檔案或入口 | 角色 |
|---|---|---|
| 共用契約 | `shared/strategies/rainbowTrendLadder.ts` | strategyKey、canonical config、normalizer、validator、預設值與策略純函式 |
| 來源 UI | `client/src/components/RainbowTrendLadderConfigPanel.tsx` | 策略／回測／快照共用配置面板 |
| 安全 UI | `client/src/components/RainbowTrendLadderSafetyControls.tsx` | 專用安全狀態與 KILL 操作 |
| AI 研究 UI | `client/src/components/RainbowTrendLadderAiAdvisor.tsx` | 風險優先參數研究建議；是否保留須按新文件的「未提及即刪除」原則決策 |
| 策略交易 | `client/src/pages/Strategies.tsx` | 新建、編輯、回讀、快照／回測導入、提交與卡片 |
| 回測 | `client/src/pages/Backtest.tsx`、`server/routers/backtest.router.ts` | 回測配置、快照覆核與後端策略分派 |
| 快照 | `client/src/pages/ParameterSnapshots.tsx`、`server/services/strategySnapshotConfig.ts` | 詳情顯示、canonical 配置鍵與導入 |
| 實盤執行 | `server/services/executor.ts` | `executeSignalRainbowTrendLadder` 專用管線與 guarded mutation 接線 |
| 策略註冊 | `server/services/strategyStudio.ts` | 內建策略登記與能力宣告 |
| 三模式能力 | `server/services/strategyCapabilityRegistry.ts` | artifact、S1／M2／H3 能力與認證 |
| AI router | `server/routers/rainbowTrendLadderAi.router.ts` | 來源策略專用研究建議後端；是否刪除待決 |
| 測試 | `server/rainbow-trend-ladder-*.test.ts` | 配置、核心、回測、管理與隔離契約 |
| 稽核文件 | `docs/rainbow-trend-ladder-isolation-audit-2026-07-25.md` | 來源策略隔離與安全證據 |

## 5. 文件不可直接照抄的技術問題

### 5.1 KAMA 示例並非可直接採用的最終演算法

文件示例只用最新一個 ER 計算單一平滑常數，再用該常數回放整段歷史 close；標準 KAMA 應在每個時間點重新計算該點 ER 與平滑常數。示例的 warm-up、索引區間、資料不足時直接回退最新價，以及初值方法也需定義為版本化規則。投產前必須建立單一純函式、固定 warm-up 與可信基準向量，而不能逐字複製示例。

### 5.2 `current`／`previous` 初始化不完整

新載入配置後第一輪 `previous` 為空，文件的兩兩比較會出現未定義行為。新設計需至少有兩根已收盤 KAMA 值，並對缺資料、相等、非有限值與配置熱更新採 fail-closed。

### 5.3 百分比單位混用

示例把 `activation`、`callback`、`step` 除以 100，但 `profit_pct` 又乘以 100，兩者單位不一致；同時硬止損寫死為 5.0。canonical config 必須統一「UI 百分點」與「內部小數」的轉換邊界，且所有風控值只能由配置讀取。

### 5.4 馬丁層級語義有 off-by-one 風險

示例底倉將 `layer = 0`，UI 又稱總層數 5；未說明 5 是「含底倉」還是「五次加倉」。新契約必須明確 L1 為底倉，`Max_Layers` 是否包含 L1，以及乘數指數與最後一層的唯一算法。

### 5.5 文件中的未接線參數

「目標利潤 1.5%」在示例離場函式沒有使用；移動止盈 ON 開關也沒有包住計算分支。報告需要求使用者在投產前確認：目標利潤是獨立固定止盈、移動止盈啟動前的退出線，還是應刪除。

### 5.6 技術棧與資料真相衝突

文件要求另建 Python／Streamlit／JSON／CSV 專案，但本任務明確是在既有 React／TypeScript／tRPC／Drizzle／交易所轉接器平台內複製並整合策略。建議把文件當作**功能與數學規格**，不另建旁路 Python 系統；配置存於現有 owner-scoped DB／artifact，交易寫入既有 signal／trade／ledger，不以本地 JSON 或 CSV 作執行真相。

### 5.7 多交易對與三模式衝突

文件主迴圈硬寫 `BTCUSDT` 且以單一 `has_position` 分支描述 S1。現有平台支援可選交易對及 S1／M2／H3；新策略需產生方向候選意圖，由 canonical mode engine 按 deployment／leg 決定是否准入，不可把全帳戶是否有任意持倉當作唯一 Gate。

### 5.8 排程與交易安全

不得新建 `setInterval`、獨立 Python daemon 或繞過現有 Heartbeat。所有新開倉、加倉、減倉與平倉均須經現有 `runtimeGuardedAdapter`；策略預設 DRAFT／disabled，未通過 deterministic preflight 不可 ACTIVE。

## 6. 待深入核對

- 讀取 `shared/strategies/rainbowTrendLadder.ts` 的完整配置與純函式，建立逐欄位保留／刪除／替換矩陣。
- 讀取專用 executor、回測分派、管理函式與測試，確認所有間接依賴與來源策略不可共用的 mutable state。
- 盤點 `_strategies_dynamic_schema.tsx`、策略模板／registry、快照 artifact、部署 preflight 及三模式認證實際接線。
- 確認新策略是否需要保留來源策略的 AI 參數研究、KILL、專用帳戶限制、點差／滑點／保證金鐵幕；依「文件未提及即刪除」原則，安全底座不可刪，但策略特有功能須在報告中逐項請示。
- 形成投產前必答問題與推薦預設，避免把文件歧義硬編碼成不可逆交易行為。

## 7. 來源策略實作基線（已核實）

### 7.1 canonical 契約與執行邊界

- `shared/strategies/rainbowTrendLadder.ts` 是來源策略的 canonical config／normalizer／validator／純函式入口；新策略不可沿用其 `strategyKey`、`__rainbowTrendLadderConfig` 或 mutable runtime namespace。
- `server/strategies/rainbowTrendLadder/core.ts` 將來源策略的七線 SMA 快照、四重入場條件、成交後狀態及重置綁在一起。KAMA 新策略只可重用無副作用的結構模式，不可保留七線 SMA、L5 穿越、L6／L7 區間或來源 reason code。
- `server/strategies/rainbowTrendLadder/management.ts` 封裝來源策略的持倉管理、階梯加倉、追蹤止盈、趨勢反轉、保證金與 KILL。文件未要求的「基礎趨勢線反轉離場」必須從新策略 evaluator 完全移除；帳戶所有權、fail-closed 報價、KILL 與 guarded mutation 屬平台安全底座，不得因「多餘」而刪除。
- 內建橋接類 `server/strategies/builtin/strategyRainbowTrendLadder.ts` 只把來源策略掛入 `BaseStrategy`；其訊息、runtime namespace 與 Live armed 驗證均為來源專用，不能共用。

### 7.2 CRUD 與持久化接點

- `server/routers.ts` 的 create／update 對來源策略有獨立 `rainbowTrendLadderConfig` 輸入與 `__rainbowTrendLadderConfig` 寫入分支，並衍生 `takeProfitPct`、`martinMultiplier`、`maxMartinLevel`、`martinSpacingPct`、`kLinePeriod`、`reentryEnabled` 等通用欄位。
- 新策略必須新增獨立 API 欄位及私有配置鍵，建議命名為 `kamaRainbowMartinConfig`／`__kamaRainbowMartinConfig`；任何策略 key 變更均需禁止把既有來源實例就地換引擎，以免狀態污染。
- 新建與快照導入的既有安全行為是 `enabled=false`、`activationState=DISABLED`，且必須重新通過版本、能力、交易所與持倉 preflight。此行為應原樣保留。

### 7.3 回測與快照

- `server/services/backtest/rainbowTrendLadderBacktest.ts` 是來源策略專用模擬器，而非通用 UI 轉接。它維持策略狀態、聚合管理 K 線、模擬成交、逐層成本、期末權益與斷點續跑。
- 來源回測目前另含 `Force_Close_On_Day_Start` 與 `Max_Hold_Hours` 強制離場；新文件沒有這兩條，故新策略回測與實盤 evaluator 都不得包含。`Backtest_End_Position_Policy` 是模擬報表的終點會計政策，可保留但必須標明不屬於交易策略規則。
- `server/routers/backtest.router.ts` 的 `applySnapshot` 與 `importSnapshotAsNew` 強制同一 `strategyKey`、驗證 artifact compatibility、更新私有 config、衍生通用欄位並將實例停用。新策略必須加入完全平行的正規化與衍生分支，且快照不可套用到 `RAINBOW_TREND_LADDER_V1`。
- `server/services/strategySnapshotConfig.ts` 以 strategyKey 對應私有 config 鍵；新策略需新增唯一鍵與 round-trip 測試。

### 7.4 三模式部署事實

- `server/services/strategyStudio.ts` 把來源策略列為受保護內建 key，`martingaleLayers=true`，但 `ADVANCED_MODE_KEYS` 不包含來源策略，所以來源策略現在只允許 `SINGLE_EXCLUSIVE`（S1）。
- `server/services/strategyCapabilityRegistry.ts` 把來源 release 標為 `advancedCertified=false`，manifest certification 為 `S1_ONLY`。
- 因此「完整複製來源功能」不等於自動取得 M2／H3。若新策略要三模式一致，必須先完成 independent leg state、hedge guard、precise leg close、canonical advanced runner 與 multi-leg ledger 測試，再把能力從 S1_ONLY 提升；未通過前 UI 應顯示模式不可用理由而非繞過能力註冊。

## 8. 來源 UI 的保留／替換／刪除基線

| 來源區塊 | 新策略處置 | 理由 |
|---|---|---|
| 任務時序與配置底倉 | 改寫 | 週期改為 M5／M15／M30／H1／H4／D1／W1 動態選擇；底倉單位與平台 position policy 維持單一真相 |
| 七線 SMA 戰術陣列 | 完全替換 | 改為可增刪 KAMA 表：enabled、name、ER、fast、slow、color，至少兩條有效線 |
| 階梯馬丁矩陣 | 改寫 | 文件只給 max layers／multiplier／gap；必須先決定是否仍允許逐層 lot／gap 表，否則刪除來源逐層自訂能力 |
| 動態止盈與趨勢反轉 | 部分保留 | 保留 trailing activation／callback／step／enabled；刪除 Trend_Base_Line、Trend_Deviation_Points 與趨勢反轉離場 |
| 交易品質鐵幕 | 保留平台安全底座 | 點差、滑點、保證金與缺報價 fail-closed 不是策略 alpha，但不能刪除 |
| 隔離、安全與 KILL | 保留並改文案 | 專用帳戶、所有權、KILL、預設未武裝是交易安全邊界；來源名稱與 M30 固定文案須替換 |
| 回測與持倉控制 | 大幅刪減 | 刪除 `Max_Hold_Hours`、`Force_Close_On_Day_Start`；保留模擬終點政策但歸入回測設定而非策略配置 |
| AI 參數研究 | 預設刪除 | 文件未要求，且其 router／prompt／schema 全為來源 V1 專用；除非使用者明確要求保留 |

來源 UI 同時在策略新建／編輯、回測、快照詳情與快照導入流程重用；新策略面板不能只在 `Strategies.tsx` 加一次，而需以新 key 在所有分派點顯式掛載。

## 9. 新增的投產前必答問題

1. 「最大馬丁層數 5」是否**包含底倉 L1**？建議包含；即最多四次加倉。
2. `multiplier ** layer` 的 `layer` 是否從 0 起算？建議 L1 指數 0、L2 指數 1，讓底倉為 1×。
3. 「上一層成交價」加倉間距是否每層重新錨定實際成交價？文件文字是肯定；這與來源策略「原始入場價累積距離」不同，必須改寫。
4. 「目標利潤 1.5%」是固定止盈、trailing activation 的別名，或應刪除？目前文件示例未接線，不能自行猜測。
5. trailing `step` 應代表峰值每增加 0.5% 才移動一次停利線，還是僅 UI 顯示粒度？必須定義，否則同一輸入在回測與實盤會不同。
6. 文件示例把硬止損寫死 5%；建議正式欄位命名 `Hard_Stop_Loss_Pct`，UI 可調且多空對稱。
7. KAMA `fast`／`slow` 的語義是 EMA 常數週期，且應要求 `fast < slow`；文件預設列如 `(20, 5, 30)` 支援此解讀，但示例命名易與現有平台其他 KAMA 版本混淆。
8. 是否保留來源 AI advisor？建議不保留，以符合「文件未提及即刪除」。
9. 是否要求首版即可 M2／H3？建議分兩關：先完成 S1 同源與模擬認證，再在同一變更集內完成 M2／H3 證據後才解鎖，不可先宣稱支援。

## 10. KAMA 數學的外部交叉驗證

StockCharts ChartSchool 對標準 KAMA 的描述是：每一期間先用 `Change / Volatility` 求 ER，再以該 ER 求當期 SC，最後遞迴計算 `Current KAMA = Prior KAMA + SC × (Price - Prior KAMA)`；MetaTrader 5 的文件同樣以 `ER(i)`、`SSC(i)` 與 `AMA(i)` 表示每一時間點均有自己的效率比與平滑常數。[1] [2]

因此，附件示例把最新一個 ER／SC 套用至整段歷史序列，不能直接作為投產公式。正式實作應以**逐棒 ER／逐棒 SC／遞迴 KAMA**為唯一 canonical 算法，並把 seed、warm-up、零波動、缺資料與非有限值政策納入版本化測試向量。

## 11. 已確認的資料週期與市場資料缺口

- 現有 `fetchKLineData()` 雖接收 `ExchangeAdapter`，實際上固定呼叫 OKX 公開 candles API；若策略 instance 選 Bybit，訊號仍會由 OKX K 線產生。新策略不可照抄此行為，必須改用 exchange-aware candle provider，且回測、paper、live 必須固定同一交易所／商品／週期語義。
- 現有 minutes 映射會把 W1 的 `10080` 分鐘轉成 `7D`，而規格要求的是 W1；必須建立受驗證的 enum 映射 `M5/M15/M30/H1/H4/D1/W1 → exchange interval`，不能以任意除法生成 interval。
- 動態 KAMA 所需歷史長度不能沿用文件的 `max(er, slow)+10` 粗略規則；正式 provider 應依 canonical warm-up 計算需求取足已收盤 candles，若資料不足則 fail-closed，不以最新價假裝 KAMA。

## 12. 欄位級處置草案

| 類別 | 來源欄位／功能 | 新策略處置 |
|---|---|---|
| 身份 | `RAINBOW_TREND_LADDER_V1`、`rainbowTrendLadder.v1`、`__rainbowTrendLadderConfig` | 全部隔離；建議新建 `KAMA_RAINBOW_MARTIN_V1`、`kamaRainbowMartin.v1`、`__kamaRainbowMartinConfig` |
| 七線 | 固定 L1–L7、period、source | 完全刪除，改為動態 `Kama_Lines[]`；每列須有 stable id、enabled、name、ER、fast、slow、color |
| 週期 | 固定 M30 入場／M30 管理 | 改為單一受控 enum；空倉 KAMA 與持倉風控均在每根所選週期已收盤 bar 評估，配置於下一根新 bar 原子生效 |
| 入場 | 七線排序、L5 穿越、L6／L7 區間 | 全部刪除，改為「任意線對相對順序反轉則鎖定；否則全升多、全降空、混合 hold」 |
| 馬丁觸發 | 相對初始入場價的累積逐層距離表 | 刪除，改為相對上一層**實際成交價**的固定 gap；多空對稱 |
| 馬丁倉位 | 每層明確 `lotValue` 與逐層 enable | 原則上刪除，改為 `initial × multiplier^(L-1)`；仍須由交易所數量規格正規化 |
| 移動止盈 | activation + peak drawdown callback | 改寫為 enabled + activation + callback + step 的階梯觸發線；百分點單位統一 |
| 趨勢離場 | `Trend_Base_Line`、`Trend_Deviation_Points` | 完全刪除 |
| 額外離場 | `Max_Hold_Hours`、`Force_Close_On_Day_Start` | 完全刪除 |
| 硬止損 | 來源無對應欄位 | 新增 `Hard_Stop_Loss_Pct`，預設 5.0%，多空按平均成本對稱 |
| 目標利潤 | 文件 UI 有 1.5%，示例未接線 | 阻擋決策；未確認語義前不可進入 canonical config |
| 交易安全 | 點差、滑點、保證金、所有權、KILL、Bar-Lock、guarded adapter | 保留為平台安全底座，但移除來源命名與固定 M30 文案 |
| 回測終點 | `Backtest_End_Position_Policy` | 保留為回測會計設定，不得當作實盤交易規則 |
| AI advisor | 來源專用研究 UI／router | 預設不複製 |

## 13. 交易所 K 線官方契約補充

OKX 官方 `GET /api/v5/market/candles` 文件列出 `5m`、`15m`、`30m`、`1H`、`4H`、`1D`、`1W` 等 `bar` 值，並以回傳欄位 `confirm` 區分未完成 K 線（`0`）與已完成 K 線（`1`）。新策略的 OKX provider 必須顯式過濾 `confirm=1`，不可把最新未收線價格當作 KAMA 的 `current`。[3]

Bybit 官方 V5 `GET /v5/market/kline` 文件列出 interval `5`、`15`、`30`、`60`、`240`、`D`、`W`，且說明未完成 K 線的 close 是最後成交價。新策略的 Bybit provider 因而需要按起始時間與目前交易所時間排除當前未收線項，而不能只相信陣列最後一筆。[4]

建議建立單一 `KAMA_TIMEFRAME_MAP`：UI enum `M5/M15/M30/H1/H4/D1/W1` 對 OKX 映射為 `5m/15m/30m/1H/4H/1D/1W`，對 Bybit 映射為 `5/15/30/60/240/D/W`；所有 provider 回傳前統一正序、去重、驗證 OHLC 有限值、剔除未收線 bar，並附上 `exchange/symbol/timeframe/lastClosedBarTimestamp` 供 artifact 與 Bar-Lock 使用。

## References

[1]: https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/kaufmans-adaptive-moving-average-kama "StockCharts ChartSchool — Kaufman's Adaptive Moving Average (KAMA)"
[2]: https://www.metatrader5.com/en/terminal/help/indicators/trend_indicators/ama "MetaTrader 5 Help — Adaptive Moving Average"
[3]: https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks "OKX API V5 — Get Candlesticks"
[4]: https://bybit-exchange.github.io/docs/v5/market/kline "Bybit API V5 — Get Kline"
