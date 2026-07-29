/**
 * 歷史 K 線數據獲取（pasted_content_4.txt 任務 7）
 * OKX / Bybit 公開 API，免費、無需金鑰
 *
 * V2.0: 多端點回退機制 — 當主端點被 CloudFront/地區封鎖時自動切換備用端點
 */

import { getBacktestDatabase, type OHLCVRow } from "./backtestDatabase";
import { convertToOKXFormat, convertToBybitFormat, getTimeframeMilliseconds } from "./timeframeParser";
import { normalizeOHLCVData } from "./backtestContracts";

// OKX 多端點（主站 + AWS 備用）
const OKX_ENDPOINTS = [
  "https://www.okx.com",
  "https://aws.okx.com",
  "https://www.okx.cab",
];

// Bybit 多端點
const BYBIT_ENDPOINTS = [
  "https://api.bybit.com",
  "https://api.bytick.com",
];

const BATCH_LIMIT = 300;
const REQUEST_INTERVAL_MS = 250;
const FETCH_TIMEOUT_MS = 8000; // 8s timeout per endpoint (reduced from 20s)

// 記錄已知可用的端點（避免每次都從頭嘗試）
let okxWorkingEndpoint: string | null = null;
let bybitWorkingEndpoint: string | null = null;

// 記錄 OKX history-candles 是否被封鎖（避免重複嘗試 60s 超時）
let okxHistoryBlocked = false;
let okxHistoryBlockedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 將通用 symbol 轉為 OKX instId（BTCUSDT → BTC-USDT；已含 - 則原樣） */
export function toOKXInstId(symbol: string): string {
  if (symbol.includes("-")) return symbol;
  const quotes = ["USDT", "USDC", "USD", "BTC", "ETH"];
  for (const q of quotes) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      return `${symbol.slice(0, symbol.length - q.length)}-${q}`;
    }
  }
  return symbol;
}

/** 將通用 symbol 轉為 Bybit symbol（BTC-USDT-SWAP → BTCUSDT） */
export function toBybitSymbol(symbol: string): string {
  return symbol.replace(/-SWAP$/i, "").replace(/-/g, "");
}

interface FetchProgress {
  fetched: number;
  message: string;
}

/**
 * 帶多端點回退的 fetch — 嘗試所有端點直到成功
 */
