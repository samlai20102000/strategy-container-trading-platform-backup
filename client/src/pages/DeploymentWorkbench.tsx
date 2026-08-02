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
import ExecutionProfileSummary from "@/components/ExecutionProfileSummary";
import { InstanceSelector } from "@/components/InstanceSelector";
import { SymbolCombobox } from "@/components/SymbolCombobox";
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
import { buildDeploymentLineage } from "@/lib/deploymentLineage";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type DeploymentRow = RouterOutputs["deployments"]["list"][number];
type TransitionRow = RouterOutputs["deployments"]["getHistory"][number];
type RecentModeDecisionRow = RouterOutputs["deployments"]["getStatus"]["recentDecisions"][number];
type WorkbenchPanel = "manage" | "quick-start";
type QuickStartSource = "STRATEGY_INSTANCE" | "PARAMETER_SNAPSHOT" | "STRATEGY_DEFINITION";

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
    </section>
  );
}

const EXECUTION_MODES: ExecutionMode[] = [
  "SINGLE_EXCLUSIVE",
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
  const [workspacePanel, setWorkspacePanel] = useState<WorkbenchPanel>(() => (
    new URLSearchParams(window.location.search).get("panel") === "quick-start" ? "quick-start" : "manage"
  ));
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

  const [policyOpen, setPolicyOpen] = useState(false);
  const [quickCreatedId, setQuickCreatedId] = useState<number | null>(null);
  const [quickSymbolSpec, setQuickSymbolSpec] = useState<{
    base: string;
    quote: string;
    minOrderQty?: number;
    qtyStep?: number;
  } | null>(null);
  const [quickForm, setQuickForm] = useState({
    sourceKind: "STRATEGY_INSTANCE" as QuickStartSource,
    sourceStrategyId: "",
    sourceSnapshotId: "",
    strategyKey: "",
    name: "",
    apiKeyId: "",
    symbol: "BTCUSDT",
    executionMode: "SINGLE_EXCLUSIVE" as ExecutionMode,
    positionSize: "30",
    positionMode: "usdt" as "usdt" | "quantity",
    leverage: "1",
    direction: "both" as "long" | "short" | "both",
    maxPositionPct: "20",
    stopLossPct: "0",
    takeProfitPct: "0",
    maxDailyLoss: "0",
  });
  const [quickPolicy, setQuickPolicy] = useState<ExecutionPolicy>(() => (
    createDefaultStrategyExecutionPolicy(undefined, "SINGLE_EXCLUSIVE")
  ));

  const listInput = useMemo(() => ({
    includeArchived,
    executionMode: modeFilter === "ALL" ? undefined : modeFilter,
    activationState: stateFilter === "ALL" ? undefined : stateFilter,
  }), [includeArchived, modeFilter, stateFilter]);
  const statusInput = useMemo(() => ({ deploymentId: selectedId ?? 0 }), [selectedId]);
  const historyInput = useMemo(() => ({ deploymentId: selectedId ?? 0, limit: 100 }), [selectedId]);
  const quickSnapshotsInput = useMemo(() => ({ sortBy: "createdAt" as const, limit: 100 }), []);

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
  const quickStrategiesQuery = trpc.strategies.list.useQuery(undefined, { staleTime: 5_000 });
  const quickSnapshotsQuery = trpc.backtest.getSnapshots.useQuery(quickSnapshotsInput, { staleTime: 5_000 });

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
  const activeLineage = buildDeploymentLineage(activeDeployment);
  const quickSelectedApiKey = apiKeysQuery.data?.find(key => String(key.id) === quickForm.apiKeyId) ?? null;
  const quickSelectedStrategy = quickStrategiesQuery.data?.find(strategy => String(strategy.id) === quickForm.sourceStrategyId) ?? null;
  const quickSelectedSnapshot = quickSnapshotsQuery.data?.find(snapshot => String(snapshot.id) === quickForm.sourceSnapshotId) ?? null;
  const quickCreatedDeployment = deployments.find(item => item.id === quickCreatedId)
    ?? (activeDeployment?.id === quickCreatedId ? activeDeployment : null);
  const quickPreflightReady = quickCreatedId !== null
    && preflightReport?.deploymentId === quickCreatedId
    && preflightReport.deploymentRevision === Number(quickCreatedDeployment?.deploymentRevision ?? preflightReport.deploymentRevision)
    && isFreshEligiblePreflight(preflightReport);
  const quickCanCreate = Boolean(
    quickForm.name.trim()
    && quickForm.apiKeyId
    && quickForm.strategyKey
    && quickForm.symbol.trim()
    && (quickForm.sourceKind !== "STRATEGY_INSTANCE" || quickForm.sourceStrategyId)
    && (quickForm.sourceKind !== "PARAMETER_SNAPSHOT" || quickForm.sourceSnapshotId)
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

  const resetQuickResult = () => {
    setQuickCreatedId(null);
    setLatestReport(null);
  };

  const setQuickMode = (executionMode: ExecutionMode) => {
    resetQuickResult();
    setQuickForm(form => ({ ...form, executionMode }));
    setQuickPolicy(createDefaultStrategyExecutionPolicy(quickForm.strategyKey || undefined, executionMode));
  };

  const selectQuickStrategy = (value: string) => {
    resetQuickResult();
    const strategy = quickStrategiesQuery.data?.find(item => String(item.id) === value);
    const strategyKey = strategy?.strategyKey ?? "";
    const executionMode = asMode(strategy?.executionMode);
    setQuickForm(form => ({
      ...form,
      sourceStrategyId: value === "__none" ? "" : value,
      sourceSnapshotId: "",
      strategyKey,
      name: strategy ? `${strategy.name} · ${DEPLOYMENT_MODE_META[executionMode].code} 部署` : form.name,
      apiKeyId: strategy?.apiKeyId ? String(strategy.apiKeyId) : form.apiKeyId,
      symbol: strategy?.symbol ?? form.symbol,
      executionMode,
    }));
    setQuickPolicy(normalizeStrategyExecutionPolicy(strategyKey || undefined, {
      ...(strategy?.executionPolicy && typeof strategy.executionPolicy === "object" ? strategy.executionPolicy : {}),
      mode: executionMode,
    }));
  };

  const selectQuickSnapshot = (value: string) => {
    resetQuickResult();
    const snapshot = quickSnapshotsQuery.data?.find(item => String(item.id) === value);
    const settings = snapshot?.backtestSettings as Record<string, unknown> | null | undefined;
    const config = snapshot?.config as Record<string, unknown> | null | undefined;
    const executionMode = snapshot?.artifact?.executionMode
      ? asMode(snapshot.artifact.executionMode)
      : quickForm.executionMode;
    const sourceSymbol = settings?.symbol ?? config?.symbol ?? config?.Symbol;
    const rawSize = settings?.baseLotSize ?? settings?.tradeAmount;
    setQuickForm(form => ({
      ...form,
      sourceStrategyId: "",
      sourceSnapshotId: value,
      strategyKey: snapshot?.strategyKey ?? "",
      name: snapshot ? `${snapshot.snapshotName || snapshot.strategyName || snapshot.strategyKey} · 部署` : form.name,
      symbol: typeof sourceSymbol === "string" ? sourceSymbol.replace(/-/g, "").toUpperCase() : form.symbol,
      positionSize: typeof rawSize === "number" && rawSize > 0 ? String(rawSize) : form.positionSize,
      executionMode,
    }));
    setQuickPolicy(normalizeStrategyExecutionPolicy(snapshot?.strategyKey, {
      ...(snapshot?.artifact?.executionPolicy ?? {}),
      mode: executionMode,
    }));
  };

  const selectQuickDefinition = (strategyKey: string) => {
    resetQuickResult();
    const definition = registryQuery.data?.find(item => item.key === strategyKey);
    const executionMode = quickForm.executionMode;
    setQuickForm(form => ({
      ...form,
      sourceStrategyId: "",
      sourceSnapshotId: "",
      strategyKey,
      name: definition ? `${definition.name} · ${DEPLOYMENT_MODE_META[executionMode].code} 部署` : form.name,
    }));
    setQuickPolicy(createDefaultStrategyExecutionPolicy(strategyKey || undefined, executionMode));
  };

  const quickCreateMutation = trpc.deployments.create.useMutation({
    onSuccess: deployment => {
      setQuickCreatedId(deployment.id);
      setSelectedId(deployment.id);
      toast.success("停用部署草稿已建立", { description: "正在執行唯讀 Preflight；不會送出訂單。" });
      void utils.deployments.list.invalidate();
      runPreflightMutation.mutate({
        deploymentId: deployment.id,
        expectedRevision: Number(deployment.deploymentRevision ?? 1),
        transitionKey: buildDeploymentTransitionKey("quick-preflight", deployment.id),
      });
    },
    onError: mutationError,
  });

  const createQuickDraft = () => {
    const positionSize = Number(quickForm.positionSize);
    const leverage = Number(quickForm.leverage);
    const maxPositionPct = Number(quickForm.maxPositionPct);
    const stopLossPct = Number(quickForm.stopLossPct);
    const takeProfitPct = Number(quickForm.takeProfitPct);
    const maxDailyLoss = Number(quickForm.maxDailyLoss);
    if (!quickCanCreate || !Number.isFinite(positionSize) || positionSize <= 0 || !Number.isInteger(leverage) || leverage < 1) {
      toast.error("請完成來源、帳戶、交易對、正數倉位與槓桿設定");
      return;
    }
    quickCreateMutation.mutate({
      name: quickForm.name.trim(),
      description: `由部署工作台快速啟動流程建立；來源 ${quickForm.sourceKind}，建立後固定停用並執行唯讀 Preflight。`,
      apiKeyId: Number(quickForm.apiKeyId),
      symbol: quickForm.symbol.trim().toUpperCase(),
      strategyKey: quickForm.strategyKey,
      ...(quickForm.sourceKind === "STRATEGY_INSTANCE" ? { sourceStrategyId: Number(quickForm.sourceStrategyId) } : {}),
      ...(quickForm.sourceKind === "PARAMETER_SNAPSHOT" ? { sourceSnapshotId: Number(quickForm.sourceSnapshotId) } : {}),
      executionMode: quickForm.executionMode,
      executionPolicy: { ...quickPolicy } as Record<string, unknown>,
      positionSize,
      positionMode: quickForm.positionMode,
      leverage,
      direction: quickForm.direction,
      maxPositionPct: Number.isFinite(maxPositionPct) ? maxPositionPct : 0,
      stopLossPct: Number.isFinite(stopLossPct) ? stopLossPct : 0,
      takeProfitPct: Number.isFinite(takeProfitPct) ? takeProfitPct : 0,
      maxDailyLoss: Number.isFinite(maxDailyLoss) ? maxDailyLoss : 0,
    });
  };

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
  );
}    <div className="mx-auto max-w-[1800px] space-y-6 p-4 sm:p-6 lg:p-8">
        <section className="relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.12),transparent_36%),linear-gradient(135deg,rgba(15,23,42,0.94),rgba(9,14,28,0.96))] p-5 shadow-2xl shadow-black/10 sm:p-7">
          <div className="absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-cyan-300/40 to-transparent" />
          <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300/90">
                <LockKeyhole className="h-4 w-4" /> Canonical Deployment Control Plane
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">部署工作台</h1>
              <p className="mt-3 text-sm leading-6 text-slate-300 sm:text-base">
                以 revision、preflight 與 transition journal 操作 S1 模式。建立、複製與模式切換皆保持停用，只有通過最新唯讀 Gate 後才能明確啟用。
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
              <Button onClick={() => setWorkspacePanel("quick-start")}>
                <Plus className="mr-2 h-4 w-4" />快速啟動
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

        <Tabs
          value={workspacePanel}
          onValueChange={value => setWorkspacePanel(value as WorkbenchPanel)}
          className="space-y-6"
          data-testid="deployment-workbench-panels"
        >
          <TabsList className="grid h-auto w-full grid-cols-2 rounded-xl bg-muted/55 p-1 sm:w-[520px]">
            <TabsTrigger value="manage" className="py-2.5"><Boxes className="mr-2 h-4 w-4" />部署管理</TabsTrigger>
            <TabsTrigger value="quick-start" className="py-2.5"><Play className="mr-2 h-4 w-4" />快速啟動</TabsTrigger>
          </TabsList>

          <TabsContent value="manage" className="space-y-6">
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
          })}
        </div>
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
                      {statusQuery.isLoading && !activeDeployment ? <div className="grid gap-3 sm:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div> : (
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
                            <div
                              data-testid="deployment-version-lineage"
                              className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.035] p-5 lg:col-span-2"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <h3 className="flex items-center gap-2 font-semibold"><History className="h-4 w-4 text-cyan-300" />Version lineage</h3>
                                  <p className="mt-1 text-xs leading-5 text-muted-foreground">直接讀取封印 artifact 與不可由頁面覆蓋的來源 metadata；缺值明確顯示為「—」，不自行推斷。</p>
                                </div>
                                <Badge variant="outline" className="border-cyan-500/30 font-mono text-cyan-300">deployment #{activeDeployment.id}</Badge>
                              </div>
                              <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                                {[
                                  ["Source kind", activeLineage.sourceKind],
                                  ["Source strategy ID", activeLineage.sourceStrategyId],
                                  ["Source snapshot ID", activeLineage.sourceSnapshotId],
                                  ["Snapshot name", activeLineage.snapshotName],
                                  ["Parameter-set version", activeLineage.parameterSetVersion],
                                  ["Strategy version", activeLineage.strategyVersion],
                                  ["Policy version", activeLineage.executionPolicyVersion],
                                  ["Artifact contract", activeLineage.artifactContractVersion],
                                  ["Artifact origin", activeLineage.artifactOrigin],
                                  ["Artifact hash", activeLineage.artifactHash],
                                  ["Imported at", formatDate(activeLineage.importedAt)],
                                  ["Migrated by", activeLineage.migratedBy],
                                  ["Migrated at", formatDate(activeLineage.migratedAt)],
                                ].map(([label, value]) => (
                                  <div key={label} className="min-w-0 rounded-lg border border-border/45 bg-background/35 px-3 py-2.5">
                                    <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
                                    <dd className="mt-1 break-all font-mono text-xs leading-5 text-foreground">{value}</dd>
                                  </div>
                                ))}
                              </dl>
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
          </TabsContent>

          <TabsContent value="quick-start" className="space-y-5">
            <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]" data-testid="quick-start-panel">
              <div className="space-y-5">
                <Card className="border-border/70 bg-card/70">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-300">Step 1 · Source</p>
                        <CardTitle className="mt-2 text-lg">選擇可信策略來源</CardTitle>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">來源只決定要封印的策略與 Execution Profile；建立結果固定為 DRAFT／disabled。</p>
                      </div>
                      <ShieldCheck className="h-6 w-6 text-cyan-300" />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-3">
                      {([
                        ["STRATEGY_INSTANCE", "策略實例", "沿用目前實例與綁定 artifact"],
                        ["PARAMETER_SNAPSHOT", "參數快照", "由可信快照完整還原"],
                        ["STRATEGY_DEFINITION", "策略定義", "從 registry 預設值開始"],
                      ] as const).map(([kind, label, description]) => (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => {
                            resetQuickResult();
                            setQuickForm(form => ({
                              ...form,
                              sourceKind: kind,
                              sourceStrategyId: "",
                              sourceSnapshotId: "",
                              strategyKey: "",
                              name: "",
                            }));
                            setQuickPolicy(createDefaultStrategyExecutionPolicy(undefined, quickForm.executionMode));
                          }}
                          className={`rounded-xl border p-4 text-left transition-[transform,border-color,background-color] duration-150 active:scale-[0.98] ${quickForm.sourceKind === kind ? "border-cyan-400/40 bg-cyan-500/10" : "border-border/60 bg-background/30 hover:border-border"}`}
                        >
                          <span className="font-semibold">{label}</span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
                        </button>
                      ))}
                    </div>

                    {quickForm.sourceKind === "STRATEGY_INSTANCE" && (
                      <div className="space-y-2">
                        <Label>策略實例</Label>
                        <InstanceSelector value={quickForm.sourceStrategyId} onChange={selectQuickStrategy} placeholder="選擇已建立策略實例" />
                      </div>
                    )}
                    {quickForm.sourceKind === "PARAMETER_SNAPSHOT" && (
                      <div className="space-y-2">
                        <Label>參數快照</Label>
                        <Select value={quickForm.sourceSnapshotId || undefined} onValueChange={selectQuickSnapshot}>
                          <SelectTrigger><SelectValue placeholder={quickSnapshotsQuery.isLoading ? "載入快照中..." : "選擇可信參數快照"} /></SelectTrigger>
                          <SelectContent>
                            {(quickSnapshotsQuery.data ?? []).length === 0
                              ? <SelectItem value="__none" disabled>暫無參數快照</SelectItem>
                              : quickSnapshotsQuery.data?.map(snapshot => (
                                <SelectItem key={snapshot.id} value={String(snapshot.id)}>
                                  {snapshot.snapshotName || `快照 #${snapshot.id}`} · {snapshot.strategyName || snapshot.strategyKey}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {quickForm.sourceKind === "STRATEGY_DEFINITION" && (
                      <div className="space-y-2">
                        <Label>Registry 策略定義</Label>
                        <Select value={quickForm.strategyKey || undefined} onValueChange={selectQuickDefinition}>
                          <SelectTrigger><SelectValue placeholder="選擇策略定義" /></SelectTrigger>
                          <SelectContent>{registryQuery.data?.map(strategy => <SelectItem key={strategy.key} value={strategy.key}>{strategy.name}{strategy.isBuiltIn ? " · 內建" : " · 自訂"}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                    )}

                    {quickForm.strategyKey && (
                      <div className="rounded-lg border border-border/60 bg-background/35 px-4 py-3 text-sm">
                        <span className="text-muted-foreground">Resolved strategy key</span>
                        <code className="ml-2 break-all text-cyan-200">{quickForm.strategyKey}</code>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-border/70 bg-card/70">
                  <CardHeader>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-300">Step 2 · Venue</p>
                    <CardTitle className="mt-2 text-lg">帳戶、交易所規格與交易對</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2 sm:col-span-2"><Label>部署名稱</Label><Input value={quickForm.name} onChange={event => { resetQuickResult(); setQuickForm(form => ({ ...form, name: event.target.value })); }} placeholder="例如：BTC H3 保護部署" /></div>
                    <div className="space-y-2">
                      <Label>交易所 API 帳戶</Label>
                      <Select value={quickForm.apiKeyId || undefined} onValueChange={apiKeyId => { resetQuickResult(); setQuickSymbolSpec(null); setQuickForm(form => ({ ...form, apiKeyId })); }}>
                        <SelectTrigger><SelectValue placeholder="選擇已驗證 API key" /></SelectTrigger>
                        <SelectContent>{apiKeysQuery.data?.map(key => <SelectItem key={key.id} value={String(key.id)}>{key.label} · {key.exchange.toUpperCase()}{key.isTestnet ? " · Testnet" : " · Production"}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>交易對</Label>
                      {quickSelectedApiKey && ["okx", "bybit"].includes(quickSelectedApiKey.exchange.toLowerCase()) ? (
                        <SymbolCombobox
                          value={quickForm.symbol}
                          exchange={quickSelectedApiKey.exchange.toLowerCase() as "okx" | "bybit"}
                          testnet={Boolean(quickSelectedApiKey.isTestnet)}
                          onChange={option => {
                            resetQuickResult();
                            setQuickSymbolSpec(option);
                            setQuickForm(form => ({ ...form, symbol: option.symbol }));
                          }}
                        />
                      ) : (
                        <Input value={quickForm.symbol} onChange={event => { resetQuickResult(); setQuickSymbolSpec(null); setQuickForm(form => ({ ...form, symbol: event.target.value.toUpperCase() })); }} />
                      )}
                    </div>
                    {quickSelectedApiKey && (
                      <div className="rounded-lg border border-border/60 bg-background/35 p-3 text-xs text-muted-foreground sm:col-span-2">
                        <div className="flex flex-wrap gap-x-5 gap-y-2">
                          <span>Exchange：<strong className="text-foreground">{quickSelectedApiKey.exchange.toUpperCase()}</strong></span>
                          <span>Environment：<strong className={quickSelectedApiKey.isTestnet ? "text-emerald-300" : "text-amber-300"}>{quickSelectedApiKey.isTestnet ? "Testnet" : "Production"}</strong></span>
                          <span>Base／Quote：<strong className="text-foreground">{quickSymbolSpec ? `${quickSymbolSpec.base}/${quickSymbolSpec.quote}` : "選擇交易對後載入"}</strong></span>
                          <span>Min qty：<strong className="text-foreground">{quickSymbolSpec?.minOrderQty ?? "—"}</strong></span>
                          <span>Qty step：<strong className="text-foreground">{quickSymbolSpec?.qtyStep ?? "—"}</strong></span>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-border/70 bg-card/70">
                  <CardHeader>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-300">Step 3 · Mode & Risk</p>
                    <CardTitle className="mt-2 text-lg">Execution mode 與風控預算</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <div className="grid gap-3 sm:grid-cols-3">
                      {EXECUTION_MODES.map(mode => {
                        const meta = DEPLOYMENT_MODE_META[mode];
                        return (
                          <button key={mode} type="button" onClick={() => setQuickMode(mode)} className={`rounded-xl border p-4 text-left transition-[transform,border-color,background-color] active:scale-[0.98] ${quickForm.executionMode === mode ? meta.accent : "border-border bg-background/30"}`}>
                            <span className="font-mono text-lg font-bold">{meta.code}</span><p className="mt-1 font-semibold">{meta.label}</p><p className="mt-1 text-xs leading-5 opacity-80">{meta.shortDescription}</p>
                          </button>
                        );
                      })}
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="space-y-2"><Label>基礎倉位</Label><Input type="number" min="0" step="any" value={quickForm.positionSize} onChange={event => { resetQuickResult(); setQuickForm(form => ({ ...form, positionSize: event.target.value })); }} /></div>
                      <div className="space-y-2"><Label>倉位單位</Label><Select value={quickForm.positionMode} onValueChange={positionMode => { resetQuickResult(); setQuickForm(form => ({ ...form, positionMode: positionMode as "usdt" | "quantity" })); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="usdt">USDT 名義金額</SelectItem><SelectItem value="quantity">Base 數量</SelectItem></SelectContent></Select></div>
                      <div className="space-y-2"><Label>槓桿</Label><Input type="number" min="1" max="125" value={quickForm.leverage} onChange={event => { resetQuickResult(); setQuickForm(form => ({ ...form, leverage: event.target.value })); }} /></div>
                      <div className="space-y-2"><Label>允許方向</Label><Select value={quickForm.direction} onValueChange={direction => { resetQuickResult(); setQuickForm(form => ({ ...form, direction: direction as "long" | "short" | "both" })); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="both">LONG + SHORT</SelectItem><SelectItem value="long">僅 LONG</SelectItem><SelectItem value="short">僅 SHORT</SelectItem></SelectContent></Select></div>
                      <div className="space-y-2"><Label>最大部位 %</Label><Input type="number" min="0" max="100" value={quickForm.maxPositionPct} onChange={event => { resetQuickResult(); setQuickForm(form => ({ ...form, maxPositionPct: event.target.value })); }} /></div>
                      <div className="space-y-2"><Label>止損 %</Label><Input type="number" min="0" max="100" value={quickForm.stopLossPct} onChange={event => { resetQuickResult(); setQuickForm(form => ({ ...form, stopLossPct: event.target.value })); }} /></div>
                      <div className="space-y-2"><Label>止盈 %</Label><Input type="number" min="0" value={quickForm.takeProfitPct} onChange={event => { resetQuickResult(); setQuickForm(form => ({ ...form, takeProfitPct: event.target.value })); }} /></div>
                      <div className="space-y-2"><Label>每日最大損失</Label><Input type="number" min="0" value={quickForm.maxDailyLoss} onChange={event => { resetQuickResult(); setQuickForm(form => ({ ...form, maxDailyLoss: event.target.value })); }} /></div>
                    </div>
                    <details className="rounded-xl border border-border/60 bg-background/25 p-4">
                      <summary className="cursor-pointer font-semibold">進階 Execution Policy</summary>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">沿用工作台既有 PolicyEditor；變更仍由後端 capability manifest 認證。</p>
                      <div className="mt-4"><PolicyEditor policy={quickPolicy} strategyKey={quickForm.strategyKey || undefined} onChange={policy => { resetQuickResult(); setQuickPolicy(policy); }} /></div>
                    </details>
                  </CardContent>
                </Card>
              </div>

              <aside className="space-y-5 xl:sticky xl:top-6 xl:self-start">
                <Card className="border-cyan-500/25 bg-card/80 shadow-lg shadow-cyan-950/10">
                  <CardHeader>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-300">Step 4 · Seal & Preflight</p>
                    <CardTitle className="mt-2 text-lg">安全檢閱與明確啟用</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <ExecutionProfileSummary
                      strategyKey={quickForm.strategyKey || null}
                      executionMode={quickForm.executionMode}
                      executionPolicy={quickPolicy}
                      artifactScope={quickSelectedSnapshot?.artifact?.artifactScope ?? (quickSelectedStrategy?.executionMode ? "EXECUTION_PROFILE" : "GENERATED_PROFILE")}
                      strategyVersion={quickSelectedSnapshot?.artifact?.strategyVersion}
                      integrityValid={quickSelectedSnapshot?.integrityValid}
                      compatible={quickSelectedSnapshot?.compatibility.compatible}
                    />
                    <div className="space-y-2 rounded-xl border border-border/60 bg-background/35 p-4 text-sm">
                      {[
                        [Boolean(quickForm.strategyKey), "可信策略來源已解析"],
                        [Boolean(quickForm.apiKeyId), "API 帳戶已選擇"],
                        [Boolean(quickForm.symbol.trim()), "交易對與規格已確認"],
                        [quickForm.positionSize !== "" && Number(quickForm.positionSize) > 0, "倉位與風控輸入有效"],
                        [true, "建立結果固定 DRAFT／disabled"],
                      ].map(([ok, label]) => (
                        <div key={String(label)} className="flex items-center gap-2">
                          {ok ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" /> : <CircleDotDashed className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          <span className={ok ? "text-foreground" : "text-muted-foreground"}>{String(label)}</span>
                        </div>
                      ))}
                    </div>

                    {!quickCreatedId ? (
                      <Button className="w-full" size="lg" disabled={!quickCanCreate || quickCreateMutation.isPending || runPreflightMutation.isPending} onClick={createQuickDraft}>
                        {quickCreateMutation.isPending || runPreflightMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileCheck2 className="mr-2 h-4 w-4" />}
                        建立停用草稿並執行 Preflight
                      </Button>
                    ) : (
                      <div className="space-y-3">
                        <Alert className={quickPreflightReady ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10"}>
                          {quickPreflightReady ? <ShieldCheck className="h-4 w-4 text-emerald-300" /> : <ShieldAlert className="h-4 w-4 text-amber-300" />}
                          <AlertTitle>{quickPreflightReady ? "Preflight 通過，部署仍停用" : runPreflightMutation.isPending ? "正在執行唯讀 Preflight" : "Preflight 未通過或已失效"}</AlertTitle>
                          <AlertDescription>{quickPreflightReady ? "這是此流程唯一會啟用新曝險的按鈕；仍需再次確認。" : "請檢閱 blocker evidence，修復後重新預檢。"}</AlertDescription>
                        </Alert>
                        {preflightReport?.deploymentId === quickCreatedId && <PreflightPanel report={preflightReport} />}
                        {quickPreflightReady ? (
                          <Button className="w-full bg-emerald-600 text-white hover:bg-emerald-500" size="lg" onClick={() => { setSelectedId(quickCreatedId); setPendingAction("ACTIVATE"); }}>
                            <Play className="mr-2 h-4 w-4" />明確啟用此部署
                          </Button>
                        ) : (
                          <Button
                            className="w-full"
                            variant="outline"
                            disabled={runPreflightMutation.isPending || !quickCreatedDeployment}
                            onClick={() => quickCreatedDeployment && runPreflightMutation.mutate({
                              deploymentId: quickCreatedDeployment.id,
                              expectedRevision: Number(quickCreatedDeployment.deploymentRevision),
                              transitionKey: buildDeploymentTransitionKey("quick-recheck", quickCreatedDeployment.id),
                            })}
                          >
                            {runPreflightMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}修復後重新 Preflight
                          </Button>
                        )}
                        <Button variant="ghost" className="w-full" onClick={() => setWorkspacePanel("manage")}>返回部署管理檢閱完整狀態</Button>
                      </div>
                    )}
                    <p className="text-xs leading-5 text-muted-foreground">Preflight 只讀取帳戶、商品規格、能力 manifest、ledger 與風險證據；本步驟不送出訂單。</p>
                  </CardContent>
                </Card>
              </aside>
            </section>
          </TabsContent>
        </Tabs>
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


  );
}

