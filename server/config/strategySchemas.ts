/**
 * V4.3 策略 Schema 定義（統一配置）
 * 用途：前端 DynamicForm 根據此結構自動渲染參數表單
 * 格式：SchemaConfig（含 groups 分組 + fields 欄位定義）
 */

export interface FieldSchema {
  key: string;
  type: "number" | "string" | "boolean" | "select" | "array" | "conditional" | "json";
  label: string;
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: any }[];
  description?: string;
  condition?: {
    field: string;
    operator: "eq" | "neq" | "gt" | "lt";
    value: any;
  };
  children?: FieldSchema[];
}

export interface SchemaConfig {
  groups?: { name: string; fields: string[] }[];
  fields: Record<string, FieldSchema>;
}

// ===== V2.5 KAMA 三K突破｜階梯式馬丁 Schema =====
export const KAMA_3K_BREAKOUT_V25_SCHEMA: SchemaConfig = {
  groups: [
    { name: "01｜KAMA 指標核心", fields: ["KAMA_Fast_Length", "p2_fastest", "p3_slowest", "KAMA_Slow_Length", "q2_fastest", "q3_slowest"] },
    { name: "02｜首單與資金單位", fields: ["Base_Lot_Size"] },
    { name: "03｜三重出場防線", fields: ["Hard_Stop_Loss_Pct", "Take_Profit_Pct", "Trailing_TP_Enabled", "Trailing_Activation_Pct", "Trailing_Callback_Pct"] },
    { name: "04｜動態階梯馬丁", fields: ["Martin_Enabled", "Martin_Ranges"] },
    { name: "05｜趨勢重入", fields: ["Reentry_On_Trend"] },
    { name: "06｜訊號週期", fields: ["K_Line_Period"] },
  ],
  fields: {
    KAMA_Fast_Length: { key: "KAMA_Fast_Length", type: "number", label: "快線 ER 週期", default: 50, min: 5, max: 200, step: 1 },
    p2_fastest: { key: "p2_fastest", type: "number", label: "快線最快常數", default: 10, min: 2, max: 20, step: 1 },
    p3_slowest: { key: "p3_slowest", type: "number", label: "快線最慢常數", default: 2, min: 1, max: 10, step: 1 },
    KAMA_Slow_Length: { key: "KAMA_Slow_Length", type: "number", label: "慢線 ER 週期", default: 50, min: 5, max: 200, step: 1 },
    q2_fastest: { key: "q2_fastest", type: "number", label: "慢線最快常數", default: 10, min: 2, max: 20, step: 1 },
    q3_slowest: { key: "q3_slowest", type: "number", label: "慢線最慢常數", default: 6, min: 1, max: 10, step: 1, description: "必須大於快線最慢常數" },
    Base_Lot_Size: { key: "Base_Lot_Size", type: "number", label: "首單金額", default: 100, min: 1, step: 1, description: "固定使用 USDT，不按槓桿放大參數百分比" },
    Hard_Stop_Loss_Pct: { key: "Hard_Stop_Loss_Pct", type: "number", label: "硬止損", default: 3, min: 0, max: 10, step: 0.1, description: "名義價格百分比；0 表示停用" },
    Take_Profit_Pct: { key: "Take_Profit_Pct", type: "number", label: "固定止盈", default: 1, min: 0, max: 10, step: 0.1, description: "名義價格百分比；0 表示停用" },
    Trailing_TP_Enabled: { key: "Trailing_TP_Enabled", type: "boolean", label: "啟用追蹤止盈", default: true },
    Trailing_Activation_Pct: { key: "Trailing_Activation_Pct", type: "number", label: "追蹤啟動門檻", default: 0.8, min: 0.1, max: 5, step: 0.05, description: "%" },
    Trailing_Callback_Pct: { key: "Trailing_Callback_Pct", type: "number", label: "追蹤回撤幅度", default: 0.4, min: 0.05, max: 3, step: 0.05, description: "不可大於啟動門檻" },
    Martin_Enabled: { key: "Martin_Enabled", type: "boolean", label: "啟用階梯馬丁", default: true },
    Martin_Ranges: {
      key: "Martin_Ranges",
      type: "array",
      label: "馬丁範圍",
      default: [
        { start: 1, end: 3, multiplier: 1.2, gap: 0.8 },
        { start: 4, end: 6, multiplier: 1.1, gap: 1.2 },
        { start: 7, end: 10, multiplier: 1, gap: 2 },
      ],
      description: "可增刪任意列；第一列從 1 開始，所有範圍必須連續且不可重疊",
      children: [
        { key: "start", type: "number", label: "起始層", min: 1, step: 1 },
        { key: "end", type: "number", label: "結束層", min: 1, step: 1 },
        { key: "multiplier", type: "number", label: "倍率", min: 0.1, max: 5, step: 0.1 },
        { key: "gap", type: "number", label: "間距 %", min: 0.1, max: 20, step: 0.1 },
      ],
    },
    Reentry_On_Trend: { key: "Reentry_On_Trend", type: "boolean", label: "止盈後原地重入", default: true, description: "僅止盈平倉後保留一次同方向重入資格" },
    K_Line_Period: { key: "K_Line_Period", type: "number", label: "K 線週期", default: 15, min: 1, max: 1440, step: 1, description: "分鐘" },
  },
};

