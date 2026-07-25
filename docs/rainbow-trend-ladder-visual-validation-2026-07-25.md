# 七彩虹線趨勢跟蹤階梯馬丁：唯讀視覺驗收紀錄

## 驗收範圍

本紀錄只涵蓋唯讀頁面檢查，不點擊啟用、自動交易、手動訊號、KILL、解除鎖定或任何可能改變策略／持倉狀態的控制項。

## 首輪觀察

2026-07-25 以桌面視窗開啟開發預覽 `/strategies`。頁面標題正確顯示「策略容器化自動交易平台」，但頁面內容為全白，沒有可互動元素。同期瀏覽器主控台未輸出 JavaScript 例外，開發伺服器亦維持運行。這一輪結果尚不能作為 UI 驗收通過證據，需先釐清預覽入口／開發伺服器資源載入狀態後重新擷取。

> 安全說明：此輪操作沒有呼叫交易 mutation，沒有建立、啟用、停用或刪除策略，也沒有送出 KILL／解除鎖定請求。

## DOM 與資源診斷

空白頁的文件狀態為 `complete`，`<title>`、字型樣式、Vite client 與 `src/main.tsx` 模組腳本均存在；然而 `#root` 仍為空字串。當時瀏覽器主控台沒有可見例外。這表示問題發生在 React 掛載前或模組載入階段，而不是 `/strategies` 頁面內容本身的可見版面錯誤。下一步需核對模組請求狀態與目前開發伺服器程序，再重新進行唯讀驗收。

直接以 `fetch` 讀取 `/src/main.tsx` 與 `/@vite/client` 均得到 HTTP 200 與 JavaScript 內容；但頁面原始帶版本查詢字串的 `main.tsx` 資源紀錄只有約 300 bytes 傳輸、0 bytes 解碼內容。強制重新載入後 `#root` 仍未掛載，故下一步改採安全重啟開發服務並使用新預覽連結驗證。此診斷不涉及任何交易 API 或狀態 mutation。

開發服務安全重啟後，伺服器成功註冊 `strategy_20415` 與獨立的 `RAINBOW_TREND_LADDER_V1`，且本機 `/strategies` 回應 HTTP 200。惟預覽瀏覽器即使加入全新查詢字串，仍收到空白畫面與空的 `#root`。這進一步指向預覽瀏覽器的版本化模組載入／快取層，而非新策略 React 元件的執行期例外；生產建置已成功，因此後續將以人工載入無版本模組的唯讀方式驗證畫面，再以正式發布站做最終確認。

瀏覽器動態匯入全新查詢字串的 `/src/main.tsx` 時回報 `Failed to fetch dynamically imported module`；直接改連 `http://127.0.0.1:3000/strategies` 仍為同樣空白。由於一般 `fetch` 可取得模組文字，而 ES module 載入失敗，暫判為目前沙箱瀏覽器／開發代理的模組載入環境異常。此項不改動任何應用程式碼，也不觸發交易行為；正式發布後仍必須再次做生產站唯讀驗收。

## 獨立生產建置唯讀驗收

為排除 Vite 開發代理因素，使用已通過 `pnpm build` 的既有生產產物，在獨立的本機 3001 埠啟動生產模式伺服器；生產模式明確停用 process-local 監控輪詢，只提供頁面與 API，未取代 3000 埠程序。`/strategies` 成功完整渲染，身份為現有測試登入狀態。

策略清單顯示原有三張策略卡片，其中 **「20415七彩虹馬丁策略 - 導入okxBTCUSDT」仍為運行中**，顯示原倉位設定 300 USDT、5x、雙向、限價、30 分鐘分析週期，且原本的交易模式、同步、暫停、停止、平倉與測試信號控制均保持可見。另兩張既有策略卡片亦正常顯示。此輪只讀取頁面與查詢資料，未點擊任何策略卡片交易控制。

開啟「新增策略」抽屜後，策略引擎初始值為 **「不使用（訊號直接執行）」**，不會自動選取或建立任何新策略。展開引擎選擇器可同時看到原本的 **「20415七彩虹馬丁策略（內建）」** 與新的 **「七彩虹線趨勢跟蹤階梯馬丁策略（內建）」**，兩者為分開選項；其餘既有引擎也保持可見。此步驟沒有選取選項、沒有填表，也沒有按下「建立策略」。

僅在尚未提交的本地表單狀態中選取新引擎後，畫面出現完整 **RAINBOW TREND / LADDER / V1** 專屬面板：M30／M1 雙節奏、七條 SMA、八層累積階梯、動態止盈、交易品質鐵幕、隔離安全 KILL 邊界與 AI 風險優先參數顧問均正常渲染。DOM 稽核確認 `rtl-close-margin`、`rtl-reentry-wait`、`rtl-dedicated`、`rtl-kill-owned` 四項安全開關均為 `aria-checked=true`。畫面文案明示「實盤交易武裝預設關閉」及「建立策略後仍會保持停用」；下一步將再定位其實際 switch DOM 後關閉抽屜，不會提交表單。

