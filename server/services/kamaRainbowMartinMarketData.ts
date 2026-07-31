import type { KamaRainbowMartinTimeframe } from "../../shared/strategies/kamaRainbowMartin";
import type { KLineData } from "../strategies/base";

export type KamaRainbowMartinExchange = "okx" | "bybit";

export interface KamaRainbowMartinCandleBatch {
  exchange: KamaRainbowMartinExchange;
  symbol: string;
  timeframe: KamaRainbowMartinTimeframe;
  interval: string;
  candles: KLineData[];
  lastClosedBarIdentity: string | null;
  capturedAt: number;
}

export interface KamaRainbowMartinFreshQuote {
  exchange: KamaRainbowMartinExchange;
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  capturedAt: number;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const INTERVALS: Record<KamaRainbowMartinTimeframe, { okx: string; bybit: string; durationMs: number }> = {
  M5: { okx: "5m", bybit: "5", durationMs: 5 * 60_000 },
  M15: { okx: "15m", bybit: "15", durationMs: 15 * 60_000 },
  M30: { okx: "30m", bybit: "30", durationMs: 30 * 60_000 },
  H1: { okx: "1H", bybit: "60", durationMs: 60 * 60_000 },
  H4: { okx: "4H", bybit: "240", durationMs: 4 * 60 * 60_000 },
  D1: { okx: "1Dutc", bybit: "D", durationMs: 24 * 60 * 60_000 },
  W1: { okx: "1Wutc", bybit: "W", durationMs: 7 * 24 * 60 * 60_000 },
};

function positiveNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Kama 彩虹馬丁行情欄位 ${field} 無效`);
  return parsed;
}

function nonNegativeNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Kama 彩虹馬丁行情欄位 ${field} 無效`);
  return parsed;
}

export function normalizeKamaRainbowMartinSymbol(exchange: KamaRainbowMartinExchange, symbol: string): string {
  const upper = symbol.trim().toUpperCase().replace(/[\/_]/g, "-");
  if (exchange === "okx") {
    if (upper.endsWith("-SWAP")) return upper;
    if (upper.includes("-")) return `${upper}-SWAP`;
    const match = upper.match(/^([A-Z0-9]+)(USDT|USDC|USD)$/);
    if (!match) throw new Error(`無法將交易對 ${symbol} 轉換為 OKX 永續合約格式`);
    return `${match[1]}-${match[2]}-SWAP`;
  }
  const normalized = upper.replace(/-/g, "").replace(/SWAP$/, "");
  if (!/^[A-Z0-9]+$/.test(normalized)) throw new Error(`無法將交易對 ${symbol} 轉換為 Bybit 永續合約格式`);
  return normalized;
}

export function getKamaRainbowMartinInterval(
  exchange: KamaRainbowMartinExchange,
  timeframe: KamaRainbowMartinTimeframe,
): string {
  return INTERVALS[timeframe][exchange];
}

function validateCandle(candle: KLineData): KLineData {
  if (!Number.isSafeInteger(candle.timestamp) || candle.timestamp <= 0) throw new Error("Kama 彩虹馬丁 K 線 timestamp 無效");
  const open = positiveNumber(candle.open, "open");
  const high = positiveNumber(candle.high, "high");
  const low = positiveNumber(candle.low, "low");
  const close = positiveNumber(candle.close, "close");
  const volume = nonNegativeNumber(candle.volume, "volume");
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
    throw new Error(`Kama 彩虹馬丁 K 線 OHLC 關係無效：${candle.timestamp}`);
  }
  return { timestamp: candle.timestamp, open, high, low, close, volume };
}

export function normalizeKamaRainbowMartinCandles(candles: readonly KLineData[]): KLineData[] {
  const byTimestamp = new Map<number, KLineData>();
  for (const candle of candles) byTimestamp.set(candle.timestamp, validateCandle(candle));
  return Array.from(byTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp);
}

export function createKamaRainbowMartinBarIdentity(
  exchange: KamaRainbowMartinExchange,
  symbol: string,
  timeframe: KamaRainbowMartinTimeframe,
  timestamp: number,
): string {
  return `${exchange}:${normalizeKamaRainbowMartinSymbol(exchange, symbol)}:${timeframe}:${timestamp}`;
}

