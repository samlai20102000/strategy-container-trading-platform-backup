import { useMemo } from "react";
import {
  Activity,
  Clock3,
  Crosshair,
  Gauge,
  Layers3,
  LockKeyhole,
  Plus,
  RadioTower,
  RotateCcw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  createV25DefaultConfig,
  deriveV25MaxMartinLayer,
  normalizeV25Config,
  validateV25Config,
  type V25MartinRange,
  type V25StrategyConfig,
} from "@shared/strategies/kama3kBreakoutV25";

type NumericConfigKey = {
  [Key in keyof V25StrategyConfig]: V25StrategyConfig[Key] extends number ? Key : never;
}[keyof V25StrategyConfig];

export interface V25ConfigPanelProps {
  value: unknown;
  onChange: (config: V25StrategyConfig) => void;
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
        <Label htmlFor={id} className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
          {label}
        </Label>
        {unit && <span className="font-mono text-[10px] text-amber-300/80">{unit}</span>}
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
        className="h-10 border-slate-700/90 bg-slate-950/70 font-mono text-sm text-slate-100 shadow-inner shadow-black/20 transition-colors focus-visible:border-amber-400/70 focus-visible:ring-amber-400/20"
      />
      {description && <p className="text-[10px] leading-4 text-slate-500">{description}</p>}
    </div>
  );
}

interface SectionProps {
  index: string;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  tone?: "cyan" | "amber" | "emerald";
}

