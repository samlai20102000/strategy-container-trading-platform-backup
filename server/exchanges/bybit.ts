import crypto from "crypto";
import type {
  Balance,
  BestBidAsk,
  Candle,
  ExchangeCapabilitySnapshot,
  ExchangeAdapter,
  ExchangeInstrumentSnapshot,
  OrderParams,
  OrderResult,
  Position,
} from "./types";

/**
 * Bybit V5 REST API 轉接器
 * 文件：https://bybit-exchange.github.io/docs/v5/intro
 * 簽名方式：HMAC-SHA256(timestamp + apiKey + recvWindow + queryString/body)
 */
/** 任務 1.1：全域 API 請求逾時（10 秒） */
const REQUEST_TIMEOUT_MS = 10000;

/** placeOrder 專用：暫時性錯誤的最大重試次數 */
const PLACE_ORDER_MAX_RETRIES = 3;
/** Bybit 可重試的錯誤碼（暫時性服務不可用） */
const RETRYABLE_RET_CODES = new Set([10000, 10001, 10002, 10006, 10016, 10018]);

/** 指數退避延遲計算（含隨機 jitter） */
function computeBackoff(attempt: number): number {
  const baseMs = 1000;
  const maxMs = 8000;
  const cap = Math.min(baseMs * 2 ** attempt, maxMs);
  return cap / 2 + Math.random() * (cap / 2);
}

export class BybitAdapter implements ExchangeAdapter {
  readonly exchange = "bybit" as const;
  private baseUrl: string;
  private recvWindow = "5000";

  constructor(
    private apiKey: string,
    private apiSecret: string,
    isTestnet = false,
  ) {
    this.baseUrl = isTestnet
      ? "https://api-testnet.bybit.com"
      : "https://api.bybit.com";
  }

