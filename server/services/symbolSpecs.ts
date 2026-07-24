/**
 * 交易對規格工具（第二輪優化 3）
 *
 * 下單鏈路統一使用此模組，將下單數量按交易所規格（最小下單量 minOrderQty、
 * 步長 qtyStep）進行取整與檢查，避免因精度或數量不符被交易所拒單。
 *
 * 規格來源：與 exchange.router.ts 相同的公開 instruments API，
 * 帶 10 分鐘記憶體快取；獲取失敗時不阻擋下單（回傳原數量），
 * 由交易所端做最終校驗，確保鏈路可用性優先。
 */

export interface SymbolSpec {
  symbol: string;
  minOrderQty?: number;
  qtyStep?: number;
  /** OKX 合約面值（1 張 = ctVal 個 base 幣） */
  ctVal?: number;
}

const specCache = new Map<string, { specs: Map<string, SymbolSpec>; fetchedAt: number }>();
const SPEC_TTL_MS = 10 * 60 * 1000;

function toPositiveNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 拉取交易所全量合約規格（帶快取） */
export async function getSymbolSpecs(
  exchange: "bybit" | "okx",
  category: "spot" | "linear" = "linear",
): Promise<Map<string, SymbolSpec>> {
  const cacheKey = `${exchange}:${category}`;
  const cached = specCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SPEC_TTL_MS) return cached.specs;

  const specs = new Map<string, SymbolSpec>();
  try {
    if (exchange === "okx") {
      const instType = category === "linear" ? "SWAP" : "SPOT";
      const data = await fetchJson(
        `https://www.okx.com/api/v5/public/instruments?instType=${instType}`,
      );
      for (const item of data?.data ?? []) {
        if (item.state !== "live") continue;
        const ctVal = toPositiveNumber(item.ctVal);
        const minSz = toPositiveNumber(item.minSz);
        const lotSz = toPositiveNumber(item.lotSz);
        if (instType === "SWAP" && ctVal) {
          specs.set(item.instId, {
            symbol: item.instId,
            minOrderQty: minSz !== undefined ? minSz * ctVal : undefined,
            qtyStep: lotSz !== undefined ? lotSz * ctVal : undefined,
            ctVal,
          });
        } else {
          specs.set(item.instId, { symbol: item.instId, minOrderQty: minSz, qtyStep: lotSz });
        }
      }
    } else {
      const cat = category === "linear" ? "linear" : "spot";
      let cursor = "";
      for (let i = 0; i < 5; i++) {
        const url =
          `https://api.bybit.com/v5/market/instruments-info?category=${cat}&limit=1000` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        const data = await fetchJson(url);
        for (const item of data?.result?.list ?? []) {
          if (item.status !== "Trading") continue;
          const lot = item.lotSizeFilter ?? {};
          specs.set(item.symbol, {
            symbol: item.symbol,
            minOrderQty: toPositiveNumber(lot.minOrderQty),
            qtyStep: toPositiveNumber(lot.qtyStep) ?? toPositiveNumber(lot.basePrecision),
          });
        }
        cursor = data?.result?.nextPageCursor || "";
        if (!cursor) break;
      }
    }
    specCache.set(cacheKey, { specs, fetchedAt: Date.now() });
  } catch (err) {
    console.error(`[SymbolSpecs] 獲取 ${exchange} 規格失敗:`, err);
    // 回退過期快取
    if (cached) return cached.specs;
  }
  return specs;
}

/** 將數量按步長向下取整（處理浮點誤差，保留 8 位小數） */
export function roundToStep(qty: number, step?: number): number {
  if (!step || step <= 0 || !Number.isFinite(qty)) return qty;
  const steps = Math.floor(qty / step + 1e-9);
  return parseFloat((steps * step).toFixed(8));
}

export interface NormalizeResult {
  qty: number;
  adjusted: boolean;
  /** 為何被調整/拒絕的說明（無調整時為空） */
  reason: string;
  /** 數量低於最小下單量且無法補救時為 true，呼叫方應拒單 */
  rejected: boolean;
}

/**
 * 依交易對規格正規化下單數量：
 * 1. 按 qtyStep 向下取整
 * 2. 取整後低於 minOrderQty → rejected（避免交易所直接拒單產生錯誤訊息不友善）
 * 規格缺失時原樣通過（由交易所端最終校驗）
 */
export function normalizeOrderQty(qty: number, spec?: SymbolSpec): NormalizeResult {
  if (!spec || (!spec.qtyStep && !spec.minOrderQty)) {
    return { qty, adjusted: false, reason: "", rejected: false };
  }
  let result = qty;
  let adjusted = false;
  const parts: string[] = [];
  if (spec.qtyStep && spec.qtyStep > 0) {
    const rounded = roundToStep(result, spec.qtyStep);
    if (rounded !== result) {
      parts.push(`按步長 ${spec.qtyStep} 取整 ${result} → ${rounded}`);
      result = rounded;
      adjusted = true;
    }
  }
  if (spec.minOrderQty && result < spec.minOrderQty) {
    return {
      qty: result,
      adjusted,
      reason: `數量 ${result} 低於最小下單量 ${spec.minOrderQty}`,
      rejected: true,
    };
  }
  return { qty: result, adjusted, reason: parts.join("；"), rejected: false };
}

/** 便捷函數：獲取單一交易對規格並正規化數量 */
export async function normalizeQtyForSymbol(
  exchange: "bybit" | "okx",
  symbol: string,
  qty: number,
  category: "spot" | "linear" = "linear",
): Promise<NormalizeResult> {
  const specs = await getSymbolSpecs(exchange, category);
  return normalizeOrderQty(qty, specs.get(symbol));
}
