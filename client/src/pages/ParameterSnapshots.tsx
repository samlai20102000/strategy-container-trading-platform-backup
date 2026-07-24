/**
 * 參數快照庫頁面（V4.1）
 * 功能：列表展示、按策略/績效排序、套用到策略、刪除、收藏
 */

import { useState, useMemo } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Star, Trash2, Play, Eye, Database, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export default function ParameterSnapshots() {
  const [sortBy, setSortBy] = useState<"totalReturn" | "winRate" | "sharpeRatio" | "createdAt">("createdAt");
  const [filterStrategy, setFilterStrategy] = useState<string>("all");
  const [viewConfig, setViewConfig] = useState<Record<string, unknown> | null>(null);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
  const [targetStrategyId, setTargetStrategyId] = useState<string>("");
  // V4.3: 導入為新策略
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importForm, setImportForm] = useState({
    name: "",
    apiKeyId: "",
    symbol: "BTCUSDT",
    positionSize: "30",
    positionMode: "usdt" as "usdt" | "quantity",
    leverage: "1",
    direction: "both" as "long" | "short" | "both",
  });

  // 查詢 - V4.2: 使用 registry 統一數據源
  const snapshotsQuery = trpc.backtest.getSnapshots.useQuery({
    sortBy,
    strategyKey: filterStrategy === "all" ? undefined : filterStrategy,
    limit: 100,
  });
  const registryQuery = trpc.registry.listDefinitions.useQuery(undefined);
  const strategiesQuery = {
    data: registryQuery.data?.map(s => ({ key: s.key, name: s.name })) ?? [],
    isLoading: registryQuery.isLoading,
  };
  const instancesQuery = trpc.registry.listInstances.useQuery();
  const userStrategiesQuery = {
    data: instancesQuery.data?.map(i => ({ id: i.id, name: i.name, exchange: i.exchange, symbol: i.symbol, strategyKey: i.strategyKey })) ?? [],
    isLoading: instancesQuery.isLoading,
  };

  // 突變
  const deleteMutation = trpc.backtest.deleteSnapshot.useMutation();
  const toggleFavMutation = trpc.backtest.toggleSnapshotFavorite.useMutation();
  const applyMutation = trpc.backtest.applySnapshot.useMutation();
  const importMutation = trpc.backtest.importSnapshotAsNew.useMutation();
  // API Keys 查詢（導入對話框需要）
  const apiKeysQuery = trpc.apiKeys.list.useQuery();

  const snapshots = snapshotsQuery.data ?? [];

  // 排序：收藏在前
  const sortedSnapshots = useMemo(() => {
    return [...snapshots].sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return 0;
    });
  }, [snapshots]);

  const handleDelete = async (id: number) => {
    if (!confirm("確定刪除此快照？")) return;
    try {
      await deleteMutation.mutateAsync({ snapshotId: id });
      toast.success("快照已刪除");
      snapshotsQuery.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "刪除失敗");
    }
  };

  const handleToggleFav = async (id: number) => {
    try {
      const res = await toggleFavMutation.mutateAsync({ snapshotId: id });
      toast.success(res.isFavorite ? "已加入收藏" : "已取消收藏");
      snapshotsQuery.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失敗");
    }
  };

  const handleImport = async () => {
    if (!selectedSnapshotId) return;
    if (!importForm.name.trim()) return toast.error("請輸入策略名稱");
    if (!importForm.apiKeyId) return toast.error("請選擇 API 金鑰");
    if (!importForm.symbol.trim()) return toast.error("請輸入交易對");
    const posSize = parseFloat(importForm.positionSize);
    if (!posSize || posSize <= 0) return toast.error("倉位大小需為正數");
    try {
      const res = await importMutation.mutateAsync({
        snapshotId: selectedSnapshotId,
        name: importForm.name,
        apiKeyId: parseInt(importForm.apiKeyId),
        symbol: importForm.symbol,
        positionSize: posSize,
        positionMode: importForm.positionMode,
        leverage: parseInt(importForm.leverage) || 1,
        direction: importForm.direction,
      });
      toast.success(res.message);
      setImportDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "導入失敗");
    }
  };

  const handleApply = async () => {
    if (!selectedSnapshotId || !targetStrategyId) {
      toast.error("請選擇目標策略");
      return;
    }
    try {
      await applyMutation.mutateAsync({
        snapshotId: selectedSnapshotId,
        targetStrategyId: Number(targetStrategyId),
      });
      toast.success("✅ 參數已成功套用到策略實例");
      // V5.3 P0-4：套用後強制刷新
      await snapshotsQuery.refetch();
      await instancesQuery.refetch();
      setApplyDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "套用失敗");
    }
  };

  const fmtNum = (n: number | null | undefined, decimals = 2) =>
    n != null ? n.toFixed(decimals) : "—";

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        {/* 標題 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Database className="w-6 h-6 text-amber-400" />
            <h1 className="text-2xl font-bold">參數快照庫</h1>
          </div>
          <Badge variant="outline" className="text-muted-foreground">
            共 {snapshots.length} 個快照
          </Badge>
        </div>

        {/* 篩選排序 */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-4 items-center">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">策略：</span>
                <Select value={filterStrategy} onValueChange={setFilterStrategy}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="全部策略" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部策略</SelectItem>
                    {strategiesQuery.data?.map((s) => (
                      <SelectItem key={s.key} value={s.key}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">排序：</span>
                <Select value={sortBy} onValueChange={(v) => setSortBy(v as any)}>
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="createdAt">建立時間</SelectItem>
                    <SelectItem value="totalReturn">總回報率</SelectItem>
                    <SelectItem value="winRate">勝率</SelectItem>
                    <SelectItem value="sharpeRatio">夏普比率</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 快照列表 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">快照列表</CardTitle>
          </CardHeader>
          <CardContent>
            {snapshotsQuery.isLoading ? (
              <p className="text-muted-foreground text-center py-8">載入中...</p>
            ) : sortedSnapshots.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                尚無快照。在回測報告中點擊「儲存快照」即可建立。
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8"></TableHead>
                      <TableHead>快照名稱</TableHead>
                      <TableHead>策略</TableHead>
                      <TableHead className="text-right">回報率</TableHead>
                      <TableHead className="text-right">勝率</TableHead>
                      <TableHead className="text-right">夏普</TableHead>
                      <TableHead className="text-right">盈虧比</TableHead>
                      <TableHead className="text-right">最大回撤</TableHead>
                      <TableHead>建立時間</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedSnapshots.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>
                          <button
                            onClick={() => handleToggleFav(s.id)}
                            className="hover:scale-110 transition-transform"
                          >
                            <Star
                              className={`w-4 h-4 ${s.isFavorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`}
                            />
                          </button>
                        </TableCell>
                        <TableCell className="font-medium text-sm">
                          {s.snapshotName || "未命名"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {s.strategyName || s.strategyKey}
                          </Badge>
                        </TableCell>
                        <TableCell className={`text-right font-mono ${(s.totalReturn ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {fmtNum(s.totalReturn)}%
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {fmtNum(s.winRate)}%
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {fmtNum(s.sharpeRatio, 3)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {fmtNum(s.profitFactor)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-red-400">
                          {fmtNum(s.maxDrawdown)}%
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {s.createdAt ? new Date(s.createdAt).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex gap-1 justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setViewConfig(s.config)}
                              title="查看參數"
                            >
                              <Eye className="w-4 h-4" />
                            </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-emerald-400 hover:text-emerald-300"
                      onClick={() => {
                        setSelectedSnapshotId(s.id);
                        setApplyDialogOpen(true);
                      }}
                      title="將此快照參數覆蓋至選定的現有策略實例"
                    >
                      <Play className="w-4 h-4" />
                      <span className="ml-1 text-xs hidden lg:inline">更新策略參數</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-blue-400 hover:text-blue-300"
                      onClick={() => {
                        setSelectedSnapshotId(s.id);
                        const bs = s.backtestSettings as any | null;
                        const cfg = s.config as Record<string, any> || {};
                        setImportForm(prev => ({
                          ...prev,
                          name: `${s.snapshotName || '快照'}_副本`,
                          symbol: (bs?.symbol || cfg.symbol || cfg.Symbol || prev.symbol).replace(/-/g, '').toUpperCase(),
                          positionSize: String(bs?.baseLotSize || bs?.tradeAmount || cfg.Base_Lot_Size || prev.positionSize),
                          leverage: String(cfg.leverage || prev.leverage),
                        }));
                        setImportDialogOpen(true);
                      }}
                      title="以此快照參數建立一個全新的策略實例"
                    >
                      <Plus className="w-4 h-4" />
                      <span className="ml-1 text-xs hidden lg:inline">複製為副本</span>
                    </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-400 hover:text-red-300"
                              onClick={() => handleDelete(s.id)}
                              title="刪除"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 查看參數 Dialog */}
        <Dialog open={!!viewConfig} onOpenChange={() => setViewConfig(null)}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>參數詳情</DialogTitle>
            </DialogHeader>
            <pre className="bg-muted p-4 rounded text-xs font-mono overflow-x-auto whitespace-pre-wrap">
              {viewConfig ? JSON.stringify(viewConfig, null, 2) : ""}
            </pre>
          </DialogContent>
        </Dialog>

        {/* 套用快照 Dialog */}
        <Dialog open={applyDialogOpen} onOpenChange={setApplyDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>更新策略參數</DialogTitle>
              <DialogDescription>
                將快照參數套用至現有策略實例，系統會自動驗證策略類型是否匹配。
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Select value={targetStrategyId} onValueChange={setTargetStrategyId}>
                <SelectTrigger>
                  <SelectValue placeholder="選擇目標策略實例" />
                </SelectTrigger>
                <SelectContent>
                  {(userStrategiesQuery.data ?? []).map((s: any) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name} ({s.exchange} {s.symbol})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setApplyDialogOpen(false)}>
                取消
              </Button>
              <Button
                className="bg-emerald-600 hover:bg-emerald-700"
                onClick={handleApply}
                disabled={!targetStrategyId || applyMutation.isPending}
              >
                {applyMutation.isPending ? "套用中..." : "確認套用"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* V4.3: 導入為新策略 Dialog */}
        <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>複製為副本</DialogTitle>
              <DialogDescription>
                以此快照參數建立一個全新的策略實例，請填寫基本信息。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>策略名稱</Label>
                <Input
                  value={importForm.name}
                  onChange={(e) => setImportForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="例如：BTC 馬丁 V4"
                />
              </div>
              <div className="space-y-2">
                <Label>API 金鑰</Label>
                <Select value={importForm.apiKeyId} onValueChange={(v) => setImportForm(prev => ({ ...prev, apiKeyId: v }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="選擇 API 金鑰" />
                  </SelectTrigger>
                  <SelectContent>
                    {(apiKeysQuery.data ?? []).map((k: any) => (
                      <SelectItem key={k.id} value={String(k.id)}>
                        {k.label || k.name} ({k.exchange})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>交易對</Label>
                  <Input
                    value={importForm.symbol}
                    onChange={(e) => setImportForm(prev => ({ ...prev, symbol: e.target.value }))}
                    placeholder="BTCUSDT"
                  />
                </div>
                <div className="space-y-2">
                  <Label>倉位大小 ({importForm.positionMode === 'usdt' ? 'USDT' : '數量'})</Label>
                  <Input
                    type="number"
                    value={importForm.positionSize}
                    onChange={(e) => setImportForm(prev => ({ ...prev, positionSize: e.target.value }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-2">
                  <Label>倉位模式</Label>
                  <Select value={importForm.positionMode} onValueChange={(v) => setImportForm(prev => ({ ...prev, positionMode: v as any }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="usdt">USDT 金額</SelectItem>
                      <SelectItem value="quantity">數量</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>槓桿</Label>
                  <Input
                    type="number"
                    min="1"
                    max="125"
                    value={importForm.leverage}
                    onChange={(e) => setImportForm(prev => ({ ...prev, leverage: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>方向</Label>
                  <Select value={importForm.direction} onValueChange={(v) => setImportForm(prev => ({ ...prev, direction: v as any }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="both">雙向</SelectItem>
                      <SelectItem value="long">只做多</SelectItem>
                      <SelectItem value="short">只做空</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setImportDialogOpen(false)}>
                取消
              </Button>
              <Button
                className="bg-blue-600 hover:bg-blue-700"
                onClick={handleImport}
                disabled={importMutation.isPending}
              >
                {importMutation.isPending ? "導入中..." : "確認導入"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
