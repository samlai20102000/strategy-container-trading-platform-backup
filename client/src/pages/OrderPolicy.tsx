import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Clock3,
  FileClock,
  Gauge,
  History,
  Loader2,
  LockKeyhole,
  RotateCcw,
  Save,
  ShieldCheck,
  TimerReset,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type PolicyView = RouterOutputs["orderPolicy"]["get"];
type PolicyConfig = PolicyView["config"];
type ConfirmAction = "save" | "reset" | null;

const FALLBACKS: Array<{
  key: "allowStopLossTaker" | "allowDailyLossTaker" | "allowKillSwitchTaker";
  title: string;
  reason: string;
  description: string;
}> = [
  {
    key: "allowStopLossTaker",
    title: "硬止損",
    reason: "STOP_LOSS",
    description: "僅在 reduce-only 止損，且 emergency maker 嘗試全數完成後，對剩餘量啟用 taker。",
  },
  {
    key: "allowDailyLossTaker",
    title: "最大日虧",
    reason: "DAILY_LOSS_LIMIT",
    description: "達到日虧上限時，先完成 maker-only，再允許對尚未退出的剩餘量 taker。",
  },
  {
    key: "allowKillSwitchTaker",
    title: "Kill Switch",
    reason: "KILL_SWITCH",
    description: "只接受明確的緊急全平倉授權；人工一般平倉不會取得此權限。",
  },
];

function formatDate(value: Date | string | number | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-TW", { hour12: false });
}

function configSummary(value: unknown) {
  if (!value || typeof value !== "object") return "—";
  const config = value as Partial<PolicyConfig>;
  return [
    `${Math.round(Number(config.standardTtlMs ?? 0) / 1000)}s × ${config.standardMaxAttempts ?? "?"}`,
    `緊急 ${Math.round(Number(config.emergencyTtlMs ?? 0) / 1000)}s × ${config.emergencyMakerAttempts ?? "?"}`,
    `Taker：${[
      config.allowStopLossTaker && "SL",
      config.allowDailyLossTaker && "日虧",
      config.allowKillSwitchTaker && "Kill",
    ].filter(Boolean).join(" / ") || "全關閉"}`,
  ].join(" · ");
}

