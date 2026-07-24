import {
  bigint,
  boolean,
  decimal,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * 交易所 API 金鑰（加密儲存）
 * apiKeyEncrypted / apiSecretEncrypted / passphraseEncrypted 均以 AES-256-GCM 加密後儲存
 */
export const apiKeys = mysqlTable("api_keys", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  label: varchar("label", { length: 100 }).notNull(),
  exchange: mysqlEnum("exchange", ["bybit", "okx"]).notNull(),
  apiKeyEncrypted: text("apiKeyEncrypted").notNull(),
  apiSecretEncrypted: text("apiSecretEncrypted").notNull(),
  /** OKX 專用 passphrase，加密儲存；Bybit 為 null */
  passphraseEncrypted: text("passphraseEncrypted"),
  /** 是否使用測試網 */
  isTestnet: boolean("isTestnet").default(false).notNull(),
  /** 最後測試連線狀態 */
  lastTestStatus: mysqlEnum("lastTestStatus", ["untested", "success", "failed"])
    .default("untested")
    .notNull(),
  lastTestAt: timestamp("lastTestAt"),
  lastTestMessage: text("lastTestMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = typeof apiKeys.$inferInsert;

/**
 * 交易策略配置
 */
export const strategies = mysqlTable("strategies", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  /** 綁定的交易所 API 金鑰 */
  apiKeyId: int("apiKeyId").notNull(),
  exchange: mysqlEnum("exchange", ["bybit", "okx"]).notNull(),
  /** 交易對，例如 BTCUSDT */
  symbol: varchar("symbol", { length: 32 }).notNull(),
  /** 倉位大小（基礎幣數量或 USDT 金額，舊版） */
  positionSize: decimal("positionSize", { precision: 20, scale: 8 }),
  /** 倉位大小（對象格式：{ value: number, mode: 'quantity' | 'usdt' }） */
  positionSizeObject: json("positionSizeObject"),
  /** 槓桿倍數 */
  leverage: int("leverage").default(1).notNull(),
  /** 交易方向：long 只做多 / short 只做空 / both 雙向 */
  direction: mysqlEnum("direction", ["long", "short", "both"])
    .default("both")
    .notNull(),
  /** 訂單類型 */
  orderType: mysqlEnum("orderType", ["market", "limit"])
    .default("market")
    .notNull(),
  /** 是否啟用 */
  enabled: boolean("enabled").default(true).notNull(),
  /** Webhook secret token，用於驗證 TradingView 請求 */
  webhookSecret: varchar("webhookSecret", { length: 64 }).notNull(),
  /** ==== 風險管理 ==== */
  /** 最大單筆倉位比例（佔帳戶餘額 %，0 表示不限制） */
  maxPositionPct: decimal("maxPositionPct", { precision: 6, scale: 2 })
    .default("0")
    .notNull(),
  /** 止損百分比（0 表示不設） */
  stopLossPct: decimal("stopLossPct", { precision: 6, scale: 2 })
    .default("0")
    .notNull(),
  /** 止盈百分比（0 表示不設） */
  takeProfitPct: decimal("takeProfitPct", { precision: 6, scale: 2 })
    .default("0")
    .notNull(),
  /** 每日最大虧損上限（USDT，0 表示不限制） */
  maxDailyLoss: decimal("maxDailyLoss", { precision: 20, scale: 2 })
    .default("0")
    .notNull(),
  /** 因風險觸發而停用的原因（若有） */
  disabledReason: text("disabledReason"),
  /** ==== 馬丁格參數（模塊三任務 3.3）==== */
  /** 馬丁倍率（虧損後加倉倍數，1 表示不啟用馬丁） */
  martinMultiplier: decimal("martinMultiplier", { precision: 6, scale: 2 })
    .default("1")
    .notNull(),
  /** 最大馬丁層數 */
  maxMartinLevel: int("maxMartinLevel").default(1).notNull(),
  /** 加倉間距（%，價格逆向移動多少 % 才允許加倉，0 表示不限制） */
  martinSpacingPct: decimal("martinSpacingPct", { precision: 6, scale: 2 })
    .default("0")
    .notNull(),
  /** 馬丁狀態（JSON：{ lossCount, currentLot, lastEntryPrice }） */
  martinState: json("martinState"),
  /** 循環再入場開關 */
  reentryEnabled: boolean("reentryEnabled").default(true).notNull(),
  /** 循環再入場冷卻 K 線數 */
  reentryCooldownBars: int("reentryCooldownBars").default(1).notNull(),
  /** 自訂策略 key（綁定策略工作室註冊的策略，null 表示純 webhook 直接執行） */
  strategyKey: varchar("strategyKey", { length: 100 }),
  /** 倉位模式：'quantity' = BTC 數量，'usdt' = USDT 金額 */
  positionMode: mysqlEnum("positionMode", ["quantity", "usdt"])
    .default("quantity")
    .notNull(),
  /** 交易模式：'webhook' = TradingView Webhook 觸發，'auto' = Heartbeat 自動交易 */
  tradeMode: mysqlEnum("tradeMode", ["webhook", "auto"])
    .default("webhook")
    .notNull(),
  /** Manus Heartbeat 任務 UID（自動模式下持久化） */
  heartbeatTaskUid: varchar("heartbeatTaskUid", { length: 100 }),
  /** K 線週期（分鐘），用於 Heartbeat 定時觸發 */
  kLinePeriod: int("kLinePeriod").default(15).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Strategy = typeof strategies.$inferSelect;
export type InsertStrategy = typeof strategies.$inferInsert;

/**
 * Webhook 訊號日誌：記錄每筆 TradingView 訊號的原始內容、解析結果、下單狀態與交易所回應
 */
export const signals = mysqlTable("signals", {
  id: int("id").autoincrement().primaryKey(),
  strategyId: int("strategyId"),
  userId: int("userId"),
  /** 原始 payload（JSON 字串） */
  rawPayload: text("rawPayload").notNull(),
  /** 解析後的動作：buy / sell / close */
  parsedAction: varchar("parsedAction", { length: 20 }),
  parsedSymbol: varchar("parsedSymbol", { length: 32 }),
  parsedPrice: decimal("parsedPrice", { precision: 20, scale: 8 }),
  /** 處理狀態 */
  status: mysqlEnum("status", [
    "received",
    "executed",
    "failed",
    "rejected",
    "skipped",
  ])
    .default("received")
    .notNull(),
  /** 錯誤或說明訊息 */
  message: text("message"),
  /** 交易所回傳原始訊息 */
  exchangeResponse: text("exchangeResponse"),
  /** 下單訂單 ID */
  orderId: varchar("orderId", { length: 100 }),
  /** 執行耗時 ms */
  latencyMs: int("latencyMs"),
  /** 信號來源：webhook / auto / manual */
  source: mysqlEnum("source", ["webhook", "auto", "manual"]).default("webhook").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Signal = typeof signals.$inferSelect;
export type InsertSignal = typeof signals.$inferInsert;

/**
 * 交易執行記錄（用於績效統計）
 */
export const trades = mysqlTable("trades", {
  id: int("id").autoincrement().primaryKey(),
  strategyId: int("strategyId").notNull(),
  userId: int("userId").notNull(),
  signalId: int("signalId"),
  exchange: mysqlEnum("exchange", ["bybit", "okx"]).notNull(),
  symbol: varchar("symbol", { length: 32 }).notNull(),
  side: mysqlEnum("side", ["buy", "sell"]).notNull(),
  orderType: mysqlEnum("orderType", ["market", "limit"]).notNull(),
  orderId: varchar("orderId", { length: 100 }),
  size: decimal("size", { precision: 20, scale: 8 }).notNull(),
  price: decimal("price", { precision: 20, scale: 8 }),
  /** 是否為平倉單 */
  reduceOnly: boolean("reduceOnly").default(false).notNull(),
  /** 已實現盈虧（平倉時記錄） */
  realizedPnl: decimal("realizedPnl", { precision: 20, scale: 8 }),
  status: mysqlEnum("status", ["submitted", "filled", "failed", "cancelled"])
    .default("submitted")
    .notNull(),
  /** 觸發來源：webhook / risk_stop_loss / risk_take_profit / risk_daily_loss / manual */
  triggerSource: varchar("triggerSource", { length: 30 })
    .default("webhook")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Trade = typeof trades.$inferSelect;
export type InsertTrade = typeof trades.$inferInsert;

/**
 * 風險事件記錄：風險觸發自動平倉與停用策略的審計軌跡
 */
export const riskEvents = mysqlTable("risk_events", {
  id: int("id").autoincrement().primaryKey(),
  strategyId: int("strategyId").notNull(),
  userId: int("userId").notNull(),
  eventType: mysqlEnum("eventType", [
    "stop_loss",
    "take_profit",
    "daily_loss_limit",
    "max_position",
  ]).notNull(),
  detail: text("detail"),
  /** 觸發時是否自動平倉成功 */
  positionClosed: boolean("positionClosed").default(false).notNull(),
  /** 觸發時是否自動停用策略 */
  strategyDisabled: boolean("strategyDisabled").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type RiskEvent = typeof riskEvents.$inferSelect;
export type InsertRiskEvent = typeof riskEvents.$inferInsert;

/**
 * 策略定義（策略工作室）：內建與用戶自訂策略代碼
 */
export const strategyDefinitions = mysqlTable("strategy_definitions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  /** 策略唯一 key（如 strategy_20415） */
  key: varchar("key", { length: 100 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  /** 策略 TypeScript 原始代碼 */
  sourceCode: text("sourceCode"),
  /** 預設參數 JSON */
  defaultConfig: json("defaultConfig"),
  /** 參數結構定義 JSON（前端動態渲染用，描述每個參數的類型/範圍/分組） */
  schemaConfig: json("schemaConfig"),
  /** 來源：system 內建 / paste 貼上 / upload 上傳 */
  sourceType: mysqlEnum("sourceType", ["system", "paste", "upload"])
    .default("paste")
    .notNull(),
  /** 內建策略受保護，禁止覆蓋與刪除 */
  isBuiltIn: boolean("isBuiltIn").default(false).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  /** 檔案儲存路徑（自訂策略） */
  filePath: varchar("filePath", { length: 300 }),
  version: int("version").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type StrategyDefinition = typeof strategyDefinitions.$inferSelect;
export type InsertStrategyDefinition = typeof strategyDefinitions.$inferInsert;

/**
 * Bar-Lock 鎖表（V3.5）：等效 Redis K3_Locked 的 DB 原子鎖
 * key = K3_Locked:{strategyId}:{barTimestamp}，TTL 由 expiresAt 控制
 */
export const barLocks = mysqlTable("bar_locks", {
  id: int("id").autoincrement().primaryKey(),
  lockKey: varchar("lockKey", { length: 120 }).notNull().unique(),
  strategyId: int("strategyId").notNull(),
  barTimestamp: bigint("barTimestamp", { mode: "number" }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type BarLock = typeof barLocks.$inferSelect;
export type InsertBarLock = typeof barLocks.$inferInsert;

/**
 * 用戶收藏交易對（第二輪優化）：下拉選單置頂顯示常用交易對
 * 唯一鍵 favKey = `${userId}:${exchange}:${symbol}`，避免重複收藏
 */
export const favoriteSymbols = mysqlTable("favorite_symbols", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  exchange: mysqlEnum("exchange", ["bybit", "okx"]).notNull(),
  symbol: varchar("symbol", { length: 40 }).notNull(),
  favKey: varchar("favKey", { length: 120 }).notNull().unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type FavoriteSymbol = typeof favoriteSymbols.$inferSelect;
export type InsertFavoriteSymbol = typeof favoriteSymbols.$inferInsert;

/**
 * 參數快照表：儲存回測後的最佳參數組合，支援跨策略通用
 * 用戶可在回測報告中一鍵儲存，並在快照庫中管理、套用
 */
export const parameterSnapshots = mysqlTable("parameter_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  /** 策略唯一 key（策略無關：任何策略的快照都存在此表） */
  strategyKey: varchar("strategyKey", { length: 100 }).notNull(),
  strategyName: varchar("strategyName", { length: 200 }),
  snapshotName: varchar("snapshotName", { length: 200 }),
  /** 完整參數配置 JSON */
  config: json("config").notNull(),
  /** 績效指標 JSON：{ totalReturn, winRate, sharpeRatio, profitFactor, maxDrawdown } */
  metrics: json("metrics").notNull(),
  /** 冗餘欄位，方便排序查詢 */
  totalReturn: decimal("totalReturn", { precision: 10, scale: 2 }),
  winRate: decimal("winRate", { precision: 8, scale: 2 }),
  sharpeRatio: decimal("sharpeRatio", { precision: 8, scale: 3 }),
  profitFactor: decimal("profitFactor", { precision: 8, scale: 2 }),
  maxDrawdown: decimal("maxDrawdown", { precision: 8, scale: 2 }),
  isFavorite: boolean("isFavorite").default(false).notNull(),
  /** 回測設定（交易所、交易對、時間框架、日期、資金等） */
  backtestSettings: json("backtestSettings"),
  /** V5.7 環境快照元數據 */
  dataHash: varchar("dataHash", { length: 64 }),
  engineVersion: varchar("engineVersion", { length: 20 }),
  leverage: decimal("leverage", { precision: 8, scale: 2 }),
  commission: decimal("commission", { precision: 8, scale: 6 }),
  slippage: decimal("slippage", { precision: 8, scale: 6 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type ParameterSnapshot = typeof parameterSnapshots.$inferSelect;
export type InsertParameterSnapshot = typeof parameterSnapshots.$inferInsert;

/**
 * 參數掃描任務表：記錄批次回測（Grid Search）的掃描配置與結果
 */
export const scanJobs = mysqlTable("scan_jobs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  /** 掃描任務唯一 ID */
  scanId: varchar("scanId", { length: 100 }),
  strategyKey: varchar("strategyKey", { length: 100 }).notNull(),
  strategyName: varchar("strategyName", { length: 200 }),
  symbol: varchar("symbol", { length: 40 }).notNull(),
  /** 多交易對 JSON 陣列 */
  symbols: json("symbols"),
  timeframe: varchar("timeframe", { length: 10 }).notNull(),
  startTime: bigint("startTime", { mode: "number" }).notNull(),
  endTime: bigint("endTime", { mode: "number" }).notNull(),
  initialCapital: decimal("initialCapital", { precision: 20, scale: 8 }).notNull(),
  /** 基礎參數配置 JSON */
  baseConfig: json("baseConfig").notNull(),
  /** 掃描參數定義 JSON：{ paramName: { values: [...] } } */
  scanParams: json("scanParams").notNull(),
  totalCombinations: int("totalCombinations").default(0).notNull(),
  completedCombinations: int("completedCombinations").default(0).notNull(),
  /** pending / running / completed / failed */
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  /** 掃描結果 JSON（最佳組合、熱力圖數據等） */
  results: json("results"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
});
export type ScanJob = typeof scanJobs.$inferSelect;
export type InsertScanJob = typeof scanJobs.$inferInsert;

/**
 * Heartbeat 輪詢日誌：記錄每次自動交易 Heartbeat 觸發的結果
 * 用於在策略卡片中顯示運行面板
 */
export const heartbeatLogs = mysqlTable("heartbeat_logs", {
  id: int("id").autoincrement().primaryKey(),
  strategyId: int("strategyId").notNull(),
  userId: int("userId").notNull(),
  /** 輪詢結果：hold（無信號）/ signal（生成信號）/ executed（已下單）/ failed（下單失敗）/ error（系統錯誤） */
  result: mysqlEnum("result", ["hold", "signal", "executed", "failed", "error"]).notNull(),
  /** 策略引擎分析結果摘要 */
  detail: text("detail"),
  /** 信號方向（如有） */
  signalAction: varchar("signalAction", { length: 20 }),
  /** 信號價格（如有） */
  signalPrice: decimal("signalPrice", { precision: 20, scale: 8 }),
  /** 執行耗時 ms */
  latencyMs: int("latencyMs"),
  /** 錯誤訊息（如有） */
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type HeartbeatLog = typeof heartbeatLogs.$inferSelect;
export type InsertHeartbeatLog = typeof heartbeatLogs.$inferInsert;

/**
 * 回測任務表：持久化回測任務狀態與結果到主資料庫
 * 支援離開頁面後回來查看、歷史記錄永久保留
 */
export const backtestJobs = mysqlTable("backtest_jobs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  /** 任務唯一 ID（前端用於 polling） */
  jobId: varchar("jobId", { length: 64 }).notNull().unique(),
  /** 策略 key */
  strategyKey: varchar("strategyKey", { length: 100 }).notNull(),
  /** 策略顯示名稱 */
  strategyName: varchar("strategyName", { length: 200 }),
  /** 交易對 */
  symbol: varchar("symbol", { length: 40 }).notNull(),
  /** 時間框架 */
  timeframe: varchar("timeframe", { length: 10 }).notNull(),
  /** 數據來源交易所 */
  exchange: varchar("exchange", { length: 20 }).default("okx").notNull(),
  /** 回測開始日期（ms timestamp） */
  startDate: bigint("startDate", { mode: "number" }).notNull(),
  /** 回測結束日期（ms timestamp） */
  endDate: bigint("endDate", { mode: "number" }).notNull(),
  /** 初始資金 */
  initialCapital: decimal("initialCapital", { precision: 20, scale: 2 }).notNull(),
  /** 每次交易金額 */
  tradeAmount: decimal("tradeAmount", { precision: 20, scale: 2 }),
  /** 完整策略參數 JSON */
  config: json("config").notNull(),
  /** 任務狀態 */
  status: mysqlEnum("status", ["pending", "running", "completed", "failed", "timeout", "cancelled"])
    .default("pending")
    .notNull(),
  /** 進度 0-100 */
  progress: int("progress").default(0).notNull(),
  /** 進度訊息 */
  message: text("message"),
  /** 績效摘要 JSON（完成後填入） */
  metrics: json("metrics"),
  /** 交易明細 JSON（完成後填入，壓縮格式） */
  tradesData: json("tradesData"),
  /** 權益曲線 JSON（完成後填入） */
  equityCurve: json("equityCurve"),
  /** 回測摘要文字 */
  summary: text("summary"),
  /** 錯誤訊息（失敗時填入） */
  error: text("error"),
  /** 任務建立時間 */
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  /** 開始執行時間 */
  startedAt: timestamp("startedAt"),
  /** 完成時間 */
  completedAt: timestamp("completedAt"),
});
export type BacktestJob = typeof backtestJobs.$inferSelect;
export type InsertBacktestJob = typeof backtestJobs.$inferInsert;


/**
 * 掃描狀態表 - 用於 Heartbeat 驅動的分段掃描
 * 保存每一代的種群狀態，使掃描能在實例重啟後繼續
 */
export const scanState = mysqlTable("scan_state", {
  id: int("id").autoincrement().primaryKey(),
  /** 掃描任務唯一 ID */
  scanId: varchar("scanId", { length: 100 }).notNull().unique(),
  userId: int("userId").notNull(),
  /** 當前階段 */
  currentPhase: varchar("currentPhase", { length: 30 }).default("preloading").notNull(),
  /** 當前代數 */
  currentGeneration: int("currentGeneration").default(0).notNull(),
  /** 最大代數 */
  maxGenerations: int("maxGenerations").notNull(),
  /** 序列化的當前種群 Individual[] */
  population: json("population"),
  /** 序列化的所有已評估個體 Individual[] */
  allEvaluated: json("allEvaluated"),
  /** 進化歷史 */
  fitnessHistory: json("fitnessHistory"),
  /** 掃描配置 ScanConfig */
  config: json("config").notNull(),
  /** 參數空間定義 ParameterSpace[] */
  paramSpace: json("paramSpace"),
  /** Walk-Forward 驗證結果 */
  walkForwardResult: json("walkForwardResult"),
  /** Heartbeat 任務 UID（用於完成後清理） */
  heartbeatTaskUid: varchar("heartbeatTaskUid", { length: 128 }),
  /** 掃描模式 */
  scanMode: varchar("scanMode", { length: 20 }).default("deep").notNull(),
  /** 錯誤訊息 */
  error: text("error"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type ScanState = typeof scanState.$inferSelect;
export type InsertScanState = typeof scanState.$inferInsert;
