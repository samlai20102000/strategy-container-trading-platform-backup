# 專案關鍵背景（防止上下文壓縮遺失）

## 平台現況（第一輪已交付 checkpoint 23f8f8ff）
自動化加密貨幣交易平台：TradingView Webhook（secret 驗證）→ Bybit/OKX V5 REST 下單。
已有：多策略管理、風險監控（20s 循環自動平倉+停用）、訊號日誌、儀表板、績效統計、金鑰 AES-256-GCM 加密、13 項 vitest 通過。
頁面：儀表板 /、策略管理 /strategies、訊號日誌 /signals、持倉監控 /positions、API 設定 /api-keys。
Webhook: POST /api/webhook/:strategyId?secret=xxx（server/webhook.ts，express）。
TradingView Alert 格式：{ "action": "buy"|"sell"|"close", "symbol": "{{ticker}}", "price": {{close}}, "secret": "<webhookSecret>" }

## 本輪任務（用戶最終執行命令，三大模塊按優先級）
1. 模塊一（已完成）：API 設定修復——5 秒逾時、Bybit/OKX 錯誤碼解析（10002=IP白名單含伺服器IP、10004=簽名）、表單內測試連線（成功顯示「✅ 連線成功，餘額：XXX USDT」）、伺服器公網 IP banner 可複製
2. 模塊三（進行中）：策略表單加馬丁參數（馬丁倍率/最大層數/加倉間距）+ 訊號日誌「發送測試信號」按鈕（後端 signals.sendTestSignal 已完成：寫入模擬 BUY 日誌 status=executed）
3. 模塊二（待做）：策略工作室——貼 TS 代碼/上傳 .ts → esbuild 編譯 → 動態載入註冊；內建 Strategy20415 保護（禁止覆蓋/刪除、「內建」標籤）；自訂策略存 server/strategies/custom/，命名 strategy_{timestamp}_{className}.ts

## 驗收標準（用戶指定）
1. 測試連線成功顯示「✅ 連線成功，餘額：XXX USDT」（done）
2. 連線失敗顯示具體原因含 IP 白名單提示（done）
3. 策略工作室貼入 Strategy20415 代碼 3 秒內顯示「✅ 策略註冊成功」
4. 策略列表顯示可複製 Webhook URL（第一輪已有）
5. 訊號日誌「發送測試信號」→ 立即出現模擬 BUY 記錄狀態成功（後端 done，前端待加按鈕）

## 用戶文件關鍵代碼（/home/ubuntu/upload/pasted_content_3.txt 已讀）
- BaseStrategy 抽象類：key/name/defaultConfig/isBuiltIn + generateActions(signal, instance, marketData, martinState) → {action: OPEN_LONG|OPEN_SHORT|CLOSE_ALL|HOLD, lotSize, stopLoss?, takeProfit?, reason?}
- Strategy20415：EMA30/60 判多空 + 馬丁 currentLot = initial_lot * martin_multiplier^loss_count（上限 max_martin_level 層）；BUY+isBull→OPEN_LONG，SELL+!isBull→OPEN_SHORT，CLOSE→CLOSE_ALL；SL/TP 用 ATR 倍數
- defaultConfig: ema_lower:30, ema_upper:60, ema_enter:3, initial_lot:0.06, martin_multiplier:1.5, max_martin_level:5, stop_loss_atr_mult:0.8, take_profit_atr_mult:1.5
- 編譯器：esbuild build tsPath→jsPath (cjs, node18, bundle:false)，import(jsPath)，找 prototype.generateActions export，驗證 key/name/defaultConfig
- 註冊中心：Map + BUILT_IN_KEYS=['strategy_20415'] 禁止覆蓋/刪除

