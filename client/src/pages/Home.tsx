import {
  ExchangeBadge,
  formatTime,
  PnlValue,
  SideBadge,
  SignalStatusBadge,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Landmark,
  LineChart,
  Loader2,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Target,
  TrendingUp,
  Trophy,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";

// ─── Constants ───────────────────────────────────────────────────
const SIGNAL_PAGE_SIZE = 25;

// ─── Main Export ─────────────────────────────────────────────────
export default function Home() {
  return (
    <DashboardLayout>
      <UnifiedDashboard />
    </DashboardLayout>
  );
}

// ═══════════════════════════════════════════════════════════════════
// UNIFIED DASHBOARD V2.0 (軍工級實盤控制中心)
// ═══════════════════════════════════════════════════════════════════
function UnifiedDashboard() {
  const utils = trpc.useUtils();

  // ─── Data Queries ──────────────────────────────────────────────
  const { data, isLoading, error, isFetching, refetch } =
    trpc.dashboard.overview.useQuery(undefined, { refetchInterval: 10000 });
  const { data: strategies } = trpc.strategies.list.useQuery(undefined, {
    refetchInterval: 10000,
  });
  const positionSnapshotInput = useMemo(
    () => ({ strategyIds: strategies?.map((strategy) => strategy.id) ?? [] }),
    [strategies],
  );
  const { data: positionSnapshots } = trpc.exchange.getStrategyPositionSnapshots.useQuery(
    positionSnapshotInput,
    {
      enabled: positionSnapshotInput.strategyIds.length > 0,
      refetchInterval: 10_000,
      staleTime: 5_000,
    },
  );
  const { data: perfData } = trpc.performance.byStrategy.useQuery({}, { refetchInterval: 30000 });

  // ─── Filter State (Block C) ────────────────────────────────────
  const [symbolFilter, setSymbolFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState("all");
  const [strategyFilter, setStrategyFilter] = useState("all");
  const [signalStatusFilter, setSignalStatusFilter] = useState("all");
  const [signalSourceFilter, setSignalSourceFilter] = useState("all");
  const [signalPage, setSignalPage] = useState(0);
  const [signalPageSize, setSignalPageSize] = useState(25);
  // P2: Layer range filter
  const [minLayerFilter, setMinLayerFilter] = useState(0);
  const [maxLayerFilter, setMaxLayerFilter] = useState(20);
  // Issue 4: Date range filter
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");

  // ─── Position-Signal Linkage (P0-3) ───────────────────────────
  const [selectedPositionSymbol, setSelectedPositionSymbol] = useState<string | null>(null);
  const [flashingSymbol, setFlashingSymbol] = useState<string | null>(null);
  // P0-3: Drawer state
  const [drawerPosition, setDrawerPosition] = useState<any | null>(null);

  // ─── Emergency Close All ───────────────────────────────────────
  const emergencyMutation = trpc.strategies.emergencyCloseAll.useMutation({
    onSuccess: (r) => {
      if (r.success) toast.success(r.message, { duration: 8000 });
      else toast.error(r.message, { duration: 10000 });
      const failed = r.results.filter((x) => !x.success && x.message !== "無持倉，跳過");
      failed.forEach((f) =>
        toast.error(`${f.name}（${f.symbol}）平倉失敗：${f.message}`, { duration: 12000 }),
      );
      utils.dashboard.overview.invalidate();
      utils.strategies.list.invalidate();
      utils.exchange.getStrategyPositionSnapshots.invalidate();
    },
    onError: (e) => toast.error(`緊急全平倉請求異常：${e.message}`, { duration: 10000 }),
  });

  const handleEmergency = () => {
    if (
      confirm("【帳戶級緊急全平倉】將平掉所有帳戶的所有持倉（影響所有策略），並暫停全部策略。確定繼續？") &&
      confirm("【二次確認】此操作將立即以市價平掉所有交易所持倉（包括所有策略的持倉），不可撤銷。確定執行？")
    ) {
      emergencyMutation.mutate();
    }
  };

  // ─── Backfill PnL Mutation ─────────────────────────────────────
  const backfillMutation = trpc.performance.backfillPnl.useMutation({
    onSuccess: (r) => {
      toast.success(
        `PnL 回填完成：${r.updated} 筆已更新，${r.linked} 筆已關聯，${r.skipped} 筆跳過（共 ${r.total} 筆）`,
        { duration: 10000 },
      );
      utils.performance.byStrategy.invalidate();
    },
    onError: (e) => toast.error(`回填失敗：${e.message}`, { duration: 10000 }),
  });

  // ─── Close Position Mutation ───────────────────────────────────
  const closeMutation = trpc.strategies.closePosition.useMutation({
    onSuccess: (r) => {
      if (r.success) toast.success(r.message, { duration: 5000 });
      else toast.error(r.exchangeError ? `平倉失敗：${r.exchangeError}` : r.message, { duration: 10000 });
      utils.dashboard.overview.invalidate();
      utils.strategies.list.invalidate();
      utils.exchange.getStrategyPositionSnapshots.invalidate();
    },
    onError: (e) => toast.error(`平倉請求異常：${e.message}`, { duration: 10000 }),
  });

  // ─── Derived Data ──────────────────────────────────────────────
  const totalEquity = data?.accounts.reduce((sum, a) => sum + (a.balance?.total ?? 0), 0) ?? 0;
  const totalUnrealized = data?.accounts.reduce((sum, a) => sum + (a.balance?.unrealizedPnl ?? 0), 0) ?? 0;
  // Fix: Use actual usedMargin (initial margin requirement) from exchange API
  // instead of (total - free) which is wrong for cross-margin mode
  const totalUsedMargin = data?.accounts.reduce((sum, a) => sum + (a.balance?.usedMargin ?? 0), 0) ?? 0;
  const totalFree = data?.accounts.reduce((sum, a) => sum + (a.balance?.free ?? 0), 0) ?? 0;
  // Margin usage = usedMargin / (usedMargin + availableBalance) * 100
  const marginDenominator = totalUsedMargin + totalFree;
  const marginUsagePercent = marginDenominator > 0 ? (totalUsedMargin / marginDenominator) * 100 : 0;

  const allPositions = useMemo(() => {
    return (
      data?.accounts.flatMap((a) =>
        a.positions.map((p) => ({
          ...p,
          account: a.label,
          exchange: a.exchange,
          apiKeyId: a.apiKeyId,
          isTestnet: a.isTestnet,
        })),
      ) ?? []
    );
  }, [data]);

  // 交易所帳戶持倉只能在後端快照確認為 exact 時，才歸屬及開放單策略平倉。
  // 共享帳戶／交易對／方向的合併持倉保留帳戶級真值，不再模糊配對到第一個策略。
  const positionsWithLayer = useMemo(() => {
    const normalizeSymbol = (sym: string) => sym.replace(/-SWAP$/i, "").replace(/-/g, "").toUpperCase();
    const strategyById = new Map((strategies ?? []).map((strategy) => [strategy.id, strategy] as const));
    return allPositions.map((p) => {
      const pNorm = normalizeSymbol(p.symbol);
      const relatedSnapshots = (positionSnapshots ?? []).filter(
        (snapshot) => snapshot.apiKeyId === p.apiKeyId
          && normalizeSymbol(snapshot.symbol) === pNorm
          && snapshot.side === p.side
          && snapshot.status === "available",
      );
      const exactSnapshots = relatedSnapshots.filter((snapshot) => snapshot.attribution === "exact");
      const exactSnapshot = exactSnapshots.length === 1 ? exactSnapshots[0] : undefined;
      const matchedStrategy = exactSnapshot ? strategyById.get(exactSnapshot.strategyId) : undefined;
      const martinState = (matchedStrategy?.martinState ?? {}) as any;
      const layer = Number(martinState.currentLayer) || 0;
      const relatedStrategyNames = relatedSnapshots
        .map((snapshot) => strategyById.get(snapshot.strategyId)?.name)
        .filter((name): name is string => Boolean(name));
      return {
        ...p,
        layer,
        strategyId: matchedStrategy?.id,
        strategyName: matchedStrategy?.name,
        relatedStrategyNames,
        positionAttribution: matchedStrategy
          ? "exact"
          : relatedSnapshots.length > 0
            ? "account_aggregate"
            : "unassigned",
      };
    });
  }, [allPositions, positionSnapshots, strategies]);

  // Filtered positions
  const filteredPositions = useMemo(() => {
    return positionsWithLayer.filter((p) => {
      if (symbolFilter !== "all" && !p.symbol.toLowerCase().includes(symbolFilter.toLowerCase())) return false;
      if (sideFilter !== "all" && p.side !== sideFilter) return false;
      if (strategyFilter !== "all" && String(p.strategyId) !== strategyFilter) return false;
      if (p.layer < minLayerFilter || p.layer > maxLayerFilter) return false;
      return true;
    });
  }, [positionsWithLayer, symbolFilter, sideFilter, strategyFilter, minLayerFilter, maxLayerFilter]);

  // ─── Signal Query ──────────────────────────────────────────────
  const signalQueryInput = useMemo(
    () => ({
      status: signalStatusFilter === "all" ? undefined : (signalStatusFilter as any),
      source: signalSourceFilter === "all" ? undefined : (signalSourceFilter as any),
      strategyId: strategyFilter === "all" ? undefined : parseInt(strategyFilter),
      limit: signalPageSize,
      offset: signalPage * signalPageSize,
      startTime: dateStart ? new Date(dateStart) : undefined,
      endTime: dateEnd ? new Date(dateEnd) : undefined,
    }),
    [signalStatusFilter, signalSourceFilter, strategyFilter, signalPage, signalPageSize, dateStart, dateEnd],
  );

  const { data: signalData, isLoading: signalLoading } = trpc.signals.list.useQuery(
    signalQueryInput,
    { refetchInterval: 10000 },
  );

  // ─── Export CSV ────────────────────────────────────────────────
  const [exportPending, setExportPending] = useState(false);

  const handleExportCSV = async () => {
    const targetStrategyId = strategyFilter !== "all" ? parseInt(strategyFilter) : (strategies?.[0]?.id ?? 0);
    if (!targetStrategyId) {
      toast.error("請先選擇策略再匯出");
      return;
    }
    setExportPending(true);
    try {
      const result = await utils.client.strategies.exportData.query({
        strategyId: targetStrategyId,
        format: "csv",
        status: signalStatusFilter === "all" ? undefined : signalStatusFilter,
        source: signalSourceFilter === "all" ? undefined : signalSourceFilter,
        side: sideFilter === "all" ? undefined : sideFilter,
        startTime: dateStart ? new Date(dateStart) : undefined,
        endTime: dateEnd ? new Date(dateEnd) : undefined,
      });
      const csvContent = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `signals_export_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("CSV 匯出成功");
    } catch (e: any) {
      toast.error(`匯出失敗：${e?.message ?? "未知錯誤"}`);
    } finally {
      setExportPending(false);
    }
  };

  // P2-2: Export cycle report (CSV format with cycle pairing)
  const handleExportCycleReport = async () => {
    const targetStrategyId = strategyFilter !== "all" ? parseInt(strategyFilter) : (strategies?.[0]?.id ?? 0);
    if (!targetStrategyId) {
      toast.error("請先選擇策略再匯出");
      return;
    }
    setExportPending(true);
    try {
      const result = await utils.client.strategies.exportData.query({
        strategyId: targetStrategyId,
        format: "cycle_report",
        startTime: dateStart ? new Date(dateStart) : undefined,
        endTime: dateEnd ? new Date(dateEnd) : undefined,
      });
      const csvContent = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cycle_report_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("循環報告匯出成功");
    } catch (e: any) {
      toast.error(`匯出失敗：${e?.message ?? "未知錯誤"}`);
    } finally {
      setExportPending(false);
    }
  };

  // ─── P0-3: Position click → filter signals + open drawer ──────
  const handlePositionClick = useCallback((pos: any) => {
    const symbol = pos.symbol;
    setSelectedPositionSymbol((prev) => (prev === symbol ? null : symbol));
    setDrawerPosition((prev: any) => (prev?.symbol === symbol ? null : pos));
  }, []);

  // ─── Signal linkage: click signal → flash position ─────────────
  const handleSignalClick = useCallback((symbol: string) => {
    setFlashingSymbol(symbol);
    setTimeout(() => setFlashingSymbol(null), 2000);
  }, []);

  // ─── Unique symbols for filter ─────────────────────────────────
  const uniqueSymbols = useMemo(() => {
    const symbols = new Set(allPositions.map((p) => p.symbol));
    strategies?.forEach((s) => symbols.add(s.symbol));
    return Array.from(symbols).sort();
  }, [allPositions, strategies]);

  // ─── P2-3: Liquidation proximity toast ─────────────────────────
  const liquidationToastShown = useRef<Set<string>>(new Set());
  useEffect(() => {
    positionsWithLayer.forEach((p) => {
      if (p.liquidationPrice && p.markPrice > 0) {
        const distance = Math.abs((p.liquidationPrice - p.markPrice) / p.markPrice) * 100;
        if (distance < 3 && !liquidationToastShown.current.has(p.symbol)) {
          liquidationToastShown.current.add(p.symbol);
          toast.error(`🚨 ${p.symbol} 距離強平僅剩 ${distance.toFixed(1)}%！`, { duration: 15000 });
        } else if (distance >= 3) {
          liquidationToastShown.current.delete(p.symbol);
        }
      }
    });
  }, [positionsWithLayer]);

  // ─── Smart Alerts (P0-2 + Section 5) ──────────────────────────
  const smartAlerts = useMemo(() => {
    const alerts: Array<{ id: string; severity: "critical" | "danger" | "warning"; message: string; detail: string; actionLabel?: string; onAction?: () => void }> = [];

    // API disconnect alerts
    data?.accounts.forEach((a) => {
      if (a.error) {
        alerts.push({
          id: `api_${a.apiKeyId}`,
          severity: "critical",
          message: `⚠️ ${a.label}（${a.exchange}）策略下單通道已中斷！`,
          detail: a.error,
          actionLabel: "嘗試重連",
          onAction: () => { refetch(); toast.info("正在重新連線..."); },
        });
      }
    });

    // Liquidation proximity
    positionsWithLayer.forEach((p) => {
      if (p.liquidationPrice && p.markPrice > 0) {
        const distance = Math.abs((p.liquidationPrice - p.markPrice) / p.markPrice) * 100;
        if (distance < 3) {
          alerts.push({
            id: `liq_${p.symbol}`,
            severity: "critical",
            message: `🚨 ${p.symbol} 距離強平僅剩 ${distance.toFixed(1)}%！`,
            detail: `強平價: ${p.liquidationPrice.toFixed(1)}，當前標記價: ${p.markPrice.toFixed(1)}`,
            actionLabel: "平倉 50%",
            onAction: () => {
              if (p.strategyId && confirm(`確定對 ${p.symbol} 執行平倉？`)) {
                closeMutation.mutate({ id: p.strategyId });
              }
            },
          });
        }
      }
    });

    // Total drawdown > 5%
    if (totalEquity > 0 && totalUnrealized < 0) {
      const drawdownPct = Math.abs(totalUnrealized / totalEquity) * 100;
      if (drawdownPct > 5) {
        alerts.push({
          id: "drawdown_total",
          severity: "danger",
          message: `🔻 總浮虧 -${drawdownPct.toFixed(1)}%！建議減倉`,
          detail: `總浮虧金額: $${Math.abs(totalUnrealized).toFixed(2)} USDT`,
          actionLabel: "一鍵減倉 25%",
          onAction: handleEmergency,
        });
      }
    }

    return alerts;
  }, [data, positionsWithLayer, totalEquity, totalUnrealized]);

  // ─── Dismissed alerts ──────────────────────────────────────────
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const visibleAlerts = smartAlerts.filter((a) => !dismissedAlerts.has(a.id));

  return (
    <div className="space-y-3">
      {/* ═══ P0-1: Margin Usage Marquee (>90%) ═══ */}
      {marginUsagePercent >= 90 && (
        <div className="fixed top-0 left-0 right-0 z-[9999] bg-rose-600 text-white text-center py-2 font-bold text-base animate-pulse">
          🚨 保證金即將耗盡！立即減倉！（使用率 {marginUsagePercent.toFixed(0)}%）
        </div>
      )}

      {/* ═══ Header ═══ */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Zap className="h-5 w-5 text-sky-400" />
            實盤戰鬥中心
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            零思考決策 · 一鍵避險 · 數據可追溯
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1", isFetching && "animate-spin")} />
            刷新
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={emergencyMutation.isPending}
            title="對所有策略執行市價平倉並暫停全部策略（需二次確認）"
            onClick={handleEmergency}
          >
            {emergencyMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5 mr-1" />
            )}
            緊急全平倉
          </Button>
        </div>
      </div>

      {/* ═══ Block A: KPI + Margin Bar (P0-1) ═══ */}
      <BlockA_KPI
        totalEquity={totalEquity}
        totalUnrealized={totalUnrealized}
        todayRealizedPnl={data?.todayRealizedPnl ?? 0}
        todayTradeCount={data?.todayTradeCount ?? 0}
        enabledStrategyCount={data?.enabledStrategyCount ?? 0}
        strategyCount={data?.strategyCount ?? 0}
        marginUsagePercent={marginUsagePercent}
        isLoading={isLoading}
      />

      {/* ═══ Block A2: Performance Statistics Panel ═══ */}
      <BlockA2_Performance
        perfData={perfData}
        onBackfill={() => backfillMutation.mutate()}
        isBackfilling={backfillMutation.isPending}
      />

      {/* ═══ Block B: Exchange Accounts (P0-2) ═══ */}
      <BlockB_Exchanges
        accounts={data?.accounts}
        isLoading={isLoading}
        error={error}
        onRetry={() => refetch()}
      />

      {/* ═══ Smart Alert Panel (Section 5) ═══ */}
      <BlockAlerts
        alerts={visibleAlerts}
        onDismiss={(id) => setDismissedAlerts((prev) => new Set(prev).add(id))}
      />

      {/* ═══ Block C: Filter Bar (P2-1 included) ═══ */}
      <BlockC_Filter
        symbolFilter={symbolFilter}
        setSymbolFilter={setSymbolFilter}
        sideFilter={sideFilter}
        setSideFilter={setSideFilter}
        strategyFilter={strategyFilter}
        setStrategyFilter={(v) => { setStrategyFilter(v); setSignalPage(0); }}
        signalStatusFilter={signalStatusFilter}
        setSignalStatusFilter={(v) => { setSignalStatusFilter(v); setSignalPage(0); }}
        signalSourceFilter={signalSourceFilter}
        setSignalSourceFilter={(v) => { setSignalSourceFilter(v); setSignalPage(0); }}
        minLayerFilter={minLayerFilter}
        setMinLayerFilter={setMinLayerFilter}
        maxLayerFilter={maxLayerFilter}
        setMaxLayerFilter={setMaxLayerFilter}
        dateStart={dateStart}
        setDateStart={(v) => { setDateStart(v); setSignalPage(0); }}
        dateEnd={dateEnd}
        setDateEnd={(v) => { setDateEnd(v); setSignalPage(0); }}
        strategies={strategies ?? []}
        uniqueSymbols={uniqueSymbols}
        onExportCSV={handleExportCSV}
        onExportCycleReport={handleExportCycleReport}
        exportPending={exportPending}
        selectedPositionSymbol={selectedPositionSymbol}
        onClearPositionFilter={() => { setSelectedPositionSymbol(null); setDrawerPosition(null); }}
      />

      {/* ═══ Block D: Position Dashboard (P1-1, P1-2, P1-3, P2-3) ═══ */}
      <BlockD_Positions
        positions={filteredPositions}
        isLoading={isLoading}
        closeMutation={closeMutation}
        onPositionClick={handlePositionClick}
        selectedSymbol={selectedPositionSymbol}
        flashingSymbol={flashingSymbol}
      />

      {/* ═══ Block E: Signal Logs (P1-4, P1-5) ═══ */}
      <BlockE_Signals
        signalData={signalData}
        signalLoading={signalLoading}
        strategies={strategies ?? []}
        page={signalPage}
        setPage={setSignalPage}
        pageSize={signalPageSize}
        setPageSize={(v) => { setSignalPageSize(v); setSignalPage(0); }}
        selectedPositionSymbol={selectedPositionSymbol}
        onSignalClick={handleSignalClick}
      />

      {/* ═══ Risk Events (kept for safety) - with pagination ═══ */}
      <BlockF_RiskEvents />

      {/* ═══ P0-3: Position Detail Drawer ═══ */}
      {drawerPosition && (
        <PositionDrawer
          position={drawerPosition}
          strategies={strategies ?? []}
          onClose={() => setDrawerPosition(null)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SMART ALERT PANEL (Section 5)
// ═══════════════════════════════════════════════════════════════════
function BlockAlerts({
  alerts,
  onDismiss,
}: {
  alerts: Array<{ id: string; severity: string; message: string; detail: string; actionLabel?: string; onAction?: () => void }>;
  onDismiss: (id: string) => void;
}) {
  if (alerts.length === 0) {
    return (
      <div className="rounded-lg border border-border/50 bg-emerald-500/5 px-4 py-2.5 text-sm text-center text-muted-foreground">
        ✅ 目前無風險事件，可安心
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className={cn(
            "rounded-md border-l-4 px-4 py-2.5 flex items-center justify-between gap-3",
            alert.severity === "critical"
              ? "border-l-rose-500 bg-rose-500/8 animate-pulse"
              : "border-l-orange-500 bg-orange-500/5",
          )}
        >
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm">{alert.message}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{alert.detail}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {alert.actionLabel && (
              <Button
                variant="destructive"
                size="sm"
                className="h-7 text-xs px-3"
                onClick={alert.onAction}
              >
                {alert.actionLabel}
              </Button>
            )}
            <button
              onClick={() => onDismiss(alert.id)}
              className="text-muted-foreground hover:text-foreground p-1"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// BLOCK A: KPI Cards + Margin Bar (P0-1)
// ═══════════════════════════════════════════════════════════════════
function BlockA_KPI({
  totalEquity,
  totalUnrealized,
  todayRealizedPnl,
  todayTradeCount,
  enabledStrategyCount,
  strategyCount,
  marginUsagePercent,
  isLoading,
}: {
  totalEquity: number;
  totalUnrealized: number;
  todayRealizedPnl: number;
  todayTradeCount: number;
  enabledStrategyCount: number;
  strategyCount: number;
  marginUsagePercent: number;
  isLoading: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
        <StatCard
          title="總權益"
          icon={<Landmark className="h-4 w-4 text-sky-400" />}
          loading={isLoading}
          value={
            <span className="font-mono text-xl font-bold">
              ${totalEquity.toFixed(2)}
            </span>
          }
        />
        <StatCard
          title="總浮動盈虧"
          icon={<LineChart className="h-4 w-4 text-sky-400" />}
          loading={isLoading}
          value={<PnlValue value={totalUnrealized} className="text-xl font-bold" />}
        />
        {/* P0-1: Margin Usage Bar */}
        <StatCard
          title="保證金使用率"
          icon={<Activity className="h-4 w-4 text-sky-400" />}
          loading={isLoading}
          value={<MarginBar percent={marginUsagePercent} />}
        />
        <StatCard
          title="今日已實現"
          icon={<Wallet className="h-4 w-4 text-sky-400" />}
          loading={isLoading}
          value={<PnlValue value={todayRealizedPnl} className="font-bold" />}
          sub={`今日交易 ${todayTradeCount} 筆`}
        />
        <StatCard
          title="運行中策略"
          icon={<Settings2 className="h-4 w-4 text-sky-400" />}
          loading={isLoading}
          value={
            <span className="font-mono font-bold">
              {enabledStrategyCount}
              <span className="text-sm text-muted-foreground"> / {strategyCount}</span>
            </span>
          }
        />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// P0-1: MARGIN BAR COMPONENT
// ═══════════════════════════════════════════════════════════════════
function MarginBar({ percent }: { percent: number }) {
  let barColor = "bg-zinc-500";
  let textColor = "text-muted-foreground";
  let label = `${percent.toFixed(0)}%`;

  if (percent >= 90) {
    barColor = "bg-rose-500 animate-pulse";
    textColor = "text-rose-400";
    label = `🚨 ${percent.toFixed(0)}% 立即減倉！`;
  } else if (percent >= 80) {
    barColor = "bg-orange-500";
    textColor = "text-orange-400";
    label = `🔴 ${percent.toFixed(0)}% 禁止加倉`;
  } else if (percent >= 60) {
    barColor = "bg-amber-500";
    textColor = "text-amber-400";
    label = `⚠️ ${percent.toFixed(0)}% 注意彈藥`;
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className={cn("text-xs font-semibold", textColor)}>{label}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", barColor)}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// BLOCK A2: Performance Statistics Panel
// ═════════════════════════════════════════════════════════════════
type PerfItem = {
  strategyId: number;
  strategyName: string;
  symbol: string;
  exchange: string;
  enabled: boolean;
  tradeCount: number;
  closedTradeCount: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
};

function BlockA2_Performance({
  perfData,
  onBackfill,
  isBackfilling,
}: {
  perfData?: PerfItem[];
  onBackfill?: () => void;
  isBackfilling?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!perfData || perfData.length === 0) return null;

  const totalPnl = perfData.reduce((s, p) => s + p.totalPnl, 0);
  const totalClosed = perfData.reduce((s, p) => s + p.closedTradeCount, 0);
  const totalWins = perfData.reduce((s, p) => s + Math.round(p.winRate * p.closedTradeCount / 100), 0);
  const overallWinRate = totalClosed > 0 ? (totalWins / totalClosed) * 100 : 0;
  const maxDD = Math.max(...perfData.map((p) => p.maxDrawdown), 0);
  const totalTrades = perfData.reduce((s, p) => s + p.tradeCount, 0);

  return (
    <div className="space-y-2">
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="累計已實現 PnL"
          icon={<TrendingUp className="h-4 w-4 text-sky-400" />}
          value={<PnlValue value={totalPnl} className="text-xl font-bold" />}
          sub={`共 ${totalClosed} 筆平倉交易`}
        />
        <StatCard
          title="總勝率"
          icon={<Trophy className="h-4 w-4 text-amber-400" />}
          value={
            <span className={cn("text-xl font-bold font-mono", overallWinRate >= 50 ? "text-emerald-400" : "text-rose-400")}>
              {overallWinRate.toFixed(1)}%
            </span>
          }
          sub={`${totalWins} 勝 / ${totalClosed - totalWins} 負`}
        />
        <StatCard
          title="最大回撤"
          icon={<Target className="h-4 w-4 text-rose-400" />}
          value={
            <span className="text-xl font-bold font-mono text-rose-400">
              ${maxDD.toFixed(2)}
            </span>
          }
          sub="基於累計盈虧曲線"
        />
        <StatCard
          title="總交易筆數"
          icon={<BarChart3 className="h-4 w-4 text-sky-400" />}
          value={
            <span className="text-xl font-bold font-mono">
              {totalTrades}
            </span>
          }
          sub={`${perfData.filter(p => p.enabled).length} 條策略運行中`}
        />
      </div>

      {/* Actions row */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          各策略績效明細
        </button>
        {onBackfill && (
          <button
            onClick={onBackfill}
            disabled={isBackfilling}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
          >
            {isBackfilling ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Database className="h-3 w-3" />
            )}
            {isBackfilling ? "回填中..." : "回填歷史 PnL"}
          </button>
        )}
      </div>

      {expanded && (
        <div className="rounded-lg border border-border bg-card/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">策略</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">幣種</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">平倉數</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">勝率</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">累計 PnL</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">最大回撤</th>
              </tr>
            </thead>
            <tbody>
              {perfData.map((p) => (
                <tr key={p.strategyId} className="border-b border-border/50 hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <span className={cn("h-2 w-2 rounded-full", p.enabled ? "bg-emerald-400" : "bg-zinc-500")} />
                      <span className="truncate max-w-[200px]">{p.strategyName}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{p.symbol}</td>
                  <td className="px-3 py-2 text-right font-mono">{p.closedTradeCount}</td>
                  <td className="px-3 py-2 text-right">
                    <span className={cn("font-mono", p.winRate >= 50 ? "text-emerald-400" : "text-rose-400")}>
                      {p.closedTradeCount > 0 ? `${p.winRate.toFixed(1)}%` : "-"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <PnlValue value={p.totalPnl} className="font-mono text-sm" />
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-rose-400">
                    {p.maxDrawdown > 0 ? `$${p.maxDrawdown.toFixed(2)}` : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// BLOCK B: Exchange Accounts (P0-2)
// ═════════════════════════════════════════════════════════════════
function BlockB_Exchanges({
  accounts,
  isLoading,
  error,
  onRetry,
}: {
  accounts: any[] | undefined;
  isLoading: boolean;
  error: any;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          🔌 交易所狀態
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : error ? (
          <p className="text-sm text-destructive">載入失敗：{error.message}</p>
        ) : !accounts || accounts.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            尚未設定交易所 API 金鑰。請先前往
            <Link href="/api-keys" className="text-primary hover:underline mx-1">
              API 設定
            </Link>
            新增金鑰。
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {accounts.map((a: any) => (
              <div
                key={a.apiKeyId}
                className={cn(
                  "rounded-lg border p-4 space-y-2 relative overflow-hidden",
                  a.error
                    ? "border-rose-500/60 bg-rose-500/5 animate-[shake_0.5s_ease-in-out_infinite]"
                    : "border-border bg-secondary/30",
                )}
              >
                {/* P0-2: Error Overlay */}
                {a.error && (
                  <div className="absolute inset-0 bg-rose-500/15 flex flex-col items-center justify-center z-10 backdrop-blur-[1px]">
                    <p className="text-lg font-bold text-rose-400">⚠️ 連線中斷！</p>
                    <p className="text-xs text-rose-300 mt-1">策略失效！</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 h-7 text-xs border-rose-500/60 text-rose-400 hover:bg-rose-500/10"
                      onClick={onRetry}
                    >
                      [嘗試重連]
                    </Button>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={cn("h-2 w-2 rounded-full", a.error ? "bg-rose-500 animate-pulse" : "bg-emerald-500")} />
                    <span className="font-medium text-sm">{a.label}</span>
                    <ExchangeBadge exchange={a.exchange} />
                    {a.isTestnet && (
                      <Badge variant="outline" className="text-[10px] border-violet-500/40 text-violet-400">
                        🧪 測試網
                      </Badge>
                    )}
                  </div>
                </div>
                {!a.error && a.balance ? (
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">總權益</p>
                      <p className="font-mono font-semibold">${a.balance.total.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">可用</p>
                      <p className="font-mono font-semibold">${a.balance.free.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">未實現盈虧</p>
                      <PnlValue value={a.balance.unrealizedPnl} suffix="" className="font-semibold" />
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════
// BLOCK C: Filter Bar (P2-1: Layer Range + Date)
// ═══════════════════════════════════════════════════════════════════
function BlockC_Filter({
  symbolFilter,
  setSymbolFilter,
  sideFilter,
  setSideFilter,
  strategyFilter,
  setStrategyFilter,
  signalStatusFilter,
  setSignalStatusFilter,
  signalSourceFilter,
  setSignalSourceFilter,
  minLayerFilter,
  setMinLayerFilter,
  maxLayerFilter,
  setMaxLayerFilter,
  dateStart,
  setDateStart,
  dateEnd,
  setDateEnd,
  strategies,
  uniqueSymbols,
  onExportCSV,
  onExportCycleReport,
  exportPending,
  selectedPositionSymbol,
  onClearPositionFilter,
}: {
  symbolFilter: string;
  setSymbolFilter: (v: string) => void;
  sideFilter: string;
  setSideFilter: (v: string) => void;
  strategyFilter: string;
  setStrategyFilter: (v: string) => void;
  signalStatusFilter: string;
  setSignalStatusFilter: (v: string) => void;
  signalSourceFilter: string;
  setSignalSourceFilter: (v: string) => void;
  minLayerFilter: number;
  setMinLayerFilter: (v: number) => void;
  maxLayerFilter: number;
  setMaxLayerFilter: (v: number) => void;
  dateStart: string;
  setDateStart: (v: string) => void;
  dateEnd: string;
  setDateEnd: (v: string) => void;
  strategies: any[];
  uniqueSymbols: string[];
  onExportCSV: () => void;
  onExportCycleReport: () => void;
  exportPending: boolean;
  selectedPositionSymbol: string | null;
  onClearPositionFilter: () => void;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Symbol */}
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">幣種</Label>
            <Select value={symbolFilter} onValueChange={setSymbolFilter}>
              <SelectTrigger className="w-36 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                {uniqueSymbols.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Side */}
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">方向</Label>
            <Select value={sideFilter} onValueChange={setSideFilter}>
              <SelectTrigger className="w-24 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="long">▲ 多</SelectItem>
                <SelectItem value="short">▼ 空</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Strategy */}
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">策略</Label>
            <Select value={strategyFilter} onValueChange={setStrategyFilter}>
              <SelectTrigger className="w-40 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部策略</SelectItem>
                {strategies.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Signal Status */}
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">訊號狀態</Label>
            <Select value={signalStatusFilter} onValueChange={setSignalStatusFilter}>
              <SelectTrigger className="w-28 h-8 text-xs">
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

          {/* Signal Source */}
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">來源</Label>
            <Select value={signalSourceFilter} onValueChange={setSignalSourceFilter}>
              <SelectTrigger className="w-28 h-8 text-xs">
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

          {/* P2-1: Layer Range */}
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">層級</Label>
            <input
              type="number"
              min={0}
              max={20}
              value={minLayerFilter}
              onChange={(e) => setMinLayerFilter(Number(e.target.value))}
              className="w-12 h-8 text-xs rounded-md border border-border bg-background px-2 text-center"
            />
            <span className="text-xs text-muted-foreground">~</span>
            <input
              type="number"
              min={0}
              max={20}
              value={maxLayerFilter}
              onChange={(e) => setMaxLayerFilter(Number(e.target.value))}
              className="w-12 h-8 text-xs rounded-md border border-border bg-background px-2 text-center"
            />
          </div>

          {/* Issue 4: Date Range Filter */}
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">日期</Label>
            <input
              type="datetime-local"
              value={dateStart}
              onChange={(e) => setDateStart(e.target.value)}
              className="h-8 text-xs rounded-md border border-border bg-background px-2"
            />
            <span className="text-xs text-muted-foreground">至</span>
            <input
              type="datetime-local"
              value={dateEnd}
              onChange={(e) => setDateEnd(e.target.value)}
              className="h-8 text-xs rounded-md border border-border bg-background px-2"
            />
            {(dateStart || dateEnd) && (
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => { setDateStart(""); setDateEnd(""); }}
                title="清除日期篩選"
              >
                ✕
              </button>
            )}
          </div>

          {/* Position filter indicator */}
          {selectedPositionSymbol && (
            <Badge
              variant="outline"
              className="text-xs border-sky-500/40 text-sky-400 cursor-pointer hover:bg-sky-500/10"
              onClick={onClearPositionFilter}
            >
              篩選：{selectedPositionSymbol} ✕
            </Badge>
          )}

          {/* Export buttons */}
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs border-sky-500/40 text-sky-400 hover:bg-sky-500/10"
              disabled={exportPending}
              onClick={onExportCSV}
            >
              {exportPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5 mr-1" />
              )}
              📥 CSV
            </Button>
            {/* P2-2: Cycle Report Export */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
              disabled={exportPending}
              onClick={onExportCycleReport}
            >
              📊 循環報告
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════
// BLOCK D: Position Dashboard (P1-1, P1-2, P1-3, P2-3)
// ═══════════════════════════════════════════════════════════════════
function BlockD_Positions({
  positions,
  isLoading,
  closeMutation,
  onPositionClick,
  selectedSymbol,
  flashingSymbol,
}: {
  positions: any[];
  isLoading: boolean;
  closeMutation: any;
  onPositionClick: (pos: any) => void;
  selectedSymbol: string | null;
  flashingSymbol: string | null;
}) {
  // Summary calculations
  const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const avgLayer = positions.length > 0
    ? positions.reduce((sum, p) => sum + p.layer, 0) / positions.length
    : 0;
  const maxRiskPos = positions.length > 0
    ? positions.reduce((worst, p) => (p.unrealizedPnl < worst.unrealizedPnl ? p : worst), positions[0])
    : null;

  // P1-3: Close confirmation state
  const [confirmClose, setConfirmClose] = useState<{ strategyId: number; symbol: string; pct: number } | null>(null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          📈 當前持倉
          <span className="text-xs text-muted-foreground font-normal">（點擊任一行 → 日誌自動過濾 + 右側抽屜詳情）</span>
          {positions.length > 0 && (
            <Badge variant="secondary" className="text-[10px] ml-1">{positions.length}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="py-8 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : positions.length === 0 ? (
          <div className="py-10 text-center space-y-2">
            <Activity className="h-8 w-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">📭 目前無持倉</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="pb-2 pr-3 font-medium">幣種</th>
                    <th className="pb-2 pr-3 font-medium">方向</th>
                    <th className="pb-2 pr-3 font-medium">層級</th>
                    <th className="pb-2 pr-3 font-medium text-right">數量</th>
                    <th className="pb-2 pr-3 font-medium text-right">入場均價</th>
                    <th className="pb-2 pr-3 font-medium text-right">標記價</th>
                    <th className="pb-2 pr-3 font-medium text-right">槓桿</th>
                    <th className="pb-2 pr-3 font-medium text-right">浮動盈虧</th>
                    <th className="pb-2 pr-3 font-medium">📊 浮動%</th>
                    <th className="pb-2 pr-3 font-medium text-right">🔴 強平價</th>
                    <th className="pb-2 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => {
                    const pnlPct = typeof p.unrealizedPnlRatioPct === "number"
                      ? p.unrealizedPnlRatioPct
                      : p.positionMargin > 0
                        ? (p.unrealizedPnl / p.positionMargin) * 100
                        : null;
                    const liqDistance = p.liquidationPrice && p.markPrice > 0
                      ? Math.abs((p.liquidationPrice - p.markPrice) / p.markPrice) * 100
                      : null;
                    const isFlashing = flashingSymbol === p.symbol;
                    const isSelected = selectedSymbol === p.symbol;
                    const isCloseToLiquidation = liqDistance !== null && liqDistance < 3;

                    return (
                      <tr
                        key={i}
                        className={cn(
                          "border-b border-border/50 last:border-0 cursor-pointer transition-all",
                          isSelected && "bg-sky-500/10",
                          isFlashing && "animate-pulse bg-amber-500/20",
                          isCloseToLiquidation && "ring-2 ring-rose-500 ring-inset animate-pulse",
                        )}
                        onClick={() => onPositionClick(p)}
                      >
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-xs">{p.symbol}</span>
                            <ExchangeBadge exchange={p.exchange} />
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px] text-muted-foreground">
                            <span>交易所持倉</span>
                            <span>·</span>
                            <span>{p.updatedAt ? `同步 ${new Date(p.updatedAt).toLocaleTimeString("zh-TW", { hour12: false })}` : "同步時間未提供"}</span>
                            {p.positionAttribution === "exact" ? (
                              <Badge variant="outline" className="h-4 border-emerald-500/40 px-1 text-[8px] text-emerald-400">精確歸屬</Badge>
                            ) : p.positionAttribution === "account_aggregate" ? (
                              <Badge variant="outline" className="h-4 border-amber-500/40 px-1 text-[8px] text-amber-300">帳戶合併</Badge>
                            ) : (
                              <Badge variant="outline" className="h-4 border-slate-500/40 px-1 text-[8px] text-slate-400">未歸屬</Badge>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3"><SideBadge side={p.side} /></td>
                        {/* P1-2: Layer Badge with color coding */}
                        <td className="py-2.5 pr-3">
                          {p.positionAttribution === "exact" ? <LayerBadge layer={p.layer} /> : <span className="text-[10px] text-muted-foreground">共享／未知</span>}
                        </td>
                        <td className="py-2.5 pr-3 text-right font-mono text-xs">{formatSize(p.size)}</td>
                        <td className="py-2.5 pr-3 text-right font-mono text-xs">{formatPrice(p.entryPrice)}</td>
                        <td className="py-2.5 pr-3 text-right font-mono text-xs">{formatPrice(p.markPrice)}</td>
                        <td className="py-2.5 pr-3 text-right font-mono text-xs">{p.leverage}x</td>
                        <td className="py-2.5 pr-3 text-right">
                          <PnlValue value={p.unrealizedPnl} suffix="" className="font-bold text-xs" />
                        </td>
                        {/* P1-1: PnL Progress Bar */}
                        <td className="py-2.5 pr-3">
                          {pnlPct !== null ? <PnlProgressBar pct={pnlPct} usdt={p.unrealizedPnl} /> : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                        {/* P2-3: Liquidation with distance */}
                        <td className="py-2.5 pr-3 text-right">
                          <LiquidationCell price={p.liquidationPrice} distance={liqDistance} />
                        </td>
                        {/* P1-3: Close buttons [25%] [50%] [100%] */}
                        <td className="py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                          {p.strategyId ? (
                            <CloseButtons
                              strategyId={p.strategyId}
                              symbol={p.symbol}
                              closeMutation={closeMutation}
                              onConfirm={setConfirmClose}
                            />
                          ) : (
                            <span
                              className="text-[10px] text-muted-foreground"
                              title={p.positionAttribution === "account_aggregate" ? "合併倉位不可由單一策略平倉，請先確認共享策略歸屬" : "此交易所持倉未能安全歸屬到策略"}
                            >
                              {p.positionAttribution === "account_aggregate" ? "合併倉位" : "—"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Summary Row */}
            <div className="mt-3 pt-3 border-t border-border/50 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              <span>
                📊 總浮動盈虧：<PnlValue value={totalPnl} suffix=" USDT" className="text-xs font-bold" />
              </span>
              <span>來源：交易所帳戶持倉毛浮盈虧；費用與資金費以交易所帳單為準</span>
              {avgLayer > 0 && (
                <span>平均層級：<span className="font-medium text-foreground">Lv.{avgLayer.toFixed(1)}</span></span>
              )}
              {maxRiskPos && maxRiskPos.unrealizedPnl < 0 && (
                <span>
                  最大風險：<span className="text-rose-400 font-semibold">{maxRiskPos.symbol} {maxRiskPos.unrealizedPnl.toFixed(2)}</span>
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>

      {/* P1-3: Confirmation Dialog */}
      {confirmClose && (
        <div className="fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center" onClick={() => setConfirmClose(null)}>
          <div className="bg-card border border-border rounded-xl p-6 max-w-sm text-center space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-rose-400">⚠️ 確認平倉</h3>
            <p className="text-sm text-muted-foreground">
              確定要對 <strong className="text-foreground">{confirmClose.symbol}</strong> 執行{" "}
              <strong className="text-rose-400">{confirmClose.pct}%</strong> 平倉？
              {confirmClose.pct === 100 && <><br /><span className="text-xs">此操作不可撤銷</span></>}
            </p>
            <div className="flex gap-3 justify-center">
              <Button variant="outline" size="sm" onClick={() => setConfirmClose(null)}>取消</Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={closeMutation.isPending}
                onClick={() => {
                  closeMutation.mutate({ id: confirmClose.strategyId });
                  setConfirmClose(null);
                }}
              >
                {closeMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                確認平倉
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════
// P1-3: CLOSE BUTTONS [25%] [50%] [100%]
// ═══════════════════════════════════════════════════════════════════
function CloseButtons({
  strategyId,
  symbol,
  closeMutation,
  onConfirm,
}: {
  strategyId: number;
  symbol: string;
  closeMutation: any;
  onConfirm: (v: { strategyId: number; symbol: string; pct: number }) => void;
}) {
  return (
    <div className="flex items-center gap-1 justify-end">
      <button
        className="px-1.5 py-0.5 text-[10px] rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-50"
        disabled={closeMutation.isPending}
        onClick={() => onConfirm({ strategyId, symbol, pct: 25 })}
        title="平倉 25%"
      >
        25%
      </button>
      <button
        className="px-1.5 py-0.5 text-[10px] rounded border border-amber-500/60 text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
        disabled={closeMutation.isPending}
        onClick={() => onConfirm({ strategyId, symbol, pct: 50 })}
        title="平倉 50%"
      >
        50%
      </button>
      <button
        className="px-1.5 py-0.5 text-[10px] rounded border-2 border-rose-500/60 text-rose-400 font-bold hover:bg-rose-500/10 transition-colors disabled:opacity-50"
        disabled={closeMutation.isPending}
        onClick={() => onConfirm({ strategyId, symbol, pct: 100 })}
        title="全平（需確認）"
      >
        100%
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// BLOCK E: Signal Logs (P1-4: Cycle Grouping, P1-5: Message Compression)
// ═══════════════════════════════════════════════════════════════════
function BlockE_Signals({
  signalData,
  signalLoading,
  strategies,
  page,
  setPage,
  pageSize,
  setPageSize,
  selectedPositionSymbol,
  onSignalClick,
}: {
  signalData: any;
  signalLoading: boolean;
  strategies: any[];
  page: number;
  setPage: (p: number) => void;
  pageSize: number;
  setPageSize: (v: number) => void;
  selectedPositionSymbol: string | null;
  onSignalClick: (symbol: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const strategyName = (id: number | null) => {
    if (!id) return "—";
    return strategies.find((s) => s.id === id)?.name ?? `#${id}`;
  };

  // Filter signals by selected position symbol if active
  const filteredItems = useMemo(() => {
    if (!signalData?.items) return [];
    if (!selectedPositionSymbol) return signalData.items;
    return signalData.items.filter((sig: any) =>
      sig.parsedSymbol?.includes(selectedPositionSymbol.split("-")[0]) ||
      sig.parsedSymbol === selectedPositionSymbol
    );
  }, [signalData, selectedPositionSymbol]);

  const totalPages = signalData ? Math.max(1, Math.ceil(signalData.total / pageSize)) : 1;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between">
          <span className="flex items-center gap-2">
            📜 訊號日誌
            <span className="text-xs text-muted-foreground font-normal">（人類語言壓縮 · 技術明細折疊）</span>
            {signalData && (
              <Badge variant="secondary" className="text-[10px]">共 {signalData.total} 筆</Badge>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {signalLoading ? (
          <div className="py-8 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filteredItems.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            📭 尚無訊號記錄
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="pb-2 pr-2 font-medium w-6"></th>
                    <th className="pb-2 pr-3 font-medium">時間</th>
                    <th className="pb-2 pr-3 font-medium">策略</th>
                    <th className="pb-2 pr-3 font-medium">來源</th>
                    <th className="pb-2 pr-3 font-medium">動作</th>
                    <th className="pb-2 pr-3 font-medium">交易對</th>
                    <th className="pb-2 pr-3 font-medium text-right">價格</th>
                    <th className="pb-2 pr-3 font-medium">狀態</th>
                    <th className="pb-2 pr-3 font-medium text-right">盈虧</th>
                    <th className="pb-2 font-medium">訊息</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((sig: any) => (
                    <Fragment key={sig.id}>
                      <tr
                        className="border-b border-border/50 last:border-0 cursor-pointer hover:bg-secondary/30 transition-colors"
                        onClick={() => {
                          setExpandedId(expandedId === sig.id ? null : sig.id);
                          if (sig.parsedSymbol) onSignalClick(sig.parsedSymbol);
                        }}
                      >
                        <td className="py-2 pr-2">
                          <ChevronDown
                            className={cn(
                              "h-3.5 w-3.5 text-muted-foreground transition-transform",
                              expandedId === sig.id && "rotate-180",
                            )}
                          />
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground whitespace-nowrap">
                          {formatTime(sig.createdAt)}
                        </td>
                        <td className="py-2 pr-3 text-xs">{strategyName(sig.strategyId)}</td>
                        <td className="py-2 pr-3"><SourceBadge source={(sig as any).source} /></td>
                        <td className="py-2 pr-3 text-xs">
                          <ActionBadge action={sig.parsedAction} />
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">{sig.parsedSymbol ?? "—"}</td>
                        <td className="py-2 pr-3 text-right font-mono text-xs">{sig.parsedPrice ?? "—"}</td>
                        <td className="py-2 pr-3"><SignalStatusBadge status={sig.status} /></td>
                        {/* Issue 5: PnL column */}
                        <td className="py-2 pr-3 text-right font-mono text-xs">
                          {sig.realizedPnl && parseFloat(sig.realizedPnl) !== 0 ? (
                            <PnlValue value={parseFloat(sig.realizedPnl)} suffix=" U" className="text-xs font-semibold" />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        {/* P1-5: Compressed message */}
                        <td className="py-2 text-xs text-muted-foreground max-w-60">
                          <div className="whitespace-pre-wrap break-words line-clamp-2">
                            {compressMessage(sig.message ?? "—")}
                          </div>
                        </td>
                      </tr>
                      {/* Expanded detail (tech details folded by default) */}
                      {expandedId === sig.id && (
                        <tr className="border-b border-border/50">
                          <td colSpan={10} className="py-3 px-4 bg-secondary/20">
                            <div className="space-y-3 text-xs">
                              <div>
                                <p className="text-muted-foreground mb-1 font-medium">▶ 技術明細</p>
                                <pre className="rounded-md bg-background border p-2.5 overflow-x-auto font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                                  {formatJson(sig.rawPayload)}
                                </pre>
                              </div>
                              {sig.exchangeResponse && (
                                <div>
                                  <p className="text-muted-foreground mb-1 font-medium">交易所回應</p>
                                  <pre className="rounded-md bg-background border p-2.5 overflow-x-auto font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                                    {formatJson(sig.exchangeResponse)}
                                  </pre>
                                </div>
                              )}
                              <div className="flex gap-6 text-muted-foreground">
                                {sig.orderId && <span>訂單 ID：{sig.orderId}</span>}
                                {sig.latencyMs !== null && <span>處理耗時：{sig.latencyMs}ms</span>}
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

            {/* Pagination + Page Size Selector */}
            <div className="flex items-center justify-between mt-4">
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  第 {page + 1} / {totalPages} 頁（共 {signalData?.total ?? 0} 筆）
                </span>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">每頁</Label>
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="h-7 text-xs rounded-md border border-border bg-background px-2"
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                  <span className="text-xs text-muted-foreground">條</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={page === 0}
                  onClick={() => setPage(Math.max(0, page - 1))}
                >
                  上一頁
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage(page + 1)}
                >
                  下一頁
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ═════════════════════════════════════════════════════════════════
// BLOCK F: Risk Events (Issue 6: with pagination)
// ═════════════════════════════════════════════════════════════════
function BlockF_RiskEvents() {
  const [riskPage, setRiskPage] = useState(0);
  const [riskPageSize, setRiskPageSize] = useState(10);

  const { data: riskEvents } = trpc.dashboard.riskEvents.useQuery(
    { limit: riskPageSize, offset: riskPage * riskPageSize },
    { refetchInterval: 30000 },
  );

  if (!riskEvents || riskEvents.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          近期風險事件
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {riskEvents.map((e: any) => (
            <div
              key={e.id}
              className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <span className="font-medium">
                  {e.eventType === "stop_loss" ? "止損觸發" : e.eventType === "take_profit" ? "止盈觸發" : e.eventType === "daily_loss_limit" ? "每日虧損上限" : "倉位限制"}
                </span>
                <p className="text-xs text-muted-foreground mt-0.5">{e.detail}</p>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">{formatTime(e.createdAt)}</span>
            </div>
          ))}
        </div>
        {/* Pagination */}
        <div className="flex items-center justify-between mt-4">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              第 {riskPage + 1} 頁
            </span>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">每頁</Label>
              <select
                value={riskPageSize}
                onChange={(e) => { setRiskPageSize(Number(e.target.value)); setRiskPage(0); }}
                className="h-7 text-xs rounded-md border border-border bg-background px-2"
              >
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
              <span className="text-xs text-muted-foreground">條</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={riskPage === 0}
              onClick={() => setRiskPage(Math.max(0, riskPage - 1))}
            >
              上一頁
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={riskEvents.length < riskPageSize}
              onClick={() => setRiskPage(riskPage + 1)}
            >
              下一頁
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ═════════════════════════════════════════════════════════════════
// P0-3: POSITION DETAIL DRAWER
// ═════════════════════════════════════════════════════════════════
function PositionDrawer({
  position,
  strategies,
  onClose,
}: {
  position: any;
  strategies: any[];
  onClose: () => void;
}) {
  const matchedStrategy = position.strategyId
    ? strategies.find((strategy) => strategy.id === position.strategyId)
    : undefined;
  const martinState = (matchedStrategy?.martinState ?? {}) as any;
  const nativePnlPct = typeof position.unrealizedPnlRatioPct === "number"
    ? position.unrealizedPnlRatioPct
    : position.positionMargin > 0
      ? (position.unrealizedPnl / position.positionMargin) * 100
      : null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[9998] bg-black/50" onClick={onClose} />
      {/* Drawer */}
      <div className="fixed top-0 right-0 bottom-0 w-[420px] max-w-[90vw] z-[9999] bg-card border-l border-border shadow-2xl overflow-y-auto animate-in slide-in-from-right duration-300">
        <div className="p-5 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold flex items-center gap-2">
              📋 持倉詳情
            </h3>
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Position Info */}
          <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold">{position.symbol}</span>
              <SideBadge side={position.side} />
              <ExchangeBadge exchange={position.exchange} />
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">入場均價</p>
                <p className="font-mono font-semibold">{formatPrice(position.entryPrice)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">標記價</p>
                <p className="font-mono font-semibold">{formatPrice(position.markPrice)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">數量</p>
                <p className="font-mono font-semibold">{formatSize(position.size)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">槓桿</p>
                <p className="font-mono font-semibold">{position.leverage}x</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">浮動盈虧</p>
                <PnlValue value={position.unrealizedPnl} suffix=" USDT" className="font-bold" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">交易所浮動盈虧率</p>
                <p className={cn("font-mono font-semibold", nativePnlPct !== null && nativePnlPct >= 0 ? "text-emerald-400" : "text-rose-400")}>
                  {nativePnlPct !== null ? `${nativePnlPct >= 0 ? "+" : ""}${nativePnlPct.toFixed(2)}%` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">持倉保證金</p>
                <p className="font-mono font-semibold">{position.positionMargin ? `${position.positionMargin.toFixed(4)} USDT` : "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">強平價</p>
                <p className="font-mono font-semibold">{position.liquidationPrice ? formatPrice(position.liquidationPrice) : "—"}</p>
              </div>
            </div>
          </div>

          <div className={cn(
            "rounded-lg border p-3 text-xs",
            position.positionAttribution === "exact"
              ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200"
              : position.positionAttribution === "account_aggregate"
                ? "border-amber-500/30 bg-amber-500/5 text-amber-200"
                : "border-slate-500/30 bg-slate-500/5 text-slate-300",
          )}>
            <p className="font-semibold">
              {position.positionAttribution === "exact"
                ? "交易所持倉 · 精確歸屬"
                : position.positionAttribution === "account_aggregate"
                  ? "交易所帳戶合併倉位 · 不可安全歸屬單一策略"
                  : "交易所持倉 · 未歸屬策略"}
            </p>
            <p className="mt-1 opacity-80">
              {position.updatedAt ? `交易所更新：${new Date(position.updatedAt).toLocaleString("zh-TW")}` : "交易所未提供更新時間"}。上述為持倉毛浮盈虧，費用與資金費以交易所帳單為準。
            </p>
            {position.relatedStrategyNames?.length > 0 && position.positionAttribution !== "exact" && (
              <p className="mt-1 opacity-80">相關策略：{position.relatedStrategyNames.join("、")}</p>
            )}
          </div>

          {/* Strategy Info */}
          {matchedStrategy && (
            <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2">
              <h4 className="text-sm font-semibold">策略資訊</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">策略名稱</p>
                  <p className="font-medium">{matchedStrategy.name}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">當前層級</p>
                  <LayerBadge layer={Number(martinState.currentLayer) || 0} />
                </div>
                {martinState.entryPrice && (
                  <div>
                    <p className="text-xs text-muted-foreground">首單入場價</p>
                    <p className="font-mono">{Number(martinState.entryPrice).toFixed(2)}</p>
                  </div>
                )}
                {martinState.totalSize && (
                  <div>
                    <p className="text-xs text-muted-foreground">總持倉量</p>
                    <p className="font-mono">{Number(martinState.totalSize).toFixed(6)}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Account Info */}
          <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2">
            <h4 className="text-sm font-semibold">帳戶資訊</h4>
            <div className="text-sm space-y-1">
              <p><span className="text-muted-foreground">帳戶：</span>{position.account}</p>
              <p><span className="text-muted-foreground">交易所：</span>{position.exchange}</p>
              {position.isTestnet && <Badge variant="outline" className="text-[10px] border-violet-500/40 text-violet-400">🧪 測試網</Badge>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════

/** P1-2: Layer Badge with military-grade color coding */
function LayerBadge({ layer }: { layer: number }) {
  if (layer <= 0) return <span className="text-xs text-muted-foreground">—</span>;

  let className = "";
  if (layer >= 10) {
    className = "border-rose-500 bg-black text-rose-400 font-bold animate-[blink_0.3s_ease-in-out_infinite]";
  } else if (layer >= 8) {
    className = "border-rose-500/60 bg-rose-500/20 text-rose-400 font-bold animate-pulse";
  } else if (layer >= 5) {
    className = "border-orange-500/60 bg-orange-500/15 text-orange-400 font-bold";
  } else if (layer >= 3) {
    className = "border-blue-500/60 bg-blue-500/10 text-blue-400";
  } else {
    className = "border-emerald-500/60 bg-emerald-500/10 text-emerald-400";
  }

  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] font-mono px-1.5", className)}
    >
      Lv.{layer}
    </Badge>
  );
}

/** P1-1: PnL Progress Bar (red left / blue-green right) */
function PnlProgressBar({ pct, usdt }: { pct: number; usdt: number }) {
  const maxDisplay = 10;
  const clamped = Math.max(-maxDisplay, Math.min(maxDisplay, pct));
  const width = Math.min(100, (Math.abs(clamped) / maxDisplay) * 100);
  const isPositive = pct >= 0;
  const barColor = isPositive ? "bg-sky-500" : "bg-rose-500";
  const textColor = isPositive ? "text-sky-400" : "text-rose-400";

  return (
    <div className="flex items-center gap-1.5 min-w-[120px]">
      <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden relative">
        {/* Center line */}
        <div className="absolute left-1/2 top-0 w-px h-full bg-muted-foreground/30" />
        <div
          className={cn("h-full rounded-full transition-all duration-500", barColor)}
          style={{
            width: `${Math.max(width / 2, 1)}%`,
            marginLeft: isPositive ? "50%" : `${50 - width / 2}%`,
          }}
        />
      </div>
      <span className={cn("text-[10px] font-mono min-w-[65px] text-right font-semibold", textColor)}>
        {isPositive ? "+" : ""}{pct.toFixed(1)}%
        <span className="text-muted-foreground ml-0.5">
          {isPositive ? "+" : ""}{usdt.toFixed(2)}
        </span>
      </span>
    </div>
  );
}

/** P2-3: Liquidation Price Cell */
function LiquidationCell({ price, distance }: { price?: number | null; distance: number | null }) {
  if (!price) return <span className="text-xs text-muted-foreground">—</span>;
  const isClose = distance !== null && distance < 3;
  const isWarning = distance !== null && distance < 5;
  return (
    <div className={cn(
      "text-xs font-mono",
      isClose ? "text-rose-400 font-bold animate-pulse" : isWarning ? "text-amber-400" : "text-muted-foreground",
    )}>
      {formatPrice(price)}
      {distance !== null && (
        <span className="ml-1">({distance.toFixed(1)}%)</span>
      )}
    </div>
  );
}

/** Action Badge */
function ActionBadge({ action }: { action?: string | null }) {
  if (!action) return <span className="text-muted-foreground">—</span>;
  const config: Record<string, { label: string; className: string }> = {
    buy: { label: "🟢 買入", className: "text-sky-400" },
    sell: { label: "🔴 賣出", className: "text-rose-400" },
    close: { label: "⬜ 平倉", className: "text-amber-400" },
  };
  const c = config[action] || { label: action, className: "text-muted-foreground" };
  return <span className={cn("text-xs font-medium", c.className)}>{c.label}</span>;
}

/** Source Badge */
function SourceBadge({ source }: { source?: string | null }) {
  if (!source) return <span className="text-muted-foreground text-xs">—</span>;
  const config: Record<string, { label: string; className: string }> = {
    webhook: { label: "Webhook", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
    auto: { label: "自動交易", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
    manual: { label: "手動觸發", className: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  };
  const c = config[source] || { label: source, className: "bg-secondary text-secondary-foreground" };
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-medium ${c.className}`}>
      {c.label}
    </Badge>
  );
}

/** Stat Card */
function StatCard({
  title,
  icon,
  value,
  sub,
  loading,
}: {
  title: string;
  icon: React.ReactNode;
  value: React.ReactNode;
  sub?: string;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] text-muted-foreground uppercase tracking-wider">{title}</span>
          {icon}
        </div>
        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <div className="text-lg font-semibold">{value}</div>
        )}
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

function formatSize(size: number): string {
  if (size >= 1) return size.toFixed(4);
  if (size >= 0.01) return size.toFixed(6);
  return size.toFixed(8);
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(1);
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

function formatJson(raw: string | null): string {
  if (!raw) return "—";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** P1-5: Message compression - human language first */
function compressMessage(original: string): string {
  if (!original || original === "—") return "—";

  let cleaned = original
    .replace(/\[Auto\]/g, "")
    .replace(/\[首單開倉\]/g, "")
    .replace(/成功/g, "")
    .replace(/已執行/g, "")
    .replace(/\[風控監控\]/g, "")
    .replace(/\[V\d+\.\d+\s*Monitor\]/g, "")
    .replace(/Monitor/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // 止盈 pattern
  if (cleaned.includes("止盈")) {
    const pctMatch = cleaned.match(/([+-]?\d+\.?\d*)%/);
    const pct = pctMatch ? pctMatch[1] : "";
    if (pct) return `✅ 止盈 ${pct.startsWith("-") ? "" : "+"}${pct}%`;
    return `✅ 止盈觸發`;
  }

  // 開倉 pattern
  if (cleaned.includes("開倉") || cleaned.includes("賣出") || cleaned.includes("買入")) {
    const priceMatch = cleaned.match(/(\d+\.?\d+)/);
    const price = priceMatch ? priceMatch[1] : "";
    const layerMatch = cleaned.match(/第\s*(\d+)\s*層/);
    const layer = layerMatch ? `Lv.${layerMatch[1]}` : "";
    return `🟢 [開] @ ${price} ${layer}`.trim();
  }

  // 加倉 pattern
  if (cleaned.includes("加倉")) {
    const priceMatch = cleaned.match(/(\d+\.?\d+)/);
    const price = priceMatch ? priceMatch[1] : "";
    const layerMatch = cleaned.match(/第\s*(\d+)\s*層/);
    const layer = layerMatch ? `Lv.${layerMatch[1]}` : "";
    return `🟡 [加] @ ${price} ${layer}`.trim();
  }

  // 移動止盈 pattern
  if (cleaned.includes("移動止盈") || cleaned.includes("回撤")) {
    const pctMatch = cleaned.match(/(\d+\.?\d*)%/);
    return `🔵 移動止盈觸發${pctMatch ? ` (回撤 ${pctMatch[1]}%)` : ""}`;
  }

  // 止損 pattern
  if (cleaned.includes("止損")) {
    const pctMatch = cleaned.match(/([+-]?\d+\.?\d*)%/);
    return `🔥 止損觸發${pctMatch ? ` ${pctMatch[1]}%` : ""}`;
  }

  // Truncate long messages
  return cleaned.length > 60 ? cleaned.substring(0, 60) + "..." : cleaned;
}
