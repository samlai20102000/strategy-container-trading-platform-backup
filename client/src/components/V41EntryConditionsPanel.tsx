import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  CandlestickChart,
  GitMerge,
  LockKeyhole,
  RefreshCw,
  Route,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import {
  V41_CONFIG_KEY,
  countEnabledV41EntryConditions,
  hasV41ContinuousDirectionCondition,
  normalizeV41Config,
  summarizeV41EntryConfig,
  validateV41Config,
  type NormalizedV41Config,
  type V41EntryConditionLogic,
  type V41ThreeKMode,
} from "../../../shared/strategies/kama3kMartinV41";

export type V41EntryPanelContext = "strategy" | "backtest" | "snapshot";

export interface V41EntryConditionsPanelProps {
  value: unknown;
  onChange: (next: NormalizedV41Config) => void;
  context: V41EntryPanelContext;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  validationIssues?: Array<{ path?: string; message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeV41EntryPanelValue(value: unknown): NormalizedV41Config {
  if (isRecord(value) && isRecord(value[V41_CONFIG_KEY])) {
    return normalizeV41Config(value[V41_CONFIG_KEY]);
  }
  return normalizeV41Config(value);
}

function ConditionToggle({
  id,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
  icon: Icon,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  icon: typeof ShieldCheck;
}) {
  return (
    <div
      className={cn(
        "flex min-h-28 min-w-0 items-start justify-between gap-3 rounded-lg border px-3.5 py-3 transition-[border-color,background-color,transform] duration-150 sm:px-4",
        checked ? "border-emerald-500/35 bg-emerald-500/[0.075]" : "border-slate-700 bg-slate-950/35",
        disabled && "opacity-70",
      )}
      data-testid={`${id}-card`}
    >
      <div className="flex min-w-0 gap-3">
        <div className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
          checked ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-300" : "border-slate-700 bg-slate-900/70 text-slate-500",
        )}>
          <Icon className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <Label htmlFor={id} className={cn("break-words text-sm font-semibold text-slate-100", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
            {title}
          </Label>
          <p className="mt-1 break-words text-[11px] leading-relaxed text-slate-400">{description}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          aria-label={`${title}：${checked ? "已啟用" : "已停用"}`}
          data-testid={`${id}-switch`}
        />
        <span className={cn("font-mono text-[9px] font-bold tracking-wider", checked ? "text-emerald-400" : "text-slate-500")}>
          {checked ? "ENABLED" : "DISABLED"}
        </span>
      </div>
    </div>
  );
}

export function V41EntryConditionsPanel({
  value,
  onChange,
  context,
  disabled = false,
  readOnly = false,
  className,
  validationIssues = [],
}: V41EntryConditionsPanelProps) {
  const config = normalizeV41EntryPanelValue(value);
  const entryCount = countEnabledV41EntryConditions(config);
  const hasContinuousDirection = hasV41ContinuousDirectionCondition(config);
  const locked = disabled || readOnly;
  const contextLabel = context === "strategy" ? "策略交易" : context === "backtest" ? "回測中心" : "參數快照";
  const strictValidation = validateV41Config(config);
  const visibleIssues = [...strictValidation.issues, ...validationIssues].filter(
    (issue, index, issues) => issues.findIndex((candidate) => candidate.message === issue.message) === index,
  );

  const update = <K extends keyof NormalizedV41Config>(key: K, next: NormalizedV41Config[K]) => {
    if (!locked) onChange({ ...config, [key]: next });
  };

  const formula = config.entryConditionLogic === "and"
    ? "全部已啟用條件必須同向通過；任一中性、資料不足或方向不一致即 HOLD。"
    : "任一已啟用條件可提供方向；若同時出現 LONG 與 SHORT 票，仍以衝突 HOLD 收斂。";

  const logicOptions: Array<{ value: V41EntryConditionLogic; title: string; description: string }> = [
    { value: "and", title: "AND｜保守一致", description: "所有已啟用條件都要給出相同方向；新表單預設採此模式。" },
    { value: "or", title: "OR｜任一觸發", description: "任一條件可觸發；相反票衝突時不下單並回傳 HOLD。" },
  ];

  const threeKModes: Array<{ value: V41ThreeKMode; title: string; description: string }> = [
    { value: "breakout", title: "A｜前兩根同向＋第三根收盤破位", description: "第三根 close 突破前兩根最高價（LONG）或最低價（SHORT）。" },
    { value: "three_body_same_direction", title: "B｜三根 K 線實體全部連續同向", description: "三根皆收紅／皆收黑，不另外要求第三根突破前高或前低。" },
  ];

  return (
    <Card
      className={cn(
        "min-w-0 overflow-hidden border-slate-700/80 bg-[linear-gradient(145deg,rgba(15,23,42,0.98),rgba(9,15,27,0.98))] text-slate-100 shadow-[0_16px_48px_rgba(2,6,23,0.28)]",
        className,
      )}
      data-testid={`v41-entry-conditions-${context}`}
    >
      <div className="border-b border-slate-700/75 bg-slate-950/50 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-violet-400/30 bg-violet-400/10 text-violet-300">
              <GitMerge className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="break-words text-sm font-bold tracking-wide text-slate-100">V4.1 入場條件路由</h3>
                <Badge className="border-violet-400/30 bg-violet-400/10 text-[9px] tracking-[0.14em] text-violet-200 hover:bg-violet-400/10">{contextLabel}</Badge>
                {readOnly && <Badge variant="outline" className="border-slate-600 text-[9px] tracking-wider text-slate-400">READ ONLY</Badge>}
              </div>
              <p className="mt-1 max-w-3xl break-words text-[11px] leading-relaxed text-slate-400">
                三個方向條件共用一個全域 AND／OR；只控制 V4.1 新首單與特殊原地重入，不改動馬丁加倉、止盈、止損或平倉。
              </p>
            </div>
          </div>
          <div className={cn(
            "flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-1.5",
            entryCount === 0 ? "border-amber-400/35 bg-amber-400/[0.08]" : "border-emerald-400/30 bg-emerald-400/[0.07]",
          )}>
            <Activity className={cn("size-3.5", entryCount === 0 ? "text-amber-400" : "text-emerald-400")} aria-hidden="true" />
            <span className="font-mono text-[10px] font-semibold text-slate-200" data-testid={`v41-entry-count-${context}`}>
              ENTRY CONDITIONS {entryCount}/3
            </span>
          </div>
        </div>
      </div>

      <CardContent className="min-w-0 space-y-4 p-4 sm:p-5">
        <section className="min-w-0 rounded-lg border border-violet-400/25 bg-violet-400/[0.045] p-3.5" aria-labelledby={`v41-logic-title-${context}`}>
          <div className="mb-3 flex min-w-0 flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p id={`v41-logic-title-${context}`} className="flex items-center gap-2 break-words text-xs font-bold tracking-wide text-slate-100">
                <Route className="size-3.5 shrink-0 text-violet-300" aria-hidden="true" />
                入場邏輯：{config.entryConditionLogic.toUpperCase()}
              </p>
              <p className="mt-1 break-words text-[10px] leading-relaxed text-slate-400">切換只影響之後的新回測與新訊號；舊回測保存建立當下的配置與 hash。</p>
            </div>
            <Badge variant="outline" className="border-violet-400/35 font-mono text-[9px] tracking-wider text-violet-200">GLOBAL ROUTER</Badge>
          </div>
          <RadioGroup
            value={config.entryConditionLogic}
            onValueChange={(next) => update("entryConditionLogic", next as V41EntryConditionLogic)}
            disabled={locked}
            className="grid min-w-0 gap-3 md:grid-cols-2"
            aria-label="V4.1 入場條件邏輯"
            data-testid={`v41-entry-logic-${context}`}
          >
            {logicOptions.map((option) => (
              <Label
                key={option.value}
                htmlFor={`v41-logic-${option.value}-${context}`}
                className={cn(
                  "flex min-h-24 min-w-0 items-start gap-3 rounded-lg border p-3.5 transition-[border-color,background-color,transform] duration-150 active:scale-[0.99]",
                  config.entryConditionLogic === option.value ? "border-violet-400/45 bg-violet-400/10" : "border-slate-700 bg-slate-950/35 hover:border-slate-500",
                  locked ? "cursor-not-allowed opacity-70" : "cursor-pointer",
                )}
              >
                <RadioGroupItem id={`v41-logic-${option.value}-${context}`} value={option.value} className="mt-0.5 border-violet-300 text-violet-300" />
                <span className="min-w-0">
                  <span className="block break-words text-xs font-bold text-slate-100">{option.title}</span>
                  <span className="mt-1.5 block break-words text-[11px] font-normal leading-relaxed text-slate-400">{option.description}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </section>

        <div className="grid min-w-0 gap-3 lg:grid-cols-3">
          <ConditionToggle id={`v41-three-k-${context}`} title="三 K 形態方向" description="依下方 A／B 模式判斷 LONG／SHORT；資料不足或無形態時為中性票。" checked={config.enableThreeKFilter} disabled={locked} onCheckedChange={(checked) => update("enableThreeKFilter", checked)} icon={CandlestickChart} />
          <ConditionToggle id={`v41-fast-slow-${context}`} title="KAMA Fast／Slow 方向" description="Fast > Slow 投 LONG；Fast < Slow 投 SHORT；採持續方向狀態，不只抓交叉瞬間。" checked={config.enableKamaFastSlowCross} disabled={locked} onCheckedChange={(checked) => update("enableKamaFastSlowCross", checked)} icon={TrendingUp} />
          <ConditionToggle id={`v41-price-slow-${context}`} title="Price／Slow KAMA 方向" description="最新已收盤決策 K 的 close 高於 Slow 投 LONG，低於 Slow 投 SHORT。" checked={config.enableKamaPriceVsSlow} disabled={locked} onCheckedChange={(checked) => update("enableKamaPriceVsSlow", checked)} icon={ShieldCheck} />
        </div>

        <section className={cn(
          "min-w-0 rounded-lg border p-3.5 transition-[opacity,border-color,background-color] duration-200",
          config.enableThreeKFilter ? "border-cyan-400/30 bg-cyan-400/[0.055]" : "border-slate-700 bg-slate-950/30 opacity-70",
        )} aria-labelledby={`v41-three-k-mode-title-${context}`}>
          <div className="mb-3 flex min-w-0 flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p id={`v41-three-k-mode-title-${context}`} className="break-words text-xs font-bold tracking-wide text-slate-200">三 K 模式｜A／B 二選一</p>
              <p className="mt-0.5 break-words text-[10px] text-slate-400">模式值完整保留；三 K 開關停用時不參與 AND／OR 計票。</p>
            </div>
            <Badge variant="outline" className={cn("font-mono text-[9px] tracking-wider", config.enableThreeKFilter ? "border-cyan-400/35 text-cyan-300" : "border-slate-600 text-slate-500")}>
              {config.enableThreeKFilter ? "CONDITION ARMED" : "CONDITION STANDBY"}
            </Badge>
          </div>
          <RadioGroup
            value={config.threeKMode}
            onValueChange={(next) => update("threeKMode", next as V41ThreeKMode)}
            disabled={locked || !config.enableThreeKFilter}
            className="grid min-w-0 gap-3 md:grid-cols-2"
            aria-label="V4.1 三 K 模式"
            data-testid={`v41-three-k-mode-${context}`}
          >
            {threeKModes.map((mode) => (
              <Label
                key={mode.value}
                htmlFor={`v41-${mode.value}-${context}`}
                className={cn(
                  "flex min-h-28 min-w-0 items-start gap-3 rounded-lg border p-3.5 transition-[border-color,background-color,transform] duration-150 active:scale-[0.99]",
                  config.threeKMode === mode.value ? "border-cyan-400/45 bg-cyan-400/10" : "border-slate-700 bg-slate-950/35 hover:border-slate-500",
                  locked || !config.enableThreeKFilter ? "cursor-not-allowed" : "cursor-pointer",
                )}
              >
                <RadioGroupItem id={`v41-${mode.value}-${context}`} value={mode.value} className="mt-0.5 border-cyan-300 text-cyan-300" />
                <span className="min-w-0">
                  <span className="block break-words text-xs font-bold text-slate-100">{mode.title}</span>
                  <span className="mt-1.5 block break-words text-[11px] font-normal leading-relaxed text-slate-400">{mode.description}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </section>

        <section className="min-w-0 rounded-lg border border-slate-700 bg-slate-950/35 p-3.5" aria-labelledby={`v41-reentry-title-${context}`}>
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-slate-700 bg-slate-900/70 text-slate-400">
                <RefreshCw className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <Label id={`v41-reentry-title-${context}`} htmlFor={`v41-reentry-${context}`} className={cn("break-words text-sm font-semibold text-slate-100", locked ? "cursor-not-allowed" : "cursor-pointer")}>
                  特殊原地重入（獨立控制）
                </Label>
                <p className="mt-1 break-words text-[11px] leading-relaxed text-slate-400">不算第四個 gate；只控制第 0 層順勢獲利後的立即重入，且必須由至少一項 KAMA 持續方向條件支持。</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
              <span className={cn("font-mono text-[9px] font-bold tracking-wider", config.enableSameDirectionReentry ? "text-emerald-400" : "text-slate-500")}>
                {config.enableSameDirectionReentry ? "ENABLED" : "DISABLED"}
              </span>
              <Switch id={`v41-reentry-${context}`} checked={config.enableSameDirectionReentry} disabled={locked} onCheckedChange={(checked) => update("enableSameDirectionReentry", checked)} data-testid={`v41-reentry-${context}-switch`} />
            </div>
          </div>
          {config.enableSameDirectionReentry && !hasContinuousDirection && (
            <div className="mt-3 flex min-w-0 items-start gap-2 rounded-md border border-amber-400/35 bg-amber-400/[0.07] px-3 py-2 text-[11px] leading-relaxed text-amber-100" role="alert">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" aria-hidden="true" />
              <p className="break-words">重入目前會 fail-closed：請至少啟用「KAMA Fast／Slow」或「Price／Slow KAMA」。</p>
            </div>
          )}
        </section>

        <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div className={cn(
            "flex min-w-0 items-start gap-2.5 rounded-md border px-3 py-2.5 text-[11px] leading-relaxed",
            entryCount === 0 ? "border-amber-400/35 bg-amber-400/[0.07] text-amber-100" : "border-emerald-400/25 bg-emerald-400/[0.055] text-slate-200",
          )} role="status" data-testid={`v41-entry-summary-${context}`}>
            {entryCount === 0 ? <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden="true" /> : <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden="true" />}
            <div className="min-w-0">
              <p className="break-words font-semibold">{summarizeV41EntryConfig(config)}</p>
              <p className="mt-1 break-words text-slate-400">{entryCount === 0 ? "Fail-closed：前端禁止執行，後端 strict validator 亦拒絕儲存或回測。" : formula}</p>
            </div>
          </div>
          <div className={cn(
            "min-w-0 rounded-md border px-3 py-2.5",
            visibleIssues.length === 0 ? "border-slate-700 bg-slate-950/35" : "border-amber-400/30 bg-amber-400/[0.055]",
          )}>
            <p className="flex items-center gap-2 text-[10px] font-bold tracking-wide text-slate-300">
              <LockKeyhole className="size-3.5 text-violet-300" aria-hidden="true" />
              VALIDATION SUMMARY
            </p>
            {visibleIssues.length === 0 ? (
              <p className="mt-1.5 break-words text-[11px] leading-relaxed text-emerald-300">配置可執行；儲存與回測仍會由後端 strict validator 再驗證。</p>
            ) : (
              <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-amber-200" data-testid={`v41-validation-issues-${context}`}>
                {visibleIssues.slice(0, 4).map((issue) => (
                  <li key={`${issue.path ?? "config"}-${issue.message}`} className="flex min-w-0 items-start gap-1.5">
                    <span aria-hidden="true">—</span>
                    <span className="min-w-0 break-words">{issue.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default V41EntryConditionsPanel;
