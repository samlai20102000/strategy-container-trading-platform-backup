import { useMemo } from "react";
import {
  Activity,
  ArrowRightLeft,
  Clock3,
  Crosshair,
  Gauge,
  Layers3,
  LockKeyhole,
  Plus,
  RadioTower,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  createRainbow20415DefaultConfig,
  deriveRainbow20415FinalEnabledLayer,
  formatRainbow20415Timeframe,
  normalizeRainbow20415Config,
  validateRainbow20415Config,
  type Rainbow20415Config,
  type Rainbow20415LineConfig,
  type Rainbow20415MartinRange,
} from "@shared/strategies/rainbow20415";

export interface Rainbow20415ConfigPanelProps {
  value: unknown;
  onChange: (config: Rainbow20415Config) => void;
  disabled?: boolean;
  className?: string;
  context?: "strategy" | "backtest" | "snapshot";
}

interface NumberFieldProps {
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

function NumberField({
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
}: NumberFieldProps) {
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
        className="h-10 border-slate-700/90 bg-[#050b11]/85 font-mono text-sm text-slate-100 shadow-inner shadow-black/30 transition-colors focus-visible:border-cyan-300/70 focus-visible:ring-cyan-300/20"
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
  icon: React.ComponentType<{ className?: string }>;
  tone?: "cyan" | "amber" | "emerald" | "rose";
  children: React.ReactNode;
}) {
  const tones = {
    cyan: "border-cyan-400/25 bg-cyan-400/5 text-cyan-300",
    amber: "border-amber-400/25 bg-amber-400/5 text-amber-300",
    emerald: "border-emerald-400/25 bg-emerald-400/5 text-emerald-300",
    rose: "border-rose-400/25 bg-rose-400/5 text-rose-300",
  };
  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-[#071018]/90 shadow-[0_18px_55px_-36px_rgba(0,0,0,1)]">
      <header className="flex items-start gap-3 border-b border-slate-800/90 bg-slate-900/70 px-4 py-3.5">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border", tones[tone])}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] tracking-[0.24em] text-slate-500">SECTOR {index}</span>
            <h3 className="text-sm font-black tracking-wide text-slate-100">{title}</h3>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p>
        </div>
      </header>
      <div className="p-4">{children}</div>
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
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-900/55 p-3.5">
      <div>
        <Label htmlFor={id} className="text-sm font-bold text-slate-100">{title}</Label>
        <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

function cloneConfig(config: Rainbow20415Config): Rainbow20415Config {
  return {
    ...config,
    Lines: config.Lines.map((line) => ({ ...line })),
    Base_Lot_Size: { ...config.Base_Lot_Size },
    Martin_Ranges: config.Martin_Ranges.map((range) => ({ ...range })),
  };
}

export function Rainbow20415ConfigPanel({
  value,
  onChange,
  disabled = false,
  className,
  context = "strategy",
}: Rainbow20415ConfigPanelProps) {
  const config = useMemo(() => normalizeRainbow20415Config(value), [value]);
  const validation = useMemo(() => validateRainbow20415Config(config), [config]);
  const maxLayer = deriveRainbow20415FinalEnabledLayer(config.Martin_Ranges);
  const contextLabel = context === "backtest" ? "同源回測" : context === "snapshot" ? "快照覆核" : "實盤部署";

  const updateConfig = (patch: Partial<Rainbow20415Config>) => {
    onChange({ ...cloneConfig(config), ...patch });
  };

  const updateLine = (index: number, patch: Partial<Rainbow20415LineConfig>) => {
    updateConfig({
      Lines: config.Lines.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : { ...line }),
    });
  };

  const replaceRanges = (ranges: Rainbow20415MartinRange[]) => {
    let cursor = 1;
    const continuous = ranges.map((range) => {
      const width = Math.max(1, Math.round(range.endLayer - range.startLayer + 1));
      const next = { ...range, startLayer: cursor, endLayer: cursor + width - 1 };
      cursor = next.endLayer + 1;
      return next;
    });
    updateConfig({ Martin_Ranges: continuous });
  };

  const updateRange = (index: number, patch: Partial<Rainbow20415MartinRange>) => {
    const ranges = config.Martin_Ranges.map((range, rangeIndex) =>
      rangeIndex === index ? { ...range, ...patch } : { ...range },
    );
    replaceRanges(ranges);
  };

  const updateRangeEnd = (index: number, endLayer: number) => {
    const range = config.Martin_Ranges[index];
    updateRange(index, { endLayer: Math.max(range.startLayer, Math.round(endLayer)) });
  };

  const addRange = () => {
    const last = config.Martin_Ranges.at(-1);
    const startLayer = last ? last.endLayer + 1 : 1;
    replaceRanges([
      ...config.Martin_Ranges.map((range) => ({ ...range })),
      {
        id: `range-${startLayer}-${startLayer + 2}-${config.Martin_Ranges.length + 1}`,
        startLayer,
        endLayer: startLayer + 2,
        multiplier: last?.multiplier ?? 1,
        useGlobalSpacing: true,
        spacingPct: config.Global_Spacing_Pct,
        enabled: true,
      },
    ]);
  };

  const removeRange = (index: number) => {
    if (config.Martin_Ranges.length <= 1) return;
    replaceRanges(config.Martin_Ranges.filter((_, rangeIndex) => rangeIndex !== index).map((range) => ({ ...range })));
  };

  return (
    <div
      data-testid="rainbow-20415-config-panel"
      className={cn(
        "relative overflow-hidden rounded-2xl border border-slate-700/80 bg-[#040a10] text-slate-100 shadow-[0_28px_90px_-42px_rgba(0,0,0,1)]",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 opacity-[0.18] [background-image:linear-gradient(rgba(34,211,238,.13)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,.13)_1px,transparent_1px)] [background-size:24px_24px]" />
      <div className="relative">
        <div className="border-b border-slate-700/90 bg-[radial-gradient(circle_at_12%_0%,rgba(34,211,238,.18),transparent_34%),radial-gradient(circle_at_88%_8%,rgba(168,85,247,.16),transparent_30%),linear-gradient(135deg,#0d1b27_0%,#050a10_72%)] p-5 sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="border border-cyan-300/35 bg-cyan-300/10 font-mono text-[10px] tracking-[0.18em] text-cyan-200 hover:bg-cyan-300/10">20415 / RAINBOW / V1</Badge>
                <Badge className="border border-violet-300/30 bg-violet-300/10 font-mono text-[10px] tracking-[0.14em] text-violet-200 hover:bg-violet-300/10">{contextLabel}</Badge>
                <Badge className="border border-emerald-300/30 bg-emerald-300/10 font-mono text-[10px] tracking-[0.14em] text-emerald-200 hover:bg-emerald-300/10">BLIND MODE ARMED</Badge>
              </div>
              <h2 className="mt-4 text-xl font-black tracking-tight text-white sm:text-2xl">20415七彩虹馬丁策略</h2>
              <p className="mt-2 max-w-3xl text-xs leading-6 text-slate-400 sm:text-sm">
                M30 七線同向斜率與排名鎖定觸發入場；成交後封存均線干預，轉入 M1 盲人模式，以真實平均成本、動態階梯與三道鐵幕管理持倉。
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:min-w-[520px]">
              {[
                { label: "契約", value: validation.valid ? "VALID" : "REVIEW", icon: ShieldCheck, ok: validation.valid },
                { label: "雙節奏", value: `${formatRainbow20415Timeframe(config.Entry_Timeframe_Minutes)} / ${formatRainbow20415Timeframe(config.Management_Interval_Minutes)}`, icon: RadioTower, ok: true },
                { label: "最終戰層", value: `${maxLayer || 0} L`, icon: Layers3, ok: maxLayer > 0 },
                { label: "配置底倉", value: config.Base_Lot_Size.mode.toUpperCase(), icon: LockKeyhole, ok: true },
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

        <div className="space-y-4 p-4 sm:p-5">
          <Sector index="01" title="任務時序與配置底倉" subtitle="此處保留快照／回測的策略基準；真正送單的數值與單位由上方「實盤部署倉位」獨立覆寫。" icon={Crosshair}>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <NumberField id="rainbow-entry-tf" label="進場週期" value={config.Entry_Timeframe_Minutes} onChange={(next) => updateConfig({ Entry_Timeframe_Minutes: next })} min={1} max={1440} step={1} unit="MIN" disabled={disabled} />
              <NumberField id="rainbow-manage-tf" label="持倉管理週期" value={config.Management_Interval_Minutes} onChange={(next) => updateConfig({ Management_Interval_Minutes: next })} min={1} max={60} step={1} unit="MIN" disabled={disabled} description="必須可整除進場週期" />
              <NumberField id="rainbow-capital" label="初始資本" value={config.Initial_Capital} onChange={(next) => updateConfig({ Initial_Capital: next })} min={0.01} step={100} unit="USDT" disabled={disabled} />
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">配置底倉單位</Label>
                <Select value={config.Base_Lot_Size.mode} onValueChange={(mode: "quantity" | "usdt") => updateConfig({ Base_Lot_Size: { ...config.Base_Lot_Size, mode } })} disabled={disabled}>
                  <SelectTrigger className="h-10 border-slate-700/90 bg-[#050b11]/85 font-mono text-sm text-slate-100"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="quantity">幣數 QUANTITY</SelectItem><SelectItem value="usdt">金額 USDT</SelectItem></SelectContent>
                </Select>
              </div>
              <NumberField id="rainbow-base-lot" label="配置底倉數值" value={config.Base_Lot_Size.value} onChange={(next) => updateConfig({ Base_Lot_Size: { ...config.Base_Lot_Size, value: next } })} min={0.00000001} step={config.Base_Lot_Size.mode === "usdt" ? 1 : 0.001} unit={config.Base_Lot_Size.mode.toUpperCase()} disabled={disabled} />
            </div>
          </Sector>

          <Sector index="02" title="七線戰術陣列" subtitle="七條均線必須全數同向，且前後兩根已收盤 K 棒的排名完全不變；任一交叉或同值即拒絕入場。" icon={Activity} tone="emerald">
            <div className="space-y-3 md:hidden">
              {config.Lines.map((line, index) => (
                <div key={`mobile-${line.id}`} className="rounded-xl border border-slate-800 bg-slate-950/55 p-3.5">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="h-3.5 w-3.5 rounded-full shadow-[0_0_14px_currentColor]" style={{ backgroundColor: line.color, color: line.color }} />
                      <span className="font-mono text-xs font-black text-slate-200">{line.id}</span>
                      <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500">RAINBOW CHANNEL</span>
                    </div>
                    <input aria-label={`${line.id} 色譜`} type="color" value={line.color} disabled={disabled} onChange={(event) => updateLine(index, { color: event.target.value })} className="h-9 w-11 cursor-pointer rounded border border-slate-700 bg-transparent p-1" />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2 sm:col-span-2">
                      <Label className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">戰術代號</Label>
                      <Input value={line.label} maxLength={24} disabled={disabled} onChange={(event) => updateLine(index, { label: event.target.value })} className="h-9 border-slate-700 bg-[#050b11]/85 text-xs text-slate-100" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">均線算法</Label>
                      <Select value={line.type} onValueChange={(type: "EMA" | "SMA" | "WMA") => updateLine(index, { type })} disabled={disabled}>
                        <SelectTrigger className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-xs text-slate-100"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="EMA">EMA</SelectItem><SelectItem value="SMA">SMA</SelectItem><SelectItem value="WMA">WMA</SelectItem></SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">計算週期</Label>
                      <Input type="number" min={1} max={250} step={1} value={line.period} disabled={disabled} onChange={(event) => updateLine(index, { period: Number(event.target.value) })} className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-xs text-slate-100" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden overflow-x-auto rounded-lg border border-slate-800 md:block">
              <div className="min-w-[760px]">
                <div className="grid grid-cols-[48px_minmax(180px,1.4fr)_120px_130px_110px] gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-2 font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">
                  <span>Line</span><span>戰術代號</span><span>算法</span><span>週期</span><span>色譜</span>
                </div>
                {config.Lines.map((line, index) => (
                  <div key={line.id} className="grid grid-cols-[48px_minmax(180px,1.4fr)_120px_130px_110px] items-center gap-2 border-b border-slate-800/70 px-3 py-2.5 last:border-b-0">
                    <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full shadow-[0_0_12px_currentColor]" style={{ backgroundColor: line.color, color: line.color }} /><span className="font-mono text-xs font-bold text-slate-300">{line.id}</span></div>
                    <Input value={line.label} maxLength={24} disabled={disabled} onChange={(event) => updateLine(index, { label: event.target.value })} className="h-9 border-slate-700 bg-[#050b11]/85 text-xs text-slate-100" />
                    <Select value={line.type} onValueChange={(type: "EMA" | "SMA" | "WMA") => updateLine(index, { type })} disabled={disabled}>
                      <SelectTrigger className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-xs text-slate-100"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="EMA">EMA</SelectItem><SelectItem value="SMA">SMA</SelectItem><SelectItem value="WMA">WMA</SelectItem></SelectContent>
                    </Select>
                    <Input type="number" min={1} max={250} step={1} value={line.period} disabled={disabled} onChange={(event) => updateLine(index, { period: Number(event.target.value) })} className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-xs text-slate-100" />
                    <div className="flex items-center gap-2"><input aria-label={`${line.id} 色譜`} type="color" value={line.color} disabled={disabled} onChange={(event) => updateLine(index, { color: event.target.value })} className="h-9 w-11 cursor-pointer rounded border border-slate-700 bg-transparent p-1" /><span className="font-mono text-[10px] text-slate-500">{line.color}</span></div>
                  </div>
                ))}
              </div>
            </div>
          </Sector>

          <Sector index="03" title="盲人模式與動態階梯" subtitle="首單成交後七線不再干預；每一層只依真實平均成本、方向、現價與下一個啟用區間執行。" icon={Layers3} tone="amber">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
              <div className="space-y-3">
                <ToggleRow id="rainbow-martingale" title="階梯馬丁武裝" description="關閉後仍保留底倉與三道風控，但不再執行任何加倉。" checked={config.Martingale_Enabled} onCheckedChange={(checked) => updateConfig({ Martingale_Enabled: checked })} disabled={disabled} />
                <div className="space-y-3 md:hidden">
                  {config.Martin_Ranges.map((range, index) => (
                    <div key={`mobile-${range.id}`} className="rounded-xl border border-slate-800 bg-slate-950/55 p-3.5">
                      <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                        <div className="flex items-center gap-2">
                          <Switch checked={range.enabled} disabled={disabled || index === 0} onCheckedChange={(enabled) => updateRange(index, { enabled })} />
                          <div>
                            <p className="font-mono text-xs font-black text-amber-200">L{range.startLayer} — L{range.endLayer}</p>
                            <p className="mt-0.5 text-[9px] uppercase tracking-[0.14em] text-slate-500">{range.enabled ? "ARMED RANGE" : "BYPASS RANGE"}</p>
                          </div>
                        </div>
                        <Button type="button" variant="ghost" size="icon" aria-label={`刪除 L${range.startLayer} 至 L${range.endLayer} 區間`} disabled={disabled || config.Martin_Ranges.length <= 1} onClick={() => removeRange(index)} className="text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 className="h-4 w-4" /></Button>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">終止層</Label>
                          <Input type="number" min={range.startLayer} step={1} value={range.endLayer} disabled={disabled} onChange={(event) => updateRangeEnd(index, Number(event.target.value))} className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-xs text-slate-100" />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">下單倍數</Label>
                          <Input type="number" min={0} max={10} step={0.1} value={range.multiplier} disabled={disabled} onChange={(event) => updateRange(index, { multiplier: Number(event.target.value) })} className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-xs text-slate-100" />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">間距來源</Label>
                          <Select value={range.useGlobalSpacing ? "global" : "custom"} onValueChange={(next) => updateRange(index, { useGlobalSpacing: next === "global" })} disabled={disabled}>
                            <SelectTrigger className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-[11px] text-slate-100"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value="global">全局間距</SelectItem><SelectItem value="custom">區間自訂</SelectItem></SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">自訂間距 (%)</Label>
                          <Input type="number" min={0.01} max={100} step={0.1} value={range.spacingPct} disabled={disabled || range.useGlobalSpacing} onChange={(event) => updateRange(index, { spacingPct: Number(event.target.value) })} className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-xs text-slate-100 disabled:opacity-40" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="hidden overflow-x-auto rounded-lg border border-slate-800 md:block">
                  <div className="min-w-[820px]">
                    <div className="grid grid-cols-[72px_90px_90px_110px_130px_110px_60px] gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-2 font-mono text-[9px] uppercase tracking-[0.14em] text-slate-500">
                      <span>狀態</span><span>起層</span><span>終層</span><span>倍數</span><span>間距來源</span><span>自訂間距</span><span />
                    </div>
                    {config.Martin_Ranges.map((range, index) => (
                      <div key={range.id} className="grid grid-cols-[72px_90px_90px_110px_130px_110px_60px] items-center gap-2 border-b border-slate-800/70 px-3 py-2.5 last:border-b-0">
                        <Switch checked={range.enabled} disabled={disabled || index === 0} onCheckedChange={(enabled) => updateRange(index, { enabled })} />
                        <div className="rounded-md border border-slate-800 bg-black/25 px-3 py-2 text-center font-mono text-xs text-slate-400">{range.startLayer}</div>
                        <Input type="number" min={range.startLayer} step={1} value={range.endLayer} disabled={disabled} onChange={(event) => updateRangeEnd(index, Number(event.target.value))} className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-xs text-slate-100" />
                        <Input type="number" min={0} max={10} step={0.1} value={range.multiplier} disabled={disabled} onChange={(event) => updateRange(index, { multiplier: Number(event.target.value) })} className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-xs text-slate-100" />
                        <Select value={range.useGlobalSpacing ? "global" : "custom"} onValueChange={(next) => updateRange(index, { useGlobalSpacing: next === "global" })} disabled={disabled}>
                          <SelectTrigger className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-[11px] text-slate-100"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="global">全局間距</SelectItem><SelectItem value="custom">區間自訂</SelectItem></SelectContent>
                        </Select>
                        <Input type="number" min={0.01} max={100} step={0.1} value={range.spacingPct} disabled={disabled || range.useGlobalSpacing} onChange={(event) => updateRange(index, { spacingPct: Number(event.target.value) })} className="h-9 border-slate-700 bg-[#050b11]/85 font-mono text-xs text-slate-100 disabled:opacity-40" />
                        <Button type="button" variant="ghost" size="icon" disabled={disabled || config.Martin_Ranges.length <= 1} onClick={() => removeRange(index)} className="text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    ))}
                  </div>
                </div>
                <Button type="button" variant="outline" onClick={addRange} disabled={disabled} className="border-cyan-400/25 bg-cyan-400/5 text-cyan-200 hover:bg-cyan-400/10 hover:text-cyan-100"><Plus className="mr-2 h-4 w-4" />新增連續戰層區間</Button>
              </div>
              <div className="space-y-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-4">
                <div className="flex items-center gap-2 text-amber-200"><Gauge className="h-4 w-4" /><span className="text-xs font-black uppercase tracking-[0.16em]">Ladder Intel</span></div>
                <NumberField id="rainbow-global-spacing" label="全局加倉間距" value={config.Global_Spacing_Pct} onChange={(next) => updateConfig({ Global_Spacing_Pct: next })} min={0.01} max={100} step={0.1} unit="%" disabled={disabled} />
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-slate-800 bg-black/20 p-3"><p className="text-[9px] uppercase tracking-wider text-slate-500">區間數</p><p className="mt-2 font-mono text-lg font-black text-slate-100">{config.Martin_Ranges.length}</p></div>
                  <div className="rounded-lg border border-slate-800 bg-black/20 p-3"><p className="text-[9px] uppercase tracking-wider text-slate-500">最終啟用層</p><p className="mt-2 font-mono text-lg font-black text-amber-200">L{maxLayer}</p></div>
                </div>
                <p className="text-[10px] leading-5 text-slate-500">停用區間會由核心跳過；下一個啟用層仍保持連續定義，不存在固定層數上限。</p>
              </div>
            </div>
          </Sector>

          <Sector index="04" title="三道鐵幕與止盈" subtitle="成本止盈優先；超時、保證金與最終層帳戶虧損任何一項命中即提出平倉決策。" icon={ShieldAlert} tone="rose">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <NumberField id="rainbow-tp" label="平均成本止盈" value={config.Take_Profit_Pct} onChange={(next) => updateConfig({ Take_Profit_Pct: next })} min={0.0001} max={100} step={0.05} unit="%" disabled={disabled} />
              <NumberField id="rainbow-max-hold" label="最長持倉" value={config.Max_Hold_Hours} onChange={(next) => updateConfig({ Max_Hold_Hours: next })} min={0.01} max={8760} step={1} unit="HOURS" disabled={disabled} />
              <NumberField id="rainbow-margin" label="保證金使用上限" value={config.Max_Margin_Usage_Pct} onChange={(next) => updateConfig({ Max_Margin_Usage_Pct: next })} min={0.01} max={100} step={1} unit="%" disabled={disabled} description="缺少真實資料時安全封鎖加倉" />
              <NumberField id="rainbow-account-loss" label="最終層帳戶虧損" value={config.Max_Account_Loss_Pct} onChange={(next) => updateConfig({ Max_Account_Loss_Pct: next })} min={0.01} max={100} step={0.5} unit="%" disabled={disabled} />
            </div>
          </Sector>

          <Sector index="05" title="無縫重入協定" subtitle="平倉成交後才重置持倉，並以最新已收盤進場 K 棒重判；冷卻與 Bar 鎖共同阻止重複推進。" icon={ArrowRightLeft} tone="cyan">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
              <ToggleRow id="rainbow-reentry" title="啟用無縫重入" description="止盈或風控平倉後，允許同一已收盤 M30 結構進行一次 pendingReentry 重判。" checked={config.Reentry_Enabled} onCheckedChange={(checked) => updateConfig({ Reentry_Enabled: checked })} disabled={disabled} />
              <NumberField id="rainbow-reentry-cooldown" label="重入冷卻" value={config.Reentry_Cooldown_Minutes} onChange={(next) => updateConfig({ Reentry_Cooldown_Minutes: next })} min={0} max={10080} step={1} unit="MIN" disabled={disabled || !config.Reentry_Enabled} />
            </div>
          </Sector>

          {!validation.valid ? (
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4">
              <div className="flex items-center gap-2 text-amber-200"><ShieldAlert className="h-4 w-4" /><span className="text-xs font-black uppercase tracking-[0.14em]">Deployment Hold</span></div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {validation.issues.map((issue, index) => <p key={`${issue.path}-${index}`} className="font-mono text-[10px] leading-5 text-amber-100/80"><span className="text-amber-300">{issue.path}</span> — {issue.message}</p>)}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.05] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3"><ShieldCheck className="h-5 w-5 text-emerald-300" /><div><p className="text-xs font-black uppercase tracking-[0.14em] text-emerald-200">Contract Validated</p><p className="mt-1 text-[10px] text-slate-500">建立、編輯、回測、快照與執行器將使用這一份配置。</p></div></div>
              <Button type="button" variant="ghost" disabled={disabled} onClick={() => onChange(createRainbow20415DefaultConfig())} className="justify-start text-slate-400 hover:bg-white/5 hover:text-white"><RotateCcw className="mr-2 h-4 w-4" />恢復文件預設</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
