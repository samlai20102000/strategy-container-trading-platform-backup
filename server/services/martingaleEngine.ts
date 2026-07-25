// server/services/martingaleEngine.ts
// 🔥 V4.0 全百分比控仓引擎 + V3.x 向後兼容 API

// ============================================================
// 類型定義
// ============================================================

export interface MartinLayer {
  start: number;
  end: number;
  multiplier: number;
  stepPct?: number; // V3.6 動態間距
}

export interface MartinLayerRule extends MartinLayer {} // Alias for backward compatibility

export interface StrategyState {
  currentLayer: number;
  totalSize: number;      // 总持仓数量（BTC）
  avgPrice: number;       // 综合持仓均价
  totalCost: number;      // 总成本（USDT）
  lastLayerPrice: number; // 最后一次加仓的价格
  capital: number;        // 剩余资金（USDT）
  highestPrice: number;
  isTrailingActivated: boolean;
  isCooldown: boolean;
  cooldownUntil: number;
  lowestPrice: number;
  isLong: boolean;
  lockedBarTimestamp: number;
  entryTrendBull?: boolean;
  hasTriggeredKamaReversal?: boolean;
  peakEquity?: number;  // 動態風控：權益峰值追踪（用於回撤止損計算）
  lastAddLayerTime?: number;  // Priority 1：最後一次加倉時間戳（用於反轉計時器）
  reverseBlockUntil?: number; // Priority 1：反轉封鎖截止時間（加倉後 3 根 K 線內不轉向）
  maxDrawdownPct?: number;  // 最大回撤百分比（用於驗證是否應該停止加倉）
}

export interface V4Config {
  Initial_Capital: number;
  First_Order_Pct: number;
  Max_Loss_Pct: number;
  Martin_Step_Pct: number;
  Martin_Layers: MartinLayer[];
  Max_Layers: number;
  Target_TP_Pct: number;
  Callback_Pct: number;
  K_Line_Period: number;
}

// ============================================================
// V3.x 向後兼容 API（O1 階梯式馬丁乘數）
// ============================================================

/**
 * O1：取得指定層的乘數
 * - 若 layers 為 null/空，回退使用 fallbackMultiplier
 * - 超出最後區間時沿用最後一層乘數
 */
export function getLayerMultiplier(
  layer: number,
  layers: MartinLayerRule[] | null | undefined,
  fallbackMultiplier: number = 1.5,
): number {
  if (!layers || layers.length === 0) return fallbackMultiplier;
  for (const rule of layers) {
    if (layer >= rule.start && layer <= rule.end) {
      return rule.multiplier;
    }
  }
  // 超出所有規則範圍，沿用最後一層乘數
  return layers[layers.length - 1].multiplier;
}

/**
 * O1：計算指定層的累乘倉位大小
 * layer=0 為首單（不乘），layer=1 為第一次加倉
 * 當有自定義 layers 時含 4.5x cap（防止單層過大）
 * 無 layers 時純累乘（baseLot × multiplier^layer）
 */
export function calculateLayerLot(
  baseLot: number,
  layer: number,
  layers?: MartinLayerRule[] | null,
  fallbackMultiplier: number = 1.5,
): number {
  if (layer <= 0) return baseLot;
  const hasCap = layers && layers.length > 0;
  const cap = hasCap ? baseLot * 4.5 : Infinity;
  let lot = baseLot;
  for (let i = 1; i <= layer; i++) {
    const mult = getLayerMultiplier(i, layers, fallbackMultiplier);
    lot = lot * mult;
    if (lot > cap) lot = cap;
  }
  return Math.round(lot * 1e8) / 1e8;
}

/**
 * O1：驗證 Martin_Layers 規則
 */
export function validateMartinLayers(
  layers: MartinLayerRule[] | null | undefined,
): { valid: boolean; reason?: string } {
  if (!layers || layers.length === 0) return { valid: true };

  for (const rule of layers) {
    if (rule.start < 1) return { valid: false, reason: "start 必須 >= 1" };
    if (rule.start > rule.end) return { valid: false, reason: "start 不可大於 end" };
    if (rule.multiplier <= 0) return { valid: false, reason: "multiplier 必須 > 0" };
  }

  // 檢查重疊
  for (let i = 0; i < layers.length; i++) {
    for (let j = i + 1; j < layers.length; j++) {
      if (layers[i].end >= layers[j].start && layers[j].end >= layers[i].start) {
        return { valid: false, reason: `區間重疊：[${layers[i].start}-${layers[i].end}] 與 [${layers[j].start}-${layers[j].end}]` };
      }
    }
  }

  return { valid: true };
}

