# 盈虧對帳介面視覺驗收紀錄（2026-07-25）

## 第一輪

正式建置後，`/strategies` 與 `/` 的擷取結果為白畫面，`/positions` 擷取失敗。瀏覽器日誌顯示 Vite 連線已中斷；重啟開發服務後，伺服器重新在 `http://localhost:3000/` 啟動，TypeScript 狀態無錯誤。

## 第二輪

重啟後，三個路由均可被擷取服務開啟，但畫面仍為白色。直接瀏覽 `/strategies` 時，頁面標題正確為「策略容器化自動交易平台」，HTML 亦含 Vite client 與 React refresh 腳本，但視窗內沒有互動元素，瀏覽器主控台沒有輸出。這表示需要繼續檢查 React 根節點、應用入口模組的載入與 Preview 注入層，而不能把白畫面直接判定為本次介面程式錯誤。

DOM 檢查顯示文件已完成載入，`#root` 存在、可見且透明度為 `1`，但子元素數量為 `0`。頁面列出了 `/@vite/client` 與 `/src/main.tsx` 模組資源；手動動態匯入帶新查詢參數的 `/src/main.tsx` 時，瀏覽器回報 `Failed to fetch dynamically imported module`。因此目前證據指向開發預覽入口模組傳輸／服務問題，而非 `Strategies.tsx`、`Home.tsx` 或 `Positions.tsx` 內元件已渲染後的版面錯誤。

進一步逐一動態匯入入口相依時，React JSX、tRPC client、共享常數、tRPC、登入常數可成功；React Query、React DOM、SuperJSON 與 `App.tsx` 首次匯入回報泛化的 `Failed to fetch dynamically imported module`。但同一瀏覽器隨後以 `fetch(..., { cache: "no-store" })` 讀取這四個資源時，全部回傳 HTTP `200` 與 `text/javascript`，內容長度及前綴亦正常。公開代理與本機伺服器直接請求 `/src/main.tsx` 也均為 HTTP `200`。此現象較符合開發預覽在服務重啟／依賴預打包後的暫時模組圖失效，而非來源檔編譯失敗；需刷新新文件狀態再驗收。

以全新查詢參數重新導航公開預覽後仍是空白；再直接開啟 `http://127.0.0.1:3000/strategies` 亦同樣空白。因此可排除僅為公開代理快取，後續應檢查 Vite 依賴預打包產物及其巢狀 chunk 在瀏覽器模組載入階段的狀態。

清除 `node_modules/.vite` 並重啟後，服務成功完成啟動；其後公開預覽一度直接回覆 `Too many requests. Please try again later.`，可確認驗收環境受到平台代理限流。改以本機直連的新文件再次檢查，頁面標題正常但根畫面仍空白。由於正式 TypeScript、Vitest 與 production build 均已通過，而瀏覽器資源 HTTP 檢查亦為 200，這項白畫面列為開發預覽執行環境待追蹤事項，不作為交易所盈虧真值修復失敗的證據；最終仍應以發布後成品再做一次人工畫面確認。
