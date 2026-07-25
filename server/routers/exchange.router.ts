/**
 * 交易所公開資料路由 - 依據 pasted_content_3.txt 任務 1 實作，第二輪優化擴充
 *
 * getSymbols：從 Bybit/OKX 公開 API 獲取交易所支援的所有現貨/合約交易對，
 * 並解析基礎貨幣（base）與報價貨幣（quote），供前端搜索下拉選單使用。
 * 第二輪擴充：
 * - 交易對規格欄位（minOrderQty / qtyStep / 合約面值 ctVal），供前端自動帶入限制
 * - getTicker：即時最新價，供 USDT 金額模式即時換算預估數量
 * - favorites：用戶收藏交易對（DB 持久化），下拉選單置頂顯示
 *
 * 適配說明：
 * - 專案已有原生 fetch（Node 22），無需引入 axios，保持依賴精簡
 * - 加入 10 分鐘記憶體快取，避免每次打開表單都請求交易所 API
 * - 加入 8 秒逾時保護，逾時回退至快取或預設清單
 */
import { readFile } from "fs/promises";
import path from "path";
import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";

export interface SymbolDetail {
  symbol: string;
  base: string;
  quote: string;
  /** 最小下單量（以 base 幣計；OKX SWAP 為最小張數 × ctVal 換算後的幣量） */
  minOrderQty?: number;
  /** 數量步長（下單數量必須是它的整數倍） */
  qtyStep?: number;
  /** OKX 合約面值（1 張 = ctVal 個 base 幣）；Bybit 無此概念 */
  ctVal?: number;
}

/** 記憶體快取：key = `${exchange}:${category}` */
const symbolsCache = new Map<string, { data: SymbolDetail[]; fetchedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分鐘

/** 即時價快取：key = `${exchange}:${symbol}`（5 秒 TTL，避免高頻打交易所） */
const tickerCache = new Map<string, { price: number; fetchedAt: number }>();
const TICKER_TTL_MS = 5 * 1000;

/** 交易所 API 不可用時的保底清單（常見合約交易對） */
const FALLBACK_SYMBOLS: SymbolDetail[] = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT", minOrderQty: 0.001, qtyStep: 0.001 },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT", minOrderQty: 0.01, qtyStep: 0.01 },
  { symbol: "SOLUSDT", base: "SOL", quote: "USDT", minOrderQty: 0.1, qtyStep: 0.1 },
  { symbol: "XRPUSDT", base: "XRP", quote: "USDT", minOrderQty: 1, qtyStep: 1 },
  { symbol: "DOGEUSDT", base: "DOGE", quote: "USDT", minOrderQty: 1, qtyStep: 1 },
  { symbol: "BNBUSDT", base: "BNB", quote: "USDT", minOrderQty: 0.01, qtyStep: 0.01 },
];

/**
 * 解析交易對字串為 base/quote（依據 pasted_content_3.txt 提供的邏輯，並擴充支援更多 quote 幣種）
 * 優先使用交易所 API 回傳的 baseCoin/quoteCoin；此函數為備用解析器
 */
export function parseSymbol(symbol: string): SymbolDetail {
  // OKX: BTC-USDT-SWAP / BTC-USDT → 提取 BTC, USDT
  if (symbol.includes("-")) {
    const parts = symbol.split("-");
    return { symbol, base: parts[0] || symbol, quote: parts[1] || "USDT" };
  }
  // Bybit: BTCUSDT → 提取 BTC, USDT（依常見 quote 後綴長度優先匹配）
  const KNOWN_QUOTES = ["USDT", "USDC", "BUSD", "USDE", "EUR", "BTC", "ETH", "DAI", "BRL", "TRY", "USD"];
  for (const q of KNOWN_QUOTES) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      return { symbol, base: symbol.slice(0, -q.length), quote: q };
    }
  }
  return { symbol, base: symbol, quote: "USD" };
}