/**
 * O1：解析 Martin_Layers（支援 JSON 字串與陣列）
 * 非法輸入回傳 null（空輸入、無效 JSON、結構無效、規則重疊）
 * 僅對非數組輸入拋出錯誤（類型安全）
 */
export function parseMartinLayers(input: any): MartinLayerRule[] | null {
  if (!input) return null;

  let arr: any[];
  if (typeof input === "string") {
    if (!input.trim()) return null;
    try {
      arr = JSON.parse(input);
    } catch {
      return null; // 無效 JSON 字串回傳 null
    }
  } else if (Array.isArray(input)) {
    arr = input;
  } else {
    return null;
  }

  if (!Array.isArray(arr) || arr.length === 0) return null;

  // 驗證每個元素
  const result: MartinLayerRule[] = [];
  for (const item of arr) {
    if (
      typeof item.start !== "number" ||
      typeof item.end !== "number" ||
      typeof item.multiplier !== "number"
    ) {
      return null; // 結構無效回傳 null
    }
    const rule: MartinLayerRule = {
      start: item.start,
      end: item.end,
      multiplier: item.multiplier,
    };
    // V3.6：保留 stepPct（0 視為 undefined）
    if (typeof item.stepPct === "number" && item.stepPct > 0) {
      rule.stepPct = item.stepPct;
    }
    result.push(rule);
  }

  // 驗證規則合法性
  const validation = validateMartinLayers(result);
  if (!validation.valid) return null; // 規則重疊或無效回傳 null

  return result;
}

/**
 * V3.6：取得指定層的動態間距
 */
export function getLayerStepPct(
  layer: number,
  layers: MartinLayerRule[] | null | undefined,
  globalStepPct: number,
): number {
  if (!layers || layers.length === 0) return globalStepPct;
  for (const rule of layers) {
    if (layer >= rule.start && layer <= rule.end) {
      if (rule.stepPct && rule.stepPct > 0) {
        return rule.stepPct;
      }
      return globalStepPct;
    }
  }
  return globalStepPct;
}

// ============================================================
// V3.x MartingaleEngine Class（完整向後兼容）
// ============================================================

interface MartinConfig {
  baseLot: number;
  multiplier?: number;
  stepPct: number;
  maxLayers: number;
  martinLayers?: MartinLayerRule[] | null;
}

export class MartingaleEngine {
  private config: MartinConfig;
  private state: StrategyState;

  constructor(config: MartinConfig, initialState?: Partial<StrategyState>) {
    this.config = {
      baseLot: config.baseLot,
      multiplier: config.multiplier ?? 1.5,
      stepPct: config.stepPct,
      maxLayers: config.maxLayers,
      martinLayers: config.martinLayers ?? null,
    };
    this.state = {
      currentLayer: 0,
      totalSize: 0,
      avgPrice: 0,
      totalCost: 0,
      lastLayerPrice: 0,
      capital: 0,
      highestPrice: 0,
      lowestPrice: 0,
      isLong: true,
      isTrailingActivated: false,
      isCooldown: false,
      cooldownUntil: 0,
      lockedBarTimestamp: 0,
      entryTrendBull: undefined,
      hasTriggeredKamaReversal: false,
      ...initialState,
    };
  }

  /**
   * 加倉：返回 lotSize 和新狀態
   */
  addLayer(price: number, isLong: boolean): { lotSize: number; newState: StrategyState } {
    if (this.state.currentLayer >= this.config.maxLayers) {
      throw new Error(`已達最大層數 ${this.config.maxLayers}`);
    }

    const nextLayer = this.state.currentLayer + 1;
    // 馬丁層 = currentLayer（首單 currentLayer=0 → 馬丁層 0 → baseLot 不乘）
    const martinLayer = this.state.currentLayer; // 第一次 addLayer: martinLayer=0
    const lotSize = calculateLayerLot(
      this.config.baseLot,
      martinLayer,
      this.config.martinLayers,
      this.config.multiplier,
    );

    const cost = lotSize * price;
    const newTotalCost = this.state.totalCost + cost;
    // 浮點精度修正：避免 0.0015 + 0.0015 + 0.0015 = 0.0045000000000000005
    const newTotalSize = parseFloat((this.state.totalSize + lotSize).toPrecision(12));
    const newAvgPrice = newTotalCost / newTotalSize;

    this.state = {
      ...this.state,
      currentLayer: nextLayer,
      totalSize: newTotalSize,
      avgPrice: newAvgPrice,
      totalCost: newTotalCost,
      lastLayerPrice: price,
      isLong,
    };

    return { lotSize, newState: { ...this.state } };
  }

