/**
 * 參數掃描 V6.0 — NSGA-II 遺傳算法智能優化面板
 *
 * 功能：
 * - 智能模式（預設）：一鍵 NSGA-II 多目標進化優化
 * - 手動進階模式：保留傳統網格搜索（勾選參數 min/max/step）
 * - 三檔掃描模式：快速(5代/~8分) / 標準(8代/~15分) / 深度(15代/~35分)
 * - 實時進度面板：四階段指示器 + 代數進度 + 進化適應度曲線
 * - 結果面板：最佳參數卡片 + 參數重要性 + Pareto 前沿 + Walk-Forward 驗證
 * - 歷史記錄 + 勾選對比
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
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
  Play,
  TrendingUp,
  History,
  BarChart3,
  Target,
  Zap,
  Trash2,
  Eye,
  GitCompare,
  Plus,
  X,
  Award,
  Activity,
  Brain,
  Settings2,
  StopCircle,
  CheckCircle2,
  Dna,
  Shield,
  Gauge,
  ArrowRight,
  Copy,
  Loader2,
  ListOrdered,
} from "lucide-react";
import { toast } from "sonner";
import { useBacktestWs } from "@/hooks/useBacktestWs";
import HeatmapChart from "@/components/backtest/HeatmapChart";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  ScatterChart,
  Scatter,
  Cell,
} from "recharts";

// ============================================================
// 類型
// ============================================================

interface ScanParam {
  name: string;
  min: string;
  max: string;
  step: string;
  enabled: boolean;
}

interface ObjectiveWeights {
  totalReturn: number;
  winRate: number;
  sharpeRatio: number;
  profitFactor: number;
  maxDrawdown: number;
}

type TabView = "smart" | "manual" | "queue" | "history" | "compare";
type ScanPhase = "idle" | "running" | "done" | "failed";
type ScanMode = "fast" | "standard" | "deep";

// ============================================================
// 常量
// ============================================================

const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1H", "4H", "1D"];

const DEFAULT_WEIGHTS: ObjectiveWeights = {
  totalReturn: 0.35,
  winRate: 0.25,
  sharpeRatio: 0.20,
  profitFactor: 0.10,
  maxDrawdown: 0.10,
};

const SCAN_MODE_CONFIG: Record<ScanMode, { label: string; generations: number; time: string; description: string }> = {
  fast: { label: "快速", generations: 5, time: "~2-5 分鐘", description: "即時執行，適合初步篩選" },
  standard: { label: "標準", generations: 8, time: "~10-15 分鐘", description: "平衡精度與速度" },
  deep: { label: "深度", generations: 15, time: "~20-35 分鐘", description: "深度搜索，最高精度" },
};

const PHASE_LABELS: Record<string, { label: string; icon: string }> = {
  preloading: { label: "數據預載", icon: "⬇️" },
  initializing: { label: "種群初始化", icon: "🎲" },
  sensitivity: { label: "敏感性分析", icon: "🔬" },
  evolution: { label: "進化搜索", icon: "🧬" },
  refinement: { label: "差分精煉", icon: "⚡" },
  validation: { label: "穩健驗證", icon: "🛡️" },
  grid: { label: "網格掃描", icon: "📊" },
};

const WEIGHT_LABELS: Record<keyof ObjectiveWeights, string> = {
  totalReturn: "總利潤",
  winRate: "勝率",
  sharpeRatio: "夏普比率",
  profitFactor: "利潤因子",
  maxDrawdown: "最大回撤",
};

// ============================================================
// 主組件
// ============================================================

export default function ParameterScan() {
  const [activeTab, setActiveTab] = useState<TabView>("smart");

  // ========== 共用配置 ==========
  const [strategyKey, setStrategyKey] = useState("");
  const [symbols, setSymbols] = useState<string[]>(["BTC-USDT-SWAP"]);
  const [timeframe, setTimeframe] = useState("5m");
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [initialCapital, setInitialCapital] = useState("10000");
  const [exchange, setExchange] = useState<"okx" | "bybit">("okx");
  const [weights, setWeights] = useState<ObjectiveWeights>(DEFAULT_WEIGHTS);

  // ========== 智能模式 ==========
  const [scanMode, setScanMode] = useState<ScanMode>("standard");
  const [walkForward, setWalkForward] = useState(true);

  // ========== 手動模式 ==========
  const [scanParams, setScanParams] = useState<ScanParam[]>([]);

  // ========== 任務狀態 ==========
  const [scanId, setScanId] = useState<string | null>(null);
  const [phase, setPhase] = useState<ScanPhase>("idle");

  // ========== WebSocket 即時進度狀態 ==========
  const [wsStatus, setWsStatus] = useState<{
    phase?: string;
    phaseProgress?: number;
    preloadMessage?: string;
    progress?: number;
    currentGeneration?: number;
    maxGenerations?: number;
    currentBest?: { score: number; totalReturn: number; winRate: number };
    fitnessHistory?: Array<{ generation: number; bestScore: number; avgScore: number; paretoSize?: number }>;
    completedCombinations?: number;
    totalCombinations?: number;
  }>({});

  // ========== 歷史對比 ==========
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<number[]>([]);
  const [viewingDetailId, setViewingDetailId] = useState<number | null>(null);

  // ========== 查詢 ==========
  const registryQuery = trpc.registry.listDefinitions.useQuery(undefined);
  const backtestStrategiesQuery = trpc.backtest.getStrategies.useQuery();
  const strategiesQuery = useMemo(() => {
    if (registryQuery.data && registryQuery.data.length > 0) {
      return registryQuery.data.map((s) => ({ key: s.key, name: s.name }));
    }
    return backtestStrategiesQuery.data ?? [];
  }, [registryQuery.data, backtestStrategiesQuery.data]);

  const defaultsQuery = trpc.registry.getDefaults.useQuery(
    { key: strategyKey },
    { enabled: !!strategyKey },
  );

  const utils = trpc.useUtils();
  const submitMutation = trpc.backtest.submitScan.useMutation();
  const abortMutation = trpc.backtest.abortScan.useMutation();
  const statusQuery = trpc.backtest.getScanStatus.useQuery(
    { scanId: scanId ?? "" },
    { enabled: !!scanId && phase === "running", refetchInterval: 2000, retry: 3 },
  );
  // 佇列狀態查詢（活躍任務列表）
  const activeJobsQuery = trpc.backtest.getScanActiveJobs.useQuery(undefined, {
    refetchInterval: activeTab === "queue" ? 2000 : 10000,
  });
  const historyQuery = trpc.backtest.listScanHistory.useQuery(
    { limit: 50, offset: 0 },
    { enabled: activeTab === "history" || activeTab === "compare" },
  );
  const detailQuery = trpc.backtest.getScanDetail.useQuery(
    { id: viewingDetailId ?? 0 },
    { enabled: !!viewingDetailId },
  );
  const compareQuery = trpc.backtest.compareScanResults.useQuery(
    { ids: selectedHistoryIds },
    { enabled: activeTab === "compare" && selectedHistoryIds.length >= 2 },
  );
  const deleteMutation = trpc.backtest.deleteScanHistory.useMutation();

  // ========== 自動設定第一個策略 ==========
  useEffect(() => {
    if (!strategyKey && strategiesQuery.length > 0) {
      setStrategyKey(strategiesQuery[0].key);
    }
  }, [strategiesQuery, strategyKey]);

  // ========== 載入策略預設參數（手動模式用） ==========
  useEffect(() => {
    if (defaultsQuery.data && typeof defaultsQuery.data === "object") {
      const defaults = defaultsQuery.data as Record<string, unknown>;
      const params: ScanParam[] = [];
      for (const [key, val] of Object.entries(defaults)) {
        if (typeof val === "number" && !key.startsWith("__") && key !== "leverage") {
          const step = val >= 10 ? 1 : val >= 1 ? 0.5 : 0.1;
          const min = Math.max(0, val * 0.5);
          const max = val * 2;
          params.push({
            name: key,
            min: Number(min.toFixed(4)).toString(),
            max: Number(max.toFixed(4)).toString(),
            step: step.toString(),
            enabled: false,
          });
        }
      }
      setScanParams(params);
    }
  }, [defaultsQuery.data]);

  // ========== WebSocket 即時進度推送（主要通道） ==========
  useBacktestWs({
    jobId: phase === "running" ? scanId : null,
    onProgress: useCallback((data: any) => {
      setWsStatus({
        phase: data.phase,
        phaseProgress: data.phaseProgress,
        preloadMessage: data.preloadMessage,
        progress: data.progress,
        currentGeneration: data.currentGeneration,
        maxGenerations: data.maxGenerations,
        currentBest: data.currentBest,
        fitnessHistory: data.fitnessHistory,
        completedCombinations: data.completedCombinations,
        totalCombinations: data.totalCombinations,
      });
    }, []),
    onComplete: useCallback(() => {
      setPhase("done");
      setWsStatus({});
      utils.backtest.getScanActiveJobs.invalidate();
      utils.backtest.getScanActiveCount.invalidate();
      utils.backtest.listScanHistory.invalidate();
      utils.backtest.getScanStatus.invalidate();
      toast.success("參數優化完成！");
    }, [utils]),
    onError: useCallback((data: any) => {
      setPhase("failed");
      setWsStatus({});
      utils.backtest.getScanActiveJobs.invalidate();
      utils.backtest.getScanActiveCount.invalidate();
      toast.error(data.error ?? "優化失敗");
    }, [utils]),
  });

  // ========== 輪詢進度（備援通道：WebSocket 斷線時仍能追蹤） ==========
  const [errorCount, setErrorCount] = useState(0);
  useEffect(() => {
    const s = statusQuery.data;
    if (!s) return;
    setErrorCount(0);
    if (s.status === "completed") {
      setPhase("done");
      setWsStatus({});
      utils.backtest.getScanActiveJobs.invalidate();
      utils.backtest.getScanActiveCount.invalidate();
      utils.backtest.listScanHistory.invalidate();
      toast.success("參數優化完成！");
    } else if (s.status === "failed") {
      setPhase("failed");
      setWsStatus({});
      utils.backtest.getScanActiveJobs.invalidate();
      utils.backtest.getScanActiveCount.invalidate();
      toast.error(s.error ?? "優化失敗");
    }
  }, [statusQuery.data]);

  // 處理狀態查詢失敗（容忍短暫網絡波動）
  useEffect(() => {
    if (statusQuery.isError && phase === "running") {
      setErrorCount((prev) => {
        const next = prev + 1;
        if (next >= 15) {
          setPhase("failed");
          toast.error("連線中斷，請重新啟動優化");
        }
        return next;
      });
    }
  }, [statusQuery.isError, phase]);

  // ========== 計算組合數（手動模式） ==========
  const enabledParams = useMemo(() => scanParams.filter((p) => p.enabled), [scanParams]);
  const combinationCount = useMemo(() => {
    let count = 1;
    for (const p of enabledParams) {
      const min = parseFloat(p.min);
      const max = parseFloat(p.max);
      const step = parseFloat(p.step);
      if (!isNaN(min) && !isNaN(max) && !isNaN(step) && step > 0) {
        count *= Math.floor((max - min) / step + 1e-9) + 1;
      }
    }
    return count;
  }, [enabledParams]);

  const totalTasks = combinationCount * symbols.length;

  // ========== 提交智能掃描 ==========
  const handleSmartSubmit = async () => {
    const capital = Number(initialCapital);
    if (!capital || capital <= 0) return toast.error("初始資金必須大於 0");
    if (!strategyKey) return toast.error("請選擇策略");
    const startMs = new Date(startDate + "T00:00:00Z").getTime();
    const endMs = new Date(endDate + "T23:59:59Z").getTime();
    if (endMs <= startMs) return toast.error("結束日期必須晚於開始日期");

    const defaults = defaultsQuery.data as Record<string, unknown> | undefined;
    if (!defaults) return toast.error("策略參數尚未載入，請稍候");

    const parameterRanges: Array<{ name: string; min: number; max: number; step: number }> = [];
    for (const [key, val] of Object.entries(defaults)) {
      if (typeof val === "number" && !key.startsWith("__") && key !== "leverage") {
        const step = val >= 10 ? 1 : val >= 1 ? 0.5 : 0.1;
        const min = Math.max(0, val * 0.5);
        const max = val * 2;
        parameterRanges.push({ name: key, min, max, step });
      }
    }

    if (parameterRanges.length === 0) return toast.error("策略無可優化參數");

    try {
      const { scanId: id } = await submitMutation.mutateAsync({
        strategyKey,
        strategyName: strategiesQuery.find((s) => s.key === strategyKey)?.name,
        symbols,
        timeframe,
        startDate: startMs,
        endDate: endMs,
        initialCapital: capital,
        baseConfig: defaults ?? {},
        parameters: [],
        parameterRanges,
        mode: scanMode,
        walkForward,
        objective: "compositeScore",
        objectiveWeights: weights,
        exchange,
      });
      setScanId(id);
      setPhase("running");
      setErrorCount(0);
      utils.backtest.getScanActiveJobs.invalidate();
      utils.backtest.getScanActiveCount.invalidate();
      toast.success(`✅ 已加入佇列！${SCAN_MODE_CONFIG[scanMode].label}模式優化已啟動，可自由瀏覽其他頁面`);
      setActiveTab("queue");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "提交失敗");
    }
  };

  // ========== 提交手動掃描 ==========
  const handleManualSubmit = async () => {
    const capital = Number(initialCapital);
    if (!capital || capital <= 0) return toast.error("初始資金必須大於 0");
    const startMs = new Date(startDate + "T00:00:00Z").getTime();
    const endMs = new Date(endDate + "T23:59:59Z").getTime();
    if (endMs <= startMs) return toast.error("結束日期必須晚於開始日期");
    if (enabledParams.length === 0) return toast.error("請勾選至少一個掃描參數");
    if (totalTasks > 50000) return toast.error(`總任務數 ${totalTasks} 超過上限 50,000，請減少參數範圍或交易對`);

    const parameters = enabledParams.map((p) => {
      const min = parseFloat(p.min);
      const max = parseFloat(p.max);
      const step = parseFloat(p.step);
      const values: number[] = [];
      for (let v = min; v <= max + 1e-9; v += step) {
        values.push(Math.round(v * 1e8) / 1e8);
      }
      return { name: p.name, values };
    });

    try {
      const { scanId: id } = await submitMutation.mutateAsync({
        strategyKey,
        strategyName: strategiesQuery.find((s) => s.key === strategyKey)?.name,
        symbols,
        timeframe,
        startDate: startMs,
        endDate: endMs,
        initialCapital: capital,
        baseConfig: (defaultsQuery.data as Record<string, unknown>) ?? {},
        parameters,
        mode: "manual",
        walkForward: false,
        objective: "compositeScore",
        objectiveWeights: weights,
        exchange,
      });
      setScanId(id);
      setPhase("running");
      setErrorCount(0);
      utils.backtest.getScanActiveJobs.invalidate();
      utils.backtest.getScanActiveCount.invalidate();
      toast.success("✅ 網格掃描已加入佇列，可自由瀏覽其他頁面");
      setActiveTab("queue");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "提交失敗");
    }
  };

  // ========== 中止掃描 ==========
  const handleAbortJob = async (targetScanId: string) => {
    try {
      await abortMutation.mutateAsync({ scanId: targetScanId });
      utils.backtest.getScanActiveJobs.invalidate();
      utils.backtest.getScanActiveCount.invalidate();
      if (targetScanId === scanId) {
        setPhase("idle");
      }
      toast.info("掃描已中止");
    } catch {
      toast.error("中止失敗");
    }
  };

  const handleAbort = async () => {
    if (!scanId) return;
    await handleAbortJob(scanId);
  };

  // ========== 參數操作 ==========
  const toggleParam = (idx: number) => {
    setScanParams((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], enabled: !next[idx].enabled };
      return next;
    });
  };

  const updateParam = (idx: number, field: keyof ScanParam, value: string) => {
    setScanParams((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const addSymbol = () => {
    if (symbols.length >= 3) return toast.error("最多支援 3 個交易對");
    setSymbols((prev) => [...prev, ""]);
  };

  const removeSymbol = (idx: number) => {
    if (symbols.length <= 1) return;
    setSymbols((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateSymbol = (idx: number, val: string) => {
    setSymbols((prev) => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  };

  // ========== 歷史操作 ==========
  const toggleHistorySelect = (id: number) => {
    setSelectedHistoryIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleDeleteHistory = async (id: number) => {
    try {
      await deleteMutation.mutateAsync({ id });
      historyQuery.refetch();
      toast.success("已刪除");
    } catch {
      toast.error("刪除失敗");
    }
  };

  // ========== 重置狀態 ==========
  const handleReset = () => {
    setPhase("idle");
    setScanId(null);
  };

  // ========== 格式化 ==========
  const fmtPct = (v: number | undefined | null) => v != null ? `${(v * 100).toFixed(2)}%` : "—";
  const fmtNum = (v: number | undefined | null, d = 2) => v != null ? v.toFixed(d) : "—";
  const fmtDate = (d: Date | string | number | undefined | null) => {
    if (!d) return "—";
    const date = d instanceof Date ? d : new Date(d);
    return date.toLocaleDateString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };

  // ============================================================
  // 渲染：共用配置區
  // ============================================================

  const renderConfigSection = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide">策略</Label>
        <Select value={strategyKey} onValueChange={setStrategyKey}>
          <SelectTrigger className="bg-background/50 border-border/50">
            <SelectValue placeholder="選擇策略" />
          </SelectTrigger>
          <SelectContent>
            {strategiesQuery.map((s) => (
              <SelectItem key={s.key} value={s.key}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide">數據源</Label>
        <Select value={exchange} onValueChange={(v) => setExchange(v as "okx" | "bybit")}>
          <SelectTrigger className="bg-background/50 border-border/50">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="okx">OKX</SelectItem>
            <SelectItem value="bybit">Bybit</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide">時間框架</Label>
        <Select value={timeframe} onValueChange={setTimeframe}>
          <SelectTrigger className="bg-background/50 border-border/50">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEFRAMES.map((tf) => (
              <SelectItem key={tf} value={tf}>{tf}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide">開始日期</Label>
        <Input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="bg-background/50 border-border/50"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide">結束日期</Label>
        <Input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="bg-background/50 border-border/50"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide">初始資金 (USDT)</Label>
        <Input
          type="number"
          value={initialCapital}
          onChange={(e) => setInitialCapital(e.target.value)}
          className="bg-background/50 border-border/50"
        />
      </div>

      <div className="space-y-2 md:col-span-2 lg:col-span-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">
            交易對 ({symbols.length}/3)
          </Label>
          <Button variant="ghost" size="sm" onClick={addSymbol} disabled={symbols.length >= 3}>
            <Plus className="w-3 h-3 mr-1" /> 新增
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {symbols.map((sym, idx) => (
            <div key={idx} className="flex items-center gap-1">
              <Input
                value={sym}
                onChange={(e) => updateSymbol(idx, e.target.value)}
                placeholder="BTC-USDT-SWAP"
                className="w-44 bg-background/50 border-border/50 text-sm"
              />
              {symbols.length > 1 && (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeSymbol(idx)}>
                  <X className="w-3 h-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // ============================================================
  // 渲染：目標權重
  // ============================================================

  const renderWeights = () => (
    <div className="space-y-3">
      <Label className="text-xs text-muted-foreground uppercase tracking-wide">
        多目標優化權重
      </Label>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {(Object.keys(weights) as Array<keyof ObjectiveWeights>).map((key) => (
          <div key={key} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{WEIGHT_LABELS[key]}</span>
              <span className="text-xs font-mono text-foreground">{(weights[key] * 100).toFixed(0)}%</span>
            </div>
            <Slider
              value={[weights[key] * 100]}
              onValueChange={([v]) => setWeights((prev) => ({ ...prev, [key]: v / 100 }))}
              min={0}
              max={100}
              step={5}
              className="h-1.5"
            />
          </div>
        ))}
      </div>
    </div>
  );

  // ============================================================
  // 渲染：進度面板
  // ============================================================

  const renderProgressPanel = () => {
    // 優先使用 WebSocket 即時狀態，備援使用輪詢數據
    const ws = wsStatus;
    const poll = statusQuery.data;
    const status = {
      phase: ws.phase ?? poll?.phase,
      phaseProgress: ws.phaseProgress ?? poll?.phaseProgress,
      preloadMessage: ws.preloadMessage ?? poll?.preloadMessage,
      progress: ws.progress ?? poll?.progress ?? 0,
      currentGeneration: ws.currentGeneration ?? poll?.currentGeneration,
      maxGenerations: ws.maxGenerations ?? poll?.maxGenerations,
      currentBest: ws.currentBest ?? poll?.currentBest,
      fitnessHistory: ws.fitnessHistory ?? poll?.fitnessHistory,
      completedCombinations: ws.completedCombinations ?? poll?.completedCombinations,
      totalCombinations: ws.totalCombinations ?? poll?.totalCombinations,
    };
    if (!status.phase && phase !== "running") return null;

    const currentPhase: string = status.phase ?? (phase === "running" ? "preloading" : "evolution");
    const isGridMode = currentPhase === "grid";
    const phaseOrder = isGridMode
      ? ["preloading", "grid"]
      : ["preloading", "initializing", "evolution", "refinement", "validation"];
    const currentPhaseIdx = phaseOrder.indexOf(currentPhase);
    const progressPct = status.progress;
    const isPreloading = currentPhase === "preloading" || currentPhase === "initializing";

    return (
      <Card className="border-border/50 bg-card/80 backdrop-blur">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400 animate-pulse" />
              {isPreloading ? "數據預載中" : "優化進行中"}
            </CardTitle>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleAbort}
              disabled={abortMutation.isPending}
            >
              <StopCircle className="w-3.5 h-3.5 mr-1" />
              中止
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 預載提示卡片 */}
          {isPreloading && (
            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                <span className="text-sm font-medium text-blue-300">正在下載歷史 K 線數據</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {status.preloadMessage ?? "正在從交易所下載歷史數據，這通常需要 20-40 秒..."}
              </p>
              {status.phaseProgress != null && status.phaseProgress > 0 && (
                <Progress value={status.phaseProgress} className="h-1.5 mt-2" />
              )}
            </div>
          )}

          {/* 階段指示器 */}
          <div className="flex items-center gap-1">
            {phaseOrder.map((p, idx) => {
              const info = PHASE_LABELS[p];
              const isActive = idx === currentPhaseIdx;
              const isDone = idx < currentPhaseIdx;
              return (
                <div key={p} className="flex items-center gap-1 flex-1">
                  <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-all ${
                    isActive ? "bg-primary/20 text-primary border border-primary/30" :
                    isDone ? "bg-emerald-500/10 text-emerald-400" :
                    "text-muted-foreground/50"
                  }`}>
                    {isDone ? <CheckCircle2 className="w-3 h-3" /> : <span>{info?.icon}</span>}
                    <span className="hidden sm:inline">{info?.label}</span>
                  </div>
                  {idx < phaseOrder.length - 1 && (
                    <ArrowRight className={`w-3 h-3 shrink-0 ${isDone ? "text-emerald-400" : "text-muted-foreground/30"}`} />
                  )}
                </div>
              );
            })}
          </div>

          {/* 進度條 */}
          {!isPreloading && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {status.currentGeneration != null && status.maxGenerations
                  ? `第 ${status.currentGeneration} / ${status.maxGenerations} 代`
                  : `進度 ${progressPct.toFixed(0)}%`}
              </span>
              <span className="text-muted-foreground">
                {status.completedCombinations ?? 0} / {status.totalCombinations ?? "?"} 評估
              </span>
            </div>
            <Progress value={progressPct} className="h-2" />
          </div>
          )}

          {/* 連線重試提示 */}
          {errorCount > 0 && errorCount < 15 && (
            <div className="text-xs text-amber-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              網絡波動，正在重新連線... ({errorCount}/15)
            </div>
          )}

          {/* 當前最佳 */}
          {status.currentBest && (
            <div className="grid grid-cols-3 gap-3 p-3 rounded-lg bg-background/50 border border-border/30">
              <div className="text-center">
                <div className="text-xs text-muted-foreground">綜合評分</div>
                <div className="text-sm font-mono font-bold text-primary">
                  {status.currentBest.score.toFixed(4)}
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-muted-foreground">總回報</div>
                <div className="text-sm font-mono font-bold text-emerald-400">
                  {fmtPct(status.currentBest.totalReturn)}
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-muted-foreground">勝率</div>
                <div className="text-sm font-mono font-bold text-blue-400">
                  {fmtPct(status.currentBest.winRate)}
                </div>
              </div>
            </div>
          )}

          {/* 進化適應度曲線 */}
          {status.fitnessHistory && status.fitnessHistory.length > 1 && (
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={status.fitnessHistory!}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="generation" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <RechartsTooltip
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }}
                    labelStyle={{ color: "hsl(var(--foreground))" }}
                  />
                  <Line type="monotone" dataKey="bestScore" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="最佳適應度" />
                  <Line type="monotone" dataKey="avgScore" stroke="hsl(var(--muted-foreground))" strokeWidth={1} dot={false} name="平均適應度" strokeDasharray="4 4" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  // ============================================================
  // 渲染：結果面板
  // ============================================================

  const renderResultsPanel = () => {
    const status = statusQuery.data;
    const results = status?.results;
    if (!results) return null;

    const evoResult = results.evolutionResult;

    return (
      <div className="space-y-4">
        {/* 最佳參數卡片 */}
        {results.best && (
          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Award className="w-4 h-4 text-amber-400" />
                最佳參數組合
                {evoResult?.mode && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    {SCAN_MODE_CONFIG[evoResult.mode as ScanMode]?.label ?? evoResult.mode} 模式
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <MetricCard label="總回報" value={fmtPct(results.best.metrics.totalReturn)} color="text-emerald-400" />
                <MetricCard label="勝率" value={fmtPct(results.best.metrics.winRate)} color="text-blue-400" />
                <MetricCard label="夏普比率" value={fmtNum(results.best.metrics.sharpeRatio)} color="text-purple-400" />
                <MetricCard label="最大回撤" value={fmtPct(results.best.metrics.maxDrawdown)} color="text-red-400" />
                <MetricCard label="利潤因子" value={fmtNum(results.best.metrics.profitFactor)} color="text-amber-400" />
                <MetricCard label="總交易數" value={String(results.best.metrics.totalTrades)} color="text-cyan-400" />
                <MetricCard label="綜合評分" value={results.best.compositeScore.toFixed(4)} color="text-primary" />
                {evoResult && <MetricCard label="總評估次數" value={String(evoResult.totalEvaluations)} color="text-muted-foreground" />}
              </div>

              <div className="p-3 rounded-lg bg-background/50 border border-border/30">
                <div className="text-xs text-muted-foreground mb-2">最佳參數</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(results.best.combination).map(([k, v]) => (
                    <Badge key={k} variant="secondary" className="font-mono text-xs">
                      {k}: {typeof v === "number" ? v.toFixed(4) : v}
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    const params = results.best?.combination;
                    if (params) {
                      navigator.clipboard.writeText(JSON.stringify(params, null, 2));
                      toast.success("最佳參數已複製到剪貼板");
                    }
                  }}
                >
                  <Copy className="w-3.5 h-3.5 mr-1" />
                  複製參數
                </Button>
                <Button size="sm" variant="outline" onClick={handleReset}>
                  重新優化
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Walk-Forward 驗證結果 */}
        {evoResult?.walkForwardResult && (
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="w-4 h-4 text-purple-400" />
                Walk-Forward 穩健性驗證
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <MetricCard
                  label="穩健性評分"
                  value={`${evoResult.walkForwardResult.robustnessScore.toFixed(0)}/100`}
                  color={evoResult.walkForwardResult.robustnessScore >= 70 ? "text-emerald-400" : "text-amber-400"}
                />
                <MetricCard
                  label="過擬合指數"
                  value={`${evoResult.walkForwardResult.overfitIndex.toFixed(0)}/100`}
                  color={evoResult.walkForwardResult.overfitIndex <= 30 ? "text-emerald-400" : "text-red-400"}
                />
                <MetricCard
                  label="樣本內回報"
                  value={fmtPct(evoResult.walkForwardResult.inSampleMetrics.totalReturn)}
                  color="text-blue-400"
                />
                <MetricCard
                  label="樣本外回報"
                  value={fmtPct(evoResult.walkForwardResult.outOfSampleMetrics.totalReturn)}
                  color="text-cyan-400"
                />
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                訓練/驗證分割比例：{((evoResult.walkForwardResult.splitRatio) * 100).toFixed(0)}% / {((1 - evoResult.walkForwardResult.splitRatio) * 100).toFixed(0)}%
              </div>
            </CardContent>
          </Card>
        )}

        {/* 參數重要性排名 */}
        {evoResult?.parameterImportance && evoResult.parameterImportance.length > 0 && (
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-amber-400" />
                參數重要性排名
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={[...evoResult.parameterImportance].sort((a, b) => b.importance - a.importance).slice(0, 10)}
                    layout="vertical"
                    margin={{ left: 80, right: 20 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={75} />
                    <RechartsTooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }}
                    />
                    <Bar dataKey="importance" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} name="重要性" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Pareto 前沿 */}
        {results.paretoFront && results.paretoFront.length > 1 && (
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Target className="w-4 h-4 text-cyan-400" />
                Pareto 前沿（回報 vs 回撤）
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ left: 10, right: 10, top: 10, bottom: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                    <XAxis
                      type="number"
                      dataKey="x"
                      name="最大回撤"
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    />
                    <YAxis
                      type="number"
                      dataKey="y"
                      name="總回報"
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    />
                    <RechartsTooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }}
                    />
                    <Scatter
                      name="Pareto 前沿"
                      data={results.paretoFront.map((item) => ({
                        x: item.metrics.maxDrawdown * 100,
                        y: item.metrics.totalReturn * 100,
                      }))}
                      fill="hsl(var(--primary))"
                    >
                      {results.paretoFront.map((_, idx) => (
                        <Cell key={idx} fill={idx === 0 ? "#f59e0b" : "hsl(var(--primary))"} />
                      ))}
                    </Scatter>
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* 熱力圖 */}
        {results.heatmapData && results.param1Name && results.param2Name && (
          <HeatmapChart
            data={results.heatmapData}
            param1Name={results.param1Name}
            param2Name={results.param2Name}
            objectiveName="綜合評分"
          />
        )}

        {/* 敏感性分析 */}
        {results.sensitivityAnalysis && Object.keys(results.sensitivityAnalysis).length > 0 && (
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-blue-400" />
                參數敏感性分析
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {Object.entries(results.sensitivityAnalysis).slice(0, 6).map(([paramName, data]) => (
                  <div key={paramName} className="h-32">
                    <div className="text-xs text-muted-foreground mb-1">{paramName}</div>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data as Array<{ value: number; avgScore: number }>}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.2} />
                        <XAxis dataKey="value" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                        <Line type="monotone" dataKey="avgScore" stroke="hsl(var(--primary))" strokeWidth={1.5} dot={{ r: 2 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* 全部結果排行榜 */}
        {results.allResults && results.allResults.length > 0 && (
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">結果排行榜 (Top 20)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>交易對</TableHead>
                      <TableHead>綜合評分</TableHead>
                      <TableHead>總回報</TableHead>
                      <TableHead>勝率</TableHead>
                      <TableHead>夏普</TableHead>
                      <TableHead>最大回撤</TableHead>
                      <TableHead>Pareto</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.allResults.slice(0, 20).map((item, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-mono text-xs">{idx + 1}</TableCell>
                        <TableCell className="text-xs">{item.symbol}</TableCell>
                        <TableCell className="font-mono text-xs font-bold">{item.compositeScore.toFixed(4)}</TableCell>
                        <TableCell className={`font-mono text-xs ${item.metrics.totalReturn >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {fmtPct(item.metrics.totalReturn)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{fmtPct(item.metrics.winRate)}</TableCell>
                        <TableCell className="font-mono text-xs">{fmtNum(item.metrics.sharpeRatio)}</TableCell>
                        <TableCell className="font-mono text-xs text-red-400">{fmtPct(item.metrics.maxDrawdown)}</TableCell>
                        <TableCell>{item.isParetoOptimal && <Badge variant="outline" className="text-[10px]">P</Badge>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    );
  };

  // ============================================================
  // 渲染：智能模式 Tab
  // ============================================================

  const renderSmartTab = () => (
    <div className="space-y-6">
          <Card className="border-border/50 bg-card/80">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="w-4 h-4 text-primary" />
                NSGA-II 智能優化配置
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {renderConfigSection()}

              {/* 掃描模式選擇 */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground uppercase tracking-wide">掃描模式</Label>
                <div className="grid grid-cols-3 gap-3">
                  {(Object.keys(SCAN_MODE_CONFIG) as ScanMode[]).map((mode) => {
                    const cfg = SCAN_MODE_CONFIG[mode];
                    const isActive = scanMode === mode;
                    return (
                      <button
                        key={mode}
                        onClick={() => setScanMode(mode)}
                        className={`p-3 rounded-lg border text-left transition-all ${
                          isActive
                            ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                            : "border-border/50 bg-background/30 hover:border-border"
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          {mode === "fast" && <Zap className="w-3.5 h-3.5 text-amber-400" />}
                          {mode === "standard" && <Gauge className="w-3.5 h-3.5 text-blue-400" />}
                          {mode === "deep" && <Dna className="w-3.5 h-3.5 text-purple-400" />}
                          <span className="text-sm font-medium">{cfg.label}</span>
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {cfg.generations} 代 · {cfg.time}
                        </div>
                        <div className="text-[10px] text-muted-foreground/70 mt-0.5">{cfg.description}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Walk-Forward 開關 */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-background/50 border border-border/30">
                <Checkbox
                  id="walkforward"
                  checked={walkForward}
                  onCheckedChange={(v) => setWalkForward(!!v)}
                />
                <div>
                  <Label htmlFor="walkforward" className="text-sm cursor-pointer">Walk-Forward 穩健性驗證</Label>
                  <p className="text-[11px] text-muted-foreground">將數據分為訓練期和驗證期，防止過擬合</p>
                </div>
              </div>

              {renderWeights()}
            </CardContent>
          </Card>

          {/* 一鍵開始按鈕 */}
          <Button
            size="lg"
            className="w-full h-14 text-base font-bold bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-lg shadow-primary/20"
            onClick={handleSmartSubmit}
            disabled={submitMutation.isPending || !strategyKey}
          >
            {submitMutation.isPending ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : <Brain className="w-5 h-5 mr-2" />}
            開始智能優化
            <Badge variant="secondary" className="ml-3 text-xs">
              {SCAN_MODE_CONFIG[scanMode].label} · {SCAN_MODE_CONFIG[scanMode].generations} 代
            </Badge>
          </Button>

          {/* 進度面板（運行中顯示） */}
          {phase === "running" && renderProgressPanel()}

          {/* 結果面板（完成後顯示） */}
          {phase === "done" && renderResultsPanel()}
    </div>
  );

  // ============================================================
  // 渲染：手動進階模式 Tab
  // ============================================================

  const renderManualTab = () => (
    <div className="space-y-6">
          <Card className="border-border/50 bg-card/80">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Settings2 className="w-4 h-4 text-muted-foreground" />
                手動網格搜索配置
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {renderConfigSection()}
              {renderWeights()}
            </CardContent>
          </Card>

          {/* 參數勾選表 */}
          <Card className="border-border/50 bg-card/80">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">掃描參數 ({enabledParams.length} 個已選)</CardTitle>
                <Badge variant={totalTasks > 50000 ? "destructive" : totalTasks > 5000 ? "outline" : "secondary"} className="text-xs">
                  組合數：{totalTasks.toLocaleString()}
                  {totalTasks > 0 && ` (~${Math.ceil(totalTasks * 3 / 60)} 分鐘)`}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {scanParams.length === 0 ? (
                <div className="text-center text-sm text-muted-foreground py-8">
                  {strategyKey ? "載入中..." : "請先選擇策略"}
                </div>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {scanParams.map((p, idx) => (
                    <div
                      key={p.name}
                      className={`flex items-center gap-3 p-2.5 rounded-lg border transition-all ${
                        p.enabled ? "border-primary/30 bg-primary/5" : "border-border/30 bg-background/30"
                      }`}
                    >
                      <Checkbox
                        checked={p.enabled}
                        onCheckedChange={() => toggleParam(idx)}
                      />
                      <span className="text-sm font-mono w-40 truncate">{p.name}</span>
                      <Input
                        type="number"
                        value={p.min}
                        onChange={(e) => updateParam(idx, "min", e.target.value)}
                        className="w-20 h-7 text-xs bg-background/50"
                        placeholder="Min"
                        disabled={!p.enabled}
                      />
                      <span className="text-muted-foreground text-xs">→</span>
                      <Input
                        type="number"
                        value={p.max}
                        onChange={(e) => updateParam(idx, "max", e.target.value)}
                        className="w-20 h-7 text-xs bg-background/50"
                        placeholder="Max"
                        disabled={!p.enabled}
                      />
                      <span className="text-muted-foreground text-xs">步長</span>
                      <Input
                        type="number"
                        value={p.step}
                        onChange={(e) => updateParam(idx, "step", e.target.value)}
                        className="w-20 h-7 text-xs bg-background/50"
                        placeholder="Step"
                        disabled={!p.enabled}
                      />
                    </div>
                  ))}
                </div>
              )}

              {totalTasks > 50000 && (
                <div className="mt-3 p-2 rounded bg-destructive/10 border border-destructive/30 text-xs text-destructive">
                  總任務數 {totalTasks.toLocaleString()} 超過上限 50,000，請減少參數範圍或交易對
                </div>
              )}
              {totalTasks > 5000 && totalTasks <= 50000 && (
                <div className="mt-3 p-2 rounded bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400">
                  組合數較多（{totalTasks.toLocaleString()}），預計需要 ~{Math.ceil(totalTasks * 3 / 60)} 分鐘。建議使用智能模式可更高效搜索。
                </div>
              )}
            </CardContent>
          </Card>

          <Button
            size="lg"
            className="w-full h-12"
            onClick={handleManualSubmit}
            disabled={submitMutation.isPending || enabledParams.length === 0 || totalTasks > 50000 || totalTasks === 0}
          >
            {submitMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
            開始網格掃描
            <span className="ml-2 text-xs text-muted-foreground">({totalTasks} 個組合)</span>
          </Button>

          {/* 進度面板（運行中顯示） */}
          {phase === "running" && renderProgressPanel()}

          {/* 結果面板（完成後顯示） */}
          {phase === "done" && renderResultsPanel()}
    </div>
  );
  // ============================================================
  // 渲染：歷史記錄 Tab
  // ============================================================

  const renderHistoryTab = () => {
    const historyRaw = historyQuery.data as any;
    const history = (Array.isArray(historyRaw) ? historyRaw : historyRaw?.items ?? []) as Array<{
      id: number;
      scanId: string;
      strategyKey: string;
      strategyName: string;
      symbols: string[];
      timeframe: string;
      status: string;
      bestScore?: number;
      bestParams?: Record<string, number>;
      mode?: string;
      totalCombinations: number;
      completedCombinations: number;
      createdAt: Date | string;
      completedAt?: Date | string;
    }>;

    if (viewingDetailId && detailQuery.data) {
      const detail = detailQuery.data as any;
      return (
        <div className="space-y-4">
          <Button variant="ghost" size="sm" onClick={() => setViewingDetailId(null)}>
            ← 返回列表
          </Button>
          {detail && (
            <div className="space-y-4">
              {detail.best && (
                <Card className="border-emerald-500/30 bg-emerald-500/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Award className="w-4 h-4 text-amber-400" />
                      最佳結果
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                      <MetricCard label="總回報" value={fmtPct(detail.best.metrics?.totalReturn)} color="text-emerald-400" />
                      <MetricCard label="勝率" value={fmtPct(detail.best.metrics?.winRate)} color="text-blue-400" />
                      <MetricCard label="夏普比率" value={fmtNum(detail.best.metrics?.sharpeRatio)} color="text-purple-400" />
                      <MetricCard label="最大回撤" value={fmtPct(detail.best.metrics?.maxDrawdown)} color="text-red-400" />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {detail.best.combination && Object.entries(detail.best.combination).map(([k, v]) => (
                        <Badge key={k} variant="secondary" className="font-mono text-xs">
                          {k}: {typeof v === "number" ? (v as number).toFixed(4) : String(v)}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {detail.heatmapData && detail.param1Name && detail.param2Name && (
                <HeatmapChart
                  data={detail.heatmapData}
                  param1Name={detail.param1Name}
                  param2Name={detail.param2Name}
                  objectiveName="綜合評分"
                />
              )}

              {detail.allResults && detail.allResults.length > 0 && (
                <Card className="border-border/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">結果排行榜</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-10">#</TableHead>
                            <TableHead>交易對</TableHead>
                            <TableHead>評分</TableHead>
                            <TableHead>回報</TableHead>
                            <TableHead>勝率</TableHead>
                            <TableHead>回撤</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {detail.allResults.slice(0, 15).map((item: any, idx: number) => (
                            <TableRow key={idx}>
                              <TableCell className="font-mono text-xs">{idx + 1}</TableCell>
                              <TableCell className="text-xs">{item.symbol}</TableCell>
                              <TableCell className="font-mono text-xs">{item.compositeScore?.toFixed(4)}</TableCell>
                              <TableCell className={`font-mono text-xs ${(item.metrics?.totalReturn ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                {fmtPct(item.metrics?.totalReturn)}
                              </TableCell>
                              <TableCell className="font-mono text-xs">{fmtPct(item.metrics?.winRate)}</TableCell>
                              <TableCell className="font-mono text-xs text-red-400">{fmtPct(item.metrics?.maxDrawdown)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">
            掃描歷史 ({history?.length ?? 0} 筆)
          </h3>
          {selectedHistoryIds.length >= 2 && (
            <Button size="sm" variant="outline" onClick={() => setActiveTab("compare")}>
              <GitCompare className="w-3.5 h-3.5 mr-1" />
              對比 ({selectedHistoryIds.length})
            </Button>
          )}
        </div>

        {!history || history.length === 0 ? (
          <Card className="border-border/50">
            <CardContent className="py-12 text-center text-muted-foreground text-sm">
              尚無掃描記錄
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {history.map((item) => (
              <Card key={item.id} className="border-border/30 hover:border-border/60 transition-colors">
                <CardContent className="py-3 px-4">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={selectedHistoryIds.includes(item.id)}
                      onCheckedChange={() => toggleHistorySelect(item.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium truncate">{item.strategyName || item.strategyKey}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {item.mode === "manual" ? "手動" : item.mode ?? "標準"}
                        </Badge>
                        <Badge
                          variant={item.status === "completed" ? "default" : item.status === "failed" ? "destructive" : "secondary"}
                          className="text-[10px]"
                        >
                          {item.status === "completed" ? "完成" : item.status === "failed" ? "失敗" : "進行中"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{(item.symbols ?? []).join(", ")}</span>
                        <span>{item.timeframe}</span>
                        <span>{item.completedCombinations}/{item.totalCombinations} 組合</span>
                        <span>{fmtDate(item.createdAt)}</span>
                      </div>
                    </div>
                    {item.bestScore != null && (
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">最佳評分</div>
                        <div className="text-sm font-mono font-bold text-primary">{item.bestScore.toFixed(4)}</div>
                      </div>
                    )}
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setViewingDetailId(item.id)}>
                        <Eye className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteHistory(item.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ============================================================
  // 渲染：對比 Tab
  // ============================================================

  const renderCompareTab = () => {
    const compareData = compareQuery.data as Array<{ id: number; summary: any; config: any }> | undefined;

    if (selectedHistoryIds.length < 2) {
      return (
        <Card className="border-border/50">
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            請在「歷史記錄」中勾選至少 2 筆記錄進行對比
          </CardContent>
        </Card>
      );
    }

    if (!compareData) {
      return (
        <Card className="border-border/50">
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            載入中...
          </CardContent>
        </Card>
      );
    }

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">
            對比 {compareData.length} 筆結果
          </h3>
          <Button size="sm" variant="ghost" onClick={() => setSelectedHistoryIds([])}>
            清除選擇
          </Button>
        </div>

        <Card className="border-border/50">
          <CardContent className="py-4">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>指標</TableHead>
                    {compareData.map((item) => (
                      <TableHead key={item.id} className="text-center">
                        #{item.id}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    { key: "compositeScore", label: "綜合評分" },
                    { key: "totalReturn", label: "總回報" },
                    { key: "winRate", label: "勝率" },
                    { key: "sharpeRatio", label: "夏普比率" },
                    { key: "profitFactor", label: "利潤因子" },
                    { key: "maxDrawdown", label: "最大回撤" },
                    { key: "totalTrades", label: "總交易數" },
                  ].map((metric) => (
                    <TableRow key={metric.key}>
                      <TableCell className="text-xs font-medium">{metric.label}</TableCell>
                      {compareData.map((item) => {
                        const best = item.summary?.best;
                        let val: string = "—";
                        if (best?.metrics) {
                          const raw = metric.key === "compositeScore" ? best.compositeScore : best.metrics[metric.key];
                          if (raw != null) {
                            val = ["totalReturn", "winRate", "maxDrawdown"].includes(metric.key)
                              ? fmtPct(raw)
                              : typeof raw === "number" ? raw.toFixed(4) : String(raw);
                          }
                        }
                        return (
                          <TableCell key={item.id} className="text-center font-mono text-xs">
                            {val}
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
      </div>
    );
  };

  // ============================================================
  // 渲染：掃描佇列 Tab
  // ============================================================

  const renderQueueTab = () => {
    const jobs = activeJobsQuery.data ?? [];
    const hasJobs = jobs.length > 0;

    return (
      <div className="space-y-4">
        {/* 佇列概覽 */}
        <Card className="border-border/50 bg-card/80">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <ListOrdered className="w-4 h-4 text-primary" />
                掃描佇列
                {hasJobs && (
                  <Badge variant="secondary" className="text-xs">
                    {jobs.filter(j => j.status === "running").length} 運行中 / {jobs.filter(j => j.status === "pending").length} 等待中
                  </Badge>
                )}
              </CardTitle>
              <div className="text-xs text-muted-foreground">
                最多同時運行 3 個掃描
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {!hasJobs ? (
              <div className="text-center py-12 space-y-3">
                <div className="text-muted-foreground text-sm">目前沒有運行中的掃描任務</div>
                <p className="text-xs text-muted-foreground/70">在「智能優化」或「手動進階」分頁提交掃描後，任務會顯示在這裡</p>
                <Button variant="outline" size="sm" onClick={() => setActiveTab("smart")}>
                  <Brain className="w-3.5 h-3.5 mr-1.5" />
                  去提交掃描
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => (
                  <div
                    key={job.scanId}
                    className={`p-4 rounded-lg border transition-all ${
                      job.status === "running"
                        ? "border-emerald-500/30 bg-emerald-500/5"
                        : "border-amber-500/30 bg-amber-500/5"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {job.status === "running" ? (
                          <Loader2 className="w-4 h-4 text-emerald-400 animate-spin" />
                        ) : (
                          <div className="w-4 h-4 rounded-full border-2 border-amber-400 animate-pulse" />
                        )}
                        <span className="text-sm font-medium">
                          {job.strategyName || "未命名策略"}
                        </span>
                        <Badge variant="outline" className="text-[10px]">
                          {job.mode === "manual" ? "網格" : job.mode === "fast" ? "快速" : job.mode === "deep" ? "深度" : "標準"}
                        </Badge>

                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
                        onClick={() => handleAbortJob(job.scanId)}
                      >
                        中止
                      </Button>
                    </div>

                    {/* 任務詳情 */}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2">
                      <span>{job.symbols?.join(", ") || ""}</span>
                      <span>{job.timeframe || ""}</span>
                      {job.createdAt && (
                        <span>提交於 {new Date(job.createdAt).toLocaleTimeString()}</span>
                      )}
                    </div>

                    {/* 進度條 */}
                    {job.status === "running" && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">
                            {job.phase && PHASE_LABELS[job.phase]
                              ? `${PHASE_LABELS[job.phase].icon} ${PHASE_LABELS[job.phase].label}`
                              : "執行中"}
                            {job.preloadMessage && (
                              <span className="ml-2 text-blue-400">{job.preloadMessage}</span>
                            )}
                            {!job.preloadMessage && job.phase === "initializing" && (
                              <span className="ml-2 text-blue-400">種群初始化中...</span>
                            )}
                          </span>
                          <span className="font-mono">
                            {job.currentGeneration && job.maxGenerations
                              ? `第 ${job.currentGeneration}/${job.maxGenerations} 代`
                              : `${job.completedCombinations ?? 0}/${job.totalCombinations ?? 0} 評估`}
                          </span>
                        </div>
                        <Progress value={Math.max(job.progress, 1)} className="h-2" />
                        <div className="text-right text-[10px] text-muted-foreground">
                          {Math.round(job.progress)}%
                        </div>
                      </div>
                    )}

                    {job.status === "pending" && (
                      <div className="text-xs text-amber-400">等待中… 前方有任務執行中</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 提示信息 */}
        <div className="p-3 rounded-lg bg-blue-500/5 border border-blue-500/20 text-xs text-blue-300 space-y-1">
          <div className="font-medium">💡 提示</div>
          <ul className="list-disc list-inside space-y-0.5 text-blue-300/80">
            <li>掃描在後台運行，你可以自由瀏覽其他頁面</li>
            <li>完成後會自動發送 Telegram 通知</li>
            <li>結果會保存到「歷史記錄」分頁</li>
            <li>最多同時運行 3 個掃描，超出的會自動排隊</li>
          </ul>
        </div>
      </div>
    );
  };

  // ============================================================
  // 主渲染
  // ============================================================

  return (
    <DashboardLayout>
      <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
        {/* 頁面標題 */}
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-primary/10">
            <Dna className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">參數優化</h1>
            <p className="text-xs text-muted-foreground">NSGA-II 遺傳算法多目標智能優化</p>
          </div>
        </div>

        {/* 主 Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabView)}>
          <TabsList className="grid grid-cols-5 w-full max-w-2xl">
            <TabsTrigger value="smart" className="text-xs gap-1.5">
              <Brain className="w-3.5 h-3.5" />
              智能優化
            </TabsTrigger>
            <TabsTrigger value="manual" className="text-xs gap-1.5">
              <Settings2 className="w-3.5 h-3.5" />
              手動進階
            </TabsTrigger>
            <TabsTrigger value="queue" className="text-xs gap-1.5 relative">
              <ListOrdered className="w-3.5 h-3.5" />
              掃描佇列
              {(activeJobsQuery.data?.length ?? 0) > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 text-[9px] text-white flex items-center justify-center font-bold">
                  {activeJobsQuery.data?.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" className="text-xs gap-1.5">
              <History className="w-3.5 h-3.5" />
              歷史記錄
            </TabsTrigger>
            <TabsTrigger value="compare" className="text-xs gap-1.5">
              <GitCompare className="w-3.5 h-3.5" />
              對比
            </TabsTrigger>
          </TabsList>

          <TabsContent value="smart" className="mt-4">
            {activeTab === "smart" && renderSmartTab()}
          </TabsContent>
          <TabsContent value="manual" className="mt-4">
            {activeTab === "manual" && renderManualTab()}
          </TabsContent>
          <TabsContent value="queue" className="mt-4">
            {activeTab === "queue" && renderQueueTab()}
          </TabsContent>
          <TabsContent value="history" className="mt-4" forceMount>
            {activeTab === "history" && renderHistoryTab()}
          </TabsContent>
          <TabsContent value="compare" className="mt-4">
            {activeTab === "compare" && renderCompareTab()}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}

// ============================================================
// 子組件
// ============================================================

function MetricCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="p-2.5 rounded-lg bg-background/50 border border-border/30 text-center">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">{label}</div>
      <div className={`text-sm font-mono font-bold ${color}`}>{value}</div>
    </div>
  );
}
