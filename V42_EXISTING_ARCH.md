# V4.2 現有系統架構關鍵信息

## DB Schema（MySQL/TiDB，使用 mysqlTable + int autoincrement）
- users: id(int), openId, name, email, role
- apiKeys: id(int), userId(int), exchange(bybit|okx), apiKeyEncrypted...
- strategies: id(int), userId(int), strategyKey(varchar 100, nullable), martinState(json)...
- strategyDefinitions: id(int), userId(int), key(varchar 100), name, sourceCode, defaultConfig(json), sourceType(system|paste|upload), isBuiltIn, isActive, version
- parameterSnapshots: id(int), userId(int), strategyKey(varchar 100), config(json), metrics(json)...
- scanJobs: id(int), userId(int), strategyKey(varchar 100)...
- signals, trades, riskEvents, barLocks, favoriteSymbols

## 策略記憶體註冊（strategyStudio.ts）
- strategyMap: Map<string, BaseStrategy>
- listRegisteredStrategies(): StrategyMeta[] (key, name, defaultConfig, isBuiltIn, sourceType)
- getStrategy(key): BaseStrategy | undefined
- initStrategyStudio(): 註冊內建 + 從 DB strategyDefinitions 重載自訂策略
- BUILT_IN_KEYS: ["strategy_20415", "20415_KAMA_MARTIN_V35"]

## 路由結構（server/routers.ts）
- appRouter 掛載: apiKeys, strategies, signals, dashboard, performance, studio, exchange, backtest
- studioRouter.list: 合併 listRegisteredStrategies() + db.listStrategyDefinitions(userId)
- studioRouter.register: compileAndLoadStrategy + db.upsertStrategyDefinition
- strategiesRouter.list: db.listStrategies(userId) → 返回交易實例列表
- strategiesRouter.create: 建立交易實例，strategyKey 關聯策略定義

## V4.2 適配策略（不破壞現有功能）
1. 已有 strategyDefinitions 表 = 文件中的 strategy_registry 概念
2. 不需要新建 strategy_registry 表，而是擴展現有 strategyDefinitions 表加入 schema_config 欄位
3. 建立 RegistryManager 作為統一查詢介面，包裝現有 strategyStudio.ts + db.ts 邏輯
4. 在路由中新增統一端點 registry.listDefinitions / registry.getSchema
5. 前端建立 StrategySelector / InstanceSelector 組件，統一所有模塊的策略選擇
6. 參數快照庫的 applySnapshot 加入 definitionKey 匹配驗證
