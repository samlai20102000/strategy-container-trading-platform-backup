# V4.4 系統整改分析（pasted_content_6.txt）

## 文件內容摘要

用戶提供了一份「系統整改最終執行命令」，要求逐行逐項執行。分析後發現：

### 文件要求 vs 現有系統對比

| 文件要求 | 現有系統狀態 | 需要做什麼 |
|---------|------------|-----------|
| 1.1 strategy_registry 表（PostgreSQL pgTable） | 已有 strategyDefinitions 表（MySQL mysqlTable）+ schemaConfig 欄位 | 不需要重建，現有表已覆蓋功能 |
| 1.2 RegistryManager | 已有 server/services/registryManager.ts | 需要增強：加入 cache TTL + clearCache |
| 1.3 策略 Schema 定義 | 已有 server/config/strategySchemas.ts | 需要對齊：確認 KAMA_3K_SCHEMA 和 STRATEGY_20415_SCHEMA 完整 |
| 1.4 策略路由 | 已有 registry 路由在 routers.ts 中 | 需要增強：加入 registerStrategy mutation |
| 1.5 遷移腳本 | 已執行 migrate_schema_config.mjs | 已完成 |
| 2.1 DynamicForm | 已有 client/src/components/DynamicForm.tsx | 需要增強：加入倉位預覽表格 + 條件子欄位 |
| 2.2-2.6 頁面更新 | 已部分完成 | 需要確認回測中心和策略管理已整合 |
| 3.1 快照導入 API | 已有 importSnapshotAsNew 端點 | 已完成 |
| 3.2 快照導入 UI | 已有導入對話框 | 已完成 |
| 4.1 TaskQueue | 已整合到 backtestJobManager | 已完成 |
| 4.2 WebSocket | 未實現 | 需要新增：回測進度 WebSocket 推送 |
| 4.3 前後端串接 | 部分完成 | 需要確認 WebSocket 串接 |

## 實際需要執行的增量工作

### P0：增強 RegistryManager
- 加入 cache TTL 機制（已有但需確認）
- 加入 registerStrategy mutation 到路由（允許用戶上傳/貼上新策略）

### P0：增強 DynamicForm
- 加入倉位預覽表格（renderPreview）
- 加入 conditional 子欄位渲染（children）
- 加入 onImportSnapshot 按鈕

### P1：WebSocket 回測進度推送
- 建立 WebSocket 服務（ws 包）
- 回測進度從輪詢改為 WebSocket 推送
- 前端連接 WebSocket 接收即時進度

### P1：策略路由增強
- 新增 registerStrategy mutation（支持 paste/upload 來源）
- 前端策略工作室新增「貼上代碼註冊」功能

## 關鍵決策

1. **不重建 Schema**：現有 MySQL/TiDB 表結構已覆蓋所有功能，不需要改為 PostgreSQL
2. **增量增強**：在現有代碼基礎上增強，而非重寫
3. **WebSocket 新增**：這是唯一真正的新功能，需要安裝 ws 包並建立服務
4. **DynamicForm 增強**：加入倉位預覽和條件子欄位，使其更接近文件要求
