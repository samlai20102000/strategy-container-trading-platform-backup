# Heartbeat 任務管理設計筆記

## 現有後端 API（autoTrade.router.ts）
- `generateSignal` - mutation: { strategyId, symbol } → 生成信號
- `executeSignalAction` - mutation: { signalId, strategyId } → 執行交易
- `getStatus` - query: { strategyId } → 策略狀態
- `getHeartbeatStatus` - query → 所有策略的 Heartbeat 狀態

## 需要新增的後端 API
- `createHeartbeatTask` - mutation: { strategyId, kLinePeriod } → 創建任務（啟用策略）
- `toggleHeartbeatTask` - mutation: { strategyId, enabled } → 切換啟用/暫停
- `deleteHeartbeatTask` - mutation: { strategyId } → 刪除任務（停用策略）
- `triggerHeartbeatTask` - mutation: { strategyId, symbol } → 手動觸發信號生成

## heartbeatManager.ts 現有函數
- `setupHeartbeatForStrategy(config, userSession)` → { taskUid }
- `disableHeartbeatForStrategy(taskUid, userSession)` → void
- `deleteHeartbeatForStrategy(taskUid, userSession)` → void
- `listHeartbeatTasks(userSession)` → HeartbeatJobInfo[]

## 問題：userSession
- heartbeatManager 需要 userSession 字符串
- 當前 tRPC context 只有 { req, res, user }
- 需要從 req.headers.cookie 中提取 session token
- Cookie name: "app_session_id"

## 策略表結構（strategies）
- id, userId, name, symbol, enabled, strategyKey, apiKeyId
- 沒有 taskUid 字段 → 暫時用 enabled 字段控制任務狀態
- 簡化方案：enabled=true 視為 running，enabled=false 視為 stopped

## 前端策略列表 API
- `trpc.strategy.list.useQuery()` → 獲取策略列表