function Section({ index, title, subtitle, icon: Icon, children, tone = "cyan" }: SectionProps) {
  const toneClasses = {
    cyan: "border-cyan-400/25 bg-cyan-400/5 text-cyan-300",
    amber: "border-amber-400/25 bg-amber-400/5 text-amber-300",
    emerald: "border-emerald-400/25 bg-emerald-400/5 text-emerald-300",
  };

  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/55 shadow-[0_16px_45px_-28px_rgba(0,0,0,0.95)]">
      <header className="flex items-start gap-3 border-b border-slate-800/90 bg-slate-900/70 px-4 py-3.5">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border", toneClasses[tone])}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] tracking-[0.24em] text-slate-500">SECTOR {index}</span>
            <h3 className="text-sm font-bold tracking-wide text-slate-100">{title}</h3>
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
        <Label htmlFor={id} className="text-sm font-semibold text-slate-100">{title}</Label>
        <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

export function V25ConfigPanel({
  value,
  onChange,
  disabled = false,
  className,
  context = "strategy",
}: V25ConfigPanelProps) {
  const config = useMemo(() => normalizeV25Config(value), [value]);
  const validation = useMemo(() => validateV25Config(config), [config]);
  const maxLayer = deriveV25MaxMartinLayer(config.Martin_Ranges);
  const contextLabel = context === "backtest" ? "回測鏈路" : context === "snapshot" ? "快照鏈路" : "執行鏈路";

  const updateNumber = (key: NumericConfigKey, next: number) => {
    onChange({ ...config, [key]: next });
  };

  const updateRange = (index: number, key: keyof V25MartinRange, next: number) => {
    const ranges = config.Martin_Ranges.map((range, rangeIndex) =>
      rangeIndex === index ? { ...range, [key]: next } : { ...range },
    );
    onChange({ ...config, Martin_Ranges: ranges });
  };

  const addRange = () => {
    const last = config.Martin_Ranges.at(-1);
    const start = last ? last.end + 1 : 1;
    onChange({
      ...config,
      Martin_Ranges: [
        ...config.Martin_Ranges.map((range) => ({ ...range })),
        { start, end: start + 2, multiplier: last?.multiplier ?? 1, gap: last?.gap ?? 1 },
      ],
    });
  };

  const removeRange = (index: number) => {
    if (config.Martin_Ranges.length <= 1) return;
    let nextStart = 1;
    const ranges = config.Martin_Ranges
      .filter((_, rangeIndex) => rangeIndex !== index)
      .map((range) => {
        const width = Math.max(0, range.end - range.start);
        const next = { ...range, start: nextStart, end: nextStart + width };
        nextStart = next.end + 1;
        return next;
      });
    onChange({ ...config, Martin_Ranges: ranges });
  };

  return (
    <div
      data-testid="v25-config-panel"
      className={cn(
        "relative overflow-hidden rounded-2xl border border-slate-700/80 bg-[#071018] text-slate-100 shadow-[0_26px_80px_-38px_rgba(0,0,0,1)]",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 opacity-[0.16] [background-image:linear-gradient(rgba(56,189,248,.16)_1px,transparent_1px),linear-gradient(90deg,rgba(56,189,248,.16)_1px,transparent_1px)] [background-size:24px_24px]" />
      <div className="relative">
        <div className="border-b border-slate-700/90 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,.16),transparent_42%),linear-gradient(135deg,#0f1d29_0%,#081018_68%)] p-5 sm:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="border border-amber-300/35 bg-amber-300/10 font-mono text-[10px] tracking-[0.18em] text-amber-200 hover:bg-amber-300/10">
                  KAMA / 3K / V2.5.0
                </Badge>
                <Badge className="border border-cyan-300/30 bg-cyan-300/10 font-mono text-[10px] tracking-[0.14em] text-cyan-200 hover:bg-cyan-300/10">
                  {contextLabel}
                </Badge>
              </div>
              <h2 className="mt-4 text-xl font-black tracking-tight text-white sm:text-2xl">
                KAMA 三K突破｜階梯式馬丁
              </h2>
              <p className="mt-2 max-w-2xl text-xs leading-6 text-slate-400 sm:text-sm">
                參數直接綁定同一策略核心；回測、快照與交易執行使用相同欄位名稱、數值語義與校驗規則。
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2 lg:min-w-[360px]">
              {[
                { label: "契約", value: validation.valid ? "VALID" : "REVIEW", icon: ShieldCheck, ok: validation.valid },
                { label: "馬丁上限", value: `${maxLayer} L`, icon: Layers3, ok: true },
                { label: "首單單位", value: "USDT", icon: LockKeyhole, ok: true },
              ].map((item) => (
                <div key={item.label} className="rounded-lg border border-slate-700/80 bg-black/25 px-3 py-3">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                    <item.icon className={cn("h-3.5 w-3.5", item.ok ? "text-emerald-300" : "text-amber-300")} />
                    {item.label}
                  </div>
                  <div className={cn("mt-2 font-mono text-sm font-bold", item.ok ? "text-slate-100" : "text-amber-200")}>{item.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-4">
            <Section index="01" title="KAMA 指標核心" subtitle="快慢線各自保留 ER、最快與最慢平滑常數；慢線關係由共享契約即時校驗。" icon={Activity}>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <NumberField id="v25-fast-er" label="快線 ER 週期" value={config.KAMA_Fast_Length} onChange={(value) => updateNumber("KAMA_Fast_Length", value)} min={5} max={200} disabled={disabled} />
                <NumberField id="v25-fast-fastest" label="快線最快常數" value={config.p2_fastest} onChange={(value) => updateNumber("p2_fastest", value)} min={2} max={20} disabled={disabled} />
                <NumberField id="v25-fast-slowest" label="快線最慢常數" value={config.p3_slowest} onChange={(value) => updateNumber("p3_slowest", value)} min={1} max={10} disabled={disabled} />
                <NumberField id="v25-slow-er" label="慢線 ER 週期" value={config.KAMA_Slow_Length} onChange={(value) => updateNumber("KAMA_Slow_Length", value)} min={5} max={200} disabled={disabled} />
                <NumberField id="v25-slow-fastest" label="慢線最快常數" value={config.q2_fastest} onChange={(value) => updateNumber("q2_fastest", value)} min={2} max={20} disabled={disabled} />
                <NumberField id="v25-slow-slowest" label="慢線最慢常數" value={config.q3_slowest} onChange={(value) => updateNumber("q3_slowest", value)} min={1} max={10} disabled={disabled} description="必須大於快線最慢常數" />
              </div>
            </Section>

            <Section index="02" title="首單與資金單位" subtitle="Base_Lot_Size 在全部入口固定解讀為 USDT 金額，實際合約數量由交易所規格換算。" icon={Gauge} tone="amber">
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(220px,.8fr)]">
                <NumberField id="v25-base-lot" label="首單金額" value={config.Base_Lot_Size} onChange={(value) => updateNumber("Base_Lot_Size", value)} min={1} step={1} unit="USDT" disabled={disabled} />
                <div className="rounded-lg border border-amber-300/20 bg-amber-300/[0.06] p-3.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-100"><LockKeyhole className="h-4 w-4" /> 單位鎖定</div>
                  <p className="mt-2 text-xs leading-5 text-amber-100/60">回測、新增策略與快照導入均保存同一 USDT 數值；不以數量模式重新解讀。</p>
                </div>
              </div>
            </Section>

            <Section index="03" title="三重出場防線" subtitle="硬止損、固定止盈與追蹤止盈獨立判斷；百分比均使用名義價格變動。" icon={Crosshair} tone="amber">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <NumberField id="v25-hard-stop" label="硬止損" value={config.Hard_Stop_Loss_Pct} onChange={(value) => updateNumber("Hard_Stop_Loss_Pct", value)} min={0} max={10} step={0.1} unit="%" disabled={disabled} description="0 表示停用" />
                <NumberField id="v25-fixed-tp" label="固定止盈" value={config.Take_Profit_Pct} onChange={(value) => updateNumber("Take_Profit_Pct", value)} min={0} max={10} step={0.1} unit="%" disabled={disabled} description="0 表示停用" />
                <div className="sm:col-span-2 xl:col-span-1">
                  <ToggleRow id="v25-trailing-enabled" title="追蹤止盈" description="超過啟動門檻後，以峰值回撤判定平倉。" checked={config.Trailing_TP_Enabled} onCheckedChange={(checked) => onChange({ ...config, Trailing_TP_Enabled: checked })} disabled={disabled} />
                </div>
                <NumberField id="v25-trailing-activation" label="追蹤啟動" value={config.Trailing_Activation_Pct} onChange={(value) => updateNumber("Trailing_Activation_Pct", value)} min={0.1} max={5} step={0.05} unit="%" disabled={disabled || !config.Trailing_TP_Enabled} />
                <NumberField id="v25-trailing-callback" label="追蹤回撤" value={config.Trailing_Callback_Pct} onChange={(value) => updateNumber("Trailing_Callback_Pct", value)} min={0.05} max={3} step={0.05} unit="%" disabled={disabled || !config.Trailing_TP_Enabled} />
              </div>
            </Section>

            <Section index="04" title="動態階梯馬丁" subtitle="範圍沒有固定列數；每一層只會命中一個連續區間，倍率與價格間距分開保存。" icon={Layers3}>
              <div className="space-y-4">
                <ToggleRow id="v25-martin-enabled" title="階梯馬丁控制器" description="停用後核心不產生加倉決策，但保留完整範圍供快照往返。" checked={config.Martin_Enabled} onCheckedChange={(checked) => onChange({ ...config, Martin_Enabled: checked })} disabled={disabled} />
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="min-w-[700px] w-full text-left" aria-label="V2.5 階梯式馬丁範圍">
                    <thead className="bg-slate-900/95 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                      <tr>
                        <th className="px-3 py-3 font-medium">區段</th>
                        <th className="px-3 py-3 font-medium">起始層</th>
                        <th className="px-3 py-3 font-medium">結束層</th>
                        <th className="px-3 py-3 font-medium">倍率</th>
                        <th className="px-3 py-3 font-medium">間距 %</th>
                        <th className="px-3 py-3 text-right font-medium">控制</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 bg-slate-950/70">
                      {config.Martin_Ranges.map((range, index) => (
                        <tr key={`${index}-${range.start}-${range.end}`} className="transition-colors hover:bg-cyan-300/[0.035]">
                          <td className="px-3 py-3 font-mono text-xs text-cyan-300">R{String(index + 1).padStart(2, "0")}</td>
                          {(["start", "end", "multiplier", "gap"] as const).map((key) => (
                            <td key={key} className="px-3 py-2">
                              <Input
                                aria-label={`範圍 ${index + 1} ${key}`}
                                type="number"
                                inputMode="decimal"
                                value={range[key]}
                                min={key === "multiplier" || key === "gap" ? 0.1 : 1}
                                max={key === "multiplier" ? 5 : key === "gap" ? 20 : undefined}
                                step={key === "start" || key === "end" ? 1 : 0.1}
                                disabled={disabled || !config.Martin_Enabled}
                                onChange={(event) => updateRange(index, key, Number(event.target.value))}
                                className="h-9 min-w-[88px] border-slate-700 bg-slate-900/75 font-mono text-xs text-slate-100 focus-visible:border-cyan-400/60 focus-visible:ring-cyan-400/20"
                              />
                            </td>
                          ))}
                          <td className="px-3 py-2 text-right">
                            <Button type="button" variant="ghost" size="icon" aria-label={`刪除範圍 ${index + 1}`} disabled={disabled || config.Martin_Ranges.length <= 1} onClick={() => removeRange(index)} className="h-9 w-9 text-slate-500 hover:bg-red-400/10 hover:text-red-300">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button type="button" variant="outline" disabled={disabled || !config.Martin_Enabled} onClick={addRange} className="border-cyan-300/25 bg-cyan-300/[0.04] text-cyan-100 hover:bg-cyan-300/10 hover:text-cyan-50">
                  <Plus className="mr-2 h-4 w-4" /> 新增連續範圍
                </Button>
              </div>
            </Section>

            <div className="grid gap-4 lg:grid-cols-2">
              <Section index="05" title="趨勢重入" subtitle="止盈平倉後若趨勢條件仍成立，可在下一次評估立即原方向重入。" icon={RotateCcw} tone="emerald">
                <ToggleRow id="v25-reentry" title="止盈後原地重入" description="無冷卻期；硬止損平倉不授予重入資格。" checked={config.Reentry_On_Trend} onCheckedChange={(checked) => onChange({ ...config, Reentry_On_Trend: checked })} disabled={disabled} />
              </Section>
              <Section index="06" title="訊號週期" subtitle="執行器、自主信號與快照部署共用同一分鐘值。" icon={Clock3} tone="emerald">
                <NumberField id="v25-kline-period" label="K 線週期" value={config.K_Line_Period} onChange={(value) => updateNumber("K_Line_Period", value)} min={1} max={1440} step={1} unit="分鐘" disabled={disabled} />
              </Section>
            </div>
          </div>

          <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
            <div className="rounded-xl border border-slate-800 bg-slate-950/75 p-4">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-300">
                <RadioTower className="h-4 w-4 text-cyan-300" /> 作戰摘要
              </div>
              <dl className="mt-4 space-y-3">
                {[
                  ["三K突破", "影線高低點"],
                  ["首單", `${config.Base_Lot_Size} USDT`],
                  ["馬丁範圍", `${config.Martin_Ranges.length} 段 / ${maxLayer} 層`],
                  ["硬止損", config.Hard_Stop_Loss_Pct === 0 ? "停用" : `${config.Hard_Stop_Loss_Pct}%`],
                  ["固定止盈", config.Take_Profit_Pct === 0 ? "停用" : `${config.Take_Profit_Pct}%`],
                  ["重入", config.Reentry_On_Trend ? "已啟用" : "已停用"],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3 border-b border-slate-800/80 pb-2.5 last:border-0 last:pb-0">
                    <dt className="text-xs text-slate-500">{label}</dt>
                    <dd className="text-right font-mono text-xs font-semibold text-slate-200">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className={cn("rounded-xl border p-4", validation.valid ? "border-emerald-400/20 bg-emerald-400/[0.055]" : "border-amber-400/25 bg-amber-400/[0.06]") }>
              <div className={cn("flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em]", validation.valid ? "text-emerald-200" : "text-amber-200") }>
                {validation.valid ? <ShieldCheck className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
                {validation.valid ? "契約校驗通過" : `待修正 ${validation.issues.length} 項`}
              </div>
              {validation.valid ? (
                <p className="mt-2 text-xs leading-5 text-emerald-100/60">目前配置可由回測、快照與交易 API 接受；提交時後端仍會再次校驗。</p>
              ) : (
                <ul className="mt-3 space-y-2" aria-live="polite">
                  {validation.issues.slice(0, 6).map((issue) => (
                    <li key={`${issue.path}-${issue.message}`} className="text-xs leading-5 text-amber-100/75"><span className="font-mono text-amber-200">{issue.path}</span>：{issue.message}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/45 p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">執行語義</p>
              <p className="mt-2 text-xs leading-5 text-slate-400">止盈、止損、追蹤與馬丁間距皆為名義價格百分比；不因策略槓桿倍數自動改寫。</p>
            </div>

            <Button type="button" variant="ghost" disabled={disabled} onClick={() => onChange(createV25DefaultConfig())} className="w-full justify-start text-slate-400 hover:bg-slate-800 hover:text-slate-100">
              <RotateCcw className="mr-2 h-4 w-4" /> 還原文件預設值
            </Button>
          </aside>
        </div>
      </div>
    </div>
  );
}

export default V25ConfigPanel;