  /**
   * 判斷是否應加倉
   */
  shouldAddLayer(currentPrice: number, isLong: boolean): boolean {
    if (this.state.currentLayer >= this.config.maxLayers) return false;
    if (this.state.totalSize === 0 || this.state.avgPrice === 0) return false;

    // V3.6：使用動態間距
    const nextMartinLayer = this.state.currentLayer; // 下一層的馬丁層 index
    const stepPct = getLayerStepPct(
      nextMartinLayer,
      this.config.martinLayers,
      this.config.stepPct,
    );

    if (isLong) {
      const deviation = ((this.state.avgPrice - currentPrice) / this.state.avgPrice) * 100;
      return deviation >= stepPct;
    } else {
      const deviation = ((currentPrice - this.state.avgPrice) / this.state.avgPrice) * 100;
      return deviation >= stepPct;
    }
  }

  /**
   * 重置狀態（保留冷卻資訊）
   */
  reset(): StrategyState {
    this.state = {
      ...this.state,
      currentLayer: 0,
      totalSize: 0,
      avgPrice: 0,
      totalCost: 0,
      lastLayerPrice: 0,
      highestPrice: 0,
      lowestPrice: 0,
      isTrailingActivated: false,
      entryTrendBull: undefined,
      hasTriggeredKamaReversal: false,
    };
    return { ...this.state };
  }

  /**
   * 取得當前狀態
   */
  getState(): StrategyState {
    return { ...this.state };
  }

  /**
   * 靜態方法：計算指定層的倉位大小（前端預覽用）
   * 公式：baseLot × multiplier^(layer-1)
   * layer=1 為首單，layer=2 為第一次加倉
   */
  static calcLayerLot(
    baseLot: number,
    multiplier: number,
    layer: number,
    martinLayers?: MartinLayerRule[] | null,
  ): number {
    if (layer <= 1) return baseLot;
    // layer 在這裡是「第幾層」（1-based），馬丁乘數從 layer-1 開始
    const martinLayer = layer - 1;
    return calculateLayerLot(baseLot, martinLayer, martinLayers, multiplier);
  }

  /**
   * 靜態方法：生成完整倉位預覽表（V3.x 舊簽名）
   */
  static previewLayers(
    baseLotOrConfig: number | V4Config,
    multiplierOrUndefined?: number,
    maxLayersOrUndefined?: number,
    entryPriceOrUndefined?: number,
  ): any[] {
    // V4.0 新簽名：previewLayers(config: V4Config)
    if (typeof baseLotOrConfig === "object") {
      return getLayerMultipliers(baseLotOrConfig);
    }

    // V3.x 舊簽名：previewLayers(baseLot, multiplier, maxLayers, entryPrice)
    const baseLot = baseLotOrConfig;
    const multiplier = multiplierOrUndefined ?? 1.5;
    const maxLayers = maxLayersOrUndefined ?? 5;
    const entryPrice = entryPriceOrUndefined ?? 50000;

    const rows: { layer: number; lotSize: number; cost: number; cumulativeSize: number; cumulativeCost: number; avgPrice: number }[] = [];
    let cumulativeSize = 0;
    let cumulativeCost = 0;

    for (let i = 1; i <= maxLayers; i++) {
      const lotSize = MartingaleEngine.calcLayerLot(baseLot, multiplier, i);
      const price = entryPrice * (1 - (i - 1) * 0.015); // 假設每層下跌 1.5%
      const cost = lotSize * price;
      cumulativeSize += lotSize;
      cumulativeCost += cost;
      rows.push({
        layer: i,
        lotSize,
        cost,
        cumulativeSize,
        cumulativeCost,
        avgPrice: cumulativeCost / cumulativeSize,
      });
    }
    return rows;
  }
}