export default function OrderPolicy() {
  const utils = trpc.useUtils();
  const policyQuery = trpc.orderPolicy.get.useQuery(undefined, { retry: false });
  const historyQuery = trpc.orderPolicy.history.useQuery({ limit: 20 }, { retry: false });
  const [draft, setDraft] = useState<PolicyConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  useEffect(() => {
    if (policyQuery.data && !dirty) setDraft({ ...policyQuery.data.config });
  }, [policyQuery.data, dirty]);

  const enabledFallbackCount = useMemo(() => {
    if (!draft) return 0;
    return FALLBACKS.filter(item => draft[item.key]).length;
  }, [draft]);

  const updateMutation = trpc.orderPolicy.update.useMutation({
    onSuccess: async data => {
      setDraft({ ...data.config });
      setDirty(false);
      setConfirmAction(null);
      await Promise.all([utils.orderPolicy.get.invalidate(), utils.orderPolicy.history.invalidate()]);
      toast.success(`訂單政策已更新至 revision ${data.revision}`);
    },
    onError: error => {
      setConfirmAction(null);
      toast.error(error.message);
    },
  });

  const resetMutation = trpc.orderPolicy.reset.useMutation({
    onSuccess: async data => {
      setDraft({ ...data.config });
      setDirty(false);
      setConfirmAction(null);
      await Promise.all([utils.orderPolicy.get.invalidate(), utils.orderPolicy.history.invalidate()]);
      toast.success(`已回復方案 B 安全預設值（revision ${data.revision}）`);
    },
    onError: error => {
      setConfirmAction(null);
      toast.error(error.message);
    },
  });

  const setConfig = <K extends keyof PolicyConfig>(key: K, value: PolicyConfig[K]) => {
    setDraft(current => current ? { ...current, [key]: value } : current);
    setDirty(true);
  };

  const submitConfirmed = () => {
    if (!policyQuery.data || !draft || !confirmAction) return;
    if (confirmAction === "reset") {
      resetMutation.mutate({
        expectedRevision: policyQuery.data.revision,
        reason: "使用者由訂單政策控制面回復方案 B 安全預設值",
      });
      return;
    }
    updateMutation.mutate({
      expectedRevision: policyQuery.data.revision,
      config: draft,
      reason: "使用者由訂單政策控制面更新全域 Maker-First 政策",
    });
  };

  const pending = updateMutation.isPending || resetMutation.isPending;

  return (
    <DashboardLayout>
      <main className="min-h-full bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.08),transparent_30%),radial-gradient(circle_at_10%_20%,rgba(16,185,129,0.06),transparent_28%)] p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-7xl space-y-6">
          <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/10">
                  <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />方案 B 已強制
                </Badge>
                <Badge variant="outline" className="border-cyan-400/30 text-cyan-300">
                  {policyQuery.data?.policyVersion ?? "GLOBAL_MAKER_FIRST_B_V1"}
                </Badge>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">全域訂單執行政策</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                所有策略共用同一 Maker-First 執行層。您只能在後端安全範圍內調整等待與重掛；一般開倉、加倉及正常平倉永遠不會自動轉為市價。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="h-9 px-3 text-xs">
                Revision {policyQuery.data?.revision ?? "—"}
              </Badge>
              <Button
                variant="outline"
                disabled={!policyQuery.data || pending}
                onClick={() => setConfirmAction("reset")}
              >
                <RotateCcw className="mr-2 h-4 w-4" />回復預設
              </Button>
              <Button
                disabled={!dirty || !draft || pending}
                onClick={() => setConfirmAction("save")}
                className="bg-cyan-500 text-slate-950 hover:bg-cyan-400"
              >
                {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                儲存政策
              </Button>
            </div>
          </header>

          {policyQuery.error ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>政策設定暫時不可用</AlertTitle>
              <AlertDescription>
                {policyQuery.error.message}。中央執行層會 fail-closed，不會使用未確認設定送單。
              </AlertDescription>
            </Alert>
          ) : null}

          <section className="grid gap-4 md:grid-cols-3">
            {[
              { icon: LockKeyhole, title: "一般流程", value: "永遠 Post-Only", copy: "Entry / Add / Normal Close 不具 taker 權限。", tone: "text-emerald-300" },
              { icon: TimerReset, title: "標準重掛", value: draft ? `${draft.standardTtlMs / 1000}s × ${draft.standardMaxAttempts}` : "—", copy: "每次重新讀取 order book，以不穿價價格掛單。", tone: "text-cyan-300" },
              { icon: Zap, title: "緊急流程", value: draft ? `${draft.emergencyTtlMs / 1000}s × ${draft.emergencyMakerAttempts}` : "—", copy: `Taker 條件目前啟用 ${enabledFallbackCount}/3。`, tone: "text-amber-300" },
            ].map(item => (
              <Card key={item.title} className="border-white/8 bg-card/70 shadow-lg shadow-black/5 backdrop-blur">
                <CardContent className="flex items-start gap-4 p-5">
                  <div className="rounded-xl border border-white/10 bg-white/[0.04] p-2.5">
                    <item.icon className={`h-5 w-5 ${item.tone}`} />
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{item.title}</p>
                    <p className="mt-1 text-lg font-semibold">{item.value}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.copy}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </section>

          <Alert className="border-amber-400/25 bg-amber-400/[0.06] text-foreground">
            <AlertTriangle className="h-4 w-4 text-amber-300" />
            <AlertTitle>不可變安全邊界</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-x-1.5 gap-y-2 leading-6 text-muted-foreground">
              <span>Taker fallback 只允許</span>
              {(["STOP_LOSS", "DAILY_LOSS_LIMIT", "KILL_SWITCH"] as const).map(reason => (
                <Badge key={reason} variant="outline" className="border-amber-300/25 bg-amber-300/[0.05] font-mono text-[10px] text-amber-100/80">
                  {reason}
                </Badge>
              ))}
              <span>，且必須為 reduce-only。稽核、查單或設定資料庫不可用時，一律停止新 mutation。</span>
            </AlertDescription>
          </Alert>

          {policyQuery.data ? (
            <section aria-label="不可變執行語義" className="grid gap-3 sm:grid-cols-3">
              <ImmutableRule
                title="價格來源"
                value="每次重讀 Best Bid / Ask"
                detail={policyQuery.data.immutableRules.priceSource}
              />
              <ImmutableRule
                title="被動價格偏移"
                value={`${policyQuery.data.immutableRules.passivePriceOffsetTicks} tick（不穿價）`}
                detail="Post-only rejection 不會改送市價"
              />
              <ImmutableRule
                title="部分成交"
                value="僅撤單並重掛剩餘量"
                detail={policyQuery.data.immutableRules.cancelConfirmationRequired
                  ? "未確認撤單即 fail-closed"
                  : policyQuery.data.immutableRules.partialFill}
              />
            </section>
          ) : null}

          <section className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
            <Card className="border-white/8 bg-card/75 shadow-xl shadow-black/10 backdrop-blur">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Gauge className="h-5 w-5 text-cyan-300" />等待與重掛
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {policyQuery.isLoading || !draft || !policyQuery.data ? (
                  <div className="grid gap-4 sm:grid-cols-2"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
                ) : (
                  <div className="grid gap-5 sm:grid-cols-2">
                    <PolicyNumberField
                      label="標準 TTL（秒）"
                      description="開倉、加倉與正常平倉每張 post-only 的等待時間。"
                      value={draft.standardTtlMs / 1000}
                      min={policyQuery.data.limits.standardTtlMs.min / 1000}
                      max={policyQuery.data.limits.standardTtlMs.max / 1000}
                      onChange={value => setConfig("standardTtlMs", value * 1000)}
                    />
                    <PolicyNumberField
                      label="標準最大提交次數"
                      description="包含第一次送單；到期後仍有剩餘量也不轉市價。"
                      value={draft.standardMaxAttempts}
                      min={policyQuery.data.limits.standardMaxAttempts.min}
                      max={policyQuery.data.limits.standardMaxAttempts.max}
                      onChange={value => setConfig("standardMaxAttempts", value)}
                    />
                    <PolicyNumberField
                      label="緊急 TTL（秒）"
                      description="每次緊急 maker-only 嘗試的等待時間。"
                      value={draft.emergencyTtlMs / 1000}
                      min={policyQuery.data.limits.emergencyTtlMs.min / 1000}
                      max={policyQuery.data.limits.emergencyTtlMs.max / 1000}
                      onChange={value => setConfig("emergencyTtlMs", value * 1000)}
                    />
                    <PolicyNumberField
                      label="緊急 Maker 次數"
                      description="完成此數量的 maker-only 嘗試後，才評估已啟用的 taker 條件。"
                      value={draft.emergencyMakerAttempts}
                      min={policyQuery.data.limits.emergencyMakerAttempts.min}
                      max={policyQuery.data.limits.emergencyMakerAttempts.max}
                      onChange={value => setConfig("emergencyMakerAttempts", value)}
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-card/75 shadow-xl shadow-black/10 backdrop-blur">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Zap className="h-5 w-5 text-amber-300" />緊急 Taker 條件
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {!draft ? <Skeleton className="h-64" /> : FALLBACKS.map((item, index) => (
                  <div key={item.key}>
                    {index > 0 ? <Separator className="my-3" /> : null}
                    <div className="flex items-start justify-between gap-4 rounded-lg p-2 transition-colors hover:bg-white/[0.025]">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Label htmlFor={item.key} className="font-medium">{item.title}</Label>
                          <Badge variant="outline" className="font-mono text-[10px]">{item.reason}</Badge>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.description}</p>
                      </div>
                      <Switch
                        id={item.key}
                        checked={draft[item.key]}
                        onCheckedChange={checked => setConfig(item.key, checked)}
                        aria-label={`切換 ${item.title} taker fallback`}
                      />
                    </div>
                  </div>
                ))}
                {draft && enabledFallbackCount === 0 ? (
                  <p className="rounded-lg border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2 text-xs leading-5 text-amber-100/80">
                    三種 taker fallback 皆已關閉；緊急退出仍會執行短 TTL maker-only，但剩餘量不會轉市價。
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </section>

          <Card className="border-white/8 bg-card/70 shadow-lg shadow-black/5 backdrop-blur">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2 text-lg"><History className="h-5 w-5 text-violet-300" />設定變更歷史</CardTitle>
              <Badge variant="outline">Append-only</Badge>
            </CardHeader>
            <CardContent>
              {historyQuery.isLoading ? (
                <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
              ) : !historyQuery.data?.length ? (
                <div className="rounded-xl border border-dashed border-border/70 px-5 py-10 text-center">
                  <FileClock className="mx-auto h-7 w-7 text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">尚無自訂變更；目前使用方案 B 預設值。</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {historyQuery.data.map(event => (
                    <article key={event.id} className="grid gap-2 rounded-xl border border-border/60 bg-background/40 p-4 md:grid-cols-[110px_1fr_auto] md:items-center">
                      <div>
                        <Badge variant="outline">{event.eventType}</Badge>
                        <p className="mt-1 text-xs text-muted-foreground">Revision {event.revision}</p>
                      </div>
                      <div className="min-w-0">
                        <p className="break-words text-sm">{configSummary(event.nextConfig)}</p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{event.reason ?? "未提供原因"}</p>
                      </div>
                      <time className="text-xs text-muted-foreground">{formatDate(event.eventAt)}</time>
                    </article>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      <AlertDialog open={confirmAction !== null} onOpenChange={open => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "reset" ? "回復方案 B 安全預設值？" : "套用全域訂單政策？"}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">此變更會由下一次交易 mutation 起套用到所有策略，並寫入不可變更歷史。</span>
              <span className="block font-medium text-foreground">
                一般流程仍永遠 post-only；此操作不會授權新的 taker 原因。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={event => { event.preventDefault(); submitConfirmed(); }}>
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
              確認套用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}

function PolicyNumberField({
  label,
  description,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/35 p-4">
      <div className="flex items-center justify-between gap-3">
        <Label className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-cyan-300" />{label}</Label>
        <Badge variant="secondary" className="text-[10px]">{min}–{max}</Badge>
      </div>
      <Input
        type="number"
        inputMode="numeric"
        value={value}
        min={min}
        max={max}
        step={1}
        onChange={event => {
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
        }}
        className="mt-3 h-11 bg-background/70 font-mono text-base"
      />
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

function ImmutableRule({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-cyan-300/10 bg-cyan-300/[0.025] px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{title}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
      <p className="mt-1 break-all font-mono text-[9px] leading-4 text-cyan-100/45">{detail}</p>
    </div>
  );
}
