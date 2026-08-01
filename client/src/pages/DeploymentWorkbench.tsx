import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowRightLeft,
  Ban,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleDotDashed,
  Copy,
  FileCheck2,
  Gauge,
  History,
  Loader2,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  TimerReset,
  Waves,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  type DeploymentActivationState,
  type ExecutionMode,
  type ExecutionPolicy,
} from "@shared/executionModes";
import { KAMA_RAINBOW_MARTIN_STRATEGY_KEY } from "@shared/strategies/kamaRainbowMartin";
import {
  KAMA_RAINBOW_MARTIN_H3_PRIMARY_LOSS_TRIGGER_PCT,
  createDefaultStrategyExecutionPolicy,
  normalizeStrategyExecutionPolicy,
} from "@shared/strategies/kamaRainbowMartinExecutionPolicy";
import DashboardLayout from "@/components/DashboardLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DEPLOYMENT_MODE_META,
  DEPLOYMENT_SAFETY_COPY,
  DEPLOYMENT_STATE_META,
  buildDeploymentTransitionKey,
  canSwitchDeploymentMode,
  getWorkbenchLifecycleActions,
  isFreshEligiblePreflight,
  type WorkbenchLifecycleAction,
} from "@/lib/deploymentWorkbench";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type DeploymentRow = RouterOutputs["deployments"]["list"][number];
type TransitionRow = RouterOutputs["deployments"]["getHistory"][number];
type RecentModeDecisionRow = RouterOutputs["deployments"]["getStatus"]["recentDecisions"][number];

interface PreflightCheckView {
  code: string;
  category: string;
  status: "PASS" | "WARNING" | "BLOCKED";
  message: string;
  evidence: Record<string, unknown>;
}

interface PreflightReportView {
  deploymentId: number;
  deploymentRevision: number;
  executionMode: ExecutionMode;
  checkedAt: number;
  expiresAt: number;
  eligible: boolean;
  blockerCodes: string[];
  warningCodes: string[];
  checks: PreflightCheckView[];
  riskEvidence: {
    accountEquity: number | null;
    availableBalance: number | null;
    grossNotional: number | null;
    grossNotionalPct: number | null;
    usedMargin: number | null;
    marginUsagePct: number | null;
  };
  preflightHash: string;
}