// ============================================================
// 🔥 V4.0 百分比控仓函數
// ============================================================

/**
 * 🔥 V4.0：获取首单金额（USDT）
 */
export function getFirstOrderValue(config: V4Config): number {
  return config.Initial_Capital * (config.First_Order_Pct / 100);
}

/**
 * 🔥 V4.0：获取极限止损触发金额（USDT）
 */
export function getMaxLossAmount(config: V4Config): number {
  return config.Initial_Capital * (config.Max_Loss_Pct / 100);
}

/**
 * 🔥 V4.0：计算指定层数的仓位价值（USDT）
 */
export function getLayerValue(layer: number, config: V4Config): number {
  const firstOrder = getFirstOrderValue(config);
  let value = firstOrder;

  for (let i = 1; i <= layer; i++) {
    let multiplier = 1.0;
    for (const rule of config.Martin_Layers) {
      if (i >= rule.start && i <= rule.end) {
        multiplier = rule.multiplier;
        break;
      }
    }
    value *= multiplier;
  }
  return value;
}

/**
 * 🔥 V4.0：获取指定层数的仓位数量（BTC）
 */
export function getLayerSize(layer: number, currentPrice: number, config: V4Config): number {
  const value = getLayerValue(layer, config);
  return value / currentPrice;
}

/**
 * 🔥 V4.0：获取各层乘数（用于显示）
 */
export function getLayerMultipliers(config: V4Config, entryPrice: number = 1): {
  layer: number;
  multiplier: number;
  cumulativeX: number;
  estimatedCost: number;
  avgPrice: number;
  triggerPrice: number;
  lotSize: number;
}[] {
  const result: {
    layer: number;
    multiplier: number;
    cumulativeX: number;
    estimatedCost: number;
    avgPrice: number;
    triggerPrice: number;
    lotSize: number;
  }[] = [];

  const firstOrderValue = getFirstOrderValue(config);
  let currentLayerValue = firstOrderValue;
  let prevTriggerPrice = entryPrice;
  let cumulativeValue = 0;
  let cumulativeSize = 0;

  for (let i = 1; i <= config.Max_Layers; i++) {
    let multiplier = 1.0;
    for (const rule of config.Martin_Layers) {
      if (i >= rule.start && i <= rule.end) {
        multiplier = rule.multiplier;
        break;
      }
    }
    currentLayerValue *= multiplier;
    const cumulativeMultiplier = currentLayerValue / firstOrderValue;

    const currentTriggerPrice = (i === 1)
      ? entryPrice
      : prevTriggerPrice * (1 - (config.Martin_Step_Pct / 100));
    prevTriggerPrice = currentTriggerPrice;

    const currentLotSize = currentLayerValue / currentTriggerPrice;
    cumulativeSize += currentLotSize;
    cumulativeValue += currentLayerValue;

    const avgPrice = cumulativeSize === 0 ? entryPrice : cumulativeValue / cumulativeSize;

    result.push({
      layer: i,
      multiplier,
      cumulativeX: cumulativeMultiplier,
      estimatedCost: cumulativeValue,
      avgPrice,
      triggerPrice: currentTriggerPrice,
      lotSize: currentLotSize,
    });
  }
  return result;
}

/**
 * 🔥 V4.0：获取加仓间距
 */
export function getStepPct(config: V4Config): number {
  return config.Martin_Step_Pct;
}

/**
 * 🔥 V4.0：检查是否应触发下一层加仓
 * 支持分層專屬間距：優先使用 Martin_Layers 中各層的 stepPct，否則回退全局 Martin_Step_Pct
 * 🔥 修復：支持 Long/Short 雙向偏離計算
 *   - Long（做多）：價格下跌 = 虧損方向 → deviation = (avgPrice - currentPrice) / avgPrice
 *   - Short（做空）：價格上漲 = 虧損方向 → deviation = (currentPrice - avgPrice) / avgPrice
 */
