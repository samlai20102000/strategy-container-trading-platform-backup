/**
 * V5.5 STRATEGIES_DYNAMIC_SCHEMA
 * 用於策略管理「新增/編輯策略」彈窗中的 DynamicForm
 * 根據 strategyKey 動態選擇 V35 或 EMA 馬丁 schema
 */
import type { SchemaConfig, FieldSchema } from "@/components/DynamicForm";

/** V3.5/V4.5 策略 schema（KAMA 3K 等） */
export const STRATEGIES_DYNAMIC_SCHEMA: SchemaConfig = {
  groups: [
    { name: "資金與風控", fields: ["Initial_Capital", "First_Order_Pct", "Max_Loss_Pct", "Max_Drawdown_Pct", "Max_Deviation_Pct"] },
    { name: "馬丁設定", fields: ["martin_mode", "Martin_Step_Pct", "Martin_Multiplier", "Max_Layers", "martinLayersJson"] },
    { name: "止盈設定", fields: ["Target_TP_Pct", "Callback_Pct", "K_Line_Period", "Reentry_On_Trend", "Max_Loss_USDT"] },
  ],
  advancedFields: ["max_single_position_pct", "stop_loss_pct", "daily_loss_limit"],
  fields: [
    // ---- 資金與風控 ----
    { key: "Initial_Capital", type: "number", label: "初始本金 (USDT)", default: 10000, min: 100, step: 100, description: "策略專屬本金，所有百分比參數以此為基準" },
    { key: "First_Order_Pct", type: "number", label: "首單佔本金 (%)", default: 0.3, min: 0.1, max: 5, step: 0.1, description: "首單開倉價值佔本金百分比（建議 0.3-1.0%）" },
    { key: "Max_Loss_Pct", type: "number", label: "極限止損 (%)", default: 5, min: 1, max: 20, step: 0.5, description: "總浮虧達本金此 % 時強制全線平倉" },
    { key: "Max_Drawdown_Pct", type: "number", label: "回撒保護 (%)", default: 10, min: 5, max: 50, step: 1, description: "整體權益曲線回撒率，介於極限止損条件 A（預設 10%）" },
    { key: "Max_Deviation_Pct", type: "number", label: "最後層偏離 (%)", default: 3, min: 0.5, max: 30, step: 0.5, description: "馬丁滿層後，最後一層價格偏離此百分比即觸發極限止損（預設 3%）" },
    // ---- 馬丁設定 ----
    { key: "martin_mode", type: "select", label: "馬丁模式", default: "fixed", options: [{ label: "固定乘數", value: "fixed" }, { label: "階梯式分層", value: "layered" }], description: "固定乘數：每層統一倍率；階梯式分層：自定義各層乘數" },
    { key: "Martin_Step_Pct", type: "number", label: "加倉間距 (%)", default: 2.0, min: 0.01, step: 0.01, description: "每層觸發偏離百分比（無上下限）" },
    { key: "Martin_Multiplier", type: "number", label: "馬丁倍率", default: 1.5, min: 1.0, max: 5, step: 0.1, condition: { field: "martin_mode", operator: "eq", value: "fixed" }, description: "固定模式下每層統一乘數" },
    { key: "Max_Layers", type: "number", label: "最大層數", default: 11, min: 1, step: 1, description: "階梯式分層時由分層設定自動決定，無上限" },
    { key: "martinLayersJson", type: "martinLayers", label: "階梯式馬丁分層設定", condition: { field: "martin_mode", operator: "eq", value: "layered" }, description: "自定義各層乘數和間距" },
    // ---- 止盈設定 ----
    { key: "Target_TP_Pct", type: "number", label: "止盈觸發 (%)", default: 1.0, min: 0.1, max: 10, step: 0.1, description: "浮盈達此 % 啟動移動止盈" },
    { key: "Callback_Pct", type: "number", label: "回撤平倉 (%)", default: 0.1, min: 0.01, max: 5, step: 0.01, description: "從峰值回撤此 % 即平倉" },
    { key: "K_Line_Period", type: "number", label: "K 線週期 (分鐘)", default: 30, min: 1, max: 1440, step: 1, description: "策略監控的 K 線週期" },
    { key: "Reentry_On_Trend", type: "boolean", label: "第 0 層順勢重入", default: true, description: "止盈後趨勢未變則立即重入" },
    { key: "Max_Loss_USDT", type: "number", label: "絕對金額限損 (USDT)", default: 15, min: 0, step: 1, description: "浮虧達此金額強制平倉（0=不啟用，建議設為初始本金×10%）" },
    // ---- 進階設定（預設隱藏） ----
    { key: "max_single_position_pct", type: "number", label: "最大單筆倉位 (%)", default: 0, min: 0, max: 100, advanced: true, description: "0 = 不限制" },
    { key: "stop_loss_pct", type: "number", label: "止損 (%)", default: 0, min: 0, advanced: true, description: "0 = 不啟用" },
    { key: "daily_loss_limit", type: "number", label: "每日最大虧損 (USDT)", default: 0, min: 0, advanced: true, description: "0 = 不限制" },
  ],
};

