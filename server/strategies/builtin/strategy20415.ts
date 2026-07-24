import {
  BaseStrategy,
  MarketData,
  MartinState,
  StrategyAction,
  StrategyInstanceConfig,
  StrategySignal,
} from "../base";

/**
 * EMA 均線回歸馬丁格爾（優化版）
 *
 * 核心邏輯：
 * 1. EMA3/EMA6 交叉判斷方向
 * 2. EMA15 為中心定義可買賣區域（±Buffer）
 * 3. 首單在區域內順勢開倉
 * 4. 逆勢時啟動馬丁加倉（動態間距 ATR），最多 12 層
 * 5. 出場：移動止盈（盤整/趨勢分別設定）+ 動態硬止損
 *
 * 模組：
 * A：動態止盈（EMA3-EMA6 差值區分盤整/趨勢）
 * B：動態加倉間距（ATR × pipstep_atr_multiplier，限幅 pipstep_min~pipstep_max）
 * D：EMA 斜率濾網（避免盤整假信號）
 * E：動態硬止損（持倉手數 × ATR × hard_stop_atr_multiplier，下限 hard_stop_max）
 */
export class Strategy20415 extends BaseStrategy {
  readonly key = "strategy_20415";
  readonly name = "EMA 均線回歸馬丁格爾（優化版）";
  readonly isBuiltIn = true;

  readonly defaultConfig = {
    // ===== EMA 指標參數 =====
    ema_killer: 3,       // Killer MA（最快線）
    ema_wave: 6,         // Wave MA（中線）
    ema_enter: 15,       // Enter MA（入場中心線）
    K_Line_Period: 30,   // K 線時間框架（分鐘）

    // ===== 緩衝區 =====
    buffer_points: 8000, // 緩衝區（點數），BTC 8000 = 80 USD（buffer_usd = buffer_points × Point_Value）
    Point_Value: 0.01,   // 每點價值（XAUUSD=0.01, BTC=0.01, EUR=0.0001）

    // ===== 資金與倉位 =====
    Base_Lot_Size: { value: 0.01, mode: "quantity" }, // 首單手數
    Initial_Capital: 10000,

    // ===== 馬丁加倉 =====
    multiplier: 1.5,       // 馬丁倍數
    max_layers: 12,        // 最大層數
    pip_step_base: 500.0,  // 基準加倉間距（USD）
    enable_dynamic_pip: true, // 動態間距開關

    // ===== 動態間距（ATR） =====
    atr_period: 14,               // ATR 週期
    pipstep_atr_multiplier: 0.15, // ATR 乘數
    pipstep_min: 200.0,           // 動態間距下限（USD）
    pipstep_max: 800.0,           // 動態間距上限（USD）

    // ===== 動態止盈（模組 A） =====
    tp_normal: 150.0,      // 止盈啟動（盤整）USD
    tp_trend: 250.0,       // 止盈啟動（趨勢）USD
    trail_normal: 25.0,    // 追蹤回撤（盤整）USD
    trail_trend: 30.0,     // 追蹤回撤（趨勢）USD
    trend_threshold: 50.0, // EMA3-EMA6 差值門檻（USD），超過視為趨勢

    // ===== EMA 斜率濾網（模組 D） =====
    slope_threshold: 3.0,  // EMA15 斜率門檻（USD/5根）

    // ===== 動態硬止損（模組 E） =====
    hard_stop_max: -1200.0,          // 硬止損上限（USD，負數）
    hard_stop_atr_multiplier: 0.6,   // 硬止損 ATR 乘數

    // ===== 循環再入場 =====
    Reentry_Enabled: true,
    Reentry_Cooldown_Bars: 1,

    // ===== 向後兼容 =====
    MagicNumber: 20415,
    OrderComment: "EMA_Martin",
  };

