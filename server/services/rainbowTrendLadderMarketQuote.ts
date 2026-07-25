export interface RainbowTrendLadderMarketQuote {
  exchange: "okx" | "bybit";
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spreadPrice: number;
  spreadPoints: number;
  capturedAt: number;
}

function positiveNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`新七彩虹策略即時報價欄位 ${field} 無效`);
  }
  return parsed;
}

function normalizeOkxSwapSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase().replace(/[\/_]/g, "-");
  if (upper.endsWith("-SWAP")) return upper;
  if (upper.includes("-")) return `${upper}-SWAP`;
  const match = upper.match(/^([A-Z0-9]+)(USDT|USDC|USD)$/);
  if (!match) throw new Error(`無法將交易對 ${symbol} 轉換為 OKX 永續合約格式`);
  return `${match[1]}-${match[2]}-SWAP`;
}

function normalizeBybitLinearSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase().replace(/[-\/_]/g, "").replace(/SWAP$/, "");
  if (!/^[A-Z0-9]+$/.test(normalized)) throw new Error(`無法將交易對 ${symbol} 轉換為 Bybit 永續合約格式`);
  return normalized;
}

function buildQuote(
  exchange: "okx" | "bybit",
  symbol: string,
  bidValue: unknown,
  askValue: unknown,
  pointValue: number,
): RainbowTrendLadderMarketQuote {
  if (!Number.isFinite(pointValue) || pointValue <= 0) throw new Error("新七彩虹策略 Point_Value 必須大於 0");
  const bid = positiveNumber(bidValue, "bid");
  const ask = positiveNumber(askValue, "ask");
  if (ask < bid) throw new Error(`新七彩虹策略即時報價反轉：ask ${ask} < bid ${bid}`);
  const spreadPrice = ask - bid;
  return {
    exchange,
    symbol,
    bid,
    ask,
    mid: (ask + bid) / 2,
    spreadPrice,
    spreadPoints: spreadPrice / pointValue,
    capturedAt: Date.now(),
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`即時報價 HTTP ${response.status}`);
  return response.json();
}

export async function fetchRainbowTrendLadderMarketQuote(
  exchange: "okx" | "bybit",
  symbol: string,
  pointValue: number,
): Promise<RainbowTrendLadderMarketQuote> {
  if (exchange === "okx") {
    const normalized = normalizeOkxSwapSymbol(symbol);
    const payload = await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(normalized)}`) as {
      code?: string;
      msg?: string;
      data?: Array<{ bidPx?: string; askPx?: string }>;
    };
    if (payload.code !== "0" || !payload.data?.[0]) {
      throw new Error(`OKX 即時報價失敗：${payload.msg || payload.code || "空資料"}`);
    }
    return buildQuote("okx", normalized, payload.data[0].bidPx, payload.data[0].askPx, pointValue);
  }

  const normalized = normalizeBybitLinearSymbol(symbol);
  const payload = await fetchJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(normalized)}`) as {
    retCode?: number;
    retMsg?: string;
    result?: { list?: Array<{ bid1Price?: string; ask1Price?: string }> };
  };
  if (payload.retCode !== 0 || !payload.result?.list?.[0]) {
    throw new Error(`Bybit 即時報價失敗：${payload.retMsg || payload.retCode || "空資料"}`);
  }
  return buildQuote("bybit", normalized, payload.result.list[0].bid1Price, payload.result.list[0].ask1Price, pointValue);
}
