/**
 * V7.0 龍捲風雙渦輪 — 軍工級六大區塊配置面板
 * 完全獨立組件，不影響任何現有策略 UI
 */
import { useState, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Plus, Trash2, AlertTriangle, Shield, TrendingUp, Activity, Layers, Settings } from "lucide-react";

export interface V70Config {
  // Block 1: 基礎設定
  base_lot_size_usdt: number;
  leverage: number;
  timeframe: string;
  // Block 2: 宏觀趨勢錨 (MA200)
  ma200_enabled: boolean;
  ma200_period: number;
  ma200_type: "SMA" | "EMA";
  ma200_oscillation_filter_pct: number;
  // Block 3: KAMA 雙線
  kama_fast_er_period: number;
  kama_fast_fast_const: number;
  kama_fast_slow_const: number;
  kama_slow_er_period: number;
  kama_slow_fast_const: number;
  kama_slow_slow_const: number;
  cross_mode: "both" | "long_only" | "short_only";
  // Block 4: 出場與風控
  risk_hard_stop_pct: number;
  risk_ma_force_liq: boolean;
  risk_reverse_cross_close: boolean;
  risk_reverse_cross_profit_limit: number;
  // Block 5: 追蹤止盈
  trailing_enabled: boolean;
  trailing_activation_pct: number;
  trailing_retracement_pct: number;
  // Block 6: S 曲線階梯馬丁
  martin_enabled: boolean;
  martin_max_layers: number;
  martin_layer_tp_long: number;
  martin_layer_tp_short: number;
  martin_layers: MartinLayerV70[];
}

export interface MartinLayerV70 {
  start: number;
  end: number;
  multiplier: number;
  gap_long: number;
  gap_short: number;
}

const DEFAULT_V70_CONFIG: V70Config = {
  base_lot_size_usdt: 150.0,
  leverage: 5,
  timeframe: "5m",
  ma200_enabled: true,
  ma200_period: 200,
  ma200_type: "SMA",
  ma200_oscillation_filter_pct: 0.015,
  kama_fast_er_period: 50,
  kama_fast_fast_const: 10,
  kama_fast_slow_const: 2,
  kama_slow_er_period: 50,
  kama_slow_fast_const: 10,
  kama_slow_slow_const: 6,
  cross_mode: "both",
  risk_hard_stop_pct: 4.5,
  risk_ma_force_liq: true,
  risk_reverse_cross_close: true,
  risk_reverse_cross_profit_limit: 1.5,
  trailing_enabled: true,
  trailing_activation_pct: 3.0,
  trailing_retracement_pct: 1.5,
  martin_enabled: true,
  martin_max_layers: 11,
  martin_layer_tp_long: 0.30,
  martin_layer_tp_short: 0.20,
  martin_layers: [
    { start: 1, end: 4, multiplier: 1.5, gap_long: 0.60, gap_short: 0.40 },
    { start: 5, end: 9, multiplier: 1.1, gap_long: 1.00, gap_short: 0.70 },
    { start: 10, end: 11, multiplier: 1.0, gap_long: 1.80, gap_short: 1.20 },
  ],
};

const TIMEFRAME_OPTIONS = [
  { label: "1 分鐘", value: "1m" },
  { label: "5 分鐘", value: "5m" },
  { label: "15 分鐘", value: "15m" },
  { label: "30 分鐘", value: "30m" },
  { label: "1 小時", value: "1h" },
  { label: "2 小時", value: "2h" },
  { label: "4 小時", value: "4h" },
  { label: "1 天", value: "1d" },
  { label: "2 天", value: "2d" },
  { label: "4 天", value: "4d" },
];

interface V70ConfigPanelProps {
  config: Partial<V70Config>;
  onChange: (config: V70Config) => void;
  mode?: "editable" | "readonly";
}