  private sign(payload: string, timestamp: string): string {
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(timestamp + this.apiKey + this.recvWindow + payload)
      .digest("hex");
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<any> {
    const timestamp = Date.now().toString();
    let url = `${this.baseUrl}${path}`;
    let body: string | undefined;
    let payload: string;

    if (method === "GET") {
      const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");
      payload = qs;
      if (qs) url += `?${qs}`;
    } else {
      body = JSON.stringify(params);
      payload = body;
    }

    const signature = this.sign(payload, timestamp);
    const res = await fetch(url, {
      method,
      headers: {
        "X-BAPI-API-KEY": this.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-SIGN": signature,
        "X-BAPI-RECV-WINDOW": this.recvWindow,
        "Content-Type": "application/json",
      },
      body,
      // 任務 1.1：強制 5 秒逾時，逾時主動拋出 Timeout Error
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((e: any) => {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new Error(`連線逾時（${REQUEST_TIMEOUT_MS / 1000} 秒），請檢查網路或防火牆設定`);
      }
      throw new Error(`無法連線至 Bybit 伺服器：${e?.message || "未知錯誤"}`);
    });
    try {
      const text = await res.text();
      console.log(`[BybitAdapter] HTTP ${res.status} - Content-Length: ${text.length}`);
      if (text.length < 500) {
        console.log(`[BybitAdapter] 回應內容: ${text}`);
      } else {
        console.log(`[BybitAdapter] 回應內容（前 500 字）: ${text.substring(0, 500)}`);
      }
      try {
        return JSON.parse(text);
      } catch (parseErr: any) {
        console.error(`[BybitAdapter] JSON 解析失敗: ${parseErr.message}`);
        if (res.status === 403) {
          throw new Error(`Bybit 拒絕存取（403 Forbidden）：伺服器 IP 可能被 Bybit WAF/Cloudflare 攔截。請確認：1) 伺服器 IP 已加入 Bybit API 白名單；2) 您的地區未被 Bybit 限制；3) API Key 未過期`);
        }
        throw new Error(`Bybit 回應格式異常（${res.status}）：伺服器回傳非 JSON 內容，可能是網路問題或 IP 被封鎖`);
      }
    } catch (e: any) {
      throw e;
    }
  }

  /** 任務 1.3：Bybit 錯誤碼解析，回傳具體原因與解決方法 */
  static parseErrorCode(retCode: number, retMsg: string, serverIp?: string): string {
    switch (retCode) {
      case 10002:
        return `IP 不在白名單內，請將伺服器 IP${serverIp ? ` ${serverIp}` : ""} 加入 Bybit API 白名單`;
      case 10003:
        return "API 金鑰無效或權限不足，請確認金鑰正確且已勾選「讀取」與「合約交易」權限（注意：測試網與主網金鑰不互通）";
      case 10004:
        return "簽名驗證失敗，請檢查 API Secret 是否正確";
      case 10005:
        return "API 權限不足，請確認金鑰權限設定";
      case 10006:
        return "請求過於頻繁，請稍後再試";
      case 33004:
        return "API 金鑰已過期，請至 Bybit 重新產生";
      default:
        return `Bybit 錯誤 ${retCode}: ${retMsg}`;
    }
  }

  /** Bybit 使用線性合約符號，如 BTCUSDT */
  async getServerTime(): Promise<number> {
    const data = await this.request("GET", "/v5/market/time");
    if (data.retCode === 0) {
      return parseInt(String(data.result.timeNano / 1000000), 10); // 轉換為毫秒
    }
    throw new Error(`Bybit 獲取伺服器時間失敗: ${data.retMsg}`);
  }

  normalizeSymbol(symbol: string): string {
    return symbol.replace(/[-/]/g, "").toUpperCase().replace(".P", "");
  }

  async testConnection(serverIp?: string): Promise<{ success: boolean; message: string; balance?: number }> {
    try {
      const data = await this.request("GET", "/v5/account/wallet-balance", {
        accountType: "UNIFIED",
      });
      if (data.retCode === 0) {
        const account = data.result?.list?.[0];
        const usdt = account?.coin?.find((c: any) => c.coin === "USDT");
        const balance = parseFloat(
          usdt?.walletBalance || account?.totalEquity || "0",
        );
        return {
          success: true,
          message: `連線成功，餘額：${balance.toFixed(2)} USDT`,
          balance,
        };
      }
      return {
        success: false,
        message: BybitAdapter.parseErrorCode(data.retCode, data.retMsg, serverIp),
      };
    } catch (e: any) {
      return { success: false, message: `連線失敗：${e.message}` };
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await this.request("POST", "/v5/position/set-leverage", {
        category: "linear",
        symbol: this.normalizeSymbol(symbol),
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      });
    } catch {
      // 槓桿未變更時 Bybit 回傳錯誤碼 110043，可安全忽略
    }
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const TAG = `[Bybit][placeOrder]`;
    try {
      const symbol = this.normalizeSymbol(params.symbol);
      if (params.postOnly && (params.orderType !== "limit" || !params.price || params.price <= 0)) {
        return {
          success: false,
          rawResponse: JSON.stringify({ policy: "GLOBAL_MAKER_FIRST_B_V1", rejected: "POST_ONLY_REQUIRES_LIMIT_PRICE" }),
          errorMessage: "post-only 訂單必須提供有效限價，已 fail-closed 拒絕",
        };
      }
      if (params.leverage && !params.reduceOnly) {
        await this.setLeverage(symbol, params.leverage);
      }
      const body: Record<string, unknown> = {
        category: "linear",
        symbol,
        side: params.side === "buy" ? "Buy" : "Sell",
        orderType: params.orderType === "market" ? "Market" : "Limit",
        qty: String(params.size),
      };
      if (params.orderType === "limit" && params.price) {
        body.price = String(params.price);
      }
      if (params.postOnly) {
        body.timeInForce = "PostOnly";
      }
      if (params.clientOrderId) {
        body.orderLinkId = params.clientOrderId.slice(0, 36);
      }
      if (params.reduceOnly) {
        body.reduceOnly = true;
      }
      if (params.posSide === "long") {
        body.positionIdx = 1;
      } else if (params.posSide === "short") {
        body.positionIdx = 2;
      } else if (params.posSide === "net") {
        body.positionIdx = 0;
      }

      // ★ 加入指數退避重試，對暫時性錯誤自動重試
      let lastRetCode = 0;
      let lastRetMsg = "";
      let lastRawResponse = "{}";

      for (let attempt = 0; attempt <= PLACE_ORDER_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const backoffMs = computeBackoff(attempt - 1);
          console.log(`${TAG} 重試 #${attempt}/${PLACE_ORDER_MAX_RETRIES}，等待 ${Math.round(backoffMs)}ms...`);
          await new Promise(r => setTimeout(r, backoffMs));
        }

        let data: any;
        try {
          data = await this.request("POST", "/v5/order/create", body);
        } catch (e: any) {
          console.warn(`${TAG} 網路異常 (attempt ${attempt}): ${e.message}`);
          lastRetMsg = e.message;
          lastRawResponse = "{}";
          if (attempt < PLACE_ORDER_MAX_RETRIES) continue;
          return { success: false, rawResponse: "{}", errorMessage: `網路錯誤（已重試 ${PLACE_ORDER_MAX_RETRIES} 次）：${e.message}` };
        }

        if (data.retCode === 0) {
          if (attempt > 0) {
            console.log(`${TAG} ✅ 重試第 ${attempt} 次成功！orderId=${data.result?.orderId}`);
          }
          const fillTruth = data.result?.orderId
            ? await this.queryOrderFillDetails(symbol, String(data.result.orderId), Boolean(params.reduceOnly))
            : {};
          return {
            success: true,
            orderId: data.result?.orderId,
            rawResponse: JSON.stringify(data),
            ...fillTruth,
          };
        }

        lastRetCode = data.retCode;
        lastRetMsg = data.retMsg;
        lastRawResponse = JSON.stringify(data);
        console.warn(`${TAG} 下單失敗 (attempt ${attempt}): retCode=${data.retCode} retMsg=${data.retMsg}`);

        // 僅對暫時性錯誤重試
        if (RETRYABLE_RET_CODES.has(data.retCode) && attempt < PLACE_ORDER_MAX_RETRIES) {
          continue;
        }

        // 不可重試的錯誤，立即返回
        return {
          success: false,
          rawResponse: lastRawResponse,
          errorMessage: `Bybit ${data.retCode}: ${data.retMsg}`,
        };
      }

      // 所有重試用完
      return {
        success: false,
        rawResponse: lastRawResponse,
        errorMessage: `Bybit 下單失敗（已重試 ${PLACE_ORDER_MAX_RETRIES} 次）：${lastRetCode}: ${lastRetMsg}`,
      };
    } catch (e: any) {
      return { success: false, rawResponse: "{}", errorMessage: e.message };
    }
  }

  async getOrderExecutionTruth(
    symbol: string,
    orderId: string | undefined,
    expectPnl = true,
    clientOrderId?: string,
  ): Promise<Partial<OrderResult>> {
    return this.queryOrderFillDetails(this.normalizeSymbol(symbol), orderId, expectPnl, clientOrderId);
  }

  private async queryOrderFillDetails(
    symbol: string,
    orderId: string | undefined,
    expectPnl: boolean,
    clientOrderId?: string,
  ): Promise<Partial<OrderResult>> {
    const finite = (value: unknown): number | undefined => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    try {
      if (!orderId && !clientOrderId) return {};
      await new Promise(resolve => setTimeout(resolve, 300));
      const orderData = await this.request("GET", "/v5/order/realtime", {
        category: "linear",
        symbol,
        ...(orderId ? { orderId } : { orderLinkId: clientOrderId }),
      });
      const detail = orderData.result?.list?.[0];
      const avgPrice = finite(detail?.avgPrice);
      const filledSize = finite(detail?.cumExecQty);
      const orderFee = finite(detail?.cumExecFee);
      const filledAt = finite(detail?.updatedTime ?? detail?.createdTime);

      let closed: any;
      if (expectPnl && orderId) {
        const closedData = await this.request("GET", "/v5/position/closed-pnl", {
          category: "linear",
          symbol,
          limit: 50,
        });
        closed = closedData.result?.list?.find(
          (row: any) => String(row.orderId ?? row.closedPnlId ?? "") === orderId,
        );
      }

      const closedNet = finite(closed?.closedPnl);
      const openFee = finite(closed?.openFee);
      const closeFee = finite(closed?.closeFee);
      const fee = openFee !== undefined || closeFee !== undefined
        ? Math.abs(openFee ?? 0) + Math.abs(closeFee ?? 0)
        : orderFee !== undefined ? Math.abs(orderFee) : undefined;
      const gross = closedNet !== undefined ? closedNet + (fee ?? 0) : undefined;
      const hasExactFill = avgPrice !== undefined && avgPrice > 0 && filledSize !== undefined && filledSize > 0;
      const orderStatus = String(detail?.orderStatus ?? "").toLowerCase();

      return {
        orderId: detail?.orderId ? String(detail.orderId) : orderId,
        filledPrice: avgPrice !== undefined && avgPrice > 0 ? avgPrice : undefined,
        filledSize: filledSize !== undefined && filledSize > 0 ? filledSize : undefined,
        filledAt,
        tradeId: detail?.orderLinkId || undefined,
        grossRealizedPnl: gross,
        realizedPnl: gross,
        netRealizedPnl: closedNet,
        fee,
        pnlSource: closedNet !== undefined ? "exchange_closed_pnl" : "unavailable",
        feeSource: fee !== undefined ? (closed ? "exchange_closed_pnl" : "exchange_order") : "unavailable",
        settlementStatus: expectPnl ? (closedNet !== undefined ? "final" : "pending") : "not_applicable",
        fillQuality: hasExactFill ? "exact" : avgPrice !== undefined || filledSize !== undefined ? "partial" : "unknown",
        executedSide: detail?.side === "Buy" ? "buy" : detail?.side === "Sell" ? "sell" : undefined,
        executedReduceOnly: typeof detail?.reduceOnly === "boolean" ? detail.reduceOnly : undefined,
        executionStatus: orderStatus === "filled"
          ? "filled"
          : orderStatus === "partiallyfilled" || orderStatus === "partially_filled"
            ? "partially_filled"
            : orderStatus === "cancelled" || orderStatus === "canceled"
              ? "cancelled"
              : "unknown",
      };
    } catch (error) {
      console.warn(`[Bybit][queryOrderFillDetails] orderId=${orderId ?? "-"} clientOrderId=${clientOrderId ?? "-"} 查詢失敗:`, (error as Error).message);
      return {
        settlementStatus: expectPnl ? "pending" : "not_applicable",
        pnlSource: "unavailable",
        feeSource: "unavailable",
        fillQuality: "unknown",
      };
    }
  }

  async getCandles(symbol: string, interval: number, limit: number): Promise<Candle[]> {
    const instId = this.normalizeSymbol(symbol);
    const intervalMap: Record<number, string> = {
      1: "1",
      3: "3",
      5: "5",
      15: "15",
      30: "30",
      60: "60",
      120: "120",
      240: "240",
      360: "360",
      720: "720",
      1440: "D",
      10080: "W",
      43200: "M",
    };
    const intervalStr = intervalMap[interval];
    if (!intervalStr) {
      throw new Error(`不支持的 K 線時間間隔: ${interval} 分鐘`);
    }

    const data = await this.request("GET", "/v5/market/kline", {
      category: "linear",
      symbol: instId,
      interval: intervalStr,
      limit: String(limit),
    });

    if (data.retCode === 0 && data.result?.list) {
      return data.result.list.map((c: string[]) => ({
        timestamp: parseInt(c[0], 10),
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
        currencyVolume: parseFloat(c[6]),
      }));
    }
    return [];
  }

  async getOrderDetail(symbol: string, orderId?: string, clientOrderId?: string): Promise<OrderResult> {
    try {
      if (!orderId && !clientOrderId) {
        return { success: false, errorMessage: "必須提供 orderId 或 clientOrderId", rawResponse: "{}" };
      }
      const data = await this.request("GET", "/v5/order/realtime", {
        category: "linear",
        symbol: this.normalizeSymbol(symbol),
        ...(orderId ? { orderId } : { orderLinkId: clientOrderId }),
      });
      const detail = data.result?.list?.[0];
      if (!detail) {
        return { success: false, errorMessage: "訂單未找到", rawResponse: JSON.stringify(data) };
      }
      const fillTruth = await this.queryOrderFillDetails(symbol, detail.orderId, true, detail.orderLinkId);
      return {
        success: true,
        orderId: detail.orderId,
        clientOrderId: detail.orderLinkId,
        rawResponse: JSON.stringify(data),
        state: detail.orderStatus === "Filled" ? "filled" : detail.orderStatus === "New" ? "live" : detail.orderStatus === "PartiallyFilled" ? "partial_filled" : detail.orderStatus === "Canceled" ? "canceled" : "unknown",
        postOnly: detail.timeInForce === "PostOnly",
        ...fillTruth,
      };
    } catch (e: any) {
      return { success: false, errorMessage: e.message, rawResponse: "{}" };
    }
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    try {
      const data = await this.request("GET", "/v5/order/realtime", {
        category: "linear",
        symbol: symbol ? this.normalizeSymbol(symbol) : undefined,
        openOnly: 0, // 0: all, 1: open
      });
      if (data.retCode === 0 && data.result?.list) {
        return data.result.list
          .filter((order: any) => order.orderStatus === "New" || order.orderStatus === "PartiallyFilled")
          .map((order: any) => ({
            success: true,
            orderId: order.orderId,
            clientOrderId: order.orderLinkId,
            rawResponse: JSON.stringify(order),
            state: order.orderStatus === "New" ? "live" : order.orderStatus === "PartiallyFilled" ? "partial_filled" : "unknown",
            postOnly: order.timeInForce === "PostOnly",
          }));
      }
      return [];
    } catch (e: any) {
      console.error(`[Bybit] 獲取掛單失敗: ${e.message}`);
      return [];
    }
  }

  async getBalance(): Promise<Balance> {
    const data = await this.request("GET", "/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin: "USDT",
    });
    if (data.retCode !== 0) {
      throw new Error(`Bybit ${data.retCode}: ${data.retMsg}`);
    }
    const account = data.result?.list?.[0];
    const coin = account?.coin?.find((c: any) => c.coin === "USDT");
    return {
      asset: "USDT",
      free: parseFloat(coin?.availableToWithdraw || coin?.walletBalance || "0"),
      total: parseFloat(account?.totalEquity || "0"),
      unrealizedPnl: parseFloat(account?.totalPerpUPL || "0"),
      usedMargin: parseFloat(account?.totalInitialMargin || "0"),
    };
  }

