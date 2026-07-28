import DashboardLayout from "@/components/DashboardLayout";
import {
  finiteNumber,
  formatTime,
  PNL_SOURCE_LABELS,
  SignalPnl,
  SignalStatusBadge,
  SourceBadge,
} from "@/components/shared";
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

  const strategyName = (signal: any) => {
    if (signal.strategyName) return signal.strategyName;
    if (!signal.strategyId) return "未綁定策略";
    return strategies?.find((s) => s.id === signal.strategyId)?.name
      ?? "已刪除策略（名稱未保存）";
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
                        <td className="py-2.5 pr-4">
                          <div className="max-w-56 truncate" title={strategyName(sig)}>{strategyName(sig)}</div>
                          {sig.strategyKey && (
                            <div className="max-w-56 truncate font-mono text-[9px] text-muted-foreground" title={sig.strategyKey}>
                              {sig.strategyKey}
                            </div>
                          )}
                        </td>
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
                          <div title={sig.filledPrice != null ? `實際成交價：${sig.filledPrice}` : "尚無實際成交價，顯示訊號價格"}>
                            {sig.filledPrice ?? sig.parsedPrice ?? "—"}
                            {sig.filledPrice != null && sig.parsedPrice != null && String(sig.filledPrice) !== String(sig.parsedPrice) && (
                              <div className="text-[9px] text-muted-foreground">訊號 {sig.parsedPrice}</div>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono-nums whitespace-nowrap">
                          <SignalPnl signal={sig} />
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
                              {(sig.hasClosingTrade || sig.parsedAction === "close") && (
                                <div>
                                  <p className="text-muted-foreground mb-1 font-medium">平倉盈虧稽核</p>
                                  <div className="grid gap-2 rounded-md border bg-background p-2.5 sm:grid-cols-4">
                                    <div>
                                      <span className="text-muted-foreground">毛盈虧</span>
                                      <p className="font-mono-nums text-foreground">{finiteNumber(sig.realizedPnl)?.toFixed(8) ?? "待同步"} U</p>
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">本次費用</span>
                                      <p className="font-mono-nums text-foreground">{finiteNumber(sig.fee)?.toFixed(8) ?? "待同步"} U</p>
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">淨盈虧</span>
                                      <p className="font-mono-nums text-foreground">{(finiteNumber(sig.netRealizedPnl) ?? finiteNumber(sig.realizedPnl))?.toFixed(8) ?? "待同步"} U</p>
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">資料來源</span>
                                      <p className="text-foreground">{PNL_SOURCE_LABELS[sig.pnlSource] ?? "待同步"}</p>
                                    </div>
                                  </div>
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
