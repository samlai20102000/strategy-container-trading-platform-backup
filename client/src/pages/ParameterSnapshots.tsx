/**
 * 參數快照庫頁面（V4.1）
 * 功能：列表展示、按策略/績效排序、套用到策略、刪除、收藏
 */

import { useState, useMemo } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import ExecutionProfileSummary, { ExecutionModeBadge } from "@/components/ExecutionProfileSummary";
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
import { AlertTriangle, Star, Trash2, Play, Eye, Database, Plus, RefreshCw, GitCompareArrows, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Rainbow20415ConfigPanel } from "@/components/Rainbow20415ConfigPanel";
import { RainbowTrendLadderConfigPanel } from "@/components/RainbowTrendLadderConfigPanel";
import { KamaRainbowMartinConfigPanel } from "@/components/KamaRainbowMartinConfigPanel";
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
  KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY,
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  getKamaRainbowMartinTimeframeMinutes,
  normalizeKamaRainbowMartinConfig,
  validateKamaRainbowMartinConfig,
} from "@shared/strategies/kamaRainbowMartin";
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

function getKamaRainbowMartinSnapshotDisplay(strategyKey: string | null | undefined, rawSnapshotConfig: unknown) {
  if (strategyKey !== KAMA_RAINBOW_MARTIN_STRATEGY_KEY) return null;
  const canonicalCandidate = isRecord(rawSnapshotConfig) && isRecord(rawSnapshotConfig[KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY])
    ? rawSnapshotConfig[KAMA_RAINBOW_MARTIN_PRIVATE_CONFIG_KEY]
    : rawSnapshotConfig;
  const validation = validateKamaRainbowMartinConfig(canonicalCandidate);
  const config = validation.config ?? normalizeKamaRainbowMartinConfig(canonicalCandidate);
  return { canonicalCandidate, config, validation };
}

