import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/_core/hooks/useAuth";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";

interface AutoTradeStatusData {
  strategyId: number;
  strategyName: string;
  status: "running" | "paused" | "stopped";
  symbol: string;
  timeframe: string;
  lastSignalTime?: Date;
  lastTradeTime?: Date;
  totalTrades: number;
  totalProfit: number;
  recentSignals: Array<{
    id: number;
    content: string;
    status: "pending" | "executed" | "failed";
    createdAt: Date;
  }>;
  recentTrades: Array<{
    id: number;
    symbol: string;
    action: "BUY" | "SELL";
    quantity: number;
    price: number;
    status: "open" | "closed";
    profit?: number;
    createdAt: Date;
  }>;
}

export function AutoTradeStatus() {
  const { user } = useAuth();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(30); // 秒
  const [statusData, setStatusData] = useState<AutoTradeStatusData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 自動刷新邏輯
  useEffect(() => {
    if (!autoRefresh) return;

    const fetchStatus = async () => {
      try {
        setLoading(true);
        // 這裡應該調用 tRPC 端點獲取狀態
        // const response = await trpc.autoTrade.getStatus.query();
        // setStatusData(response);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch status");
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, refreshInterval * 1000);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval]);

  if (!user) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p>Please log in to view auto trade status</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* 標題和控制 */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">24/7 自動交易狀態</h1>
          <p className="text-gray-500 mt-2">實時監控所有策略的交易信號和執行情況</p>
        </div>
        <div className="flex gap-4 items-center">
          <div className="flex items-center gap-2">
            <span className="text-sm">刷新間隔：</span>
            <select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(parseInt(e.target.value))}
              className="px-3 py-1 border rounded"
            >
              <option value={10}>10 秒</option>
              <option value={30}>30 秒</option>
              <option value={60}>1 分鐘</option>
              <option value={300}>5 分鐘</option>
            </select>
          </div>
          <Button
            onClick={() => setAutoRefresh(!autoRefresh)}
            variant={autoRefresh ? "default" : "outline"}
          >
            {autoRefresh ? "🟢 自動刷新中" : "⚪ 手動模式"}
          </Button>
        </div>
      </div>

      {/* 錯誤提示 */}
      {error && (
        <Card className="border-red-500 bg-red-50">
          <CardContent className="pt-6">
            <p className="text-red-700">❌ {error}</p>
          </CardContent>
        </Card>
      )}

      {/* 加載中 */}
      {loading && statusData.length === 0 && (
        <Card>
          <CardContent className="flex items-center justify-center h-40">
            <Spinner className="mr-2" />
            <span>加載中...</span>
          </CardContent>
        </Card>
      )}

      {/* 策略狀態卡片 */}
      {statusData.map((strategy) => (
        <Card key={strategy.strategyId} className="overflow-hidden">
          <CardHeader className="bg-gradient-to-r from-blue-50 to-indigo-50">
            <div className="flex justify-between items-start">
              <div>
                <CardTitle className="text-xl">{strategy.strategyName}</CardTitle>
                <CardDescription className="mt-2">
                  交易對: <span className="font-mono font-bold">{strategy.symbol}</span> |
                  時間框架: <span className="font-mono">{strategy.timeframe}</span>
                </CardDescription>
              </div>
              <Badge
                variant={
                  strategy.status === "running"
                    ? "default"
                    : strategy.status === "paused"
                      ? "secondary"
                      : "destructive"
                }
              >
                {strategy.status === "running"
                  ? "🟢 運行中"
                  : strategy.status === "paused"
                    ? "🟡 暫停"
                    : "🔴 停止"}
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="pt-6 space-y-6">
            {/* 統計信息 */}
            <div className="grid grid-cols-4 gap-4">
              <div className="border rounded p-4">
                <p className="text-sm text-gray-600">總交易數</p>
                <p className="text-2xl font-bold">{strategy.totalTrades}</p>
              </div>
              <div className="border rounded p-4">
                <p className="text-sm text-gray-600">總盈利</p>
                <p className={`text-2xl font-bold ${strategy.totalProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
                  ${strategy.totalProfit.toFixed(2)}
                </p>
              </div>
              <div className="border rounded p-4">
                <p className="text-sm text-gray-600">最後信號</p>
                <p className="text-sm font-mono">
                  {strategy.lastSignalTime
                    ? format(new Date(strategy.lastSignalTime), "HH:mm:ss", { locale: zhCN })
                    : "無"}
                </p>
              </div>
              <div className="border rounded p-4">
                <p className="text-sm text-gray-600">最後交易</p>
                <p className="text-sm font-mono">
                  {strategy.lastTradeTime
                    ? format(new Date(strategy.lastTradeTime), "HH:mm:ss", { locale: zhCN })
                    : "無"}
                </p>
              </div>
            </div>

            {/* 最近信號 */}
            <div>
              <h3 className="font-bold mb-3">最近信號</h3>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {strategy.recentSignals.length === 0 ? (
                  <p className="text-gray-500 text-sm">暫無信號</p>
                ) : (
                  strategy.recentSignals.slice(0, 5).map((signal) => (
                    <div
                      key={signal.id}
                      className="flex justify-between items-center p-2 bg-gray-50 rounded text-sm"
                    >
                      <div className="flex-1">
                        <p className="font-mono">{signal.content}</p>
                        <p className="text-xs text-gray-500">
                          {format(new Date(signal.createdAt), "HH:mm:ss", { locale: zhCN })}
                        </p>
                      </div>
                      <Badge
                        variant={
                          signal.status === "executed"
                            ? "default"
                            : signal.status === "failed"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {signal.status === "executed"
                          ? "✅ 已執行"
                          : signal.status === "failed"
                            ? "❌ 失敗"
                            : "⏳ 待執行"}
                      </Badge>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 最近交易 */}
            <div>
              <h3 className="font-bold mb-3">最近交易</h3>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {strategy.recentTrades.length === 0 ? (
                  <p className="text-gray-500 text-sm">暫無交易</p>
                ) : (
                  strategy.recentTrades.slice(0, 5).map((trade) => (
                    <div
                      key={trade.id}
                      className="flex justify-between items-center p-2 bg-gray-50 rounded text-sm"
                    >
                      <div className="flex-1">
                        <p>
                          <span
                            className={`font-bold ${trade.action === "BUY" ? "text-green-600" : "text-red-600"}`}
                          >
                            {trade.action === "BUY" ? "🟢 買入" : "🔴 賣出"}
                          </span>
                          {" "}
                          {trade.quantity.toFixed(4)} @ ${trade.price.toFixed(2)}
                        </p>
                        <p className="text-xs text-gray-500">
                          {format(new Date(trade.createdAt), "HH:mm:ss", { locale: zhCN })}
                        </p>
                      </div>
                      <div className="text-right">
                        <Badge variant={trade.status === "closed" ? "default" : "secondary"}>
                          {trade.status === "closed" ? "已平倉" : "持倉中"}
                        </Badge>
                        {trade.profit !== undefined && (
                          <p
                            className={`text-xs font-bold mt-1 ${trade.profit >= 0 ? "text-green-600" : "text-red-600"}`}
                          >
                            {trade.profit >= 0 ? "+" : ""}${trade.profit.toFixed(2)}
                          </p>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      {/* 空狀態 */}
      {!loading && statusData.length === 0 && !error && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center h-40">
            <p className="text-gray-500 mb-4">暫無運行中的策略</p>
            <Button>創建新策略</Button>
          </CardContent>
        </Card>
      )}

      {/* 系統狀態 */}
      <Card className="bg-blue-50 border-blue-200">
        <CardHeader>
          <CardTitle className="text-sm">系統信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <span className="font-bold">Heartbeat 狀態：</span>
            <span className="text-green-600">🟢 正常運行</span>
          </p>
          <p>
            <span className="font-bold">最後更新：</span>
            <span className="font-mono">{format(new Date(), "yyyy-MM-dd HH:mm:ss", { locale: zhCN })}</span>
          </p>
          <p>
            <span className="font-bold">刷新頻率：</span>
            <span>每 {refreshInterval} 秒</span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
