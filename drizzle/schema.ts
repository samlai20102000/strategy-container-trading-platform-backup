import {
  bigint,
  boolean,
  decimal,
  index,
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
 * 全系統 Maker-First 訂單政策事件（append-only）。
 * 每個 intent 的 submit／partial／cancel／reprice／fallback 都必須留下持久證據。
 */
export const orderPolicyEvents = mysqlTable("order_policy_events", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  /** 同一交易意圖跨 request／重啟的穩定識別；所有 attempt 共用。 */
  policyRunId: varchar("policyRunId", { length: 40 }).notNull(),
  userId: int("userId").notNull(),
  apiKeyId: int("apiKeyId").notNull(),
  strategyId: int("strategyId"),
  signalId: int("signalId"),
  exchange: mysqlEnum("exchange", ["bybit", "okx"]).notNull(),
  eventType: mysqlEnum("eventType", [
    "INTENT_RECEIVED",
    "MAKER_SUBMIT",
    "MAKER_ACCEPTED",
    "MAKER_REJECTED",
    "MAKER_PARTIAL",
    "MAKER_FILLED",
    "MAKER_CANCEL_REQUESTED",
    "MAKER_CANCELLED",
    "MAKER_EXPIRED",
    "EMERGENCY_FALLBACK",
    "EMERGENCY_FILLED",
    "FAILED",
  ]).notNull(),
  executionClass: mysqlEnum("executionClass", ["MAKER_ONLY", "EMERGENCY_EXIT"]).notNull(),
  emergencyReason: mysqlEnum("emergencyReason", ["STOP_LOSS", "DAILY_LOSS_LIMIT", "KILL_SWITCH"]),
  clientOrderId: varchar("clientOrderId", { length: 40 }).notNull(),
  exchangeOrderId: varchar("exchangeOrderId", { length: 128 }),
  symbol: varchar("symbol", { length: 40 }).notNull(),
  side: mysqlEnum("side", ["buy", "sell"]).notNull(),
  reduceOnly: boolean("reduceOnly").default(false).notNull(),
  attempt: int("attempt").default(0).notNull(),
  requestedSize: decimal("requestedSize", { precision: 30, scale: 12 }).notNull(),
  filledSize: decimal("filledSize", { precision: 30, scale: 12 }).default("0").notNull(),
  remainingSize: decimal("remainingSize", { precision: 30, scale: 12 }).notNull(),
  price: decimal("price", { precision: 30, scale: 12 }),
  reasonCode: varchar("reasonCode", { length: 120 }),
  message: text("message"),
  details: json("details"),
  eventAt: bigint("eventAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  ownerTimeIdx: index("order_policy_owner_time_idx").on(table.userId, table.eventAt),
  runTimeIdx: index("order_policy_run_time_idx").on(table.policyRunId, table.eventAt),
  clientOrderIdx: index("order_policy_client_order_idx").on(table.clientOrderId),
  exchangeOrderIdx: index("order_policy_exchange_order_idx").on(table.exchangeOrderId),
}));

export type OrderPolicyEvent = typeof orderPolicyEvents.$inferSelect;
export type InsertOrderPolicyEvent = typeof orderPolicyEvents.$inferInsert;

/**
 * Maker-First recovery Heartbeat 的資料庫真相來源。
 *
 * 路由除平台 cron 身分外，還必須以 body.task_uid 命中 enabled row 才可執行；
 * task_uid 不寫入程式碼或 query string，且可在不重新部署的情況下撤銷。
 */
