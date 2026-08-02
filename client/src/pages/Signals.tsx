import DashboardLayout from "@/components/DashboardLayout";
import { formatTime, SignalStatusBadge } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import {
  parseKamaRainbowMartinSignalPayload,
  type KamaRainbowMartinSignalTrace,
} from "@shared/observability/kamaRainbowMartinSignalTrace";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Loader2,
  ScrollText,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";

const PAGE_SIZE = 25;

export const parseKrmSignalTrace = parseKamaRainbowMartinSignalPayload;

const KRM_ACTION_LABELS: Record<string, string> = {
  OPEN_LONG: "建立多腿",
  OPEN_SHORT: "建立空腿",
  ADD_LONG: "多腿馬丁加倉",
  ADD_SHORT: "空腿馬丁加倉",
  CLOSE: "精確關腿",
};

function KrmAuditField({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={`min-w-0 rounded-md border border-border/70 bg-background/70 px-2.5 py-2 ${wide ? "xl:col-span-2" : ""}`}>
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`${mono ? "font-mono-nums" : ""} break-all text-xs text-foreground`}>{value}</p>
    </div>
  );
}

function KrmSignalAuditPanel({ rawPayload }: { rawPayload: string | null }) {
  const trace = parseKrmSignalTrace(rawPayload);
  if (!trace) return null;
  const missingIdentity = "—（此事件未封印）";
  return (
    <section
      data-testid="krm-signal-audit"
      className="rounded-lg border border-cyan-500/30 bg-cyan-500/[0.06] p-3.5 space-y-3"
      aria-label="Kama 彩虹馬丁訊號稽核"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
          KRM 封印決策
        </Badge>
        <span className="font-semibold text-foreground">
          {trace.action ? (KRM_ACTION_LABELS[trace.action] ?? trace.action) : "未知動作"}
        </span>
        <code className="rounded bg-background/80 px-1.5 py-0.5 text-[11px] text-cyan-700 dark:text-cyan-300 break-all">
          {trace.reasonCode ?? "KRM_REASON_MISSING"}
        </code>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <KrmAuditField
          label="執行模式"
          value="S1 單倉獨佔"
        />
        <KrmAuditField label="馬丁層級" value={trace.layerNum === null ? "—" : `L${trace.layerNum}`} />
        <KrmAuditField label="配置版本" value={trace.configRevision ?? missingIdentity} mono />
        <KrmAuditField label="關腿原因" value={trace.closeReason ?? "—"} mono />
        <KrmAuditField label="Cycle ID" value={trace.cycleId ?? missingIdentity} mono wide />
        <KrmAuditField label="Leg ID" value={trace.legId ?? missingIdentity} mono wide />
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <KrmAuditField label="決策原因" value={trace.reason ?? "—"} wide />
        <KrmAuditField label="Event Key" value={trace.eventKey ?? missingIdentity} mono wide />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        此區只解碼伺服器已封印的 KRM 訊號；未封印欄位不會由目前策略狀態反推，避免歷史稽核失真。
      </p>
    </section>
  );
}