/** EMA 均線回歸馬丁格爾（優化版）schema */
export const STRATEGIES_V20_SCHEMA: SchemaConfig = {
  groups: [
    { name: "EMA 指標參數", fields: ["ema_killer", "ema_wave", "ema_enter", "K_Line_Period"] },
    { name: "緩衝區與入場", fields: ["buffer_points", "Point_Value", "slope_threshold"] },
    { name: "資金與倉位", fields: ["Base_Lot_Size", "Initial_Capital"] },
    { name: "馬丁加倉", fields: ["multiplier", "max_layers", "pip_step_base", "enable_dynamic_pip"] },
    { name: "動態間距（ATR）", fields: ["atr_period", "pipstep_atr_multiplier", "pipstep_min", "pipstep_max"] },
    { name: "動態止盈（模組 A）", fields: ["tp_normal", "tp_trend", "trail_normal", "trail_trend", "trend_threshold"] },
    { name: "動態硬止損（模組 E）", fields: ["hard_stop_max", "hard_stop_atr_multiplier"] },
  ],
  advancedFields: [],
  fields: [
    // ---- EMA 指標參數 ----
    { key: "ema_killer", type: "number", label: "Killer EMA 週期", default: 3, min: 1, max: 100, step: 1, description: "Killer 快線（預設 3），交叉判斷方向" },
    { key: "ema_wave", type: "number", label: "Wave EMA 週期", default: 6, min: 2, max: 100, step: 1, description: "Wave 中線（預設 6），交叉判斷方向" },
    { key: "ema_enter", type: "number", label: "Enter EMA 週期", default: 15, min: 3, max: 200, step: 1, description: "Enter 入場中心線（預設 15），定義可買賣區域" },
    { key: "K_Line_Period", type: "number", label: "K 線時間框架 (分鐘)", default: 30, min: 1, max: 1440, step: 1, description: "策略監控的 K 線時間框架" },
    // ---- 緩衝區與入場 ----
    { key: "buffer_points", type: "number", label: "緩衝區 (點數)", default: 8000, min: 10, max: 100000, step: 100, description: "EMA15 ±Buffer 定義可買賣區域（BTC 8000 = 80 USD）" },
    { key: "Point_Value", type: "number", label: "每點價值 (USD)", default: 0.01, min: 0.0001, max: 100, step: 0.0001, description: "每 1 點對應的價格變動（BTC=0.01, XAUUSD=0.01）" },
    { key: "slope_threshold", type: "number", label: "EMA 斜率門檻 (USD/5根)", default: 3.0, min: 0, max: 100, step: 0.1, description: "EMA15 近 5 根變化 >= 此值才允許開倉（模組 D 濾網）" },
    // ---- 資金與倉位 ----
    { key: "Base_Lot_Size", type: "number", label: "首單倉位", default: 0.01, min: 0.001, max: 100000, step: 0.001, description: "首單手數（entry_lot），配合 positionMode 使用" },
    { key: "Initial_Capital", type: "number", label: "初始本金 (USDT)", default: 10000, min: 100, step: 100, description: "策略專屬本金" },
    // ---- 馬丁加倉 ----
    { key: "multiplier", type: "number", label: "馬丁倍數", default: 1.5, min: 1.0, max: 5.0, step: 0.1, description: "每層加倉倍率（lot = base × mult^layer）" },
    { key: "max_layers", type: "number", label: "最大層數", default: 12, min: 1, max: 50, step: 1, description: "馬丁最大加倉層數" },
    { key: "pip_step_base", type: "number", label: "基準加倉間距 (USD)", default: 500, min: 10, max: 10000, step: 10, description: "動態間距關閉時使用此固定值" },
    { key: "enable_dynamic_pip", type: "boolean", label: "啟用動態間距", default: true, description: "開啟後使用 ATR 計算動態加倉間距" },
    // ---- 動態間距（ATR） ----
    { key: "atr_period", type: "number", label: "ATR 週期", default: 14, min: 5, max: 50, step: 1, description: "ATR 計算週期（根數）" },
    { key: "pipstep_atr_multiplier", type: "number", label: "ATR 乘數", default: 0.15, min: 0.01, max: 1.0, step: 0.01, description: "動態間距 = ATR × 此乘數" },
    { key: "pipstep_min", type: "number", label: "動態間距下限 (USD)", default: 200, min: 10, max: 5000, step: 10, description: "動態間距不低於此值" },
    { key: "pipstep_max", type: "number", label: "動態間距上限 (USD)", default: 800, min: 50, max: 10000, step: 10, description: "動態間距不超過此值" },
    // ---- 動態止盈（模組 A） ----
    { key: "tp_normal", type: "number", label: "止盈啟動 - 盤整 (USD)", default: 150, min: 1, max: 10000, step: 1, description: "盤整行情下浮盈達此金額啟動追蹤止盈" },
    { key: "tp_trend", type: "number", label: "止盈啟動 - 趨勢 (USD)", default: 250, min: 1, max: 10000, step: 1, description: "趨勢行情下浮盈達此金額啟動追蹤止盈" },
    { key: "trail_normal", type: "number", label: "追蹤回撤 - 盤整 (USD)", default: 25, min: 0.1, max: 1000, step: 0.1, description: "盤整行情下從峰值回撤此金額即平倉" },
    { key: "trail_trend", type: "number", label: "追蹤回撤 - 趨勢 (USD)", default: 30, min: 0.1, max: 1000, step: 0.1, description: "趨勢行情下從峰值回撤此金額即平倉" },
    { key: "trend_threshold", type: "number", label: "趨勢判定門檻 (USD)", default: 50, min: 1, max: 500, step: 1, description: "EMA3-EMA6 絕對差值 > 此值視為趨勢行情" },
    // ---- 動態硬止損（模組 E） ----
    { key: "hard_stop_max", type: "number", label: "硬止損上限 (USD)", default: -1200, min: -100000, max: 0, step: 10, description: "最大虧損金額（負數），超過此值強制全平" },
    { key: "hard_stop_atr_multiplier", type: "number", label: "硬止損 ATR 乘數", default: 0.6, min: 0.1, max: 3.0, step: 0.1, description: "動態硬止損 = -(持倉手數 × ATR × 此乘數)" },
  ],
};