function RecentModeDecisionsPanel({
  rows,
  isLoading,
}: {
  rows: RecentModeDecisionRow[];
  isLoading: boolean;
}) {
  return (
    <section
      data-testid="canonical-mode-decisions"
      className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.035] p-5"
      aria-label="Canonical mode decisions"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-4 w-4 text-cyan-300" />Canonical mode decisions
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            最近 runtime 授權決策的唯讀證據；target leg 為空代表該候選未指向既有腿，介面不會自行推斷。
          </p>
        </div>
        <Badge variant="outline" className="border-cyan-500/30 text-cyan-300">{rows.length} 筆</Badge>
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
      ) : rows.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
          尚無 canonical mode decision；部署仍可保持 DRAFT／停用，不代表已取得交易授權。
        </div>
      ) : (
        <div className="mt-4 grid gap-2">
          {rows.slice(0, 10).map(row => {
            const mode = asMode(row.executionMode);
            const allowed = String(row.outcome).toUpperCase() === "ALLOW";
            return (
              <article key={row.decisionId} className="rounded-lg border border-border/60 bg-background/55 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {modeBadge(mode)}
                  <Badge
                    variant="outline"
                    className={allowed
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-300"}
                  >
                    {String(row.outcome)}
                  </Badge>
                  <code className="break-all rounded bg-secondary/60 px-1.5 py-0.5 text-[10px] text-foreground">{row.reasonCode}</code>
                  <time className="ml-auto text-[10px] text-muted-foreground">{formatDate(row.createdAt)}</time>
                </div>
                <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-[90px_1fr_90px_1fr]">
                  <dt className="text-muted-foreground">Source</dt><dd className="font-mono">{row.source}</dd>
                  <dt className="text-muted-foreground">Target leg</dt><dd className="break-all font-mono">{row.legId ?? "—（未封印）"}</dd>
                  <dt className="text-muted-foreground">Cycle</dt><dd className="break-all font-mono">{row.cycleId ?? "—（未封印）"}</dd>
                  <dt className="text-muted-foreground">Candidate</dt><dd className="break-all font-mono">{row.candidateId}</dd>
                  <dt className="text-muted-foreground">Decision</dt><dd className="break-all font-mono sm:col-span-3">{row.decisionId}</dd>
                </dl>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

const EXECUTION_MODES: ExecutionMode[] = [
  "SINGLE_EXCLUSIVE",
  "MULTI_POSITION",
  "HEDGE_GUARDED",
];

const ACTIVATION_STATES: DeploymentActivationState[] = [
  "LEGACY",
  "DRAFT",
  "DISABLED",
  "PREFLIGHT_FAILED",
  "READY_DISABLED",
  "ARMED",
  "ACTIVE",
  "PAUSED",
  "DRAINING",
  "BLOCKED",
  "ARCHIVED",
];

const ACTION_COPY: Record<WorkbenchLifecycleAction, {
  label: string;
  description: string;
  confirmLabel: string;
}> = {
  PREFLIGHT: {
    label: "執行唯讀預檢",
    description: DEPLOYMENT_SAFETY_COPY.readonlyPreflight,
    confirmLabel: "執行預檢",
  },
  ACTIVATE: {
    label: "啟用部署",
    description: "這是唯一會讓部署進入 ACTIVE 的操作。系統會再次驗證最新 revision 與未過期的 passing preflight。",
    confirmLabel: "確認啟用",
  },
  PAUSE: {
    label: "暫停新曝險",
    description: "部署將進入 PAUSED，禁止增加曝險，但保留 reduce／close 維運能力。",
    confirmLabel: "確認暫停",
  },
  RESUME: {
    label: "重新預檢並恢復",
    description: "恢復不是 enabled toggle；系統會先執行全新唯讀預檢，再以新的 revision 明確啟用。",
    confirmLabel: "預檢並恢復",
  },
  DRAIN: {
    label: "排空既有曝險",
    description: "部署將進入 DRAINING，只允許 reduce／close，不允許新開倉或加倉。",
    confirmLabel: "進入排空",
  },
  DISABLE: {
    label: "停用部署",
    description: "部署將保持停用；若要再次啟用，必須重新執行 preflight。",
    confirmLabel: "確認停用",
  },
  BLOCK: {
    label: "風控封鎖",
    description: "立即 fail-closed。部署只保留降低風險的路徑，待調查完成後再處理。",
    confirmLabel: "確認封鎖",
  },
  ARCHIVE: {
    label: "封存部署",
    description: "僅 flat 且完全對帳的部署可封存。封存後不可再啟用。",
    confirmLabel: "確認封存",
  },
};

function parsePreflightReport(input: unknown): PreflightReportView | null {
  if (!input || typeof input !== "object") return null;
  const report = input as Partial<PreflightReportView>;
  if (!Array.isArray(report.checks) || !Array.isArray(report.blockerCodes)) return null;
  return report as PreflightReportView;
}

function asState(value: unknown): DeploymentActivationState {
  return ACTIVATION_STATES.includes(value as DeploymentActivationState)
    ? value as DeploymentActivationState
    : "LEGACY";
}

function asMode(value: unknown): ExecutionMode {
  return EXECUTION_MODES.includes(value as ExecutionMode)
    ? value as ExecutionMode
    : "SINGLE_EXCLUSIVE";
}

function formatDate(value: Date | string | number | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
}

function modeBadge(modeValue: unknown) {
  const mode = asMode(modeValue);
  const meta = DEPLOYMENT_MODE_META[mode];
  return (
    <Badge variant="outline" className={meta.accent}>
      {meta.code} · {meta.label}
    </Badge>
  );
}

function stateBadge(stateValue: unknown) {
  const state = asState(stateValue);
  const meta = DEPLOYMENT_STATE_META[state];
  return (
    <Badge variant="outline" className={meta.tone}>
      {meta.label}
    </Badge>
  );
}

function PolicyEditor({
  policy,
  strategyKey,
  onChange,
}: {
  policy: ExecutionPolicy;
  strategyKey?: string | null;
  onChange: (policy: ExecutionPolicy) => void;
}) {
  const isKamaRainbowMartin = strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY;
  const updateRisk = (field: keyof ExecutionPolicy["riskBudget"], value: number) => {
    onChange({
      ...policy,
      riskBudget: { ...policy.riskBudget, [field]: value },
    } as ExecutionPolicy);
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="gross-budget">Gross 上限（%）</Label>
          <Input
            id="gross-budget"
            type="number"
            min={1}
            max={500}
            value={policy.riskBudget.maxGrossNotionalPct}
            onChange={event => updateRisk("maxGrossNotionalPct", Number(event.target.value))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="margin-budget">Margin 上限（%）</Label>
          <Input
            id="margin-budget"
            type="number"
            min={1}
            max={100}
            value={policy.riskBudget.maxMarginUsagePct}
            onChange={event => updateRisk("maxMarginUsagePct", Number(event.target.value))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="capability-ttl">能力 TTL（秒）</Label>
          <Input
            id="capability-ttl"
            type="number"
            min={15}
            max={3600}
            value={policy.riskBudget.capabilityTtlSeconds}
            onChange={event => updateRisk("capabilityTtlSeconds", Number(event.target.value))}
          />
        </div>
      </div>

      {policy.mode === "SINGLE_EXCLUSIVE" && (
        <div className="space-y-2">
          <Label>反向信號策略</Label>
          <Select
            value={policy.oppositeSignalPolicy}
            onValueChange={value => onChange({ ...policy, oppositeSignalPolicy: value } as ExecutionPolicy)}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="CLOSE_THEN_WAIT">先平倉後等待</SelectItem>
              <SelectItem value="CLOSE_THEN_REVERSE">先平倉再反向</SelectItem>
              <SelectItem value="IGNORE">忽略反向信號</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {policy.mode === "MULTI_POSITION" && (
        <Alert className="border-violet-500/30 bg-violet-500/10">
          <Boxes className="h-4 w-4 text-violet-300" />
          <AlertTitle>M2 固定安全契約</AlertTitle>
          <AlertDescription>
            最多兩腿、LONG／SHORT 各一腿，馬丁與出場狀態按 leg 隔離；這些不變量不可由 UI 關閉。
          </AlertDescription>
        </Alert>
      )}

      {policy.mode === "HEDGE_GUARDED" && (
        <div className="space-y-4 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>主腿浮虧觸發（%）</Label>
              <Input
                type="number"
                min={0.1}
                max={100}
                step={0.1}
                value={policy.primaryLossTriggerPct}
                disabled={isKamaRainbowMartin}
                onChange={event => onChange({
                  ...policy,
                  primaryLossTriggerPct: Number(event.target.value),
                })}
              />
              {isKamaRainbowMartin && (
                <p className="text-xs leading-5 text-amber-200/80">
                  KRM canonical 契約固定為 {KAMA_RAINBOW_MARTIN_H3_PRIMARY_LOSS_TRIGGER_PCT}%：先於預設 5% 硬止損啟動保護腿。
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>對沖比例</Label>
              <Input
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                value={policy.hedgeRatio}
                onChange={event => onChange({ ...policy, hedgeRatio: Number(event.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label>最大對沖比例</Label>
              <Input
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                value={policy.maxHedgeRatio}
                onChange={event => onChange({ ...policy, maxHedgeRatio: Number(event.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label>對沖冷卻（秒）</Label>
              <Input
                type="number"
                min={0}
                max={86400}
                value={policy.hedgeCooldownSeconds}
                onChange={event => onChange({ ...policy, hedgeCooldownSeconds: Number(event.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label>最短持有（秒）</Label>
              <Input
                type="number"
                min={0}
                max={86400}
                value={policy.minimumHedgeHoldSeconds}
                onChange={event => onChange({ ...policy, minimumHedgeHoldSeconds: Number(event.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label>解除策略</Label>
              <Select
                value={policy.unwindPolicy}
                onValueChange={value => onChange({ ...policy, unwindPolicy: value } as ExecutionPolicy)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CLOSE_LOSER_KEEP_WINNER">平虧損腿、保留獲利腿</SelectItem>
                  <SelectItem value="CLOSE_HEDGE_ON_RECOVERY">主腿恢復時平保護腿</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs leading-5 text-amber-200/80">
            H3 必須同時滿足主腿浮虧門檻與反向信號。保護腿馬丁固定停用，backend 會再次正規化並驗證。
          </p>
        </div>
      )}
    </div>
  );
}

function PreflightPanel({ report }: { report: PreflightReportView | null }) {
  const [category, setCategory] = useState("ALL");
  const categories = useMemo(
    () => report ? Array.from(new Set(report.checks.map(check => check.category))) : [],
    [report],
  );
  const checks = useMemo(
    () => report?.checks.filter(check => category === "ALL" || check.category === category) ?? [],
    [category, report],
  );

  if (!report) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/10 p-8 text-center">
        <FileCheck2 className="mb-4 h-10 w-10 text-muted-foreground/50" />
        <h3 className="font-semibold">尚無 canonical preflight report</h3>
        <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
          執行唯讀預檢後，這裡會顯示帳戶、交易所、商品規格、精確關腿、ledger、資金與資料新鮮度 Gate。
        </p>
      </div>
    );
  }

  const fresh = isFreshEligiblePreflight(report);
  return (
    <div className="space-y-5">
      <div className={`rounded-xl border p-5 ${report.eligible ? "border-emerald-500/30 bg-emerald-500/8" : "border-rose-500/30 bg-rose-500/8"}`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            {report.eligible
              ? <ShieldCheck className="mt-0.5 h-6 w-6 text-emerald-400" />
              : <ShieldAlert className="mt-0.5 h-6 w-6 text-rose-400" />}
            <div>
              <h3 className="font-semibold">{report.eligible ? "全部必要 Gate 通過" : "Preflight 已封鎖"}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                revision {report.deploymentRevision} · {formatDate(report.checkedAt)} · {fresh ? "仍在有效期" : "已過期或不合格"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className={fresh ? "border-emerald-500/30 text-emerald-300" : "border-amber-500/30 text-amber-300"}>
              {fresh ? "FRESH" : "STALE"}
            </Badge>
            <Badge variant="outline">{report.checks.length} checks</Badge>
            <Badge variant="outline" className="border-rose-500/30 text-rose-300">
              {report.blockerCodes.length} blockers
            </Badge>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[
          ["帳戶權益", report.riskEvidence.accountEquity],
          ["可用餘額", report.riskEvidence.availableBalance],
          ["Gross Notional", report.riskEvidence.grossNotional],
          ["Gross／權益", report.riskEvidence.grossNotionalPct, "%"],
          ["已用 Margin", report.riskEvidence.usedMargin],
          ["Margin／權益", report.riskEvidence.marginUsagePct, "%"],
        ].map(([label, value, suffix]) => (
          <div key={String(label)} className="rounded-lg border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 font-mono text-base font-semibold">{formatNumber(value as number | null)}{suffix}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={category === "ALL" ? "default" : "outline"} onClick={() => setCategory("ALL")}>全部</Button>
        {categories.map(item => (
          <Button key={item} size="sm" variant={category === item ? "default" : "outline"} onClick={() => setCategory(item)}>
            {item}
          </Button>
        ))}
      </div>

      <div className="space-y-2">
        {checks.map(check => (
          <div key={check.code} className="rounded-lg border border-border/60 bg-card/50 p-4">
            <div className="flex items-start gap-3">
              {check.status === "PASS" && <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />}
              {check.status === "WARNING" && <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />}
              {check.status === "BLOCKED" && <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{check.code}</span>
                  <Badge variant="outline" className="text-[10px]">{check.category}</Badge>
                </div>
                <p className="mt-1 text-sm leading-6">{check.message}</p>
                {Object.keys(check.evidence ?? {}).length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">查看 evidence</summary>
                    <pre className="mt-2 overflow-x-auto rounded-md bg-background/70 p-3 text-[11px] leading-5 text-muted-foreground">
                      {JSON.stringify(check.evidence, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryTimeline({ rows }: { rows: TransitionRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center text-center text-muted-foreground">
        <History className="mb-3 h-9 w-9 opacity-40" />
        <p>尚無 lifecycle transition journal</p>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {rows.map((row, index) => (
        <div key={row.id} className="relative flex gap-4 pb-6">
          {index < rows.length - 1 && <div className="absolute left-[11px] top-7 h-[calc(100%-1.25rem)] w-px bg-border" />}
          <div className={`mt-1.5 h-6 w-6 shrink-0 rounded-full border-4 border-background ${row.status === "APPLIED" ? "bg-emerald-400" : row.status === "BLOCKED" || row.status === "FAILED" ? "bg-rose-400" : "bg-amber-400"}`} />
          <div className="min-w-0 flex-1 rounded-lg border border-border/60 bg-card/50 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                {stateBadge(row.fromState)}
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                {stateBadge(row.toState)}
                <Badge variant="outline">{row.status}</Badge>
              </div>
              <span className="text-xs text-muted-foreground">{formatDate(row.completedAt ?? row.createdAt)}</span>
            </div>
            <p className="mt-3 text-sm font-medium">{row.reasonCode}</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{row.reason}</p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
              <span>rev {row.expectedRevision} → {row.resultingRevision ?? "—"}</span>
              <span>{row.fromMode} → {row.toMode}</span>
              <span className="truncate">key {row.transitionKey}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DeploymentWorkbench() {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [modeFilter, setModeFilter] = useState<ExecutionMode | "ALL">("ALL");
  const [stateFilter, setStateFilter] = useState<DeploymentActivationState | "ALL">("ALL");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const requestedId = Number(new URLSearchParams(window.location.search).get("deploymentId"));
    return Number.isSafeInteger(requestedId) && requestedId > 0 ? requestedId : null;
  });
  const [latestReport, setLatestReport] = useState<PreflightReportView | null>(null);
  const [pendingAction, setPendingAction] = useState<WorkbenchLifecycleAction | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);

  const listInput = useMemo(() => ({
    includeArchived,
    executionMode: modeFilter === "ALL" ? undefined : modeFilter,
    activationState: stateFilter === "ALL" ? undefined : stateFilter,
  }), [includeArchived, modeFilter, stateFilter]);
  const statusInput = useMemo(() => ({ deploymentId: selectedId ?? 0 }), [selectedId]);
  const historyInput = useMemo(() => ({ deploymentId: selectedId ?? 0, limit: 100 }), [selectedId]);

  const deploymentsQuery = trpc.deployments.list.useQuery(listInput, {
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
  const statusQuery = trpc.deployments.getStatus.useQuery(statusInput, {
    enabled: selectedId !== null,
    refetchInterval: 10_000,
  });
  const historyQuery = trpc.deployments.getHistory.useQuery(historyInput, {
    enabled: selectedId !== null,
    refetchInterval: 15_000,
  });
  const apiKeysQuery = trpc.apiKeys.list.useQuery();
  const registryQuery = trpc.registry.listDefinitions.useQuery(undefined);

  const deployments = deploymentsQuery.data ?? [];
  const filteredDeployments = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return deployments;
    return deployments.filter(item => [
      item.name,
      item.symbol,
      item.strategyKey,
      item.deploymentKey,
      String(item.id),
    ].some(value => String(value ?? "").toLowerCase().includes(query)));
  }, [deployments, search]);

  useEffect(() => {
    if (selectedId !== null && deployments.some(item => item.id === selectedId)) return;
    setSelectedId(deployments[0]?.id ?? null);
  }, [deployments, selectedId]);

  useEffect(() => {
    setLatestReport(null);
  }, [selectedId]);

  const selectedFromList = deployments.find(item => item.id === selectedId);
  const activeDeployment = statusQuery.data?.deployment ?? selectedFromList ?? null;
  const activeState = asState(activeDeployment?.activationState);
  const activeMode = asMode(activeDeployment?.executionMode);
  const activeRevision = Number(activeDeployment?.deploymentRevision ?? 0);
  const storedReport = parsePreflightReport(activeDeployment?.preflightReport);
  const preflightReport = latestReport?.deploymentId === selectedId ? latestReport : storedReport;
  const availableActions = getWorkbenchLifecycleActions(activeState);
  const activePolicy = normalizeStrategyExecutionPolicy(
    activeDeployment?.strategyKey,
    activeDeployment?.executionPolicy ?? { mode: activeMode },
  );

  const stats = useMemo(() => ({
    total: deployments.length,
    active: deployments.filter(item => item.activationState === "ACTIVE").length,
    closeOnly: deployments.filter(item => ["PAUSED", "DRAINING", "BLOCKED"].includes(String(item.activationState))).length,
    blocked: deployments.filter(item => item.activationState === "PREFLIGHT_FAILED" || item.activationState === "BLOCKED").length,
  }), [deployments]);

  const refreshDeployment = () => {
    void utils.deployments.list.invalidate();
    if (selectedId !== null) {
      void utils.deployments.getStatus.invalidate({ deploymentId: selectedId });
      void utils.deployments.getHistory.invalidate({ deploymentId: selectedId, limit: 100 });
    }
  };

  const mutationError = (error: { message: string }) => {
    toast.error(error.message);
    refreshDeployment();
  };

  const runPreflightMutation = trpc.deployments.runPreflight.useMutation({
    onSuccess: result => {
      const report = parsePreflightReport(result.report);
      setLatestReport(report);
      toast.success(report?.eligible ? "Preflight 全部必要 Gate 通過；部署仍保持停用。" : "Preflight 已完成並維持 fail-closed。", {
        description: report?.eligible ? "請檢閱報告後再明確啟用。" : report?.blockerCodes.join("、") ?? "回傳報告格式無法辨識，請重新載入部署狀態。",
      });
      refreshDeployment();
    },
    onError: mutationError,
  });
  const activateMutation = trpc.deployments.activate.useMutation({ onSuccess: () => { toast.success("部署已明確啟用"); refreshDeployment(); }, onError: mutationError });
  const pauseMutation = trpc.deployments.pause.useMutation({ onSuccess: () => { toast.success("部署已暫停新曝險"); refreshDeployment(); }, onError: mutationError });
  const resumeMutation = trpc.deployments.resume.useMutation({ onSuccess: result => { setLatestReport(parsePreflightReport(result.report)); toast.success("全新 preflight 通過，部署已恢復"); refreshDeployment(); }, onError: mutationError });
  const drainMutation = trpc.deployments.drain.useMutation({ onSuccess: () => { toast.success("部署已進入 DRAINING"); refreshDeployment(); }, onError: mutationError });
  const disableMutation = trpc.deployments.disable.useMutation({ onSuccess: () => { toast.success("部署已停用"); refreshDeployment(); }, onError: mutationError });
  const blockMutation = trpc.deployments.block.useMutation({ onSuccess: () => { toast.success("部署已 fail-closed 封鎖"); refreshDeployment(); }, onError: mutationError });
  const archiveMutation = trpc.deployments.archive.useMutation({ onSuccess: () => { toast.success("部署已封存"); refreshDeployment(); }, onError: mutationError });

  const isLifecyclePending = [
    runPreflightMutation,
    activateMutation,
    pauseMutation,
    resumeMutation,
    drainMutation,
    disableMutation,
    blockMutation,
    archiveMutation,
  ].some(mutation => mutation.isPending);

  const executeLifecycleAction = (action: WorkbenchLifecycleAction) => {
    if (!activeDeployment) return;
    const input = {
      deploymentId: activeDeployment.id,
      expectedRevision: activeRevision,
      transitionKey: buildDeploymentTransitionKey(action, activeDeployment.id),
    };
    setPendingAction(null);
    switch (action) {
      case "PREFLIGHT": runPreflightMutation.mutate(input); break;
      case "ACTIVATE": activateMutation.mutate(input); break;
      case "PAUSE": pauseMutation.mutate(input); break;
      case "RESUME": resumeMutation.mutate(input); break;
      case "DRAIN": drainMutation.mutate(input); break;
      case "DISABLE": disableMutation.mutate(input); break;
      case "BLOCK": blockMutation.mutate(input); break;
      case "ARCHIVE": archiveMutation.mutate(input); break;
    }
  };

  const [createForm, setCreateForm] = useState({
    name: "",
    apiKeyId: "",
    symbol: "BTCUSDT",
    strategyKey: "",
    executionMode: "SINGLE_EXCLUSIVE" as ExecutionMode,
  });
  const createMutation = trpc.deployments.create.useMutation({
    onSuccess: deployment => {
      toast.success("部署草稿已建立", { description: DEPLOYMENT_SAFETY_COPY.defaultDisabled });
      setCreateOpen(false);
      setSelectedId(deployment.id);
      setCreateForm({ name: "", apiKeyId: "", symbol: "BTCUSDT", strategyKey: "", executionMode: "SINGLE_EXCLUSIVE" });
      refreshDeployment();
    },
    onError: mutationError,
  });

  const [copyForm, setCopyForm] = useState({ name: "", executionMode: activeMode });
  useEffect(() => {
    if (activeDeployment) setCopyForm({ name: `${activeDeployment.name} 副本`, executionMode: activeMode });
  }, [activeDeployment?.id, activeDeployment?.name, activeMode]);
  const copyMutation = trpc.deployments.copy.useMutation({
    onSuccess: deployment => {
      toast.success("部署副本已建立並保持停用");
      setCopyOpen(false);
      setSelectedId(deployment.id);
      refreshDeployment();
    },
    onError: mutationError,
  });

  const [targetMode, setTargetMode] = useState<ExecutionMode>(activeMode);
  const [targetPolicy, setTargetPolicy] = useState<ExecutionPolicy>(() => (
    createDefaultStrategyExecutionPolicy(undefined, activeMode)
  ));
  const openModeDialog = () => {
    const nextMode = activeMode === "SINGLE_EXCLUSIVE" ? "MULTI_POSITION" : "SINGLE_EXCLUSIVE";
    setTargetMode(nextMode);
    setTargetPolicy(createDefaultStrategyExecutionPolicy(activeDeployment?.strategyKey, nextMode));
    setModeOpen(true);
  };
  const switchModeMutation = trpc.deployments.switchMode.useMutation({
    onSuccess: result => {
      setLatestReport(parsePreflightReport(result.report));
      toast.success("模式切換 preflight 通過，policy 已更新且部署保持停用");
      setModeOpen(false);
      refreshDeployment();
    },
    onError: mutationError,
  });

  const [policyDraft, setPolicyDraft] = useState<ExecutionPolicy>(activePolicy);
  const openPolicyDialog = () => {
    setPolicyDraft(activePolicy);
    setPolicyOpen(true);
  };
  const updatePolicyMutation = trpc.deployments.updatePolicy.useMutation({
    onSuccess: () => {
      toast.success("Execution policy 已更新，部署保持停用");
      setPolicyOpen(false);
      refreshDeployment();
    },
    onError: mutationError,
  });

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-[1800px] space-y-6 p-4 sm:p-6 lg:p-8">
        <section className="relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.12),transparent_36%),linear-gradient(135deg,rgba(15,23,42,0.94),rgba(9,14,28,0.96))] p-5 shadow-2xl shadow-black/10 sm:p-7">
          <div className="absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-cyan-300/40 to-transparent" />
          <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300/90">
                <LockKeyhole className="h-4 w-4" /> Canonical Deployment Control Plane
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">三模式部署工作台</h1>
              <p className="mt-3 text-sm leading-6 text-slate-300 sm:text-base">
                以 revision、preflight 與 transition journal 操作 S1／M2／H3。建立、複製與模式切換皆保持停用，只有通過最新唯讀 Gate 後才能明確啟用。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="border-slate-600 bg-slate-950/40 text-slate-100 hover:bg-slate-800"
                onClick={() => {
                  void deploymentsQuery.refetch();
                  void statusQuery.refetch();
                  void historyQuery.refetch();
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" />重新載入
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />建立部署草稿
              </Button>
            </div>
          </div>
        </section>

        <Alert className="border-amber-500/25 bg-amber-500/8">
          <ShieldAlert className="h-4 w-4 text-amber-400" />
          <AlertTitle>實盤安全邊界</AlertTitle>
          <AlertDescription className="leading-6">
            {DEPLOYMENT_SAFETY_COPY.defaultDisabled} {DEPLOYMENT_SAFETY_COPY.closeOnly}
          </AlertDescription>
        </Alert>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "目前範圍", value: stats.total, suffix: " deployments", icon: Boxes, tone: "text-cyan-300 bg-cyan-500/10" },
            { label: "ACTIVE", value: stats.active, suffix: " 可新增曝險", icon: Activity, tone: "text-emerald-300 bg-emerald-500/10" },
            { label: "Close-only", value: stats.closeOnly, suffix: " 維運中", icon: Waves, tone: "text-amber-300 bg-amber-500/10" },
            { label: "Blocked", value: stats.blocked, suffix: " 需處理", icon: ShieldAlert, tone: "text-rose-300 bg-rose-500/10" },
          ].map(item => (
            <Card key={item.label} className="border-border/70 bg-card/70 shadow-sm">
              <CardContent className="flex items-center gap-4 p-4">
                <div className={`rounded-xl p-2.5 ${item.tone}`}><item.icon className="h-5 w-5" /></div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">{item.label}</p>
                  <p className="mt-1 text-xl font-semibold">{item.value}<span className="ml-1 text-xs font-normal text-muted-foreground">{item.suffix}</span></p>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="grid min-h-[720px] gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
          <Card className="overflow-hidden border-border/70 bg-card/70">
            <CardHeader className="space-y-4 border-b border-border/60 pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">部署清單</CardTitle>
                <Badge variant="secondary">{filteredDeployments.length}</Badge>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="名稱、商品、策略或 ID" className="pl-9" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Select value={modeFilter} onValueChange={value => setModeFilter(value as ExecutionMode | "ALL")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部模式</SelectItem>
                    {EXECUTION_MODES.map(mode => <SelectItem key={mode} value={mode}>{DEPLOYMENT_MODE_META[mode].code} · {DEPLOYMENT_MODE_META[mode].label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={stateFilter} onValueChange={value => setStateFilter(value as DeploymentActivationState | "ALL")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部狀態</SelectItem>
                    {ACTIVATION_STATES.map(state => <SelectItem key={state} value={state}>{DEPLOYMENT_STATE_META[state].label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button variant={includeArchived ? "secondary" : "ghost"} size="sm" className="justify-start" onClick={() => setIncludeArchived(value => !value)}>
                <Archive className="mr-2 h-4 w-4" />{includeArchived ? "已包含封存" : "顯示封存部署"}
              </Button>
            </CardHeader>
            <ScrollArea className="h-[560px] xl:h-[calc(100vh-25rem)] xl:min-h-[560px]">
              <CardContent className="space-y-2 p-3">
                {deploymentsQuery.isLoading && Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-28 rounded-xl" />)}
                {deploymentsQuery.error && (
                  <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>載入失敗</AlertTitle><AlertDescription>{deploymentsQuery.error.message}</AlertDescription></Alert>
                )}
                {!deploymentsQuery.isLoading && !deploymentsQuery.error && filteredDeployments.length === 0 && (
                  <div className="py-16 text-center text-muted-foreground">
                    <CircleDotDashed className="mx-auto mb-3 h-9 w-9 opacity-40" />
                    <p className="font-medium text-foreground">沒有符合條件的部署</p>
                    <p className="mt-1 text-sm">調整篩選，或建立一個保持停用的草稿。</p>
                  </div>
                )}
                {filteredDeployments.map(deployment => {
                  const selected = deployment.id === selectedId;
                  const state = asState(deployment.activationState);
                  return (
                    <button
                      key={deployment.id}
                      type="button"
                      onClick={() => setSelectedId(deployment.id)}
                      className={`w-full rounded-xl border p-4 text-left transition-[transform,background-color,border-color] duration-150 active:scale-[0.99] ${selected ? "border-cyan-400/40 bg-cyan-500/10 shadow-sm shadow-cyan-950/30" : "border-border/60 bg-background/30 hover:border-border hover:bg-muted/30"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{deployment.name}</p>
                          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">#{deployment.id} · {deployment.symbol}</p>
                        </div>
                        <ChevronRight className={`mt-1 h-4 w-4 shrink-0 ${selected ? "text-cyan-300" : "text-muted-foreground"}`} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">{modeBadge(deployment.executionMode)}{stateBadge(state)}</div>
                      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="truncate">{deployment.strategyKey ?? "legacy-unknown"}</span>
                        <span className="font-mono">rev {deployment.deploymentRevision}</span>
                      </div>
                    </button>
                  );
                })}
              </CardContent>
            </ScrollArea>
          </Card>

          <Card className="min-w-0 overflow-hidden border-border/70 bg-card/70">
            {!activeDeployment ? (
              <div className="flex min-h-[720px] flex-col items-center justify-center p-8 text-center">
                <Boxes className="mb-4 h-12 w-12 text-muted-foreground/30" />
                <h2 className="text-lg font-semibold">選擇一個部署</h2>
                <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">檢視 canonical mode、preflight Gate、ledger 與 transition journal。</p>
              </div>
            ) : (
              <>
                <CardHeader className="border-b border-border/60 bg-background/20 p-5 sm:p-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">{modeBadge(activeMode)}{stateBadge(activeState)}<Badge variant="outline" className="font-mono">rev {activeRevision}</Badge></div>
                      <CardTitle className="mt-3 truncate text-xl sm:text-2xl">{activeDeployment.name}</CardTitle>
                      <p className="mt-2 text-sm text-muted-foreground">{activeDeployment.exchange.toUpperCase()} · {activeDeployment.symbol} · {activeDeployment.strategyKey ?? "legacy strategy"}</p>
                      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{DEPLOYMENT_STATE_META[activeState].description}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => setCopyOpen(true)}><Copy className="mr-2 h-4 w-4" />複製</Button>
                      <Button size="sm" variant="outline" onClick={openPolicyDialog} disabled={!canSwitchDeploymentMode(activeState, Boolean(activeDeployment.enabled))}><Settings2 className="mr-2 h-4 w-4" />Policy</Button>
                      <Button size="sm" variant="outline" onClick={openModeDialog} disabled={!canSwitchDeploymentMode(activeState, Boolean(activeDeployment.enabled))}><ArrowRightLeft className="mr-2 h-4 w-4" />切換模式</Button>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {availableActions.map(action => {
                      const destructive = ["BLOCK", "ARCHIVE"].includes(action);
                      const primary = action === "PREFLIGHT" || action === "ACTIVATE" || action === "RESUME";
                      const Icon = action === "PREFLIGHT" ? FileCheck2
                        : action === "ACTIVATE" || action === "RESUME" ? Play
                        : action === "PAUSE" ? Pause
                        : action === "DRAIN" ? Waves
                        : action === "BLOCK" ? Ban
                        : action === "ARCHIVE" ? Archive
                        : XCircle;
                      return (
                        <Button
                          key={action}
                          size="sm"
                          variant={destructive ? "destructive" : primary ? "default" : "outline"}
                          disabled={isLifecyclePending}
                          onClick={() => action === "PREFLIGHT" ? executeLifecycleAction(action) : setPendingAction(action)}
                        >
                          {isLifecyclePending && action === pendingAction ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Icon className="mr-2 h-4 w-4" />}
                          {ACTION_COPY[action].label}
                        </Button>
                      );
                    })}
                  </div>
                </CardHeader>

                <CardContent className="p-5 sm:p-6">
                  <Tabs defaultValue="overview" className="space-y-5">
                    <TabsList className="grid h-auto w-full grid-cols-3 sm:w-[480px]">
                      <TabsTrigger value="overview"><Gauge className="mr-2 h-4 w-4" />狀態與風險</TabsTrigger>
                      <TabsTrigger value="preflight"><FileCheck2 className="mr-2 h-4 w-4" />Preflight</TabsTrigger>
                      <TabsTrigger value="history"><History className="mr-2 h-4 w-4" />歷史</TabsTrigger>
                    </TabsList>

                    <TabsContent value="overview" className="space-y-5">
                      {statusQuery.isLoading ? <div className="grid gap-3 sm:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div> : (
                        <>
                          <div className="grid gap-4 lg:grid-cols-2">
                            <div className="rounded-xl border border-border/60 bg-background/25 p-5">
                              <h3 className="flex items-center gap-2 font-semibold"><Activity className="h-4 w-4 text-cyan-300" />Deployment identity</h3>
                              <dl className="mt-4 grid grid-cols-[130px_1fr] gap-x-3 gap-y-3 text-sm">
                                <dt className="text-muted-foreground">Deployment key</dt><dd className="truncate font-mono text-xs">{activeDeployment.deploymentKey ?? "—"}</dd>
                                <dt className="text-muted-foreground">Strategy version</dt><dd>{activeDeployment.strategyVersion}</dd>
                                <dt className="text-muted-foreground">API key ID</dt><dd className="font-mono">#{activeDeployment.apiKeyId}</dd>
                                <dt className="text-muted-foreground">Trade mode</dt><dd>{activeDeployment.tradeMode}</dd>
                                <dt className="text-muted-foreground">最後更新</dt><dd>{formatDate(activeDeployment.updatedAt)}</dd>
                              </dl>
                            </div>
                            <div className="rounded-xl border border-border/60 bg-background/25 p-5">
                              <h3 className="flex items-center gap-2 font-semibold"><Gauge className="h-4 w-4 text-violet-300" />Risk budget</h3>
                              <div className="mt-4 grid grid-cols-3 gap-3">
                                <div><p className="text-xs text-muted-foreground">Gross</p><p className="mt-1 font-mono text-lg">{activePolicy.riskBudget.maxGrossNotionalPct}%</p></div>
                                <div><p className="text-xs text-muted-foreground">Margin</p><p className="mt-1 font-mono text-lg">{activePolicy.riskBudget.maxMarginUsagePct}%</p></div>
                                <div><p className="text-xs text-muted-foreground">TTL</p><p className="mt-1 font-mono text-lg">{activePolicy.riskBudget.capabilityTtlSeconds}s</p></div>
                              </div>
                              <Separator className="my-4" />
                              <p className="text-sm leading-6 text-muted-foreground">{DEPLOYMENT_MODE_META[activeMode].shortDescription}。能力 stale 或不相容時一律 fail closed。</p>
                            </div>
                          </div>

                          <div className="rounded-xl border border-border/60 bg-background/25 p-5">
                            <h3 className="flex items-center gap-2 font-semibold"><Boxes className="h-4 w-4 text-amber-300" />Canonical ledger Gate</h3>
                            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                              {[
                                ["Open legs", statusQuery.data?.ledger.openLegCount ?? 0],
                                ["Pending intents", statusQuery.data?.ledger.pendingIntentCount ?? 0],
                                ["Reconciliation", statusQuery.data?.ledger.unresolvedReconciliationCount ?? 0],
                                ["Hedge links", statusQuery.data?.ledger.activeHedgeRelationshipCount ?? 0],
                                ["Reservations", statusQuery.data?.ledger.activeReservationCount ?? 0],
                              ].map(([label, value]) => (
                                <div key={String(label)} className="rounded-lg border border-border/50 bg-card/50 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-mono text-xl font-semibold">{value}</p></div>
                              ))}
                            </div>
                          </div>

                          <RecentModeDecisionsPanel
                            rows={statusQuery.data?.recentDecisions ?? []}
                            isLoading={statusQuery.isLoading}
                          />

                          <div className="grid gap-4 lg:grid-cols-3">
                            {EXECUTION_MODES.map(mode => {
                              const meta = DEPLOYMENT_MODE_META[mode];
                              const current = mode === activeMode;
                              return (
                                <div key={mode} className={`rounded-xl border p-4 ${current ? meta.accent : "border-border/60 bg-background/20"}`}>
                                  <div className="flex items-center justify-between"><span className="font-mono text-lg font-bold">{meta.code}</span>{current && <Badge variant="secondary">CURRENT</Badge>}</div>
                                  <p className="mt-2 font-semibold">{meta.label}</p>
                                  <p className="mt-1 text-sm leading-6 opacity-80">{meta.shortDescription}</p>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </TabsContent>

                    <TabsContent value="preflight"><PreflightPanel report={preflightReport} /></TabsContent>
                    <TabsContent value="history">
                      {historyQuery.isLoading ? <div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-32" /></div> : <HistoryTimeline rows={historyQuery.data ?? []} />}
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </>
            )}
          </Card>
        </section>
      </div>

      <AlertDialog open={pendingAction !== null} onOpenChange={open => { if (!open) setPendingAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingAction ? ACTION_COPY[pendingAction].label : "確認操作"}</AlertDialogTitle>
            <AlertDialogDescription className="leading-6">{pendingAction ? ACTION_COPY[pendingAction].description : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          {pendingAction === "ACTIVATE" && (
            <Alert className="border-rose-500/30 bg-rose-500/10"><ShieldAlert className="h-4 w-4 text-rose-400" /><AlertTitle>這會啟用交易部署</AlertTitle><AlertDescription>確認所選帳戶、商品、策略版本與風險預算均正確。</AlertDescription></Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={pendingAction === "BLOCK" || pendingAction === "ARCHIVE" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
              disabled={isLifecyclePending}
              onClick={() => pendingAction && executeLifecycleAction(pendingAction)}
            >
              {pendingAction ? ACTION_COPY[pendingAction].confirmLabel : "確認"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[680px]">
          <DialogHeader><DialogTitle>建立 canonical deployment</DialogTitle><DialogDescription>{DEPLOYMENT_SAFETY_COPY.defaultDisabled}</DialogDescription></DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2"><Label>部署名稱</Label><Input value={createForm.name} onChange={event => setCreateForm(form => ({ ...form, name: event.target.value }))} placeholder="例如：BTC H3 保護部署" /></div>
            <div className="space-y-2"><Label>交易所帳戶</Label><Select value={createForm.apiKeyId} onValueChange={apiKeyId => setCreateForm(form => ({ ...form, apiKeyId }))}><SelectTrigger><SelectValue placeholder="選擇 API key" /></SelectTrigger><SelectContent>{apiKeysQuery.data?.map(key => <SelectItem key={key.id} value={String(key.id)}>{key.label} · {key.exchange.toUpperCase()}{key.isTestnet ? " · Testnet" : ""}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2"><Label>商品</Label><Input value={createForm.symbol} onChange={event => setCreateForm(form => ({ ...form, symbol: event.target.value.toUpperCase() }))} /></div>
            <div className="space-y-2"><Label>策略版本</Label><Select value={createForm.strategyKey} onValueChange={strategyKey => setCreateForm(form => ({ ...form, strategyKey }))}><SelectTrigger><SelectValue placeholder="選擇 registry 策略" /></SelectTrigger><SelectContent>{registryQuery.data?.map(strategy => <SelectItem key={strategy.key} value={strategy.key}>{strategy.name}{strategy.isBuiltIn ? " · 內建" : " · 自訂"}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2"><Label>Execution mode</Label><Select value={createForm.executionMode} onValueChange={executionMode => setCreateForm(form => ({ ...form, executionMode: executionMode as ExecutionMode }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{EXECUTION_MODES.map(mode => <SelectItem key={mode} value={mode}>{DEPLOYMENT_MODE_META[mode].code} · {DEPLOYMENT_MODE_META[mode].label}</SelectItem>)}</SelectContent></Select></div>
          </div>
          <Alert className="border-cyan-500/25 bg-cyan-500/8"><LockKeyhole className="h-4 w-4 text-cyan-300" /><AlertTitle>安全預設</AlertTitle><AlertDescription>新部署會保存 capability snapshot 與 default policy，狀態固定為 DRAFT／disabled。</AlertDescription></Alert>
          <DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button><Button disabled={createMutation.isPending || !createForm.name.trim() || !createForm.apiKeyId || !createForm.strategyKey || !createForm.symbol.trim()} onClick={() => createMutation.mutate({ name: createForm.name.trim(), apiKeyId: Number(createForm.apiKeyId), symbol: createForm.symbol.trim(), strategyKey: createForm.strategyKey, executionMode: createForm.executionMode })}>{createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}建立停用草稿</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>複製部署設定</DialogTitle><DialogDescription>只複製策略配置；持倉、腿、委託、reservation、馬丁 runtime 與 transition history 不會複製。</DialogDescription></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2"><Label>副本名稱</Label><Input value={copyForm.name} onChange={event => setCopyForm(form => ({ ...form, name: event.target.value }))} /></div>
            <div className="space-y-2"><Label>副本模式</Label><Select value={copyForm.executionMode} onValueChange={executionMode => setCopyForm(form => ({ ...form, executionMode: executionMode as ExecutionMode }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{EXECUTION_MODES.map(mode => <SelectItem key={mode} value={mode}>{DEPLOYMENT_MODE_META[mode].code} · {DEPLOYMENT_MODE_META[mode].label}</SelectItem>)}</SelectContent></Select></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setCopyOpen(false)}>取消</Button><Button disabled={!activeDeployment || !copyForm.name.trim() || copyMutation.isPending} onClick={() => activeDeployment && copyMutation.mutate({ sourceDeploymentId: activeDeployment.id, name: copyForm.name.trim(), executionMode: copyForm.executionMode })}>{copyMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}建立 DRAFT 副本</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={policyOpen} onOpenChange={setPolicyOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]">
          <DialogHeader><DialogTitle>更新 {DEPLOYMENT_MODE_META[activeMode].code} execution policy</DialogTitle><DialogDescription>只有停用且通過 ledger state Gate 的部署可更新；更新後 revision 增加並需重新 preflight。</DialogDescription></DialogHeader>
          <PolicyEditor policy={policyDraft} strategyKey={activeDeployment?.strategyKey} onChange={setPolicyDraft} />
          <DialogFooter><Button variant="outline" onClick={() => setPolicyOpen(false)}>取消</Button><Button disabled={!activeDeployment || updatePolicyMutation.isPending} onClick={() => activeDeployment && updatePolicyMutation.mutate({ deploymentId: activeDeployment.id, expectedRevision: activeRevision, transitionKey: buildDeploymentTransitionKey("policy", activeDeployment.id), executionPolicy: policyDraft as unknown as Record<string, unknown> })}>{updatePolicyMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}儲存並使預檢失效</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modeOpen} onOpenChange={setModeOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[800px]">
          <DialogHeader><DialogTitle>切換 execution mode</DialogTitle><DialogDescription>Backend 會要求 flat、無 pending intents／reconciliation／hedge relationship／reservation，並以目標 policy 執行 fresh preflight。</DialogDescription></DialogHeader>
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              {EXECUTION_MODES.map(mode => {
                const meta = DEPLOYMENT_MODE_META[mode];
                return <button key={mode} type="button" onClick={() => { setTargetMode(mode); setTargetPolicy(createDefaultStrategyExecutionPolicy(activeDeployment?.strategyKey, mode)); }} className={`rounded-xl border p-4 text-left transition-[transform,border-color,background-color] active:scale-[0.98] ${targetMode === mode ? meta.accent : "border-border bg-background/30"}`}><span className="font-mono text-lg font-bold">{meta.code}</span><p className="mt-1 font-semibold">{meta.label}</p><p className="mt-1 text-xs leading-5 opacity-80">{meta.shortDescription}</p></button>;
              })}
            </div>
            <PolicyEditor policy={targetPolicy} strategyKey={activeDeployment?.strategyKey} onChange={setTargetPolicy} />
            <Alert className="border-amber-500/25 bg-amber-500/8"><TimerReset className="h-4 w-4 text-amber-300" /><AlertTitle>原子模式切換</AlertTitle><AlertDescription>目標 policy 預檢、revision 更新與 READY_DISABLED 會在同一 optimistic-lock transaction 提交；不會直接進入 ACTIVE。</AlertDescription></Alert>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setModeOpen(false)}>取消</Button><Button disabled={!activeDeployment || targetMode === activeMode || switchModeMutation.isPending} onClick={() => activeDeployment && switchModeMutation.mutate({ deploymentId: activeDeployment.id, expectedRevision: activeRevision, transitionKey: buildDeploymentTransitionKey("switch-mode", activeDeployment.id), executionMode: targetMode, executionPolicy: targetPolicy as unknown as Record<string, unknown> })}>{switchModeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}執行 flat Gate 與模式切換</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
