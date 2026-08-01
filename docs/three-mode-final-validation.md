# S1／M2／H3 最終驗收紀錄

驗收日期：2026-08-01

## 自動化驗證

- `pnpm check`：通過。
- `pnpm test`：119 個測試檔通過、1 個跳過；979 個案例通過、4 個跳過。
- `pnpm build`：Vite 前端及 Node 伺服器正式建置通過。
- 覆蓋範圍包含九個內建策略 executable factories、V4.1 BACKTEST capability、S1／M2／H3 runtime 建立、runner preflight、結構化失敗歷史、雙腿／H3 portfolio kernel、margin liquidation、零權益下限、最大回撤與 fail-explicit future strategy 邊界。

## 畫面驗收

桌面版以 1440 × 1000 檢查 `/backtest`：頁面正常載入，執行模式區明確顯示 `BACKTEST` channel；S1、M2、H3 三張模式卡均顯示已認證狀態，M2／H3 不再出現誤導的「未認證」鎖定。回測參數、入場設定、開始回測及歷史記錄區均可見。

行動版以 390 × 844 檢查 `/backtest`：模式卡依序垂直排列，S1、M2、H3 的名稱、說明及認證圖示仍可閱讀；Gross、Margin、TTL 與反向誘發處理欄位沒有超出容器，回測按鈕及歷史區保留可操作入口。

## 安全邊界

本輪只執行型別檢查、單元測試、正式建置及回測中心畫面檢查，未送出任何真實訂單。BACKTEST、SIMULATION、LIVE 的 capability 仍分 channel 管理；V4.1 的 BACKTEST M2／H3 認證不會提升其尚未接入的 LIVE 能力。