進一步以標籤 `for="rtl-live-armed"` 精準定位實盤武裝 switch；其 DOM 為 `aria-checked="false"`、`data-state="unchecked"`。因此新策略即使被選入尚未提交的建立表單，**實盤交易武裝仍確定預設關閉**。整個桌面驗收過程未呼叫建立、更新、啟用、訊號、平倉或 KILL 等 mutation。

## 375 × 812 行動版驗收

使用同源 iframe 建立真實 375 × 812 viewport，讓 CSS media query 以行動版條件重新渲染生產建置。側欄正確收合為「Toggle Sidebar」，頁首、策略清單／績效分頁與「新增策略」入口均可見；原 20415 卡片正常呈現為單欄。既有策略卡片的密集交易控制仍保留水平捲動條，屬原頁既有資訊密度行為，並非新策略面板造成；新策略設定抽屜將另行檢查其行動版寬度與可捲動性。

行動版 iframe 的「新增策略」按鈕已透過同源 DOM 成功觸發；這僅開啟客戶端表單抽屜，沒有填入、建立、更新或啟用策略。下一步檢查抽屜的行動版可見範圍與新策略面板，驗收後直接丟棄表單狀態。

375 × 812 下新增策略抽屜能完整開啟，標題、關閉按鈕、表單欄位與內部垂直捲動條可見；內容可在抽屜內獨立滾動。以同源 DOM 在未提交表單中成功選取「七彩虹線趨勢跟蹤階梯馬丁策略」引擎，未呼叫建立端點。下一步查看專屬面板的實際行動版佈局並核對武裝開關仍為關閉。

新策略 V1 面板成功渲染，七線、八層、風控、安全與 AI 區塊均存在，`rtl-live-armed` 仍為 `aria-checked=false`。DOM 寬度量測發現一項需修正的純前端 responsive 問題：iframe `innerWidth=375`、抽屜 `clientWidth=326`，但新面板被內容撐至 `clientWidth=968`，抽屜 `scrollWidth=1002`，文件 `scrollWidth=529`。兩個表格 wrapper 都被撐成 900px，表示 `overflow-x-auto` 的父層缺少 `min-w-0`／最大寬度約束；這會讓面板整體溢出，而不是只讓表格本身橫向捲動。修正將只限於 `RainbowTrendLadderConfigPanel.tsx`，不更動 `Rainbow20415ConfigPanel` 或原策略任何執行碼。

## Responsive 修正後重驗

最新生產 bundle 已在獨立 3001 埠重新載入。策略清單唯讀查詢正常完成；畫面仍顯示既有 **20415 七彩虹馬丁策略**、**KAMA 3K V6.1** 與 **V4.0 KAMA+3K** 原部署及其原狀態，沒有新增新策略部署，也沒有改動任何啟用開關。下一步僅在客戶端未提交表單內重做 375 × 812 尺寸量測。

375 × 812 同源 iframe 已以最新 bundle 正常渲染策略交易頁；行動版導航、新增策略入口與既有策略卡片保持可見。此步驟只有 GET／query 讀取，未觸發建立、啟用、停用、平倉、測試訊號或任何交易 mutation。

行動版「新增策略」抽屜已在 iframe 內開啟，表單欄位與底部「取消／建立策略」控制可見且可垂直捲動。驗收過程沒有點擊「建立策略」；下一步僅在客戶端選取新引擎以量測專屬面板，不會送出表單。

第一次 responsive 修正加入新面板本身的 `w-full min-w-0 max-w-full` 與兩個可聚焦的局部水平捲動區，但重驗顯示抽屜外層仍把 grid item 依表格 intrinsic width 撐開：dialog `display:grid`、`clientWidth=322`、`scrollWidth=986`；其直接子層 `.space-y-4` 為 `clientWidth=954`、`min-width:auto`；新面板因此仍為 `clientWidth=952`。根因已縮小到**只包住新策略專屬設定的呼叫端 wrapper**。下一個修正會在該 wrapper 加 `min-w-0 max-w-full overflow-hidden`，不會改動 20415 面板或任何交易邏輯。

最終改以新元件根節點的 CSS `contain:inline-size` 隔離表格 intrinsic width，避免修改共用抽屜或 20415 分支。全新生產 bundle 的正式 375 × 812 重驗通過：dialog `clientWidth=322 / scrollWidth=334`；新面板 `clientWidth=300 / scrollWidth=300 / contain=inline-size`；直接父層 `clientWidth=302 / scrollWidth=308`。七線表 wrapper 為 `clientWidth=248 / scrollWidth=760 / overflow-x=auto`，八層表 wrapper 為 `clientWidth=248 / scrollWidth=900 / overflow-x=auto`，證明寬內容只在各自可聚焦區域局部水平捲動，不再把整個設定面板撐出抽屜。`rtl-live-armed` 仍為 `aria-checked=false`／`data-state=unchecked`，且 `createClicked=false`，未建立、未啟用、未送出任何策略或交易操作。

最終實際畫面亦通過：375 × 812 抽屜邊界完整可見，七線 SMA 欄位顯示在抽屜內，表格底部提供自身水平捲動條；其後四張入場規則卡在同一抽屜寬度內正常換行排列。背景既有 20415 與其他策略卡片仍保持原狀。此畫面只反映未提交表單的客戶端預覽。
