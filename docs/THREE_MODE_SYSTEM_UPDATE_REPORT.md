# 三模式全系統更新完成報告

**專案：** 策略容器化自動交易平台-的副本  
**完成日期：** 2026-07-31  
**涵蓋模式：** `SINGLE_POSITION`（S1）、`MULTI_POSITION`（M2）、`HEDGE`（H3）  
**交付安全原則：** 本次更新只建立安全部署與執行能力，**沒有自動執行 preflight、沒有啟用任何 canonical deployment、沒有切換模式、沒有送出任何交易所 mutation**。

## 一、交付摘要

本次更新將先前完成的三模式資料與策略核心，擴充為可由營運人員安全操作的完整系統。新增範圍包含 deterministic preflight、revisioned deployment lifecycle、owner-scoped protected API、三模式部署工作台、runtime 不可繞過的 mode guard、decision observability、既有策略頁相容導流，以及完整的自動化與 production-like 資料庫契約驗證。

| 領域 | 完成內容 | 安全結果 |
|---|---|---|
| Deployment lifecycle | 建立、複製、列表、詳情、policy 更新、preflight、activate、pause、resume、drain、disable、block、archive | 建立與複製固定為 `DRAFT`／disabled；不存在 UI 布林啟用捷徑 |
| Preflight | strategy/artifact/capability、帳戶、position mode、商品規格、精確關腿、資金、gross、margin、open legs、pending intents 與 freshness Gate | blocker 聚合、證據清洗、TTL/revision/policy hash 驗證；失敗時 fail closed |
| 模式切換 | S1、M2、H3 的結構化 policy 與原子切換 | 必須 flat、無 pending intent／hedge 關係，並以目標 policy 重新跑 fresh preflight |
| Runtime | webhook、auto、manual、risk 與 V35/V50/V61/risk monitors 共用 canonical guard | 任何交易所 mutation 前先持久化 decision；持久化失敗或重複事件均不觸達交易所 |
| Close-only 維運 | `PAUSED`、`DRAINING`、`BLOCKED` pipeline admission | 只允許 reduce/close；只有 `ACTIVE` 可新增曝險；LEGACY S1 保持相容 |
| Observability | recent execution decisions、reason/source/time、ledger counters、lifecycle history | 工作台可同時查看 runtime decision 與 revisioned transition，不暴露完整 context payload |
| UI | `/deployments` 三模式工作台與策略頁導流 | 支援桌面與行動版；canonical 操作集中至工作台，舊頁不能繞過 preflight |

## 二、Canonical deployment 狀態機

系統以 `activationState` 與 `revision` 作為部署生命週期的主要真相，不再以 legacy `enabled` 布林值單獨決定可否交易。

| 狀態 | 新增曝險 | Reduce／Close | 主要用途 |
|---|---:|---:|---|
| `DRAFT` | 禁止 | 禁止 | 新建或複製後的安全預設 |
| `DISABLED` | 禁止 | 禁止 | 明確停用 |
| `PREFLIGHT_FAILED` | 禁止 | 禁止 | Gate 未通過，等待修復 |
| `READY_DISABLED` | 禁止 | 禁止 | Preflight 通過但尚未由操作員明確啟用 |
| `ACTIVE` | 允許，仍受 S1/M2/H3 policy Gate | 允許 | 正常執行 |
| `PAUSED` | 禁止 | 允許 | 暫停增曝、保留安全退出能力 |
| `DRAINING` | 禁止 | 允許 | 有腿部持倉時逐步退出 |
| `BLOCKED` | 禁止 | 允許 | 風控／營運封鎖，僅允許降風險 |
| `ARCHIVED` | 禁止 | 禁止 | 歷史封存 |

所有 mutation 均使用 owner scope、revision optimistic lock、transition key 與 reason code。相同冪等鍵只可重放同一操作；若 payload、mode、policy hash 或 expected revision 不同，系統拒絕碰撞請求。

## 三、Runtime 不可繞過安全邊界

`runtimeModeGuard` 與 `runtimeGuardedAdapter` 已接入主要執行路徑。交易所 adapter 的 readonly 方法可供 preflight 與市場資料探測使用；`placeOrder`、單腿 close 與 close-all 等 mutation 必須先通過 canonical decision。