## 本輪已完成改動
- bybit.ts/okx.ts：REQUEST_TIMEOUT_MS=5000、TimeoutError、parseErrorCode、testConnection(serverIp?) 回傳 balance
- types.ts：testConnection(serverIp?)→{success,message,balance?}；factory.ts：AdapterCredentials Pick 型別
- routers.ts：getServerPublicIP()（快取10分）、apiKeys.getServerIP、apiKeys.testCredentials、testConnection 傳 serverIp；strategyInputSchema+create/update 加馬丁欄位；signals.sendTestSignal
- ApiKeys.tsx：IP banner、對話框內測試連線按鈕 + 結果顯示
- schema.ts：strategies 加 martinMultiplier/maxMartinLevel/martinSpacingPct/martinState(json)/strategyKey；新表 strategy_definitions；遷移 0002 已套用

## 已完成（本輪追加）
- Strategies.tsx：馬丁參數區塊（倍率/層數/間距）+ strategyKey 選擇（trpc.studio.list）+ 卡片「測試信號」按鈕（FlaskConical）
- Signals.tsx：工具列「發送測試信號」按鈕（依策略篩選或第一個策略）
- server/strategies/base.ts：BaseStrategy 抽象類 + StrategySignal/StrategyInstanceConfig/MarketData/MartinState/StrategyAction 型別 + calcMartinLot
- server/strategies/builtin/strategy20415.ts：內建 Strategy20415（isBuiltIn=true, key=strategy_20415）
- server/services/strategyStudio.ts：register/getStrategy/listRegisteredStrategies/isBuiltInKey、validateStrategyCode（禁 child_process/fs/net/http/eval/new Function/process.env）、compileAndLoadStrategy（esbuild CLI spawnSync --bundle --format=esm → tmpdir → dynamic import → 找 generateActions 類 → 驗證 key/name/defaultConfig → 禁覆蓋內建 → register → 備存 CUSTOM_DIR）、initStrategyStudio()（註冊內建+DB 重載）、unregisterStrategy

## 已完成（第二輪追加）
- db.ts：已加 listAllActiveStrategyDefinitions/listStrategyDefinitions/getStrategyDefinitionByKey/upsertStrategyDefinition/deleteStrategyDefinition/updateStrategyMartinState
- routers.ts：studio router 完成（list/register(code,sourceType,filename)/delete(key)/getSource）已掛入 appRouter；register 流程：compileAndLoadStrategy→key衝突檢查→upsertStrategyDefinition
- server/_core/index.ts：啟動時 initStrategyStudio()，已驗證 log：內建策略已註冊 strategy_20415
- executor.ts：strategyKey 綁定時經 engine.generateActions 決策（HOLD=skipped、CLOSE_ALL=平倉、OPEN_LONG/SHORT 覆寫方向與 lotSize）；getMartinState/updateMartinAfterClose 導出；orderSide 型別修正
- esbuild 已加入 production dependencies
- client/src/pages/Studio.tsx：完成（範本載入/上傳.ts/貼代碼/註冊結果顯示/已註冊列表含內建鎖定 Badge/刪除）
- 開發伺服器已重啟成功，0 TS errors，console 舊錯誤為歷史記錄