/** V5.0 KAMA+3K 極致優化馬丁策略 schema */
export const STRATEGIES_V50_SCHEMA: SchemaConfig = {
  groups: [
    { name: "資金與風控", fields: ["Initial_Capital", "Base_Lot_Size", "First_Order_Pct", "Max_Loss_Pct", "Max_Drawdown_Pct"] },
    { name: "KAMA 指標", fields: ["KAMA_Fast_Length", "p2_fastest", "p3_slowest", "KAMA_Slow_Length", "q2_fastest", "q3_slowest"] },
    { name: "馬丁設定", fields: ["martin_mode", "Martin_Step_Pct", "Martin_Multiplier", "Max_Layers", "martinLayersJson"] },
    { name: "止盈設定", fields: ["Target_TP_Pct", "Callback_Pct", "K_Line_Period", "Reentry_On_Trend", "Max_Loss_USDT"] },
    { name: "F1 市場制度切換", fields: ["enable_regime_switch", "adx_period", "atr_period", "adx_strong_threshold", "adx_weak_threshold"] },
    { name: "F2 部分獲利", fields: ["enable_partial_tp", "partial_tp_layer_4", "partial_tp_layer_6", "partial_tp_layer_8", "partial_tp_trigger_pct"] },
    { name: "F3 ATR 動態止盈", fields: ["enable_dynamic_tp", "tp_min_pct", "tp_atr_multiplier"] },
    { name: "F4 時間濾網", fields: ["enable_time_filter", "allowed_start_hour", "allowed_end_hour"] },
    { name: "F5 波動率倉位", fields: ["enable_vol_position", "target_vol_pct", "vol_min_scale", "vol_max_scale"] },
    { name: "F6 AI 輔助過濾", fields: ["enable_ai_filter", "kama_slope_lookback", "kama_slope_min", "volume_ma_period", "volume_expansion_threshold"] },
  ],
  advancedFields: ["max_single_position_pct", "stop_loss_pct", "daily_loss_limit"],
  fields: [
    // 資金與風控
    { key: "Initial_Capital", type: "number", label: "初始本金 (USDT)", default: 10000, min: 100, step: 100, description: "策略專屬本金" },
    { key: "Base_Lot_Size", type: "number", label: "首單金額 (USDT)", default: 30, min: 1, max: 100000, step: 1, description: "固定金本位首單金額" },
    { key: "First_Order_Pct", type: "number", label: "首單佔本金 (%)", default: 0.3, min: 0.01, max: 10, step: 0.01, description: "回退用：首單佔本金百分比" },
    { key: "Max_Loss_Pct", type: "number", label: "硬止損 (%)", default: 6, min: 1, max: 50, step: 0.5, description: "總浮虧佔本金比例觸發硬止損" },
    { key: "Max_Drawdown_Pct", type: "number", label: "極限止損 (%)", default: 10, min: 5, max: 50, step: 1, description: "極限防爆倉止損" },
    // KAMA 指標
    { key: "KAMA_Fast_Length", type: "number", label: "KAMA 快線長度", default: 30, min: 5, max: 200, step: 1, description: "V5.0 優化預設 30" },
    { key: "p2_fastest", type: "number", label: "快線 fastest", default: 8, min: 2, max: 50, step: 1 },
    { key: "p3_slowest", type: "number", label: "快線 slowest", default: 2, min: 2, max: 50, step: 1 },
    { key: "KAMA_Slow_Length", type: "number", label: "KAMA 慢線長度", default: 55, min: 5, max: 200, step: 1, description: "V5.0 優化預設 55" },
    { key: "q2_fastest", type: "number", label: "慢線 fastest", default: 10, min: 2, max: 50, step: 1 },
    { key: "q3_slowest", type: "number", label: "慢線 slowest", default: 8, min: 2, max: 50, step: 1, description: "V5.0 優化預設 8" },
    // 馬丁設定
    { key: "martin_mode", type: "select", label: "馬丁模式", default: "layered", options: [{ label: "固定乘數", value: "fixed" }, { label: "階梯式分層", value: "layered" }], description: "V5.0 預設階梯式分層" },
    { key: "Martin_Step_Pct", type: "number", label: "加倉間距 (%)", default: 2.0, min: 0.01, step: 0.01, description: "每層觸發偏離百分比（無上下限）" },
    { key: "Martin_Multiplier", type: "number", label: "馬丁倍率", default: 1.5, min: 1.0, max: 5, step: 0.1, condition: { field: "martin_mode", operator: "eq", value: "fixed" }, description: "固定模式下每層統一乘數" },
    { key: "Max_Layers", type: "number", label: "最大層數", default: 13, min: 1, step: 1, description: "無上限，由用戶自由設定" },
    { key: "martinLayersJson", type: "martinLayers", label: "階梯式馬丁分層設定", condition: { field: "martin_mode", operator: "eq", value: "layered" }, description: "自定義各層乘數和間距" },
    // 止盈設定
    { key: "Target_TP_Pct", type: "number", label: "止盈觸發 (%)", default: 1.0, min: 0.1, max: 50, step: 0.1, description: "浮盈達此 % 啟動移動止盈" },
    { key: "Callback_Pct", type: "number", label: "回撤平倉 (%)", default: 0.1, min: 0.01, max: 5, step: 0.01, description: "從峰值回撤此 % 即平倉" },
    { key: "K_Line_Period", type: "number", label: "K 線週期 (分鐘)", default: 15, min: 1, max: 1440, step: 1, description: "策略監控的 K 線週期" },
    { key: "Reentry_On_Trend", type: "boolean", label: "順勢重入", default: true, description: "平倉後 KAMA 方向一致時立即重入" },
    { key: "Max_Loss_USDT", type: "number", label: "絕對金額限損 (USDT)", default: 0, min: 0, step: 1, description: "0=不啟用，浮虧達此金額強制平倉" },
    // F1 市場制度切換
    { key: "enable_regime_switch", type: "boolean", label: "啟用市場制度切換", default: true, description: "ADX 驅動動態馬丁參數（強趨勢減層/盤整加層）" },
    { key: "adx_period", type: "number", label: "ADX 週期", default: 14, min: 5, max: 50, step: 1, description: "ADX 指標計算週期" },
    { key: "atr_period", type: "number", label: "ATR 週期", default: 14, min: 5, max: 50, step: 1, description: "ATR 指標計算週期" },
    { key: "adx_strong_threshold", type: "number", label: "ADX 強趨勢閾值", default: 30, min: 15, max: 50, step: 1, description: "ADX ≥ 此值 = 強趨勢（減層、加寬間距）" },
    { key: "adx_weak_threshold", type: "number", label: "ADX 弱趨勢閾值", default: 20, min: 10, max: 40, step: 1, description: "ADX ≥ 此值 = 弱趨勢" },
    // F2 部分獲利
    { key: "enable_partial_tp", type: "boolean", label: "啟用部分獲利", default: true, description: "層數≥ 4/6/8 時分批平倉降低風險" },
    { key: "partial_tp_layer_4", type: "number", label: "≥ 4 層平倉比例", default: 0.3, min: 0.05, max: 0.8, step: 0.05, description: "第 4 層觸發時平倉 30%" },
    { key: "partial_tp_layer_6", type: "number", label: "≥ 6 層平倉比例", default: 0.3, min: 0.05, max: 0.8, step: 0.05, description: "第 6 層觸發時平倉 30%" },
    { key: "partial_tp_layer_8", type: "number", label: "≥ 8 層平倉比例", default: 0.2, min: 0.05, max: 0.8, step: 0.05, description: "第 8 層觸發時平倉 20%" },
    { key: "partial_tp_trigger_pct", type: "number", label: "觸發盈利 (%)", default: 0.5, min: 0.1, max: 5, step: 0.1, description: "浮盈達此值才觸發部分平倉" },
    // F3 ATR 動態止盈
    { key: "enable_dynamic_tp", type: "boolean", label: "啟用 ATR 動態止盈", default: true, description: "TP = MAX(tp_min, ATR/price × multiplier)" },
    { key: "tp_min_pct", type: "number", label: "最低止盈 (%)", default: 0.8, min: 0.1, max: 10, step: 0.1, description: "動態止盈下限" },
    { key: "tp_atr_multiplier", type: "number", label: "ATR 止盈乘數", default: 2.5, min: 0.5, max: 10, step: 0.1, description: "ATR 乘數越大止盈越寬" },
    // F4 時間濾網
    { key: "enable_time_filter", type: "boolean", label: "啟用時間濾網", default: true, description: "僅在指定 UTC 時段開新倉" },
    { key: "allowed_start_hour", type: "number", label: "開始時 (UTC)", default: 12, min: 0, max: 23, step: 1, description: "允許開倉開始時間 (UTC)" },
    { key: "allowed_end_hour", type: "number", label: "結束時 (UTC)", default: 22, min: 0, max: 23, step: 1, description: "允許開倉結束時間 (UTC)" },
    // F5 波動率倉位
    { key: "enable_vol_position", type: "boolean", label: "啟用波動率倉位", default: true, description: "首單 = base_lot × (target_vol / ATR_pct)" },
    { key: "target_vol_pct", type: "number", label: "目標波動率 (%)", default: 1.5, min: 0.5, max: 5, step: 0.1, description: "目標波動率越小倉位越大" },
    { key: "vol_min_scale", type: "number", label: "最小縮放", default: 0.5, min: 0.1, max: 1, step: 0.1, description: "倉位縮放下限" },
    { key: "vol_max_scale", type: "number", label: "最大縮放", default: 2.0, min: 1, max: 5, step: 0.1, description: "倉位縮放上限" },
    // F6 AI 輔助過濾
    { key: "enable_ai_filter", type: "boolean", label: "啟用 AI 過濾", default: true, description: "KAMA 斜率 + 成交量放大過濾" },
    { key: "kama_slope_lookback", type: "number", label: "KAMA 斜率回看", default: 5, min: 2, max: 20, step: 1, description: "計算 KAMA 斜率的回看根數" },
    { key: "kama_slope_min", type: "number", label: "KAMA 斜率閾值 (%)", default: 0.05, min: 0.01, max: 1, step: 0.01, description: "斜率低於此值拒絕開倉" },
    { key: "volume_ma_period", type: "number", label: "成交量 MA 週期", default: 20, min: 5, max: 50, step: 1, description: "成交量均線計算週期" },
    { key: "volume_expansion_threshold", type: "number", label: "成交量放大倍數", default: 1.5, min: 1.0, max: 5.0, step: 0.1, description: "當前成交量/MA ≥ 此值才確認信號" },
    // 進階設定
    { key: "max_single_position_pct", type: "number", label: "最大單筆倉位 (%)", default: 0, min: 0, max: 100, advanced: true, description: "0 = 不限制" },
    { key: "stop_loss_pct", type: "number", label: "止損 (%)", default: 0, min: 0, advanced: true, description: "0 = 不啟用" },
    { key: "daily_loss_limit", type: "number", label: "每日最大虧損 (USDT)", default: 0, min: 0, advanced: true, description: "0 = 不限制" },
  ],
};