export default function ParameterSnapshots() {
  const [sortBy, setSortBy] = useState<"totalReturn" | "winRate" | "sharpeRatio" | "createdAt">("createdAt");
  const [filterStrategy, setFilterStrategy] = useState<string>("all");
  const [viewConfig, setViewConfig] = useState<Record<string, unknown> | null>(null);
  const [viewStrategyKey, setViewStrategyKey] = useState<string | null>(null);
  const [viewSnapshotId, setViewSnapshotId] = useState<number | null>(null);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
  const [targetStrategyId, setTargetStrategyId] = useState<string>("");
  const [compareSnapshotIds, setCompareSnapshotIds] = useState<number[]>([]);
  const [deploymentDialogOpen, setDeploymentDialogOpen] = useState(false);
  const [deploymentSnapshotId, setDeploymentSnapshotId] = useState<number | null>(null);
  const [deploymentForm, setDeploymentForm] = useState({
    name: "",
    apiKeyId: "",
    symbol: "BTCUSDT",
    positionSize: "1",
    positionMode: "usdt" as "usdt" | "quantity",
    leverage: "1",
    direction: "both" as "long" | "short" | "both",
  });
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
  const createDeploymentMutation = trpc.deployments.create.useMutation();
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
  const selectedKamaRainbowMartinDisplay = useMemo(
    () => getKamaRainbowMartinSnapshotDisplay(selectedSnapshot?.strategyKey, selectedSnapshot?.config),
    [selectedSnapshot],
  );
  const viewV41Display = useMemo(
    () => getV41SnapshotDisplay(viewStrategyKey, viewConfig),
    [viewConfig, viewStrategyKey],
  );
  const viewKamaRainbowMartinDisplay = useMemo(
    () => getKamaRainbowMartinSnapshotDisplay(viewStrategyKey, viewConfig),
    [viewConfig, viewStrategyKey],
  );
  const viewSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.id === viewSnapshotId) ?? null,
    [snapshots, viewSnapshotId],
  );
  const deploymentSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.id === deploymentSnapshotId) ?? null,
    [deploymentSnapshotId, snapshots],
  );
  const compareSnapshots = useMemo(
    () => compareSnapshotIds
      .map((id) => snapshots.find((snapshot) => snapshot.id === id))
      .filter((snapshot): snapshot is NonNullable<typeof snapshot> => Boolean(snapshot)),
    [compareSnapshotIds, snapshots],
  );

  const getSnapshotDeploymentDefaults = (snapshot: (typeof snapshots)[number]) => {
    const bs = snapshot.backtestSettings as Record<string, unknown> | null;
    const cfg = snapshot.config as Record<string, unknown>;
    const rawSymbol = bs?.symbol ?? cfg.symbol ?? cfg.Symbol ?? "BTCUSDT";
    const rawPosition = bs?.baseLotSize ?? bs?.tradeAmount ?? cfg.Base_Lot_Size ?? 1;
    const rawPositionMode = bs?.baseLotSizeMode;
    return {
      name: `${snapshot.snapshotName || snapshot.strategyName || snapshot.strategyKey} · 部署草稿`,
      apiKeyId: "",
      symbol: String(rawSymbol).replace(/-/g, "").toUpperCase(),
      positionSize: String(typeof rawPosition === "object" && rawPosition !== null && "value" in rawPosition
        ? (rawPosition as { value?: unknown }).value ?? 1
        : rawPosition),
      positionMode: rawPositionMode === "quantity" ? "quantity" as const : "usdt" as const,
      leverage: String(cfg.leverage ?? 1),
      direction: "both" as const,
    };
  };

  const openDeploymentDraft = (snapshot: (typeof snapshots)[number]) => {
    setDeploymentSnapshotId(snapshot.id);
    setDeploymentForm(getSnapshotDeploymentDefaults(snapshot));
    setDeploymentDialogOpen(true);
  };

  const openSnapshotView = (snapshot: (typeof snapshots)[number]) => {
    setViewConfig(snapshot.config);
    setViewStrategyKey(snapshot.strategyKey);
    setViewSnapshotId(snapshot.id);
  };

  const openSnapshotApply = (snapshot: (typeof snapshots)[number]) => {
    setSelectedSnapshotId(snapshot.id);
    setApplyDialogOpen(true);
  };

  const openSnapshotImport = (snapshot: (typeof snapshots)[number]) => {
    setSelectedSnapshotId(snapshot.id);
    const backtestSettings = snapshot.backtestSettings as Record<string, unknown> | null;
    const config = (snapshot.config as Record<string, unknown>) || {};
    const rainbowConfig = snapshot.strategyKey === RAINBOW_20415_STRATEGY_KEY
      ? normalizeRainbow20415Config(config)
      : null;
    const rainbowLadderConfig = snapshot.strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY
      ? normalizeRainbowTrendLadderConfig(config)
      : null;
    const snapshotPositionValue = String(
      backtestSettings?.baseLotSize
        ?? backtestSettings?.tradeAmount
        ?? rainbowConfig?.Base_Lot_Size.value
        ?? rainbowLadderConfig?.Base_Lot_Size.value
        ?? config.Base_Lot_Size
        ?? 30,
    );
    const rawSnapshotPositionMode = backtestSettings?.baseLotSizeMode
      ?? rainbowConfig?.Base_Lot_Size.mode
      ?? rainbowLadderConfig?.Base_Lot_Size.mode
      ?? "usdt";
    const snapshotPositionMode: "usdt" | "quantity" = rawSnapshotPositionMode === "quantity"
      ? "quantity"
      : "usdt";
    setImportSnapshotPosition({ value: snapshotPositionValue, mode: snapshotPositionMode });
    setImportForm((previous) => ({
      ...previous,
      name: `${snapshot.snapshotName || "快照"}_副本`,
      symbol: String(backtestSettings?.symbol || config.symbol || config.Symbol || previous.symbol)
        .replace(/-/g, "")
        .toUpperCase(),
      positionSize: snapshotPositionValue,
      positionMode: snapshotPositionMode,
      leverage: String(config.leverage || previous.leverage),
    }));
    setImportDialogOpen(true);
  };

  const toggleSnapshotComparison = (snapshotId: number) => {
    setCompareSnapshotIds((current) => {
      if (current.includes(snapshotId)) return current.filter((id) => id !== snapshotId);
      if (current.length >= 2) {
        toast.info("Execution Profile 比較最多選擇兩個快照");
        return [current[1], snapshotId];
      }
      return [...current, snapshotId];
    });
  };

  const handleCreateDeploymentDraft = async () => {
    if (!deploymentSnapshot) return;
    if (!deploymentForm.name.trim()) return toast.error("請輸入部署名稱");
    if (!deploymentForm.apiKeyId) return toast.error("請選擇 API 金鑰");
    const positionSize = Number(deploymentForm.positionSize);
    if (!Number.isFinite(positionSize) || positionSize <= 0) return toast.error("倉位大小需為正數");
    try {
      const deployment = await createDeploymentMutation.mutateAsync({
        name: deploymentForm.name.trim(),
        apiKeyId: Number(deploymentForm.apiKeyId),
        symbol: deploymentForm.symbol.trim().toUpperCase(),
        strategyKey: deploymentSnapshot.strategyKey,
        sourceSnapshotId: deploymentSnapshot.id,
        positionSize,
        positionMode: deploymentForm.positionMode,
        leverage: Number(deploymentForm.leverage) || 1,
        direction: deploymentForm.direction,
        executionMode: deploymentSnapshot.artifact?.artifactScope === "EXECUTION_PROFILE"
          ? deploymentSnapshot.artifact.executionMode
          : undefined,
        executionPolicy: deploymentSnapshot.artifact?.artifactScope === "EXECUTION_PROFILE"
          ? { ...deploymentSnapshot.artifact.executionPolicy }
          : undefined,
      });
      toast.success("部署草稿已建立並保持停用", {
        description: "來源快照與 Execution Profile 已由伺服器封印；請先執行唯讀 Preflight。",
      });
      setDeploymentDialogOpen(false);
      window.location.assign(`/deployments?deploymentId=${deployment.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "建立部署草稿失敗");
    }
  };

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

        {compareSnapshots.length > 0 && (
          <Card className="border-violet-500/25 bg-violet-500/[0.03]">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <GitCompareArrows className="h-4 w-4 text-violet-300" /> Execution Profile 比較
                  </CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">選擇兩個快照即可比較模式、policy、風險預算與 artifact 版本。</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setCompareSnapshotIds([])}>清除比較</Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 lg:grid-cols-2">
                {compareSnapshots.map((snapshot) => (
                  <div key={snapshot.id} className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{snapshot.snapshotName || `快照 #${snapshot.id}`}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{snapshot.strategyKey}</p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => toggleSnapshotComparison(snapshot.id)}>移除</Button>
                    </div>
                    <ExecutionProfileSummary
                      strategyKey={snapshot.strategyKey}
                      executionMode={snapshot.artifact?.executionMode}
                      executionPolicy={snapshot.artifact?.executionPolicy}
                      artifactScope={snapshot.artifact?.artifactScope}
                      strategyVersion={snapshot.artifact?.strategyVersion}
                      integrityValid={snapshot.integrityValid}
                      compatible={snapshot.compatibility.compatible}
                    />
                    <div className="grid gap-1 rounded-md border border-border/50 bg-background/40 p-2 font-mono text-[10px] text-muted-foreground">
                      <span>Policy hash：{snapshot.artifact?.executionPolicyHash ?? "—"}</span>
                      <span>Logic hash：{snapshot.artifact?.strategyLogicHash ?? "—"}</span>
                      <span>Artifact hash：{snapshot.artifact?.artifactHash ?? snapshot.compatibility.artifactHash ?? "—"}</span>
                    </div>
                  </div>
                ))}
                {compareSnapshots.length === 1 && (
                  <button
                    type="button"
                    className="min-h-40 rounded-lg border border-dashed border-violet-500/30 p-6 text-sm text-muted-foreground transition-colors hover:border-violet-400/50 hover:text-violet-200"
                    onClick={() => toast.info("請在列表選擇另一個快照加入比較")}
                  >
                    再選擇一個快照以完成雙欄比較
                  </button>
                )}
              </div>
              {compareSnapshots.length === 2 && (
                <div className="mt-3 rounded-md border border-border/50 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
                  結論：模式{compareSnapshots[0].artifact?.executionMode === compareSnapshots[1].artifact?.executionMode ? "相同" : "不同"}；
                  Policy hash {compareSnapshots[0].artifact?.executionPolicyHash === compareSnapshots[1].artifact?.executionPolicyHash ? "相同" : "不同"}；
                  Strategy logic hash {compareSnapshots[0].artifact?.strategyLogicHash === compareSnapshots[1].artifact?.strategyLogicHash ? "相同" : "不同"}。
                </div>
              )}
            </CardContent>
          </Card>
        )}

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
              <div className="space-y-3">
                <div className="space-y-3 md:hidden">
                  {sortedSnapshots.map((snapshot) => {
                    const trusted = snapshot.integrityValid && snapshot.compatibility.compatible;
                    return (
                      <div key={snapshot.id} className="rounded-xl border border-border/60 bg-background/35 p-4 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{snapshot.snapshotName || "未命名"}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <Badge variant="outline" className="max-w-full truncate text-[10px]">
                                {snapshot.strategyName || snapshot.strategyKey}
                              </Badge>
                              <span className="text-[10px] text-muted-foreground">
                                {snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleDateString("zh-TW") : "—"}
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleToggleFav(snapshot.id)}
                            className="shrink-0 rounded-md p-2 transition-transform active:scale-95"
                            aria-label={snapshot.isFavorite ? "取消收藏" : "加入收藏"}
                          >
                            <Star className={`h-4 w-4 ${snapshot.isFavorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`} />
                          </button>
                        </div>

                        <div className="mt-3 rounded-lg border border-border/50 bg-card/40 p-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <ExecutionModeBadge mode={snapshot.artifact?.executionMode} />
                            <Badge
                              variant="outline"
                              className={snapshot.artifact?.artifactScope === "EXECUTION_PROFILE"
                                ? "border-cyan-500/35 text-[10px] text-cyan-300"
                                : "text-[10px] text-muted-foreground"}
                            >
                              {snapshot.artifact?.artifactScope ?? "LEGACY"}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={trusted
                                ? "border-emerald-500/35 text-[10px] text-emerald-300"
                                : "border-amber-500/40 text-[10px] text-amber-300"}
                            >
                              {trusted ? "可信" : "Fail-closed"}
                            </Badge>
                          </div>
                          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                            Strategy v{snapshot.artifact?.strategyVersion ?? "—"}
                          </p>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                          <div className="rounded-md bg-muted/35 p-2">
                            <p className="text-[10px] text-muted-foreground">回報率</p>
                            <p className={`mt-1 font-mono font-semibold ${(snapshot.totalReturn ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                              {fmtNum(snapshot.totalReturn)}%
                            </p>
                          </div>
                          <div className="rounded-md bg-muted/35 p-2">
                            <p className="text-[10px] text-muted-foreground">最大回撤</p>
                            <p className="mt-1 font-mono font-semibold text-red-400">{fmtNum(snapshot.maxDrawdown)}%</p>
                          </div>
                          <div className="rounded-md bg-muted/35 p-2">
                            <p className="text-[10px] text-muted-foreground">勝率</p>
                            <p className="mt-1 font-mono font-semibold">{fmtNum(snapshot.winRate)}%</p>
                          </div>
                          <div className="rounded-md bg-muted/35 p-2">
                            <p className="text-[10px] text-muted-foreground">夏普／盈虧比</p>
                            <p className="mt-1 font-mono font-semibold">{fmtNum(snapshot.sharpeRatio, 3)} / {fmtNum(snapshot.profitFactor)}</p>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <Button
                            variant={compareSnapshotIds.includes(snapshot.id) ? "secondary" : "outline"}
                            size="sm"
                            onClick={() => toggleSnapshotComparison(snapshot.id)}
                          >
                            <GitCompareArrows className="mr-1.5 h-3.5 w-3.5" />比較
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => openSnapshotView(snapshot)}>
                            <Eye className="mr-1.5 h-3.5 w-3.5" />查看
                          </Button>
                          <Button variant="outline" size="sm" className="text-emerald-300" onClick={() => openSnapshotApply(snapshot)}>
                            <Play className="mr-1.5 h-3.5 w-3.5" />更新策略
                          </Button>
                          <Button variant="outline" size="sm" className="text-blue-300" onClick={() => openSnapshotImport(snapshot)}>
                            <Plus className="mr-1.5 h-3.5 w-3.5" />複製副本
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-cyan-300"
                            onClick={() => openDeploymentDraft(snapshot)}
                            disabled={!trusted}
                          >
                            <Rocket className="mr-1.5 h-3.5 w-3.5" />部署草稿
                          </Button>
                          <Button variant="outline" size="sm" className="text-red-300" onClick={() => handleDelete(snapshot.id)}>
                            <Trash2 className="mr-1.5 h-3.5 w-3.5" />刪除
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8"></TableHead>
                      <TableHead>快照名稱</TableHead>
                      <TableHead>策略</TableHead>
                      <TableHead>Execution Profile</TableHead>
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
                          {s.strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY && (() => {
                            const display = getKamaRainbowMartinSnapshotDisplay(s.strategyKey, s.config);
                            if (!display) return null;
                            return (
                              <div className="mt-2 flex min-w-56 flex-wrap items-center gap-1.5">
                                <Badge variant="outline" className="border-cyan-500/40 text-[10px] text-cyan-200">
                                  {getKamaRainbowMartinTimeframeMinutes(display.config.timeframe)}m
                                </Badge>
                                <Badge variant="outline" className="text-[10px]">{display.config.kamaLines.length} KAMA</Badge>
                                <Badge variant="outline" className="text-[10px]">{display.config.maxLayers} 層</Badge>
                                {!display.validation.valid && (
                                  <Badge variant="outline" className="border-amber-500/45 text-[10px] text-amber-300">需複核</Badge>
                                )}
                              </div>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="min-w-44">
                          <div className="space-y-1.5">
                            <ExecutionModeBadge mode={s.artifact?.executionMode} />
                            <div className="flex flex-wrap gap-1">
                              <Badge
                                variant="outline"
                                className={s.artifact?.artifactScope === "EXECUTION_PROFILE"
                                  ? "border-cyan-500/35 text-[10px] text-cyan-300"
                                  : "text-[10px] text-muted-foreground"}
                              >
                                {s.artifact?.artifactScope ?? "LEGACY"}
                              </Badge>
                              <Badge
                                variant="outline"
                                className={s.integrityValid && s.compatibility.compatible
                                  ? "border-emerald-500/35 text-[10px] text-emerald-300"
                                  : "border-amber-500/40 text-[10px] text-amber-300"}
                              >
                                {s.integrityValid && s.compatibility.compatible ? "可信" : "Fail-closed"}
                              </Badge>
                            </div>
                            <p className="text-[10px] text-muted-foreground">Strategy v{s.artifact?.strategyVersion ?? "—"}</p>
                          </div>
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
                              variant={compareSnapshotIds.includes(s.id) ? "secondary" : "ghost"}
                              size="sm"
                              onClick={() => toggleSnapshotComparison(s.id)}
                              title="加入 Execution Profile 比較"
                            >
                              <GitCompareArrows className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openSnapshotView(s)}
                              title="查看參數"
                            >
                              <Eye className="w-4 h-4" />
                            </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-emerald-400 hover:text-emerald-300"
                      onClick={() => openSnapshotApply(s)}
                      title="將此快照參數覆蓋至選定的現有策略實例"
                    >
                      <Play className="w-4 h-4" />
                      <span className="ml-1 text-xs hidden lg:inline">更新策略參數</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-blue-400 hover:text-blue-300"
                      onClick={() => openSnapshotImport(s)}
                      title="以此快照參數建立一個全新的策略實例"
                    >
                      <Plus className="w-4 h-4" />
                      <span className="ml-1 text-xs hidden lg:inline">複製為副本</span>
                    </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-cyan-400 hover:text-cyan-300"
                              onClick={() => openDeploymentDraft(s)}
                              disabled={!s.integrityValid || !s.compatibility.compatible}
                              title={s.integrityValid && s.compatibility.compatible
                                ? "由可信快照建立停用部署草稿"
                                : "Artifact 未通過可信與相容 Gate"}
                            >
                              <Rocket className="w-4 h-4" />
                              <span className="ml-1 hidden text-xs 2xl:inline">部署草稿</span>
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
              </div>
            )}
          </CardContent>
        </Card>

        {/* 查看參數 Dialog */}
        <Dialog open={!!viewConfig} onOpenChange={(open) => {
          if (!open) {
            setViewConfig(null);
            setViewStrategyKey(null);
            setViewSnapshotId(null);
          }
        }}>
          <DialogContent className="max-h-[86vh] max-w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-5xl">
            <DialogHeader>
              <DialogTitle>參數詳情</DialogTitle>
            </DialogHeader>
            {viewSnapshot && (
              <ExecutionProfileSummary
                strategyKey={viewSnapshot.strategyKey}
                executionMode={viewSnapshot.artifact?.executionMode}
                executionPolicy={viewSnapshot.artifact?.executionPolicy}
                artifactScope={viewSnapshot.artifact?.artifactScope}
                strategyVersion={viewSnapshot.artifact?.strategyVersion}
                integrityValid={viewSnapshot.integrityValid}
                compatible={viewSnapshot.compatibility.compatible}
              />
            )}
            {viewConfig && viewKamaRainbowMartinDisplay ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="border-cyan-500/40 text-cyan-200">{viewKamaRainbowMartinDisplay.config.version}</Badge>
                    <Badge variant="outline">{getKamaRainbowMartinTimeframeMinutes(viewKamaRainbowMartinDisplay.config.timeframe)}m</Badge>
                    <Badge variant="outline">{viewKamaRainbowMartinDisplay.config.kamaLines.length} 條 KAMA</Badge>
                    <Badge variant="outline">{viewKamaRainbowMartinDisplay.config.maxLayers} 層含底倉</Badge>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    此處唯讀覆核 canonical 策略配置；Position_Size／Mode 來自快照頂層回測設定，不會回寫策略配置。
                  </p>
                </div>
                {!viewKamaRainbowMartinDisplay.validation.valid && (
                  <div role="alert" className="rounded-lg border border-amber-500/35 bg-amber-500/8 p-3 text-xs text-amber-100">
                    <p className="font-semibold">Canonical 驗證失敗，伺服器將拒絕套用或導入。</p>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-amber-100/75">
                      {viewKamaRainbowMartinDisplay.validation.issues.map((issue) => (
                        <li key={`${issue.path}:${issue.message}`}>{issue.path}：{issue.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {viewSnapshot && (
                  <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs sm:grid-cols-2">
                    <span>Artifact：<strong className={viewSnapshot.compatibility.compatible ? "text-emerald-300" : "text-amber-300"}>{viewSnapshot.compatibility.compatible ? "相容" : "封鎖"}</strong></span>
                    <span>Integrity：<strong className={viewSnapshot.integrityValid ? "text-emerald-300" : "text-amber-300"}>{viewSnapshot.integrityValid ? "有效" : "需複核"}</strong></span>
                    <span>Scope：{viewSnapshot.artifact?.artifactScope ?? "LEGACY"}</span>
                    <span>Strategy version：{viewSnapshot.artifact?.strategyVersion ?? "—"}</span>
                    <span className="break-all sm:col-span-2">Logic hash：{viewSnapshot.artifact?.strategyLogicHash ?? "—"}</span>
                    <span className="break-all sm:col-span-2">Artifact checksum：{viewSnapshot.artifact?.artifactHash ?? viewSnapshot.compatibility.artifactHash ?? "—"}</span>
                  </div>
                )}
                <KamaRainbowMartinConfigPanel
                  value={viewKamaRainbowMartinDisplay.canonicalCandidate}
                  onChange={() => undefined}
                  disabled
                  context="snapshot"
                  positionMode={viewSnapshot?.backtestSettings?.baseLotSizeMode === "quantity" ? "quantity" : "usdt"}
                  positionSize={Number(viewSnapshot?.backtestSettings?.baseLotSize ?? viewSnapshot?.backtestSettings?.tradeAmount ?? 0)}
                />
              </div>
            ) : viewConfig && viewV41Display ? (
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
            {selectedSnapshot && (
              <ExecutionProfileSummary
                strategyKey={selectedSnapshot.strategyKey}
                executionMode={selectedSnapshot.artifact?.executionMode}
                executionPolicy={selectedSnapshot.artifact?.executionPolicy}
                artifactScope={selectedSnapshot.artifact?.artifactScope}
                strategyVersion={selectedSnapshot.artifact?.strategyVersion}
                integrityValid={selectedSnapshot.integrityValid}
                compatible={selectedSnapshot.compatibility.compatible}
                compact
              />
            )}
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
            {selectedKamaRainbowMartinDisplay && (
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3 text-xs leading-relaxed">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-cyan-500/40 text-cyan-200">{selectedKamaRainbowMartinDisplay.config.version}</Badge>
                  <Badge variant="outline">{selectedKamaRainbowMartinDisplay.config.kamaLines.length} KAMA</Badge>
                  <Badge variant="outline">{selectedKamaRainbowMartinDisplay.config.maxLayers} 層</Badge>
                </div>
                <p className="mt-2 text-muted-foreground">只允許套用至相同 KRM strategy key；套用後會停用並要求重新 preflight。</p>
                {!selectedKamaRainbowMartinDisplay.validation.valid && (
                  <p className="mt-2 text-amber-300">Canonical 驗證失敗，伺服器將 fail-closed 拒絕套用。</p>
                )}
              </div>
            )}
            <div className="py-4">
              <Select value={targetStrategyId} onValueChange={setTargetStrategyId}>
                <SelectTrigger>
                  <SelectValue placeholder="選擇目標策略實例" />
                </SelectTrigger>
                <SelectContent>
                  {(userStrategiesQuery.data ?? []).filter((s: any) => s.strategyKey === selectedSnapshot?.strategyKey).map((s: any) => (
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
            {selectedSnapshot && (
              <ExecutionProfileSummary
                strategyKey={selectedSnapshot.strategyKey}
                executionMode={selectedSnapshot.artifact?.executionMode}
                executionPolicy={selectedSnapshot.artifact?.executionPolicy}
                artifactScope={selectedSnapshot.artifact?.artifactScope}
                strategyVersion={selectedSnapshot.artifact?.strategyVersion}
                integrityValid={selectedSnapshot.integrityValid}
                compatible={selectedSnapshot.compatibility.compatible}
                compact
              />
            )}
            {selectedV41Display && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-emerald-500/40 text-emerald-300">
                    入場邏輯：{selectedV41Display.config.entryConditionLogic.toUpperCase()}
                  </Badge>
                  <Badge variant="outline">{countEnabledV41EntryConditions(selectedV41Display.config)}/3 條件</Badge>
                </div>
                <p className="mt-2 text-muted-foreground">{summarizeV41EntryConfig(selectedV41Display.config)}</p>
                <p className="mt-2 text-amber-200">V4.1 快照複製為新策略後預設停用；人工覆核後可由策略卡片直接啟用，不需另跑 deployment preflight。</p>
              </div>
            )}
            {selectedKamaRainbowMartinDisplay && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-cyan-500/40 text-cyan-200">{selectedKamaRainbowMartinDisplay.config.version}</Badge>
                  <Badge variant="outline">{selectedKamaRainbowMartinDisplay.config.kamaLines.length} KAMA</Badge>
                  <Badge variant="outline">{selectedKamaRainbowMartinDisplay.config.maxLayers} 層</Badge>
                </div>
                <p className="mt-2 text-amber-200">KRM 快照複製後固定為停用；canonical 配置與頂層部署倉位分離，必須重新通過 preflight。</p>
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

        <Dialog open={deploymentDialogOpen} onOpenChange={setDeploymentDialogOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>由快照建立部署草稿</DialogTitle>
              <DialogDescription>
                伺服器會以 sourceSnapshotId 讀取並封印可信策略配置與 Execution Profile；建立後一律停用，不會送單。
              </DialogDescription>
            </DialogHeader>
            {deploymentSnapshot && (
              <ExecutionProfileSummary
                strategyKey={deploymentSnapshot.strategyKey}
                executionMode={deploymentSnapshot.artifact?.executionMode}
                executionPolicy={deploymentSnapshot.artifact?.executionPolicy}
                artifactScope={deploymentSnapshot.artifact?.artifactScope}
                strategyVersion={deploymentSnapshot.artifact?.strategyVersion}
                integrityValid={deploymentSnapshot.integrityValid}
                compatible={deploymentSnapshot.compatibility.compatible}
                compact
              />
            )}
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label>部署名稱</Label>
                <Input
                  value={deploymentForm.name}
                  onChange={(event) => setDeploymentForm((current) => ({ ...current, name: event.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>API 金鑰</Label>
                <Select
                  value={deploymentForm.apiKeyId}
                  onValueChange={(value) => setDeploymentForm((current) => ({ ...current, apiKeyId: value }))}
                >
                  <SelectTrigger><SelectValue placeholder="選擇 API 金鑰" /></SelectTrigger>
                  <SelectContent>
                    {(apiKeysQuery.data ?? []).map((key: any) => (
                      <SelectItem key={key.id} value={String(key.id)}>{key.label || key.name} ({key.exchange})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>交易對</Label>
                <Input
                  value={deploymentForm.symbol}
                  onChange={(event) => setDeploymentForm((current) => ({ ...current, symbol: event.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>最終實盤部署倉位</Label>
                <Input
                  type="number"
                  min="0"
                  value={deploymentForm.positionSize}
                  onChange={(event) => setDeploymentForm((current) => ({ ...current, positionSize: event.target.value }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>倉位模式</Label>
                  <Select
                    value={deploymentForm.positionMode}
                    onValueChange={(value) => setDeploymentForm((current) => ({
                      ...current,
                      positionMode: value === "quantity" ? "quantity" : "usdt",
                    }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="usdt">USDT</SelectItem>
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
                    value={deploymentForm.leverage}
                    onChange={(event) => setDeploymentForm((current) => ({ ...current, leverage: event.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>允許方向</Label>
                <Select
                  value={deploymentForm.direction}
                  onValueChange={(value) => setDeploymentForm((current) => ({
                    ...current,
                    direction: value as "long" | "short" | "both",
                  }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="both">雙向</SelectItem>
                    <SelectItem value="long">只做多</SelectItem>
                    <SelectItem value="short">只做空</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-100">
              安全預設：DRAFT／disabled。建立後請在部署工作台執行唯讀 Preflight，檢閱全部必要 Gate，再另行明確啟用。
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeploymentDialogOpen(false)}>取消</Button>
              <Button
                onClick={handleCreateDeploymentDraft}
                disabled={createDeploymentMutation.isPending || !deploymentSnapshot?.integrityValid || !deploymentSnapshot?.compatibility.compatible}
              >
                {createDeploymentMutation.isPending
                  ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  : <Rocket className="mr-2 h-4 w-4" />}
                建立停用草稿
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
