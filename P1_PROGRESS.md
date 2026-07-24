# P1 三項優化實作進度（Pasted_content_16.txt）

## 需求來源
用戶文件 /home/ubuntu/upload/Pasted_content_16.txt 要求三項 P1 優化：
- T1：策略列表顯示 Webhook URL + 複製按鈕（現有 Strategies.tsx 已有，需確認）
- T2：策略控制按鈕（暫停/恢復/停止/手動平倉）+ 儀表板緊急全平倉按鈕
- T3：建立策略成功引導彈窗（顯示 Webhook URL + 複製 + TradingView 下一步指引）
- 另：getServerIP 加 TradingView Webhook IP 提示（52.89.214.238、34.212.75.30、54.218.53.128、52.32.178.7）

文件代碼引用 strategyInstances 表，實際平台用 strategies 表（int id、enabled boolean、disabledReason、martinState JSON），已做適配。

## 已完成（後端 server/routers.ts）
1. `TRADINGVIEW_WEBHOOK_IPS` 常數 + `getServerIP` 回傳 `{ ip, allIps, tradingViewIPs, message }`
2. `strategies.create` 回傳 `{ success, id, name, exchange, symbol, webhookUrl }`（T3 用）
3. `strategies.setStatus`：running→enabled=true；paused→enabled=false+disabledReason="手動暫停"；stopped→enabled=false+disabledReason="手動停止"+重置馬丁狀態
4. `strategies.closePosition` 升級：先 getPositions 檢查有無持倉；真實交易所市價平倉；成功後重置馬丁狀態 + pauseAfterClose（預設 true）自動暫停（disabledReason="手動暫停"）
5. `strategies.emergencyCloseAll`：遍歷所有策略→查持倉→市價平倉→記錄 trade（triggerSource=manual）→全部策略 enabled=false、disabledReason="緊急全平倉"、重置馬丁；回傳 successCount/failCount/skippedCount/results
6. `statusLabel()` helper 在 strategiesRouter 之後定義

## 待完成（前端）
- Strategies.tsx：
  - 狀態顯示：enabled→運行中（綠）；disabledReason==="手動暫停"→已暫停（黃）；其他 disabled→已停止（灰/紅含原因）
  - 控制按鈕：暫停（running時）/恢復（paused時）/停止 → trpc.strategies.setStatus；手動平倉改用新 closePosition（含二次確認 confirm x2）
  - T3：createMutation onSuccess 接收 webhookUrl → 顯示成功引導 Dialog（URL + 複製 + 下一步指引：1複製URL 2 TradingView建Alert 3自動下單）
- Home.tsx：緊急全平倉紅色按鈕（destructive、二次確認、呼叫 emergencyCloseAll、顯示結果 toast、invalidate overview）
- ApiKeys.tsx：伺服器 IP banner 顯示 allIps（多 IP）+ TradingView IP 提示（tradingViewIPs 顯示與複製）

## 待完成（測試/交付）
- 新增/更新 vitest 測試（39 項現有測試需保持通過）
- webdev_take_screenshot 驗證 /strategies、/、/api-keys
- 更新 todo.md 勾選
- webdev_save_checkpoint → result 訊息交付

## 技術要點
- closePosition 適配器：Bybit 逐倉位 reduce-only 市價單；OKX /trade/close-position（51023=無持倉視為良性）
- adapter.getPositions(symbol) 支援 symbol 過濾
- 前端用 shadcn/ui：Button、Dialog、toast(sonner)、confirm() 二次確認
- trpc client 用法：trpc.strategies.setStatus.useMutation() 等
- 現有測試：pnpm test（vitest，39 項）
- checkpoint 歷史：46e25d80（核心閉環）→ 33ed174a（連線測試修復）