// ===== V4.0 KAMA+3K 動態馬丁策略 Schema =====
export const KAMA_3K_SCHEMA: SchemaConfig = {
  groups: [
    {
      name: "資金管理",
      fields: ["Initial_Capital", "Base_Lot_Size", "First_Order_Pct", "Max_Loss_Pct"],
    },
    {
      name: "KAMA 指標",
      fields: ["KAMA_Fast_Length", "p2_fastest", "p3_slowest", "KAMA_Slow_Length", "q2_fastest", "q3_slowest"],
    },
    {
      name: "馬丁格爾",
      fields: ["Martin_Multiplier", "Max_Layers", "Martin_Step_Pct", "Martin_Layers"],
    },
    {
      name: "止盈止損",
      fields: ["Target_TP_Pct", "Callback_Pct", "K_Line_Period"],
    },
  ],
  fields: {
    Initial_Capital: {
      key: "Initial_Capital",
      type: "number",
      label: "初始資金 (USDT)",
      default: 10000,
      min: 100,
      max: 10000000,
      step: 100,
      description: "策略初始資金，用於計算百分比倉位和風控",
    },
    Base_Lot_Size: {
      key: "Base_Lot_Size",
      type: "number",
      label: "首單金額 (USDT)",
      default: 30,
      min: 1,
      max: 100000,
      step: 1,
      description: "首單固定金額（USDT 金本位模式）",
    },
    First_Order_Pct: {
      key: "First_Order_Pct",
      type: "number",
      label: "首單百分比 (%)",
      default: 0.3,
      min: 0.01,
      max: 10,
      step: 0.01,
      description: "首單佔初始資金的百分比（回退用）",
    },
    Max_Loss_Pct: {
      key: "Max_Loss_Pct",
      type: "number",
      label: "硬止損 (%)",
      default: 5.0,
      min: 0.5,
      max: 50,
      step: 0.5,
      description: "當倉位總虧損達到初始資金的此百分比時全平",
    },
    Martin_Multiplier: {
      key: "Martin_Multiplier",
      type: "number",
      label: "馬丁倍率",
      default: 1.5,
      min: 1.0,
      max: 5.0,
      step: 0.1,
      description: "全局馬丁加倉倍率（有分層時被分層覆蓋）",
    },
    Max_Layers: {
      key: "Max_Layers",
      type: "number",
      label: "最大層數",
      default: 11,
      min: 1,
      max: 20,
      step: 1,
      description: "馬丁格爾最大加倉層數",
    },
    KAMA_Fast_Length: {
      key: "KAMA_Fast_Length",
      type: "number",
      label: "KAMA 快線長度",
      default: 50,
      min: 5,
      max: 200,
      step: 1,
      description: "快速 KAMA 指標的計算週期",
    },
    p2_fastest: {
      key: "p2_fastest",
      type: "number",
      label: "快線最快常數",
      default: 10,
      min: 2,
      max: 50,
      step: 1,
      description: "KAMA 快線的最快平滑常數",
    },
    p3_slowest: {
      key: "p3_slowest",
      type: "number",
      label: "快線最慢常數",
      default: 2,
      min: 1,
      max: 30,
      step: 1,
      description: "KAMA 快線的最慢平滑常數",
    },
    KAMA_Slow_Length: {
      key: "KAMA_Slow_Length",
      type: "number",
      label: "KAMA 慢線長度",
      default: 50,
      min: 5,
      max: 200,
      step: 1,
      description: "慢速 KAMA 指標的計算週期",
    },
    q2_fastest: {
      key: "q2_fastest",
      type: "number",
      label: "慢線最快常數",
      default: 10,
      min: 2,
      max: 50,
      step: 1,
      description: "KAMA 慢線的最快平滑常數",
    },
    q3_slowest: {
      key: "q3_slowest",
      type: "number",
      label: "慢線最慢常數",
      default: 6,
      min: 1,
      max: 30,
      step: 1,
      description: "KAMA 慢線的最慢平滑常數",
    },
    Martin_Step_Pct: {
      key: "Martin_Step_Pct",
      type: "number",
      label: "全局加倉間距 (%)",
      default: 2.0,
      min: 0.1,
      max: 20,
      step: 0.1,
      description: "每層加倉的價格偏離百分比",
    },
    Martin_Layers: {
      key: "Martin_Layers",
      type: "json",
      label: "階梯式馬丁分層",
      default: [
        { start: 1, end: 4, multiplier: 1.5 },
        { start: 5, end: 9, multiplier: 1.1 },
        { start: 10, end: 11, multiplier: 1.0 },
      ],
      description: "分層乘數設定（JSON 格式），可含 stepPct 自定義間距",
    },
    Target_TP_Pct: {
      key: "Target_TP_Pct",
      type: "number",
      label: "止盈 (%)",
      default: 1.0,
      min: 0.1,
      max: 20,
      step: 0.1,
      description: "均價上漲此百分比時激活移動止盈",
    },
    Callback_Pct: {
      key: "Callback_Pct",
      type: "number",
      label: "回撤出場 (%)",
      default: 0.1,
      min: 0.01,
      max: 5,
      step: 0.01,
      description: "從最高點回撤此百分比時觸發平倉",
    },
    K_Line_Period: {
      key: "K_Line_Period",
      type: "number",
      label: "K 線週期 (分鐘)",
      default: 15,
      min: 1,
      max: 1440,
      step: 1,
      description: "策略使用的 K 線時間框架",
    },
  },
};

