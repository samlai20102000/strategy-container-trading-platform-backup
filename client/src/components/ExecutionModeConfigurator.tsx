import { useEffect } from "react";
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
  type ExecutionPolicy,
  type SingleExclusivePolicy,
  type StrategyModeCapabilities,
} from "@shared/executionModes";
import {
  createDefaultStrategyExecutionPolicy,
  normalizeStrategyExecutionPolicy,
} from "@shared/strategies/kamaRainbowMartinExecutionPolicy";
import { LockKeyhole, ShieldCheck } from "lucide-react";

type ExecutionModeConfiguratorProps = {
  strategyKey: string;
  value: ExecutionPolicy;
  onChange: (policy: ExecutionPolicy) => void;
  capabilities?: StrategyModeCapabilities | null;
  context?: "backtest" | "strategy" | "deployment";
  disabled?: boolean;
  compact?: boolean;
};

function numericValue(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function ExecutionModeConfigurator({
  strategyKey,
  value,
  onChange,
  context = "backtest",
  disabled = false,
  compact = false,
}: ExecutionModeConfiguratorProps) {
  const singlePolicy = normalizeStrategyExecutionPolicy(strategyKey, value.mode === "SINGLE_EXCLUSIVE"
    ? value
    : {
        ...createDefaultStrategyExecutionPolicy(strategyKey, "SINGLE_EXCLUSIVE"),
        riskBudget: value.riskBudget,
        mode: "SINGLE_EXCLUSIVE",
      }) as SingleExclusivePolicy;

  useEffect(() => {
    if (value.mode !== "SINGLE_EXCLUSIVE") {
      onChange(singlePolicy);
    }
  }, [onChange, singlePolicy, value.mode]);

  const updatePolicy = (patch: Record<string, unknown>) => {
    onChange(normalizeStrategyExecutionPolicy(strategyKey, {
      ...singlePolicy,
      ...patch,
      mode: "SINGLE_EXCLUSIVE",
    }));
  };

  const updateRiskBudget = (
    key: "maxGrossNotionalPct" | "maxMarginUsagePct" | "capabilityTtlSeconds",
    next: string,
  ) => {
    const parsed = numericValue(next);
    if (parsed === undefined) return;
    updatePolicy({ riskBudget: { ...singlePolicy.riskBudget, [key]: parsed } });
  };

  return (
    <section
      className="rounded-xl border border-cyan-500/25 bg-slate-950/45 p-4 shadow-[0_18px_50px_-36px_rgba(34,211,238,0.65)]"
      data-testid="s1-only-execution-policy"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-cyan-300" />
            <h3 className="text-sm font-semibold text-foreground">S1 單模式與風控政策</h3>
            <Badge variant="outline" className="border-cyan-500/40 font-mono text-[10px] text-cyan-300">
              {context === "backtest" ? "BACKTEST" : context.toUpperCase()}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            回測、快照與部署均採用 S1 單倉獨占政策；此處保留共通風控與反向訊號設定。
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <LockKeyhole className="h-3.5 w-3.5" />
          實盤部署仍須通過 Preflight 並明確啟用
        </div>
      </div>

      <div
        className="mt-4 rounded-lg border border-cyan-500/45 bg-cyan-500/10 p-3"
        aria-label="S1 單倉獨占"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-base font-bold text-cyan-100">S1</p>
            <p className="mt-1 text-xs font-semibold text-cyan-50">單倉獨占</p>
          </div>
          <Badge variant="outline" className="border-emerald-500/35 bg-emerald-500/10 text-emerald-300">
            已鎖定
          </Badge>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          同一商品同一時間僅允許一個方向的單一倉位；反向訊號依下方政策處理。
        </p>
      </div>

      <div className={`mt-4 grid gap-3 ${compact ? "md:grid-cols-3" : "md:grid-cols-3 xl:grid-cols-6"}`}>
        <div className="space-y-1.5">
          <Label className="text-[11px]">Gross 上限（%）</Label>
          <Input
            type="number"
            min="1"
            max="500"
            value={singlePolicy.riskBudget.maxGrossNotionalPct}
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
            value={singlePolicy.riskBudget.maxMarginUsagePct}
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
            value={singlePolicy.riskBudget.capabilityTtlSeconds}
            disabled={disabled}
            onChange={(event) => updateRiskBudget("capabilityTtlSeconds", event.target.value)}
          />
        </div>

        <div className="space-y-1.5 md:col-span-3">
          <Label className="text-[11px]">反向訊號處理</Label>
          <Select
            value={singlePolicy.oppositeSignalPolicy}
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
      </div>
    </section>
  );
}

export default ExecutionModeConfigurator;
