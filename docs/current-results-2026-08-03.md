# 回測可信度與全策略準備度最終成果報告

**日期：** 2026-08-03  
**作者：** Manus AI  
**範圍：** 回測策略準備度、伺服器 admission 守門、績效指標 v2、九策略 oracle、完整技術檢查與 1440×900 桌面驗收。依本輪範圍決定，**不納入手機版驗收，也未觸發任何實盤交易動作**。

## 一、執行結論

本輪已把原先的 **7/9 初步人工盤點**提升為 **9/9 機器可讀權威矩陣**，並讓策略目錄、回測設定頁與真正的伺服器執行入口共用同一份 readiness 契約。回測中心會顯示逐策略風險、邏輯等價性、支援模式、建議時間框架、動態最低 K 線、資料要求、限制與阻擋原因；權威預檢尚未完成、請求失敗或策略不符合契約時，介面與伺服器都採 **fail-closed**，不允許開始回測。

全策略 oracle 已建立可執行 evidence manifest：九個內建策略共 **54 個 baseline／高風險 target 指派**均對應到實際 Vitest 檔案與斷言標記；唯一刻意重用的 target 是兩個策略共用的 `MULTI_LEG_ACCOUNTING`，因此共有 53 個唯一 evidence key。完整檢查結果為 TypeScript 通過、正式建置通過、139 個測試檔通過且 2 個測試檔依環境跳過；測試案例共 1119 項通過、5 項跳過。

| 驗收面向 | 最終結果 | 主要證據 |
|---|---|---|
| 九策略權威準備度 | **9/9 已納管** | `server/services/backtest/backtestReadinessRegistry.ts` |
| 策略目錄投影 | **9/9 回傳 readiness 契約** | `server/services/backtest/backtestStrategyCatalog.ts` |
| 執行前 admission | **UI 與 server 雙重 fail-closed** | `server/routers/backtest.router.ts`、`client/src/pages/Backtest.tsx` |
| Oracle evidence | **54/54 target 指派可驗證** | `server/services/backtest/backtestOracleManifest.test.ts` |
| 高風險深度案例 | **V4.1／V5.0／V6.1／V7.0 已補強** | `server/services/backtest/strategyHighRiskOracle.test.ts` |
| 完整 Vitest | **139 passed、2 skipped；1119 tests passed、5 skipped** | `pnpm vitest run`，2026-08-03 最終重跑 |
| TypeScript | **通過** | `pnpm check` |
| 正式建置 | **通過** | `pnpm build` |
| 桌面 UI | **1440×900 全頁與首屏通過** | `/backtest` 桌面截圖驗收 |
| 已登入 QA 日誌 | **console 0 error/warn；network 0 個 4xx/5xx** | `.manus-logs/browserConsole.log`、`.manus-logs/networkRequests.log` |

## 二、九策略權威準備度矩陣

矩陣中的 `READY` 表示策略已具有正式回測認證與可執行 admission 契約，**不代表任意模式、時間框架或資料都會被放行**。每次執行仍會依當下的策略、部署模式、時間框架、配置與資料品質重新評估。V6.1 與 V7.0 保留 `FORK_RISK`，所以雖可執行，介面會明確提示需要持續依賴 parity oracle 防止路徑漂移。