async function fetchJson(fetcher: Fetcher, url: string): Promise<any> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Kama 彩虹馬丁行情 HTTP ${response.status}`);
  return response.json();
}

function parseOkxRows(rows: unknown): KLineData[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is unknown[] => Array.isArray(row) && String(row[8] ?? "") === "1")
    .map(row => ({
      timestamp: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
}

export function parseBybitClosedRows(rows: unknown, timeframe: KamaRainbowMartinTimeframe, now: number): KLineData[] {
  if (!Array.isArray(rows)) return [];
  const durationMs = INTERVALS[timeframe].durationMs;
  return rows
    .filter((row): row is unknown[] => Array.isArray(row) && now >= Number(row[0]) + durationMs)
    .map(row => ({
      timestamp: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
}

async function fetchOkxClosedCandles(
  fetcher: Fetcher,
  symbol: string,
  timeframe: KamaRainbowMartinTimeframe,
  limit: number,
): Promise<KLineData[]> {
  const interval = INTERVALS[timeframe].okx;
  const collected: KLineData[] = [];
  let after: number | null = null;
  let previousOldest = Number.POSITIVE_INFINITY;
  while (collected.length < limit) {
    const pageLimit = Math.min(300, Math.max(1, limit - collected.length));
    const query = new URLSearchParams({ instId: symbol, bar: interval, limit: String(pageLimit) });
    if (after !== null) query.set("after", String(after));
    const payload = await fetchJson(fetcher, `https://www.okx.com/api/v5/market/history-candles?${query}`);
    if (payload?.code !== "0") throw new Error(`OKX K 線失敗：${payload?.msg || payload?.code || "未知錯誤"}`);
    const page = parseOkxRows(payload?.data);
    if (page.length === 0) break;
    collected.push(...page);
    const oldest = Math.min(...page.map(candle => candle.timestamp));
    if (!Number.isFinite(oldest) || oldest >= previousOldest) break;
    previousOldest = oldest;
    after = oldest;
    if (page.length < pageLimit) break;
  }
  return normalizeKamaRainbowMartinCandles(collected).slice(-limit);
}

async function fetchBybitClosedCandles(
  fetcher: Fetcher,
  symbol: string,
  timeframe: KamaRainbowMartinTimeframe,
  limit: number,
  now: number,
): Promise<KLineData[]> {
  const query = new URLSearchParams({
    category: "linear",
    symbol,
    interval: INTERVALS[timeframe].bybit,
    limit: String(Math.min(1_000, Math.max(1, limit + 1))),
  });
  const payload = await fetchJson(fetcher, `https://api.bybit.com/v5/market/kline?${query}`);
  if (payload?.retCode !== 0) throw new Error(`Bybit K 線失敗：${payload?.retMsg || payload?.retCode || "未知錯誤"}`);
  return normalizeKamaRainbowMartinCandles(parseBybitClosedRows(payload?.result?.list, timeframe, now)).slice(-limit);
}

export async function fetchKamaRainbowMartinClosedCandles(
  exchange: KamaRainbowMartinExchange,
  symbol: string,
  timeframe: KamaRainbowMartinTimeframe,
  limit: number,
  options?: { fetcher?: Fetcher; now?: number },
): Promise<KamaRainbowMartinCandleBatch> {
  const normalizedSymbol = normalizeKamaRainbowMartinSymbol(exchange, symbol);
  const requestedLimit = Math.min(1_000, Math.max(1, Math.trunc(limit)));
  const fetcher = options?.fetcher ?? fetch;
  const capturedAt = options?.now ?? Date.now();
  const candles = exchange === "okx"
    ? await fetchOkxClosedCandles(fetcher, normalizedSymbol, timeframe, requestedLimit)
    : await fetchBybitClosedCandles(fetcher, normalizedSymbol, timeframe, requestedLimit, capturedAt);
  const lastTimestamp = candles.at(-1)?.timestamp;
  return {
    exchange,
    symbol: normalizedSymbol,
    timeframe,
    interval: INTERVALS[timeframe][exchange],
    candles,
    lastClosedBarIdentity: lastTimestamp
      ? createKamaRainbowMartinBarIdentity(exchange, normalizedSymbol, timeframe, lastTimestamp)
      : null,
    capturedAt,
  };
}

export async function fetchKamaRainbowMartinFreshQuote(
  exchange: KamaRainbowMartinExchange,
  symbol: string,
  options?: { fetcher?: Fetcher; now?: number },
): Promise<KamaRainbowMartinFreshQuote> {
  const normalizedSymbol = normalizeKamaRainbowMartinSymbol(exchange, symbol);
  const fetcher = options?.fetcher ?? fetch;
  const capturedAt = options?.now ?? Date.now();
  if (exchange === "okx") {
    const payload = await fetchJson(fetcher, `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(normalizedSymbol)}`);
    if (payload?.code !== "0" || !payload?.data?.[0]) throw new Error(`OKX 即時報價失敗：${payload?.msg || "空資料"}`);
    const bid = positiveNumber(payload.data[0].bidPx, "bid");
    const ask = positiveNumber(payload.data[0].askPx, "ask");
    if (ask < bid) throw new Error("OKX 即時報價 bid／ask 反轉");
    return { exchange, symbol: normalizedSymbol, bid, ask, mid: (bid + ask) / 2, capturedAt };
  }
  const payload = await fetchJson(fetcher, `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(normalizedSymbol)}`);
  if (payload?.retCode !== 0 || !payload?.result?.list?.[0]) throw new Error(`Bybit 即時報價失敗：${payload?.retMsg || "空資料"}`);
  const bid = positiveNumber(payload.result.list[0].bid1Price, "bid");
  const ask = positiveNumber(payload.result.list[0].ask1Price, "ask");
  if (ask < bid) throw new Error("Bybit 即時報價 bid／ask 反轉");
  return { exchange, symbol: normalizedSymbol, bid, ask, mid: (bid + ask) / 2, capturedAt };
}
