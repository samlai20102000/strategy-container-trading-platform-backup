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
import { AlertTriangle, Star, Trash2, Play, Eye, Database, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Rainbow20415ConfigPanel } from "@/components/Rainbow20415ConfigPanel";
import { RainbowTrendLadderConfigPanel } from "@/components/RainbowTrendLadderConfigPanel";
import { V41EntryConditionsPanel } from "@/components/V41EntryConditionsPanel";
import {
  RAINBOW_20415_STRATEGY_KEY,
  normalizeRainbow20415Config,
} from "@shared/strategies/rainbow20415";
import {
  RAINBOW_TREND_LADDER_STRATEGY_KEY,
  normalizeRainbowTrendLadderConfig,
} from "@shared/strategies/rainbowTrendLadder";
import {
  V41_CONFIG_KEY,
  V41_STRATEGY_KEY,
  countEnabledV41EntryConditions,
  normalizeV41Config,
  summarizeV41EntryConfig,
  validateV41Config,
} from "@shared/strategies/kama3kMartinV41";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getV41SnapshotDisplay(strategyKey: string | null | undefined, rawSnapshotConfig: unknown) {
  if (strategyKey !== V41_STRATEGY_KEY) return null;
  const canonicalCandidate = isRecord(rawSnapshotConfig) && isRecord(rawSnapshotConfig[V41_CONFIG_KEY])
    ? rawSnapshotConfig[V41_CONFIG_KEY]
    : rawSnapshotConfig;
  const validation = validateV41Config(canonicalCandidate);
  const config = validation.config ?? normalizeV41Config(canonicalCandidate);
  return { canonicalCandidate, config, validation };
}

