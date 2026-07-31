/**
 * 統一交易所轉接器介面
 * BybitAdapter 與 OKXAdapter 均實作此介面，可依策略設定無縫切換
 */

export interface OrderParams {
  symbol: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  /** 數量（基礎幣） */
  size: number;
  /** 限價單價格 */
  price?: number;
  /** 是否僅平倉 */
  reduceOnly?: boolean;
  /** 槓桿倍數（開倉前設定） */
  leverage?: number;
  /** 持倉方向（OKX 雙向持倉模式必填） */
  posSide?: "long" | "short" | "net";
  /** 僅允許 maker 成交；交易所若判定會立即成交，必須拒單而非轉 taker。 */
  postOnly?: boolean;
  /** 由中央執行層建立的冪等客戶端訂單識別碼。 */
  clientOrderId?: string;
  /** 方案 B 執行分類；未指定時中央執行層一律視為 MAKER_ONLY。 */
  executionClass?: "MAKER_ONLY" | "EMERGENCY_EXIT";
  /** 只有三種已批准理由可授權 emergency taker。 */
  emergencyReason?: "STOP_LOSS" | "DAILY_LOSS_LIMIT" | "KILL_SWITCH";
  /** 只用於稽核，不由交易所解讀。 */
  policyContext?: {
    strategyId?: number;
    signalId?: number;
    source?: string;
    reasonCode?: string;
  };
}

export interface BestBidAsk {
  symbol: string;
  bid: number;
  ask: number;
  observedAt: number;
  source: string;
}

export interface CloseExecutionOptions {
  executionClass?: "MAKER_ONLY" | "EMERGENCY_EXIT";
  emergencyReason?: "STOP_LOSS" | "DAILY_LOSS_LIMIT" | "KILL_SWITCH";
  policyContext?: OrderParams["policyContext"];
}

export type ExchangeTruthSource =
  | "exchange_order"
  | "exchange_closed_pnl"
  | "calculated"
  | "unavailable";

export type SettlementStatus = "final" | "pending" | "not_applicable";
export type FillQuality = "exact" | "partial" | "requested" | "unknown";

export interface OrderResult {
  success: boolean;
  orderId?: string;
  /** 交易所原始回應（JSON 字串），用於日誌 */
  rawResponse: string;
  errorMessage?: string;
  /** 實際成交均價（市價單成交後查詢獲得） */
  filledPrice?: number;
  /** 實際成交數量（base 幣種單位，如 BTC） */
  filledSize?: number;
  /** 交易所成交／交易識別碼（如可取得） */
  tradeId?: string;
  /** 交易所成交時間（Unix 毫秒） */
  filledAt?: number;
  /** 未扣交易費前的已實現盈虧（USDT） */
  grossRealizedPnl?: number;
  /** 相容欄位：已實現盈虧（USDT） */
  realizedPnl?: number;
  /** 扣除交易費與資金費後的淨已實現盈虧（USDT） */
  netRealizedPnl?: number;
  /** 交易費，統一為正數成本（USDT） */
  fee?: number;
  /** 資金費，正數代表成本、負數代表收入（USDT） */
  fundingFee?: number;
  /** PnL 與費用的權威來源 */
  pnlSource?: ExchangeTruthSource;
  feeSource?: ExchangeTruthSource;
  /** 平倉 PnL 是否已完成交易所結算 */
  settlementStatus?: SettlementStatus;
  /** 成交價量完整性 */
  fillQuality?: FillQuality;
  /** 只讀成交稽核欄位；用於驗證歷史記錄，不參與下單決策。 */
  executedSide?: "buy" | "sell";
  executedReduceOnly?: boolean;
  executionStatus?: "filled" | "partially_filled" | "cancelled" | "unknown";
  /** 多方向／多持倉平倉時的逐筆權威結果 */
  childResults?: OrderResult[];
  /** 中央 maker-first 執行層的結構化稽核摘要。 */
  policyAudit?: {
    policyVersion: "GLOBAL_MAKER_FIRST_B_V1";
    executionClass: "MAKER_ONLY" | "EMERGENCY_EXIT";
    emergencyReason?: "STOP_LOSS" | "DAILY_LOSS_LIMIT" | "KILL_SWITCH";
    attempts: number;
    fallbackUsed: boolean;
    requestedSize: number;
    filledSize: number;
    remainingSize: number;
    finalOrderType: "post_only" | "market" | "none";
    clientOrderIds: string[];
  };
}