export function shouldAddLayer(
  state: StrategyState,
  currentPrice: number,
  config: V4Config,
  leverage?: number,
): { shouldAdd: boolean; stepPctUsed: number; nextLayer: number; leveragedDeviation?: number } {
  const nextLayer = state.currentLayer + 1;
  const lev = leverage && leverage > 0 ? leverage : 1;

  if (nextLayer > config.Max_Layers) {
    return { shouldAdd: false, stepPctUsed: 0, nextLayer };
  }

  // 使用分層專屬間距（優先）或全局間距
  const globalStepPct = getStepPct(config);
  const stepPct = getLayerStepPct(nextLayer, config.Martin_Layers, globalStepPct);

  if (state.avgPrice <= 0 || state.totalSize === 0) {
    return { shouldAdd: false, stepPctUsed: stepPct, nextLayer };
  }

  // 🔥 偏離% 基於價格變動（不乘槓桿）—— 加倉是為了攤平成本，應基於價格偏離而非保證金盈虧
  // 基準價優先級：lastLayerPrice > avgPrice（確保每層加倉都是從上一層價格偏離 stepPct%）
  const isLong = state.isLong;
  const basePrice = (state.lastLayerPrice && state.lastLayerPrice > 0) ? state.lastLayerPrice : state.avgPrice;
  const deviation = isLong
    ? ((basePrice - currentPrice) / basePrice) * 100
    : ((currentPrice - basePrice) / basePrice) * 100;

  return {
    shouldAdd: deviation >= stepPct,
    stepPctUsed: stepPct,
    nextLayer,
    leveragedDeviation: deviation * lev, // 僅供前端顯示用（保證金%）
  };
}

/**
 * 🔥 V4.0：计算总浮亏（USDT）
 * 🔥 修復：方向感知，做空時價格上漲 = 虧損
 */
export function calculateUnrealizedLoss(state: StrategyState, currentPrice: number): number {
  if (
    !Number.isFinite(state.totalSize) ||
    state.totalSize <= 0 ||
    !Number.isFinite(state.avgPrice) ||
    state.avgPrice <= 0 ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) return 0;
  if (state.isLong) {
    // 做多：價格下跌 = 虧損（正值）
    return (state.avgPrice - currentPrice) * state.totalSize;
  } else {
    // 做空：價格上漲 = 虧損（正值）
    return (currentPrice - state.avgPrice) * state.totalSize;
  }
}

/**
 * 🔥 V4.0：计算总浮亏率（%）
 */
export function calculateUnrealizedLossPct(state: StrategyState, currentPrice: number, config: V4Config): number {
  if (!Number.isFinite(config.Initial_Capital) || config.Initial_Capital <= 0) return 0;
  const loss = calculateUnrealizedLoss(state, currentPrice);
  const lossPct = (loss / config.Initial_Capital) * 100;
  return Number.isFinite(lossPct) ? lossPct : 0;
}

/**
 * 🔥 V4.0：检查是否触发极限止损（百分比版）
 */
export function shouldTriggerLimitStop(
  state: StrategyState,
  currentPrice: number,
  config: V4Config,
): { triggered: boolean; reason: string } {
  if (!Number.isFinite(state.totalSize) || state.totalSize <= 0) {
    return { triggered: false, reason: '無有效持倉' };
  }

  const maxLossPct = Number(config.Max_Loss_Pct);
  if (!Number.isFinite(maxLossPct) || maxLossPct <= 0) {
    return { triggered: false, reason: '硬止損未啟用或閾值無效（Max_Loss_Pct ≤ 0）' };
  }

  if (!Number.isFinite(config.Initial_Capital) || config.Initial_Capital <= 0) {
    return { triggered: false, reason: '硬止損配置無效（Initial_Capital ≤ 0）' };
  }

  if (
    !Number.isFinite(state.avgPrice) ||
    state.avgPrice <= 0 ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return { triggered: false, reason: '價格資料無效，拒絕觸發硬止損' };
  }

  const loss = calculateUnrealizedLoss(state, currentPrice);
  const lossPct = (loss / config.Initial_Capital) * 100;

  if (!Number.isFinite(lossPct) || lossPct <= 0) {
    return { triggered: false, reason: '未觸發（無浮虧）' };
  }

  if (lossPct >= maxLossPct) {
    return {
      triggered: true,
      reason: `總浮虧 ${lossPct.toFixed(2)}% ≥ ${maxLossPct}%`,
    };
  }

  return { triggered: false, reason: '未觸發' };
}
