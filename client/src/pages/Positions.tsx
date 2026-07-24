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

  /** 找到對應此持倉的策略（依交易對 + 金鑰） */
  const findStrategy = (symbol: string, apiKeyId: number) =>
    strategies?.find((s) => s.symbol === symbol && s.apiKeyId === apiKeyId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">持倉監控</h1>
          <p className="text-sm text-muted-foreground mt-1">
            即時持倉與交易記錄（每 10 秒自動更新）
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching}
          onClick={() => refetch()}
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isFetching ? "animate-spin" : ""}`} />
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
          ) : allPositions.length === 0 ? (
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
                  {allPositions.map((p, i) => {
                    const strategy = findStrategy(p.symbol, p.apiKeyId);
                    return (
                      <tr key={i} className="border-b border-border/50 last:border-0">
                        <td className="py-2.5 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="text-xs">{p.account}</span>
                            <ExchangeBadge exchange={p.exchange} />
                          </div>
                        </td>
                        <td className="py-2.5 pr-4 font-medium">{p.symbol}</td>
                        <td className="py-2.5 pr-4"><SideBadge side={p.side} /></td>
                        <td className="py-2.5 pr-4 text-right font-mono-nums">{p.size}</td>
                        <td className="py-2.5 pr-4 text-right font-mono-nums">{p.entryPrice}</td>
                        <td className="py-2.5 pr-4 text-right font-mono-nums">{p.markPrice}</td>
                        <td className="py-2.5 pr-4 text-right font-mono-nums">{p.leverage}x</td>
                        <td className="py-2.5 pr-4 text-right">
                          <PnlValue value={p.unrealizedPnl} suffix="" />
                        </td>
                        <td className="py-2.5 text-right">
                          {strategy ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={closeMutation.isPending}
                              onClick={() => {
                                if (confirm(`確定對 ${p.symbol} 執行市價平倉？`)) {
                                  closeMutation.mutate({ id: strategy.id });
                                }
                              }}
                            >
                              平倉
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
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