export default function ParameterSnapshots() {
  const [sortBy, setSortBy] = useState<"totalReturn" | "winRate" | "sharpeRatio" | "createdAt">("createdAt");
  const [filterStrategy, setFilterStrategy] = useState<string>("all");
  const [viewConfig, setViewConfig] = useState<Record<string, unknown> | null>(null);
  const [viewStrategyKey, setViewStrategyKey] = useState<string | null>(null);
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
  const [importSnapshotPosition, setImportSnapshotPosition] = useState<{
    value: string;
    mode: "usdt" | "quantity";
  } | null>(null);

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
  const selectedSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null,
    [selectedSnapshotId, snapshots],
  );
  const selectedV41Display = useMemo(
    () => getV41SnapshotDisplay(selectedSnapshot?.strategyKey, selectedSnapshot?.config),
    [selectedSnapshot],
  );
  const viewV41Display = useMemo(
    () => getV41SnapshotDisplay(viewStrategyKey, viewConfig),
    [viewConfig, viewStrategyKey],
  );

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
                          {s.strategyKey === V41_STRATEGY_KEY && (() => {
                            const display = getV41SnapshotDisplay(s.strategyKey, s.config);
                            if (!display) return null;
                            return (
                              <div className="mt-2 min-w-56 space-y-1.5">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-300">
                                    入場邏輯：{display.config.entryConditionLogic.toUpperCase()}
                                  </Badge>
                                  <Badge variant="outline" className="text-[10px]">
                                    {countEnabledV41EntryConditions(display.config)}/3 條件
                                  </Badge>
                                  {!display.validation.valid && (
                                    <Badge variant="outline" className="border-amber-500/45 text-[10px] text-amber-300">
                                      需複核
                                    </Badge>
                                  )}
                                </div>
                                <p className="max-w-sm break-words text-[10px] leading-relaxed text-muted-foreground">
                                  {summarizeV41EntryConfig(display.config)}
                                </p>
                              </div>
                            );
                          })()}
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
                              onClick={() => {
                                setViewConfig(s.config);
                                setViewStrategyKey(s.strategyKey);
                              }}
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
                        const rainbowConfig = s.strategyKey === RAINBOW_20415_STRATEGY_KEY
                          ? normalizeRainbow20415Config(cfg)
                          : null;
                        const rainbowLadderConfig = s.strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY
                          ? normalizeRainbowTrendLadderConfig(cfg)
                          : null;
                        const snapshotPositionValue = String(
                          bs?.baseLotSize
                            ?? bs?.tradeAmount
                            ?? rainbowConfig?.Base_Lot_Size.value
                            ?? rainbowLadderConfig?.Base_Lot_Size.value
                            ?? cfg.Base_Lot_Size
                            ?? 30,
                        );
                        const rawSnapshotPositionMode = rainbowConfig?.Base_Lot_Size.mode
                          ?? rainbowLadderConfig?.Base_Lot_Size.mode
                          ?? "usdt";
                        const snapshotPositionMode: "usdt" | "quantity" = rawSnapshotPositionMode === "quantity"
                          ? "quantity"
                          : "usdt";
                        setImportSnapshotPosition({
                          value: snapshotPositionValue,
                          mode: snapshotPositionMode,
                        });
                        setImportForm(prev => ({
                          ...prev,
                          name: `${s.snapshotName || '快照'}_副本`,
                          symbol: (bs?.symbol || cfg.symbol || cfg.Symbol || prev.symbol).replace(/-/g, '').toUpperCase(),
                          positionSize: snapshotPositionValue,
                          positionMode: snapshotPositionMode,
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
        <Dialog open={!!viewConfig} onOpenChange={(open) => {
          if (!open) {
            setViewConfig(null);
            setViewStrategyKey(null);
          }
        }}>
          <DialogContent className="max-h-[86vh] max-w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-5xl">
            <DialogHeader>
              <DialogTitle>參數詳情</DialogTitle>
            </DialogHeader>
            {viewConfig && viewV41Display ? (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold">V4.1 入場條件契約覆核</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    AND／OR、三項條件、三 K 模式與特殊原地重入均以快照保存值唯讀顯示；查看詳情不會改寫配置。
                  </p>
                </div>
                {!viewV41Display.validation.valid && (
                  <div role="alert" className="flex items-start gap-3 rounded-lg border border-amber-500/35 bg-amber-500/8 p-3 text-amber-100">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">Canonical 驗證警告（不封鎖唯讀瀏覽）</p>
                      <p className="mt-1 text-xs leading-relaxed text-amber-100/75">
                        此快照仍可查看，但後端套用或複製時會維持 fail-closed，直到配置通過同 key 嚴格驗證。
                      </p>
                      <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-amber-100/75">
                        {viewV41Display.validation.issues.map((issue) => (
                          <li key={`${issue.path}:${issue.message}`}>{issue.path}：{issue.message}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
                <V41EntryConditionsPanel
                  value={viewV41Display.canonicalCandidate}
                  onChange={() => undefined}
                  disabled
                  readOnly
                  context="snapshot"
                  validationIssues={viewV41Display.validation.issues}
                />
                <details className="rounded-lg border border-border/60 bg-muted/20 p-3">
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">查看完整原始參數</summary>
                  <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-[11px] font-mono">
                    {JSON.stringify(viewConfig, null, 2)}
                  </pre>
                </details>
              </div>
            ) : viewConfig && viewStrategyKey === RAINBOW_20415_STRATEGY_KEY ? (
              <Rainbow20415ConfigPanel value={viewConfig} onChange={() => undefined} disabled context="snapshot" />
            ) : viewConfig && viewStrategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY ? (
              <RainbowTrendLadderConfigPanel value={viewConfig} onChange={() => undefined} disabled context="snapshot" />
            ) : (
              <pre className="bg-muted p-4 rounded text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                {viewConfig ? JSON.stringify(viewConfig, null, 2) : ""}
              </pre>
            )}
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
            {selectedV41Display && (
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-emerald-500/40 text-emerald-300">
                    入場邏輯：{selectedV41Display.config.entryConditionLogic.toUpperCase()}
                  </Badge>
                  <Badge variant="outline">
                    {countEnabledV41EntryConditions(selectedV41Display.config)}/3 條件
                  </Badge>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {summarizeV41EntryConfig(selectedV41Display.config)}
                </p>
                {!selectedV41Display.validation.valid && (
                  <p className="mt-2 text-xs text-amber-300">此快照未通過 canonical 驗證，伺服器將拒絕套用。</p>
                )}
              </div>
            )}
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
                快照只提供策略邏輯與倉位預填；建立前可獨立指定最終實盤部署倉位。
              </DialogDescription>
            </DialogHeader>
            {selectedV41Display && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-emerald-500/40 text-emerald-300">
                    入場邏輯：{selectedV41Display.config.entryConditionLogic.toUpperCase()}
                  </Badge>
                  <Badge variant="outline">{countEnabledV41EntryConditions(selectedV41Display.config)}/3 條件</Badge>
                </div>
                <p className="mt-2 text-muted-foreground">{summarizeV41EntryConfig(selectedV41Display.config)}</p>
                <p className="mt-2 text-amber-200">V4.1 快照複製為新策略後預設停用，必須人工覆核後才可啟用。</p>
              </div>
            )}
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
                  <Label>最終實盤部署倉位 ({importForm.positionMode === 'usdt' ? 'USDT' : '數量'})</Label>
                  <Input
                    type="number"
                    value={importForm.positionSize}
                    onChange={(e) => setImportForm(prev => ({ ...prev, positionSize: e.target.value }))}
                  />
                </div>
              </div>
              {importSnapshotPosition && (
                <div className="rounded-md border border-cyan-500/30 bg-cyan-500/5 px-3 py-2 text-xs leading-relaxed">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-cyan-100">
                    <span className="font-medium">快照原始倉位</span>
                    <span className="font-mono">
                      {importSnapshotPosition.value} {importSnapshotPosition.mode === "usdt" ? "USDT" : "數量"}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-emerald-200">
                    <span className="font-medium">建立後最終生效</span>
                    <span className="font-mono font-semibold">
                      {importForm.positionSize || "—"} {importForm.positionMode === "usdt" ? "USDT" : "數量"}
                    </span>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    最終值會寫入策略頂層部署契約；快照、回測參數與策略專用 Base_Lot_Size 均不得覆蓋。
                  </p>
                </div>
              )}
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
