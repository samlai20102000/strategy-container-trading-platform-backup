import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EXECUTION_MODES,
  EXECUTION_MODE_META,
  type ExecutionMode,
  type ExecutionPolicy,
  type HedgeGuardedPolicy,
  type SingleExclusivePolicy,
  type StrategyModeCapabilities,
} from "@shared/executionModes";
import {
  createDefaultStrategyExecutionPolicy,
  normalizeStrategyExecutionPolicy,
} from "@shared/strategies/kamaRainbowMartinExecutionPolicy";
import { KAMA_RAINBOW_MARTIN_STRATEGY_KEY } from "@shared/strategies/kamaRainbowMartin";
import { AlertTriangle, CheckCircle2, LockKeyhole, ShieldCheck } from "lucide-react";

type ExecutionModeConfiguratorProps = {
  strategyKey: string;
  value: ExecutionPolicy;
  onChange: (policy: ExecutionPolicy) => void;
  capabilities?: StrategyModeCapabilities | null;
  context?: "backtest" | "strategy" | "deployment";
  disabled?: boolean;
  compact?: boolean;
};

const MODE_ACCENTS: Record<ExecutionMode, string> = {
  SINGLE_EXCLUSIVE: "border-cyan-500/45 bg-cyan-500/10 text-cyan-100",
  MULTI_POSITION: "border-violet-500/45 bg-violet-500/10 text-violet-100",
  HEDGE_GUARDED: "border-amber-500/45 bg-amber-500/10 text-amber-100",
};

const MODE_CODES: Record<ExecutionMode, "S1" | "M2" | "H3"> = {
  SINGLE_EXCLUSIVE: "S1",
  MULTI_POSITION: "M2",
  HEDGE_GUARDED: "H3",
};

