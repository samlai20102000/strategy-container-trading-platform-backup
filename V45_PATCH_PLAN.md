# V4.5 Strategies.tsx 修改計劃

## 目標
替換 Strategies.tsx 行 942-1183 的三個硬編碼區塊為 DynamicForm 組件

## 保留不動的部分
- 行 791-940：基礎設定（策略名稱、API金鑰、交易對、倉位大小、槓桿、方向、下單類型）
- 行 1185-1207：策略引擎綁定
- 行 1209-1219：V35ConfigPanel 倉位預覽

## 替換策略
不直接綁定 DynamicForm 到 form state（因為 key 不匹配），而是：
1. 定義一個頁面本地的 STRATEGY_CONFIG_SCHEMA（使用 form state 的 key 名稱）
2. 將 DynamicForm 直接綁定到 form 的相關欄位
3. 使用 adapter 函數在 DynamicForm onChange 時更新 form state

## 頁面本地 Schema 定義（使用 form state key 名稱）
```ts
const STRATEGY_CONFIG_SCHEMA: SchemaConfig = {
  groups: [
    { name: "資金配置", fields: ["Initial_Capital", "Max_Loss_Pct"] },
    { name: "馬丁引擎", fields: ["martin_mode", "martinMultiplier", "maxMartinLevel", "martinSpacingPct", "martinLayersJson"] },
    { name: "止盈設定", fields: ["callbackPct", "kLinePeriod"] },
    { name: "進階選項", fields: ["reentryOnTrend", "maxLossUsdt"] },
  ],
  advancedFields: ["maxPositionPct", "stopLossPct", "takeProfitPct", "maxDailyLoss"],
  fields: [
    { key: "Initial_Capital", type: "number", label: "初始本金 (USDT)", default: 10000, min: 100, step: 100, description: "策略專屬本金" },
    { key: "Max_Loss_Pct", type: "number", label: "極限止損 (%)", default: 5, min: 1, max: 20, step: 0.5, description: "浮虧達本金此 % 時強制全平" },
    { key: "martin_mode", type: "select", label: "馬丁模式", default: "fixed", options: [{ label: "固定乘數", value: "fixed" }, { label: "階梯式分層", value: "layered" }] },
    { key: "martinMultiplier", type: "number", label: "馬丁倍率", default: 1.5, step: 0.1, min: 1.0, max: 3.0, condition: { field: "martin_mode", operator: "eq", value: "fixed" } },
    { key: "maxMartinLevel", type: "number", label: "最大層數", default: 11, min: 1, max: 20, step: 1 },
    { key: "martinSpacingPct", type: "number", label: "加倉間距 (%)", default: 2.0, step: 0.1, min: 0.5, max: 10 },
    { key: "martinLayersJson", type: "martinLayers", label: "階梯式馬丁乘數分層", condition: { field: "martin_mode", operator: "eq", value: "layered" }, description: "空 = 使用上方固定馬丁倍率" },
    { key: "callbackPct", type: "number", label: "回撤平倉 (%)", default: 0.1, step: 0.05, min: 0.01, max: 10, description: "移動止盈激活後回撤此 % 即平倉" },
    { key: "kLinePeriod", type: "number", label: "K 線週期 (分鐘)", default: 15, min: 1, max: 1440, step: 1 },
    { key: "reentryOnTrend", type: "boolean", label: "第 0 層順勢重入", default: true, description: "止盈後 KAMA 方向未變 → 立即重入" },
    { key: "maxLossUsdt", type: "number", label: "絕對金額限損 (USDT)", default: 100, min: 0, step: 10, description: "浮虧 ≥ 此金額 → 強制平倉（0 不啟用）" },
    // 進階欄位
    { key: "maxPositionPct", type: "number", label: "最大單筆倉位 (%)", default: 0, min: 0, max: 100, advanced: true },
    { key: "stopLossPct", type: "number", label: "止損 (%)", default: 0, min: 0, advanced: true },
    { key: "takeProfitPct", type: "number", label: "止盈 (%)", default: 0, min: 0, advanced: true },
    { key: "maxDailyLoss", type: "number", label: "每日最大虧損 (USDT)", default: 0, min: 0, advanced: true },
  ],
};
```

