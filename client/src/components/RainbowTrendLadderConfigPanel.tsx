import { useMemo, type ComponentType, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Clock3,
  Crosshair,
  Gauge,
  Layers3,
  LockKeyhole,
  Radar,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  Target,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { RainbowTrendLadderAiAdvisor } from "@/components/RainbowTrendLadderAiAdvisor";
import { K_LINE_PERIODS } from "../pages/Strategies";
import {
  createRainbowTrendLadderDefaultConfig,
  deriveRainbowTrendLadderFinalEnabledLayer,
  normalizeRainbowTrendLadderConfig,
  validateRainbowTrendLadderConfig,
  type RainbowTrendLadderBaseLine,
  type RainbowTrendLadderConfig,
  type RainbowTrendLadderLayerConfig,
  type RainbowTrendLadderLineConfig,
  type RainbowTrendLadderLineSource,
} from "@shared/strategies/rainbowTrendLadder";

export interface RainbowTrendLadderConfigPanelProps {
  value: unknown;
  onChange: (config: RainbowTrendLadderConfig) => void;
  disabled?: boolean;
  className?: string;
  context?: "strategy" | "backtest" | "snapshot";
}

interface NumberControlProps {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  description?: string;
  disabled?: boolean;
}

function NumberControl({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  description,
  disabled,
}: NumberControlProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">
          {label}
        </Label>
        {unit ? <span className="font-mono text-[10px] text-cyan-300/80">{unit}</span> : null}
      </div>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-10 border-slate-700/90 bg-[#050b11]/90 font-mono text-sm text-slate-100 shadow-inner shadow-black/30 transition-colors focus-visible:border-cyan-300/70 focus-visible:ring-cyan-300/20"
      />
      {description ? <p className="text-[10px] leading-4 text-slate-500">{description}</p> : null}
    </div>
  );
}

function Sector({
  index,
  title,
  subtitle,
  icon: Icon,
  tone = "cyan",
  children,
}: {
  index: string;
  title: string;
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
  tone?: "cyan" | "amber" | "emerald" | "rose" | "violet";
  children: ReactNode;
}) {
  const tones = {
    cyan: "border-cyan-400/25 bg-cyan-400/5 text-cyan-300",
    amber: "border-amber-400/25 bg-amber-400/5 text-amber-300",
    emerald: "border-emerald-400/25 bg-emerald-400/5 text-emerald-300",
    rose: "border-rose-400/25 bg-rose-400/5 text-rose-300",
    violet: "border-violet-400/25 bg-violet-400/5 text-violet-300",
  };
  return (
    <section className="min-w-0 max-w-full overflow-hidden rounded-xl border border-slate-800 bg-[#071018]/90 shadow-[0_18px_55px_-36px_rgba(0,0,0,1)]">
      <header className="flex min-w-0 items-start gap-3 border-b border-slate-800/90 bg-slate-900/70 px-3 py-3.5 sm:px-4">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border", tones[tone])}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] tracking-[0.24em] text-slate-500">SECTOR {index}</span>
            <h3 className="break-words text-sm font-black tracking-wide text-slate-100">{title}</h3>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p>
        </div>
      </header>
      <div className="min-w-0 max-w-full p-3 sm:p-4">{children}</div>
    </section>
  );
}

function ToggleRow({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  danger = false,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <div className={cn(
      "flex min-w-0 items-center justify-between gap-3 rounded-lg border p-3 sm:gap-4 sm:p-3.5",
      danger ? "border-rose-500/25 bg-rose-500/5" : "border-slate-800 bg-slate-900/55",
    )}>
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className={cn("text-sm font-bold", danger ? "text-rose-100" : "text-slate-100")}>{title}</Label>
        <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
      </div>
      <Switch className="shrink-0" id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

function cloneConfig(config: RainbowTrendLadderConfig): RainbowTrendLadderConfig {
  return {
    ...config,
    Lines: config.Lines.map((line) => ({ ...line })),
    Base_Lot_Size: { ...config.Base_Lot_Size },
    Martin_Layers: config.Martin_Layers.map((layer) => ({ ...layer })),
  };
}

function sourceLabel(source: RainbowTrendLadderLineSource): string {
  return source === "hlc3" ? "HLC3" : source.toUpperCase();
}

export function RainbowTrendLadderConfigPanel({
  value,
  onChange,
  disabled = false,
  className,
  context = "strategy",
}: RainbowTrendLadderConfigPanelProps) {
  const config = useMemo(() => normalizeRainbowTrendLadderConfig(value), [value]);
  const validation = useMemo(() => validateRainbowTrendLadderConfig(config), [config]);
  const configuredFinalLayer = deriveRainbowTrendLadderFinalEnabledLayer(config.Martin_Layers);
  const finalLayer = Math.min(config.Max_Layers, configuredFinalLayer);
  const contextLabel = context === "backtest" ? "同源回測" : context === "snapshot" ? "快照覆核" : "隔離部署";

  const layerRows = useMemo(() => {
    let cumulativeSpacingPct = 0;
    let cumulativeLot = 0;
    return config.Martin_Layers.slice(0, 20).map((layer) => {
      if (layer.enabled) {
        cumulativeSpacingPct += layer.triggerSpacingPct;
        cumulativeLot += layer.lotValue;
      }
      return { layer, cumulativeSpacingPct, cumulativeLot };
    });
  }, [config.Martin_Layers]);

  const updateConfig = (patch: Partial<RainbowTrendLadderConfig>) => {
    onChange({ ...cloneConfig(config), ...patch });
  };

  const updateLine = (index: number, patch: Partial<RainbowTrendLadderLineConfig>) => {
    updateConfig({
      Lines: config.Lines.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : { ...line }),
    });
  };

  const updateLayer = (index: number, patch: Partial<RainbowTrendLadderLayerConfig>) => {
    updateConfig({
      Martin_Layers: config.Martin_Layers.map((layer, layerIndex) => layerIndex === index ? { ...layer, ...patch } : { ...layer }),
    });
  };

  return (
    <div
      data-testid="rainbow-trend-ladder-config-panel"
      className={cn(
        "relative w-full min-w-0 max-w-full [contain:inline-size] overflow-hidden rounded-2xl border border-slate-700/80 bg-[#040a10] text-slate-100 shadow-[0_28px_90px_-42px_rgba(0,0,0,1)]",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 opacity-[0.18] [background-image:linear-gradient(rgba(34,211,238,.13)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,.13)_1px,transparent_1px)] [background-size:24px_24px]" />
      <div className="relative min-w-0 max-w-full">
        <div className="min-w-0 max-w-full border-b border-slate-700/90 bg-[radial-gradient(circle_at_12%_0%,rgba(34,211,238,.18),transparent_34%),radial-gradient(circle_at_88%_8%,rgba(249,115,22,.16),transparent_30%),linear-gradient(135deg,#0d1b27_0%,#050a10_72%)] p-4 sm:p-6">
          <div className="flex min-w-0 flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="border border-cyan-300/35 bg-cyan-300/10 font-mono text-[10px] tracking-[0.18em] text-cyan-200 hover:bg-cyan-300/10">RAINBOW TREND / LADDER / V1</Badge>
                <Badge className="border border-violet-300/30 bg-violet-300/10 font-mono text-[10px] tracking-[0.14em] text-violet-200 hover:bg-violet-300/10">{contextLabel}</Badge>
                <Badge className={cn(
                  "border font-mono text-[10px] tracking-[0.14em] hover:bg-current/10",
                  config.Live_Trading_Armed
                    ? "border-rose-300/40 bg-rose-300/10 text-rose-200"
                    : "border-emerald-300/30 bg-emerald-300/10 text-emerald-200",
                )}>
                  {config.Live_Trading_Armed ? "LIVE ARMED" : "SAFE LOCKED"}
                </Badge>
              </div>
              <h2 className="mt-4 text-xl font-black tracking-tight text-white sm:text-2xl">七彩虹線趨勢跟蹤階梯馬丁策略</h2>
              <p className="mt-2 max-w-3xl text-xs leading-6 text-slate-400 sm:text-sm">
                七線 SMA 完成趨勢、排列、穿越與波動區間四重確認；成交後切換持倉管理週期，以原始進場價累計多層距離，並由動態止盈與風控鐵幕統一離場。
              </p>
            </div>

            <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4 xl:min-w-[520px]">
              {[
                { label: "契約", value: validation.valid ? "VALID" : "REVIEW", icon: ShieldCheck, ok: validation.valid },
                { label: "雙節奏", value: `${config.Entry_Timeframe_Minutes}M / ${config.Management_Interval_Minutes}M`, icon: Clock3, ok: true },
                { label: "最終戰層", value: `${finalLayer || 0} L`, icon: Layers3, ok: finalLayer > 0 },
                { label: "累積手數", value: layerRows.at(-1)?.cumulativeLot.toFixed(2) ?? "0.00", icon: Gauge, ok: true },
              ].map((item) => (
                <div key={item.label} className="rounded-lg border border-slate-700/80 bg-black/30 px-3 py-3">
                  <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.15em] text-slate-500">
                    <item.icon className={cn("h-3.5 w-3.5", item.ok ? "text-emerald-300" : "text-amber-300")} />
                    {item.label}
                  </div>
                  <div className={cn("mt-2 font-mono text-sm font-black", item.ok ? "text-slate-100" : "text-amber-200")}>{item.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="min-w-0 max-w-full space-y-4 p-3 sm:p-5">
          <Sector index="01" title="任務時序與配置底倉" subtitle="新策略使用獨立設定與狀態；進場週期只在新收盤 K 棒掃描，持倉管理週期固定每分鐘評估。" icon={Crosshair}>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">進場週期</Label>
                <Select
                  value={String(config.Entry_Timeframe_Minutes)}
                  onValueChange={(value) => updateConfig({ Entry_Timeframe_Minutes: Number(value) })}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-10 border-slate-700/90 bg-[#050b11]/90 font-mono text-sm text-slate-100"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {K_LINE_PERIODS.map((p: { value: number; label: string }) => (
                      <SelectItem key={p.value} value={String(p.value)}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">持倉管理週期</Label>
                <Select
                  value={String(config.Management_Interval_Minutes)}
                  onValueChange={(value) => updateConfig({ Management_Interval_Minutes: Number(value) })}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-10 border-slate-700/90 bg-[#050b11]/90 font-mono text-sm text-slate-100"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {K_LINE_PERIODS.map((p: { value: number; label: string }) => (
                      <SelectItem key={p.value} value={String(p.value)}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <NumberControl id="rtl-capital" label="初始資金" value={config.Initial_Capital} onChange={(next) => updateConfig({ Initial_Capital: next })} min={1} step={100} unit="USDT" disabled={disabled} />
              <NumberControl id="rtl-point-value" label="每點價格" value={config.Point_Value} onChange={(next) => updateConfig({ Point_Value: next })} min={0.00000001} step={0.1} unit="USDT" disabled={disabled} />
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">配置底倉單位</Label>
                    <Select
                      value={config.Base_Lot_Size.mode}
                      onValueChange={(mode: "quantity" | "usdt") => {
                        const newBaseLotSize = { ...config.Base_Lot_Size, mode };
                        let newMartinLayers = config.Martin_Layers;
                        if (mode === "usdt") {
                          newMartinLayers = config.Martin_Layers.map((layer) => ({
                            ...layer,
                            lotValue: newBaseLotSize.value * layer.layer,
                          }));
                        } else { // quantity 模式下，lotValue 應根據 lotMultiplier 重新計算
                          newMartinLayers = config.Martin_Layers.map((layer) => ({
                            ...layer,
                            lotValue: newBaseLotSize.value * layer.lotMultiplier,
                          }));
                        }
                        updateConfig({ Base_Lot_Size: newBaseLotSize, Martin_Layers: newMartinLayers });
                      }}
                      disabled={disabled}
                    >
                  <SelectTrigger className="h-10 border-slate-700/90 bg-[#050b11]/90 font-mono text-sm text-slate-100"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="quantity">幣數 QUANTITY</SelectItem><SelectItem value="usdt">金額 USDT</SelectItem></SelectContent>
                </Select>
              </div>
              <NumberControl
                id="rtl-base-lot"
                label="配置底倉數值"
                value={config.Base_Lot_Size.value}
                onChange={(next) => {
                  const newBaseLotSize = { ...config.Base_Lot_Size, value: next };
                  let newMartinLayers = config.Martin_Layers;
                  if (newBaseLotSize.mode === "usdt") {
                    newMartinLayers = config.Martin_Layers.map((layer) => ({
                      ...layer,
                      lotValue: newBaseLotSize.value * layer.layer,
                    }));
                  }
                  updateConfig({ Base_Lot_Size: newBaseLotSize, Martin_Layers: newMartinLayers });
                }}
                min={0.00000001}
                step={config.Base_Lot_Size.mode === "usdt" ? 1 : 0.01}
                unit={config.Base_Lot_Size.mode.toUpperCase()}
                disabled={disabled}
              />
            </div>
          </Sector>

          <Sector index="02" title="七線 SMA 戰術陣列" subtitle="每條線均直接連接底層計算；L5 是穿越觸發器，L6／L7 組成波動區間過濾。" icon={Activity} tone="emerald">
            <div data-testid="rtl-lines-scroll" role="region" aria-label="七線 SMA 設定表，可水平捲動" tabIndex={0} className="w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-xl border border-slate-800">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="bg-slate-950/80 text-[9px] uppercase tracking-[0.16em] text-slate-500">
                  <tr><th className="px-3 py-3">線別</th><th className="px-3 py-3">戰術名稱</th><th className="px-3 py-3">週期</th><th className="px-3 py-3">價格來源</th><th className="px-3 py-3">色譜</th><th className="px-3 py-3">底層角色</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-[#050b11]/70">
                  {config.Lines.map((line, index) => (
                    <tr key={line.id}>
                      <td className="px-3 py-3"><span className="font-mono font-black text-cyan-200">{line.id}</span></td>
                      <td className="px-3 py-3"><Input value={line.label} maxLength={40} disabled={disabled} onChange={(event) => updateLine(index, { label: event.target.value })} className="h-9 min-w-[190px] border-slate-700 bg-slate-950/70 text-xs" /></td>
                      <td className="px-3 py-3"><Input type="number" min={1} max={250} step={1} value={line.period} disabled={disabled} onChange={(event) => updateLine(index, { period: Number(event.target.value) })} className="h-9 w-24 border-slate-700 bg-slate-950/70 font-mono text-xs" /></td>
                      <td className="px-3 py-3">
                        <Select value={line.source} onValueChange={(source: RainbowTrendLadderLineSource) => updateLine(index, { source })} disabled={disabled}>
                          <SelectTrigger className="h-9 w-28 border-slate-700 bg-slate-950/70 font-mono text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="close">CLOSE</SelectItem><SelectItem value="hlc3">HLC3</SelectItem><SelectItem value="high">HIGH</SelectItem><SelectItem value="low">LOW</SelectItem></SelectContent>
                        </Select>
                      </td>
                      <td className="px-3 py-3"><input aria-label={`${line.id} 色譜`} type="color" value={line.color} disabled={disabled} onChange={(event) => updateLine(index, { color: event.target.value })} className="h-9 w-12 cursor-pointer rounded border border-slate-700 bg-transparent p-1" /></td>
                      <td className="px-3 py-3 text-slate-400">{line.id === "L5" ? "入場穿越觸發" : line.id === "L6" ? "波峰確認" : line.id === "L7" ? "波谷確認" : `${sourceLabel(line.source)} 趨勢斜率／排列`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {["L1／L2／L3／L4 全部同向斜率", "多空指定排列必須完整成立", "L5 穿越 L4／L3／L2／L1", "L5 必須仍位於 L7～L6 區間內"].map((rule, index) => (
                <div key={rule} className="flex gap-2 rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3 text-xs text-slate-300"><span className="font-mono text-emerald-300">0{index + 1}</span>{rule}</div>
              ))}
            </div>
          </Sector>

          <Sector index="03" title="階梯馬丁矩陣" subtitle="間距從原始進場價按層累加；lotValue 是真正下單值，倍率只作規格與稽核對照。" icon={Layers3} tone="violet">
            <div data-testid="rtl-layers-scroll" role="region" aria-label="八層階梯馬丁設定表，可水平捲動" tabIndex={0} className="w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-xl border border-slate-800">
              <table className="w-full min-w-[900px] text-left text-xs">
                <thead className="bg-slate-950/80 text-[9px] uppercase tracking-[0.16em] text-slate-500">
                  <tr><th className="px-3 py-3">啟用</th><th className="px-3 py-3">層級</th><th className="px-3 py-3">本層間距 %</th><th className="px-3 py-3">累積間距 %</th><th className="px-3 py-3">倍率</th><th className="px-3 py-3">本層手數</th><th className="px-3 py-3">累積手數</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-[#050b11]/70">
                  {layerRows.map(({ layer, cumulativeSpacingPct, cumulativeLot }, index) => (
                    <tr key={layer.layer} className={cn(!layer.enabled && "opacity-45")}>
                      <td className="px-3 py-3"><Switch checked={layer.enabled} onCheckedChange={(enabled) => updateLayer(index, { enabled })} disabled={disabled || layer.layer === 1} /></td>
                      <td className="px-3 py-3 font-mono font-black text-violet-200">L{layer.layer}</td>
                      <td className="px-3 py-3"><Input type="number" min={0} max={100} step={0.01} value={layer.triggerSpacingPct} disabled={disabled || layer.layer === 1} onChange={(event) => updateLayer(index, { triggerSpacingPct: Number(event.target.value) })} className="h-9 w-28 border-slate-700 bg-slate-950/70 font-mono text-xs" /></td>
                      <td className="px-3 py-3 font-mono text-cyan-200">{cumulativeSpacingPct.toFixed(2)}%</td>
                      <td className="px-3 py-3"><Input type="number" min={0.01} max={100} step={0.1} value={layer.lotMultiplier} disabled={disabled} onChange={(event) => updateLayer(index, { lotMultiplier: Number(event.target.value) })} className="h-9 w-24 border-slate-700 bg-slate-950/70 font-mono text-xs" /></td>
                      <td className="px-3 py-3">
                        <Input
                          type="number"
                          min={0.00000001}
                          step={0.01}
                          value={layer.lotValue}
                          disabled={disabled || config.Base_Lot_Size.mode === "usdt"} // USDT 模式下唯讀
                          onChange={(event) => updateLayer(index, { lotValue: Number(event.target.value) })}
                          className="h-9 w-28 border-slate-700 bg-slate-950/70 font-mono text-xs"
                        />
                      </td>
                      <td className="px-3 py-3 font-mono text-emerald-200">{cumulativeLot.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Sector>

          <div className="grid gap-4 xl:grid-cols-2">
            <Sector index="04" title="動態止盈與趨勢反轉" subtitle="持倉後不再重跑入場條件，只按盈利峰值、回撤與基礎趨勢線轉向管理。" icon={Target} tone="amber">
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberControl id="rtl-trailing-activate" label="追蹤啟動盈利" value={config.Trailing_Activation_Pct} onChange={(next) => updateConfig({ Trailing_Activation_Pct: next })} min={0.01} max={100} step={0.1} unit="%" disabled={disabled} />
                <NumberControl id="rtl-trailing-callback" label="最高盈利回撤" value={config.Trailing_Callback_Pct} onChange={(next) => updateConfig({ Trailing_Callback_Pct: next })} min={0.01} max={100} step={0.01} unit="%" disabled={disabled} />
                <NumberControl id="rtl-trend-deviation" label="趨勢線偏離" value={config.Trend_Deviation_Points} onChange={(next) => updateConfig({ Trend_Deviation_Points: next })} min={0} max={1_000_000} step={1} unit="POINT" disabled={disabled} />
                <div className="space-y-2">
                  <Label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">基礎趨勢線</Label>
                  <Select value={config.Trend_Base_Line} onValueChange={(line: RainbowTrendLadderBaseLine) => updateConfig({ Trend_Base_Line: line })} disabled={disabled}>
                    <SelectTrigger className="h-10 border-slate-700/90 bg-[#050b11]/90 font-mono text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>{["L1", "L2", "L3", "L4"].map((line) => <SelectItem key={line} value={line}>{line}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
            </Sector>

            <Sector index="05" title="交易品質鐵幕" subtitle="每次進場與加倉都以公開即時 bid／ask fail-closed 檢查；缺少報價時拒絕送單。" icon={Radar} tone="rose">
              <div className="grid gap-4 sm:grid-cols-3">
                <NumberControl id="rtl-spread" label="最大點差" value={config.Max_Spread_Points} onChange={(next) => updateConfig({ Max_Spread_Points: next })} min={0} max={1_000_000} step={1} unit="POINT" disabled={disabled} />
                <NumberControl id="rtl-slippage" label="最大滑點" value={config.Max_Slippage_Points} onChange={(next) => updateConfig({ Max_Slippage_Points: next })} min={0} max={1_000_000} step={1} unit="POINT" disabled={disabled} />
                <NumberControl id="rtl-margin" label="保證金上限" value={config.Max_Margin_Usage_Pct} onChange={(next) => updateConfig({ Max_Margin_Usage_Pct: next })} min={0.01} max={100} step={1} unit="%" disabled={disabled} />
              </div>
            </Sector>
          </div>

          <Sector index="06" title="隔離、安全與 KILL 邊界" subtitle="這些不變量保證新策略不會接管 20415 或其他策略的帳戶聚合持倉。" icon={LockKeyhole} tone="rose">
            <div className="grid gap-3 lg:grid-cols-2">
              <ToggleRow id="rtl-close-margin" title="保證金越界立即全平" description="達到 70% 時先停止加倉；開啟時只對已證明屬於本策略的持倉執行離場。" checked={config.Close_On_Margin_Breach} onCheckedChange={(checked) => updateConfig({ Close_On_Margin_Breach: checked })} disabled={disabled} />
              <ToggleRow id="rtl-reentry-wait" title="平倉後等待下一根 M30" description="重置層級與成本後，必須等新的 M30 收盤才重新掃描入場。" checked={config.Reentry_Wait_Next_M30_Close} onCheckedChange={(checked) => updateConfig({ Reentry_Wait_Next_M30_Close: checked })} disabled={disabled} />
              <ToggleRow id="rtl-dedicated" title="只允許專用交易帳戶" description="實盤武裝的必要條件；禁止與 20415 或其他 7×24 策略共用聚合持倉。" checked={config.Require_Dedicated_Account} onCheckedChange={(checked) => updateConfig({ Require_Dedicated_Account: checked })} disabled={disabled} />
              <ToggleRow id="rtl-kill-owned" title="KILL 只平本策略自有持倉" description="數量或方向無法證明所有權時，KILL 只鎖定策略並拒絕聚合平倉。" checked={config.Kill_Close_Only_Owned_Position} onCheckedChange={(checked) => updateConfig({ Kill_Close_Only_Owned_Position: checked })} disabled={disabled} />
            </div>
            <div className="mt-3">
              <ToggleRow id="rtl-live-armed" title="實盤交易武裝" description="預設關閉。只有專用帳戶、所有權驗證、模擬盤與回測均完成後才可人工開啟；建立策略後仍會保持停用。" checked={config.Live_Trading_Armed} onCheckedChange={(checked) => updateConfig({ Live_Trading_Armed: checked })} disabled={disabled} danger />
            </div>
          </Sector>

          <Sector index="07" title="回測與持倉控制區" subtitle="資料分片、每日邊界與完整回測終點是三個獨立事件；任何選項都不會在七天分片邊界平倉。" icon={Sliders} tone="violet">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">執行層數上限</Label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="1"
                    max={config.Martin_Layers.length}
                    value={config.Max_Layers}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      updateConfig({
                        Max_Layers: Number.isFinite(next)
                          ? Math.max(1, Math.min(config.Martin_Layers.length, Math.trunc(next)))
                          : finalLayer,
                      });
                    }}
                    disabled={disabled}
                    className="h-10 flex-1 rounded-lg border border-slate-700/90 bg-[#050b11]/90 px-3 font-mono text-sm text-slate-100 placeholder-slate-600 focus:border-cyan-400/50 focus:outline-none focus:ring-1 focus:ring-cyan-400/30"
                  />
                  <span className="flex items-center text-xs font-mono text-slate-500">層</span>
                </div>
                <p className="text-[10px] text-slate-500">目前逐層表共 {config.Martin_Layers.length} 層；底層只會執行此上限內已啟用的層。</p>
              </div>
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">最長持倉時間</Label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="0"
                    max="9999"
                    value={config.Max_Hold_Hours}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      updateConfig({ Max_Hold_Hours: Number.isFinite(next) ? Math.max(0, Math.min(9999, next)) : 72 });
                    }}
                    disabled={disabled}
                    className="h-10 flex-1 rounded-lg border border-slate-700/90 bg-[#050b11]/90 px-3 font-mono text-sm text-slate-100 placeholder-slate-600 focus:border-cyan-400/50 focus:outline-none focus:ring-1 focus:ring-cyan-400/30"
                  />
                  <span className="flex items-center text-xs font-mono text-slate-500">小時</span>
                </div>
                <p className="text-[10px] text-slate-500">設為 0 表示無時間限制，持倉直到盈利或風控觸發</p>
              </div>
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">完整回測終點</Label>
                <Select
                  value={config.Backtest_End_Position_Policy}
                  onValueChange={(next) => updateConfig({ Backtest_End_Position_Policy: next as "mark_to_market" | "force_close" })}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-10 border-slate-700/90 bg-[#050b11]/90 font-mono text-xs text-slate-100">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mark_to_market">按市價標記（推薦）</SelectItem>
                    <SelectItem value="force_close">只在全域終點平倉</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-slate-500">按市價標記保留未平倉狀態，只把浮動盈虧計入期末權益。</p>
              </div>
              <div className="flex items-end">
                <ToggleRow id="rtl-force-close" title="每日邊界強制平倉" description="預設關閉。啟用後只在新 UTC 交易日第一根管理 K 線平倉；與七天資料分片及完整回測終點無關。" checked={config.Force_Close_On_Day_Start} onCheckedChange={(checked) => updateConfig({ Force_Close_On_Day_Start: checked })} disabled={disabled} />
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-xs leading-5 text-amber-100/90">
                <span className="font-bold">⚠️ 風險提示：</span>
                執行層數上限不得超過目前逐層表；Max_Hold_Hours 設為 0 代表不使用時間上限。完整回測終點預設按市價標記，避免為報表製造不存在的成交。
              </p>
            </div>
          </Sector>

          <div className={cn(
            "rounded-xl border p-4",
            validation.valid ? "border-emerald-500/25 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5",
          )}>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex gap-3">
                {validation.valid ? <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" /> : <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />}
                <div className="min-w-0">
                  <h4 className="text-sm font-black text-slate-100">{validation.valid ? "V1 契約已通過" : `需要修正 ${validation.issues.length} 項設定`}</h4>
                  <p className="mt-1 text-xs leading-5 text-slate-500">所有欄位直接連接新策略底層；不會回退或寫入 20415 的設定鍵。</p>
                  {!validation.valid ? (
                    <ul className="mt-3 space-y-1.5 text-xs text-amber-100/90">
                      {validation.issues.slice(0, 8).map((issue) => <li key={`${issue.path}-${issue.message}`}>• <span className="font-mono text-amber-300">{issue.path}</span>：{issue.message}</li>)}
                    </ul>
                  ) : null}
                </div>
              </div>
              {!disabled ? (
                <Button type="button" variant="outline" className="shrink-0 border-slate-700 bg-slate-950/50 text-slate-200" onClick={() => onChange(createRainbowTrendLadderDefaultConfig())}>
                  <RotateCcw className="mr-2 h-4 w-4" />恢復原始規格
                </Button>
              ) : null}
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 text-xs leading-5 text-slate-400">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
            <div className="min-w-0 break-words"><span className="font-bold text-cyan-100">AI 輔助邊界：</span>策略工作室可以分析與產生本 V1 契約的參數建議，但儲存前仍須通過同一共享驗證器；AI 無權更改 20415、啟用策略或解除 KILL 鎖。</div>
          </div>

          <RainbowTrendLadderAiAdvisor config={config} onApply={onChange} disabled={disabled} />

          {config.Live_Trading_Armed ? (
            <div className="flex items-start gap-3 rounded-xl border border-rose-500/35 bg-rose-500/10 p-4 text-xs leading-5 text-rose-100">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
              <div><span className="font-black">實盤武裝已寫入配置。</span>這不等於策略已啟用；仍須人工覆核專用帳戶、交易所最小單量、模擬盤結果及策略啟用開關。</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
