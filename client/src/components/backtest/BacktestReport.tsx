/**
 * 回測績效報告（pasted_content_4.txt 任務 9 + 12 + 14）
 * 5 項核心指標卡 + 詳細統計 + 權益曲線 + 交易明細（可篩選）+ CSV 導出 + 一鍵複製參數
 */

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Copy, Download, Save, Upload, Play } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { InstanceSelector } from "@/components/InstanceSelector";
import { Rainbow20415ConfigPanel } from "@/components/Rainbow20415ConfigPanel";
import EquityChart from "./EquityChart";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { RAINBOW_20415_STRATEGY_KEY } from "@shared/strategies/rainbow20415";

export interface ReportTrade {
  id: number;
  entryTime: number;
  exitTime: number;
  side: string;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPct: number;
  exitReason: string;
  martinLayer: number;
}

export interface ReportMetrics {
  totalReturn: number;
  totalReturnUSDT: number;
  winRate: number;
  maxDrawdown: number;
  maxDrawdownUSDT: number;
  sharpeRatio: number;
  profitFactor: number;
  calmarRatio: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  avgWin: number;
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  martinTriggerCount: number;
  maxMartinLayer: number;
  totalDays: number;
}

export interface ReportOpenPosition {
  side: "long" | "short";
  entryTime: number;
  averageEntryPrice: number;
  size: number;
  markPrice: number;
  entryNotional: number;
  entryFees: number;
  unrealizedGrossPnl: number;
  unrealizedPnl: number;
}

export interface ReportAccounting {
  initialCapital: number;
  realizedPnl: number;
  unrealizedPnl: number;
  finalEquity: number;
  expectedFinalEquity: number;
  reconciliationDifference: number;
  balanced: boolean;
  reconciled: boolean;
  tolerance: number;
  openPosition: ReportOpenPosition | null;
  openPositionCount: number;
  syntheticForceCloseCount: number;
}

export interface ReportDataQuality {
  intervalContract: "[start,end)";
  requestedStartMs: number;
  requestedEndMs: number;
  inputCandles: number;
  returnedCandles: number;
  candleCount: number;
  duplicateCandlesRemoved: number;
  outOfRangeCandlesRemoved: number;
  invalidCandlesRemoved: number;
  unclosedCandlesRemoved: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  sortedAscending: boolean;
}

export interface ReportEngineSemantics {
  version: string;
  sessionMode: "continuous";
  dataSlicing: "half_open";
  finalizationScope: "global_end_only";
  defaultEndPositionPolicy: "mark_to_market";
}

export interface ReportEnvironment {
  engineVersion: string;
  dataHash: string;
  leverage: number;
  commission: number;
  slippage: number;
  symbol: string;
  timeframe: string;
  startDate: number;
  endDate: number;
  candleCount: number;
  initialCapital: number;
}

interface Props {
  runId: string;
  strategyName?: string;
  strategyKey?: string;
  metrics: ReportMetrics;
  trades: ReportTrade[];
  equityCurve: Array<{ timestamp: number; equity: number; price: number }>;
  config: Record<string, unknown>;
  endPositionPolicy?: string;
  candleCount?: number;
  accounting?: ReportAccounting | null;
  dataQuality?: ReportDataQuality | null;
  engineSemantics?: ReportEngineSemantics | null;
  environment?: ReportEnvironment | null;
  backtestSettings?: { exchange: string; symbol: string; timeframe: string; startDate: string; endDate: string; initialCapital: number; tradeAmount?: number; endPositionPolicy?: "mark_to_market" | "force_close"; configJson?: Record<string, unknown>; baseLotSize?: number; baseLotSizeMode?: string };
  onCopyParams?: (config: Record<string, unknown>) => void;
  onSaveSnapshot?: () => void;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-TW", { hour12: false });
}