## 整合方式
```tsx
// 從 form state 提取 DynamicForm 需要的值
const configValues = useMemo(() => ({
  Initial_Capital: form.Initial_Capital,
  Max_Loss_Pct: form.Max_Loss_Pct,
  martin_mode: form.martinLayersJson.trim() ? "layered" : "fixed",
  martinMultiplier: form.martinMultiplier,
  maxMartinLevel: form.maxMartinLevel,
  martinSpacingPct: form.martinSpacingPct,
  martinLayersJson: form.martinLayersJson,
  callbackPct: form.callbackPct,
  kLinePeriod: form.kLinePeriod,
  reentryOnTrend: form.reentryOnTrend,
  maxLossUsdt: form.maxLossUsdt,
  maxPositionPct: form.maxPositionPct,
  stopLossPct: form.stopLossPct,
  takeProfitPct: form.takeProfitPct,
  maxDailyLoss: form.maxDailyLoss,
  // 預覽需要的額外欄位
  Base_Lot_Size: parseFloat(String(form.positionValue)) || 30,
  Martin_Step_Pct: parseFloat(form.martinSpacingPct) || 2.0,
  Martin_Multiplier: parseFloat(form.martinMultiplier) || 1.5,
  Max_Layers: parseInt(form.maxMartinLevel) || 11,
}), [form]);

// onChange handler
const handleConfigChange = (newValues: Record<string, any>) => {
  setForm(prev => ({
    ...prev,
    Initial_Capital: String(newValues.Initial_Capital ?? prev.Initial_Capital),
    Max_Loss_Pct: String(newValues.Max_Loss_Pct ?? prev.Max_Loss_Pct),
    martinMultiplier: String(newValues.martinMultiplier ?? prev.martinMultiplier),
    maxMartinLevel: String(newValues.maxMartinLevel ?? prev.maxMartinLevel),
    martinSpacingPct: String(newValues.martinSpacingPct ?? prev.martinSpacingPct),
    martinLayersJson: newValues.martinLayersJson ?? prev.martinLayersJson,
    callbackPct: String(newValues.callbackPct ?? prev.callbackPct),
    kLinePeriod: String(newValues.kLinePeriod ?? prev.kLinePeriod),
    reentryOnTrend: newValues.reentryOnTrend ?? prev.reentryOnTrend,
    maxLossUsdt: String(newValues.maxLossUsdt ?? prev.maxLossUsdt),
    maxPositionPct: String(newValues.maxPositionPct ?? prev.maxPositionPct),
    stopLossPct: String(newValues.stopLossPct ?? prev.stopLossPct),
    takeProfitPct: String(newValues.takeProfitPct ?? prev.takeProfitPct),
    maxDailyLoss: String(newValues.maxDailyLoss ?? prev.maxDailyLoss),
  }));
};
```

## 後端修復
server/routers.ts 的 v35Config zod schema 需要新增 Initial_Capital 和 First_Order_Pct：
```ts
v35Config: z.object({
  Martin_Layers: z.string().max(2000).default(""),
  Reentry_On_Trend: z.boolean().default(true),
  Max_Loss_USDT: z.number().min(0).default(100),
  Max_Loss_Pct: z.number().min(0).max(50).default(6),
  Callback_Pct: z.number().min(0.01).max(10).default(0.1),
  K_Line_Period: z.number().min(1).max(1440).default(15),
  // 新增
  Initial_Capital: z.number().min(10).default(10000),
  First_Order_Pct: z.number().min(0.01).max(100).default(0.5),
}).optional(),
```