| 策略 | 認證／風險 | 邏輯等價性 | 最低已收盤 K 線 | 關鍵結論 |
|---|---|---|---:|---|
| `strategy_20415` | READY／HIGH | `SHARED_CORE` | 120 | 實盤與回測共用 Rainbow 20415 進場與管理核心 |
| `RAINBOW_TREND_LADDER_V1` | READY／HIGH | `SHARED_CORE` | 120 | 共用七線趨勢階梯純核心，M30 已收盤語意受 oracle 保護 |
| `KAMA_RAINBOW_MARTIN_V1` | READY／HIGH | `SHARED_CORE` | 動態，基礎 2 | 共用 KRM entry／management；目前只放行 S1；funding 尚未納入專用 runner |
| `KAMA_3K_BREAKOUT_V25` | READY／HIGH | `SHARED_CORE` | 動態，基礎 201 | 共用 V2.5 訊號核心；最低資料量依 KAMA 長度動態提高 |
| `20415_KAMA_MARTIN_V35` | READY／HIGH | `SHARED_CORE` | 4 | 共用 V3.5/V4.0 entry gate 與 canonical portfolio kernel |
| `20415_KAMA_MARTIN_V41` | READY／HIGH | `SHARED_CORE` | 120 | 共用 V4.1 三條件 `entryConditions`，AND／OR 拒絕理由可稽核 |
| `KAMA_3K_ULTIMATE_V50` | READY／HIGH | `WRAPPED_SHARED_CORE` | 120 | 實盤與回測沿用 F1–F6 模組及 canonical portfolio kernel |
| `KAMA_3K_HF_V61` | READY／CRITICAL | `FORK_RISK` | 動態，基礎 69 | 部分 S1 路徑仍有 inline 邏輯；以 zone、direction 與負權益 oracle 持續守護 |
| `KAMA_3K_TORNADO_V70` | READY／CRITICAL | `FORK_RISK` | 動態，基礎 220 | S1 有專用 runner；funding、重新入市與 attribution 不在目前能力內 |

## 三、回測中心與伺服器守門

`backtest.getStrategies` 現在直接投影權威 readiness 欄位；`backtest.getReadiness` 依目前策略、時間框架、執行模式與 canonical config 回傳 admission assessment。真正的 `backtest.run` 仍會在伺服器端重新執行相同判定，因此前端狀態不能繞過後端安全邊界。

| 守門層 | 已完成行為 |
|---|---|
| 策略選擇器 | 顯示逐策略就緒／注意／阻擋狀態，不以名稱或前端硬編碼猜測 |
| Readiness 診斷卡 | 顯示契約版本、風險、邏輯等價性、最低資料量、支援模式、建議與目前時間框架、資料品質要求及限制 |
| 初始預檢 | 權威回應尚未取得時顯示「預檢中」，開始按鈕維持禁用 |
| 不符合契約 | 顯示中文原因碼與警告，開始按鈕禁用 |
| 查詢失敗 | 顯示 fail-closed 錯誤，不以 catalog fallback 冒充已通過 admission |
| 執行入口 | 伺服器再次驗證同一契約，避免只靠 UI 守門 |
| 績效口徑 | 可摺疊顯示 `backtest-performance-v2` 的公式與邊界語意 |

## 四、Oracle 與高風險會計證據

Oracle manifest 會從 readiness 矩陣讀取每個策略宣告的 baseline 與 high-risk target，驗證九個策略均存在、總 target 指派為 54、evidence 檔案存在且確實包含指定斷言。這使新增或修改策略時，不能只更新文案而忘記提供可執行證據。

| 類別 | 代表性覆蓋 |
|---|---|
| Rainbow 20415／七線趨勢階梯 | 進場排名、盲人管理、M30 closed-bar 語意、多腿單一權益帳本、馬丁層隔離 |
| KRM | long／short、hard stop、trailing、逐層 fill 錨定、cross／touch lock、mixed slope、重新入市 |
| V2.5 | long／short、硬止損、無固定十層上限、追蹤止盈、趨勢重入 |
| V3.5 | entry gate、S1 ledger、M2 反向腿、H3 hedge guard |
| V4.1 | ENTRY、三條件 AND／OR、各拒絕 reason code、方向衝突、原地重入 |
| V5.0 | entry、F1 regime、trailing、dynamic Martin、partial TP、多模式會計 |
| V6.1 | live／backtest oracle、zone trigger parity、direction mode parity、gap-loss 零下限與 100% 回撤 |
| V7.0 | MA200、KAMA cross、S 曲線層、硬止損、反向交叉、分層止盈、馬丁觸發、path parity |

## 五、最終技術與桌面驗收