// ===== 通用策略 Schema（用於自訂策略的預設結構） =====
export const GENERIC_STRATEGY_SCHEMA: SchemaConfig = {
  groups: [
    { name: "基本設定", fields: ["Base_Lot_Size", "Initial_Capital", "Max_Loss_Pct"] },
    { name: "止盈止損", fields: ["Target_TP_Pct", "Callback_Pct"] },
    { name: "馬丁格爾", fields: ["Martin_Multiplier", "Max_Layers", "Martin_Step_Pct"] },
  ],
  fields: {
    Base_Lot_Size: {
      key: "Base_Lot_Size",
      type: "number",
      label: "首單金額 (USDT)",
      default: 30,
      min: 1,
      max: 100000,
      step: 1,
      description: "首單固定金額",
    },
    Initial_Capital: {
      key: "Initial_Capital",
      type: "number",
      label: "初始資金 (USDT)",
      default: 10000,
      min: 100,
      max: 10000000,
      step: 100,
      description: "策略初始資金",
    },
    Max_Loss_Pct: {
      key: "Max_Loss_Pct",
      type: "number",
      label: "硬止損 (%)",
      default: 5.0,
      min: 0.5,
      max: 50,
      step: 0.5,
      description: "最大虧損百分比",
    },
    Target_TP_Pct: {
      key: "Target_TP_Pct",
      type: "number",
      label: "止盈 (%)",
      default: 1.0,
      min: 0.1,
      max: 20,
      step: 0.1,
      description: "止盈觸發百分比",
    },
    Callback_Pct: {
      key: "Callback_Pct",
      type: "number",
      label: "回撤出場 (%)",
      default: 0.1,
      min: 0.01,
      max: 5,
      step: 0.01,
      description: "回撤平倉百分比",
    },
    Martin_Multiplier: {
      key: "Martin_Multiplier",
      type: "number",
      label: "馬丁倍率",
      default: 1.5,
      min: 1.0,
      max: 5.0,
      step: 0.1,
      description: "加倉倍率",
    },
    Max_Layers: {
      key: "Max_Layers",
      type: "number",
      label: "最大層數",
      default: 11,
      min: 1,
      max: 20,
      step: 1,
      description: "最大加倉層數",
    },
    Martin_Step_Pct: {
      key: "Martin_Step_Pct",
      type: "number",
      label: "加倉間距 (%)",
      default: 2.0,
      min: 0.1,
      max: 20,
      step: 0.1,
      description: "加倉價格偏離百分比",
    },
  },
};