export function V70ConfigPanel({ config, onChange, mode = "editable" }: V70ConfigPanelProps) {
  const cfg = useMemo(() => ({ ...DEFAULT_V70_CONFIG, ...config }), [config]);
  const readonly = mode === "readonly";

  const update = useCallback(
    (patch: Partial<V70Config>) => {
      onChange({ ...cfg, ...patch });
    },
    [cfg, onChange],
  );

  const updateLayer = useCallback(
    (idx: number, patch: Partial<MartinLayerV70>) => {
      const newLayers = [...cfg.martin_layers];
      newLayers[idx] = { ...newLayers[idx], ...patch };
      // Auto-fix start values for continuity
      for (let i = 1; i < newLayers.length; i++) {
        newLayers[i].start = newLayers[i - 1].end + 1;
      }
      // Update max_layers from last end
      const maxLayers = newLayers[newLayers.length - 1]?.end || cfg.martin_max_layers;
      update({ martin_layers: newLayers, martin_max_layers: maxLayers });
    },
    [cfg, update],
  );

  const addLayer = useCallback(() => {
    const last = cfg.martin_layers[cfg.martin_layers.length - 1];
    const newStart = last ? last.end + 1 : 1;
    const newEnd = newStart + 1;
    const newLayers = [
      ...cfg.martin_layers,
      { start: newStart, end: newEnd, multiplier: 1.0, gap_long: 1.0, gap_short: 0.8 },
    ];
    update({ martin_layers: newLayers, martin_max_layers: newEnd });
  }, [cfg, update]);

  const removeLayer = useCallback(
    (idx: number) => {
      if (cfg.martin_layers.length <= 1) return;
      const newLayers = cfg.martin_layers.filter((_, i) => i !== idx);
      // Recalculate start values
      for (let i = 1; i < newLayers.length; i++) {
        newLayers[i].start = newLayers[i - 1].end + 1;
      }
      const maxLayers = newLayers[newLayers.length - 1]?.end || 1;
      update({ martin_layers: newLayers, martin_max_layers: maxLayers });
    },
    [cfg, update],
  );

  // Calculate cumulative multiplier for each layer group
  const cumulativeMultipliers = useMemo(() => {
    const result: number[] = [];
    let cumulative = 1;
    for (const layer of cfg.martin_layers) {
      const layerCount = layer.end - layer.start + 1;
      for (let i = 0; i < layerCount; i++) {
        cumulative *= layer.multiplier;
      }
      result.push(parseFloat(cumulative.toFixed(2)));
    }
    return result;
  }, [cfg.martin_layers]);

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* ===== 區塊 1：策略基礎設定 ===== */}
        <Card className="border-blue-500/30 bg-blue-950/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Settings className="h-4 w-4 text-blue-400" />
              <span>區塊 1：策略基礎設定</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">時間框架</Label>
                <Select
                  value={cfg.timeframe}
                  onValueChange={(v) => update({ timeframe: v })}
                  disabled={readonly}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEFRAME_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">基礎下單金額 (USDT)</Label>
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={cfg.base_lot_size_usdt}
                  onChange={(e) => update({ base_lot_size_usdt: parseFloat(e.target.value) || 150 })}
                  min={1}
                  step={0.1}
                  disabled={readonly}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">槓桿倍數</Label>
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={cfg.leverage}
                  onChange={(e) => update({ leverage: Math.max(1, Math.round(parseFloat(e.target.value) || 5)) })}
                  min={1}
                  max={125}
                  step={1}
                  disabled={readonly}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ===== 區塊 2：宏觀趨勢錨 (MA200) ===== */}
        <Card className="border-amber-500/30 bg-amber-950/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-amber-400" />
              <span>區塊 2：宏觀趨勢錨 (MA200)</span>
              <div className="ml-auto">
                <Switch
                  checked={cfg.ma200_enabled}
                  onCheckedChange={(v) => update({ ma200_enabled: v })}
                  disabled={readonly}
                />
              </div>
            </CardTitle>
          </CardHeader>
          {cfg.ma200_enabled && (
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">MA 計算週期</Label>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={cfg.ma200_period}
                    onChange={(e) => update({ ma200_period: Math.max(1, parseInt(e.target.value) || 200) })}
                    min={1}
                    step={1}
                    disabled={readonly}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">MA 類型</Label>
                  <Select
                    value={cfg.ma200_type}
                    onValueChange={(v) => update({ ma200_type: v as "SMA" | "EMA" })}
                    disabled={readonly}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SMA">SMA</SelectItem>
                      <SelectItem value="EMA">EMA</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Label className="text-xs cursor-help">震盪過濾 (斜率門檻 %)</Label>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs">MA 斜率低於此值時暫停開新倉，設 0 關閉此過濾</p>
                    </TooltipContent>
                  </Tooltip>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={cfg.ma200_oscillation_filter_pct}
                    onChange={(e) => update({ ma200_oscillation_filter_pct: Math.max(0, parseFloat(e.target.value) || 0) })}
                    min={0}
                    step={0.001}
                    disabled={readonly}
                  />
                </div>
              </div>
            </CardContent>
          )}
        </Card>

        {/* ===== 區塊 3：KAMA 雙線動能參數 ===== */}
        <Card className="border-purple-500/30 bg-purple-950/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4 text-purple-400" />
              <span>區塊 3：KAMA 雙線動能參數</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* 快速線 */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-purple-300">快速線 (效率週期 / 最快常數 / 最慢常數)</Label>
              <div className="grid grid-cols-3 gap-2">
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={cfg.kama_fast_er_period}
                  onChange={(e) => update({ kama_fast_er_period: Math.max(10, parseInt(e.target.value) || 50) })}
                  min={10}
                  step={1}
                  disabled={readonly}
                  placeholder="效率週期"
                />
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={cfg.kama_fast_fast_const}
                  onChange={(e) => update({ kama_fast_fast_const: Math.max(2, parseInt(e.target.value) || 10) })}
                  min={2}
                  step={1}
                  disabled={readonly}
                  placeholder="最快常數"
                />
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={cfg.kama_fast_slow_const}
                  onChange={(e) => update({ kama_fast_slow_const: Math.max(1, parseInt(e.target.value) || 2) })}
                  min={1}
                  step={1}
                  disabled={readonly}
                  placeholder="最慢常數"
                />
              </div>
            </div>
            {/* 慢速線 */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-purple-300">慢速線 (效率週期 / 最快常數 / 最慢常數)</Label>
              <div className="grid grid-cols-3 gap-2">
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={cfg.kama_slow_er_period}
                  onChange={(e) => update({ kama_slow_er_period: Math.max(10, parseInt(e.target.value) || 50) })}
                  min={10}
                  step={1}
                  disabled={readonly}
                  placeholder="效率週期"
                />
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={cfg.kama_slow_fast_const}
                  onChange={(e) => update({ kama_slow_fast_const: Math.max(2, parseInt(e.target.value) || 10) })}
                  min={2}
                  step={1}
                  disabled={readonly}
                  placeholder="最快常數"
                />
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={cfg.kama_slow_slow_const}
                  onChange={(e) => update({ kama_slow_slow_const: Math.max(1, parseInt(e.target.value) || 6) })}
                  min={1}
                  step={1}
                  disabled={readonly}
                  placeholder="最慢常數"
                />
              </div>
            </div>
            {/* 交叉模式 */}
            <div className="space-y-1.5">
              <Label className="text-xs">交叉信號模式</Label>
              <Select
                value={cfg.cross_mode}
                onValueChange={(v) => update({ cross_mode: v as "both" | "long_only" | "short_only" })}
                disabled={readonly}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="both">雙向 (金叉做多 + 死叉做空)</SelectItem>
                  <SelectItem value="long_only">僅做多 (金叉)</SelectItem>
                  <SelectItem value="short_only">僅做空 (死叉)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* ===== 區塊 4：出場與風控 (硬保護) ===== */}
        <Card className="border-red-500/30 bg-red-950/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Shield className="h-4 w-4 text-red-400" />
              <span>區塊 4：出場與風控 (硬保護)</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Label className="text-xs cursor-help">硬止損百分比 (%)</Label>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">整體帳面虧損達此 % 強制平倉，設 0 關閉（不建議）</p>
                  </TooltipContent>
                </Tooltip>
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={cfg.risk_hard_stop_pct}
                  onChange={(e) => update({ risk_hard_stop_pct: Math.max(0, parseFloat(e.target.value) || 0) })}
                  min={0}
                  max={20}
                  step={0.1}
                  disabled={readonly}
                />
                {cfg.risk_hard_stop_pct === 0 && (
                  <p className="text-[10px] text-red-400 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> 已關閉硬止損，風險極高
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Label className="text-xs cursor-help">反向交叉浮盈上限 (%)</Label>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">僅當浮盈低於此值時才觸發反向交叉平倉</p>
                  </TooltipContent>
                </Tooltip>
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={cfg.risk_reverse_cross_profit_limit}
                  onChange={(e) => update({ risk_reverse_cross_profit_limit: Math.max(0, parseFloat(e.target.value) || 0) })}
                  min={0}
                  max={10}
                  step={0.1}
                  disabled={readonly}
                />
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <Switch
                  checked={cfg.risk_ma_force_liq}
                  onCheckedChange={(v) => update({ risk_ma_force_liq: v })}
                  disabled={readonly}
                />
                <Label className="text-xs">MA 強平保護 (穿越即平)</Label>
                <Badge variant="destructive" className="text-[9px] px-1 py-0">鐵律</Badge>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={cfg.risk_reverse_cross_close}
                  onCheckedChange={(v) => update({ risk_reverse_cross_close: v })}
                  disabled={readonly}
                />
                <Label className="text-xs">啟用反向交叉平倉</Label>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ===== 區塊 5：追蹤止盈 (利潤奔跑) ===== */}
        <Card className="border-green-500/30 bg-green-950/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-green-400" />
              <span>區塊 5：追蹤止盈 (利潤奔跑)</span>
              <div className="ml-auto">
                <Switch
                  checked={cfg.trailing_enabled}
                  onCheckedChange={(v) => update({ trailing_enabled: v })}
                  disabled={readonly}
                />
              </div>
            </CardTitle>
          </CardHeader>
          {cfg.trailing_enabled && (
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Label className="text-xs cursor-help">啟動追蹤之浮盈門檻 (%)</Label>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs">浮盈超過此值才啟動追蹤止盈</p>
                    </TooltipContent>
                  </Tooltip>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={cfg.trailing_activation_pct}
                    onChange={(e) => update({ trailing_activation_pct: Math.max(0.5, parseFloat(e.target.value) || 3.0) })}
                    min={0.5}
                    max={20}
                    step={0.1}
                    disabled={readonly}
                  />
                </div>
                <div className="space-y-1.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Label className="text-xs cursor-help">追蹤回撤幅度 (%)</Label>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs">從最高點回撤此值即平倉</p>
                    </TooltipContent>
                  </Tooltip>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={cfg.trailing_retracement_pct}
                    onChange={(e) => update({ trailing_retracement_pct: Math.max(0.1, parseFloat(e.target.value) || 1.5) })}
                    min={0.1}
                    max={10}
                    step={0.1}
                    disabled={readonly}
                  />
                </div>
              </div>
            </CardContent>
          )}
        </Card>

        {/* ===== 區塊 6：S 曲線階梯馬丁 (動態表格) ===== */}
        <Card className="border-cyan-500/30 bg-cyan-950/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Layers className="h-4 w-4 text-cyan-400" />
              <span>區塊 6：S 曲線階梯馬丁</span>
              <Badge variant="outline" className="ml-2 text-[9px]">
                總層數: {cfg.martin_max_layers}
              </Badge>
              <div className="ml-auto">
                <Switch
                  checked={cfg.martin_enabled}
                  onCheckedChange={(v) => update({ martin_enabled: v })}
                  disabled={readonly}
                />
              </div>
            </CardTitle>
          </CardHeader>
          {cfg.martin_enabled && (
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">多頭加倉層專屬止盈 (%)</Label>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={cfg.martin_layer_tp_long}
                    onChange={(e) => update({ martin_layer_tp_long: Math.max(0.05, parseFloat(e.target.value) || 0.3) })}
                    min={0.05}
                    max={5}
                    step={0.01}
                    disabled={readonly}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">空頭加倉層專屬止盈 (%)</Label>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={cfg.martin_layer_tp_short}
                    onChange={(e) => update({ martin_layer_tp_short: Math.max(0.05, parseFloat(e.target.value) || 0.2) })}
                    min={0.05}
                    max={5}
                    step={0.01}
                    disabled={readonly}
                  />
                </div>
              </div>

              {/* 動態分層表格 */}
              <div className="rounded-md border border-cyan-500/20 overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-cyan-950/30">
                      <TableHead className="text-[10px] w-16">起始層</TableHead>
                      <TableHead className="text-[10px] w-16">結束層</TableHead>
                      <TableHead className="text-[10px] w-16">乘數</TableHead>
                      <TableHead className="text-[10px] w-20">多頭間距%</TableHead>
                      <TableHead className="text-[10px] w-20">空頭間距%</TableHead>
                      <TableHead className="text-[10px] w-20">累積倍數</TableHead>
                      <TableHead className="text-[10px] w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cfg.martin_layers.map((layer, idx) => (
                      <TableRow key={idx} className="hover:bg-cyan-950/20">
                        <TableCell className="p-1">
                          <Input
                            type="number"
                            className="h-7 text-xs w-14 bg-muted/50"
                            value={layer.start}
                            disabled
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Input
                            type="number"
                            className="h-7 text-xs w-14"
                            value={layer.end}
                            onChange={(e) => {
                              const val = Math.max(layer.start, parseInt(e.target.value) || layer.start);
                              updateLayer(idx, { end: val });
                            }}
                            min={layer.start}
                            step={1}
                            disabled={readonly}
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Input
                            type="number"
                            className="h-7 text-xs w-14"
                            value={layer.multiplier}
                            onChange={(e) => updateLayer(idx, { multiplier: Math.max(0.1, parseFloat(e.target.value) || 1.0) })}
                            min={0.1}
                            step={0.1}
                            disabled={readonly}
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Input
                            type="number"
                            className="h-7 text-xs w-16"
                            value={layer.gap_long}
                            onChange={(e) => updateLayer(idx, { gap_long: Math.max(0.01, parseFloat(e.target.value) || 0.6) })}
                            min={0.01}
                            step={0.01}
                            disabled={readonly}
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Input
                            type="number"
                            className="h-7 text-xs w-16"
                            value={layer.gap_short}
                            onChange={(e) => updateLayer(idx, { gap_short: Math.max(0.01, parseFloat(e.target.value) || 0.4) })}
                            min={0.01}
                            step={0.01}
                            disabled={readonly}
                          />
                        </TableCell>
                        <TableCell className="p-1 text-center">
                          <Badge variant="secondary" className="text-[10px]">
                            {cumulativeMultipliers[idx]}x
                          </Badge>
                        </TableCell>
                        <TableCell className="p-1">
                          {!readonly && cfg.martin_layers.length > 1 && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-red-400 hover:text-red-300"
                              onClick={() => removeLayer(idx)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {!readonly && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs border-dashed border-cyan-500/30 text-cyan-400 hover:bg-cyan-950/30"
                  onClick={addLayer}
                >
                  <Plus className="h-3 w-3 mr-1" /> 新增分層
                </Button>
              )}

              {/* 提示框 */}
              <div className="rounded-md bg-muted/30 p-2.5 space-y-1 text-[10px] text-muted-foreground">
                <p className="flex items-center gap-1">
                  <span className="text-green-400">🟢</span> 多頭間距：僅在價格 &gt; MA200 且價格下跌偏離時觸發加倉
                </p>
                <p className="flex items-center gap-1">
                  <span className="text-red-400">🔴</span> 空頭間距：僅在價格 &lt; MA200 且價格上漲偏離時觸發加倉
                </p>
                <p className="flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 text-amber-400" />
                  當前表格總層數 = 最終結束層的數值，必須等於上方 Max_Layers 設定值
                </p>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </TooltipProvider>
  );
}

export { DEFAULT_V70_CONFIG };
export function serializeV70Config(cfg: V70Config): Record<string, any> {
  return {
    base_lot_size_usdt: cfg.base_lot_size_usdt,
    leverage: cfg.leverage,
    timeframe: cfg.timeframe,
    ma200_enabled: cfg.ma200_enabled,
    ma200_period: cfg.ma200_period,
    ma200_type: cfg.ma200_type,
    ma200_oscillation_filter_pct: cfg.ma200_oscillation_filter_pct,
    kama_fast_er_period: cfg.kama_fast_er_period,
    kama_fast_fast_const: cfg.kama_fast_fast_const,
    kama_fast_slow_const: cfg.kama_fast_slow_const,
    kama_slow_er_period: cfg.kama_slow_er_period,
    kama_slow_fast_const: cfg.kama_slow_fast_const,
    kama_slow_slow_const: cfg.kama_slow_slow_const,
    cross_mode: cfg.cross_mode,
    risk_hard_stop_pct: cfg.risk_hard_stop_pct,
    risk_ma_force_liq: cfg.risk_ma_force_liq,
    risk_reverse_cross_close: cfg.risk_reverse_cross_close,
    risk_reverse_cross_profit_limit: cfg.risk_reverse_cross_profit_limit,
    trailing_enabled: cfg.trailing_enabled,
    trailing_activation_pct: cfg.trailing_activation_pct,
    trailing_retracement_pct: cfg.trailing_retracement_pct,
    martin_enabled: cfg.martin_enabled,
    martin_max_layers: cfg.martin_max_layers,
    martin_layer_tp_long: cfg.martin_layer_tp_long,
    martin_layer_tp_short: cfg.martin_layer_tp_short,
    martin_layers: JSON.stringify(cfg.martin_layers),
  };
}

export function deserializeV70Config(raw: Record<string, any> | null | undefined): V70Config {
  if (!raw) return { ...DEFAULT_V70_CONFIG };
  let layers = DEFAULT_V70_CONFIG.martin_layers;
  if (raw.martin_layers) {
    try {
      const parsed = typeof raw.martin_layers === "string" ? JSON.parse(raw.martin_layers) : raw.martin_layers;
      if (Array.isArray(parsed)) layers = parsed;
    } catch { /* use default */ }
  }
  return {
    base_lot_size_usdt: Number(raw.base_lot_size_usdt) || DEFAULT_V70_CONFIG.base_lot_size_usdt,
    leverage: Number(raw.leverage) || DEFAULT_V70_CONFIG.leverage,
    timeframe: String(raw.timeframe || DEFAULT_V70_CONFIG.timeframe),
    ma200_enabled: raw.ma200_enabled !== false,
    ma200_period: Number(raw.ma200_period) || DEFAULT_V70_CONFIG.ma200_period,
    ma200_type: (raw.ma200_type === "EMA" ? "EMA" : "SMA"),
    ma200_oscillation_filter_pct: Number(raw.ma200_oscillation_filter_pct) ?? DEFAULT_V70_CONFIG.ma200_oscillation_filter_pct,
    kama_fast_er_period: Number(raw.kama_fast_er_period) || DEFAULT_V70_CONFIG.kama_fast_er_period,
    kama_fast_fast_const: Number(raw.kama_fast_fast_const) || DEFAULT_V70_CONFIG.kama_fast_fast_const,
    kama_fast_slow_const: Number(raw.kama_fast_slow_const) || DEFAULT_V70_CONFIG.kama_fast_slow_const,
    kama_slow_er_period: Number(raw.kama_slow_er_period) || DEFAULT_V70_CONFIG.kama_slow_er_period,
    kama_slow_fast_const: Number(raw.kama_slow_fast_const) || DEFAULT_V70_CONFIG.kama_slow_fast_const,
    kama_slow_slow_const: Number(raw.kama_slow_slow_const) || DEFAULT_V70_CONFIG.kama_slow_slow_const,
    cross_mode: (["both", "long_only", "short_only"].includes(raw.cross_mode) ? raw.cross_mode : "both") as "both" | "long_only" | "short_only",
    risk_hard_stop_pct: Number(raw.risk_hard_stop_pct) ?? DEFAULT_V70_CONFIG.risk_hard_stop_pct,
    risk_ma_force_liq: raw.risk_ma_force_liq !== false,
    risk_reverse_cross_close: raw.risk_reverse_cross_close !== false,
    risk_reverse_cross_profit_limit: Number(raw.risk_reverse_cross_profit_limit) ?? DEFAULT_V70_CONFIG.risk_reverse_cross_profit_limit,
    trailing_enabled: raw.trailing_enabled !== false,
    trailing_activation_pct: Number(raw.trailing_activation_pct) || DEFAULT_V70_CONFIG.trailing_activation_pct,
    trailing_retracement_pct: Number(raw.trailing_retracement_pct) || DEFAULT_V70_CONFIG.trailing_retracement_pct,
    martin_enabled: raw.martin_enabled !== false,
    martin_max_layers: Number(raw.martin_max_layers) || DEFAULT_V70_CONFIG.martin_max_layers,
    martin_layer_tp_long: Number(raw.martin_layer_tp_long) || DEFAULT_V70_CONFIG.martin_layer_tp_long,
    martin_layer_tp_short: Number(raw.martin_layer_tp_short) || DEFAULT_V70_CONFIG.martin_layer_tp_short,
    martin_layers: layers,
  };
}
