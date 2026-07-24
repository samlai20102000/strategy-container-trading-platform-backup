/**
 * 歷史回測記錄 + 多策略對比（任務 C1/C2）
 * DB 持久化版本：支援分頁、刪除、狀態顯示（running/queued/completed/failed/cancelled）
 */

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, GitCompare, Eye, FileJson, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";

interface Props {
  strategyNameMap: Record<string, string>;
  onLoadRun: (runId: string) => void;
}

interface CompareRow {
  runId: string;
  strategyKey: string;
  symbol: string;
  timeframe: string;
  metrics: {
    totalReturn: number;
    winRate: number;
    maxDrawdown: number;
    sharpeRatio: number;
    profitFactor: number;
    totalTrades: number;
  } | null;
}

const PAGE_SIZE = 20;

function fmtDate(ts: number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return d.toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const statusMap: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  running: { label: "執行中", variant: "default" },
  queued: { label: "排隊中", variant: "outline" },
  pending: { label: "排隊中", variant: "outline" },
  completed: { label: "完成", variant: "secondary" },
  failed: { label: "失敗", variant: "destructive" },
  timeout: { label: "超時", variant: "destructive" },
  cancelled: { label: "已取消", variant: "outline" },
};

export default function BacktestHistory({ strategyNameMap, onLoadRun }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [compareRows, setCompareRows] = useState<CompareRow[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const [page, setPage] = useState(0);
  const [snapshots, setSnapshots] = useState<Record<string, Record<string, unknown> | "loading">>({});

  const runsQuery = trpc.backtest.listRuns.useQuery(
    { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
  );
  const deleteMutation = trpc.backtest.deleteRun.useMutation();
  const utils = trpc.useUtils();

  const loadSnapshot = async (runId: string) => {
    if (snapshots[runId] && snapshots[runId] !== "loading") return;
    setSnapshots((prev) => ({ ...prev, [runId]: "loading" }));
    try {
      const data = await utils.backtest.getRun.fetch({ runId });
      const cfg = (data.run as { config?: unknown }).config;
      const obj =
        typeof cfg === "string" ? (JSON.parse(cfg) as Record<string, unknown>) : ((cfg ?? {}) as Record<string, unknown>);
      setSnapshots((prev) => ({ ...prev, [runId]: obj }));
    } catch (e) {
      setSnapshots((prev) => {
        const next = { ...prev };
        delete next[runId];
        return next;
      });
      toast.error(`參數快照載入失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const hasMore = runs.length === PAGE_SIZE;

  const toggleSelect = (runId: string) => {
    setSelected((prev) =>
      prev.includes(runId) ? prev.filter((id) => id !== runId) : [...prev, runId].slice(-4),
    );
  };

  const handleDelete = async (runId: string) => {
    try {
      await deleteMutation.mutateAsync({ jobId: runId });
      toast.success("記錄已刪除");
      utils.backtest.listRuns.invalidate();
    } catch (e) {
      toast.error(`刪除失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const runCompare = async () => {
    if (selected.length < 2) {
      toast.error("請至少勾選 2 筆記錄進行對比");
      return;
    }
    setComparing(true);
    try {
      const rows: CompareRow[] = [];
      for (const runId of selected) {
        const data = await utils.backtest.getRun.fetch({ runId });
        const m = data.metrics as CompareRow["metrics"];
        rows.push({
          runId,
          strategyKey: data.run.strategyKey,
          symbol: data.run.symbol,
          timeframe: data.run.timeframe,
          metrics: m,
        });
      }
      setCompareRows(rows);
    } catch (e) {
      toast.error(`對比載入失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setComparing(false);
    }
  };

  if (runsQuery.isLoading && page === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> 載入歷史記錄...
      </div>
    );
  }

  if (runs.length === 0 && page === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        暫無歷史回測記錄，執行一次回測後會自動保存於此
      </div>
    );
  }

  const bestOf = (key: keyof NonNullable<CompareRow["metrics"]>, higherBetter = true): string => {
    if (!compareRows) return "";
    let best = "";
    let bestVal = higherBetter ? -Infinity : Infinity;
    for (const r of compareRows) {
      if (!r.metrics) continue;
      const v = r.metrics[key];
      if (higherBetter ? v > bestVal : v < bestVal) {
        bestVal = v;
        best = r.runId;
      }
    }
    return best;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          第 {page + 1} 頁，勾選 2-4 筆可並排對比
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={selected.length < 2 || comparing}
            onClick={runCompare}
          >
            {comparing ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <GitCompare className="h-3 w-3 mr-1" />
            )}
            對比選中（{selected.length}）
          </Button>
        </div>
      </div>

      {/* 多策略並排對比表 */}
      {compareRows && compareRows.length >= 2 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">多策略對比</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">指標</TableHead>
                    {compareRows.map((r) => (
                      <TableHead key={r.runId} className="text-xs text-center">
                        <div>{strategyNameMap[r.strategyKey] ?? r.strategyKey}</div>
                        <div className="text-[10px] text-muted-foreground">{r.symbol} / {r.timeframe}</div>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(
                    [
                      ["totalReturn", "總收益率 %", true],
                      ["winRate", "勝率 %", true],
                      ["maxDrawdown", "最大回撤 %", false],
                      ["sharpeRatio", "夏普比率", true],
                      ["profitFactor", "盈虧比", true],
                      ["totalTrades", "總交易數", true],
                    ] as [keyof NonNullable<CompareRow["metrics"]>, string, boolean][]
                  ).map(([key, label, higher]) => (
                    <TableRow key={key}>
                      <TableCell className="text-xs font-medium">{label}</TableCell>
                      {compareRows.map((r) => {
                        const val = r.metrics?.[key];
                        const isBest = bestOf(key, higher) === r.runId;
                        return (
                          <TableCell
                            key={r.runId}
                            className={`text-xs text-center font-mono ${isBest ? "text-emerald-500 font-bold" : ""}`}
                          >
                            {val != null ? (typeof val === "number" ? val.toFixed(2) : val) : "—"}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 歷史記錄表格 */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead className="text-xs">時間</TableHead>
              <TableHead className="text-xs">策略</TableHead>
              <TableHead className="text-xs">品種</TableHead>
              <TableHead className="text-xs">框架</TableHead>
              <TableHead className="text-xs">狀態</TableHead>
              <TableHead className="text-xs text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => {
              const st = statusMap[r.status] ?? { label: r.status, variant: "outline" as const };
              const rowId = r.jobId;
              return (
                <TableRow key={rowId} className={r.status === "running" ? "bg-blue-500/5" : ""}>
                  <TableCell>
                    <Checkbox
                      checked={selected.includes(rowId)}
                      onCheckedChange={() => toggleSelect(rowId)}
                      disabled={r.status !== "completed"}
                    />
                  </TableCell>
                  <TableCell className="text-xs">{fmtDate(r.createdAt)}</TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline" className="text-[10px]">
                      {r.strategyName || strategyNameMap[r.strategyKey] || r.strategyKey}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs font-mono">{r.symbol}</TableCell>
                  <TableCell className="text-xs">{r.timeframe}</TableCell>
                  <TableCell className="text-xs">
                    <div className="flex items-center gap-1.5">
                      <Badge variant={st.variant} className="text-[10px]">
                        {r.status === "running" && <Loader2 className="h-2.5 w-2.5 animate-spin mr-0.5" />}
                        {st.label}
                      </Badge>
                      {r.status === "running" && r.progress != null && (
                        <Progress value={r.progress} className="w-16 h-1.5" />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {r.status === "completed" && (
                        <>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 text-xs"
                                onClick={() => void loadSnapshot(rowId)}
                              >
                                <FileJson className="h-3 w-3 mr-1" /> 參數
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent align="end" className="w-80 max-h-72 overflow-auto">
                              <p className="text-xs font-medium mb-2">參數快照</p>
                              {snapshots[rowId] === "loading" || !snapshots[rowId] ? (
                                <div className="flex items-center text-xs text-muted-foreground">
                                  <Loader2 className="h-3 w-3 animate-spin mr-1" /> 載入中...
                                </div>
                              ) : (
                                <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted/50 rounded p-2">
                                  {JSON.stringify(snapshots[rowId], null, 2)}
                                </pre>
                              )}
                            </PopoverContent>
                          </Popover>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-xs"
                            onClick={() => onLoadRun(rowId)}
                          >
                            <Eye className="h-3 w-3 mr-1" /> 查看
                          </Button>
                        </>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs text-red-500 hover:text-red-600"
                        onClick={() => handleDelete(rowId)}
                        disabled={deleteMutation.isPending || r.status === "running"}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* 分頁控制 */}
      <div className="flex items-center justify-between pt-2">
        <Button
          size="sm"
          variant="outline"
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        >
          <ChevronLeft className="h-3 w-3 mr-1" /> 上一頁
        </Button>
        <span className="text-xs text-muted-foreground">第 {page + 1} 頁</span>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasMore}
          onClick={() => setPage((p) => p + 1)}
        >
          下一頁 <ChevronRight className="h-3 w-3 ml-1" />
        </Button>
      </div>
    </div>
  );
}