// ===== 20415 七彩虹馬丁策略 Schema =====
// 陣列／物件參數（七線、底倉、動態階梯）由 Rainbow20415ConfigPanel 與共享契約管理。
export const STRATEGY_20415_SCHEMA: SchemaConfig = {
  groups: [
    {
      name: "七線排名入場",
      fields: ["Entry_Timeframe_Minutes", "Management_Interval_Minutes"],
    },
    {
      name: "盲人模式與止盈",
      fields: ["Take_Profit_Pct", "Global_Spacing_Pct", "Martingale_Enabled"],
    },
    {
      name: "三道鐵幕",
      fields: ["Max_Hold_Hours", "Max_Margin_Usage_Pct", "Max_Account_Loss_Pct"],
    },
    {
      name: "資金與重入",
      fields: ["Initial_Capital", "Reentry_Enabled", "Reentry_Cooldown_Minutes"],
    },
  ],
  fields: {
    Entry_Timeframe_Minutes: {
      key: "Entry_Timeframe_Minutes",
      type: "number",
      label: "入場戰術週期 (分鐘)",
      default: 30,
      min: 1,
      max: 1440,
      step: 1,
      description: "空倉時只使用已收盤週期 K 棒判定七線排名，標準為 M30",
    },
    Management_Interval_Minutes: {
      key: "Management_Interval_Minutes",
      type: "number",
      label: "持倉管理週期 (分鐘)",
      default: 1,
      min: 1,
      max: 60,
      step: 1,
      description: "入場後以此頻率執行盲人模式、階梯、止盈與風控",
    },
    Take_Profit_Pct: {
      key: "Take_Profit_Pct",
      type: "number",
      label: "平均成本止盈 (%)",
      default: 0.2,
      min: 0.01,
      max: 10,
      step: 0.01,
      description: "依真實加權平均成本計算止盈觸發價",
    },
    Global_Spacing_Pct: {
      key: "Global_Spacing_Pct",
      type: "number",
      label: "全局階梯間距 (%)",
      default: 1.5,
      min: 0.01,
      max: 100,
      step: 0.01,
      description: "未設定自訂間距的啟用階梯使用此價格偏離百分比",
    },
    Martingale_Enabled: {
      key: "Martingale_Enabled",
      type: "boolean",
      label: "啟用階梯馬丁",
      default: true,
      description: "停用後保留底倉、成本止盈與三道鐵幕，但不再加倉",
    },
    Max_Hold_Hours: {
      key: "Max_Hold_Hours",
      type: "number",
      label: "持倉時間上限 (小時)",
      default: 48,
      min: 0.01,
      max: 8760,
      step: 1,
      description: "第一道鐵幕：持倉超時即要求全平",
    },
    Max_Margin_Usage_Pct: {
      key: "Max_Margin_Usage_Pct",
      type: "number",
      label: "保證金使用率上限 (%)",
      default: 70,
      min: 1,
      max: 100,
      step: 0.1,
      description: "第二道鐵幕：缺少真實保證金資料時禁止加倉",
    },
    Max_Account_Loss_Pct: {
      key: "Max_Account_Loss_Pct",
      type: "number",
      label: "最終層帳戶虧損上限 (%)",
      default: 5,
      min: 0.1,
      max: 100,
      step: 0.1,
      description: "第三道鐵幕：到達最終啟用層且策略虧損達帳戶權益比例時全平",
    },
    Initial_Capital: {
      key: "Initial_Capital",
      type: "number",
      label: "策略初始資金 (USDT)",
      default: 10000,
      min: 100,
      max: 100000000,
      step: 100,
      description: "回測初始權益與策略資金基準",
    },
    Reentry_Enabled: {
      key: "Reentry_Enabled",
      type: "boolean",
      label: "啟用無縫重入",
      default: true,
      description: "成功平倉後以最新已收盤七線結構重判一次",
    },
    Reentry_Cooldown_Minutes: {
      key: "Reentry_Cooldown_Minutes",
      type: "number",
      label: "重入冷卻 (分鐘)",
      default: 0,
      min: 0,
      max: 10080,
      step: 1,
      description: "0 代表不延遲；合法 0 必須完整保存",
    },
  },
};

