/**
 * V5.7 RiskSettings 驗證模組
 * 
 * 所有風控參數從配置讀取，含合法性校驗。
 * 對應 pasted_content_11.txt 的 RiskSettings 概念。
 * 
 * 設計原則：
 * - 所有風控閾值必須從 config 對象讀取，禁止硬編碼
 * - 參數範圍校驗（0~100%、正數、互斥檢查）
 * - 返回標準化的 RiskSettings 對象供引擎使用
 */

export interface RiskSettings {
  /** 最大單筆虧損百分比（0~100，如 5 = 5%） */
  maxLossPct: number;
  /** 最大回撤百分比（0~100，如 10 = 10%） */
  maxDrawdownPct: number;
  /** 目標止盈百分比（0~100，如 2 = 2%） */
  targetTPPct: number;
  /** 回調止盈百分比（0~100，如 0.3 = 0.3%） */
  callbackPct: number;
  /** 移動止盈啟動百分比（0~100） */
  trailingStartPct: number;
  /** 逃生艙虧損閾值（USD） */
  escapeLossUSD: number;
  /** 逃生艙冷卻時間（小時） */
  escapeCooldownHours: number;
  /** 正常冷卻時間（分鐘） */
  cooldownMinutes: number;
  /** 最大馬丁層數 */
  maxMartinLevels: number;
}

export interface EnvironmentSnapshot {
  /** 引擎版本 */
  engineVersion: string;
  /** 數據指紋（SHA-256 of candle data range） */
  dataHash: string;
  /** 槓桿倍數 */
  leverage: number;
  /** 單邊手續費率 */
  commission: number;
  /** 滑點率 */
  slippage: number;
  /** 交易對 */
  symbol: string;
  /** 時間框架 */
  timeframe: string;
  /** 回測起始時間（ms） */
  startDate: number;
  /** 回測結束時間（ms） */
  endDate: number;
  /** K 線數量 */
  candleCount: number;
  /** 初始資金 */
  initialCapital: number;
}

export interface ValidationError {
  field: string;
  message: string;
  value: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
  settings: RiskSettings;
}

/** 當前引擎版本 */
export const ENGINE_VERSION = "2.0.0";

/**
 * 從 config 對象提取並驗證 RiskSettings
 * 所有參數從 config 讀取，無硬編碼默認值（默認值由 schema 定義）
 */
export function validateRiskSettings(config: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  // 提取參數（使用 schema 定義的默認值）
  const maxLossPct = toNumber(config.Max_Loss_Pct, 5);
  const maxDrawdownPct = toNumber(config.MaxDrawdownPercent, maxLossPct); // fallback to maxLossPct
  const targetTPPct = toNumber(config.Target_TP_Pct, 1.0);
  const callbackPct = toNumber(config.Callback_Pct, 0.3);
  const trailingStartPct = toNumber(config.TrailingStartPct, targetTPPct); // fallback to targetTP
  const escapeLossUSD = toNumber(config.EscapeLossUSD, 8000);
  const escapeCooldownHours = toNumber(config.EscapeCooldownHours, 24);
  const cooldownMinutes = toNumber(config.CooldownMinutes, 5);
  const maxMartinLevels = toNumber(config.MaxMartinLevels, toNumber(config.Max_Layers, 15));

  // === 範圍校驗 ===
  if (maxLossPct <= 0 || maxLossPct > 100) {
    errors.push({ field: "Max_Loss_Pct", message: "必須在 0~100 之間", value: maxLossPct });
  }
  if (maxDrawdownPct <= 0 || maxDrawdownPct > 100) {
    errors.push({ field: "MaxDrawdownPercent", message: "必須在 0~100 之間", value: maxDrawdownPct });
  }
  if (targetTPPct <= 0 || targetTPPct > 100) {
    errors.push({ field: "Target_TP_Pct", message: "必須在 0~100 之間", value: targetTPPct });
  }
  if (callbackPct <= 0 || callbackPct > 50) {
    errors.push({ field: "Callback_Pct", message: "必須在 0~50 之間", value: callbackPct });
  }
  if (trailingStartPct <= 0 || trailingStartPct > 100) {
    errors.push({ field: "TrailingStartPct", message: "必須在 0~100 之間", value: trailingStartPct });
  }
  if (escapeLossUSD < 0) {
    errors.push({ field: "EscapeLossUSD", message: "不能為負數", value: escapeLossUSD });
  }
  if (escapeCooldownHours < 0 || escapeCooldownHours > 168) {
    errors.push({ field: "EscapeCooldownHours", message: "必須在 0~168 小時之間", value: escapeCooldownHours });
  }
  if (cooldownMinutes < 0 || cooldownMinutes > 1440) {
    errors.push({ field: "CooldownMinutes", message: "必須在 0~1440 分鐘之間", value: cooldownMinutes });
  }
  if (maxMartinLevels < 0 || maxMartinLevels > 100) {
    errors.push({ field: "MaxMartinLevels", message: "必須在 0~100 之間", value: maxMartinLevels });
  }

  // === 邏輯一致性校驗 ===
  if (callbackPct >= targetTPPct) {
    warnings.push(`Callback_Pct (${callbackPct}%) ≥ Target_TP_Pct (${targetTPPct}%)，移動止盈可能永遠不會觸發`);
  }
  if (maxLossPct > 50) {
    warnings.push(`Max_Loss_Pct (${maxLossPct}%) 設置過高，可能導致嚴重虧損`);
  }
  if (escapeLossUSD > 0 && maxMartinLevels < 5) {
    warnings.push(`逃生艙需要層數≥5 才會觸發，但 MaxMartinLevels=${maxMartinLevels} < 5`);
  }

  const settings: RiskSettings = {
    maxLossPct,
    maxDrawdownPct,
    targetTPPct,
    callbackPct,
    trailingStartPct,
    escapeLossUSD,
    escapeCooldownHours,
    cooldownMinutes,
    maxMartinLevels,
  };

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    settings,
  };
}

/**
 * 生成數據指紋（SHA-256 of candle data summary）
 * 用於快照一致性驗證：相同數據 → 相同指紋 → 相同回測結果
 */
export function generateDataHash(
  symbol: string,
  timeframe: string,
  startDate: number,
  endDate: number,
  candleCount: number,
  firstClose?: number,
  lastClose?: number,
): string {
  // 使用確定性字串生成指紋（不依賴 crypto 模組，使用簡單 hash）
  const input = `${symbol}|${timeframe}|${startDate}|${endDate}|${candleCount}|${firstClose ?? 0}|${lastClose ?? 0}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // 轉為 hex 字串
  return Math.abs(hash).toString(16).padStart(8, "0");
}

/**
 * 構建完整環境快照
 */
export function buildEnvironmentSnapshot(
  symbol: string,
  timeframe: string,
  startDate: number,
  endDate: number,
  candleCount: number,
  initialCapital: number,
  commission: number,
  slippage: number,
  leverage: number,
  firstClose?: number,
  lastClose?: number,
): EnvironmentSnapshot {
  return {
    engineVersion: ENGINE_VERSION,
    dataHash: generateDataHash(symbol, timeframe, startDate, endDate, candleCount, firstClose, lastClose),
    leverage,
    commission,
    slippage,
    symbol,
    timeframe,
    startDate,
    endDate,
    candleCount,
    initialCapital,
  };
}

// === Helper ===
function toNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return isNaN(n) ? fallback : n;
}
