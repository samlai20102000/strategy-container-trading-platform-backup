# Phase 8 Deployment Workbench — Visual QA Notes

## 2026-07-31：隔離工作樹預覽

- Preview：`/deployments` on isolated port 3001.
- 第一個畫面擷取發生於 SPA 尚未完成 mount 的瞬間；第二次 view 已正常渲染 React root。
- 隔離預覽 domain 未共享主專案的 Manus OAuth session cookie，因此由 `DashboardLayout` 正確顯示「登入以繼續」認證閘門。
- 此結果確認 route、bundle 與認證 fallback 均能載入；完整 owner-scoped deployment workbench 桌面／行動視覺 QA 必須在合併至主專案、沿用已登入 preview session 後完成。
- 未執行任何 mutation、送單、模式啟用或實盤操作。

後續嘗試以瀏覽器既有 session 進入時，OAuth 頁要求互動式登入與「Verify you are human」驗證。此步驟需要使用者本人操作，因此 QA 在未輸入任何個人資料、未嘗試繞過 CAPTCHA 的情況下停止。合併至主預覽後再利用既有登入 session 完成實際工作台驗證。