// ===== V5.0 KAMA+3K 極致優化馬丁策略 Schema =====
export const KAMA_3K_V50_SCHEMA: SchemaConfig = {
  groups: [
    {
      name: "資金管理",
      fields: ["Initial_Capital", "Base_Lot_Size", "First_Order_Pct", "Max_Loss_Pct", "Max_Drawdown_Pct"],
    },
    {
      name: "KAMA 指標",
      fields: ["KAMA_Fast_Length", "p2_fastest", "p3_slowest", "KAMA_Slow_Length", "q2_fastest", "q3_slowest"],
    },
    {
      name: "馬丁格爾",
      fields: ["Martin_Multiplier", "Max_Layers", "Martin_Step_Pct", "Martin_Layers"],
    },
    {
      name: "止盈止損",
      fields: ["Target_TP_Pct", "Callback_Pct", "K_Line_Period", "Reentry_On_Trend"],
    },
    {
      name: "F1 市場制度切換",
      fields: ["enable_regime_switch", "adx_period", "atr_period", "adx_strong_threshold", "adx_weak_threshold"],
    },
    {
      name: "F2 部分獲利",
      fields: ["enable_partial_tp", "partial_tp_layer_4", "partial_tp_layer_6", "partial_tp_layer_8", "partial_tp_trigger_pct"],
    },
    {
      name: "F3 ATR 動態止盈",
      fields: ["enable_dynamic_tp", "tp_min_pct", "tp_atr_multiplier"],
    },
    {
      name: "F4 時間濾網",
      fields: ["enable_time_filter", "allowed_start_hour", "allowed_end_hour"],
    },
    {
      name: "F5 波動率倉位",
      fields: ["enable_vol_position", "target_vol_pct", "vol_min_scale", "vol_max_scale"],
    },
    {
      name: "F6 AI 輔助過濾",
      fields: ["enable_ai_filter", "kama_slope_lookback", "kama_slope_min", "volume_ma_period", "volume_expansion_threshold"],
    },
  ],
  fields: {
    Initial_Capital: { key: "Initial_Capital", type: "number", label: "初始資金 (USDT)", default: 10000, min: 100, max: 10000000, step: 100, description: "策略初始資金" },
    Base_Lot_Size: { key: "Base_Lot_Size", type: "number", label: "首單金額 (USDT)", default: 30, min: 1, max: 100000, step: 1, description: "固定金本位首單金額" },
    First_Order_Pct: { key: "First_Order_Pct", type: "number", label: "首單佔本金%", default: 0.3, min: 0.01, max: 10, step: 0.01, description: "回退用：首單佔本金百分比" },
    Max_Loss_Pct: { key: "Max_Loss_Pct", type: "number", label: "硬止損 (%)", default: 6.0, min: 1, max: 50, step: 0.5, description: "總浮虧佔本金比例觸發硬止損" },
    Max_Drawdown_Pct: { key: "Max_Drawdown_Pct", type: "number", label: "極限止損 (%)", default: 10, min: 5, max: 50, step: 1, description: "極限防爆倉止損" },
    KAMA_Fast_Length: { key: "KAMA_Fast_Length", type: "number", label: "KAMA 快線長度", default: 30, min: 5, max: 200, step: 1, description: "V5.0 優化預設 30" },
    p2_fastest: { key: "p2_fastest", type: "number", label: "快線 fastest", default: 8, min: 2, max: 50, step: 1 },
    p3_slowest: { key: "p3_slowest", type: "number", label: "快線 slowest", default: 2, min: 2, max: 50, step: 1 },
    KAMA_Slow_Length: { key: "KAMA_Slow_Length", type: "number", label: "KAMA 慢線長度", default: 55, min: 5, max: 200, step: 1, description: "V5.0 優化預設 55" },
    q2_fastest: { key: "q2_fastest", type: "number", label: "慢線 fastest", default: 10, min: 2, max: 50, step: 1 },
    q3_slowest: { key: "q3_slowest", type: "number", label: "慢線 slowest", default: 8, min: 2, max: 50, step: 1, description: "V5.0 優化預設 8" },
    Martin_Multiplier: { key: "Martin_Multiplier", type: "number", label: "馬丁乘數", default: 1.5, min: 1, max: 5, step: 0.1 },
    Max_Layers: { key: "Max_Layers", type: "number", label: "最大層數", default: 13, min: 1, max: 50, step: 1, description: "V5.0 預設 13 層" },
    Martin_Step_Pct: { key: "Martin_Step_Pct", type: "number", label: "加倉間距 (%)", default: 2.0, min: 0.1, max: 20, step: 0.1 },
    Martin_Layers: { key: "Martin_Layers", type: "json", label: "階梯式分層", default: "[{\"start\":1,\"end\":4,\"multiplier\":1.5},{\"start\":5,\"end\":9,\"multiplier\":1.2},{\"start\":10,\"end\":13,\"multiplier\":1.0}]" },
    Target_TP_Pct: { key: "Target_TP_Pct", type: "number", label: "止盈激活 (%)", default: 1.0, min: 0.1, max: 50, step: 0.1 },
    Callback_Pct: { key: "Callback_Pct", type: "number", label: "回撤平倉 (%)", default: 0.1, min: 0.01, max: 5, step: 0.01 },
    K_Line_Period: { key: "K_Line_Period", type: "number", label: "K 線週期 (分鐘)", default: 15, min: 1, max: 1440, step: 1 },
    Reentry_On_Trend: { key: "Reentry_On_Trend", type: "boolean", label: "順勢重入", default: true, description: "平倉後 KAMA 方向一致時立即重入" },
    // F1
    enable_regime_switch: { key: "enable_regime_switch", type: "boolean", label: "啟用市場制度切換", default: true, description: "ADX 驅動動態馬丁參數" },
    adx_period: { key: "adx_period", type: "number", label: "ADX 週期", default: 14, min: 5, max: 50, step: 1 },
    atr_period: { key: "atr_period", type: "number", label: "ATR 週期", default: 14, min: 5, max: 50, step: 1 },
    adx_strong_threshold: { key: "adx_strong_threshold", type: "number", label: "ADX 強趨勢閾值", default: 30, min: 15, max: 50, step: 1, description: "ADX ≥ 此值 = 強趨勢" },
    adx_weak_threshold: { key: "adx_weak_threshold", type: "number", label: "ADX 弱趨勢閾值", default: 20, min: 10, max: 40, step: 1, description: "ADX ≥ 此值 = 弱趨勢" },
    // F2
    enable_partial_tp: { key: "enable_partial_tp", type: "boolean", label: "啟用部分獲利", default: true, description: "層數≥ 4/6/8 時分批平倉" },
    partial_tp_layer_4: { key: "partial_tp_layer_4", type: "number", label: "≥ 4 層平倉比例", default: 0.3, min: 0.05, max: 0.8, step: 0.05, description: "30%" },
    partial_tp_layer_6: { key: "partial_tp_layer_6", type: "number", label: "≥ 6 層平倉比例", default: 0.3, min: 0.05, max: 0.8, step: 0.05, description: "30%" },
    partial_tp_layer_8: { key: "partial_tp_layer_8", type: "number", label: "≥ 8 層平倉比例", default: 0.2, min: 0.05, max: 0.8, step: 0.05, description: "20%" },
    partial_tp_trigger_pct: { key: "partial_tp_trigger_pct", type: "number", label: "觸發盈利 (%)", default: 0.5, min: 0.1, max: 5, step: 0.1, description: "浮盈達此值才觸發部分平倉" },
    // F3
    enable_dynamic_tp: { key: "enable_dynamic_tp", type: "boolean", label: "啟用 ATR 動態止盈", default: true, description: "TP = MAX(tp_min, ATR/price × multiplier)" },
    tp_min_pct: { key: "tp_min_pct", type: "number", label: "最低止盈 (%)", default: 0.8, min: 0.1, max: 10, step: 0.1 },
    tp_atr_multiplier: { key: "tp_atr_multiplier", type: "number", label: "ATR 止盈乘數", default: 2.5, min: 0.5, max: 10, step: 0.1 },
    // F4
    enable_time_filter: { key: "enable_time_filter", type: "boolean", label: "啟用時間濾網", default: false, description: "預設關閉（24/7 全時段）；KAMA 自適應 + AI 斜率過濾已足夠過濾低波動假信號" },
    allowed_start_hour: { key: "allowed_start_hour", type: "number", label: "開始時 (UTC)", default: 0, min: 0, max: 23, step: 1 },
    allowed_end_hour: { key: "allowed_end_hour", type: "number", label: "結束時 (UTC)", default: 24, min: 0, max: 24, step: 1 },
    // F5
    enable_vol_position: { key: "enable_vol_position", type: "boolean", label: "啟用波動率倉位", default: true, description: "首單 = base_lot × (target_vol / ATR_pct)" },
    target_vol_pct: { key: "target_vol_pct", type: "number", label: "目標波動率 (%)", default: 1.5, min: 0.5, max: 5, step: 0.1 },
    vol_min_scale: { key: "vol_min_scale", type: "number", label: "最小縮放", default: 0.5, min: 0.1, max: 1, step: 0.1 },
    vol_max_scale: { key: "vol_max_scale", type: "number", label: "最大縮放", default: 2.0, min: 1, max: 5, step: 0.1 },
    // F6
    enable_ai_filter: { key: "enable_ai_filter", type: "boolean", label: "啟用 AI 過濾", default: true, description: "KAMA 斜率 + 成交量放大過濾" },
    kama_slope_lookback: { key: "kama_slope_lookback", type: "number", label: "KAMA 斜率回看", default: 5, min: 2, max: 20, step: 1 },
    kama_slope_min: { key: "kama_slope_min", type: "number", label: "KAMA 斜率閾值 (%)", default: 0.05, min: 0.01, max: 1, step: 0.01 },
    volume_ma_period: { key: "volume_ma_period", type: "number", label: "成交量 MA 週期", default: 20, min: 5, max: 50, step: 1 },
    volume_expansion_threshold: { key: "volume_expansion_threshold", type: "number", label: "成交量放大倍數", default: 1.5, min: 1.0, max: 5.0, step: 0.1 },
  },
};