export interface Balance {
  asset: string;
  /** 可用餘額 */
  free: number;
  /** 總權益 */
  total: number;
  /** 未實現盈虧 */
  unrealizedPnl: number;
  /** 已用保證金（初始保證金佔用） */
  usedMargin?: number;
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  /** 該持倉使用的保證金，與 unrealizedPnl 來自同一交易所快照 */
  positionMargin?: number;
  /** 交易所原生未實現盈虧率，統一為百分比數值（例如 -0.26 表示 -0.26%） */
  unrealizedPnlRatioPct?: number;
  /** 交易所持倉資料更新時間（Unix 毫秒） */
  updatedAt?: number;
  /** 預估強平價 */
  liquidationPrice?: number;
  /** 保證金率 (%) */
  marginRatio?: number;
}

export type AccountPositionMode = "ONE_WAY" | "HEDGE" | "UNKNOWN";

/**
 * 僅由交易所只讀 API 建立的能力快照。不得用送測試單或修改帳戶設定來推測能力。
 */
export interface ExchangeCapabilitySnapshot {
  exchange: "bybit" | "okx";
  symbol: string;
  positionMode: AccountPositionMode;
  preciseLegClose: boolean;
  observedAt: number;
  source: string;
  details?: Record<string, unknown>;
}

/**
 * 由交易所公開／只讀 API 建立的商品規格證據。數量統一為策略與 placeOrder 使用的 base 幣單位。
 */
export interface ExchangeInstrumentSnapshot {
  exchange: "bybit" | "okx";
  symbol: string;
  exists: boolean;
  active: boolean;
  minOrderSize: number;
  quantityStep: number;
  contractValue?: number;
  priceStep?: number;
  observedAt: number;
  source: string;
  details?: Record<string, unknown>;
}

export interface ExchangeAdapter {
  readonly exchange: "bybit" | "okx";

  /** 測試 API 金鑰有效性（serverIp 用於錯誤訊息中提示白名單設定） */
  testConnection(serverIp?: string): Promise<{ success: boolean; message: string; balance?: number }>;

  /** 設定槓桿倍數 */
  setLeverage(symbol: string, leverage: number): Promise<void>;

  /** 下單（市價/限價） */
  placeOrder(params: OrderParams): Promise<OrderResult>;

  /** 查詢 USDT 帳戶餘額 */
  getBalance(): Promise<Balance>;

  /** 查詢當前所有持倉 */
  getPositions(symbol?: string): Promise<Position[]>;

  /** 只讀探測帳戶持倉模式與指定腿精確平倉能力；不得改變帳戶或送單。 */
  probeCapabilities(symbol: string): Promise<ExchangeCapabilitySnapshot>;

  /** 只讀探測商品是否可交易及下單規格；不得建立、修改或取消訂單。 */
  probeInstrument(symbol: string): Promise<ExchangeInstrumentSnapshot>;

  /** 只讀取得最佳買／賣價，供中央 post-only 價格決策。 */
  getBestBidAsk(symbol: string): Promise<BestBidAsk>;

  /** 撤單 */
  cancelOrder(symbol: string, orderId: string): Promise<OrderResult>;

  /** 市價平倉指定交易對的所有持倉 */
  closePosition(symbol: string, posSide?: "long" | "short" | "net", options?: CloseExecutionOptions): Promise<OrderResult>;

  /**
   * 智能平倉：先限價掛單（享受 maker 費率），超時未成交則取消改市價兜底
   * @param symbol 交易對
   * @param posSide 持倉方向
   * @param timeoutMs 限價單等待超時（毫秒），預設 3000ms
   * @param priceOffsetPct 限價偏移百分比（相對 markPrice），預設 0.02%（確保快速成交）
   */
  closePositionSmart(symbol: string, posSide?: "long" | "short" | "net", timeoutMs?: number, priceOffsetPct?: number, options?: CloseExecutionOptions): Promise<OrderResult>;

  /** 查詢已實現盈虧記錄（用於統計） */
  getClosedPnl(symbol?: string, startTime?: number): Promise<{ symbol: string; pnl: number; time: number }[]>;

  /**
   * 只讀查詢指定訂單的成交與結算真相。
   * 不會下單、撤單或改變持倉，供延遲盈虧對帳使用。
   */
  getOrderExecutionTruth(
    symbol: string,
    orderId: string | undefined,
    expectPnl?: boolean,
    clientOrderId?: string,
  ): Promise<Partial<OrderResult>>;
}
