/**
 * 時間框架解析器（pasted_content_4.txt 任務 3）
 * 支持任意時間框架：15m、1h、4h、1d、90m 等
 */

export interface ParsedTimeframe {
  unit: "m" | "h" | "d";
  value: number;
  totalSeconds: number;
  display: string;
}

const TIMEFRAME_REGEX = /^(\d+)(m|h|d)$/i;

/**
 * 解析時間框架字串，如 '15m'、'2h'、'1d'
 */
export function parseTimeframe(timeframe: string): ParsedTimeframe {
  const match = String(timeframe).trim().toLowerCase().match(TIMEFRAME_REGEX);
  if (!match) {
    throw new Error(`無效的時間框架格式: ${timeframe}（正確格式如 15m、1h、4h、1d）`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2] as "m" | "h" | "d";

  if (value <= 0) {
    throw new Error(`時間框架數值必須大於 0: ${timeframe}`);
  }

  let totalSeconds: number;
  switch (unit) {
    case "m":
      totalSeconds = value * 60;
      break;
    case "h":
      totalSeconds = value * 3600;
      break;
    case "d":
      totalSeconds = value * 86400;
      break;
  }

  return { unit, value, totalSeconds, display: `${value}${unit}` };
}

/**
 * OKX 支援的 bar 值白名單
 * 來源：https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history
 */
const OKX_SUPPORTED_BARS = new Set([
  "1m", "3m", "5m", "15m", "30m",
  "1H", "2H", "4H", "6H", "12H",
  "1D", "2D", "3D", "1W", "1M",
]);

/**
 * 轉換為 OKX API 的 bar 參數格式
 * OKX：1m/3m/5m/15m/30m → 小寫分鐘；1H/2H/4H/6H/12H → 大寫小時；1D/2D/3D → 大寫日
 */
export function convertToOKXFormat(timeframe: string): string {
  const parsed = parseTimeframe(timeframe);
  let bar: string;
  if (parsed.unit === "m") {
    if (parsed.value >= 60 && parsed.value % 60 === 0) {
      bar = `${parsed.value / 60}H`;
    } else {
      bar = `${parsed.value}m`;
    }
  } else if (parsed.unit === "h") {
    bar = `${parsed.value}H`;
  } else {
    bar = parsed.value === 7 ? "1W" : `${parsed.value}D`;
  }

  if (!OKX_SUPPORTED_BARS.has(bar)) {
    throw new Error(
      `OKX 不支援 bar=${bar}（來自 ${timeframe}）。支援的時間框架：1m/3m/5m/15m/30m/1H/2H/4H/6H/12H/1D/2D/3D`
    );
  }
  return bar;
}

/** 取得 OKX 支援的時間框架清單（供前端下拉過濾） */
export function getOKXSupportedTimeframes(): string[] {
  return ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "2d", "3d", "7d"];
}

/**
 * 轉換為 Bybit API 的 interval 參數格式
 * Bybit：分鐘數字（1/3/5/15/30/60/120/240...）、D、W、M
 */
export function convertToBybitFormat(timeframe: string): string {
  const parsed = parseTimeframe(timeframe);
  if (parsed.unit === "m") {
    return String(parsed.value);
  }
  if (parsed.unit === "h") {
    return String(parsed.value * 60);
  }
  if (parsed.value === 1) return "D";
  if (parsed.value === 7) return "W";
  return String(parsed.value * 1440);
}

/** 取得時間框架的總秒數 */
export function getTimeframeSeconds(timeframe: string): number {
  return parseTimeframe(timeframe).totalSeconds;
}

/** 取得時間框架的總毫秒數 */
export function getTimeframeMilliseconds(timeframe: string): number {
  return parseTimeframe(timeframe).totalSeconds * 1000;
}

/** 驗證時間框架是否有效 */
export function isValidTimeframe(timeframe: string): boolean {
  try {
    parseTimeframe(timeframe);
    return true;
  } catch {
    return false;
  }
}

/** 支援的時間框架清單（供前端下拉使用） */
export function getSupportedTimeframes(): { minutes: number[]; hours: number[]; days: number[] } {
  return {
    minutes: [1, 3, 5, 15, 30, 45, 60, 90, 120],
    hours: [1, 2, 3, 4, 6, 8, 12],
    days: [1, 2, 3, 5, 7],
  };
}