  async getBestBidAsk(symbol: string): Promise<BestBidAsk> {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const data = await this.request("GET", "/v5/market/tickers", {
      category: "linear",
      symbol: normalizedSymbol,
    });
    const row = data.result?.list?.[0];
    const bid = Number(row?.bid1Price);
    const ask = Number(row?.ask1Price);
    if (data.retCode !== 0 || !Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= bid) {
      throw new Error(`Bybit 無有效最佳買賣價：${data.retCode ?? "UNKNOWN"} ${data.retMsg ?? ""}`.trim());
    }
    return {
      symbol: normalizedSymbol,
      bid,
      ask,
      observedAt: Number(row?.time ?? data.time) || Date.now(),
      source: "bybit:/v5/market/tickers.bid1Price/ask1Price",
    };
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const params: Record<string, unknown> = {
      category: "linear",
      settleCoin: "USDT",
    };
    if (symbol) {
      params.symbol = this.normalizeSymbol(symbol);
      delete params.settleCoin;
    }
    const data = await this.request("GET", "/v5/position/list", params);
    if (data.retCode !== 0) {
      throw new Error(`Bybit ${data.retCode}: ${data.retMsg}`);
    }
    return (data.result?.list || [])
      .filter((p: any) => parseFloat(p.size) > 0)
      .map((p: any) => ({
        symbol: p.symbol,
        side: p.side === "Buy" ? ("long" as const) : ("short" as const),
        size: parseFloat(p.size),
        entryPrice: parseFloat(p.avgPrice),
        markPrice: parseFloat(p.markPrice),
        unrealizedPnl: parseFloat(p.unrealisedPnl),
        leverage: parseFloat(p.leverage),
        positionMargin: parseFloat(p.positionIM || p.positionBalance || "0") || undefined,
        unrealizedPnlRatioPct:
          parseFloat(p.positionIM || p.positionBalance || "0") > 0
            ? (parseFloat(p.unrealisedPnl || "0") / parseFloat(p.positionIM || p.positionBalance)) * 100
            : undefined,
        updatedAt: parseInt(p.updatedTime || p.updatedAt || "0", 10) || undefined,
      }));
  }