export const orderPolicyRecoverySchedules = mysqlTable("order_policy_recovery_schedules", {
  id: int("id").autoincrement().primaryKey(),
  taskUid: varchar("taskUid", { length: 128 }).notNull().unique(),
  enabled: boolean("enabled").default(true).notNull(),
  lastRunAt: timestamp("lastRunAt"),
  lastResult: mysqlEnum("lastResult", ["SUCCESS", "PARTIAL", "FAILED"]),
  lastSummary: json("lastSummary"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type OrderPolicyRecoverySchedule = typeof orderPolicyRecoverySchedules.$inferSelect;
export type InsertOrderPolicyRecoverySchedule = typeof orderPolicyRecoverySchedules.$inferInsert;

/**
 * 每使用者全域 Maker-First 政策設定。
 *
 * 只有 TTL、maker 次數與既有三種緊急 taker 條件可以調整；一般路徑永遠
 * maker-only、緊急單永遠 reduce-only 等不可放寬的不變量不存入設定。
 */
export const orderPolicySettings = mysqlTable("order_policy_settings", {
  userId: int("userId").primaryKey(),
  standardTtlMs: int("standardTtlMs").default(30_000).notNull(),
  standardMaxAttempts: int("standardMaxAttempts").default(3).notNull(),
  emergencyTtlMs: int("emergencyTtlMs").default(2_000).notNull(),
  emergencyMakerAttempts: int("emergencyMakerAttempts").default(2).notNull(),
  allowStopLossTaker: boolean("allowStopLossTaker").default(true).notNull(),
  allowDailyLossTaker: boolean("allowDailyLossTaker").default(true).notNull(),
  allowKillSwitchTaker: boolean("allowKillSwitchTaker").default(true).notNull(),
  revision: int("revision").default(0).notNull(),
  updatedByUserId: int("updatedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type OrderPolicySetting = typeof orderPolicySettings.$inferSelect;
export type InsertOrderPolicySetting = typeof orderPolicySettings.$inferInsert;

/** Maker-First 設定變更歷史；只新增、不更新、不刪除。 */
export const orderPolicySettingEvents = mysqlTable("order_policy_setting_events", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  revision: int("revision").notNull(),
  eventType: mysqlEnum("eventType", ["CREATED", "UPDATED", "RESET"]).notNull(),
  previousConfig: json("previousConfig"),
  nextConfig: json("nextConfig").notNull(),
  reason: varchar("reason", { length: 500 }),
  eventAt: bigint("eventAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  ownerTimeIdx: index("order_policy_setting_owner_time_idx").on(table.userId, table.eventAt),
}));

export type OrderPolicySettingEvent = typeof orderPolicySettingEvents.$inferSelect;
export type InsertOrderPolicySettingEvent = typeof orderPolicySettingEvents.$inferInsert;

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
  /** 三模式部署識別；舊資料回填後不可變，新建部署由伺服器生成。 */
  deploymentKey: varchar("deploymentKey", { length: 128 }).unique(),
  /** 每個策略部署獨立選擇運行模式。 */
  executionMode: mysqlEnum("executionMode", [
    "SINGLE_EXCLUSIVE",
    "MULTI_POSITION",
    "HEDGE_GUARDED",
  ])
    .default("SINGLE_EXCLUSIVE")
    .notNull(),
  /** 完整 discriminated mode policy；模式切換只能在 flat/drained Gate 完成。 */
  executionPolicy: json("executionPolicy"),
  executionPolicyVersion: varchar("executionPolicyVersion", { length: 40 })
    .default("execution-policy-v1")
    .notNull(),
  /** 版本化策略能力快照，部署後不因 definition 熱更新而靜默改義。 */
  capabilitySnapshot: json("capabilitySnapshot"),
  strategyVersion: int("strategyVersion").default(1).notNull(),
  /** LEGACY 兼容既有 enabled；所有新部署必須明確寫入 DISABLED。 */
  activationState: mysqlEnum("activationState", [
    "LEGACY",
    "DRAFT",
    "DISABLED",
    "PREFLIGHT_FAILED",
    "READY_DISABLED",
    "ARMED",
    "ACTIVE",
    "PAUSED",
    "DRAINING",
    "BLOCKED",
    "ARCHIVED",
  ])
    .default("LEGACY")
    .notNull(),
  /** 每次配置、policy 或 lifecycle mutation 都必須以 optimistic lock 遞增。 */
  deploymentRevision: int("deploymentRevision").default(1).notNull(),
  /** 最近一次 deterministic deployment preflight 狀態。 */
  preflightStatus: mysqlEnum("preflightStatus", ["NOT_RUN", "PASSED", "FAILED", "STALE"])
    .default("NOT_RUN")
    .notNull(),
  /** 完整 preflight Gate、blocker 與 capability evidence。 */
  preflightReport: json("preflightReport"),
  /** 綁定 deployment revision、policy、artifact、account 與 capability evidence 的 hash。 */
  preflightHash: varchar("preflightHash", { length: 64 }),
  preflightCheckedAt: timestamp("preflightCheckedAt"),
  lifecycleReasonCode: varchar("lifecycleReasonCode", { length: 80 }),
  lifecycleReason: text("lifecycleReason"),
  modeActivatedAt: timestamp("modeActivatedAt"),
  archivedAt: timestamp("archivedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Strategy = typeof strategies.$inferSelect;
export type InsertStrategy = typeof strategies.$inferInsert;

/**
 * Deployment lifecycle 與模式切換的持久化 journal。
 * transitionKey 提供 mutation retry 冪等性；revision 欄位提供 optimistic lock 稽核。
 */
export const modeTransitions = mysqlTable(
  "mode_transitions",
  {
    id: int("id").autoincrement().primaryKey(),
    transitionKey: varchar("transitionKey", { length: 128 }).notNull().unique(),
    deploymentId: int("deploymentId").notNull(),
    userId: int("userId").notNull(),
    fromState: varchar("fromState", { length: 32 }).notNull(),
    toState: varchar("toState", { length: 32 }).notNull(),
    fromMode: varchar("fromMode", { length: 32 }).notNull(),
    toMode: varchar("toMode", { length: 32 }).notNull(),
    fromPolicyHash: varchar("fromPolicyHash", { length: 64 }),
    toPolicyHash: varchar("toPolicyHash", { length: 64 }),
    expectedRevision: int("expectedRevision").notNull(),
    resultingRevision: int("resultingRevision"),
    status: mysqlEnum("status", ["PENDING", "APPLIED", "BLOCKED", "FAILED", "CANCELLED"])
      .default("PENDING")
      .notNull(),
    reasonCode: varchar("reasonCode", { length: 80 }).notNull(),
    reason: text("reason").notNull(),
    blockerCodes: json("blockerCodes"),
    preflightReport: json("preflightReport"),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("mode_transitions_deployment_created_idx").on(table.deploymentId, table.createdAt),
    index("mode_transitions_user_status_idx").on(table.userId, table.status),
  ],
);

export type ModeTransition = typeof modeTransitions.$inferSelect;
export type InsertModeTransition = typeof modeTransitions.$inferInsert;

/**
 * Webhook 訊號日誌：記錄每筆 TradingView 訊號的原始內容、解析結果、下單狀態與交易所回應
 */
export const signals = mysqlTable(
  "signals",
  {
    id: int("id").autoincrement().primaryKey(),
    strategyId: int("strategyId"),
    userId: int("userId"),
    /** 全系統唯一執行識別；新交易由共用記錄服務生成，支援冪等重試 */
    executionId: varchar("executionId", { length: 128 }).unique(),
    /** 同一開倉至全部退出的交易循環；部分平倉共用同一 cycleId */
    cycleId: varchar("cycleId", { length: 128 }),
    deploymentKey: varchar("deploymentKey", { length: 128 }),
    decisionId: varchar("decisionId", { length: 128 }),
    intentId: varchar("intentId", { length: 128 }),
    legId: varchar("legId", { length: 128 }),
    executionMode: mysqlEnum("executionMode", [
      "SINGLE_EXCLUSIVE",
      "MULTI_POSITION",
      "HEDGE_GUARDED",
    ]),
    reasonCode: varchar("reasonCode", { length: 80 }),
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
  },
  table => [
    index("signals_strategy_created_idx").on(table.strategyId, table.createdAt),
    index("signals_order_idx").on(table.orderId),
    index("signals_cycle_idx").on(table.cycleId),
  ]
);

export type Signal = typeof signals.$inferSelect;
export type InsertSignal = typeof signals.$inferInsert;

/**
 * 交易執行記錄（用於績效統計）
 */
export const trades = mysqlTable(
  "trades",
  {
    id: int("id").autoincrement().primaryKey(),
    strategyId: int("strategyId").notNull(),
    userId: int("userId").notNull(),
    signalId: int("signalId"),
    /** 與 signal.executionId 一致；新成交必填且全表唯一 */
    executionId: varchar("executionId", { length: 128 }).unique(),
    /** 部分平倉與最終平倉共用同一交易循環 */
    cycleId: varchar("cycleId", { length: 128 }),
    deploymentKey: varchar("deploymentKey", { length: 128 }),
    decisionId: varchar("decisionId", { length: 128 }),
    intentId: varchar("intentId", { length: 128 }),
    legId: varchar("legId", { length: 128 }),
    legRole: mysqlEnum("legRole", ["PRIMARY", "INDEPENDENT", "HEDGE"]),
    positionSide: mysqlEnum("positionSide", ["LONG", "SHORT"]),
    executionMode: mysqlEnum("executionMode", [
      "SINGLE_EXCLUSIVE",
      "MULTI_POSITION",
      "HEDGE_GUARDED",
    ]),
    exchange: mysqlEnum("exchange", ["bybit", "okx"]).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    side: mysqlEnum("side", ["buy", "sell"]).notNull(),
    orderType: mysqlEnum("orderType", ["market", "limit"]).notNull(),
    orderId: varchar("orderId", { length: 100 }),
    /** 交易所成交 ID；與 orderId 分開保存，便於一單多成交與對帳 */
    exchangeTradeId: varchar("exchangeTradeId", { length: 128 }),
    /** 下單時要求數量／價格；size／price 保留為最終採用成交真值 */
    requestedSize: decimal("requestedSize", { precision: 20, scale: 8 }),
    requestedPrice: decimal("requestedPrice", { precision: 20, scale: 8 }),
    size: decimal("size", { precision: 20, scale: 8 }).notNull(),
    price: decimal("price", { precision: 20, scale: 8 }),
    /** 價格真值來源：交易所實際成交／下單請求回退／歷史未知 */
    priceSource: mysqlEnum("priceSource", ["exchange_fill", "order_request", "legacy_unknown"])
      .default("legacy_unknown")
      .notNull(),
    /** 數量真值來源：交易所實際成交／下單請求回退／歷史未知 */
    sizeSource: mysqlEnum("sizeSource", ["exchange_fill", "order_request", "legacy_unknown"])
      .default("legacy_unknown")
      .notNull(),
    /** 是否為平倉單 */
    reduceOnly: boolean("reduceOnly").default(false).notNull(),
    /** 已實現毛利、費用、資金費與淨利；realizedPnl 一律代表最終淨利 */
    grossPnl: decimal("grossPnl", { precision: 20, scale: 8 }),
    fee: decimal("fee", { precision: 20, scale: 8 }),
    fundingFee: decimal("fundingFee", { precision: 20, scale: 8 }),
    realizedPnl: decimal("realizedPnl", { precision: 20, scale: 8 }),
    /** 舊資料庫已使用的淨利欄位；新寫入與 realizedPnl 同步，讀取時作相容後備 */
    netRealizedPnl: decimal("netRealizedPnl", { precision: 20, scale: 8 }),
    realizedPnlPct: decimal("realizedPnlPct", { precision: 12, scale: 6 }),
    pnlCurrency: varchar("pnlCurrency", { length: 16 }),
    /** PnL 真值來源與可稽核品質；禁止以自然語言訊息反推金額 */
    pnlSource: mysqlEnum("pnlSource", [
      "exchange",
      "local_estimate",
      "legacy",
      "unavailable",
      "exchange_settlement",
      "fill_calculation",
      "position_snapshot",
      "legacy_time_match",
      "legacy_existing",
      "unknown",
    ]).default("unknown").notNull(),
    dataQuality: mysqlEnum("dataQuality", [
      "exchange_confirmed",
      "calculated",
      "pending_reconciliation",
      "legacy_time_matched",
      "legacy_unresolved",
      "not_applicable",
    ]).default("legacy_unresolved").notNull(),
    reconciliationStatus: mysqlEnum("reconciliationStatus", [
      "not_required",
      "pending",
      "confirmed",
      "failed",
      "unresolved",
    ]).default("not_required").notNull(),
    reconciliationAttempts: int("reconciliationAttempts").default(0).notNull(),
    lastReconciledAt: timestamp("lastReconciledAt"),
    reconciliationError: text("reconciliationError"),
    filledAt: timestamp("filledAt"),
    status: mysqlEnum("status", ["submitted", "filled", "failed", "cancelled"])
      .default("submitted")
      .notNull(),
    /** 觸發來源：webhook / risk_stop_loss / risk_take_profit / risk_daily_loss / manual */
    triggerSource: varchar("triggerSource", { length: 30 })
      .default("webhook")
      .notNull(),
    /** 交易當下的策略顯示名稱與穩定 key 快照，避免策略改名／刪除後報告失真 */
    strategyName: varchar("strategyName", { length: 100 }),
    strategyKey: varchar("strategyKey", { length: 100 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("trades_signal_idx").on(table.signalId),
    index("trades_order_idx").on(table.orderId),
    index("trades_strategy_created_idx").on(table.strategyId, table.createdAt),
    index("trades_cycle_idx").on(table.cycleId),
    index("trades_reconciliation_idx").on(table.reconciliationStatus, table.createdAt),
  ]
);

export type Trade = typeof trades.$inferSelect;
export type InsertTrade = typeof trades.$inferInsert;

/**
 * 馬丁持倉循環主檔。
 *
 * 只為明確宣告 martingale capability 且具有效配置的策略建立；非馬丁策略不得寫入。
 * cycleId 與 trades.cycleId 共用，讓逐層明細可回溯到不可變成交真相。
 */
export const positionCycles = mysqlTable(
  "position_cycles",
  {
    id: int("id").autoincrement().primaryKey(),
    cycleId: varchar("cycleId", { length: 128 }).notNull().unique(),
    deploymentKey: varchar("deploymentKey", { length: 128 }),
    executionMode: mysqlEnum("executionMode", [
      "SINGLE_EXCLUSIVE",
      "MULTI_POSITION",
      "HEDGE_GUARDED",
    ])
      .default("SINGLE_EXCLUSIVE")
      .notNull(),
    executionPolicyVersion: varchar("executionPolicyVersion", { length: 40 })
      .default("execution-policy-v1")
      .notNull(),
    executionPolicySnapshot: json("executionPolicySnapshot"),
    contractVersion: varchar("contractVersion", { length: 32 })
      .default("martin-layers-v1")
      .notNull(),
    userId: int("userId").notNull(),
    strategyId: int("strategyId").notNull(),
    apiKeyId: int("apiKeyId").notNull(),
    exchange: mysqlEnum("exchange", ["bybit", "okx"]).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    side: mysqlEnum("side", ["long", "short"]).notNull(),
    status: mysqlEnum("status", ["open", "closed", "reconciliation_required"])
      .default("open")
      .notNull(),
    dataQuality: mysqlEnum("dataQuality", [
      "live_exact",
      "legacy_reconstructed",
      "reconciliation_required",
    ])
      .default("live_exact")
      .notNull(),
    openedAt: timestamp("openedAt").notNull(),
    closedAt: timestamp("closedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("position_cycles_strategy_status_idx").on(table.strategyId, table.status),
    index("position_cycles_owner_status_idx").on(table.userId, table.status),
    index("position_cycles_account_position_idx").on(
      table.apiKeyId,
      table.symbol,
      table.side,
      table.status,
    ),
  ],
);

export type PositionCycle = typeof positionCycles.$inferSelect;
export type InsertPositionCycle = typeof positionCycles.$inferInsert;

/**
 * 馬丁逐層開倉成交事件（append-only）。
 *
 * 每筆 executionId 最多一列；一個循環內 layerIndex 由 1 開始。部分成交先在 trades
 * 聚合為交易所確認數量／均價，再以單一事件寫入，避免 UI 把委託量冒充成交量。
 */
export const positionLayerEvents = mysqlTable(
  "position_layer_events",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    strategyId: int("strategyId").notNull(),
    apiKeyId: int("apiKeyId").notNull(),
    cycleId: varchar("cycleId", { length: 128 }).notNull(),
    legId: varchar("legId", { length: 128 }),
    layerIndex: int("layerIndex").notNull(),
    executionId: varchar("executionId", { length: 128 }).notNull().unique(),
    layerIntentId: varchar("layerIntentId", { length: 128 }).notNull(),
    orderId: varchar("orderId", { length: 100 }),
    exchangeTradeId: varchar("exchangeTradeId", { length: 128 }),
    side: mysqlEnum("side", ["buy", "sell"]).notNull(),
    quantity: decimal("quantity", { precision: 20, scale: 8 }).notNull(),
    entryPrice: decimal("entryPrice", { precision: 20, scale: 8 }).notNull(),
    fee: decimal("fee", { precision: 20, scale: 8 }),
    source: mysqlEnum("source", [
      "live_execution",
      "legacy_reconstructed",
      "reconciliation_adjustment",
    ])
      .default("live_execution")
      .notNull(),
    dataQuality: mysqlEnum("dataQuality", [
      "live_exact",
      "legacy_reconstructed",
      "reconciliation_required",
    ])
      .default("live_exact")
      .notNull(),
    filledAt: timestamp("filledAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("position_layer_cycle_layer_idx").on(table.cycleId, table.layerIndex),
    index("position_layer_strategy_cycle_idx").on(table.strategyId, table.cycleId),
    index("position_layer_order_idx").on(table.orderId),
  ],
);

export type PositionLayerEvent = typeof positionLayerEvents.$inferSelect;
export type InsertPositionLayerEvent = typeof positionLayerEvents.$inferInsert;

/**
 * 平倉成交對各馬丁層的 FIFO 分配事件（append-only）。
 * allocationKey = closeExecutionId + layerEventId，令重試可安全去重。
 */
export const positionLayerCloseAllocations = mysqlTable(
  "position_layer_close_allocations",
  {
    id: int("id").autoincrement().primaryKey(),
    allocationKey: varchar("allocationKey", { length: 180 }).notNull().unique(),
    userId: int("userId").notNull(),
    strategyId: int("strategyId").notNull(),
    cycleId: varchar("cycleId", { length: 128 }).notNull(),
    legId: varchar("legId", { length: 128 }),
    layerEventId: int("layerEventId").notNull(),
    layerIndex: int("layerIndex").notNull(),
    closeExecutionId: varchar("closeExecutionId", { length: 128 }).notNull(),
    allocatedQuantity: decimal("allocatedQuantity", { precision: 20, scale: 8 }).notNull(),
    closePrice: decimal("closePrice", { precision: 20, scale: 8 }),
    grossPnl: decimal("grossPnl", { precision: 20, scale: 8 }),
    feeShare: decimal("feeShare", { precision: 20, scale: 8 }),
    realizedPnl: decimal("realizedPnl", { precision: 20, scale: 8 }),
    allocationPolicy: mysqlEnum("allocationPolicy", ["fifo"]).default("fifo").notNull(),
    dataQuality: mysqlEnum("dataQuality", [
      "live_exact",
      "legacy_reconstructed",
      "reconciliation_required",
    ])
      .default("live_exact")
      .notNull(),
    allocatedAt: timestamp("allocatedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("position_layer_close_cycle_idx").on(table.cycleId, table.layerIndex),
    index("position_layer_close_execution_idx").on(table.closeExecutionId),
    index("position_layer_close_event_idx").on(table.layerEventId),
  ],
);

export type PositionLayerCloseAllocation = typeof positionLayerCloseAllocations.$inferSelect;
export type InsertPositionLayerCloseAllocation = typeof positionLayerCloseAllocations.$inferInsert;

/** 三模式 position leg 真相；同一 cycle 可有 LONG／SHORT 兩腿。 */
export const positionLegs = mysqlTable(
  "position_legs",
  {
    id: int("id").autoincrement().primaryKey(),
    legId: varchar("legId", { length: 128 }).notNull().unique(),
    userId: int("userId").notNull(),
    strategyId: int("strategyId").notNull(),
    deploymentKey: varchar("deploymentKey", { length: 128 }),
    apiKeyId: int("apiKeyId").notNull(),
    cycleId: varchar("cycleId", { length: 128 }).notNull(),
    exchange: mysqlEnum("exchange", ["bybit", "okx"]).notNull(),
    symbol: varchar("symbol", { length: 40 }).notNull(),
    executionMode: mysqlEnum("executionMode", [
      "SINGLE_EXCLUSIVE",
      "MULTI_POSITION",
      "HEDGE_GUARDED",
    ]).notNull(),
    side: mysqlEnum("side", ["LONG", "SHORT"]).notNull(),
    role: mysqlEnum("role", ["PRIMARY", "INDEPENDENT", "HEDGE"]).notNull(),
    status: mysqlEnum("status", [
      "PENDING",
      "OPEN",
      "REDUCING",
      "CLOSED",
      "RECONCILIATION_REQUIRED",
      "BLOCKED",
    ])
      .default("PENDING")
      .notNull(),
    quantity: decimal("quantity", { precision: 20, scale: 8 }).default("0").notNull(),
    avgEntryPrice: decimal("avgEntryPrice", { precision: 20, scale: 8 }),
    realizedPnl: decimal("realizedPnl", { precision: 20, scale: 8 }).default("0").notNull(),
    unrealizedPnl: decimal("unrealizedPnl", { precision: 20, scale: 8 }),
    martinState: json("martinState"),
    riskState: json("riskState"),
    openedAt: timestamp("openedAt"),
    closedAt: timestamp("closedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("position_legs_strategy_status_idx").on(table.strategyId, table.status),
    index("position_legs_cycle_idx").on(table.cycleId),
    index("position_legs_account_symbol_side_idx").on(
      table.apiKeyId,
      table.symbol,
      table.side,
      table.status,
    ),
  ],
);
export type PositionLeg = typeof positionLegs.$inferSelect;
export type InsertPositionLeg = typeof positionLegs.$inferInsert;

/** H3 PRIMARY／HEDGE 關係狀態機。 */
export const hedgeRelationships = mysqlTable(
  "hedge_relationships",
  {
    id: int("id").autoincrement().primaryKey(),
    relationshipId: varchar("relationshipId", { length: 128 }).notNull().unique(),
    userId: int("userId").notNull(),
    strategyId: int("strategyId").notNull(),
    cycleId: varchar("cycleId", { length: 128 }).notNull(),
    primaryLegId: varchar("primaryLegId", { length: 128 }).notNull(),
    hedgeLegId: varchar("hedgeLegId", { length: 128 }).notNull(),
    status: mysqlEnum("status", ["ARMING", "ACTIVE", "UNWINDING", "CLOSED", "BLOCKED"])
      .default("ARMING")
      .notNull(),
    targetRatio: decimal("targetRatio", { precision: 10, scale: 6 }).notNull(),
    triggerSnapshot: json("triggerSnapshot").notNull(),
    unwindSnapshot: json("unwindSnapshot"),
    openedAt: timestamp("openedAt"),
    closedAt: timestamp("closedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("hedge_relationship_strategy_status_idx").on(table.strategyId, table.status),
    index("hedge_relationship_cycle_idx").on(table.cycleId),
  ],
);
export type HedgeRelationship = typeof hedgeRelationships.$inferSelect;
export type InsertHedgeRelationship = typeof hedgeRelationships.$inferInsert;

/** 每次候選信號經模式與風控判定後的不可變決策事件。 */
export const executionDecisions = mysqlTable(
  "execution_decisions",
  {
    id: int("id").autoincrement().primaryKey(),
    decisionId: varchar("decisionId", { length: 128 }).notNull().unique(),
    candidateId: varchar("candidateId", { length: 128 }).notNull(),
    userId: int("userId").notNull(),
    strategyId: int("strategyId").notNull(),
    deploymentKey: varchar("deploymentKey", { length: 128 }),
    cycleId: varchar("cycleId", { length: 128 }),
    legId: varchar("legId", { length: 128 }),
    executionMode: mysqlEnum("executionMode", [
      "SINGLE_EXCLUSIVE",
      "MULTI_POSITION",
      "HEDGE_GUARDED",
    ]).notNull(),
    source: mysqlEnum("source", ["WEBHOOK", "AUTO", "MANUAL", "RISK", "RECONCILIATION"])
      .notNull(),
    outcome: mysqlEnum("outcome", [
      "APPROVED",
      "HOLD",
      "REJECTED",
      "CLOSE_ONLY",
      "RECONCILIATION_REQUIRED",
    ]).notNull(),
    reasonCode: varchar("reasonCode", { length: 80 }).notNull(),
    candidateIntent: json("candidateIntent").notNull(),
    contextSnapshot: json("contextSnapshot").notNull(),
    decision: json("decision").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("execution_decision_strategy_created_idx").on(table.strategyId, table.createdAt),
    index("execution_decision_cycle_idx").on(table.cycleId),
  ],
);
export type ExecutionDecisionRow = typeof executionDecisions.$inferSelect;
export type InsertExecutionDecisionRow = typeof executionDecisions.$inferInsert;

/** 經核准後的 leg-scoped order intent；idempotencyKey 禁止重複送單。 */
export const executionOrderIntents = mysqlTable(
  "execution_order_intents",
  {
    id: int("id").autoincrement().primaryKey(),
    intentId: varchar("intentId", { length: 128 }).notNull().unique(),
    idempotencyKey: varchar("idempotencyKey", { length: 180 }).notNull().unique(),
    decisionId: varchar("decisionId", { length: 128 }).notNull(),
    userId: int("userId").notNull(),
    strategyId: int("strategyId").notNull(),
    cycleId: varchar("cycleId", { length: 128 }),
    legId: varchar("legId", { length: 128 }),
    action: mysqlEnum("action", ["OPEN", "ADD", "REDUCE", "CLOSE"]).notNull(),
    side: mysqlEnum("side", ["BUY", "SELL"]).notNull(),
    positionSide: mysqlEnum("positionSide", ["LONG", "SHORT"]).notNull(),
    reduceOnly: boolean("reduceOnly").default(false).notNull(),
    requestedQuantity: decimal("requestedQuantity", { precision: 20, scale: 8 }).notNull(),
    requestedPrice: decimal("requestedPrice", { precision: 20, scale: 8 }),
    status: mysqlEnum("status", [
      "CREATED",
      "SUBMITTING",
      "SUBMITTED",
      "PARTIALLY_FILLED",
      "FILLED",
      "FAILED",
      "CANCELLED",
      "RECONCILIATION_REQUIRED",
    ])
      .default("CREATED")
      .notNull(),
    exchangeOrderId: varchar("exchangeOrderId", { length: 128 }),
    reasonCode: varchar("reasonCode", { length: 80 }).notNull(),
    error: text("error"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("execution_intent_strategy_created_idx").on(table.strategyId, table.createdAt),
    index("execution_intent_leg_idx").on(table.legId),
    index("execution_intent_exchange_order_idx").on(table.exchangeOrderId),
  ],
);
export type ExecutionOrderIntent = typeof executionOrderIntents.$inferSelect;
export type InsertExecutionOrderIntent = typeof executionOrderIntents.$inferInsert;

/** 交易所成交 append-only 真相，一單可有多筆 fills。 */
export const executionFills = mysqlTable(
  "execution_fills",
  {
    id: int("id").autoincrement().primaryKey(),
    fillKey: varchar("fillKey", { length: 180 }).notNull().unique(),
    intentId: varchar("intentId", { length: 128 }).notNull(),
    userId: int("userId").notNull(),
    strategyId: int("strategyId").notNull(),
    cycleId: varchar("cycleId", { length: 128 }),
    legId: varchar("legId", { length: 128 }),
    exchangeOrderId: varchar("exchangeOrderId", { length: 128 }),
    exchangeTradeId: varchar("exchangeTradeId", { length: 128 }),
    quantity: decimal("quantity", { precision: 20, scale: 8 }).notNull(),
    price: decimal("price", { precision: 20, scale: 8 }).notNull(),
    fee: decimal("fee", { precision: 20, scale: 8 }),
    feeCurrency: varchar("feeCurrency", { length: 16 }),
    filledAt: timestamp("filledAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("execution_fill_intent_idx").on(table.intentId),
    index("execution_fill_leg_idx").on(table.legId),
    index("execution_fill_order_idx").on(table.exchangeOrderId),
  ],
);
export type ExecutionFill = typeof executionFills.$inferSelect;
export type InsertExecutionFill = typeof executionFills.$inferInsert;

/** 決策到送單前的帳戶級 gross／margin 預留，支援跨 instance 原子風控。 */
export const executionRiskReservations = mysqlTable(
  "execution_risk_reservations",
  {
    id: int("id").autoincrement().primaryKey(),
    reservationId: varchar("reservationId", { length: 128 }).notNull().unique(),
    decisionId: varchar("decisionId", { length: 128 }).notNull(),
    userId: int("userId").notNull(),
    strategyId: int("strategyId").notNull(),
    apiKeyId: int("apiKeyId").notNull(),
    symbol: varchar("symbol", { length: 40 }).notNull(),
    grossNotional: decimal("grossNotional", { precision: 20, scale: 8 }).notNull(),
    estimatedMargin: decimal("estimatedMargin", { precision: 20, scale: 8 }).notNull(),
    status: mysqlEnum("status", ["RESERVED", "COMMITTED", "RELEASED", "EXPIRED"])
      .default("RESERVED")
      .notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("execution_reservation_account_status_idx").on(table.apiKeyId, table.status),
    index("execution_reservation_expiry_idx").on(table.expiresAt),
  ],
);
export type ExecutionRiskReservation = typeof executionRiskReservations.$inferSelect;
export type InsertExecutionRiskReservation = typeof executionRiskReservations.$inferInsert;

/** 本地 ledger 與交易所真相不一致時的 fail-closed case。 */
export const executionReconciliationCases = mysqlTable(
  "execution_reconciliation_cases",
  {
    id: int("id").autoincrement().primaryKey(),
    caseId: varchar("caseId", { length: 128 }).notNull().unique(),
    userId: int("userId").notNull(),
    strategyId: int("strategyId").notNull(),
    apiKeyId: int("apiKeyId").notNull(),
    cycleId: varchar("cycleId", { length: 128 }),
    legId: varchar("legId", { length: 128 }),
    caseType: varchar("caseType", { length: 80 }).notNull(),
    severity: mysqlEnum("severity", ["INFO", "WARNING", "CRITICAL"]).notNull(),
    status: mysqlEnum("status", ["OPEN", "ACKNOWLEDGED", "RESOLVED", "IGNORED"])
      .default("OPEN")
      .notNull(),
    localSnapshot: json("localSnapshot").notNull(),
    exchangeSnapshot: json("exchangeSnapshot").notNull(),
    resolution: json("resolution"),
    detectedAt: timestamp("detectedAt").notNull(),
    resolvedAt: timestamp("resolvedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("execution_reconciliation_account_status_idx").on(table.apiKeyId, table.status),
    index("execution_reconciliation_strategy_status_idx").on(table.strategyId, table.status),
  ],
);
export type ExecutionReconciliationCase = typeof executionReconciliationCases.$inferSelect;
export type InsertExecutionReconciliationCase = typeof executionReconciliationCases.$inferInsert;

/**
 * 帳戶級持倉共享快照。
 *
 * 只儲存交易所回傳的持倉欄位與已清洗錯誤，不儲存 API key／secret。跨 instance 先讀此表，
 * 到期後再由單一租約持有者刷新，避免每張策略卡或每層各自呼叫交易所。
 */
export const accountPositionSnapshots = mysqlTable(
  "account_position_snapshots",
  {
    id: int("id").autoincrement().primaryKey(),
    snapshotKey: varchar("snapshotKey", { length: 96 }).notNull().unique(),
    contractVersion: varchar("contractVersion", { length: 40 })
      .default("exchange-position-v3")
      .notNull(),
    userId: int("userId").notNull(),
    apiKeyId: int("apiKeyId").notNull(),
    exchange: mysqlEnum("exchange", ["bybit", "okx"]).notNull(),
    status: mysqlEnum("status", ["available", "error"]).notNull(),
    positions: json("positions").notNull(),
    executionCapabilities: json("executionCapabilities"),
    accountPositionMode: varchar("accountPositionMode", { length: 24 }),
    sanitizedError: text("sanitizedError"),
    capturedAt: timestamp("capturedAt").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("account_position_snapshot_owner_idx").on(table.userId, table.apiKeyId),
    index("account_position_snapshot_expiry_idx").on(table.expiresAt),
  ],
);

export type AccountPositionSnapshotRow = typeof accountPositionSnapshots.$inferSelect;
export type InsertAccountPositionSnapshotRow = typeof accountPositionSnapshots.$inferInsert;

/**
 * 風險事件記錄：風險觸發自動平倉與停用策略的審計軌跡
 */
export const riskEvents = mysqlTable("risk_events", {
  id: int("id").autoincrement().primaryKey(),
  strategyId: int("strategyId").notNull(),
  userId: int("userId").notNull(),
  cycleId: varchar("cycleId", { length: 128 }),
  legId: varchar("legId", { length: 128 }),
  executionMode: mysqlEnum("executionMode", [
    "SINGLE_EXCLUSIVE",
    "MULTI_POSITION",
    "HEDGE_GUARDED",
  ]),
  reasonCode: varchar("reasonCode", { length: 80 }),
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
  /** 策略版本支援的模式、獨立腿狀態、精確關腿及馬丁能力。 */
  capabilityManifest: json("capabilityManifest"),
  modeContractVersion: varchar("modeContractVersion", { length: 40 })
    .default("strategy-mode-capabilities-v1")
    .notNull(),
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
  executionMode: mysqlEnum("executionMode", [
    "SINGLE_EXCLUSIVE",
    "MULTI_POSITION",
    "HEDGE_GUARDED",
  ])
    .default("SINGLE_EXCLUSIVE")
    .notNull(),
  executionPolicy: json("executionPolicy"),
  executionPolicyVersion: varchar("executionPolicyVersion", { length: 40 })
    .default("execution-policy-v1")
    .notNull(),
  artifactScope: mysqlEnum("artifactScope", ["PARAMETERS_ONLY", "EXECUTION_PROFILE"])
    .default("PARAMETERS_ONLY")
    .notNull(),
  strategyVersion: int("strategyVersion").default(1).notNull(),
  artifactContractVersion: varchar("artifactContractVersion", { length: 64 }),
  artifactHash: varchar("artifactHash", { length: 64 }),
  strategyLogicHash: varchar("strategyLogicHash", { length: 64 }),
  executionPolicyHash: varchar("executionPolicyHash", { length: 64 }),
  capabilityManifest: json("capabilityManifest").$type<Record<string, unknown>>(),
  artifactSource: json("artifactSource").$type<Record<string, unknown>>(),
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
}, table => [
  index("idx_ps_artifact_hash").on(table.artifactHash),
]);
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
  /** 一次掃描可比較一至三種模式；各模式使用自己的 policy。 */
  executionModes: json("executionModes"),
  executionPolicies: json("executionPolicies"),
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
  cycleId: varchar("cycleId", { length: 128 }),
  legId: varchar("legId", { length: 128 }),
  executionMode: mysqlEnum("executionMode", [
    "SINGLE_EXCLUSIVE",
    "MULTI_POSITION",
    "HEDGE_GUARDED",
  ]),
  reasonCode: varchar("reasonCode", { length: 80 }),
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
  executionMode: mysqlEnum("executionMode", [
    "SINGLE_EXCLUSIVE",
    "MULTI_POSITION",
    "HEDGE_GUARDED",
  ])
    .default("SINGLE_EXCLUSIVE")
    .notNull(),
  executionPolicy: json("executionPolicy"),
  executionPolicyVersion: varchar("executionPolicyVersion", { length: 40 })
    .default("execution-policy-v1")
    .notNull(),
  /** Finalize Gate 產生的完整版本化回測執行身份與公平比較 hash。 */
  executionContext: json("executionContext"),
  /** 三模式公平比較時保存各 mode 的績效、腿與曝險歸因。 */
  modeResults: json("modeResults"),
  legAccounting: json("legAccounting"),
  /** V2.5 全域終點持倉政策 */
  endPositionPolicy: varchar("endPositionPolicy", { length: 20 })
    .default("mark_to_market")
    .notNull(),
  /** 任務狀態 */
  status: mysqlEnum("status", ["pending", "running", "completed", "failed", "timeout", "cancelled"])
    .default("pending")
    .notNull(),
  /** Durable worker 細階段；UI 與 watchdog 不再僅依百分比猜測狀態。 */
  phase: mysqlEnum("phase", [
    "QUEUED",
    "PREPARING",
    "RUNNING",
    "FINALIZING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ]).default("QUEUED").notNull(),
  /** 進度 0-100 */
  progress: int("progress").default(0).notNull(),
  /** 已完成／總 K 棒數；皆為單調、可診斷進度。 */
  processedBars: int("processedBars").default(0).notNull(),
  totalBars: int("totalBars").default(0).notNull(),
  /** 進度訊息 */
  message: text("message"),
  /** 完整且不可變的 BacktestRequest，供任何容器接管後重建執行。 */
  requestSnapshot: json("requestSnapshot"),
  /** runner／策略邏輯身份 hash，供重試與稽核。 */
  logicHash: varchar("logicHash", { length: 128 }),
  /** 使用者設定的工作上限（秒）；0 代表平台預設。 */
  timeoutSeconds: int("timeoutSeconds").default(0).notNull(),
  /** DB lease 與 worker 心跳；所有更新皆須比對 leaseToken。 */
  heartbeatAt: timestamp("heartbeatAt"),
  leaseToken: varchar("leaseToken", { length: 64 }),
  leaseExpiresAt: timestamp("leaseExpiresAt"),
  /** 跨容器持久化取消意圖，一旦為 true 不得重設。 */
  cancelRequested: boolean("cancelRequested").default(false).notNull(),
  /** stale 接管次數；超過上限明確失敗，禁止永久 running。 */
  attemptCount: int("attemptCount").default(0).notNull(),
  errorCode: varchar("errorCode", { length: 100 }),
  /** 績效摘要 JSON（完成後填入） */
  metrics: json("metrics"),
  /** 交易明細 JSON（完成後填入，壓縮格式） */
  tradesData: json("tradesData"),
  /** 權益曲線 JSON（完成後填入） */
  equityCurve: json("equityCurve"),
  /** 回測摘要文字 */
  summary: text("summary"),
  /** V2.5 規範化後的有效 K 棒數 */
  candleCount: int("candleCount"),
  /** V2.5 單一權益帳本與未平倉估值 */
  accounting: json("accounting"),
  /** V2.5 半開區間、排序、去重與未收盤過濾統計 */
  dataQuality: json("dataQuality"),
  /** V2.5 連續 Session 與全域終點語義 */
  engineSemantics: json("engineSemantics"),
  /** 可重現性環境快照 */
  environment: json("environment"),
  /** 錯誤訊息（失敗時填入） */
  error: text("error"),
  /** 任務建立時間 */
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  /** 開始執行時間 */
  startedAt: timestamp("startedAt"),
  /** 完成時間 */
  completedAt: timestamp("completedAt"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  statusLeaseIdx: index("backtest_jobs_status_lease_idx").on(table.status, table.leaseExpiresAt),
  cancellationIdx: index("backtest_jobs_cancel_idx").on(table.cancelRequested, table.status),
  heartbeatIdx: index("backtest_jobs_heartbeat_idx").on(table.heartbeatAt),
}));
export type BacktestJob = typeof backtestJobs.$inferSelect;
export type InsertBacktestJob = typeof backtestJobs.$inferInsert;

/**
 * Project-level durable 回測 worker 的唯一 Heartbeat 身份。
 * Callback 只依 authenticateRequest 產生的 taskUid 查此表，不信任 request body。
 */
export const backtestWorkerRegistry = mysqlTable("backtest_worker_registry", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 80 }).notNull().unique(),
  scheduleCronTaskUid: varchar("schedule_cron_task_uid", { length: 65 }).notNull().unique(),
  enabled: boolean("enabled").default(true).notNull(),
  lastHeartbeatAt: timestamp("lastHeartbeatAt"),
  lastResult: varchar("lastResult", { length: 40 }),
  lastSummary: json("lastSummary"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  taskUidIdx: index("backtest_worker_task_uid_idx").on(table.scheduleCronTaskUid),
}));
export type BacktestWorkerRegistry = typeof backtestWorkerRegistry.$inferSelect;
export type InsertBacktestWorkerRegistry = typeof backtestWorkerRegistry.$inferInsert;


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