| 檢查 | 指令／條件 | 結果 |
|---|---|---|
| 型別 | `pnpm check` | 通過，0 TypeScript error |
| 全套測試 | `pnpm vitest run` | 139 個檔案通過、2 個跳過；1119 項通過、5 項跳過 |
| 正式建置 | `pnpm build` | Vite 與 server bundle 均完成 |
| 聚焦 UI 契約 | readiness、V4.1、S1-only 三組測試 | 3 個檔案、19 項全部通過 |
| 1440×900 全頁 | `/backtest`，full-page | 表單、診斷卡、績效口徑、策略參數、執行區與歷史區無橫向溢位 |
| 1440×900 首屏 | `/backtest`，viewport | 文字可讀、標籤對比清楚、四欄 readiness 卡對齊、欄位未截斷到不可辨識 |
| 已登入 console | 只檢查 authenticated screenshot 時窗 | 0 error、0 warning |
| 已登入 network | 同一時窗 | 0 個 4xx／5xx |

正式建置仍會輸出既有的 chunk-size 警告：主要 JavaScript bundle 約 3.52 MB、gzip 約 713.85 kB。這不阻擋本次發布，但屬於後續可用 route-level dynamic import 與 manual chunks 處理的效能技術債。

獨立互動瀏覽器因沒有沿用專案預覽的登入 cookie，曾正確落到登入頁並產生 401；該工作階段與已登入的桌面截圖驗收分開判讀，不視為產品回歸。已登入驗收時窗沒有 console 或 HTTP 失敗。

## 六、已修正的完整測試回歸

完整 Vitest 首次重跑揭露兩個舊 source-contract 問題。策略頁殘留的可見 `M2/H3 成交 Ledger` 標籤已改為中性的「逐腿成交 Ledger」，維持目前 S1-only UI 契約；V4.1 UI 測試則更新為同時鎖定 readiness 與 V4.1 自身驗證的雙重 fail-closed 條件。兩項修正完成後，聚焦測試與完整套件均重新通過。

## 七、安全邊界與後續限制

本輪沒有主動啟動、停止或修改任何實盤策略，也沒有送出下單、撤單或平倉請求。發布後仍建議先在模擬盤／測試帳戶驗證策略輸出與交易所回報；尤其 V6.1、V7.0 的 `FORK_RISK` 是已被明確揭露並由 parity oracle 防守的架構風險，不應被解讀為實盤與回測已形式化證明完全等價。

| 邊界 | 本輪處理 |
|---|---|
| 手機版 UI | 依範圍決定未驗收，不宣稱通過 |
| V6.1／V7.0 fork risk | 已揭露、顯示警告並建立 parity oracle；未在本輪重構為單一共享函式 |
| KRM funding | 專用 runner 尚未納入，UI 顯示限制 |
| V7.0 funding／重新入市／attribution | 不屬於目前 runner 能力，UI 顯示限制 |
| Bundle size | 建置通過但保留非阻擋警告，列為效能技術債 |

## 八、主要倉庫證據

| 類型 | 路徑 |
|---|---|
| 共享 readiness 契約 | `shared/backtest/backtestReadiness.ts` |
| 權威九策略矩陣與 admission | `server/services/backtest/backtestReadinessRegistry.ts` |
| 策略目錄投影 | `server/services/backtest/backtestStrategyCatalog.ts` |
| tRPC 查詢與執行守門 | `server/routers/backtest.router.ts` |
| 回測中心 UI | `client/src/pages/Backtest.tsx` |
| 績效 v2 契約 | `shared/backtest/performanceMetricSpec.ts` |
| 九策略 evidence manifest | `server/services/backtest/backtestOracleManifest.test.ts` |
| 高風險 deterministic oracle | `server/services/backtest/strategyHighRiskOracle.test.ts` |
| UI source-contract | `server/backtestReadinessUiContract.test.ts`、`server/v41UiWiring.test.ts`、`server/s1SingleModeUi.test.ts` |

> **最終判定：** 本輪承諾的 readiness、9/9 oracle、完整技術檢查與 1440×900 桌面驗收均已完成；已知能力限制仍被清楚揭露並由 admission 與 UI 阻擋，而非以成功文案掩蓋。
