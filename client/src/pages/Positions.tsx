import DashboardLayout from "@/components/DashboardLayout";
import {
  ExchangeBadge,
  formatTime,
  PnlValue,
  SideBadge,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Activity, Loader2, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

export default function PositionsPage() {
  return (
    <DashboardLayout>
      <PositionsContent />
    </DashboardLayout>
  );
}

function PositionsContent() {
  const utils = trpc.useUtils();
  const { data, isLoading, isFetching, refetch } =
    trpc.dashboard.overview.useQuery(undefined, { refetchInterval: 10000 });
  const { data: strategies } = trpc.strategies.list.useQuery();
  const positionSnapshotInput = useMemo(
    () => ({ strategyIds: strategies?.map((strategy) => strategy.id) ?? [] }),
    [strategies],
  );
  const {
    data: positionSnapshots,
    isFetching: positionSnapshotsFetching,
  } = trpc.exchange.getStrategyPositionSnapshots.useQuery(positionSnapshotInput, {
    enabled: positionSnapshotInput.strategyIds.length > 0,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  const refreshPositionSnapshotsMutation = trpc.exchange.refreshStrategyPositionSnapshots.useMutation({
    onSuccess: (refreshedSnapshots) => {
      utils.exchange.getStrategyPositionSnapshots.setData(positionSnapshotInput, refreshedSnapshots);
      toast.success("已重新同步交易所持倉");
    },
    onError: (refreshError) => toast.error(`交易所持倉同步失敗：${refreshError.message}`),
  });
  const { data: recentTrades } = trpc.performance.trades.useQuery(
    { limit: 50 },
    { refetchInterval: 15000 },
  );

  const closeMutation = trpc.strategies.closePosition.useMutation({
    onSuccess: (r) => {
      if (r.success) {
        toast.success(r.message, { duration: 5000 });
      } else {
        toast.error(
          r.exchangeError
            ? `平倉失敗：${r.exchangeError}`
            : r.message,
          { duration: 10000 }
        );
      }
      utils.dashboard.overview.invalidate();
      utils.strategies.list.invalidate();
      utils.exchange.getStrategyPositionSnapshots.invalidate();
    },
    onError: (e) => toast.error(`平倉請求異常：${e.message}`, { duration: 10000 }),
  });

  const allPositions =
    data?.accounts.flatMap((a) =>
      a.positions.map((p) => ({
        ...p,
        account: a.label,
        exchange: a.exchange,
        apiKeyId: a.apiKeyId,
      })),
    ) ?? [];

  const attributedPositions = useMemo(() => {
    const normalizeSymbol = (symbol: string) => symbol.replace(/-SWAP$/i, "").replace(/-/g, "").toUpperCase();
    const strategyById = new Map((strategies ?? []).map((strategy) => [strategy.id, strategy] as const));
    return allPositions.map((position) => {
      const relatedSnapshots = (positionSnapshots ?? []).filter(
        (snapshot) => snapshot.apiKeyId === position.apiKeyId
          && normalizeSymbol(snapshot.symbol) === normalizeSymbol(position.symbol)
          && snapshot.side === position.side
          && snapshot.status === "available",
      );
      const exactSnapshots = relatedSnapshots.filter((snapshot) => snapshot.attribution === "exact");
      const exactSnapshot = exactSnapshots.length === 1 ? exactSnapshots[0] : undefined;
      const singletonSnapshots = relatedSnapshots.filter((snapshot) => snapshot.attribution === "singleton_exchange");
      const singletonSnapshot = singletonSnapshots.length === 1 ? singletonSnapshots[0] : undefined;
      const strategy = exactSnapshot ? strategyById.get(exactSnapshot.strategyId) : undefined;
      return {
        ...position,
        strategy,
        attribution: strategy ? "exact" : singletonSnapshot ? "singleton_exchange" : relatedSnapshots.length > 0 ? "account_aggregate" : "unassigned",
        relatedStrategyNames: relatedSnapshots
          .map((snapshot) => strategyById.get(snapshot.strategyId)?.name)
          .filter((name): name is string => Boolean(name)),
      };
    });
  }, [allPositions, positionSnapshots, strategies]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">持倉監控</h1>
          <p className="text-sm text-muted-foreground mt-1">
            交易所帳戶持倉真值與成交記錄（每 10 秒自動更新；毛浮盈虧未含逐策略費用與資金費）
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching || positionSnapshotsFetching || refreshPositionSnapshotsMutation.isPending}
          onClick={() => {
            void refreshPositionSnapshotsMutation.mutateAsync(positionSnapshotInput)
              .then(() => refetch())
              .catch(() => undefined);
          }}
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isFetching || positionSnapshotsFetching || refreshPositionSnapshotsMutation.isPending ? "animate-spin" : ""}`} />
          重新整理
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">當前持倉</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 flex justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : attributedPositions.length === 0 ? (
            <div className="py-12 text-center space-y-2">
              <Activity className="h-8 w-8 mx-auto text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">目前無持倉</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="pb-2 pr-4 font-medium">帳戶</th>
                    <th className="pb-2 pr-4 font-medium">交易對</th>
                    <th className="pb-2 pr-4 font-medium">方向</th>
                    <th className="pb-2 pr-4 font-medium text-right">數量</th>
                    <th className="pb-2 pr-4 font-medium text-right">入場價</th>
                    <th className="pb-2 pr-4 font-medium text-right">標記價</th>
                    <th className="pb-2 pr-4 font-medium text-right">槓桿</th>
                    <th className="pb-2 pr-4 font-medium text-right">未實現盈虧</th>
                    <th className="pb-2 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {attributedPositions.map((p, i) => {
                    const strategyId = p.strategy?.id;
                    const pnlPct = typeof p.unrealizedPnlRatioPct === "number"
                      ? p.unrealizedPnlRatioPct
                      : typeof p.positionMargin === "number" && p.positionMargin > 0
                        ? (p.unrealizedPnl / p.positionMargin) * 100
                        : null;
                    return (
                      <tr key={i} className="border-b border-border/50 last:border-0">
                        <td className="py-2.5 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="text-xs">{p.account}</span>
                            <ExchangeBadge exchange={p.exchange} />
                          </div>
                        </td>
                        <td className="py-2.5 pr-4">
                          <p className="font-medium">{p.symbol}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px] text-muted-foreground">
                            <span>{p.updatedAt ? `同步 ${new Date(p.updatedAt).toLocaleTimeString("zh-TW", { hour12: false })}` : "同步時間未提供"}</span>
                            {p.attribution === "exact" ? (
                              <Badge variant="outline" className="h-4 border-emerald-500/40 px-1 text-[8px] text-emerald-400">{p.strategy?.name ?? "精確歸屬"}</Badge>
                            ) : p.attribution === "singleton_exchange" ? (
                              <Badge variant="outline" className="h-4 border-sky-500/40 px-1 text-[8px] text-sky-300">唯一交易所持倉</Badge>
                            ) : p.attribution === "account_aggregate" ? (
                              <Badge variant="outline" className="h-4 border-amber-500/40 px-1 text-[8px] text-amber-300">帳戶合併倉位</Badge>
                            ) : (
                              <Badge variant="outline" className="h-4 border-slate-500/40 px-1 text-[8px] text-slate-400">未歸屬</Badge>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 pr-4"><SideBadge side={p.side} /></td>
                        <td className="py-2.5 pr-4 text-right font-mono-nums">{p.size}</td>
                        <td className="py-2.5 pr-4 text-right font-mono-nums">{p.entryPrice}</td>
                        <td className="py-2.5 pr-4 text-right font-mono-nums">{p.markPrice}</td>
                        <td className="py-2.5 pr-4 text-right font-mono-nums">{p.leverage}x</td>
                        <td className="py-2.5 pr-4 text-right">
                          <PnlValue value={p.unrealizedPnl} suffix="" />
                          <p className="mt-0.5 font-mono-nums text-[10px] text-muted-foreground">
                            {pnlPct !== null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "盈虧率未提供"}
                          </p>
                        </td>
                        <td className="py-2.5 text-right">
                          {strategyId ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={closeMutation.isPending}
                              onClick={() => {
                                if (confirm(`確定對 ${p.symbol} 執行市價平倉？`)) {
                                  closeMutation.mutate({ id: strategyId });
                                }
                              }}
                            >
                              平倉
                            </Button>
                          ) : (
                            <span
                              className="text-[10px] text-muted-foreground"
                              title={p.attribution === "account_aggregate" ? `相關策略：${p.relatedStrategyNames.join("、") || "無法唯一判定"}` : p.attribution === "singleton_exchange" ? "原生交易所倉位可讀，但本地策略狀態尚未達精確歸屬門檻" : "無法安全歸屬此交易所持倉"}
                            >
                              {p.attribution === "account_aggregate" ? "合併倉位不可單策略平倉" : p.attribution === "singleton_exchange" ? "待對帳，不開放單策略平倉" : "—"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">近期交易記錄</CardTitle>
        </CardHeader>
        <CardContent>
          {!recentTrades || recentTrades.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              尚無交易記錄
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="pb-2 pr-4 font-medium">時間</th>
                    <th className="pb-2 pr-4 font-medium">交易對</th>
                    <th className="pb-2 pr-4 font-medium">方向</th>
                    <th className="pb-2 pr-4 font-medium">類型</th>
                    <th className="pb-2 pr-4 font-medium text-right">數量</th>
                    <th className="pb-2 pr-4 font-medium text-right">價格</th>
                    <th className="pb-2 pr-4 font-medium">觸發來源</th>
                    <th className="pb-2 pr-4 font-medium">成交真值</th>
                    <th className="pb-2 font-medium">狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTrades.map((t) => (
                    <tr key={t.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2.5 pr-4 text-xs text-muted-foreground whitespace-nowrap">
                        {formatTime(t.createdAt)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-1.5">
                          <ExchangeBadge exchange={t.exchange} />
                          <span className="font-medium">{t.symbol}</span>
                        </div>
                      </td>
                      <td className="py-2.5 pr-4"><SideBadge side={t.side} /></td>
                      <td className="py-2.5 pr-4 text-xs">
                        {t.orderType === "market" ? "市價" : "限價"}
                        {t.reduceOnly && (
                          <span className="text-muted-foreground">（平倉）</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono-nums">{t.size}</td>
                      <td className="py-2.5 pr-4 text-right font-mono-nums">
                        {t.price ?? "市價"}
                      </td>
                      <td className="py-2.5 pr-4 text-xs">
                        {triggerLabel(t.triggerSource)}
                      </td>
                      <td className="py-2.5 pr-4 text-xs">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${t.priceSource === "exchange_fill" && t.sizeSource === "exchange_fill" ? "border-emerald-500/40 text-emerald-400" : "border-amber-500/40 text-amber-300"}`}
                        >
                          {fillTruthLabel(t.priceSource, t.sizeSource)}
                        </Badge>
                      </td>
                      <td className="py-2.5">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${
                            t.status === "filled"
                              ? "border-emerald-500/40 text-emerald-400"
                              : t.status === "failed"
                                ? "border-rose-500/40 text-rose-400"
                                : "border-zinc-500/40 text-zinc-400"
                          }`}
                        >
                          {t.status === "filled"
                            ? "已成交"
                            : t.status === "failed"
                              ? "失敗"
                              : t.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function fillTruthLabel(priceSource: string | null, sizeSource: string | null): string {
  if (priceSource === "exchange_fill" && sizeSource === "exchange_fill") return "交易所實際成交";
  if (priceSource === "order_request_fallback" || sizeSource === "order_request_fallback") return "下單請求回退";
  return "歷史來源未知";
}

function triggerLabel(source: string | null): string {
  switch (source) {
    case "webhook":
      return "Webhook 訊號";
    case "manual":
      return "手動";
    case "risk_stop_loss":
      return "止損觸發";
    case "risk_take_profit":
      return "止盈觸發";
    case "risk_daily_loss":
    case "risk_daily_loss_limit":
      return "日虧上限";
    default:
      return source ?? "—";
  }
}