export default function BacktestReport({
  runId,
  strategyName,
  strategyKey,
  metrics,
  trades,
  equityCurve,
  config,
  endPositionPolicy = "mark_to_market",
  candleCount,
  accounting,
  dataQuality,
  engineSemantics,
  environment,
  backtestSettings,
  onCopyParams,
  onSaveSnapshot,
}: Props) {
  const utils = trpc.useUtils();
  const [showParams, setShowParams] = useState(false);
  const [resultFilter, setResultFilter] = useState<"all" | "win" | "loss">("all");
  const [martinFilter, setMartinFilter] = useState<"all" | "martin" | "no-martin">("all");
  const hasV25Metadata = Boolean(accounting || dataQuality || engineSemantics || environment);
  const isForceClose = endPositionPolicy === "force_close";

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      if (resultFilter === "win" && t.pnl <= 0) return false;
      if (resultFilter === "loss" && t.pnl >= 0) return false;
      if (martinFilter === "martin" && t.martinLayer === 0) return false;
      if (martinFilter === "no-martin" && t.martinLayer > 0) return false;
      return true;
    });
  }, [trades, resultFilter, martinFilter]);

  const exportCSV = () => {
    const headers = ["時間", "方向", "入場價", "出場價", "數量", "盈虧", "盈虧%", "原因", "馬丁層數"];
    const rows = trades.map((t) => [
      fmtTime(t.exitTime),
      t.side === "long" ? "買升" : "買跌",
      t.entryPrice,
      t.exitPrice,
      t.size,
      t.pnl,
      t.pnlPct,
      t.exitReason,
      t.martinLayer,
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backtest_${runId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV 已導出");
  };

  const copyParams = () => {
    navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    onCopyParams?.(config);
    toast.success("參數已複製，可貼到策略配置使用");
  };

  // 儲存快照到參數快照庫
  const saveSnapshotMutation = trpc.backtest.saveSnapshot.useMutation();
  const [savingSnapshot, setSavingSnapshot] = useState(false);

  // V5.3: 套用至現有策略
  const applyToInstanceMutation = trpc.backtest.applySnapshotToInstance.useMutation();
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [applyTargetId, setApplyTargetId] = useState("");

  // V5.3: 以參數建立新策略
  const [, navigate] = useLocation();

  const handleApplyToExisting = () => {
    setApplyTargetId("");
    setShowApplyModal(true);
  };

  const handleConfirmApply = async () => {
    if (!applyTargetId) {
      toast.error("請選擇目標策略實例");
      return;
    }
    try {
      const result = await applyToInstanceMutation.mutateAsync({
        snapshotConfig: config as Record<string, unknown>,
        strategyKey: strategyKey || "unknown",
        targetInstanceId: Number(applyTargetId),
      });
      toast.success(result.message);
      setShowApplyModal(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "套用失敗");
    }
  };

  const handleCreateNewStrategy = () => {
    // 跳轉到策略管理頁，帶入預填參數
    navigate("/strategies");
    // 使用 sessionStorage 傳遞參數（wouter 不支援 state）
    sessionStorage.setItem("importParams", JSON.stringify({
      definitionKey: strategyKey || "unknown",
      config,
      suggestedName: `${strategyName || strategyKey || '未知策略'}_${new Date().toISOString().slice(0, 10)}`,
      sourceMetrics: {
        totalReturn: metrics.totalReturn,
        winRate: metrics.winRate,
        sharpeRatio: metrics.sharpeRatio,
        profitFactor: metrics.profitFactor,
        maxDrawdown: metrics.maxDrawdown,
      },
    }));
  };

  const handleSaveSnapshot = async () => {
    setSavingSnapshot(true);
    try {
      await saveSnapshotMutation.mutateAsync({
        strategyKey: strategyKey || "unknown",
        strategyName: strategyName || strategyKey || "未知策略",
        config,
        metrics: {
          totalReturn: metrics.totalReturn,
          winRate: metrics.winRate,
          sharpeRatio: metrics.sharpeRatio,
          profitFactor: metrics.profitFactor,
          maxDrawdown: metrics.maxDrawdown,
          calmarRatio: metrics.calmarRatio,
          totalTrades: metrics.totalTrades,
          winningTrades: metrics.winningTrades,
          losingTrades: metrics.losingTrades,
          avgWin: metrics.avgWin,
          avgLoss: metrics.avgLoss,
          maxWin: metrics.maxWin,
          maxLoss: metrics.maxLoss,
        },
        backtestSettings,
      });
      toast.success("✅ 參數快照已儲存到快照庫");
      onSaveSnapshot?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "儲存快照失敗");
    } finally {
      setSavingSnapshot(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 任務 A5：策略名稱標題列 + 任務 C4：參數快照 */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default" className="text-sm px-3 py-1">
          {strategyName ?? "未知策略"}
        </Badge>
        {strategyKey && (
          <Badge variant="outline" className="text-xs font-mono">
            {strategyKey}
          </Badge>
        )}
        <Badge variant="secondary" className="text-xs font-mono" title={runId}>
          {runId.length > 40 ? runId.slice(0, 40) + "..." : runId}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => setShowParams((v) => !v)}
        >
          {showParams ? "隱藏參數快照" : "查看參數快照"}
        </Button>
      </div>
      {showParams && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">本次回測參數快照</CardTitle>
          </CardHeader>
          <CardContent>
            {strategyKey === RAINBOW_20415_STRATEGY_KEY ? (
              <Rainbow20415ConfigPanel value={config} onChange={() => undefined} disabled context="snapshot" />
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                {Object.entries(config).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 border rounded px-2 py-1">
                    <span className="text-muted-foreground truncate" title={k}>{k}</span>
                    <span className="font-mono">
                      {typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 5 項核心指標卡 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">總回報</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${metrics.totalReturn >= 0 ? "text-emerald-500" : "text-red-500"}`}
            >
              {metrics.totalReturn >= 0 ? "+" : ""}
              {metrics.totalReturn}%
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {metrics.totalReturnUSDT >= 0 ? "+" : ""}
              {metrics.totalReturnUSDT} USDT
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">勝率</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-500">{metrics.winRate}%</div>
            <p className="text-xs text-muted-foreground mt-1">
              {metrics.winningTrades} 勝 / {metrics.losingTrades} 負
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">最大回撤</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-500">-{metrics.maxDrawdown}%</div>
            <p className="text-xs text-muted-foreground mt-1">-{metrics.maxDrawdownUSDT} USDT</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">夏普比率</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${metrics.sharpeRatio >= 1 ? "text-emerald-500" : "text-yellow-500"}`}
            >
              {metrics.sharpeRatio}
            </div>
            <p className="text-xs text-muted-foreground mt-1">年化風險調整收益</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">利潤因子</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${metrics.profitFactor >= 1.5 ? "text-emerald-500" : "text-yellow-500"}`}
            >
              {metrics.profitFactor}
            </div>
            <p className="text-xs text-muted-foreground mt-1">總盈利 / 總虧損</p>
          </CardContent>
        </Card>
      </div>

      {/* 詳細統計 8 格 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">詳細統計</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">總交易數</p>
              <p className="font-semibold">{metrics.totalTrades}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">回測天數</p>
              <p className="font-semibold">{metrics.totalDays} 天</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">平均盈利</p>
              <p className="font-semibold text-emerald-500">+{metrics.avgWin} USDT</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">平均虧損</p>
              <p className="font-semibold text-red-500">{metrics.avgLoss} USDT</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">最大單筆盈利</p>
              <p className="font-semibold text-emerald-500">+{metrics.maxWin} USDT</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">最大單筆虧損</p>
              <p className="font-semibold text-red-500">{metrics.maxLoss} USDT</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">馬丁觸發次數</p>
              <p className="font-semibold">{metrics.martinTriggerCount}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">最大馬丁層數</p>
              <p className="font-semibold">{metrics.maxMartinLayer}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {hasV25Metadata && (
        <Card className="border-cyan-500/30 bg-slate-950/30">
          <CardHeader className="gap-3 border-b border-border/60 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-sm">V2.5 對帳與資料口徑</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                單一權益帳本、連續 Session 與全域終點政策的可稽核結果。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className={isForceClose ? "border-amber-500/60 text-amber-300" : "border-cyan-500/60 text-cyan-300"}>
                {isForceClose ? "終點：強制平倉" : "終點：按市價估值"}
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px]">
                {engineSemantics?.version ?? environment?.engineVersion ?? "V2.5"}
              </Badge>
              {accounting && (
                <Badge className={accounting.reconciled ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}>
                  {accounting.reconciled ? "帳本已對平" : "帳本未對平"}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-5">
            {accounting && (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                {[
                  ["最終權益", `${accounting.finalEquity.toFixed(2)} USDT`],
                  ["已實現損益", `${accounting.realizedPnl >= 0 ? "+" : ""}${accounting.realizedPnl.toFixed(2)} USDT`],
                  ["未實現損益", `${accounting.unrealizedPnl >= 0 ? "+" : ""}${accounting.unrealizedPnl.toFixed(2)} USDT`],
                  ["對帳差額", `${accounting.reconciliationDifference.toFixed(4)} USDT`],
                  ["有效 K 棒", String(candleCount ?? dataQuality?.candleCount ?? environment?.candleCount ?? 0)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md border border-border/70 bg-background/50 px-3 py-3">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
                    <p className="mt-1 font-mono text-sm font-semibold text-foreground">{value}</p>
                  </div>
                ))}
              </div>
            )}

            {accounting?.openPosition && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-amber-50">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-amber-300">終點未平倉估值</p>
                    <p className="mt-1 text-xs text-amber-100/80">按最後一根已收盤 K 棒標記價格納入最終權益，不製造合成交易。</p>
                  </div>
                  <Badge variant="outline" className="border-amber-400/60 text-amber-200">
                    {accounting.openPosition.side === "long" ? "多單" : "空單"}
                  </Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs md:grid-cols-5">
                  <div><span className="text-amber-100/60">均價</span><p className="font-mono">{accounting.openPosition.averageEntryPrice.toFixed(4)}</p></div>
                  <div><span className="text-amber-100/60">標記價</span><p className="font-mono">{accounting.openPosition.markPrice.toFixed(4)}</p></div>
                  <div><span className="text-amber-100/60">數量</span><p className="font-mono">{accounting.openPosition.size.toFixed(6)}</p></div>
                  <div><span className="text-amber-100/60">名義價值</span><p className="font-mono">{accounting.openPosition.entryNotional.toFixed(2)} USDT</p></div>
                  <div><span className="text-amber-100/60">未實現淨損益</span><p className="font-mono font-semibold">{accounting.openPosition.unrealizedPnl >= 0 ? "+" : ""}{accounting.openPosition.unrealizedPnl.toFixed(2)} USDT</p></div>
                </div>
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              {dataQuality && (
                <div className="rounded-md border border-border/70 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">資料品質</p>
                    <Badge variant="secondary" className="font-mono text-[10px]">{dataQuality.intervalContract}</Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <span className="text-muted-foreground">輸入 / 回傳</span><span className="text-right font-mono">{dataQuality.inputCandles} / {dataQuality.returnedCandles}</span>
                    <span className="text-muted-foreground">重複移除</span><span className="text-right font-mono">{dataQuality.duplicateCandlesRemoved}</span>
                    <span className="text-muted-foreground">越界移除</span><span className="text-right font-mono">{dataQuality.outOfRangeCandlesRemoved}</span>
                    <span className="text-muted-foreground">無效移除</span><span className="text-right font-mono">{dataQuality.invalidCandlesRemoved}</span>
                    <span className="text-muted-foreground">未收盤移除</span><span className="text-right font-mono">{dataQuality.unclosedCandlesRemoved}</span>
                    <span className="text-muted-foreground">時間排序</span><span className="text-right font-mono">{dataQuality.sortedAscending ? "嚴格遞增" : "異常"}</span>
                  </div>
                </div>
              )}
              {(engineSemantics || environment) && (
                <div className="rounded-md border border-border/70 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">引擎語義與環境</p>
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <span className="text-muted-foreground">Session</span><span className="text-right font-mono">{engineSemantics?.sessionMode ?? "continuous"}</span>
                    <span className="text-muted-foreground">資料切片</span><span className="text-right font-mono">{engineSemantics?.dataSlicing ?? "half_open"}</span>
                    <span className="text-muted-foreground">結算範圍</span><span className="text-right font-mono">{engineSemantics?.finalizationScope ?? "global_end_only"}</span>
                    <span className="text-muted-foreground">槓桿 / 費率</span><span className="text-right font-mono">{environment ? `${environment.leverage}x / ${(environment.commission * 100).toFixed(4)}%` : "—"}</span>
                    <span className="text-muted-foreground">資料雜湊</span><span className="truncate text-right font-mono" title={environment?.dataHash}>{environment?.dataHash ? `${environment.dataHash.slice(0, 12)}…` : "—"}</span>
                    <span className="text-muted-foreground">合成終點平倉</span><span className="text-right font-mono">{accounting?.syntheticForceCloseCount ?? 0}</span>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 權益曲線 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">權益曲線</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={exportCSV}>
              <Download className="w-4 h-4 mr-1" />
              導出 CSV
            </Button>
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={copyParams}
            >
              <Copy className="w-4 h-4 mr-1" />
              一鍵複製參數
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-amber-500 text-amber-400 hover:bg-amber-500/10"
              onClick={handleSaveSnapshot}
              disabled={savingSnapshot}
            >
              <Save className="w-4 h-4 mr-1" />
              {savingSnapshot ? "儲存中..." : "儲存快照"}
            </Button>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={handleApplyToExisting}
                  >
                    <Play className="w-4 h-4 mr-1" />
                    套用至現有策略
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>將此回測參數覆蓋至選定的現有策略實例</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={handleCreateNewStrategy}
                  >
                    <Upload className="w-4 h-4 mr-1" />
                    以參數建立新策略
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>以此回測參數建立一個全新的策略實例</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </CardHeader>
        <CardContent>
          <EquityChart equityCurve={equityCurve} trades={trades} height={350} />
        </CardContent>
      </Card>

      {/* 交易明細 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">
            交易明細（{filteredTrades.length}/{trades.length}）
          </CardTitle>
          <div className="flex gap-2">
            <Select value={resultFilter} onValueChange={(v) => setResultFilter(v as typeof resultFilter)}>
              <SelectTrigger className="w-28 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部結果</SelectItem>
                <SelectItem value="win">僅盈利</SelectItem>
                <SelectItem value="loss">僅虧損</SelectItem>
              </SelectContent>
            </Select>
            <Select value={martinFilter} onValueChange={(v) => setMartinFilter(v as typeof martinFilter)}>
              <SelectTrigger className="w-28 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部類型</SelectItem>
                <SelectItem value="martin">有馬丁</SelectItem>
                <SelectItem value="no-martin">無馬丁</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">出場時間</TableHead>
                  <TableHead className="text-xs">方向</TableHead>
                  <TableHead className="text-xs text-right">入場價</TableHead>
                  <TableHead className="text-xs text-right">出場價</TableHead>
                  <TableHead className="text-xs text-right">數量</TableHead>
                  <TableHead className="text-xs text-right">盈虧</TableHead>
                  <TableHead className="text-xs text-right">盈虧%</TableHead>
                  <TableHead className="text-xs">原因</TableHead>
                  <TableHead className="text-xs text-right">層數</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTrades.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-xs whitespace-nowrap">{fmtTime(t.exitTime)}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          t.side === "long"
                            ? "border-emerald-500 text-emerald-500 text-xs"
                            : "border-red-500 text-red-500 text-xs"
                        }
                      >
                        {t.side === "long" ? "買升" : "買跌"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-right">{t.entryPrice}</TableCell>
                    <TableCell className="text-xs text-right">{t.exitPrice}</TableCell>
                    <TableCell className="text-xs text-right">{t.size}</TableCell>
                    <TableCell
                      className={`text-xs text-right font-medium ${t.pnl >= 0 ? "text-emerald-500" : "text-red-500"}`}
                    >
                      {t.pnl >= 0 ? "+" : ""}
                      {t.pnl}
                    </TableCell>
                    <TableCell
                      className={`text-xs text-right ${t.pnlPct >= 0 ? "text-emerald-500" : "text-red-500"}`}
                    >
                      {t.pnlPct >= 0 ? "+" : ""}
                      {t.pnlPct}%
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{t.exitReason}</TableCell>
                    <TableCell className="text-xs text-right">{t.martinLayer}</TableCell>
                  </TableRow>
                ))}
                {filteredTrades.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-xs text-muted-foreground py-6">
                      無符合篩選條件的交易
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* V5.3: 套用至現有策略 Modal */}
      <Dialog open={showApplyModal} onOpenChange={setShowApplyModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>套用參數至現有策略</DialogTitle>
            <DialogDescription>
              選擇要更新的策略實例，系統將覆蓋其參數配置。僅顯示相同策略類型的實例。
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div className="space-y-2">
              <Label>目標策略實例</Label>
              <InstanceSelector
                value={applyTargetId}
                onChange={setApplyTargetId}
                filterByStrategy={strategyKey}
                placeholder="請選擇目標策略實例..."
              />
            </div>
            <div className="text-xs text-muted-foreground bg-muted/30 rounded p-2">
              <p>將覆蓋以下參數：</p>
              <ul className="mt-1 space-y-0.5">
                <li>• 馬丁分層、止盈、風控設定</li>
                <li>• 交易對：{(config.symbol as string) || (config.Symbol as string) || "BTCUSDT"}</li>
                <li>• 策略：{strategyName || strategyKey || "未知"}</li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApplyModal(false)}>
              取消
            </Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={handleConfirmApply}
              disabled={applyToInstanceMutation.isPending || !applyTargetId}
            >
              {applyToInstanceMutation.isPending ? "套用中..." : "✅ 確認套用"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
