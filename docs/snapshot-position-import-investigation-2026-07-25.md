# 快照匯入倉位覆寫與 20415 單位錯配調查紀錄

## 使用者圖片證據

圖 1 顯示由 V4.0 KAMA+3K 快照建立策略時，頂層「倉位大小」數值 `100` 及「USDT 金額」選擇器均呈停用狀態；介面文字明確寫著「倉位單位由快照還原並鎖定」。使用者需求是只鎖定快照原策略引擎及策略邏輯參數，實盤部署的倉位大小與單位必須可覆寫，且規則適用於所有現有及未來策略。

圖 2 顯示導入 20415 七彩虹馬丁快照後，伺服器阻止建立並回報：`倉位單位與快照不一致（快照：usdt；提交：quantity）`。這證明同一個表單內存在兩套不同步的倉位模式狀態。

圖 3 顯示同一 20415 導入表單的頂層倉位為 `100 USDT`，20415 專用面板的 `Base_Lot_Size` 亦顯示 `100 USDT`；然而提交值仍成為 `quantity`，屬於表單狀態／快照正規化分叉，而非使用者選錯。

## 已定位程式根因

`client/src/pages/Strategies.tsx` 的頂層倉位輸入與模式選擇器使用 `disabled={Boolean(snapshotImportSource) || ...}`，因此所有從快照建立的策略一律被鎖死。

同檔快照點選流程只由 `backtestSettings.baseLotSizeMode` 設定頂層 `form.positionMode`，卻沒有將 20415 原始快照正規化後寫入 `form.v2_0`；其預設值仍可能是 `Base_Lot_Size.mode = quantity`。提交時 20415 又優先讀取 `form.v2_0.Base_Lot_Size.mode`，造成畫面／提交語義分叉。

`server/services/strategySnapshotConfig.ts` 的 `assertSnapshotPositionMode` 實作舊契約：提交單位必須等於快照單位，否則直接拒絕。

`server/routers/backtest.router.ts` 的 `importSnapshotAsNew` 即使收到 `input.positionSize`／`input.positionMode`，仍會對 20415／V2.5 改用快照配置中的 `Base_Lot_Size` 寫入 `positionSize`、`positionSizeObject` 與 `martinState.currentLot`，因此單純解鎖前端仍無效。

`server/routers.ts` 的一般 create／update 路徑亦會在 20415 配置分支把頂層部署倉位重新覆寫成 `v2_0Config.Base_Lot_Size`，這解釋了為何既有策略編輯也無法真正獨立變更部署倉位。

## 目標契約

快照原始配置及策略引擎身份保持不可變並完整保存；實盤部署層使用獨立 `positionSize`、`positionMode`、`positionSizeObject` 作為下單資金語義。導入時以快照值作為初始建議值，但使用者可覆寫；覆寫不得回寫或污染 `__snapshotConfig`，執行器應優先採用部署層欄位。整個流程不得自動啟用策略、下單、平倉或改變持倉。

### 分層資料契約

| 層級 | 欄位／來源 | 用途 | 可否在實盤建立／編輯時修改 | 優先序 |
|---|---|---|---|---|
| 引擎身份 | `strategyKey`、快照 `strategyKey` | 決定使用哪一個策略引擎 | 快照導入時不可修改 | 最高且不可替換 |
| 快照策略配置 | `martinState.__snapshotConfig`、`__v2_0Config`、`__v25Config` 等 | 保存回測及策略邏輯參數，供引擎還原 | 快照導入流程維持原值 | 僅用於策略邏輯 |
| 實盤部署倉位 | `positionSize`、`positionMode`、`positionSizeObject` | 決定實際下單的基準金額／數量 | 必須可修改 | 下單計算時最高 |
| 實盤運行狀態 | `martinState.lossCount`、`currentLayer`、`totalSize` 等 | 保存已成交後的持倉與馬丁狀態 | 不由本次表單重置 | 成交狀態專用 |