進階模式的關倉 scope 已加固：CandidateIntent 帶有 `posSide`，M2/H3 decision 只核准相符的 ledger leg；單腿 reduce-only 數量上限由該腿剩餘數量決定，guarded adapter 不沿用呼叫端的方向或數量繞過 decision。Close-all 會依核准腿部拆成精確 reduce-only 市價單。

Runtime event 使用穩定 identity。若 decision persistence 失敗、owner/deployment facts 不完整、交易所 capability probe 失敗，或相同 event 已被處理，系統都會 fail closed，且不呼叫底層交易所 mutation。

## 四、部署工作台

新增 `/deployments` 工作台與共用側邊欄入口。工作台提供：

1. S1／M2／H3、activation state、搜尋與封存篩選。
2. 部署清單與詳情雙欄操作台，顯示 mode、state、revision、策略 identity、帳戶、商品、風險預算與 ledger counters。
3. Readonly preflight 報告，呈現 PASS／BLOCKED、有效期限、分類 Gate、blocker、warning 與清洗後 evidence。
4. Revisioned lifecycle 動作與破壞性確認，不提供直接 enabled 開關。
5. 結構化 mode/policy 編輯、複製部署與 fresh-preflight 切換流程。
6. Runtime execution decisions 與 lifecycle transition history。
7. Loading、empty、error、stale revision 與 conflict 回饋，以及行動版單欄長頁布局。

既有策略頁會把 canonical deployment 導向此工作台，並顯示 `DRAINING`、`BLOCKED`、`PREFLIGHT_FAILED` 等 action-required 告警。既有 LEGACY S1 策略仍保留原相容控制，但非 LEGACY deployment 已無法透過舊 `toggle/setStatus` 啟用。

## 五、驗證結果

| 驗證 | 結果 |
|---|---|
| Full Vitest | **34 個測試檔、814 項測試全部通過** |
| TypeScript | `tsc --noEmit` 通過，零型別錯誤 |
| Production build | Vite build 通過，2,833 modules transformed |
| Schema/index 核對 | Phase 0–10 lifecycle/runtime tables、columns 與唯一索引通過 |
| Production-like DB 契約 | owner isolation、optimistic lock、preflight JSON persistence、冪等 collision、flat Gate、legacy disabled migration 通過 |
| 靜態安全掃描 | whitespace、憑證模式、私鑰與 webhook secret 新增暴露未發現問題 |
| Desktop browser QA | 主預覽登入後解除 skeleton；四筆既有部署、三模式入口、LEGACY 提示、risk/ledger 與安全邊界正常 |
| Mobile browser QA | 390×844 首屏與全頁通過；清單、詳情與 risk/ledger/mode cards 單欄堆疊，無水平 overflow |
| 策略頁回歸 | 四筆既有 LEGACY S1 卡片正常；新增工作台入口與 canonical lifecycle 導流，既有持倉／監控區未出現版面回歸 |

視覺 QA 細節保存於 [`docs/phase8_workbench_visual_qa.md`](./phase8_workbench_visual_qa.md)。一般 sandbox browser 與管理預覽的登入 session 隔離，因此非破壞性互動瀏覽器停在認證閘門；confirm、error、action matrix、owner scope 與 stale/conflict 行為由 typed model、tRPC regression、repository transaction harness 與 production build 補足。測試與 QA 全程沒有提交 lifecycle 或交易所 mutation。

## 六、目前資料狀態與後續操作

合併後唯讀資料庫核對顯示目前共有四筆既有策略／部署，均為 LEGACY 相容資料；canonical activation state 的筆數仍為零。因此本次交付**不會改變既有實盤策略狀態，也不會自動把任何策略轉成 M2/H3 或 ACTIVE**。

後續如要啟用 canonical deployment，應由操作員依序：

1. 在部署工作台建立或複製 deployment，選擇 S1、M2 或 H3 與對應 policy。
2. 執行 readonly preflight，修復所有 blocker。
3. 確認報告仍在 TTL 內且 revision/policy hash 未變更。
4. 由操作員明確執行 activate；若模式切換，系統會重新驗證 flat Gate 與目標模式 preflight。
5. 先以小額、受控環境觀察 recent decision、ledger、position legs 與 alerts，再逐步提高風險預算。

> **重要：** 本報告記錄的是系統能力與驗證完成，不代表任何交易策略的獲利保證，也不取代交易所帳戶、商品規格、資金與風險限制的實際操作確認。