/** V6.1 KAMA 3K 高頻掃射極致版 schema */
export const STRATEGIES_V61_SCHEMA: SchemaConfig = {
  groups: [
    { name: "資金與風控", fields: ["initial_capital", "base_lot_size", "max_drawdown_pct", "hard_stop_pct", "max_deviation_pct"] },
    { name: "KAMA 指標", fields: ["kama_fast_len", "kama_fast_fastest", "kama_fast_slowest", "kama_slow_len", "kama_slow_fastest", "kama_slow_slowest"] },
    { name: "區域觸發設定", fields: ["zone_width_pct", "zone_tp_pct", "zone_sl_pct", "trailing_callback_pct"] },
    { name: "馬丁設定", fields: ["martin_step_pct", "martin_multiplier", "max_layers", "martin_mode", "martinLayersJson"] },
    { name: "時間與頻率", fields: ["timeframe", "cooldown_bars", "enable_bar_lock"] },
    { name: "部分獲利", fields: ["enable_partial_tp", "partial_tp_layer_4", "partial_tp_layer_6", "partial_tp_layer_8", "partial_tp_trigger_pct"] },
    { name: "風控開關", fields: ["enable_loss_shrink", "loss_shrink_level1", "loss_shrink_level1_pct", "loss_shrink_level2", "loss_shrink_level2_pct", "enable_continuous_entry"] },
    { name: "進階設定", fields: ["max_single_position_pct", "stop_loss_pct", "daily_loss_limit"] },
  ],
  advancedFields: ["max_single_position_pct", "stop_loss_pct", "daily_loss_limit"],
  fields: [
    // 資金與風控
    { key: "initial_capital", type: "number", label: "初始本金 (USDT)", default: 500, min: 50, step: 50, description: "策略專屬本金" },
    { key: "base_lot_size", type: "number", label: "首單金額 (USDT)", default: 15, min: 1, max: 100000, step: 1, description: "高頻掃射模式首單金額" },
    { key: "max_drawdown_pct", type: "number", label: "極限止損 (%)", default: 15, min: 5, max: 50, step: 1, description: "浮虧佔本金比例觸發強制平倉" },
    { key: "hard_stop_pct", type: "number", label: "硬止損 (%)", default: 3, min: 0.5, max: 30, step: 0.5, description: "持倉浮虧達此百分比即觸發強制平倉（預設 3%）" },
    { key: "max_deviation_pct", type: "number", label: "最後層偏離 (%)", default: 3, min: 0.5, max: 30, step: 0.5, description: "馬丁滿層後，最後一層價格偏離此百分比即觸發極限止損（預設 3%）" },
    // KAMA 指標
    { key: "kama_fast_len", type: "number", label: "KAMA 快線長度", default: 10, min: 3, max: 100, step: 1, description: "V6.1 高頻優化預設 10" },
    { key: "kama_fast_fastest", type: "number", label: "快線 fastest", default: 2, min: 2, max: 20, step: 1 },
    { key: "kama_fast_slowest", type: "number", label: "快線 slowest", default: 30, min: 5, max: 100, step: 1 },
    { key: "kama_slow_len", type: "number", label: "KAMA 慢線長度", default: 30, min: 5, max: 200, step: 1, description: "V6.1 高頻優化預設 30" },
    { key: "kama_slow_fastest", type: "number", label: "慢線 fastest", default: 2, min: 2, max: 20, step: 1 },
    { key: "kama_slow_slowest", type: "number", label: "慢線 slowest", default: 30, min: 5, max: 100, step: 1 },
    // 區域觸發設定
    { key: "zone_width_pct", type: "number", label: "區域寬度 (%)", default: 0.3, min: 0.05, max: 5, step: 0.05, description: "KAMA 上下區域寬度" },
    { key: "zone_tp_pct", type: "number", label: "區域止盈 (%)", default: 0.4, min: 0.1, max: 10, step: 0.1, description: "觸發移動止盈的盈利閾值" },
    { key: "zone_sl_pct", type: "number", label: "區域止損 (%)", default: 0.6, min: 0.1, max: 10, step: 0.1, description: "單層止損百分比" },
    { key: "trailing_callback_pct", type: "number", label: "回撤平倉 (%)", default: 0.15, min: 0.01, max: 5, step: 0.01, description: "從峰值回撤此 % 即平倉" },
    // 馬丁設定（與 V4.0 架構一致：分層表格為唯一來源）
    { key: "martin_step_pct", type: "number", label: "全局加倉間距 (%)", default: 2.0, min: 0.1, max: 20, step: 0.1, description: "當分層未設專屬間距時使用此全局值" },
    { key: "martin_multiplier", type: "number", label: "馬丁倍率（分層時鎖定）", default: 1.5, min: 1.0, max: 5, step: 0.1, description: "啟用階梯式分層後自動鎖定，請在分層表格設定各層乘數" },
    { key: "max_layers", type: "number", label: "最大層數（🔒 自動計算）", default: 11, min: 1, step: 1, description: "自動讀取分層表格最後一層 end 值，不可手動修改" },
    { key: "martin_mode", type: "select", label: "馬丁模式", default: "layered", options: [{ label: "固定乘數", value: "fixed" }, { label: "階梯式分層", value: "layered" }] },
    { key: "martinLayersJson", type: "martinLayers", label: "階梯式馬丁分層設定", condition: { field: "martin_mode", operator: "eq", value: "layered" } },
    // 時間與頻率
    { key: "timeframe", type: "number", label: "K 線週期 (分鐘)", default: 15, min: 1, max: 1440, step: 1, description: "策略監控的 K 線週期" },
    { key: "cooldown_bars", type: "number", label: "平倉後冷卻 (K 線數)", default: 2, min: 0, max: 20, step: 1, description: "平倉後等待幾根 K 線再重入" },
    { key: "enable_bar_lock", type: "boolean", label: "啟用 Bar-Lock", default: true, description: "同一根 K 線僅開倉一次" },
    // 部分獲利
    { key: "enable_partial_tp", type: "boolean", label: "啟用部分獲利", default: true, description: "層數≥ 4/6/8 時分批平倉" },
    { key: "partial_tp_layer_4", type: "number", label: "≥ 4 層平倉比例", default: 0.3, min: 0.05, max: 0.8, step: 0.05 },
    { key: "partial_tp_layer_6", type: "number", label: "≥ 6 層平倉比例", default: 0.3, min: 0.05, max: 0.8, step: 0.05 },
    { key: "partial_tp_layer_8", type: "number", label: "≥ 8 層平倉比例", default: 0.2, min: 0.05, max: 0.8, step: 0.05 },
    { key: "partial_tp_trigger_pct", type: "number", label: "觸發盈利 (%)", default: 0.3, min: 0.1, max: 5, step: 0.1, description: "浮盈達此值才觸發部分平倉" },
    // 風控開關
    { key: "enable_loss_shrink", type: "select", label: "連續虧損縮倉", default: "1", options: [{ label: "1 (開)", value: "1" }, { label: "0 (關)", value: "0" }], description: "連續虧損時自動縮小倉位" },
    { key: "loss_shrink_level1", type: "number", label: "第一階段觸發 (連虧次數)", default: 3, min: 1, max: 10, step: 1 },
    { key: "loss_shrink_level1_pct", type: "number", label: "第一階段縮倉比例 (%)", default: 70, min: 50, max: 90, step: 5 },
    { key: "loss_shrink_level2", type: "number", label: "第二階段觸發 (連虧次數)", default: 5, min: 3, max: 15, step: 1 },
    { key: "loss_shrink_level2_pct", type: "number", label: "第二階段縮倉比例 (%)", default: 50, min: 30, max: 70, step: 5 },
    { key: "enable_continuous_entry", type: "select", label: "連續開倉", default: "1", options: [{ label: "1 (開)", value: "1" }, { label: "0 (關)", value: "0" }], description: "允許連續開倉不等待冷卻" },
    // 進階設定
    { key: "max_single_position_pct", type: "number", label: "最大單筆倉位 (%)", default: 0, min: 0, max: 100, advanced: true, description: "0 = 不限制" },
    { key: "stop_loss_pct", type: "number", label: "止損 (%)", default: 0, min: 0, advanced: true, description: "0 = 不啟用" },
    { key: "daily_loss_limit", type: "number", label: "每日最大虧損 (USDT)", default: 0, min: 0, advanced: true, description: "0 = 不限制" },
  ],
};

/** 根據 strategyKey 選擇對應 schema */
export function getSchemaForStrategy(strategyKey: string | null | undefined): SchemaConfig {
  if (strategyKey === "KAMA_3K_HF_V61") return STRATEGIES_V61_SCHEMA;
  if (strategyKey === "KAMA_3K_ULTIMATE_V50") return STRATEGIES_V50_SCHEMA;
  if (strategyKey === "strategy_20415") return STRATEGIES_V20_SCHEMA;
  return STRATEGIES_DYNAMIC_SCHEMA;
}
