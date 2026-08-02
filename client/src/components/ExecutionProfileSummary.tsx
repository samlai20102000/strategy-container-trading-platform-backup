import { Badge } from "@/components/ui/badge";
import {
  normalizeStrategyExecutionPolicy,
} from "@shared/strategies/kamaRainbowMartinExecutionPolicy";
import type { ExecutionMode, ExecutionPolicy } from "@shared/executionModes";
import { CheckCircle2, ShieldAlert } from "lucide-react";

export interface ExecutionProfileSummaryProps {
  strategyKey?: string | null;
  executionMode?: ExecutionMode | null;
  executionPolicy?: ExecutionPolicy | Record<string, unknown> | null;
  artifactScope?: string | null;
  strategyVersion?: number | null;
  integrityValid?: boolean | null;
  compatible?: boolean | null;
  compact?: boolean;
  className?: string;
}

function policyDetail(policy: ExecutionPolicy): string[] {
  const budget = policy.riskBudget;
  return [
    `Gross ≤ ${budget.maxGrossNotionalPct}%`,
    `Margin ≤ ${budget.maxMarginUsagePct}%`,
    `能力 TTL ${budget.capabilityTtlSeconds}s`,
    "反向訊號：先平後反轉",
    "同一時間僅保留一個方向腿",
  ];
}

export function ExecutionModeBadge({
  className = "",
}: {
  mode?: ExecutionMode | null;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={`border-cyan-500/45 text-cyan-300 ${className}`}>
      S1 · 單倉互斥
    </Badge>
  );
}

export default function ExecutionProfileSummary({
  strategyKey,
  executionPolicy,
  artifactScope,
  strategyVersion,
  integrityValid,
  compatible,
  compact = false,
  className = "",
}: ExecutionProfileSummaryProps) {
  const policy = normalizeStrategyExecutionPolicy(strategyKey, {
    ...(executionPolicy && typeof executionPolicy === "object" ? executionPolicy : {}),
    mode: "SINGLE_EXCLUSIVE",
  });
  const details = policyDetail(policy);
  const isExecutionProfile = artifactScope === "EXECUTION_PROFILE";
  const trusted = integrityValid !== false && compatible !== false;

  return (
    <div className={`rounded-lg border border-border/60 bg-muted/20 ${compact ? "p-2.5" : "p-3"} ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        <ExecutionModeBadge mode={policy.mode} />
        <Badge variant="outline" className={isExecutionProfile ? "border-cyan-500/35 text-cyan-300" : "text-muted-foreground"}>
          {isExecutionProfile ? "Execution Profile" : artifactScope ?? "Legacy artifact"}
        </Badge>
        {strategyVersion != null && (
          <Badge variant="outline" className="text-muted-foreground">Strategy v{strategyVersion}</Badge>
        )}
        {(integrityValid != null || compatible != null) && (
          <Badge
            variant="outline"
            className={trusted
              ? "border-emerald-500/35 text-emerald-300"
              : "border-amber-500/40 text-amber-300"}
          >
            {trusted ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <ShieldAlert className="mr-1 h-3 w-3" />}
            {trusted ? "可信／相容" : "Fail-closed"}
          </Badge>
        )}
      </div>
      {!compact && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          單方向單腿，反向訊號採先平後反轉。Execution policy 由 canonical artifact 封印；建立或套用後仍保持停用，必須重新通過唯讀 Preflight。
        </p>
      )}
      <div className={`mt-2 grid gap-1 text-[11px] text-muted-foreground ${compact ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
        {details.map((detail) => <span key={detail}>• {detail}</span>)}
      </div>
    </div>
  );
}