async function fetchWithFallback(
  endpoints: string[],
  pathAndQuery: string,
  workingEndpoint: string | null,
  setWorking: (ep: string) => void,
  label: string,
): Promise<Response> {
  // 優先嘗試已知可用的端點
  const orderedEndpoints = workingEndpoint
    ? [workingEndpoint, ...endpoints.filter((e) => e !== workingEndpoint)]
    : [...endpoints];

  let lastError: Error | null = null;

  for (const base of orderedEndpoints) {
    try {
      const url = `${base}${pathAndQuery}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      
      if (res.status === 403 || res.status === 451) {
        // 地區封鎖，嘗試下一個端點
        console.warn(`[DataFetcher] ${label} ${base} 被封鎖 (HTTP ${res.status})，嘗試備用端點...`);
        continue;
      }
      
      if (!res.ok) {
        // 其他 HTTP 錯誤，也嘗試下一個
        console.warn(`[DataFetcher] ${label} ${base} HTTP ${res.status}，嘗試備用端點...`);
        continue;
      }

      // 成功！記錄可用端點
      setWorking(base);
      return res;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.warn(`[DataFetcher] ${label} ${base} 連線失敗: ${lastError.message}，嘗試備用端點...`);
    }
  }

  throw new Error(`${label} 所有端點均不可用（已嘗試 ${orderedEndpoints.length} 個端點）: ${lastError?.message ?? "未知錯誤"}`);
}

/**
 * 從 OKX 抓取歷史 K 線（自動 after 分頁 + 多端點回退）
 * 優先使用 history-candles（可取更久的歷史），失敗則自動降級到 market/candles
 */
export async function fetchOKXCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  onProgress?: (p: FetchProgress) => void,
): Promise<OHLCVRow[]> {
  // 先嘗試 history-candles（支援更長歷史），失敗則降級到普通 candles
  try {
    const result = await fetchOKXHistoryCandles(symbol, timeframe, startMs, endMs, onProgress);
    return result;
  } catch (historyError) {
    console.warn(`[DataFetcher] OKX history-candles 失敗: ${(historyError as Error).message}，降級使用 market/candles...`);
    // 標記 history-candles 被封鎖
    okxHistoryBlocked = true;
    okxHistoryBlockedAt = Date.now();
    return fetchOKXRegularCandles(symbol, timeframe, startMs, endMs, onProgress);
  }
}

/**
 * OKX history-candles API（可取更久的歷史數據）
 */
async function fetchOKXHistoryCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  onProgress?: (p: FetchProgress) => void,
): Promise<OHLCVRow[]> {
  const instId = toOKXInstId(symbol);
  const bar = convertToOKXFormat(timeframe);
  const timeframeMs = getTimeframeMilliseconds(timeframe);
  const all: OHLCVRow[] = [];
  let after = String(endMs); // `[start,end)`：OKX after=ts 回傳 ts 之前（更早）的數據
  let guard = 0;

  while (guard++ < 2000) {
    const pathAndQuery = `/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${BATCH_LIMIT}&after=${after}`;
    
    const res = await fetchWithFallback(
      OKX_ENDPOINTS,
      pathAndQuery,
      okxWorkingEndpoint,
      (ep) => { okxWorkingEndpoint = ep; },
      "OKX K線(history)",
    );

    const json = (await res.json()) as { code: string; msg: string; data: string[][] };
    if (json.code !== "0") throw new Error(`OKX API 錯誤：${json.msg}（code=${json.code}）`);
    const rows = json.data || [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const ts = Number(r[0]);
      // OKX 第 9 欄 confirm：0=未收盤、1=已收盤。缺欄僅供舊測試／相容端點使用。
      if (ts >= startMs && ts < endMs && r[8] !== "0") {
        all.push({
          symbol,
          timeframe,
          timestamp: ts,
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
        });
      }
    }

    const oldestTs = Number(rows[rows.length - 1][0]);
    onProgress?.({ fetched: all.length, message: `已抓取 ${all.length} 根（至 ${new Date(oldestTs).toISOString()}）` });
    if (oldestTs <= startMs) break;
    after = String(oldestTs);
    await sleep(REQUEST_INTERVAL_MS);
  }

  return normalizeOHLCVData(all, {
    startMs,
    endMs,
    timeframeMs,
  }).candles;
}

/**
 * OKX 普通 candles API（/market/candles）— 作為 history-candles 的降級方案
 * 注意：此 API 最多只能取近 1440 根（約 5 天的 5 分鐘 K 線），但在部署地區不會被封鎖
 * 對於較長時間範圍，會分批向前翻頁
 */
async function fetchOKXRegularCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  onProgress?: (p: FetchProgress) => void,
): Promise<OHLCVRow[]> {
  const instId = toOKXInstId(symbol);
  const bar = convertToOKXFormat(timeframe);
  const timeframeMs = getTimeframeMilliseconds(timeframe);
  const all: OHLCVRow[] = [];
  let after = String(endMs);
  let guard = 0;
  const REGULAR_LIMIT = 100; // market/candles 每次最多 100 根

  console.log(`[DataFetcher] 使用 OKX market/candles API 獲取 ${instId} ${bar} 數據...`);

  while (guard++ < 5000) {
    const pathAndQuery = `/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${REGULAR_LIMIT}&after=${after}`;
    
    const res = await fetchWithFallback(
      OKX_ENDPOINTS,
      pathAndQuery,
      okxWorkingEndpoint,
      (ep) => { okxWorkingEndpoint = ep; },
      "OKX K線(regular)",
    );

    const json = (await res.json()) as { code: string; msg: string; data: string[][] };
    if (json.code !== "0") throw new Error(`OKX candles API 錯誤：${json.msg}（code=${json.code}）`);
    const rows = json.data || [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const ts = Number(r[0]);
      if (ts >= startMs && ts < endMs && r[8] !== "0") {
        all.push({
          symbol,
          timeframe,
          timestamp: ts,
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
        });
      }
    }

    const oldestTs = Number(rows[rows.length - 1][0]);
    onProgress?.({ fetched: all.length, message: `已抓取 ${all.length} 根（至 ${new Date(oldestTs).toISOString()}）` });
    if (oldestTs <= startMs || rows.length < REGULAR_LIMIT) break;
    after = String(oldestTs);
    await sleep(REQUEST_INTERVAL_MS);
  }

  console.log(`[DataFetcher] OKX market/candles 完成: ${all.length} 根 K 線`);
  return normalizeOHLCVData(all, {
    startMs,
    endMs,
    timeframeMs,
  }).candles;
}

/**
 * 從 Bybit 抓取歷史 K 線（end 參數向更早翻頁 + 多端點回退）
 */
export async function fetchBybitCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  onProgress?: (p: FetchProgress) => void,
): Promise<OHLCVRow[]> {
  const bybitSymbol = toBybitSymbol(symbol);
  const interval = convertToBybitFormat(timeframe);
  const timeframeMs = getTimeframeMilliseconds(timeframe);
  const all: OHLCVRow[] = [];
  let end = endMs - 1;
  let guard = 0;

  while (guard++ < 2000) {
    const pathAndQuery = `/v5/market/kline?category=linear&symbol=${encodeURIComponent(bybitSymbol)}&interval=${interval}&limit=${BATCH_LIMIT}&start=${startMs}&end=${end}`;
    
    const res = await fetchWithFallback(
      BYBIT_ENDPOINTS,
      pathAndQuery,
      bybitWorkingEndpoint,
      (ep) => { bybitWorkingEndpoint = ep; },
      "Bybit K線",
    );

    const json = (await res.json()) as {
      retCode: number;
      retMsg: string;
      result?: { list?: string[][] };
    };
    if (json.retCode !== 0) throw new Error(`Bybit API 錯誤：${json.retMsg}（retCode=${json.retCode}）`);
    const rows = json.result?.list || [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const ts = Number(r[0]);
      if (ts >= startMs && ts < endMs) {
        all.push({
          symbol,
          timeframe,
          timestamp: ts,
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
        });
      }
    }

    const oldestTs = Number(rows[rows.length - 1][0]);
    onProgress?.({ fetched: all.length, message: `已抓取 ${all.length} 根（至 ${new Date(oldestTs).toISOString()}）` });
    if (oldestTs <= startMs || rows.length < BATCH_LIMIT) break;
    end = oldestTs - 1;
    await sleep(REQUEST_INTERVAL_MS);
  }

  return normalizeOHLCVData(all, {
    startMs,
    endMs,
    timeframeMs,
  }).candles;
}

/**
 * 確保指定區間的 K 線已在本地快取（SQLite），不足則自動從交易所抓取。
 * @returns K 線陣列（昇冪）
 */
export async function ensureOHLCVData(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  exchange: "okx" | "bybit" = "okx",
  onProgress?: (p: FetchProgress) => void,
): Promise<OHLCVRow[]> {
  const db = getBacktestDatabase();
  const tfMs = getTimeframeMilliseconds(timeframe);
  const expected = Math.floor((endMs - startMs) / tfMs);
  const existing = db.countOHLCV(symbol, timeframe, startMs, endMs);

  // 覆蓋率 >= 95% 視為快取命中（週末/停盤縫隙容差）
  if (expected > 0 && existing >= expected * 0.95) {
    return normalizeOHLCVData(
      db.getOHLCV(symbol, timeframe, startMs, endMs),
      { startMs, endMs, timeframeMs: tfMs },
    ).candles;
  }

  // 直接使用用戶指定的交易所（fetchOKXCandles 內部已有 history-candles -> regular candles 降級邏輯）
  let fetched: OHLCVRow[] = [];
  try {
    fetched = exchange === "bybit"
      ? await fetchBybitCandles(symbol, timeframe, startMs, endMs, onProgress)
      : await fetchOKXCandles(symbol, timeframe, startMs, endMs, onProgress);
  } catch (primaryError) {
    // 主交易所失敗，嘗試備用交易所
    const fallbackExchange = exchange === "okx" ? "bybit" : "okx";
    console.warn(`[DataFetcher] ${exchange} 獲取失敗: ${(primaryError as Error).message}，嘗試 ${fallbackExchange} 作為備用...`);
    try {
      fetched = fallbackExchange === "bybit"
        ? await fetchBybitCandles(symbol, timeframe, startMs, endMs, onProgress)
        : await fetchOKXCandles(symbol, timeframe, startMs, endMs, onProgress);
    } catch (fallbackError) {
      throw new Error(
        `K線數據獲取失敗（${exchange} 和 ${fallbackExchange} 均不可用）。` +
        `主要錯誤: ${(primaryError as Error).message}。` +
        `備用錯誤: ${(fallbackError as Error).message}`
      );
    }
  }

  const normalizedFetched = normalizeOHLCVData(fetched, {
    startMs,
    endMs,
    timeframeMs: tfMs,
  }).candles;
  if (normalizedFetched.length > 0) {
    db.insertOHLCV(normalizedFetched);
  }
  return normalizeOHLCVData(
    db.getOHLCV(symbol, timeframe, startMs, endMs),
    { startMs, endMs, timeframeMs: tfMs },
  ).candles;
}