## 驗收階段進度（phase 9）
- App.tsx 已加 /studio 路由 + import Studio；DashboardLayout 已加「策略工作室」FlaskConical nav
- studio.test.ts：35/35 全部通過（calcMartinLot 用 MartinProbe 子類測、validateStrategyCode 回傳 ok 非 valid、馬丁封頂為 maxLevel-1、EMA 趨勢過濾測試、ATR 止損止盈測試、內建保護、動態編譯載入）
- FORBIDDEN_PATTERNS 已強化：fetch/XMLHttpRequest/WebSocket/dns/os/tls/dgram/https
- tsconfig exclude 加 server/strategies/custom/**（動態備存檔不參與 tsc）
- 注意：每次跑完測試要 rm -f server/strategies/custom/strategy_*.ts（測試會寫備存檔）
- 問題：舊 node 進程（pid 13022）佔用 3001；新 server 在 3000 且 localhost:3000 回 200，但 preview URL 回 502、webdev_take_screenshot 失敗。待解：kill 13022 或再 restart
- 已解：502 問題為舊 iptables REDIRECT 3000→3003 殘留規則，已刪除（sudo iptables -t nat -D PREROUTING/OUTPUT），preview 200 OK
- 截圖驗收完成：六頁全部正常渲染，伺服器 IP banner 顯示 103.130.175.70，Studio 顯示內建策略 Strategy20415 含鎖定 Badge
- 審查確認：apiKeys.create 無 try/catch 包裹（但 tRPC 會自動把 throw 轉錯誤回應，前端 onError 會停 loading）；testConnection 有 try/catch；sendTestSignal 實作完整（寫入 signals 表 status=executed）
- todo.md 已全部勾選；待：補充整合測試（apiKeys create 錯誤、sendTestSignal 寫入驗證）、checkpoint、交付

## 待做（剩餘）
- App.tsx：註冊 /studio 路由；DashboardLayout.tsx：側邊欄加「策略工作室」nav item（用 Code2 or FlaskConical icon）
- riskMonitor.ts：平倉時呼叫 updateMartinAfterClose（可選）
- 單元測試：calcMartinLot、validateStrategyCode、compileAndLoadStrategy（用範本代碼變體）、Strategy20415.generateActions
- 驗收：截圖五頁+Studio、curl 測 webhook、測試信號按鈕
- checkpoint + 交付

## 舊待做（已完成，依據上方）
- db.ts：加 strategy_definitions helpers：listAllActiveStrategyDefinitions()、listStrategyDefinitions(userId)、getStrategyDefinitionByKey(key)、createStrategyDefinition、updateStrategyDefinition、deleteStrategyDefinition（TS 錯誤：strategyStudio.ts 用到 listAllActiveStrategyDefinitions）
- routers.ts：studio router（list=內建+DB合併、paste(code)、upload(code,filename)、delete(key)）→ 掛入 appRouter（TS 錯誤：Strategies.tsx 用 trpc.studio.list）；paste/upload 流程：compileAndLoadStrategy → 成功後 upsert DB（key 唯一 per user，version+1）
- server/_core/index.ts：啟動時 await initStrategyStudio()（在 startRiskMonitor 附近）
- 前端策略工作室 UI：Strategies 頁加第三個 Tab「策略工作室」：代碼 textarea + 上傳 .ts（FileReader）+ 已註冊策略列表（內建 Badge、刪除自訂、顯示 defaultConfig）+ 範本代碼複製按鈕
- executor.ts 整合 strategyKey：getStrategy(key).generateActions() 決策 OPEN_LONG/OPEN_SHORT/CLOSE_ALL/HOLD + lotSize 覆蓋倉位；馬丁狀態更新（平倉時依已實現盈虧 lossCount+1 或歸零，寫回 martinState）
- esbuild 需在 production dependencies：pnpm add esbuild（目前僅 devDeps）
- 測試：馬丁計算、validateStrategyCode、compileAndLoadStrategy（貼 Strategy20415 變體代碼）、錯誤碼解析
- 驗收截圖五項、checkpoint、交付

## 重要限制
- 部署為 serverless：自訂策略以 DB sourceCode 為真相來源，冷啟動從 DB 重建記憶體註冊表；檔案僅為編譯暫存（os.tmpdir 或 server/strategies/custom/）
- 上傳走 tRPC 傳 code 字串（前端 FileReader 讀 .ts）
- esbuild 在 devDependencies（production build 時 esbuild 為 build 工具，runtime 需將 esbuild 移至 dependencies 才能動態編譯）→ 需 pnpm add esbuild -P 確認
- dev server 曾有 zombie port 問題：preview 走 127.0.0.1:3000 iptables redirect 至實際 port
- 現有測試：server/trading.test.ts（13 pass）