頂層部署倉位的標準形態固定為 `{ value: number, mode: "quantity" | "usdt" }`。伺服器在建立與編輯時以 `input.positionSize` 與 `input.positionMode` 正規化後，同步寫入三個部署欄位；任何策略專用配置都不得在持久化末段重新覆蓋它們。快照內的 `Base_Lot_Size` 保留為原始策略配置及初次預填來源，但不再等同於不可變的實盤下單值。

### 執行階段覆寫規則

執行器必須先載入並校驗原始策略配置，再以部署倉位產生「只存在於本次執行記憶體」的有效配置。對使用 `Base_Lot_Size` 的 V2.5、20415、V3.5、V5.0、V6.1，應將有效 `Base_Lot_Size`／`Position_Mode`／`Position_Value` 覆寫為部署值；對使用 `base_lot_size_usdt` 的 V7.0，只有在部署模式為 `usdt` 時直接覆寫，若使用者選擇 `quantity`，則由執行器直接依該數量下單。這個覆寫不得寫回 `__snapshotConfig` 或各版本專用配置。

20415 的馬丁各層下單量由 `Base_Lot_Size` 與層級倍率共同推算，所以自動訊號產生器與最終執行器都必須使用同一個有效配置。只在資料庫寫入頂層部署欄位不足以解決問題；若不修正這兩個執行入口，自動訊號中的 `rainbow20415OrderSize` 仍會沿用快照值。

### 已確認的執行器覆蓋風險

| 策略 | 目前風險 | 修正原則 |
|---|---|---|
| 20415 七彩虹 | 自動決策及執行器直接使用快照 `Base_Lot_Size` | 先校驗快照，再以部署倉位建立有效 20415 配置 |
| V2.5 | 自動決策及執行器使用 `cfg.Base_Lot_Size`，且固定按 USDT 換算 | 有效配置改採部署值；同時支援 `usdt` 與 `quantity` |
| V3.5／V5.0 | 專用配置在物件合併末段覆蓋頂層 `Base_Lot_Size` | 將部署倉位覆寫移至合併最後 |
| V6.1 | `Base_Lot_Size` 直接取 `v61Cfg.base_lot_size` | 將部署倉位覆寫移至合併最後 |
| V7.0 | 下單固定取 `cfg.base_lot_size_usdt` | 最終委託依部署模式選擇 USDT 換算或直接數量 |
| 其他／未來策略 | 若引擎自訂配置包含同名欄位，可能覆蓋部署層 | 共用部署倉位解析函式，並規定下單邊界以部署層為最高優先 |

### 相容與安全界線

既有資料不需資料庫結構遷移，因 `strategies` 表已同時具備 `positionSize`、`positionMode` 與 `positionSizeObject`。舊資料若缺少或含有無效 `positionSizeObject`，執行階段會依序使用有效頂層欄位、相容物件及明確安全預設值，但不會批次修改資料庫、啟用策略、重置運行狀態或觸發任何委託。套用快照到既有策略時保留原本 `enabled` 與持倉狀態；由快照建立的新策略則一律以 `enabled=false` 建立，待使用者覆核實盤倉位後手動啟用。

## 最終實作

本次修復沒有新增或遷移資料庫欄位，而是把原本混合的「快照策略配置」與「實盤部署倉位」拆成兩個明確責任層。前端所有策略共用同一組可編輯的實盤部署控制項；後端建立、編輯、快照導入、自動訊號與最終委託則共用同一套值／單位正規化規則。