// ===== V6.1 KAMA 3K 高頻掃射極致版 Schema =====
export const KAMA_3K_V61_SCHEMA: SchemaConfig = {
  groups: [
    { name: "KAMA 雙線", fields: ["kama_fast_length", "kama_fast_fastest", "kama_fast_slowest", "kama_slow_length", "kama_slow_fastest", "kama_slow_slowest"] },
    { name: "區域觸發與濾網", fields: ["buffer_atr_multiplier_trend", "buffer_atr_multiplier_weak", "buffer_atr_multiplier_ranging", "entry_zone_mode", "direction_mode", "min_atr_ratio"] },
    { name: "連續開倉設定", fields: ["enable_continuous_entry", "cooldown_minutes", "enable_bar_lock"] },
    { name: "市場制度 (F1)", fields: ["adx_period", "adx_trend_threshold", "adx_strong_threshold", "atr_ratio_threshold"] },
    { name: "動態止盈 (F3)", fields: ["tp_atr_multiplier", "callback_atr_multiplier", "tp_min_pct", "callback_min_pct"] },
    { name: "波動率倉位 (F5)", fields: ["target_volatility", "base_lot_size", "lot_min_multiplier", "lot_max_multiplier"] },
    { name: "連續虧損縮倉", fields: ["enable_loss_shrink", "loss_shrink_level1", "loss_shrink_level1_pct", "loss_shrink_level2", "loss_shrink_level2_pct"] },
    { name: "每日風控", fields: ["max_daily_trades", "max_daily_loss"] },
  ],
  fields: {
    kama_fast_length: { key: "kama_fast_length", type: "number", label: "快線 Length", default: 30, min: 10, max: 100, step: 1 },
    kama_fast_fastest: { key: "kama_fast_fastest", type: "number", label: "快線 Fastest", default: 8, min: 2, max: 20, step: 1 },
    kama_fast_slowest: { key: "kama_fast_slowest", type: "number", label: "快線 Slowest", default: 2, min: 1, max: 50, step: 1 },
    kama_slow_length: { key: "kama_slow_length", type: "number", label: "慢線 Length", default: 55, min: 10, max: 100, step: 1 },
    kama_slow_fastest: { key: "kama_slow_fastest", type: "number", label: "慢線 Fastest", default: 10, min: 2, max: 20, step: 1 },
    kama_slow_slowest: { key: "kama_slow_slowest", type: "number", label: "慢線 Slowest", default: 8, min: 1, max: 50, step: 1 },
    buffer_atr_multiplier_trend: { key: "buffer_atr_multiplier_trend", type: "number", label: "緩衝區 (強趨勢)", default: 0.25, min: 0.1, max: 0.8, step: 0.05, description: "×ATR" },
    buffer_atr_multiplier_weak: { key: "buffer_atr_multiplier_weak", type: "number", label: "緩衝區 (弱趨勢)", default: 0.30, min: 0.1, max: 0.8, step: 0.05, description: "×ATR" },
    buffer_atr_multiplier_ranging: { key: "buffer_atr_multiplier_ranging", type: "number", label: "緩衝區 (震盪)", default: 0.50, min: 0.1, max: 0.8, step: 0.05, description: "×ATR" },
    entry_zone_mode: { key: "entry_zone_mode", type: "select", label: "入場模式", default: "breakout", options: [{ label: "突破模式 (Breakout)", value: "breakout" }, { label: "內部模式 (Inside)", value: "inside" }] },
    direction_mode: { key: "direction_mode", type: "select", label: "方向模式", default: "hybrid", options: [{ label: "順勢+震盪雙向 (Hybrid)", value: "hybrid" }, { label: "僅順勢 (Trend)", value: "trend" }, { label: "純雙向 (Both)", value: "both" }] },
    min_atr_ratio: { key: "min_atr_ratio", type: "number", label: "最小 ATR 比率", default: 0.7, min: 0.4, max: 1.0, step: 0.05, description: "低於此值不開倉" },
    enable_continuous_entry: { key: "enable_continuous_entry", type: "select", label: "連續開倉", default: "1", options: [{ label: "1 (開)", value: "1" }, { label: "0 (關)", value: "0" }] },
    cooldown_minutes: { key: "cooldown_minutes", type: "number", label: "冷卻期 (分鐘)", default: 0, min: 0, max: 60, step: 1, description: "0=無冷卻" },
    enable_bar_lock: { key: "enable_bar_lock", type: "boolean", label: "Bar-Lock 限制", default: false, description: "同一 K 線限制" },
    adx_period: { key: "adx_period", type: "number", label: "ADX 週期", default: 14, min: 7, max: 30, step: 1 },
    adx_trend_threshold: { key: "adx_trend_threshold", type: "number", label: "ADX 趨勢門檻", default: 25, min: 10, max: 50, step: 1 },
    adx_strong_threshold: { key: "adx_strong_threshold", type: "number", label: "ADX 強趨勢門檻", default: 30, min: 20, max: 50, step: 1 },
    atr_ratio_threshold: { key: "atr_ratio_threshold", type: "number", label: "ATR 高波動比率", default: 1.2, min: 1.0, max: 2.0, step: 0.1 },
    tp_atr_multiplier: { key: "tp_atr_multiplier", type: "number", label: "ATR 止盈倍數", default: 1.5, min: 0.5, max: 3.0, step: 0.1 },
    callback_atr_multiplier: { key: "callback_atr_multiplier", type: "number", label: "ATR 回撤倍數", default: 0.3, min: 0.1, max: 0.8, step: 0.05 },
    tp_min_pct: { key: "tp_min_pct", type: "number", label: "最小止盈 %", default: 0.5, min: 0.2, max: 2.0, step: 0.05 },
    callback_min_pct: { key: "callback_min_pct", type: "number", label: "最小回撤 %", default: 0.15, min: 0.05, max: 0.5, step: 0.05 },
    target_volatility: { key: "target_volatility", type: "number", label: "目標波動率", default: 4.0, min: 2.0, max: 8.0, step: 0.1, description: "%" },
    base_lot_size: { key: "base_lot_size", type: "number", label: "基準首單金額", default: 15, min: 5, max: 100, step: 1, description: "USDT" },
    lot_min_multiplier: { key: "lot_min_multiplier", type: "number", label: "最小倉位係數", default: 0.5, min: 0.3, max: 0.8, step: 0.05 },
    lot_max_multiplier: { key: "lot_max_multiplier", type: "number", label: "最大倉位係數", default: 2.0, min: 1.2, max: 3.0, step: 0.05 },
    enable_loss_shrink: { key: "enable_loss_shrink", type: "select", label: "連續虧損縮倉", default: "1", options: [{ label: "1 (開)", value: "1" }, { label: "0 (關)", value: "0" }] },
    loss_shrink_level1: { key: "loss_shrink_level1", type: "number", label: "第一階段觸發 (連虧次數)", default: 3, min: 1, max: 10, step: 1 },
    loss_shrink_level1_pct: { key: "loss_shrink_level1_pct", type: "number", label: "第一階段縮倉比例", default: 70, min: 50, max: 90, step: 5, description: "%" },
    loss_shrink_level2: { key: "loss_shrink_level2", type: "number", label: "第二階段觸發 (連虧次數)", default: 5, min: 3, max: 15, step: 1 },
    loss_shrink_level2_pct: { key: "loss_shrink_level2_pct", type: "number", label: "第二階段縮倉比例", default: 50, min: 30, max: 70, step: 5, description: "%" },
    max_daily_trades: { key: "max_daily_trades", type: "number", label: "每日最大交易次數", default: 20, min: 5, max: 50, step: 1 },
    max_daily_loss: { key: "max_daily_loss", type: "number", label: "每日最大虧損", default: 3.0, min: 1.0, max: 5.0, step: 0.5, description: "% 本金" },
  },
};

/** 根據策略 key 獲取對應的 Schema */
export function getSchemaForStrategy(key: string): SchemaConfig {
  if (key === "KAMA_3K_BREAKOUT_V25") {
    return KAMA_3K_BREAKOUT_V25_SCHEMA;
  }
  if (key === "KAMA_3K_HF_V61") {
    return KAMA_3K_V61_SCHEMA;
  }
  if (key === "KAMA_3K_ULTIMATE_V50") {
    return KAMA_3K_V50_SCHEMA;
  }
  if (key === "20415_KAMA_MARTIN_V35" || key.includes("KAMA")) {
    return KAMA_3K_SCHEMA;
  }
  if (key === "strategy_20415" || key.includes("EMATrend")) {
    return STRATEGY_20415_SCHEMA;
  }
  return GENERIC_STRATEGY_SCHEMA;
}
