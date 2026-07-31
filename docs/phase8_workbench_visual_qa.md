# Phase 8 Deployment Workbench — Visual QA Notes

## 2026-07-31：隔離工作樹預覽

- Preview：`/deployments` on isolated port 3001.
- 第一個畫面擷取發生於 SPA 尚未完成 mount 的瞬間；第二次 view 已正常渲染 React root。
- 隔離預覽 domain 未共享主專案的 Manus OAuth session cookie，因此由 `DashboardLayout` 正確顯示「登入以繼續」認證閘門。
- 此結果確認 route、bundle 與認證 fallback 均能載入；完整 owner-scoped deployment workbench 桌面／行動視覺 QA 必須在合併至主專案、沿用已登入 preview session 後完成。
- 未執行任何 mutation、送單、模式啟用或實盤操作。

後續嘗試以瀏覽器既有 session 進入時，OAuth 頁要求互動式登入與「Verify you are human」驗證。此步驟需要使用者本人操作，因此 QA 在未輸入任何個人資料、未嘗試繞過 CAPTCHA 的情況下停止。合併至主預覽後再利用既有登入 session 完成實際工作台驗證。

## 2026-07-31：合併後主預覽桌面 QA

主專案 `/deployments` 以 **1440×1000** viewport 驗證。第一次全頁擷取發生於 owner-scoped queries 尚未完成時，正常顯示 DashboardLayout 與內容 skeleton；等待查詢完成後，第二次首屏擷取已完整渲染工作台，未停留於 loading 狀態。

| 驗證區域 | 結果 |
|---|---|
| 全域導覽 | 共用側邊欄新增「三模式部署」，active route 標示清楚，沒有重複 page header。 |
| 安全邊界 | 頁首明示建立、複製與模式切換保持停用，系統不會自動啟用實盤；`PAUSED / DRAINING / BLOCKED` 僅允許 reduce/close。 |
| 態勢摘要 | 正確顯示目前範圍共 4 deployments；ACTIVE、CLOSE-ONLY、BLOCKED 目前皆為 0。 |
| 部署清單 | 搜尋、模式／狀態篩選、封存切換、選取狀態與四筆真實部署均正常排列。 |
| 部署詳情 | 顯示 S1 badge、LEGACY 相容、revision、策略 identity、風險預算、Preflight 與歷史 tabs。 |
| Legacy 防繞過 | 現有策略明示「尚未載入 canonical lifecycle」，操作區未提供非 canonical enabled 布林切換。 |

合併與 server restart 後，TypeScript/LSP 未報錯；最新瀏覽器 console 與 network log 未見新增 4xx/5xx。devserver log 中較早時間的 `aws.okx.com` DNS 失敗屬重啟前歷史外部端點紀錄，並非本次工作台載入錯誤。

本輪仍未提交 preflight、activate、mode switch、close 或任何交易所 mutation。

## 2026-07-31：行動 viewport QA

第一次 **390×844 full-page** capture 命中管理預覽的舊 checkpoint 快照（回報 version `08af839e`）而顯示 404；主工作樹檢查確認 HEAD 仍為 `6d7a19f`、`/deployments` route 存在，network log 亦無對應 404。隨後以相同路徑重試非全頁 capture，工具回報 version `6d7a19ff` 並成功渲染，故前次結果判定為 stale preview artifact，而非應用程式 mobile route 回歸。

行動首屏驗證通過：側邊欄收合為頂部 mobile header，頁首改為單欄；安全邊界、重新載入與建立草稿按鈕均在 viewport 內，摘要 cards 依序堆疊，未見水平 overflow、文字截斷或低對比問題。後續清單／詳情為正常長頁內容，full-page screenshot 工具的 stale 快照不作為 layout 判定依據。

在工具確認 current preview version 為 `6d7a19ff` 後，再次執行 **390×844 full-page** capture 已通過：四筆部署清單、選取詳情、lifecycle actions、tabs、Deployment identity、Risk budget、canonical ledger Gate 與 S1/M2/H3 mode cards 全部以單欄完整堆疊；未見水平 overflow、浮動元件遮擋或底部內容被裁切。前次 stale 404 已由 current-version 成功結果排除。

一般 sandbox browser 另行開啟同一主預覽時未共享 Management Preview 的登入 session，正確停在 DashboardLayout 認證閘門；因此互動式 click-through QA 未在未認證環境嘗試。已登入的 Management Preview screenshot 可驗證 owner-scoped 真實資料與完整頁面渲染，但本輪仍不提交任何可能改變 deployment 狀態的操作。

## 2026-07-31：既有策略頁相容與導流 QA

主預覽 `/strategies` 以 **1440×1000** 驗證通過。四筆既有策略、API 帳戶、持倉同步、交易模式、輪詢資訊與原有操作列均正常渲染。每張 canonical/legacy-aware 卡片已顯示 execution-mode badge 與「部署工作台」入口，底部 lifecycle 操作改以「Preflight 與生命週期」導向 canonical 工作台；LEGACY S1 的現有策略資訊與相容狀態仍保留，未出現重複 header、重疊、水平 overflow 或不可讀文字。

畫面包含現有真實持倉與監控資訊；本次只做 screenshot 驗證，未點擊平倉、切換模式、測試信號、Webhook 或任何交易 mutation。