| 範圍 | 完成內容 | 安全結果 |
|---|---|---|
| 策略新增／編輯 UI | 移除快照狀態對倉位數值及單位的 `disabled`；新增「可獨立覆寫」標示、快照原值對照及用途說明 | 使用者能修改真正落盤的值與單位，不會誤改回測快照 |
| 20415／V2.5 專用面板 | 將 `Base_Lot_Size` 明確標示為「策略／回測配置基準」，不再與頂層實盤部署倉位混為一談 | 兩套畫面狀態不再互相覆蓋 |
| 共用部署倉位服務 | 新增嚴格建立、舊資料解析、三欄同步及數字／物件型有效配置工具 | 拒絕非有限值、零、負數及未知單位；保留原始快照物件不變 |
| 一般策略路由 | create／update 以頂層 `positionSize`、`positionMode` 為正式來源，專用配置不得在末段覆蓋 | 現有及未來策略遵循同一持久化契約 |
| 快照建立新策略 | 接受使用者覆寫後的數值與單位；保留原引擎及原始配置；新策略保持停用 | 不會因導入立即開始交易 |
| 快照套用既有策略 | 只更新策略邏輯、風控及週期配置，不寫入部署倉位、不改 `enabled`、不重置運行狀態 | 不下單、不平倉、不改變既有持倉 |
| 自動訊號與實盤執行器 | 20415、V2.5、V3.5、V5.0、V6.1、V7.0 及通用分支都在快照合併後套用部署倉位 | USDT 模式按即時價格換算；quantity 模式直接使用幣量 |
| Webhook 邊界 | 外部 payload 只解析方向、交易對、價格及 Bar 時間，不接受 `lotUsdt` 或專用內部決策欄位 | 外部訊號不能偽造倉位繞過部署設定 |

### 20415 問題的具體結果

20415 快照先由 `normalizeRainbow20415Config` 還原物件型 `Base_Lot_Size`，因此表單預填的數值及單位與快照一致；提交時則永遠取頂層實盤部署欄位。伺服器不再要求提交單位必須與快照相同，也不再用快照 `Base_Lot_Size` 覆蓋提交值。自動決策與最終委託會先校驗原始 20415 配置，再以部署值建立只存在於本次執行記憶體的有效配置，馬丁倍率仍按原策略邏輯計算。

> 例：快照原值為 `100 USDT` 時，介面初始仍顯示 `100 USDT`。使用者可改成 `35 USDT`，也可改成合法的幣數量；真正送往交易所的委託依覆寫後的值與單位計算，而快照及回測報告保持 `100 USDT` 不變。

## 驗證結果

| 驗證項目 | 結果 |
|---|---|
| TypeScript 全專案檢查 | 通過，無型別錯誤 |
| 部署倉位定向回歸 | 4 個測試檔、41 項測試全部通過 |
| 完整 Vitest | 38 個測試檔通過、1 個測試檔依既有條件跳過；489 項通過、4 項跳過 |
| 生產建置 | Vite 前端與 Node 伺服器 bundle 均成功 |
| LSP／專案健康 | 無錯誤 |
| UI 靜態驗收 | 已確認倉位 `Input`、單位 `Select` 均無快照 `disabled`／`readOnly`，桌面與手機斷點沿用既有響應式網格 |
| 登入式預覽截圖 | 擷取環境回傳空白頁，未取得可用視覺證據；未以此取代 TypeScript、測試、建置及靜態 JSX 驗收 |

新增回歸案例涵蓋嚴格數值／單位校驗、舊資料回退、三欄同步、快照不變性、20415 物件型底倉覆寫、V3.5 同步與非同步決策、V5.0 百分比控倉優先序，以及 Webhook 無法注入專用倉位欄位。完整測試期間沒有執行建立策略、啟用策略、下單、平倉或資料庫批次遷移。

## 主要程式位置

| 類別 | 路徑 |
|---|---|
| 前端策略表單 | `client/src/pages/Strategies.tsx` |
| 20415／V2.5 配置標示 | `client/src/components/Rainbow20415ConfigPanel.tsx`、`client/src/components/V25ConfigPanel.tsx` |
| 部署倉位共用契約 | `server/services/deploymentPosition.ts` |
| 一般建立／編輯路由 | `server/routers.ts` |
| 快照建立／套用路由 | `server/routers/backtest.router.ts` |
| 自動訊號 | `server/services/autoTradeSignalGenerator.ts` |
| 最終委託 | `server/services/executor.ts` |
| 核心優先序 | `server/strategies/v35/strategy_kama_3k_v35.ts`、`server/strategies/v50/strategy_kama_3k_v50.ts` |
| 回歸測試 | `server/deployment-position.test.ts`、`server/position-mode.test.ts`、`server/executor-signal-payload.test.ts`、`server/services/strategySnapshotConfig.test.ts` |
