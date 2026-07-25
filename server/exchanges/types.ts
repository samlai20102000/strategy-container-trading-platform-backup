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
}

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

  /** 撤單 */
  cancelOrder(symbol: string, orderId: string): Promise<OrderResult>;

  /** 市價平倉指定交易對的所有持倉 */
  closePosition(symbol: string, posSide?: "long" | "short" | "net"): Promise<OrderResult>;

  /**
   * 智能平倉：先限價掛單（享受 maker 費率），超時未成交則取消改市價兜底
   * @param symbol 交易對
   * @param posSide 持倉方向
   * @param timeoutMs 限價單等待超時（毫秒），預設 3000ms
   * @param priceOffsetPct 限價偏移百分比（相對 markPrice），預設 0.02%（確保快速成交）
   */
  closePositionSmart(symbol: string, posSide?: "long" | "short" | "net", timeoutMs?: number, priceOffsetPct?: number): Promise<OrderResult>;

  /** 查詢已實現盈虧記錄（用於統計） */
  getClosedPnl(symbol?: string, startTime?: number): Promise<{ symbol: string; pnl: number; time: number }[]>;
}