function numericValue(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function ExecutionModeConfigurator({
  strategyKey,
  value,
  onChange,
  capabilities,
  context = "backtest",
  disabled = false,
  compact = false,
}: ExecutionModeConfiguratorProps) {
  const supportedModes = capabilities?.supportedModes?.length
    ? capabilities.supportedModes
    : (["SINGLE_EXCLUSIVE"] as ExecutionMode[]);

  const updatePolicy = (patch: Record<string, unknown>) => {
    onChange(normalizeStrategyExecutionPolicy(strategyKey, { ...value, ...patch }));
  };

  const updateRiskBudget = (
    key: "maxGrossNotionalPct" | "maxMarginUsagePct" | "capabilityTtlSeconds",
    next: string,
  ) => {
    const parsed = numericValue(next);
    if (parsed === undefined) return;
    updatePolicy({ riskBudget: { ...value.riskBudget, [key]: parsed } });
  };

  return (
    <section className="rounded-xl border border-cyan-500/25 bg-slate-950/45 p-4 shadow-[0_18px_50px_-36px_rgba(34,211,238,0.65)]">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-cyan-300" />
            <h3 className="text-sm font-semibold text-foreground">執行模式與風控政策</h3>
            <Badge variant="outline" className="border-cyan-500/40 font-mono text-[10px] text-cyan-300">
              {context === "backtest" ? "BACKTEST" : context.toUpperCase()}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            回測、快照與部署共用同一 canonical policy。此處只影響回測；建立實盤部署仍須通過 Preflight 並明確啟用。
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <LockKeyhole className="h-3.5 w-3.5" />
          未認證模式會 fail closed
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="執行模式">
        {EXECUTION_MODES.map((mode) => {
          const meta = EXECUTION_MODE_META[mode];
          const isSupported = supportedModes.includes(mode);
          const selected = value.mode === mode;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || !isSupported}
              onClick={() => onChange(createDefaultStrategyExecutionPolicy(strategyKey, mode))}
              className={`rounded-lg border p-3 text-left transition-[border-color,background-color,transform,opacity] duration-150 active:scale-[0.98] ${
                selected ? MODE_ACCENTS[mode] : "border-border bg-background/40 hover:border-cyan-500/35"
              } ${!isSupported ? "cursor-not-allowed opacity-45" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-base font-bold">{MODE_CODES[mode]}</span>
                {isSupported ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Badge variant="outline" className="text-[9px]">未認證</Badge>
                )}
              </div>
              <span className="mt-1 block text-xs font-semibold">{meta.label}</span>
              <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{meta.description}</span>
            </button>
          );
        })}
      </div>

      <div className={`mt-4 grid gap-3 ${compact ? "md:grid-cols-3" : "md:grid-cols-3 xl:grid-cols-6"}`}>
        <div className="space-y-1.5">
          <Label className="text-[11px]">Gross 上限（%）</Label>
          <Input
            type="number"
            min="1"
            max="500"
            value={value.riskBudget.maxGrossNotionalPct}
            disabled={disabled}
            onChange={(event) => updateRiskBudget("maxGrossNotionalPct", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px]">Margin 上限（%）</Label>
          <Input
            type="number"
            min="1"
            max="100"
            value={value.riskBudget.maxMarginUsagePct}
            disabled={disabled}
            onChange={(event) => updateRiskBudget("maxMarginUsagePct", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px]">能力 TTL（秒）</Label>
          <Input
            type="number"
            min="15"
            max="3600"
            value={value.riskBudget.capabilityTtlSeconds}
            disabled={disabled}
            onChange={(event) => updateRiskBudget("capabilityTtlSeconds", event.target.value)}
          />
        </div>

        {value.mode === "SINGLE_EXCLUSIVE" && (
          <div className="space-y-1.5 md:col-span-3">
            <Label className="text-[11px]">反向訊號處理</Label>
            <Select
              value={(value as SingleExclusivePolicy).oppositeSignalPolicy}
              disabled={disabled}
              onValueChange={(next) => updatePolicy({ oppositeSignalPolicy: next })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="CLOSE_THEN_WAIT">平倉後等待</SelectItem>
                <SelectItem value="CLOSE_THEN_REVERSE">平倉後反手</SelectItem>
                <SelectItem value="IGNORE">忽略反向訊號</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {value.mode === "MULTI_POSITION" && (
          <div className="rounded-lg border border-violet-500/25 bg-violet-500/[0.06] p-3 text-[11px] leading-relaxed text-muted-foreground md:col-span-3">
            <span className="font-semibold text-violet-200">M2 固定不變式：</span>
            LONG／SHORT 各一腿；每腿馬丁層級、止盈及風控狀態完全隔離。分層觸發與倉位仍由下方策略參數控制。
          </div>
        )}

        {value.mode === "HEDGE_GUARDED" && (() => {
          const h3 = value as HedgeGuardedPolicy;
          const isKrmLocked = strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY;
          return (
            <>
              <div className="space-y-1.5">
                <Label className="text-[11px]">主腿浮虧觸發（%）</Label>
                <Input
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={h3.primaryLossTriggerPct}
                  disabled={disabled || isKrmLocked}
                  onChange={(event) => updatePolicy({ primaryLossTriggerPct: numericValue(event.target.value) })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px]">保護腿比例</Label>
                <Input
                  type="number"
                  min="0.01"
                  max="1"
                  step="0.05"
                  value={h3.hedgeRatio}
                  disabled={disabled}
                  onChange={(event) => updatePolicy({ hedgeRatio: numericValue(event.target.value) })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px]">保護冷卻（秒）</Label>
                <Input
                  type="number"
                  min="0"
                  max="86400"
                  value={h3.hedgeCooldownSeconds}
                  disabled={disabled}
                  onChange={(event) => updatePolicy({ hedgeCooldownSeconds: numericValue(event.target.value) })}
                />
              </div>
              <div className="space-y-1.5 md:col-span-3">
                <Label className="text-[11px]">解除保護政策</Label>
                <Select
                  value={h3.unwindPolicy}
                  disabled={disabled}
                  onValueChange={(next) => updatePolicy({ unwindPolicy: next })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CLOSE_LOSER_KEEP_WINNER">關閉虧損腿，保留獲利腿</SelectItem>
                    <SelectItem value="CLOSE_HEDGE_ON_RECOVERY">主腿恢復後關閉保護腿</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[10px] leading-relaxed text-muted-foreground md:col-span-3">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                <span>
                  H3 必須同時滿足主腿浮虧及反向訊號；保護腿禁止馬丁。
                  {isKrmLocked ? " KRM 的觸發門檻依策略契約鎖定為 4%。" : " 可在安全範圍內調整觸發與保護比例。"}
                </span>
              </div>
            </>
          );
        })()}
      </div>
    </section>
  );
}

export default ExecutionModeConfigurator;
