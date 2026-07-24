# V4.2 整體系統一致性優化 - 實現計劃

## 核心目標
建立「策略註冊中心」(strategy_registry)，讓策略工作室、回測中心、策略管理、參數快照庫共享同一數據源。

## 現有系統適配分析

### 現有架構（需保留）
- 使用 MySQL/TiDB（非 PostgreSQL），drizzle/schema.ts 使用 mysqlTable
- 已有 strategyInstances 表（int id, 非 uuid）
- 已有 parameterSnapshots 表（int id）
- 已有 scanJobs 表
- 已有 backtestRuns 表
- 策略在記憶體中通過 strategyStudio.ts 的 initStrategyStudio() 註冊
- 路由掛載在 server/routers.ts 的 appRouter 中

### 文件中的代碼需要適配的部分
1. Schema 使用 pgTable + uuid → 需改為 mysqlTable + int autoincrement
2. 文件中的 strategy.router.ts 需整合到現有 routers.ts 結構
3. RegistryManager 需適配現有 db.ts 的查詢模式
4. 前端組件需使用 shadcn/ui + Tailwind（非原始 HTML select）

## 執行步驟

### Phase 1: DB Schema 升級
- 新增 strategy_registry 表（mysqlTable, int id）
- 修改 strategy_instances 表新增 definition_key 欄位（可空，向後兼容）
- 修改 parameter_snapshots 表新增 definition_key 欄位

### Phase 2: 後端 RegistryManager
- 建立 server/services/registryManager.ts（適配 MySQL + 現有 db 模式）
- 整合到現有路由系統

### Phase 3: 策略路由更新
- 在 server/routers.ts 中新增 registry 相關端點
- 保持現有端點向後兼容

### Phase 4: 前端統一組件
- 建立 StrategySelector.tsx（使用 shadcn/ui Select）
- 建立 InstanceSelector.tsx
- 更新策略工作室、回測中心、策略管理、參數快照庫

### Phase 5: 數據遷移 + 測試
- 遷移腳本：將現有記憶體策略寫入 strategy_registry
- 端到端測試驗證