  async probeCapabilities(symbol: string): Promise<ExchangeCapabilitySnapshot> {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const data = await this.request("GET", "/v5/position/list", {
      category: "linear",
      symbol: normalizedSymbol,
    });
    if (data.retCode !== 0) {
      throw new Error(`Bybit ${data.retCode}: ${data.retMsg}`);
    }
    const rows = Array.isArray(data.result?.list) ? data.result.list : [];
    const indexes = rows
      .map((row: any) => Number(row.positionIdx))
      .filter((value: number) => Number.isInteger(value));
    const positionMode = indexes.some((value: number) => value === 1 || value === 2)
      ? "HEDGE"
      : indexes.some((value: number) => value === 0)
        ? "ONE_WAY"
        : "UNKNOWN";
    return {
      exchange: this.exchange,
      symbol: normalizedSymbol,
      positionMode,
      preciseLegClose: positionMode !== "UNKNOWN",
      observedAt: Date.now(),
      source: "bybit:/v5/position/list.positionIdx",
      details: { observedPositionIndexes: indexes },
    };
  }

  async probeInstrument(symbol: string): Promise<ExchangeInstrumentSnapshot> {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const data = await this.request("GET", "/v5/market/instruments-info", {
      category: "linear",
      symbol: normalizedSymbol,
    });
    if (data.retCode !== 0) {
      throw new Error(`Bybit ${data.retCode}: ${data.retMsg}`);
    }
    const row = Array.isArray(data.result?.list) ? data.result.list[0] : undefined;
    const minOrderSize = Number(row?.lotSizeFilter?.minOrderQty ?? 0);
    const quantityStep = Number(row?.lotSizeFilter?.qtyStep ?? 0);
    const priceStep = Number(row?.priceFilter?.tickSize ?? 0);
    return {
      exchange: this.exchange,
      symbol: normalizedSymbol,
      exists: Boolean(row),
      active: row?.status === "Trading",
      minOrderSize: Number.isFinite(minOrderSize) && minOrderSize > 0 ? minOrderSize : 0,
      quantityStep: Number.isFinite(quantityStep) && quantityStep > 0 ? quantityStep : 0,
      contractValue: 1,
      ...(Number.isFinite(priceStep) && priceStep > 0 ? { priceStep } : {}),
      observedAt: Date.now(),
      source: "bybit:/v5/market/instruments-info",
      details: {
        status: row?.status ?? "missing",
        baseCoin: row?.baseCoin,
        quoteCoin: row?.quoteCoin,
      },
    };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<OrderResult> {
    try {
      const data = await this.request("POST", "/v5/order/cancel", {
        category: "linear",
        symbol: this.normalizeSymbol(symbol),
        orderId,
      });
      return {
        success: data.retCode === 0,
        orderId,
        rawResponse: JSON.stringify(data),
        errorMessage: data.retCode !== 0 ? data.retMsg : undefined,
      };
    } catch (e: any) {
      return { success: false, rawResponse: "{}", errorMessage: e.message };
    }
  }

  async closePosition(symbol: string, posSide?: "long" | "short" | "net"): Promise<OrderResult> {
    try {
      const positions = (await this.getPositions(symbol)).filter(position =>
        !posSide || posSide === "net" || position.side === posSide
      );
      if (positions.length === 0) {
        return {
          success: true,
          rawResponse: JSON.stringify({ info: "無持倉可平" }),
        };
      }
      let lastResult: OrderResult = { success: true, rawResponse: "{}" };
      const childResults: OrderResult[] = [];
      for (const pos of positions) {
        lastResult = await this.placeOrder({
          symbol,
          side: pos.side === "long" ? "sell" : "buy",
          orderType: "market",
          size: pos.size,
          reduceOnly: true,
          posSide: pos.side,
          clientOrderId: `clOrdId_BYBIT_CLOSE_${symbol}_${pos.side}_${Date.now()}`,
        });
        childResults.push(lastResult);
      }
      const successful = childResults.filter(result => result.success);
      return {
        ...lastResult,
        success: successful.length === childResults.length,
        childResults,
        grossRealizedPnl: successful.some(result => result.grossRealizedPnl !== undefined)
          ? successful.reduce((sum, result) => sum + (result.grossRealizedPnl ?? 0), 0)
          : undefined,
        realizedPnl: successful.some(result => result.realizedPnl !== undefined)
          ? successful.reduce((sum, result) => sum + (result.realizedPnl ?? 0), 0)
          : undefined,
        netRealizedPnl: successful.some(result => result.netRealizedPnl !== undefined)
          ? successful.reduce((sum, result) => sum + (result.netRealizedPnl ?? 0), 0)
          : undefined,
        fee: successful.some(result => result.fee !== undefined)
          ? successful.reduce((sum, result) => sum + (result.fee ?? 0), 0)
          : undefined,
        settlementStatus: successful.every(result => result.settlementStatus !== "pending") ? "final" : "pending",
      };
    } catch (e: any) {
      return { success: false, rawResponse: "{}", errorMessage: e.message };
    }
  }

  /**
   * Bybit 智能平倉：目前直接委託給 closePosition（市價）
   * 未來可擴展為限價+超時兜底機制
   */
  async closePositionSmart(
    symbol: string,
    posSide?: "long" | "short" | "net",
    _timeoutMs?: number,
    _priceOffsetPct?: number,
  ): Promise<OrderResult> {
    return this.closePosition(symbol, posSide);
  }

  async getClosedPnl(
    symbol?: string,
    startTime?: number,
  ): Promise<{ symbol: string; pnl: number; time: number }[]> {
    const params: Record<string, unknown> = { category: "linear", limit: 100 };
    if (symbol) params.symbol = this.normalizeSymbol(symbol);
    if (startTime) params.startTime = startTime;
    const data = await this.request("GET", "/v5/position/closed-pnl", params);
    if (data.retCode !== 0) return [];
    return (data.result?.list || []).map((r: any) => ({
      symbol: r.symbol,
      pnl: parseFloat(r.closedPnl),
      time: parseInt(r.updatedTime),
    }));
  }
}