/** 將字串安全轉為正數，失敗回傳 undefined */
function toPositiveNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function fetchWithTimeout(url: string, timeoutMsOrHeaders: number | Record<string, string> = 8000, timeoutMs = 8000): Promise<any> {
  let headers: Record<string, string> = {};
  let timeout = timeoutMs;
  if (typeof timeoutMsOrHeaders === 'number') {
    timeout = timeoutMsOrHeaders;
  } else {
    headers = timeoutMsOrHeaders;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 從 OKX 獲取交易對（公開 API，無需金鑰），優先使用 API 回傳的幣種欄位，含規格
 * ★ 核心修復：新增 testnet 參數，模擬盤查詢帶 x-simulated-trading header
 */
async function fetchOkxSymbols(category: "spot" | "linear", testnet: boolean = false): Promise<SymbolDetail[]> {
  const instType = category === "linear" ? "SWAP" : "SPOT";
  const url = `https://www.okx.com/api/v5/public/instruments?instType=${instType}`;
  const headers: Record<string, string> = {};
  if (testnet) {
    headers['x-simulated-trading'] = '1';
  }
  const data: any = await fetchWithTimeout(url, headers);
  return (data?.data ?? [])
    .filter((item: any) => item.state === "live")
    .map((item: any) => {
      const symbol = item.instId as string;
      // OKX 規格：minSz 最小下單量（SPOT 為幣量，SWAP 為張數）、lotSz 步長、ctVal 合約面值
      const ctVal = toPositiveNumber(item.ctVal);
      const minSz = toPositiveNumber(item.minSz);
      const lotSz = toPositiveNumber(item.lotSz);
      let minOrderQty: number | undefined;
      let qtyStep: number | undefined;
      if (instType === "SWAP" && ctVal) {
        // SWAP：張數 × 面值 = 幣量
        minOrderQty = minSz !== undefined ? minSz * ctVal : undefined;
        qtyStep = lotSz !== undefined ? lotSz * ctVal : undefined;
      } else {
        minOrderQty = minSz;
        qtyStep = lotSz;
      }
      const specs = { minOrderQty, qtyStep, ctVal: instType === "SWAP" ? ctVal : undefined };
      if (instType === "SPOT" && item.baseCcy && item.quoteCcy) {
        return { symbol, base: item.baseCcy as string, quote: item.quoteCcy as string, ...specs };
      }
      // SWAP：從 settleCcy/ctValCcy 不可靠，直接解析 instId（BTC-USDT-SWAP）
      return { ...parseSymbol(symbol), ...specs };
    });
}

/** 從 Bybit 獲取交易對（公開 API，無需金鑰，limit=1000 拿全量），直接使用 API 回傳的 baseCoin/quoteCoin，含規格 */
async function fetchBybitSymbols(category: "spot" | "linear"): Promise<SymbolDetail[]> {
  const cat = category === "linear" ? "linear" : "spot";
  const details: SymbolDetail[] = [];
  let cursor = "";
  // Bybit 分頁：最多迴圈 5 次防止意外死循環
  for (let i = 0; i < 5; i++) {
    const url =
      `https://api.bybit.com/v5/market/instruments-info?category=${cat}&limit=1000` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const data: any = await fetchWithTimeout(url);
    const list = data?.result?.list ?? [];
    details.push(
      ...list
        .filter((item: any) => item.status === "Trading")
        .map((item: any) => {
          const symbol = item.symbol as string;
          // Bybit 規格：lotSizeFilter.minOrderQty / qtyStep（linear），SPOT 為 basePrecision/minOrderQty
          const lot = item.lotSizeFilter ?? {};
          const minOrderQty = toPositiveNumber(lot.minOrderQty);
          const qtyStep = toPositiveNumber(lot.qtyStep) ?? toPositiveNumber(lot.basePrecision);
          const specs = { minOrderQty, qtyStep };
          if (item.baseCoin && item.quoteCoin) {
            return { symbol, base: item.baseCoin as string, quote: item.quoteCoin as string, ...specs };
          }
          return { ...parseSymbol(symbol), ...specs };
        }),
    );
    cursor = data?.result?.nextPageCursor || "";
    if (!cursor) break;
  }
  return details;
}

/** 獲取即時最新價（公開 API，無需金鑰） */
/**
 * 將簡化格式的 symbol（如 BTCUSDT）轉換為 OKX instId 格式（如 BTC-USDT-SWAP）
 * 如果已經是 OKX 格式（包含 -）則直接返回
 */
function normalizeOkxInstId(symbol: string, category: "spot" | "linear"): string {
  // 已經是 OKX 格式（包含 -）
  if (symbol.includes("-")) return symbol;
  // 嘗試解析：BTCUSDT -> BTC-USDT-SWAP, ETHUSDT -> ETH-USDT-SWAP
  const match = symbol.match(/^([A-Z0-9]+)(USDT|USD|USDC)$/i);
  if (match) {
    const base = match[1].toUpperCase();
    const quote = match[2].toUpperCase();
    return category === "linear" ? `${base}-${quote}-SWAP` : `${base}-${quote}`;
  }
  // 無法解析，原樣返回
  return symbol;
}

/**
 * 將 OKX 格式的 symbol（如 BTC-USDT-SWAP）轉換為 Bybit 格式（如 BTCUSDT）
 */
function normalizeBybitSymbol(symbol: string): string {
  // 已經是 Bybit 格式（不包含 -）
  if (!symbol.includes("-")) return symbol;
  // BTC-USDT-SWAP -> BTCUSDT, ETH-USDT -> ETHUSDT
  const parts = symbol.split("-");
  if (parts.length >= 2) {
    return `${parts[0]}${parts[1]}`;
  }
  return symbol;
}

async function fetchTickerPrice(
  exchange: "bybit" | "okx",
  symbol: string,
  category: "spot" | "linear",
): Promise<number> {
  if (exchange === "okx") {
    const instId = normalizeOkxInstId(symbol, category);
    const data: any = await fetchWithTimeout(
      `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`,
      6000,
    );
    const price = Number(data?.data?.[0]?.last);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`OKX ticker 無效: ${instId}`);
    return price;
  }
  const cat = category === "linear" ? "linear" : "spot";
  const bybitSymbol = normalizeBybitSymbol(symbol);
  const data: any = await fetchWithTimeout(
    `https://api.bybit.com/v5/market/tickers?category=${cat}&symbol=${encodeURIComponent(bybitSymbol)}`,
    6000,
  );
  const price = Number(data?.result?.list?.[0]?.lastPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Bybit ticker 無效: ${bybitSymbol}`);
  return price;
}

/** UI Schema 快取（啟動後讀一次） */
let uiSchemaCache: Record<string, unknown> | null = null;

export const exchangeRouter = router({
  /**
   * 受保護的策略持倉快照：同一 API 金鑰只查一次帳戶持倉，再安全歸屬到策略。
   * 此程序嚴格唯讀；不下單、不平倉、不修改策略或帳戶設定。
   */
  getStrategyPositionSnapshots: protectedProcedure
    .input(
      z.object({
        strategyIds: z.array(z.number().int().positive()).max(200).optional(),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      const { getStrategyPositionSnapshotsForUser } = await import("../services/strategyPositionSnapshot");
      return getStrategyPositionSnapshotsForUser(ctx.user.id, input?.strategyIds);
    }),

  /**
   * 獲取 V3.5 策略 UI Schema（pasted_content_3.txt 任務 5）
   * 供前端動態表單渲染：Base_Lot_Size 對象格式、Symbol 欄位、Position_Mode/Position_Value
   */
  getUiSchema: publicProcedure.query(async (): Promise<Record<string, unknown>> => {
    if (uiSchemaCache) return uiSchemaCache;
    const schemaPath = path.resolve(process.cwd(), "server/ui/strategySchema.json");
    const raw = await readFile(schemaPath, "utf-8");
    uiSchemaCache = JSON.parse(raw) as Record<string, unknown>;
    return uiSchemaCache;
  }),

  /** 獲取交易所支援的交易對列表（含 base/quote 解析與最小下單量/步長規格）
   * ★ 核心修復：新增 testnet 參數，模擬盤只返回模擬盤支持的交易對 */
  getSymbols: publicProcedure
    .input(
      z.object({
        exchange: z.enum(["bybit", "okx"]),
        category: z.enum(["spot", "linear"]).optional().default("linear"), // 合約
        testnet: z.boolean().optional().default(false), // ★ 新增：是否查詢模擬盤交易對
      }),
    )
    .query(async ({ input }): Promise<SymbolDetail[]> => {
      const cacheKey = `${input.exchange}:${input.category}:${input.testnet ? 'demo' : 'live'}`;
      const cached = symbolsCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.data;
      }

      try {
        let symbolDetails: SymbolDetail[] = [];
        if (input.exchange === "okx") {
          symbolDetails = await fetchOkxSymbols(input.category, input.testnet);
        } else {
          symbolDetails = await fetchBybitSymbols(input.category);
        }

        // 優先顯示 USDT 交易對，並按字母排序
        symbolDetails.sort((a, b) => {
          if (a.quote === "USDT" && b.quote !== "USDT") return -1;
          if (a.quote !== "USDT" && b.quote === "USDT") return 1;
          return a.symbol.localeCompare(b.symbol);
        });

        symbolsCache.set(cacheKey, { data: symbolDetails, fetchedAt: Date.now() });
        return symbolDetails;
      } catch (err) {
        console.error(`[ExchangeRouter] 獲取 ${input.exchange} 交易對失敗:`, err);
        // 回退：過期快取 > 保底清單
        if (cached) return cached.data;
        return FALLBACK_SYMBOLS;
      }
    }),

  /** 獲取即時最新價（供 USDT 金額模式即時換算預估數量，5 秒快取） */
  getTicker: publicProcedure
    .input(
      z.object({
        exchange: z.enum(["bybit", "okx"]),
        symbol: z.string().min(2).max(40),
        category: z.enum(["spot", "linear"]).optional().default("linear"),
      }),
    )
    .query(async ({ input }): Promise<{ symbol: string; price: number; fetchedAt: number }> => {
      const cacheKey = `${input.exchange}:${input.symbol}`;
      const cached = tickerCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < TICKER_TTL_MS) {
        return { symbol: input.symbol, price: cached.price, fetchedAt: cached.fetchedAt };
      }
      const price = await fetchTickerPrice(input.exchange, input.symbol, input.category);
      const fetchedAt = Date.now();
      tickerCache.set(cacheKey, { price, fetchedAt });
      return { symbol: input.symbol, price, fetchedAt };
    }),

  /** 批量獲取多個交易對的即時價格（供持倉盈虧計算） */
  getBatchTickers: publicProcedure
    .input(
      z.object({
        pairs: z.array(
          z.object({
            exchange: z.enum(["bybit", "okx"]),
            symbol: z.string().min(2).max(40),
          }),
        ).max(20),
      }),
    )
    .query(async ({ input }) => {
      const results: { symbol: string; exchange: string; price: number; fetchedAt: number }[] = [];
      await Promise.allSettled(
        input.pairs.map(async (pair) => {
          try {
            const cacheKey = `${pair.exchange}:${pair.symbol}`;
            const cached = tickerCache.get(cacheKey);
            if (cached && Date.now() - cached.fetchedAt < TICKER_TTL_MS) {
              results.push({ symbol: pair.symbol, exchange: pair.exchange as string, price: cached.price, fetchedAt: cached.fetchedAt });
              return;
            }
            const price = await fetchTickerPrice(pair.exchange, pair.symbol, "linear");
            const fetchedAt = Date.now();
            tickerCache.set(cacheKey, { price, fetchedAt });
            results.push({ symbol: pair.symbol, exchange: pair.exchange as string, price, fetchedAt });
          } catch { /* skip failed tickers */ }
        }),
      );
      return results;
    }),

  /** 列出當前用戶收藏的交易對 */
  listFavorites: protectedProcedure
    .input(z.object({ exchange: z.enum(["bybit", "okx"]) }))
    .query(async ({ ctx, input }) => {
      const db = await import("../db");
      return db.listFavoriteSymbols(ctx.user.id, input.exchange);
    }),

  /** 切換收藏交易對（已收藏則取消，未收藏則加入） */
  toggleFavorite: protectedProcedure
    .input(
      z.object({
        exchange: z.enum(["bybit", "okx"]),
        symbol: z.string().min(2).max(40),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await import("../db");
      return db.toggleFavoriteSymbol(ctx.user.id, input.exchange, input.symbol);
    }),
});
