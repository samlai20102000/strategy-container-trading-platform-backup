# pasted_content_3.txt 四大優化實現計劃

## 文件要求 vs 現有系統差異分析

### 現有系統架構
- DB: MySQL/TiDB via Drizzle ORM (drizzle/schema.ts 已有 users, apiKeys, strategies, signals, trades, riskEvents, strategyDefinitions, barLocks, favoriteSymbols)
- 回測持久化: SQLite (server/services/backtest/backtestDatabase.ts) - 獨立於主 DB
- 回測任務管理: backtestJobManager.ts (in-memory Map, 2 concurrent, 30min timeout)
- 回測路由: backtest.router.ts (run/getProgress/getResult/listRuns/optimize/multiSymbol)
- 參數優化: optimizer.ts (同步笛卡爾積, max 60 combinations, 含 heatmapData)
- 前端: Backtest.tsx (async job + progress polling + report)

### 文件要求的四大功能
1. **TiDB 遷移（雙寫）** - 現有系統已使用 TiDB/MySQL 作為主 DB，回測數據在 SQLite。需要：將回測結果也寫入主 DB
2. **回測超時保護** - 現有 backtestJobManager 已有 30min timeout。需要：可配置超時 + 取消功能 + timeout 狀態
3. **參數快照庫** - 全新功能。需要：parameter_snapshots 表 + CRUD API + 前端 UI
4. **參數掃描（熱力圖）** - 現有 optimizer.ts 已有基礎。需要：scan_jobs 表 + 異步掃描 + 前端熱力圖 UI

### 適配策略（優先使用現有代碼，不破壞已通過的 258 測試）

#### Phase 2: Schema 升級
- 新增 `parameter_snapshots` 表到 drizzle/schema.ts (MySQL 版本，非 pg)
- 新增 `scan_jobs` 表到 drizzle/schema.ts
- 執行 SQL 遷移

#### Phase 3: 後端
- 升級 backtestJobManager.ts：新增可配置超時 + cancel 方法 + timeout 狀態
- 新增 backtest.router.ts 端點：saveSnapshot / getSnapshots / deleteSnapshot / applySnapshot
- 升級 optimizer.ts → scanEngine 模式：異步 + 記錄到 DB + 熱力圖數據
- 回測結果雙寫：完成時同步寫入主 DB (TiDB)

#### Phase 4: 前端
- 新增 ParameterSnapshotLibrary.tsx 頁面（側邊欄導航）
- 新增 HeatmapChart.tsx 組件（使用 echarts）
- BacktestReport.tsx 新增「儲存快照」按鈕
- Backtest.tsx 新增超時設定 + 掃描入口

#### 關鍵參數（來自文件 defaultConfig）
- Initial_Capital = 10000
- Base_Lot_Size = 30 USDT
- Martin_Step_Pct = 2.0%
- 分層：1-4層×1.5, 5-9層×1.1, 10-11層×1.0
- Target_TP_Pct = 1.0, Callback_Pct = 0.1, Max_Loss_Pct = 5%

## 新增表 SQL（MySQL/TiDB 格式）

```sql
CREATE TABLE IF NOT EXISTS parameter_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  strategyKey VARCHAR(100) NOT NULL,
  strategyName VARCHAR(200),
  snapshotName VARCHAR(200),
  config JSON NOT NULL,
  metrics JSON NOT NULL,
  totalReturn DECIMAL(10,2),
  winRate DECIMAL(8,2),
  sharpeRatio DECIMAL(8,3),
  profitFactor DECIMAL(8,2),
  maxDrawdown DECIMAL(8,2),
  isFavorite BOOLEAN DEFAULT FALSE,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scan_jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  strategyKey VARCHAR(100) NOT NULL,
  strategyName VARCHAR(200),
  symbol VARCHAR(40) NOT NULL,
  timeframe VARCHAR(10) NOT NULL,
  startTime BIGINT NOT NULL,
  endTime BIGINT NOT NULL,
  initialCapital DECIMAL(20,8) NOT NULL,
  baseConfig JSON NOT NULL,
  scanParams JSON NOT NULL,
  totalCombinations INT DEFAULT 0,
  completedCombinations INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending',
  results JSON,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completedAt TIMESTAMP NULL
);
```
