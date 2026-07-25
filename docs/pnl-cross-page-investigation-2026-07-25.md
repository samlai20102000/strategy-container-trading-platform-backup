# 策略交易頁與 OKX 盈虧跨頁一致性調查

## 調查邊界

- 本輪只執行唯讀程式與頁面檢查，不下單、不平倉、不修改策略運行狀態。
- 使用者提供的正式網域為 `https://tradeauto-ny5chipj.manus.space/strategies`。
- 沙箱瀏覽器開啟正式網域後被導向登入頁，因此無法讀取使用者帳戶內的實際持倉；後續以程式資料流、使用者截圖及自動測試交叉驗證。

## 已確認的重要差異

- 使用者截圖中的策略卡片標題為「本策略持倉」。
- 目前工作樹 `client/src/pages/Strategies.tsx` 在精確歸屬時顯示「OKX 真實持倉」，並顯示同步時間、標記價格、持倉保證金及「交易所未實現盈虧」。
- 因此截圖介面與目前工作樹並非同一個可見版本或同一渲染分支；不能直接假設現行 `Strategies.tsx` 仍用本地 ticker 計算。

## 正式網域版本核對（直接證據）

| 檢查 | 正式網域結果 | 現行工作樹結果 | 判定 |
|---|---|---|---|
| 前端主 bundle | `/assets/index-BF9W4zvA.js` 包含「本策略持倉」 | `Strategies.tsx` 包含「OKX 真實持倉」 | 正式前端仍是舊版 |
| 新版欄位文字 | 找不到「交易所未實現盈虧」 | 現行策略卡片已使用該欄位 | 正式前端未包含本輪修復 |
| 快照程序名稱 | bundle 找不到 `getStrategyPositionSnapshots` | 現行前端與後端均已使用 | 正式前端未包含新端點 |
| 正式後端端點 | 對 `exchange.getStrategyPositionSnapshots` 的唯讀未登入請求回傳 `404 NOT_FOUND`，訊息為 `No procedure found` | 現行 `exchange.router.ts` 已註冊此程序 | 正式後端同樣仍是舊版 |

正式網域來源：`https://tradeauto-ny5chipj.manus.space/strategies`。以上核對證明，使用者截圖中的策略頁不一致並非現行工作樹的快照公式再次失效，而是先前修復沒有部署到該正式網域的前後端版本。實時控制中心在舊版仍直接呼叫帳戶持倉，因此可接近 OKX；舊策略卡片則繼續使用本地價格／本地狀態顯示，遂形成兩套口徑。

## 目前程式資料流

- 實時控制中心 `dashboard.overview` 每 10 秒直接建立 adapter 並呼叫 `getPositions()`。
- 實時控制中心同時每 10 秒查詢 `exchange.getStrategyPositionSnapshots`，前端 staleTime 為 5 秒。
- 策略交易頁已查詢 `exchange.getStrategyPositionSnapshots`；後端策略快照服務另有帳戶級短暫快取。
- 尚需核對兩頁是否因後端快取、瀏覽器舊前端版本、不同部署網域或策略歸屬分支而看到不同時點的交易所資料。

## 後續驗證

- 精確比較策略頁與控制中心的 query options、快取鍵及手動刷新行為。
- 驗證正式發布版本是否包含現行策略卡片標題與交易所原生欄位。
- 為同一 `apiKeyId + symbol + side` 的跨頁快照建立可重現測試，確保同一時間窗只使用同一筆交易所回應。

## 2026-07-25 14:27（GMT+8）發布前線上基線

正式站首頁來源為 <https://tradeauto-ny5chipj.manus.space/>，當時 HTML 指向主資產 <https://tradeauto-ny5chipj.manus.space/assets/index-BF9W4zvA.js>。該 JavaScript 資產的 SHA-256 為 `87c5a4022eba477731711401ae80c152ee4a2b8bf01b9667660c9caebbec025b`；可找到兩處「本策略持倉」，但找不到 `getStrategyPositionSnapshots` 或「OKX 真實持倉」。這是本輪新發布前的可重現舊版基線，發布後必須同時確認主資產名稱／雜湊已改變，且 bundle 已含 `getStrategyPositionSnapshots`、`exchange-position-v2` 與「同源 V2」。

## 2026-07-25 14:36–14:40（GMT+8）發布前驗收

| 驗收項目 | 結果 |
|---|---|
| TypeScript | `pnpm check` 通過，零錯誤 |
| 策略快照專屬測試 | 9/9 通過，涵蓋 TTL 內同一交易所請求、慢回應待決 promise 重用、強制刷新、精確／唯一／合併歸屬與錯誤降級 |
| 完整 Vitest | 40 個測試檔通過、1 個跳過；501 項通過、4 項跳過 |
| 生產建置 | `pnpm build` 通過；主資產 `dist/public/assets/index-BaZRAqdy.js` |
| 新 bundle SHA-256 | `e790bab1e991121530805cb7c8449c9e5f6a024cf78a6d1df0f6e1009475508b` |
| 新 bundle 契約字串 | `getStrategyPositionSnapshots` 7 處、`refreshStrategyPositionSnapshots` 2 處、`exchange-position-v2` 1 處、「同源 V2」1 處 |

開發預覽 URL <https://3000-iqxdk6bxajb1pl4x8fzk1-6540027e.sg1.manus.computer/strategies> 在 14:40 的瀏覽器回應為 HTTP 代理限流頁面「Too many requests. Please try again later.」，DOM 中沒有 React root 或入口 scripts。因此該次空白截圖不是應用程式渲染錯誤；正式發布後改以正式網域的資產名稱、SHA-256、契約字串與 HTTP 回應驗證部署結果。
