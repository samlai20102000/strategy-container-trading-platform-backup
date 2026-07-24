# V4.3 實現計劃 - DynamicForm + TaskQueue + WebSocket

## 文件分析

### 需求摘要（pasted_content_5.txt）
1. **DynamicForm 核心組件** - Schema-Driven 動態表單（條件顯示、倉位預覽）
2. **TaskQueue 非同步佇列** - 解決回測/掃描「假死」問題
3. **WebSocket 進度推送** - 即時推送任務進度（替代輪詢）
4. **策略 Schema 定義** - 各策略的 FieldSchema 配置
5. **策略註冊時寫入 Schema** - 註冊路由自動填充 schemaConfig
6. **回測中心改用 DynamicForm** - 替換硬編碼參數表單
7. **新增策略改用 DynamicForm** - 替換硬編碼
8. **快照庫「導入新策略」** - 一鍵從快照建立新策略實例
9. **快照導入 API** - applySnapshotToNew 後端端點

### 現有系統適配分析

1. **DynamicForm**：文件用原生 HTML input/select，需改為 shadcn/ui 組件（Input, Select, Switch, Checkbox）以保持 UI 一致性
2. **TaskQueue**：現有 backtestJobManager 已有類似功能（submit/cancel/progress/timeout），需整合而非重建
3. **WebSocket**：Manus WebDev 部署環境是 Autoscale（serverless），WebSocket 長連接不適合。保留現有 tRPC 輪詢方案（已有 refetchInterval: 1500ms），但可優化輪詢頻率
4. **策略 Schema**：V4.2 已有 schemaConfig 欄位和 registryManager，需要建立前端 DynamicForm 來消費這些數據
5. **快照導入新策略**：需新增 applySnapshotToNew API 端點

### 執行決策

| 文件任務 | 執行方式 | 原因 |
|---------|---------|------|
| DynamicForm | ✅ 實現（改用 shadcn/ui） | 核心功能，解決參數表單不一致問題 |
| TaskQueue | ⚠️ 整合到現有 backtestJobManager | 已有類似功能，避免重複 |
| WebSocket | ❌ 不實現 | Autoscale 部署不支持長連接，現有輪詢已足夠 |
| 策略 Schema 定義 | ✅ 實現（適配 V4.0 固定金本位參數） | 核心功能 |
| 策略註冊寫入 Schema | ✅ 整合到現有 studio.register | 已有路由，擴展即可 |
| 回測中心改用 DynamicForm | ✅ 實現 | 核心 UI 一致性 |
| 新增策略改用 DynamicForm | ✅ 實現 | 核心 UI 一致性 |
| 快照庫導入新策略 | ✅ 實現 | 新功能 |
| 快照導入 API | ✅ 實現（適配 MySQL + int ID） | 新功能 |