/** 來源 Badge 組件 */
function SourceBadge({ source }: { source?: string | null }) {
  if (!source) return <span className="text-muted-foreground">—</span>;
  const config: Record<string, { label: string; className: string }> = {
    webhook: { label: "Webhook", className: "bg-blue-500/15 text-blue-600 border-blue-500/30" },
    auto: { label: "自動交易", className: "bg-green-500/15 text-green-600 border-green-500/30" },
    manual: { label: "手動觸發", className: "bg-orange-500/15 text-orange-600 border-orange-500/30" },
  };
  const c = config[source] || { label: source, className: "bg-secondary text-secondary-foreground" };
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-medium ${c.className}`}>
      {c.label}
    </Badge>
  );
}

export default function SignalsPage() {
  return (
    <DashboardLayout>
      <SignalsContent />
    </DashboardLayout>
  );
}

function SignalsContent() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [strategyFilter, setStrategyFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: strategies } = trpc.strategies.list.useQuery();

  const queryInput = useMemo(
    () => ({
      status:
        statusFilter === "all"
          ? undefined
          : (statusFilter as "received" | "executed" | "failed" | "rejected" | "skipped"),
      source:
        sourceFilter === "all"
          ? undefined
          : (sourceFilter as "webhook" | "auto" | "manual"),
      strategyId: strategyFilter === "all" ? undefined : parseInt(strategyFilter),
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [statusFilter, sourceFilter, strategyFilter, page],
  );

  const { data, isLoading } = trpc.signals.list.useQuery(queryInput, {
    refetchInterval: 10000,
  });

  const utils = trpc.useUtils();
  // 任務 3.4：發送測試信號（模擬 BUY，不實際下單）
  const testSignalMutation = trpc.signals.sendTestSignal.useMutation({
    onSuccess: (r) => {
      toast.success(r.message);
      utils.signals.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleSendTest = () => {
    const target =
      strategyFilter !== "all"
        ? parseInt(strategyFilter)
        : strategies && strategies.length > 0
          ? strategies[0].id
          : null;
    if (!target) {
      toast.error("請先建立策略才能發送測試信號");
      return;
    }
    testSignalMutation.mutate({ strategyId: target });
  };

  const strategyName = (id: number | null) => {
    if (!id) return "—";
    return strategies?.find((s) => s.id === id)?.name ?? `#${id}`;
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">訊號日誌</h1>
        <p className="text-sm text-muted-foreground mt-1">
          每筆交易訊號的原始內容、解析結果與執行狀態（每 10 秒自動更新）
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label className="text-sm text-muted-foreground">狀態</Label>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="executed">已執行</SelectItem>
              <SelectItem value="failed">失敗</SelectItem>
              <SelectItem value="rejected">已拒絕</SelectItem>
              <SelectItem value="skipped">已跳過</SelectItem>
              <SelectItem value="received">已接收</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-sm text-muted-foreground">來源</Label>
          <Select
            value={sourceFilter}
            onValueChange={(v) => {
              setSourceFilter(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="webhook">Webhook</SelectItem>
              <SelectItem value="auto">自動交易</SelectItem>
              <SelectItem value="manual">手動觸發</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-sm text-muted-foreground">策略</Label>
          <Select
            value={strategyFilter}
            onValueChange={(v) => {
              setStrategyFilter(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部策略</SelectItem>
              {(strategies ?? []).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {data && (
            <span className="text-xs text-muted-foreground">
              共 {data.total} 筆記錄
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={testSignalMutation.isPending}
            title="寫入一筆模擬 BUY 信號（不實際下單），驗證訊號接收鏈路"
            onClick={handleSendTest}
          >
            {testSignalMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <FlaskConical className="h-3.5 w-3.5 mr-1" />
            )}
            發送測試信號
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-5">
          {isLoading ? (
            <div className="py-8 flex justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="py-12 text-center space-y-2">
              <ScrollText className="h-8 w-8 mx-auto text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                尚無訊號記錄。在 TradingView 建立 Alert 並指向策略的 Webhook URL 後，訊號將顯示於此。
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="pb-2 pr-3 font-medium w-8"></th>
                    <th className="pb-2 pr-4 font-medium">時間</th>
                    <th className="pb-2 pr-4 font-medium">策略</th>
                    <th className="pb-2 pr-4 font-medium">來源</th>
                    <th className="pb-2 pr-4 font-medium">動作</th>
                    <th className="pb-2 pr-4 font-medium">交易對</th>
                    <th className="pb-2 pr-4 font-medium text-right">價格</th>
                    <th className="pb-2 pr-4 font-medium text-right">盈虧</th>
                    <th className="pb-2 pr-4 font-medium">狀態</th>
                    <th className="pb-2 font-medium">訊息</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((sig) => (
                    <Fragment key={sig.id}>
                      <tr
                        className="border-b border-border/50 last:border-0 cursor-pointer hover:bg-secondary/30 transition-colors"
                        onClick={() =>
                          setExpandedId(expandedId === sig.id ? null : sig.id)
                        }
                      >
                        <td className="py-2.5 pr-3">
                          <ChevronDown
                            className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                              expandedId === sig.id ? "rotate-180" : ""
                            }`}
                          />
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-muted-foreground whitespace-nowrap">
                          {formatTime(sig.createdAt)}
                        </td>
                        <td className="py-2.5 pr-4">{strategyName(sig.strategyId)}</td>
                        <td className="py-2.5 pr-4">
                          <SourceBadge source={(sig as any).source} />
                        </td>
                        <td className="py-2.5 pr-4">
                          {sig.parsedAction === "buy"
                            ? "買入"
                            : sig.parsedAction === "sell"
                              ? "賣出"
                              : sig.parsedAction === "close"
                                ? "平倉"
                                : "—"}
                        </td>
                        <td className="py-2.5 pr-4 font-mono-nums">
                          {sig.parsedSymbol ?? "—"}
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono-nums">
                          {sig.parsedPrice ?? "—"}
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono-nums">
                          {sig.realizedPnl ? (
                            <span className={parseFloat(sig.realizedPnl) >= 0 ? "text-green-500" : "text-red-500"}>
                              {parseFloat(sig.realizedPnl) >= 0 ? "+" : ""}
                              {parseFloat(sig.realizedPnl).toFixed(2)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-2.5 pr-4">
                          <SignalStatusBadge status={sig.status} />
                        </td>
                        <td className="py-2.5 text-xs text-muted-foreground max-w-80">
                          <div className="whitespace-pre-wrap break-words line-clamp-3">
                            {sig.message ?? "—"}
                          </div>
                        </td>
                      </tr>
                      {expandedId === sig.id && (
                        <tr className="border-b border-border/50">
                          <td colSpan={10} className="py-3 px-4 bg-secondary/20">
                            <div className="space-y-3 text-xs">
                              <KrmSignalAuditPanel rawPayload={sig.rawPayload} />
                              <div>
                                <p className="text-muted-foreground mb-1 font-medium">
                                  原始 Payload
                                </p>
                                <pre className="rounded-md bg-background border p-2.5 overflow-x-auto font-mono-nums whitespace-pre-wrap break-all">
                                  {formatJson(sig.rawPayload)}
                                </pre>
                              </div>
                              {sig.exchangeResponse && (
                                <div>
                                  <p className="text-muted-foreground mb-1 font-medium">
                                    交易所回應
                                  </p>
                                  <pre className="rounded-md bg-background border p-2.5 overflow-x-auto font-mono-nums whitespace-pre-wrap break-all">
                                    {formatJson(sig.exchangeResponse)}
                                  </pre>
                                </div>
                              )}
                              <div className="flex gap-6 text-muted-foreground">
                                {sig.orderId && <span>訂單 ID：{sig.orderId}</span>}
                                {sig.latencyMs !== null && (
                                  <span>處理耗時：{sig.latencyMs}ms</span>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data && data.total > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-muted-foreground">
                第 {page + 1} / {totalPages} 頁
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  上一頁
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一頁
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatJson(raw: string | null): string {
  if (!raw) return "—";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