  /**
   * 計算 EMA（指數移動平均線）
   */
  private calcEMA(data: number[], period: number): number[] {
    if (data.length === 0) return [];
    const k = 2 / (period + 1);
    const ema: number[] = [data[0]];
    for (let i = 1; i < data.length; i++) {
      ema.push(data[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  }

  /**
   * 計算 ATR（平均真實波幅）
   */
  private calcATR(candles: { high: number; low: number; close: number }[], period: number): number {
    if (candles.length < 2) return 0;
    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
    }
    if (trueRanges.length === 0) return 0;
    // 使用 EMA 方式計算 ATR
    const k = 2 / (period + 1);
    let atr = trueRanges[0];
    for (let i = 1; i < trueRanges.length; i++) {
      atr = trueRanges[i] * k + atr * (1 - k);
    }
    return atr;
  }

  /**
   * 計算動態加倉間距（模組 B）
   * 公式：clamp(ATR × pipstep_atr_multiplier, pipstep_min, pipstep_max)
   * 若 enable_dynamic_pip=false，使用 pip_step_base
   */
  calculatePipStep(cfg: Record<string, any>, atr: number): number {
    const enableDynamic = cfg.enable_dynamic_pip === true || cfg.enable_dynamic_pip === "true";
    if (!enableDynamic || atr <= 0) {
      return Number(cfg.pip_step_base) || 500;
    }
    const atrMultiplier = Number(cfg.pipstep_atr_multiplier) || 0.15;
    const pipMin = Number(cfg.pipstep_min) || 200;
    const pipMax = Number(cfg.pipstep_max) || 800;
    const dynamicPip = atr * atrMultiplier;
    return Math.max(pipMin, Math.min(pipMax, dynamicPip));
  }

  /**
   * 計算動態硬止損（模組 E）
   * 公式：min(hard_stop_max, -(totalSize × ATR × hard_stop_atr_multiplier))
   * 返回負數（止損金額）
   */
  calculateHardStop(cfg: Record<string, any>, totalSize: number, atr: number): number {
    const hardStopMax = Number(cfg.hard_stop_max) || -1200;
    const atrMult = Number(cfg.hard_stop_atr_multiplier) || 0.6;
    if (atr <= 0 || totalSize <= 0) return hardStopMax;
    const dynamicStop = -(totalSize * atr * atrMult);
    // 取更嚴格的（更接近 0 的）
    return Math.max(hardStopMax, dynamicStop);
  }

  /**
   * 判斷是否為趨勢行情（模組 A）
   * EMA3 - EMA6 絕對差值 > trend_threshold → 趨勢
   */
  isTrending(emaKiller: number, emaWave: number, cfg: Record<string, any>): boolean {
    const threshold = Number(cfg.trend_threshold) || 50;
    return Math.abs(emaKiller - emaWave) > threshold;
  }

  /**
   * 獲取止盈參數（模組 A：盤整/趨勢分別設定）
   */
  getTpParams(isTrend: boolean, cfg: Record<string, any>): { tpTarget: number; trailAmount: number } {
    if (isTrend) {
      return {
        tpTarget: Number(cfg.tp_trend) || 250,
        trailAmount: Number(cfg.trail_trend) || 30,
      };
    }
    return {
      tpTarget: Number(cfg.tp_normal) || 150,
      trailAmount: Number(cfg.trail_normal) || 25,
    };
  }

  /**
   * EMA 斜率濾網（模組 D）
   * EMA15 近 5 根變化 >= slope_threshold → 有趨勢（允許開倉）
   */
  checkSlopeFilter(emaEnterValues: number[], cfg: Record<string, any>): boolean {
    const threshold = Number(cfg.slope_threshold) || 3.0;
    if (emaEnterValues.length < 6) return true; // 數據不足時放行
    const recent = emaEnterValues[emaEnterValues.length - 1];
    const fiveAgo = emaEnterValues[emaEnterValues.length - 6];
    return Math.abs(recent - fiveAgo) >= threshold;
  }

  /**
   * 計算首單倉位（支持 USDT/quantity 雙模式）
   */
  calculateLotSize(cfg: Record<string, any>, price: number): number {
    const baseLotRaw = cfg.Base_Lot_Size;
    let entryLot: number;

    if (baseLotRaw && typeof baseLotRaw === 'object' && 'value' in (baseLotRaw as any)) {
      const obj = baseLotRaw as unknown as { value: number; mode: string };
      if (obj.mode === 'usdt' && price > 0) {
        entryLot = obj.value / price;
      } else {
        entryLot = obj.value;
      }
    } else if (cfg.Position_Mode === 'usdt' && price > 0) {
      entryLot = (Number(cfg.Position_Value) || Number(baseLotRaw) || 0.01) / price;
    } else {
      entryLot = Number(baseLotRaw) || 0.01;
    }
    return Math.max(entryLot, 0.00001);
  }

  /**
   * 計算馬丁加倉倉位：base_lot × multiplier^layer
   */
  calculateMartinLot(baseLot: number, layer: number, cfg: Record<string, any>): number {
    const mult = Number(cfg.multiplier) || 1.5;
    const maxLayers = Number(cfg.max_layers) || 12;
    const level = Math.min(layer, Math.max(0, maxLayers - 1));
    const lot = baseLot * Math.pow(mult, level);
    return Math.round(lot * 1e8) / 1e8;
  }

  /**
   * 參數驗證（命令 6：參數自動比對）
   */
  validateConfig(userConfig: Record<string, any>): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const merged: Record<string, any> = { ...this.defaultConfig, ...userConfig };

    // 必要參數存在性
    const requiredKeys = ["Base_Lot_Size", "multiplier", "max_layers", "pip_step_base", "tp_normal", "tp_trend"];
    for (const key of requiredKeys) {
      if (merged[key] === undefined || merged[key] === null) {
        errors.push(`缺少必要參數: ${key}`);
      }
    }

    // 數值範圍
    const maxLayers = Number(merged.max_layers);
    if (maxLayers < 1 || maxLayers > 50) errors.push(`max_layers 必須在 1~50 之間（當前: ${maxLayers}）`);

    const mult = Number(merged.multiplier);
    if (mult < 1.0 || mult > 5.0) warnings.push(`multiplier=${mult} 超出常規範圍 [1.0, 5.0]`);

    const tpNormal = Number(merged.tp_normal);
    const trailNormal = Number(merged.trail_normal);
    if (trailNormal >= tpNormal) {
      warnings.push(`trail_normal(${trailNormal}) >= tp_normal(${tpNormal})，止盈可能無法觸發`);
    }

    const tpTrend = Number(merged.tp_trend);
    const trailTrend = Number(merged.trail_trend);
    if (trailTrend >= tpTrend) {
      warnings.push(`trail_trend(${trailTrend}) >= tp_trend(${tpTrend})，止盈可能無法觸發`);
    }

    const pipMin = Number(merged.pipstep_min);
    const pipMax = Number(merged.pipstep_max);
    if (pipMin >= pipMax) {
      errors.push(`pipstep_min(${pipMin}) >= pipstep_max(${pipMax})，動態間距無效`);
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * 核心決策方法
   *
   * 信號邏輯：
   * - 無持倉時：EMA 交叉 + 區域判斷 + 斜率濾網 → 開倉
   * - 有持倉時：硬止損 / 追蹤止盈 / 馬丁加倉 / HOLD
   */
  generateActions(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    martinState: MartinState,
  ): StrategyAction {
    const cfg = this.mergeConfig(instance);
    const price = signal.price || 0;

    // 計算首單倉位
    const baseLot = this.calculateLotSize(cfg, price);
    const maxLayers = Number(cfg.max_layers) || 12;
    const currentLayer = martinState.lossCount;

    // CLOSE 訊號：全平
    if (signal.action === "CLOSE") {
      return {
        action: "CLOSE_ALL",
        lotSize: 0,
        reason: "收到 CLOSE 訊號，全部平倉",
      };
    }

    // 加倉層數已滿
    if (currentLayer >= maxLayers) {
      return { action: "HOLD", lotSize: 0, reason: `已達最大層數 ${maxLayers}，等待止盈/止損` };
    }

    // 計算當前層的馬丁倉位
    const lotSize = this.calculateMartinLot(baseLot, currentLayer, cfg);

    if (signal.action === "BUY") {
      return {
        action: "OPEN_LONG",
        lotSize,
        reason: `EMA 做多訊號，馬丁層數 ${currentLayer}，倉位 ${lotSize.toFixed(6)}`,
      };
    }

    if (signal.action === "SELL") {
      return {
        action: "OPEN_SHORT",
        lotSize,
        reason: `EMA 做空訊號，馬丁層數 ${currentLayer}，倉位 ${lotSize.toFixed(6)}`,
      };
    }

    return { action: "HOLD", lotSize: 0, reason: "無法識別的訊號" };
  }
}
