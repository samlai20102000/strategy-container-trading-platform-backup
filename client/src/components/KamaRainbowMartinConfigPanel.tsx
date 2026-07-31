import { useMemo, type ComponentType, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Clock3,
  Crosshair,
  Gauge,
  Layers3,
  Minus,
  Plus,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  KAMA_RAINBOW_MARTIN_TIMEFRAMES,
  buildKamaRainbowMartinLayerQuantities,
  createKamaRainbowMartinDefaultConfig,
  normalizeKamaRainbowMartinConfig,
  validateKamaRainbowMartinConfig,
  type KamaRainbowMartinConfig,
  type KamaRainbowMartinLineConfig,
  type KamaRainbowMartinTimeframe,
} from "@shared/strategies/kamaRainbowMartin";

export interface KamaRainbowMartinConfigPanelProps {
  value: unknown;
  onChange: (config: KamaRainbowMartinConfig) => void;
  disabled?: boolean;
  className?: string;
  context?: "strategy" | "backtest" | "snapshot";
  positionMode?: "quantity" | "usdt";
  positionSize?: number;
  referencePrice?: number;
  quantityPrecision?: string;
  pricePrecision?: string;
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

function cloneConfig(config: KamaRainbowMartinConfig): KamaRainbowMartinConfig {
  return {
    ...config,
    kamaLines: config.kamaLines.map((line) => ({ ...line })),
    trailing: { ...config.trailing },
  };
}

function makeLineId(lines: readonly KamaRainbowMartinLineConfig[]): string {
  let suffix = lines.length + 1;
  while (lines.some((line) => line.id === `KAMA_${suffix}`)) suffix += 1;
  return `KAMA_${suffix}`;
}

function formatEstimate(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

export function KamaRainbowMartinConfigPanel({
  value,
  onChange,
  disabled = false,
  className,
  context = "strategy",
  positionMode = "usdt",
  positionSize = 0,
  referencePrice,
  quantityPrecision = "依交易所 qtyStep／minQty 向下正規化",
  pricePrecision = "風控觸發價依交易所 tickSize 顯示",
}: KamaRainbowMartinConfigPanelProps) {
  const config = useMemo(() => normalizeKamaRainbowMartinConfig(value), [value]);
  const validation = useMemo(() => validateKamaRainbowMartinConfig(config), [config]);
  const enabledLines = useMemo(() => config.kamaLines.filter((line) => line.enabled), [config.kamaLines]);
  const layerQuantities = useMemo(
    () => buildKamaRainbowMartinLayerQuantities(positionSize, config.maxLayers, config.multiplier),
    [config.maxLayers, config.multiplier, positionSize],
  );
  const cumulativeExposure = layerQuantities.reduce((sum, quantity) => sum + quantity, 0);
  const estimatedBaseQuantity = positionMode === "usdt" && referencePrice && referencePrice > 0
    ? positionSize / referencePrice
    : positionMode === "quantity"
      ? positionSize
      : Number.NaN;
  const contextLabel = context === "backtest" ? "同源回測" : context === "snapshot" ? "快照覆核" : "隔離部署";

  const updateConfig = (patch: Partial<KamaRainbowMartinConfig>) => {
    onChange({ ...cloneConfig(config), ...patch });
  };
  const updateLine = (index: number, patch: Partial<KamaRainbowMartinLineConfig>) => {
    updateConfig({
      kamaLines: config.kamaLines.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : { ...line }),
    });
  };
  const appendLine = () => {
    if (config.kamaLines.length >= 32) return;
    const previous = config.kamaLines.at(-1);
    const index = config.kamaLines.length + 1;
    updateConfig({
      kamaLines: [
        ...config.kamaLines.map((line) => ({ ...line })),
        {
          id: makeLineId(config.kamaLines),
          name: `KAMA ${index * 10}`,
          enabled: true,
          erPeriod: Math.min(500, (previous?.erPeriod ?? 10) + 10),
          fastEma: previous?.fastEma ?? 2,
          slowEma: previous?.slowEma ?? 30,
          color: "#A78BFA",
        },
      ],
    });
  };
  const removeLine = (index: number) => {
    if (config.kamaLines.length <= 2) return;
    updateConfig({ kamaLines: config.kamaLines.filter((_, lineIndex) => lineIndex !== index).map((line) => ({ ...line })) });
  };

  return (
    <div
      data-testid="kama-rainbow-martin-config-panel"
      className={cn(
        "relative w-full min-w-0 max-w-full [contain:inline-size] overflow-hidden rounded-2xl border border-slate-700/80 bg-[#040a10] text-slate-100 shadow-[0_28px_90px_-42px_rgba(0,0,0,1)]",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 opacity-[0.18] [background-image:linear-gradient(rgba(34,211,238,.13)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,.13)_1px,transparent_1px)] [background-size:24px_24px]" />
      <div className="relative min-w-0 max-w-full">
        <div className="min-w-0 max-w-full border-b border-slate-700/90 bg-[radial-gradient(circle_at_12%_0%,rgba(34,211,238,.18),transparent_34%),radial-gradient(circle_at_88%_8%,rgba(167,139,250,.18),transparent_30%),linear-gradient(135deg,#0d1b27_0%,#050a10_72%)] p-4 sm:p-6">
          <div className="flex min-w-0 flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="border border-cyan-300/35 bg-cyan-300/10 font-mono text-[10px] tracking-[0.18em] text-cyan-200 hover:bg-cyan-300/10">KAMA RAINBOW / MARTIN / V1</Badge>
                <Badge className="border border-violet-300/30 bg-violet-300/10 font-mono text-[10px] tracking-[0.14em] text-violet-200 hover:bg-violet-300/10">{contextLabel}</Badge>
                <Badge className="border border-emerald-300/30 bg-emerald-300/10 font-mono text-[10px] tracking-[0.14em] text-emerald-200 hover:bg-emerald-300/10">DEFAULT DISABLED</Badge>
              </div>
              <h2 className="mt-4 text-xl font-black tracking-tight text-white sm:text-2xl">Kama彩虹馬丁策略</h2>
              <p className="mt-2 max-w-3xl text-xs leading-6 text-slate-400 sm:text-sm">
                空倉只在已收線 K 棒上以全部啟用 KAMA 的斜率與任意線對交叉鎖判定入場；持倉後完全跳過 KAMA，改由 fresh bid／ask 執行腿級馬丁、硬止損與階梯移動止盈。
              </p>
            </div>
            <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4 xl:min-w-[520px]">
              {[
                { label: "契約", value: validation.valid ? "VALID" : "REVIEW", icon: ShieldCheck, ok: validation.valid },
                { label: "進場週期", value: config.timeframe, icon: Clock3, ok: true },
                { label: "啟用線數", value: `${enabledLines.length} / ${config.kamaLines.length}`, icon: Activity, ok: enabledLines.length >= 2 },
                { label: "最大曝險倍數", value: positionSize > 0 ? `${(cumulativeExposure / positionSize).toFixed(2)}×` : "—", icon: Gauge, ok: positionSize > 0 },
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
          <Sector index="01" title="事件時序與倉位來源" subtitle="進場使用指定週期的已收線 K 棒；持倉風控使用 fresh bid／ask。底倉數值只取策略 top-level 倉位設定。" icon={Crosshair}>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">進場週期</Label>
                <Select value={config.timeframe} onValueChange={(timeframe: KamaRainbowMartinTimeframe) => updateConfig({ timeframe })} disabled={disabled}>
                  <SelectTrigger className="h-10 border-slate-700/90 bg-[#050b11]/90 font-mono text-sm text-slate-100"><SelectValue /></SelectTrigger>
                  <SelectContent>{KAMA_RAINBOW_MARTIN_TIMEFRAMES.map((timeframe) => <SelectItem key={timeframe} value={timeframe}>{timeframe}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-3">
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-300"><Clock3 className="h-3.5 w-3.5" />Entry clock</div>
                <p className="mt-2 font-mono text-sm font-black text-cyan-100">{config.timeframe} CLOSED BAR</p>
                <p className="mt-1 text-[10px] leading-4 text-slate-500">未收線資料不進入交叉鎖與全線斜率判定。</p>
              </div>
              <div className="rounded-lg border border-violet-400/20 bg-violet-400/5 p-3">
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300"><TrendingUp className="h-3.5 w-3.5" />Risk clock</div>
                <p className="mt-2 font-mono text-sm font-black text-violet-100">FRESH BID / ASK</p>
                <p className="mt-1 text-[10px] leading-4 text-slate-500">持倉腿優先；不因新 KAMA 交叉 close、reverse 或阻擋風控。</p>
              </div>
              <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3">
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300"><Calculator className="h-3.5 w-3.5" />底倉估算</div>
                <p className="mt-2 font-mono text-sm font-black text-emerald-100">{formatEstimate(positionSize)} {positionMode.toUpperCase()}</p>
                <p className="mt-1 text-[10px] leading-4 text-slate-500">估算基礎數量：{formatEstimate(estimatedBaseQuantity)}；{quantityPrecision}。</p>
              </div>
            </div>
          </Sector>

          <Sector index="02" title="動態 KAMA 彩虹陣列" subtitle="支援 2–32 條；id 是快照與監控的穩定身份，名稱、參數、啟用狀態及色譜可配置。" icon={Activity} tone="emerald">
            <div className="mb-3 flex flex-col gap-3 rounded-xl border border-emerald-400/15 bg-emerald-400/5 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-mono text-xs font-semibold text-emerald-100">共 {config.kamaLines.length} 條，已啟用 {enabledLines.length} 條</p>
                <p className="mt-1 text-[10px] leading-4 text-slate-500">每棒逐一重算 ER 與平滑常數；fast &gt; slow 直接阻擋，fast = slow 顯示退化警告。</p>
              </div>
              <Button type="button" variant="outline" size="sm" disabled={disabled || config.kamaLines.length >= 32} onClick={appendLine} className="border-emerald-400/30 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/20">
                <Plus className="mr-1.5 h-3.5 w-3.5" />新增 KAMA
              </Button>
            </div>
            <div data-testid="krm-lines-scroll" role="region" aria-label="KAMA 彩虹設定表，可水平捲動" tabIndex={0} className="w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-xl border border-slate-800">
              <table className="w-full min-w-[980px] text-left text-xs">
                <thead className="bg-slate-950/80 text-[9px] uppercase tracking-[0.16em] text-slate-500">
                  <tr><th className="px-3 py-3">啟用</th><th className="px-3 py-3">穩定 ID</th><th className="px-3 py-3">顯示名稱</th><th className="px-3 py-3">ER 週期</th><th className="px-3 py-3">Fast EMA</th><th className="px-3 py-3">Slow EMA</th><th className="px-3 py-3">色譜</th><th className="px-3 py-3">操作</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-[#050b11]/70">
                  {config.kamaLines.map((line, index) => (
                    <tr key={line.id} className={cn(!line.enabled && "opacity-45")}>
                      <td className="px-3 py-3"><Switch checked={line.enabled} onCheckedChange={(enabled) => updateLine(index, { enabled })} disabled={disabled} /></td>
                      <td className="px-3 py-3"><Badge className="border border-cyan-400/25 bg-cyan-400/5 font-mono text-[10px] text-cyan-200">{line.id}</Badge></td>
                      <td className="px-3 py-3"><Input value={line.name} maxLength={40} disabled={disabled} onChange={(event) => updateLine(index, { name: event.target.value })} className="h-9 min-w-[170px] border-slate-700 bg-slate-950/70 text-xs" /></td>
                      <td className="px-3 py-3"><Input type="number" min={2} max={500} step={1} value={line.erPeriod} disabled={disabled} onChange={(event) => updateLine(index, { erPeriod: Number(event.target.value) })} className="h-9 w-24 border-slate-700 bg-slate-950/70 font-mono text-xs" /></td>
                      <td className="px-3 py-3"><Input type="number" min={1} max={500} step={1} value={line.fastEma} disabled={disabled} onChange={(event) => updateLine(index, { fastEma: Number(event.target.value) })} className="h-9 w-24 border-slate-700 bg-slate-950/70 font-mono text-xs" /></td>
                      <td className="px-3 py-3"><Input type="number" min={1} max={500} step={1} value={line.slowEma} disabled={disabled} onChange={(event) => updateLine(index, { slowEma: Number(event.target.value) })} className="h-9 w-24 border-slate-700 bg-slate-950/70 font-mono text-xs" /></td>
                      <td className="px-3 py-3"><input aria-label={`${line.name} 色譜`} type="color" value={line.color} disabled={disabled} onChange={(event) => updateLine(index, { color: event.target.value.toUpperCase() })} className="h-9 w-12 cursor-pointer rounded border border-slate-700 bg-transparent p-1" /></td>
                      <td className="px-3 py-3"><Button type="button" variant="outline" size="sm" aria-label={`移除 ${line.name}`} disabled={disabled || config.kamaLines.length <= 2} onClick={() => removeLine(index)} className="border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-900"><Minus className="h-3.5 w-3.5" /></Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {["任意啟用線對 cross／touch 即鎖定", "全部啟用線斜率上升才允許 LONG", "全部啟用線斜率下降才允許 SHORT", "mixed／not-ready／spread 異常一律 fail-closed"].map((rule, index) => (
                <div key={rule} className="flex gap-2 rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3 text-xs text-slate-300"><span className="font-mono text-emerald-300">0{index + 1}</span>{rule}</div>
              ))}
            </div>
          </Sector>

          <Sector index="03" title="固定間距指數馬丁" subtitle="五層預設包含底倉 L1；每層量 = 底倉 × multiplier^(L-1)，下一層只以最近一層實際 fill 為錨點。" icon={Layers3} tone="violet">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <NumberControl id="krm-max-layers" label="最大層數（含底倉）" value={config.maxLayers} onChange={(maxLayers) => updateConfig({ maxLayers })} min={1} max={20} step={1} unit="L" disabled={disabled} />
              <NumberControl id="krm-multiplier" label="層級倍率" value={config.multiplier} onChange={(multiplier) => updateConfig({ multiplier })} min={1} max={10} step={0.1} unit="×" disabled={disabled} />
              <NumberControl id="krm-gap" label="相鄰層實際成交間距" value={config.gapPct} onChange={(gapPct) => updateConfig({ gapPct })} min={0.01} max={100} step={0.1} unit="百分點" disabled={disabled} description="LONG 向下、SHORT 向上；每次評估最多產生一層 intent。" />
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {layerQuantities.map((quantity, index) => (
                <div key={index} className="rounded-lg border border-violet-400/15 bg-violet-400/5 p-3">
                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-violet-300">L{index + 1}</div>
                  <div className="mt-2 font-mono text-sm font-black text-slate-100">{formatEstimate(quantity)} {positionMode.toUpperCase()}</div>
                  <div className="mt-1 text-[10px] text-slate-500">{config.multiplier}^{index} × 底倉</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10px] leading-5 text-slate-500">最大累積曝險估算：{formatEstimate(cumulativeExposure)} {positionMode.toUpperCase()}。實際委託仍受 deployment position cap、帳戶餘額及 {quantityPrecision} 約束。</p>
          </Sector>

          <Sector index="04" title="腿級硬止損與階梯移動止盈" subtitle="action precedence 固定為 KILL → hard stop → trailing close → martingale → hold；沒有額外 target profit。" icon={ShieldAlert} tone="rose">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <NumberControl id="krm-hard-stop" label="硬止損" value={config.hardStopLossPct} onChange={(hardStopLossPct) => updateConfig({ hardStopLossPct })} min={0.01} max={100} step={0.1} unit="% AVG COST" disabled={disabled} description="以該腿加權平均成本計算，多空鏡像。" />
              <NumberControl id="krm-trailing-activation" label="Trailing 啟動" value={config.trailing.activationPct} onChange={(activationPct) => updateConfig({ trailing: { ...config.trailing, activationPct } })} min={0.01} max={100} step={0.1} unit="%" disabled={disabled || !config.trailing.enabled} />
              <NumberControl id="krm-trailing-callback" label="Trailing 回調" value={config.trailing.callbackPct} onChange={(callbackPct) => updateConfig({ trailing: { ...config.trailing, callbackPct } })} min={0.01} max={100} step={0.1} unit="%" disabled={disabled || !config.trailing.enabled} />
              <NumberControl id="krm-trailing-step" label="階梯步長" value={config.trailing.stepPct} onChange={(stepPct) => updateConfig({ trailing: { ...config.trailing, stepPct } })} min={0.01} max={100} step={0.1} unit="%" disabled={disabled || !config.trailing.enabled} />
            </div>
            <div className="mt-4 flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/55 p-3 sm:gap-4 sm:p-3.5">
              <div className="min-w-0 flex-1">
                <Label htmlFor="krm-trailing-enabled" className="text-sm font-bold text-slate-100">啟用階梯移動止盈</Label>
                <p className="mt-1 text-xs leading-5 text-slate-500">只在實際加倉 fill 後重置峰值／谷值；拒單或未成交不會改變 trailing 狀態。{pricePrecision}。</p>
              </div>
              <Switch id="krm-trailing-enabled" checked={config.trailing.enabled} onCheckedChange={(enabled) => updateConfig({ trailing: { ...config.trailing, enabled } })} disabled={disabled} />
            </div>
          </Sector>

          <Sector index="05" title="回測終點與契約覆核" subtitle="回測與 live／paper 共用 evaluator；終點政策必須顯式，快照保留完整 canonical config。" icon={Sparkles} tone="amber">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">回測終點持倉政策</Label>
                <Select value={config.backtestEndPositionPolicy} onValueChange={(backtestEndPositionPolicy: KamaRainbowMartinConfig["backtestEndPositionPolicy"]) => updateConfig({ backtestEndPositionPolicy })} disabled={disabled}>
                  <SelectTrigger className="h-10 border-slate-700/90 bg-[#050b11]/90 font-mono text-sm text-slate-100"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="mark_to_market">MARK TO MARKET</SelectItem><SelectItem value="force_close">FORCE CLOSE</SelectItem></SelectContent>
                </Select>
                <p className="text-[10px] leading-4 text-slate-500">不加入跨日、最大持倉時間或來源策略其他多餘退出條件。</p>
              </div>
              <div className={cn("rounded-xl border p-3", validation.valid ? "border-emerald-400/20 bg-emerald-400/5" : "border-rose-400/25 bg-rose-400/5")}>
                <div className="flex items-center gap-2 text-sm font-black text-slate-100">
                  {validation.valid ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <AlertTriangle className="h-4 w-4 text-rose-300" />}
                  {validation.valid ? "Canonical 配置可保存" : `需要修正 ${validation.issues.length} 項`}
                </div>
                <div className="mt-3 space-y-2">
                  {validation.issues.map((issue) => <p key={`${issue.path}-${issue.code}`} className="text-xs leading-5 text-rose-200"><span className="font-mono text-[10px] text-rose-300">{issue.code}</span> · {issue.message}</p>)}
                  {validation.warnings.map((warning) => <p key={`${warning.path}-${warning.code}`} className="text-xs leading-5 text-amber-200"><span className="font-mono text-[10px] text-amber-300">{warning.code}</span> · {warning.message}</p>)}
                  {validation.valid && validation.warnings.length === 0 ? <p className="text-xs leading-5 text-slate-400">KAMA 線、馬丁、硬止損、trailing 與終點政策均通過本地契約檢查；伺服器會再次 fail-closed 驗證。</p> : null}
                </div>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-3 rounded-xl border border-amber-400/15 bg-amber-400/5 p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-5 text-slate-400">重設只恢復核准預設值，不會修改策略 top-level 倉位、API 綁定、部署模式或啟用狀態。</p>
              <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange(createKamaRainbowMartinDefaultConfig())} className="shrink-0 border-amber-400/30 bg-amber-400/10 text-amber-100 hover:bg-amber-400/20">
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />恢復核准預設
              </Button>
            </div>
          </Sector>
        </div>
      </div>
    </div>
  );
}
