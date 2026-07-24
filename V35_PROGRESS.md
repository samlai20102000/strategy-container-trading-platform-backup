# V3.5 實作進度記錄（防 context 遺失）

## 用戶指令
按 UNCOMPLETED_ITEMS.md 全部執行：修復 TS 錯誤 → Webhook 接收器 → 馬丁引擎 → 風險管理器 → 逐項完成全部 10 個模組。

## 已完成（截至目前）
1. [x] TypeScript 20 個錯誤修復：
   - `server/strategies/base.ts` 擴展：StrategySignal.barTimestamp、StrategyInstanceConfig.state、MarketData KAMA/3K 欄位、StrategyState 介面、createInitialStrategyState()、StrategyValidationResult、BaseStrategyV35 抽象類（validateSignal + generateActionsV35）
   - `server/strategies/v35/strategy_kama_3k_v35.ts` 重寫：extends BaseStrategyV35，五層驗證（KAMA 方向鎖/3K 形態/破位/冷卻/Bar-Lock/反向持倉檢查），generateActionsV35 + 相容舊版 generateActions。key = "20415_KAMA_MARTIN_V35"
   - tsc --noEmit 全過（0 errors）
2. [x] `server/services/martingaleEngine.ts`：MartingaleEngine 類（shouldAddLayer/addLayer/reset/getState + 靜態 calcLayerLot/previewLayers）
3. [x] `server/services/riskManager.ts`：RiskManager 類（checkLimitStop 條件 A 浮虧>=初始資本×10% / 條件 B 最後層偏離>=3%、checkDailyLoss）
4. [x] `server/services/barLock.ts`：DB 版 Bar-Lock（acquireBarLock/releaseAllLocks/cleanupExpiredLocks/__clearMemoryLocks），記憶體快取 + DB 唯一鍵原子插入，TTL=K線週期×2×60秒
5. [x] `drizzle/schema.ts` 新增 barLocks 表（bar_locks），migration 0003 已用 webdev_execute_sql 應用到 DB
6. [x] `server/services/strategyStateManager.ts`：loadStrategyState（相容舊 MartinState 自動遷移）/saveStrategyState（寫入 strategies.martinState JSON）/resetStrategyState/reconcileWithExchange（與交易所對賬修正）
7. [x] `server/services/executor.ts` 整合：
   - parseSignalPayload 支援 bar_timestamp/barTimestamp/time 提取
   - ParsedSignal.barTimestamp 欄位
   - executeSignal 中：engine instanceof BaseStrategyV35 → 走 executeSignalV35 專用管線
   - executeSignalV35 函數已加入：Bar-Lock（僅初始開倉）→ validateSignal → generateActionsV35 → CLOSE_ALL（分流：馬丁解套 currentLayer>1 → 冷卻 K×2 分鐘；否則立即重入）→ 開倉下單 → MartingaleEngine.addLayer 更新狀態 → saveStrategyState

## 待完成（接下來要做）
- [x] executor.ts tsc 通過
- [x] V3.5 策略註冊到 strategyStudio（BUILT_IN_KEYS + initStrategyStudio 註冊）
- [x] trailingStopManager.ts（激活/追蹤/回撤平倉，多空雙向）
- [x] v35Monitor.ts 實時監控循環（每 20 秒：極限止損→移動止盈→馬丁自動加倉），已在 _core/index.ts 啟動
- [x] notifier.ts 告警通知（包裝 owner notification，極限止損/止盈/加倉觸發）
- [x] vitest 測試 server/v35-system.test.ts 28/28 通過（馬丁/風控 A+B/移動止盈/五層驗證）
- [x] 前端動態表單：Strategies.tsx V35ConfigPanel（分組參數對照 + 馬丁倉位預覽表，後端 studio.previewMartinLayers 端點含觸發價/均價/累計成本）
- [x] 信號日誌（signals 表 blocked/invalid 原因已寫入 executeSignalV35 管線）
- [x] 全部測試通過 76/76（6 個測試檔，含 v35-system.test.ts 28 項）
- [ ] 截圖驗證 → webdev_save_checkpoint → 交付

## 關鍵參數（Pasted_content_17.txt）
- Initial_Capital=1000, Base_Lot_Size=0.01, Max_Drawdown_Pct=10
- KAMA_Fast_Length=50 (p2=10,p3=2), KAMA_Slow_Length=50 (q2=10,q3=6)
- Martin_Step_Pct=1.5, Martin_Multiplier=1.5, Max_Layers=5
- Target_TP_Pct=1.0, Callback_Pct=0.2, K_Line_Period=30
- 極限止損：條件 A 浮虧>=初始資本×10%；條件 B 最後層偏離>=3%（固定）
- Bar-Lock TTL = K_Line_Period × 2 × 60 秒
- 冷卻期（分流 B）= K_Line_Period × 2 分鐘；分流 A（首層止盈）無冷卻

## 現有專案關鍵檔案
- server/services/strategyStudio.ts：策略註冊中心（getStrategy/initStrategyStudio，內建 strategy_20415）
- server/services/riskMonitor.ts：風險監控循環（每 20 秒，devserver log 顯示 [RiskMonitor] 風險監控已啟動）
- server/webhook.ts：POST /api/webhook/:strategyId → processWebhookSignal
- server/db.ts：getStrategyById/updateStrategyMartinState/createTrade/createSignal/updateSignal/createRiskEvent/disableStrategySystem/getTodayRealizedPnl
- server/exchanges/types.ts：Position{side:"long"|"short",size,entryPrice}, ExchangeAdapter{placeOrder,getBalance,getPositions,closePosition}
- server/exchanges/factory.ts：createAdapter(apiKeyRecord)
- 前端：client/src/pages/Strategies.tsx（策略卡片+建立對話框+引導彈窗）、Home.tsx（儀表板+緊急全平倉）、ApiKeys.tsx
- 測試：server/p1-optimizations.test.ts 等，pnpm test 目前 48/48 通過（未含新 V3.5 測試）

## 注意事項
- serverless 部署：無 Redis，Bar-Lock 用 DB 實作；無常駐進程，riskMonitor 在 dev 有效、生產需 heartbeat（已有 references/periodic-updates.md）
- strategies 表 martinState JSON 欄位現在儲存 V3.5 StrategyState（loadStrategyState 自動遷移舊格式）
- checkpoint 歷史：33ed174a（連線修復）→ 076ca919（P1 完成）
- Bybit 連線問題（用戶回報）：API 設定頁測試正常、儀表板顯示 JSON 解析錯誤；已加診斷日誌，等用戶重測。與 V3.5 實作獨立。
