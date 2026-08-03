/**
 * 回測中心（pasted_content_4.txt 任務 8 主頁面）
 * 設定面板（策略/交易對/時間框架/日期/資金/參數）+ 異步任務輪詢 + 績效報告
 */

import { useEffect, useMemo, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Play, RotateCcw, Download, Save, Loader2, XCircle, Clock, CheckCircle2, Trash2, ArrowLeft, Activity, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import BacktestReport, {
  type ReportMetrics,
  type ReportTrade,
} from "@/components/backtest/BacktestReport";
import BacktestHistory from "@/components/backtest/BacktestHistory";
import MartinLayersEditor, {
  calculateMaxLayers,
  hasAnyLayerStepPct,
  parseLayersValue,
  validateLayersUI,
} from "@/components/backtest/MartinLayersEditor";
import EmaMartinTiersEditor, {
  parseTiersValue,
  calculateMaxLayersFromTiers,
} from "@/components/backtest/EmaMartinTiersEditor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SymbolCombobox } from "@/components/SymbolCombobox";
import DynamicForm from "@/components/DynamicForm";
import type { SchemaConfig } from "@/components/DynamicForm";
import { useBacktestWs } from "@/hooks/useBacktestWs";
import { V25ConfigPanel } from "@/components/V25ConfigPanel";
import { Rainbow20415ConfigPanel } from "@/components/Rainbow20415ConfigPanel";
import {
  V25_STRATEGY_KEY,
  normalizeV25Config,
  validateV25Config,
} from "@shared/strategies/kama3kBreakoutV25";
import {
  deriveRainbow20415FinalEnabledLayer,
  formatRainbow20415Timeframe,
  RAINBOW_20415_STRATEGY_KEY,
  normalizeRainbow20415Config,
  validateRainbow20415Config,
} from "@shared/strategies/rainbow20415";
import {
  normalizeRainbowTrendLadderConfig,
  deriveRainbowTrendLadderFinalEnabledLayer,
  RAINBOW_TREND_LADDER_STRATEGY_KEY,
  validateRainbowTrendLadderConfig,
} from "@shared/strategies/rainbowTrendLadder";
import { RainbowTrendLadderConfigPanel } from "@/components/RainbowTrendLadderConfigPanel";
import {
  V40EntryGatePanel,
  V40_STRATEGY_KEY,
  normalizeV40EntryGateValue,
} from "@/components/V40EntryGatePanel";
import { V41EntryConditionsPanel } from "@/components/V41EntryConditionsPanel";
import {
  V41_STRATEGY_KEY,
  countEnabledV41EntryConditions,
  normalizeV41Config,
  summarizeV41EntryConfig,
  validateV41Config,
} from "@shared/strategies/kama3kMartinV41";
import { KamaRainbowMartinConfigPanel } from "@/components/KamaRainbowMartinConfigPanel";
import {
  KAMA_RAINBOW_MARTIN_STRATEGY_KEY,
  getKamaRainbowMartinTimeframeMinutes,
  normalizeKamaRainbowMartinConfig,
  validateKamaRainbowMartinConfig,
  type KamaRainbowMartinTimeframe,
} from "@shared/strategies/kamaRainbowMartin";
import type { ExecutionMode, ExecutionPolicy, StrategyModeCapabilities } from "@shared/executionModes";
import {
  createDefaultStrategyExecutionPolicy,
  normalizeStrategyExecutionPolicy,
} from "@shared/strategies/kamaRainbowMartinExecutionPolicy";

type JobPhase = "idle" | "running" | "done" | "failed" | "cancelled";

const BACKTEST_STALE_HEARTBEAT_MS = 120_000;

function formatElapsedDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}時 ${minutes}分 ${remainder}秒`
    : `${minutes}分 ${remainder}秒`;
}

function formatBacktestTimestamp(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleString() : "尚未回報";
}

const KRM_BACKTEST_TIMEFRAME_OPTIONS: ReadonlyArray<{
  value: string;
  configValue: KamaRainbowMartinTimeframe;
  label: string;
}> = [
  { value: "5m", configValue: "M5", label: "5 分鐘" },
  { value: "15m", configValue: "M15", label: "15 分鐘" },
  { value: "30m", configValue: "M30", label: "30 分鐘" },
  { value: "1h", configValue: "H1", label: "1 小時" },
  { value: "4h", configValue: "H4", label: "4 小時" },
  { value: "1d", configValue: "D1", label: "1 天" },
  { value: "7d", configValue: "W1", label: "1 週" },
] as const;

export default function Backtest() {
  // ===== 表單狀態 =====
  const [strategyKey, setStrategyKey] = useState("20415_KAMA_MARTIN_V35");
  const [exchange, setExchange] = useState<"okx" | "bybit">("okx");
  const [symbol, setSymbol] = useState("BTC-USDT");
  const [tfValue, setTfValue] = useState("1");
  const [tfUnit, setTfUnit] = useState<"m" | "h" | "d">("h");
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [initialCapital, setInitialCapital] = useState("10000");
  const [tradeAmount, setTradeAmount] = useState("15"); // 每次交易金額 (USDT)
  const [positionMode, setPositionMode] = useState<"quantity" | "usdt">("usdt");
  const [endPositionPolicy, setEndPositionPolicy] = useState<"mark_to_market" | "force_close">("mark_to_market");
  const [configJson, setConfigJson] = useState<Record<string, unknown>>({});
  const [executionPolicy, setExecutionPolicy] = useState<ExecutionPolicy>(() =>
    createDefaultStrategyExecutionPolicy("20415_KAMA_MARTIN_V35", "SINGLE_EXCLUSIVE"),
  );

  // ===== 任務狀態 =====
  const [jobId, setJobId] = useState<string | null>(null);
  const [phase, setPhase] = useState<JobPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());

  // ===== 歷史記錄載入（任務 C1）=====
  const [activeTab, setActiveTab] = useState("run");
  const [loadedRunId, setLoadedRunId] = useState<string | null>(null);
  const loadedRunQuery = trpc.backtest.getRun.useQuery(
    { runId: loadedRunId ?? "" },
    { enabled: !!loadedRunId, retry: false },
  );

  // ===== 數據 =====
  // V4.2: 使用 registry 統一數據源，同時保留 backtest.getStrategies 作為 fallback
  const registryQuery = trpc.registry.listDefinitions.useQuery(undefined);
  const backtestStrategiesQuery = trpc.backtest.getStrategies.useQuery();
  // ❗ 穩定化引用：避免每次渲染都產生新陣列導致 useEffect/useMemo 無限觸發
  const strategiesData = useMemo(() => {
    if (registryQuery.data && registryQuery.data.length > 0) {
      return registryQuery.data.map(s => ({
        key: s.key,
        name: s.name,
        defaultConfig: s.defaultConfig as Record<string, unknown>,
        schemaConfig: s.schemaConfig as SchemaConfig | null,
        modeCapabilities: s.backtestModeCapabilities as StrategyModeCapabilities,
        strategyVersion: String(s.backtestCapabilityManifest.strategyVersion),
        strategyLogicHash: s.backtestCapabilityManifest.strategyLogicHash,
      }));
    }
    if (backtestStrategiesQuery.data) {
      return backtestStrategiesQuery.data.map(s => ({
        key: s.key,
        name: s.name,
        defaultConfig: s.defaultConfig as Record<string, unknown>,
        schemaConfig: null as SchemaConfig | null,
        modeCapabilities: s.backtestModeCapabilities as StrategyModeCapabilities,
        strategyVersion: String(s.backtestCapabilityManifest.strategyVersion),
        strategyLogicHash: s.backtestCapabilityManifest.strategyLogicHash,
      }));
    }
    return undefined;
  }, [registryQuery.data, backtestStrategiesQuery.data]);
  const strategiesQuery = {
    data: strategiesData,
    isLoading: registryQuery.isLoading && backtestStrategiesQuery.isLoading,
  };

  const runMutation = trpc.backtest.run.useMutation();
  const cancelMutation = trpc.backtest.cancel.useMutation();

  // 佇列狀態（全局可見，顯示進行中/排隊中任務）
  const queueStatusQuery = trpc.backtest.getQueueStatus.useQuery(undefined, {
    refetchInterval: phase === "running" ? 3000 : 10000,
  });

  const progressQuery = trpc.backtest.getProgress.useQuery(
    { jobId: jobId ?? "" },
    {
      enabled: !!jobId && phase === "running",
      refetchInterval: 1500,
      retry: false,
    },
  );

  const resultQuery = trpc.backtest.getResult.useQuery(
    { jobId: jobId ?? "" },
    { enabled: !!jobId && phase === "done", retry: false },
  );

  useEffect(() => {
    if (phase !== "running") return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  // 選中策略的默認配置
  const selectedStrategy = useMemo(
    () => strategiesQuery.data?.find((s) => s.key === strategyKey),
    [strategiesQuery.data, strategyKey],
  );
  const selectedModeCapabilities = selectedStrategy?.modeCapabilities ?? null;
  // V4.3: 獲取選中策略的 schemaConfig 用於 DynamicForm fallback
  const selectedSchemaConfig = useMemo(
    () => selectedStrategy && 'schemaConfig' in selectedStrategy ? (selectedStrategy as any).schemaConfig as SchemaConfig | null : null,
    [selectedStrategy],
  );
  const v41Validation = useMemo(
    () => strategyKey === V41_STRATEGY_KEY ? validateV41Config(configJson) : null,
    [configJson, strategyKey],
  );
  // V4.3: 是否使用 DynamicForm（非 KAMA 策略或有 schemaConfig 但無特殊定制的策略）
  const useDynamicFormMode = useMemo(() => {
    if (!strategyKey) return false;
    // KAMA V3.5 策略使用深度定制面板
    if (strategyKey === V40_STRATEGY_KEY || strategyKey === V41_STRATEGY_KEY) return false;
    // 20415 七彩虹使用共享契約驅動的專用軍規面板
    if (strategyKey === RAINBOW_20415_STRATEGY_KEY) return false;
    // 七彩虹線趨勢跟蹤使用共享契約驅動的專用軍規面板
    if (strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY) return false;
    // KRM 使用同一份 canonical config 與專用同源回測面板
    if (strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY) return false;
    // V6.1 高頻掃射策略使用深度定制面板（需要 V4.0 風格馬丁分層 UI）
    if (strategyKey === 'KAMA_3K_HF_V61') return false;
    // V2.5 使用共享參數契約驅動的專用面板
    if (strategyKey === V25_STRATEGY_KEY) return false;
    // 其他策略如果有 schemaConfig 則使用 DynamicForm
    return !!selectedSchemaConfig;
  }, [strategyKey, selectedSchemaConfig]);

  // 策略切換時載入默認配置
  useEffect(() => {
    if (selectedStrategy?.defaultConfig) {
      const nextConfig: Record<string, unknown> = strategyKey === V25_STRATEGY_KEY
        ? { ...normalizeV25Config(selectedStrategy.defaultConfig) }
        : strategyKey === RAINBOW_20415_STRATEGY_KEY
          ? { ...normalizeRainbow20415Config(selectedStrategy.defaultConfig) }
          : strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY
            ? { ...normalizeKamaRainbowMartinConfig(selectedStrategy.defaultConfig) }
          : strategyKey === V41_STRATEGY_KEY
            ? { ...normalizeV41Config(selectedStrategy.defaultConfig) }
          : strategyKey === V40_STRATEGY_KEY
            ? { ...selectedStrategy.defaultConfig, ...normalizeV40EntryGateValue(selectedStrategy.defaultConfig) }
            : { ...selectedStrategy.defaultConfig };
      setConfigJson(nextConfig);
      // 🔥 同步 initialCapital 與 configJson.Initial_Capital，避免參數衝突
      const ic = selectedStrategy.defaultConfig.Initial_Capital;
      if (typeof ic === 'number' && ic > 0) {
        setInitialCapital(String(ic));
      }
      // 🔥 同步 tradeAmount 與 configJson.base_lot_size / Base_Lot_Size
      const bls = nextConfig.base_lot_size ?? nextConfig.Base_Lot_Size;
      if (typeof bls === 'number' && bls > 0) {
        setTradeAmount(String(bls));
      } else if (typeof bls === 'object' && bls !== null && (bls as any).value) {
        setTradeAmount(String((bls as any).value));
      }
      if (strategyKey === RAINBOW_20415_STRATEGY_KEY) {
        const rainbow = normalizeRainbow20415Config(nextConfig);
        setTfValue(String(rainbow.Management_Interval_Minutes));
        setTfUnit("m");
      } else if (strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY) {
        const kamaRainbowMartin = normalizeKamaRainbowMartinConfig(nextConfig);
        setTfValue(String(getKamaRainbowMartinTimeframeMinutes(kamaRainbowMartin.timeframe)));
        setTfUnit("m");
      } else if (strategyKey === V41_STRATEGY_KEY) {
        const v41 = normalizeV41Config(nextConfig);
        setInitialCapital(String(v41.Initial_Capital));
        setTradeAmount(String(v41.Base_Lot_Size));
        setTfValue(String(v41.K_Line_Period));
        setTfUnit("m");
      }
    }
  }, [selectedStrategy, strategyKey]);

  useEffect(() => {
    const supportedModes: readonly ExecutionMode[] = selectedModeCapabilities?.supportedModes?.length
      ? selectedModeCapabilities.supportedModes
      : ["SINGLE_EXCLUSIVE"];
    setExecutionPolicy((previous) => {
      const nextMode = supportedModes.includes(previous.mode)
        ? previous.mode
        : supportedModes[0] ?? "SINGLE_EXCLUSIVE";
      return createDefaultStrategyExecutionPolicy(strategyKey, nextMode);
    });
  }, [strategyKey, selectedModeCapabilities]);

  // 輪詢進度更新（作為 fallback）
  useEffect(() => {
    const p = progressQuery.data;
    if (!p) return;
    setProgress(p.progress);
    setProgressMsg(p.error ?? p.message);
    if (p.status === "completed") setPhase("done");
    else if (p.status === "cancelled") {
      setPhase("cancelled");
    } else if (p.status === "failed" || p.status === "timeout") {
      setPhase("failed");
      toast.error(`${p.errorCode ? `[${p.errorCode}] ` : ""}${p.error ?? "回測失敗"}`);
    }
  }, [progressQuery.data]);

  // WebSocket 即時推送（優先於輪詢，更快更新進度）
  useBacktestWs({
    jobId: phase === "running" ? jobId : null,
    onProgress: (data) => {
      if (data.progress !== undefined) setProgress(data.progress);
      if (data.message) setProgressMsg(data.message);
    },
    onComplete: () => {
      setPhase("done");
      setProgress(100);
      utils.backtest.listRuns.invalidate();
      utils.backtest.getQueueStatus.invalidate();
      utils.backtest.getActiveCount.invalidate();
      toast.success("回測完成");
    },
    onError: (data) => {
      setPhase("failed");
      utils.backtest.getQueueStatus.invalidate();
      utils.backtest.getActiveCount.invalidate();
      toast.error(data.error ?? "回測失敗");
    },
  });

  const utils = trpc.useUtils();

  const timeframe = `${tfValue}${tfUnit}`;

  const handleRun = async () => {
    const capital = Number(initialCapital);
    if (!symbol.trim()) return toast.error("請選擇交易對");
    if (!capital || capital <= 0) return toast.error("初始資金必須大於 0");
    const startMs = new Date(startDate + "T00:00:00Z").getTime();
    const endMs = new Date(endDate + "T23:59:59Z").getTime();
    if (endMs <= startMs) return toast.error("結束日期必須晚於開始日期");
    const v25Validation = strategyKey === V25_STRATEGY_KEY ? validateV25Config(configJson) : null;
    if (v25Validation && !v25Validation.valid) {
      return toast.error(`V2.5 參數設定錯誤：${v25Validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
    }
    const rainbowValidation = strategyKey === RAINBOW_20415_STRATEGY_KEY ? validateRainbow20415Config(configJson) : null;
    if (rainbowValidation && !rainbowValidation.valid) {
      return toast.error(`20415 七彩虹參數設定錯誤：${rainbowValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
    }
    const rainbowTrendValidation = strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY
      ? validateRainbowTrendLadderConfig(configJson)
      : null;
    if (rainbowTrendValidation && !rainbowTrendValidation.valid) {
      return toast.error(`七彩虹線階梯參數設定錯誤：${rainbowTrendValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
    }
    const kamaRainbowMartinValidation = strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY
      ? validateKamaRainbowMartinConfig(configJson)
      : null;
    if (kamaRainbowMartinValidation && !kamaRainbowMartinValidation.valid) {
      return toast.error(`Kama彩虹馬丁參數設定錯誤：${kamaRainbowMartinValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
    }
    const positionSize = Number(tradeAmount);
    if (strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY && (!Number.isFinite(positionSize) || positionSize <= 0)) {
      return toast.error("Kama彩虹馬丁的首層倉位必須大於 0");
    }
    const v41RunValidation = strategyKey === V41_STRATEGY_KEY ? validateV41Config(configJson) : null;
    if (v41RunValidation && !v41RunValidation.valid) {
      return toast.error(`V4.1 參數設定錯誤：${v41RunValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
    }
    // O1：Martin_Layers 提交前驗證（與後端 validateMartinLayers 一致）
    if (strategyKey !== RAINBOW_TREND_LADDER_STRATEGY_KEY && "Martin_Layers" in configJson) {
      const layersErr = validateLayersUI(parseLayersValue(configJson.Martin_Layers));
      if (layersErr) return toast.error(`階梯式馬丁分層設定錯誤：${layersErr}`);
    }

    try {
      setPhase("running");
      setProgress(0);
      setProgressMsg("提交任務中...");
      const { jobId: id } = await runMutation.mutateAsync({
        strategyKey,
        symbol: symbol.trim(),
        timeframe: rainbowValidation
          ? `${rainbowValidation.config.Management_Interval_Minutes}m`
          : rainbowTrendValidation
            ? `${rainbowTrendValidation.config.Management_Interval_Minutes}m`
            : kamaRainbowMartinValidation?.config
              ? `${getKamaRainbowMartinTimeframeMinutes(kamaRainbowMartinValidation.config.timeframe)}m`
            : v41RunValidation?.config
              ? `${v41RunValidation.config.K_Line_Period}m`
              : timeframe,
        startDate: startMs,
        endDate: endMs,
        initialCapital: capital,
        endPositionPolicy,
        config: strategyKey === V25_STRATEGY_KEY
          ? { ...(v25Validation?.config ?? normalizeV25Config(configJson)) }
          : rainbowValidation
            ? { ...rainbowValidation.config }
            : rainbowTrendValidation
              ? { ...rainbowTrendValidation.config }
              : kamaRainbowMartinValidation?.config
                ? {
                    ...kamaRainbowMartinValidation.config,
                    Position_Size_Value: positionSize,
                    Position_Size_Mode: positionMode,
                  }
              : v41RunValidation?.config
                ? { ...v41RunValidation.config }
                : strategyKey === V40_STRATEGY_KEY
                  ? { ...configJson, ...normalizeV40EntryGateValue(configJson) }
                  : configJson,
        exchange,
        executionMode: executionPolicy.mode,
        executionPolicy: executionPolicy as unknown as Record<string, unknown>,
        strategyVersion: selectedStrategy?.strategyVersion,
        strategyLogicHash: selectedStrategy?.strategyLogicHash,
        strategyModeCapabilities: selectedModeCapabilities ?? undefined,
        strategyName: selectedStrategy?.name,
        tradeAmount: strategyKey === V25_STRATEGY_KEY
          ? v25Validation?.config.Base_Lot_Size
          : rainbowValidation
            ? rainbowValidation.config.Base_Lot_Size.value
            : rainbowTrendValidation
              ? rainbowTrendValidation.config.Base_Lot_Size.value
              : kamaRainbowMartinValidation?.config
                ? positionSize
                : v41RunValidation?.config?.Base_Lot_Size ?? (Number(tradeAmount) || undefined),
      });
      setJobId(id);
      utils.backtest.getQueueStatus.invalidate();
      utils.backtest.getActiveCount.invalidate();
      toast.success("回測任務已提交");
    } catch (e) {
      setPhase("failed");
      toast.error(e instanceof Error ? e.message : "提交失敗");
    }
  };

  const handleReset = () => {
    setJobId(null);
    setPhase("idle");
    setProgress(0);
    setProgressMsg("");
  };

  /** 參數友善描述（hover 提示） */
  const paramTitle = (key: string): string => {
    const titles: Record<string, string> = {
      // SMA v3.00 EMA 指標
      EMA1_Period: "Killer 週期（快線，預設 3）",
      EMA2_Period: "Wave 週期（中線，預設 6）",
      EMA3_Period: "Trend 週期（趨勢線，預設 15）",
      EMA4_Period: "Lower 週期（預設 30）",
      EMA5_Period: "Upper 週期（慢線，預設 60）",
      TimeFrameEnter: "Enter 週期（入場線，預設 15）",
      Reentry_Enabled: "循環再入場（平倉後自動重入）",
      Reentry_Cooldown_Bars: "再入場冷卻 K 線數",
      Base_Lot_Size: "首單倉位（支援 USDT 金額/幣種數量雙模式）",
      Initial_Capital: "初始資金 (USDT)",
      // SMA v3.00 階梯式分層
      Martin_Multiplier: "馬丁倍率（已鎖定，由分層表格控制）",
      MaxMartinLevels: "Max_Layers（自動計算）",
      Global_Pipstep: "全局加倉間距 (pipstep)",
      Martin_Tiers: "階梯式馬丁分層（起始/結束/乘數/間距）",
      Point_Value: "每點價值（XAUUSD=0.01, BTC=1）",
      // SMA v3.00 金額追踪止盈
      Dollar_Start_Buy: "做多止盈啟動金額 ($)",
      Dollar_Start_Sell: "做空止盈啟動金額 ($)",
      Dollar_Trail: "追踪回撤金額 ($)（從峰值回撤此值即平倉）",
      // SMA v3.00 動態風控
      Max_Position_Ratio: "最大持倉比例（預設 20%，持倉名義總值 ≤ 權益 × 此值）",
      Max_Equity_Drawdown: "權益回撤止損（預設 5%，從峰值回撤超過即全平）",
      Dollar_Loss: "極限止損金額 ($)（浮虧達此值強制全平）",
      News_Blackout_Minutes: "新聞禁開倉（分鐘，前後禁止開倉）",
      // 向後兼容 KAMA V3.5 keys
      Max_Loss_Pct: "硬止損 %（總浮虧達此值強制全平）",
      Max_Drawdown_Pct: "回撤保護 %（整體權益曲線回撤率）",
      Max_Deviation_Pct: "最後層偏離 %",
      Target_TP_Pct: "整體止盈 %",
      Callback_Pct: "回調確認 %",
      K_Line_Period: "K 線週期（分鐘）",
      Martin_Step_Pct: "全局加倉間距 %（自定義分層的 fallback）",
      Martin_Layers: "自定義階梯分層（覆蓋上方矩陣）",
      Max_Layers: "最大層數（由分層表格自動計算）",
      Reentry_On_Trend: "KAMA 重入開關",
      Max_Loss_USDT: "浮虧止損 (USDT)",
      MaxDrawdownPercent: "最大回撤保護 %",
      EscapeLossUSD: "逃生艙觸發金額 (USD)",
      EscapeCooldownHours: "逃生艙冷卻（小時）",
      CooldownMinutes: "正常冷卻（分鐘）",
      TrailingStartPct: "移動止盈啟動 %",
      Step_Level_0_2: "間距 0~2 層（USD 價差）",
      Step_Level_3_5: "間距 3~5 層（USD 價差）",
      Step_Level_6_9: "間距 6~9 層（USD 價差）",
      Step_Level_10_Plus: "間距 10+ 層（USD 價差）",
      Multiplier_Level_0_2: "乘數 0~2 層",
      Multiplier_Level_3_5: "乘數 3~5 層",
      Multiplier_Level_6_9: "乘數 6~9 層",
      Multiplier_Level_10_Plus: "乘數 10+ 層",
      hard_stop_pct: "硬止損 (%)（持倉浮虧達此百分比即觸發強制平倉，預設 3%）",
      enable_loss_shrink: "連續虧損縮倉（1=開, 0=關）",
      loss_shrink_level1: "縮倉第1級觸發（連續虧損次數）",
      loss_shrink_level1_pct: "縮倉第1級比例 (%)",
      loss_shrink_level2: "縮倉第2級觸發（連續虧損次數）",
      loss_shrink_level2_pct: "縮倉第2級比例 (%)",
      enable_continuous_entry: "連續開倉（1=開, 0=關）",
      max_deviation_pct: "最後層偏離 %（極限止損條件B）",
    };
    return titles[key] ?? key;
  };

  const updateConfig = (key: string, value: string) => {
    const num = Number(value);
    setConfigJson((prev) => ({ ...prev, [key]: Number.isFinite(num) && value !== "" ? num : value }));
  };

  // ===== UI-1/UI-2（Pasted_content_22）：階梯式分層聯動狀態 =====
  // 新增：優先讀 Martin_Tiers（新參數），其次讀 Martin_Layers（舊參數）
  const martinTiersRules = useMemo(() => {
    if (configJson.Martin_Tiers && typeof configJson.Martin_Tiers === "string") {
      try {
        return JSON.parse(configJson.Martin_Tiers);
      } catch (e) {
        return [];
      }
    }
    return [];
  }, [configJson.Martin_Tiers]);

  const martinLayersRules = useMemo(
    () => parseLayersValue(configJson.Martin_Layers),
    [configJson.Martin_Layers],
  );
  /** UI-2：是否啟用階梯式分層（有數據時鎖定固定乘數） */
  const hasLayeredMartin = martinTiersRules.length > 0 || martinLayersRules.length > 0;
  /** UI-1：Max_Layers 自動 = 分層最後一層 end；無分層回退配置值/預設 5 */
  const autoMaxLayers = useMemo(() => {
    // 新參數 Martin_Tiers 優先
    if (martinTiersRules.length > 0) {
      return martinTiersRules[martinTiersRules.length - 1].end;
    }
    // 舊參數 Martin_Layers 次之
    if (martinLayersRules.length > 0) {
      return calculateMaxLayers(martinLayersRules);
    }
    // 都沒有分層時，使用 Max_Layers 或預設值
    const n = Number(configJson.Max_Layers);
    return Number.isFinite(n) && n > 0 ? n : 5;
  }, [martinTiersRules, martinLayersRules, configJson.Max_Layers]);

  // UI-1 聯動：分層變更時同步寫回 configJson.Max_Layers（提交給後端的值保持一致）；
  // 分層全部刪除時回退策略預設 Max_Layers（無預設則 5），避免殘留聯動寫入的舊值
  const prevHasLayeredRef = useRef(hasLayeredMartin);
  useEffect(() => {
    if (hasLayeredMartin) {
      prevHasLayeredRef.current = true;
      // 優先更新 MaxMartinLevels（新參數），同時保持 Max_Layers 同步（向後相容）
      setConfigJson((prev) => {
        if (martinTiersRules.length > 0) {
          return Number(prev.MaxMartinLevels) === autoMaxLayers ? prev : { ...prev, MaxMartinLevels: autoMaxLayers, Max_Layers: autoMaxLayers };
        }
        return Number(prev.Max_Layers) === autoMaxLayers ? prev : { ...prev, Max_Layers: autoMaxLayers };
      });
      return;
    }
    if (prevHasLayeredRef.current) {
      // 剛從「有分層」切換到「無分層」：重設為策略預設值或 5
      prevHasLayeredRef.current = false;
      const defRaw = selectedStrategy?.defaultConfig?.Max_Layers;
      const def = Number(defRaw);
      const fallback = Number.isFinite(def) && def > 0 ? def : 5;
      setConfigJson((prev) =>
        Number(prev.Max_Layers) === fallback ? prev : { ...prev, Max_Layers: fallback, MaxMartinLevels: fallback },
      );
    }
  }, [hasLayeredMartin, autoMaxLayers, selectedStrategy, martinTiersRules]);

  // ===== UI-3（SMA v3.00）：參數模組化三大區塊分類 =====
  /** 區塊 2：馬丁加倉與網格間距 */
  const MARTIN_KEYS = [
    // SMA v3.00 階梯式分層
    "Martin_Multiplier", "MaxMartinLevels", "Global_Pipstep", "Martin_Tiers", "Point_Value",
    // 向後兼容舊版 keys
    "Step_1_2", "Step_2_3", "Step_3_4", "Step_4_5", "Step_5_6", "Step_6_7", "Step_7_8",
    "Step_Level_0_2", "Step_Level_3_5", "Step_Level_6_9", "Step_Level_10_Plus",
    "Multiplier_Level_0_2", "Multiplier_Level_3_5", "Multiplier_Level_6_9", "Multiplier_Level_10_Plus",
    "Martin_Layers", "Martin_Step_Pct", "Max_Layers",
  ];
  /** 區塊 3：止盈與風控 */
  const RISK_KEYS = [
    // SMA v3.00 金額追踪止盈
    "Dollar_Start_Buy", "Dollar_Start_Sell", "Dollar_Trail",
    // SMA v3.00 動態風控
    "Max_Position_Ratio", "Max_Equity_Drawdown", "Dollar_Loss", "News_Blackout_Minutes",
    // 向後兼容 KAMA V3.5 / 舊版 keys
    "TrailingStartPct",
    "MaxDrawdownPercent", "EscapeLossUSD", "EscapeCooldownHours", "CooldownMinutes",
    "Max_Loss_Pct", "Max_Drawdown_Pct", "Max_Deviation_Pct", "Target_TP_Pct", "Callback_Pct", "K_Line_Period",
    "Reentry_On_Trend", "Max_Loss_USDT",
    "Reentry_Enabled", "Reentry_Cooldown_Bars",
    "EnableDrawdownProtect",
    // V6.1 極限止損
    "hard_stop_pct",
    // V6.1 風控開關
    "enable_loss_shrink", "loss_shrink_level1", "loss_shrink_level1_pct",
    "loss_shrink_level2", "loss_shrink_level2_pct",
    "enable_continuous_entry",
    "max_deviation_pct",
  ];
  /** 隱藏的參數（不顯示在面板上，僅內部使用） */
  const HIDDEN_KEYS = ["MagicNumber", "OrderComment", "Slippage", "Initial_Capital", "initial_capital", "First_Order_Pct", "FirstLot"];
  const groupOfParam = (key: string): 0 | 1 | 2 | 3 => {
    if (HIDDEN_KEYS.includes(key)) return 0; // 隱藏
    if (MARTIN_KEYS.includes(key)) return 2;
    if (RISK_KEYS.includes(key)) return 3;
    return 1; // 趨勢與形態（EMA/KAMA/倉位等）
  };

  // 任務 B2/B4：Base_Lot_Size 雙模式（數量 / USDT 金額）
  const lotSizeObj = useMemo(() => {
    const v = configJson.Base_Lot_Size;
    if (v && typeof v === "object" && "value" in (v as Record<string, unknown>)) {
      const o = v as { value?: unknown; mode?: unknown };
      return { value: String(o.value ?? ""), mode: o.mode === "usdt" ? "usdt" : "quantity" };
    }
    // 🔥 固定金本位：當 Base_Lot_Size 是純數字且 >= 1 時，默認為 USDT 金額模式
    if (typeof v === "number" && v >= 1) {
      return { value: String(v), mode: "usdt" };
    }
    return { value: v === undefined ? "" : String(v), mode: "quantity" };
  }, [configJson.Base_Lot_Size]);

  const updateLotSize = (value: string, mode: string) => {
    const num = Number(value);
    setConfigJson((prev) => ({
      ...prev,
      Base_Lot_Size: strategyKey === V41_STRATEGY_KEY
        ? (Number.isFinite(num) && value !== "" ? num : value)
        : {
            value: Number.isFinite(num) && value !== "" ? num : value,
            mode: mode === "usdt" ? "usdt" : "quantity",
          },
    }));
  };

  // 交易對基礎貨幣（倉位單位動態跟隨）
  const baseCurrency = useMemo(() => {
    const s = symbol.toUpperCase();
    const cleaned = s.replace(/-SWAP$/, "").replace(/-/g, "");
    for (const q of ["USDT", "USDC", "USD", "BTC", "ETH"]) {
      if (cleaned.endsWith(q) && cleaned.length > q.length) return cleaned.slice(0, -q.length);
    }
    return "BTC";
  }, [symbol]);

  const result = resultQuery.data;
  const durableProgress = progressQuery.data;
  const durablePhaseLabel = (() => {
    switch (durableProgress?.phase) {
      case "QUEUED": return "排隊中";
      case "PREPARING": return "準備資料";
      case "RUNNING": return "策略運算";
      case "FINALIZING": return "保存結果";
      case "COMPLETED": return "已完成";
      case "FAILED": return "失敗";
      case "CANCELLED": return "已取消";
      default: return phase === "running" ? "等待工作回報" : "—";
    }
  })();
  const processedBars = durableProgress?.processedBars ?? 0;
  const totalBars = durableProgress?.totalBars ?? 0;
  const heartbeatAgeMs = durableProgress?.heartbeatAt
    ? Math.max(0, clockNow - durableProgress.heartbeatAt)
    : null;
  const isJobStale = phase === "running"
    && durableProgress?.status === "running"
    && heartbeatAgeMs !== null
    && heartbeatAgeMs > BACKTEST_STALE_HEARTBEAT_MS;
  const elapsedStart = durableProgress?.startedAt ?? durableProgress?.createdAt;
  const elapsedEnd = durableProgress?.finishedAt ?? clockNow;
  const elapsedMs = elapsedStart ? Math.max(0, elapsedEnd - elapsedStart) : 0;

  // 策略 key → 名稱對照表（歷史記錄/對比用）
  const strategyNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of strategiesQuery.data ?? []) map[s.key] = s.name;
    return map;
  }, [strategiesQuery.data]);

  const loadedRun = loadedRunQuery.data;

  // ===== V5.6：從快照導入參數 =====
  const [showSnapshotModal, setShowSnapshotModal] = useState(false);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
  const [importMessage, setImportMessage] = useState("");

  // 查詢當前策略的快照列表
  const snapshotsQuery = trpc.backtest.getSnapshots.useQuery(
    { strategyKey, limit: 50 },
    { enabled: showSnapshotModal },
  );

  // 查詢選中快照的完整配置
  const snapshotConfigQuery = trpc.backtest.getSnapshotConfig.useQuery(
    { snapshotId: selectedSnapshotId ?? 0 },
    { enabled: !!selectedSnapshotId },
  );

  const previewConfig = snapshotConfigQuery.data?.config ?? null;
  const previewV41Validation = useMemo(
    () => strategyKey === V41_STRATEGY_KEY && previewConfig ? validateV41Config(previewConfig) : null,
    [previewConfig, strategyKey],
  );

  const handleImportSnapshot = () => {
    if (!previewConfig) return;
    // 共享契約策略以完整配置替換，避免合併時遺失合法 0／false；舊策略維持相容合併。
    if (strategyKey === V25_STRATEGY_KEY) {
      const nextConfig = normalizeV25Config(previewConfig);
      setConfigJson({ ...nextConfig });
      setTradeAmount(String(nextConfig.Base_Lot_Size));
    } else if (strategyKey === RAINBOW_20415_STRATEGY_KEY) {
      const nextConfig = normalizeRainbow20415Config(previewConfig);
      setConfigJson({ ...nextConfig });
      setTradeAmount(String(nextConfig.Base_Lot_Size.value));
      setInitialCapital(String(nextConfig.Initial_Capital));
      setTfValue(String(nextConfig.Management_Interval_Minutes));
      setTfUnit("m");
    } else if (strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY) {
      // 七彩虹線完整契約替換；管理回測週期必須取 Management_Interval_Minutes。
      const nextConfig = normalizeRainbowTrendLadderConfig(previewConfig);
      setConfigJson({ ...nextConfig });
      setTradeAmount(String(nextConfig.Base_Lot_Size.value));
      setInitialCapital(String(nextConfig.Initial_Capital));
      setTfValue(String(nextConfig.Management_Interval_Minutes));
      setTfUnit("m");
    } else if (strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY) {
      const validation = validateKamaRainbowMartinConfig(previewConfig);
      if (!validation.valid || !validation.config) {
        toast.error(`Kama彩虹馬丁快照無法導入：${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
        return;
      }
      setConfigJson({ ...validation.config });
      setTfValue(String(getKamaRainbowMartinTimeframeMinutes(validation.config.timeframe)));
      setTfUnit("m");
    } else if (strategyKey === V41_STRATEGY_KEY) {
      const validation = validateV41Config(previewConfig);
      if (!validation.valid || !validation.config) {
        toast.error(`V4.1 快照無法導入：${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
        return;
      }
      setConfigJson({ ...validation.config });
      setInitialCapital(String(validation.config.Initial_Capital));
      setTradeAmount(String(validation.config.Base_Lot_Size));
      setTfValue(String(validation.config.K_Line_Period));
      setTfUnit("m");
    } else if (strategyKey === V40_STRATEGY_KEY) {
      setConfigJson({ ...previewConfig, ...normalizeV40EntryGateValue(previewConfig) });
    } else {
      setConfigJson((prev) => ({ ...prev, ...previewConfig }));
    }
    // 同步 initialCapital
    const ic = (previewConfig as Record<string, unknown>).Initial_Capital;
    if (typeof ic === "number" && ic > 0) setInitialCapital(String(ic));

    // ✅ 完整還原回測設定（交易所、交易對、時間框架、日期、資金、交易金額）
    const snapshotData = snapshotConfigQuery.data;
    const bs = snapshotData?.backtestSettings;
    if (bs) {
      if (bs.exchange) setExchange(bs.exchange as "okx" | "bybit");
      if (bs.symbol) setSymbol(bs.symbol);
      // 七彩虹線的資料週期是共享策略契約的一部分，舊快照的 backtestSettings
      // 可能曾錯存 Entry_Timeframe，不能覆蓋 Management_Interval_Minutes。
      if (
        bs.timeframe
        && strategyKey !== RAINBOW_TREND_LADDER_STRATEGY_KEY
        && strategyKey !== KAMA_RAINBOW_MARTIN_STRATEGY_KEY
      ) {
        // 解析 timeframe 字串（如 "1h", "15m", "4h", "1d"）
        const tfMatch = bs.timeframe.match(/^(\d+)([mhd])$/);
        if (tfMatch) {
          setTfValue(tfMatch[1]);
          setTfUnit(tfMatch[2] as "m" | "h" | "d");
        }
      }
      if (bs.startDate) setStartDate(bs.startDate);
      if (bs.endDate) setEndDate(bs.endDate);
      if (bs.initialCapital && bs.initialCapital > 0) setInitialCapital(String(bs.initialCapital));
      if (bs.tradeAmount && bs.tradeAmount > 0) setTradeAmount(String(bs.tradeAmount));
      else if (bs.baseLotSize && bs.baseLotSize > 0) setTradeAmount(String(bs.baseLotSize));
      if (bs.baseLotSizeMode === "quantity" || bs.baseLotSizeMode === "usdt") {
        setPositionMode(bs.baseLotSizeMode);
      }
      if (bs.endPositionPolicy === "force_close" || bs.endPositionPolicy === "mark_to_market") {
        setEndPositionPolicy(bs.endPositionPolicy);
      }
    }

    if (snapshotData?.artifact?.artifactScope === "EXECUTION_PROFILE") {
      const artifactMode = snapshotData.artifact.executionMode;
      const artifactPolicy = snapshotData.artifact.executionPolicy;
      if (artifactMode && artifactPolicy) {
        setExecutionPolicy(normalizeStrategyExecutionPolicy(
          snapshotData.strategyKey,
          { ...artifactPolicy, mode: artifactMode },
        ));
      }
    }

    setShowSnapshotModal(false);
    setSelectedSnapshotId(null);
    setImportMessage("");
    toast.success("✅ 快照參數已導入回測表單（含回測設定）");
  };

  // V5.6 P1：儲存當前參數為快照（含自訂名稱）
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [snapshotName, setSnapshotName] = useState("");

  const saveSnapshotMutation = trpc.backtest.saveSnapshot.useMutation({
    onSuccess: () => {
      toast.success("✅ 參數快照已儲存");
      setShowSaveDialog(false);
      setSnapshotName("");
    },
    onError: (err) => {
      toast.error(`儲存失敗：${err.message}`);
    },
  });

  const handleSaveSnapshot = () => {
    // 開啟命名 Dialog，預設名稱為策略名+日期
    const defaultName = `${selectedStrategy?.name || strategyKey}_${new Date().toLocaleDateString("zh-TW")}`;
    setSnapshotName(defaultName);
    setShowSaveDialog(true);
  };

  const confirmSaveSnapshot = () => {
    const v25Validation = strategyKey === V25_STRATEGY_KEY ? validateV25Config(configJson) : null;
    if (v25Validation && !v25Validation.valid) {
      toast.error(`V2.5 參數設定錯誤：${v25Validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
      return;
    }
    const rainbowValidation = strategyKey === RAINBOW_20415_STRATEGY_KEY ? validateRainbow20415Config(configJson) : null;
    if (rainbowValidation && !rainbowValidation.valid) {
      toast.error(`20415 七彩虹參數設定錯誤：${rainbowValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
      return;
    }
    const rainbowTrendValidation = strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY
      ? validateRainbowTrendLadderConfig(configJson)
      : null;
    if (rainbowTrendValidation && !rainbowTrendValidation.valid) {
      toast.error(`七彩虹線階梯參數設定錯誤：${rainbowTrendValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
      return;
    }
    const kamaRainbowMartinValidation = strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY
      ? validateKamaRainbowMartinConfig(configJson)
      : null;
    if (kamaRainbowMartinValidation && !kamaRainbowMartinValidation.valid) {
      toast.error(`Kama彩虹馬丁參數設定錯誤：${kamaRainbowMartinValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
      return;
    }
    const positionSize = Number(tradeAmount);
    if (strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY && (!Number.isFinite(positionSize) || positionSize <= 0)) {
      toast.error("Kama彩虹馬丁的首層倉位必須大於 0");
      return;
    }
    const v41SnapshotValidation = strategyKey === V41_STRATEGY_KEY ? validateV41Config(configJson) : null;
    if (v41SnapshotValidation && !v41SnapshotValidation.valid) {
      toast.error(`V4.1 參數設定錯誤：${v41SnapshotValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
      return;
    }
    const cfg = {
      ...(strategyKey === V25_STRATEGY_KEY
        ? v25Validation?.config ?? configJson
        : rainbowValidation?.config
          ?? rainbowTrendValidation?.config
          ?? kamaRainbowMartinValidation?.config
          ?? v41SnapshotValidation?.config
          ?? (strategyKey === V40_STRATEGY_KEY
            ? { ...configJson, ...normalizeV40EntryGateValue(configJson) }
            : configJson)),
      Initial_Capital: Number(initialCapital) || 10000,
    };
    // ✅ 從回測結果中提取完整績效指標（如果已有結果）
    const reportMetrics = result?.metrics as ReportMetrics | undefined;
    const metricsPayload = reportMetrics ? {
      totalReturn: reportMetrics.totalReturn ?? 0,
      winRate: reportMetrics.winRate ?? 0,
      sharpeRatio: reportMetrics.sharpeRatio,
      profitFactor: reportMetrics.profitFactor,
      maxDrawdown: reportMetrics.maxDrawdown,
      calmarRatio: reportMetrics.calmarRatio,
      totalTrades: reportMetrics.totalTrades,
      winningTrades: reportMetrics.winningTrades,
      losingTrades: reportMetrics.losingTrades,
      avgWin: reportMetrics.avgWin,
      avgLoss: reportMetrics.avgLoss,
      maxWin: reportMetrics.maxWin,
      maxLoss: reportMetrics.maxLoss,
    } : {
      totalReturn: 0,
      winRate: 0,
    };
    saveSnapshotMutation.mutate({
      strategyKey,
      strategyName: selectedStrategy?.name,
      snapshotName: snapshotName.trim() || undefined,
      config: cfg,
      metrics: metricsPayload,
      artifactScope: "EXECUTION_PROFILE",
      executionMode: executionPolicy.mode,
      executionPolicy: { ...executionPolicy },
      sourceRunId: jobId ?? loadedRunId ?? undefined,
      // ✅ 傳遞完整回測設定（交易所、交易對、時間框架、日期、資金、交易金額）
      backtestSettings: {
        exchange,
        symbol: symbol.trim(),
        timeframe: rainbowValidation
          ? `${rainbowValidation.config.Management_Interval_Minutes}m`
          : rainbowTrendValidation
            ? `${rainbowTrendValidation.config.Management_Interval_Minutes}m`
            : kamaRainbowMartinValidation?.config
              ? `${getKamaRainbowMartinTimeframeMinutes(kamaRainbowMartinValidation.config.timeframe)}m`
            : v41SnapshotValidation?.config
              ? `${v41SnapshotValidation.config.K_Line_Period}m`
              : `${tfValue}${tfUnit}`,
        startDate,
        endDate,
        initialCapital: Number(initialCapital) || 10000,
        endPositionPolicy,
        tradeAmount: strategyKey === V25_STRATEGY_KEY
          ? v25Validation?.config.Base_Lot_Size
          : rainbowValidation
            ? rainbowValidation.config.Base_Lot_Size.value
            : rainbowTrendValidation
              ? rainbowTrendValidation.config.Base_Lot_Size.value
              : kamaRainbowMartinValidation?.config
                ? positionSize
              : v41SnapshotValidation?.config?.Base_Lot_Size ?? (Number(tradeAmount) || undefined),
        configJson: cfg,
        baseLotSize: strategyKey === V25_STRATEGY_KEY
          ? v25Validation?.config.Base_Lot_Size
          : rainbowValidation
            ? rainbowValidation.config.Base_Lot_Size.value
            : rainbowTrendValidation
              ? rainbowTrendValidation.config.Base_Lot_Size.value
              : kamaRainbowMartinValidation?.config
                ? positionSize
              : v41SnapshotValidation?.config?.Base_Lot_Size ?? (Number(tradeAmount) || undefined),
        baseLotSizeMode: rainbowValidation
          ? rainbowValidation.config.Base_Lot_Size.mode
          : rainbowTrendValidation?.config.Base_Lot_Size.mode
            ?? (kamaRainbowMartinValidation?.config ? positionMode : "usdt"),
      },
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">回測中心</h1>
          <p className="text-sm text-muted-foreground mt-1">
            使用歷史 K 線數據驗證策略績效，與實盤 V3.5 引擎邏輯完全一致
          </p>
        </div>

        {/* 設定面板 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">回測設定</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label className="text-xs">策略</Label>
                <Select value={strategyKey} onValueChange={setStrategyKey}>
                  <SelectTrigger className="w-full max-w-full overflow-hidden [&>span]:truncate [&>span]:block [&>span]:max-w-[calc(100%-1.5rem)] [&>span]:text-left">
                    <SelectValue placeholder="選擇策略" />
                  </SelectTrigger>
                  <SelectContent>
                    {(strategiesQuery.data ?? []).map((s) => (
                      <SelectItem key={s.key} value={s.key}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">數據來源交易所</Label>
                <Select value={exchange} onValueChange={(v) => setExchange(v as "okx" | "bybit")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="okx">OKX</SelectItem>
                    <SelectItem value="bybit">Bybit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">交易對</Label>
                <SymbolCombobox
                  exchange={exchange}
                  value={symbol}
                  onChange={(opt) => setSymbol(opt.symbol)}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">時間框架</Label>
                <Select value={`${tfValue}${tfUnit}`} onValueChange={(v) => {
                  const m = v.match(/^(\d+)(m|h|d)$/);
                  if (m) {
                    setTfValue(m[1]);
                    setTfUnit(m[2] as "m" | "h" | "d");
                  }
                  if (strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY) {
                    const selected = KRM_BACKTEST_TIMEFRAME_OPTIONS.find(option => option.value === v);
                    if (selected) {
                      setConfigJson(previous => ({
                        ...normalizeKamaRainbowMartinConfig(previous),
                        timeframe: selected.configValue,
                      }));
                    }
                  }
                }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY ? (
                      KRM_BACKTEST_TIMEFRAME_OPTIONS.map(option => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))
                    ) : (
                      <>
                        <SelectItem value="1m">1 分鐘</SelectItem>
                        <SelectItem value="3m">3 分鐘</SelectItem>
                        <SelectItem value="5m">5 分鐘</SelectItem>
                        <SelectItem value="15m">15 分鐘</SelectItem>
                        <SelectItem value="30m">30 分鐘</SelectItem>
                        <SelectItem value="1h">1 小時</SelectItem>
                        <SelectItem value="2h">2 小時</SelectItem>
                        <SelectItem value="4h">4 小時</SelectItem>
                        <SelectItem value="6h">6 小時</SelectItem>
                        <SelectItem value="12h">12 小時</SelectItem>
                        <SelectItem value="1d">1 天</SelectItem>
                        <SelectItem value="2d">2 天</SelectItem>
                        <SelectItem value="3d">3 天</SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">開始日期</Label>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">結束日期</Label>
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">初始資金（USDT）</Label>
                <Input
                  type="number"
                  min="1"
                  step="any"
                  lang="en"
                  inputMode="decimal"
                  value={initialCapital}
                  onChange={(e) => setInitialCapital(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">
                  {strategyKey === RAINBOW_20415_STRATEGY_KEY
                    ? "20415 底倉數值"
                    : strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY
                      ? `KRM 首層倉位（${positionMode === "usdt" ? "USDT" : "幣數量"}）`
                      : "每次交易金額（USDT）"}
                </Label>
                <Input
                  type="number"
                  min={strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY ? "0.00000001" : "1"}
                  step="any"
                  lang="en"
                  inputMode="decimal"
                  value={tradeAmount}
                  disabled={strategyKey === V25_STRATEGY_KEY || strategyKey === RAINBOW_20415_STRATEGY_KEY}
                  onChange={(e) => {
                    setTradeAmount(e.target.value);
                    const num = Number(e.target.value);
                    if (strategyKey !== KAMA_RAINBOW_MARTIN_STRATEGY_KEY && Number.isFinite(num) && num > 0) {
                      setConfigJson((prev) => ({
                        ...prev,
                        base_lot_size: num,
                        Base_Lot_Size: num,
                      }));
                    }
                  }}
                  placeholder="每次首單下單金額"
                />
                <p className="text-[10px] text-muted-foreground">
                  {strategyKey === V25_STRATEGY_KEY
                    ? "由下方 V2.5 Base_Lot_Size 單一參數契約控制"
                    : strategyKey === RAINBOW_20415_STRATEGY_KEY
                      ? `由下方七彩虹 Base_Lot_Size 控制；數據鎖定 ${normalizeRainbow20415Config(configJson).Management_Interval_Minutes}m 管理週期`
                      : strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY
                        ? `頂層 Position_Size；策略週期目前為 ${getKamaRainbowMartinTimeframeMinutes(normalizeKamaRainbowMartinConfig(configJson).timeframe)} 分鐘，可於此處或下方面板修改；馬丁層量由分層表預覽`
                    : "首單固定金額，加倉按馬丁倍率遞增"}
                </p>
              </div>
              {strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY && (
                <div className="space-y-2">
                  <Label className="text-xs">KRM 倉位模式</Label>
                  <Select value={positionMode} onValueChange={(value) => setPositionMode(value as "quantity" | "usdt")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="usdt">USDT 名目金額</SelectItem>
                      <SelectItem value="quantity">幣數量</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">此值屬策略實例／回測設定，不寫入 canonical 策略配置。</p>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/[0.04] p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-2xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label className="text-sm font-semibold">全域終點持倉政策</Label>
                    <Badge variant="outline" className="border-cyan-500/50 font-mono text-[10px] text-cyan-300">V2.5</Badge>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    僅在完整回測區間結束時處理未平倉；分段抓取資料不會觸發中途平倉。
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:w-[32rem]" role="radiogroup" aria-label="全域終點持倉政策">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={endPositionPolicy === "mark_to_market"}
                    onClick={() => setEndPositionPolicy("mark_to_market")}
                    className={`rounded-md border px-3 py-3 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.98] ${endPositionPolicy === "mark_to_market" ? "border-cyan-400 bg-cyan-500/15 ring-1 ring-cyan-400/30" : "border-border bg-background/60 hover:border-cyan-500/50"}`}
                  >
                    <span className="block text-xs font-semibold text-foreground">按市價估值（預設）</span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">保留未平倉，以最後收盤價計入未實現損益與最終權益。</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={endPositionPolicy === "force_close"}
                    onClick={() => setEndPositionPolicy("force_close")}
                    className={`rounded-md border px-3 py-3 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.98] ${endPositionPolicy === "force_close" ? "border-amber-400 bg-amber-500/15 ring-1 ring-amber-400/30" : "border-border bg-background/60 hover:border-amber-500/50"}`}
                  >
                    <span className="block text-xs font-semibold text-foreground">全域終點強制平倉</span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">只在最後資料點產生一筆可稽核的合成平倉交易。</span>
                  </button>
                </div>
              </div>
            </div>

            {/* V4.3: 非 KAMA 策略使用 DynamicForm 渲染 */}
            {useDynamicFormMode && selectedSchemaConfig && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">策略參數（Schema-Driven）</Label>
                <DynamicForm
                  schema={selectedSchemaConfig}
                  values={configJson as Record<string, any>}
                  onChange={(newValues) => setConfigJson(newValues)}
                  mode="editable"
                  showPreview={true}
                  compact={true}
                />
              </div>
            )}

            {strategyKey === V25_STRATEGY_KEY && Object.keys(configJson).length > 0 && (
              <V25ConfigPanel
                value={configJson}
                onChange={(nextConfig) => {
                  setConfigJson({ ...nextConfig });
                  setTradeAmount(String(nextConfig.Base_Lot_Size));
                }}
                context="backtest"
              />
            )}

            {strategyKey === RAINBOW_20415_STRATEGY_KEY && Object.keys(configJson).length > 0 && (
              <Rainbow20415ConfigPanel
                value={configJson}
                onChange={(nextConfig) => {
                  setConfigJson({ ...nextConfig });
                  setInitialCapital(String(nextConfig.Initial_Capital));
                  setTradeAmount(String(nextConfig.Base_Lot_Size.value));
                  setTfValue(String(nextConfig.Management_Interval_Minutes));
                  setTfUnit("m");
                }}
                context="backtest"
              />
            )}

            {strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY && Object.keys(configJson).length > 0 && (
              <RainbowTrendLadderConfigPanel
                value={configJson}
                onChange={(nextConfig) => {
                  setConfigJson({ ...nextConfig });
                  setInitialCapital(String(nextConfig.Initial_Capital));
                  setTradeAmount(String(nextConfig.Base_Lot_Size.value));
                  setTfValue(String(nextConfig.Management_Interval_Minutes));
                  setTfUnit("m");
                }}
                context="backtest"
              />
            )}

            {strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY && Object.keys(configJson).length > 0 && (
              <KamaRainbowMartinConfigPanel
                value={configJson}
                onChange={(nextConfig) => {
                  setConfigJson({ ...nextConfig });
                  setTfValue(String(getKamaRainbowMartinTimeframeMinutes(nextConfig.timeframe)));
                  setTfUnit("m");
                }}
                context="backtest"
                positionMode={positionMode}
                positionSize={Number(tradeAmount) || 0}
              />
            )}

            {strategyKey === V40_STRATEGY_KEY && Object.keys(configJson).length > 0 && (
              <V40EntryGatePanel
                value={configJson}
                onChange={(entryGate) => setConfigJson((prev) => ({ ...prev, ...entryGate }))}
                context="backtest"
              />
            )}

            {strategyKey === V41_STRATEGY_KEY && Object.keys(configJson).length > 0 && (
              <V41EntryConditionsPanel
                value={configJson}
                onChange={(nextConfig) => {
                  setConfigJson({ ...nextConfig });
                  setInitialCapital(String(nextConfig.Initial_Capital));
                  setTradeAmount(String(nextConfig.Base_Lot_Size));
                  setTfValue(String(nextConfig.K_Line_Period));
                  setTfUnit("m");
                }}
                context="backtest"
                validationIssues={v41Validation?.issues}
              />
            )}

            {/* 動態策略參數（UI-3：三大模組化區塊分類）- 內建策略深度定制面板 */}
            {strategyKey !== V25_STRATEGY_KEY && strategyKey !== RAINBOW_20415_STRATEGY_KEY && strategyKey !== RAINBOW_TREND_LADDER_STRATEGY_KEY && strategyKey !== KAMA_RAINBOW_MARTIN_STRATEGY_KEY && !useDynamicFormMode && Object.keys(configJson).length > 0 && (() => {
              /** 單一參數渲染（含 UI-1/UI-2/UI-4 特殊規則） */
              const renderParam = (key: string, value: unknown) => {
                // 任務 B2：Base_Lot_Size 雙模式（數量 / USDT）
                if (key === "Base_Lot_Size") {
                  return (
                    <div key={key} className="space-y-1 col-span-2">
                      <Label className="text-[10px] text-muted-foreground truncate block" title="Base_Lot_Size（首單倉位）">
                        Base_Lot_Size（{lotSizeObj.mode === "usdt" ? "USDT 金額" : `${baseCurrency} 數量`}）
                      </Label>
                      <div className="flex gap-1">
                        <Input
                          className="h-8 text-xs flex-1"
                          type="number"
                          min="0"
                          step="any"
                          lang="en"
                          inputMode="decimal"
                          value={lotSizeObj.value}
                          placeholder={
                            lotSizeObj.mode === "usdt"
                              ? "例：100（USDT 金額）"
                              : `例：0.01（${baseCurrency} 數量）`
                          }
                          onChange={(e) => updateLotSize(e.target.value, lotSizeObj.mode)}
                        />
                        <Select
                          value={lotSizeObj.mode}
                          onValueChange={(m) => updateLotSize(lotSizeObj.value, m)}
                        >
                          <SelectTrigger className="h-8 text-xs w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="quantity">{baseCurrency} 數量</SelectItem>
                            <SelectItem value="usdt">USDT 金額</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  );
                }
                // O1：Martin_Layers 階梯式分層編輯器（KAMA 馬丁用）
                if (key === "Martin_Layers") {
                  return (
                    <MartinLayersEditor
                      key={key}
                      value={value}
                      onChange={(jsonStr) =>
                        setConfigJson((prev) => ({ ...prev, Martin_Layers: jsonStr }))
                      }
                    />
                  );
                }
                // EMA 馬丁專用：Martin_Tiers 階梯式分層編輯器（pipstep 版本）
                if (key === "Martin_Tiers") {
                  return (
                    <EmaMartinTiersEditor
                      key={key}
                      value={value}
                      pointValue={Number(configJson.Point_Value) || 0.01}
                      globalPipstep={Number(configJson.Global_Pipstep) || 10000}
                      onChange={(jsonStr) =>
                        setConfigJson((prev) => {
                          const next: Record<string, any> = { ...prev, Martin_Tiers: jsonStr };
                          // 自動同步 MaxMartinLevels
                          const tiers = parseTiersValue(jsonStr);
                          if (tiers.length > 0) {
                            next.MaxMartinLevels = calculateMaxLayersFromTiers(tiers);
                          }
                          return next;
                        })
                      }
                    />
                  );
                }
                // MaxMartinLevels 對於 EMA 馬丁也顯示為唯讀（由 Martin_Tiers 自動計算）
                if (key === "MaxMartinLevels" && configJson.Martin_Tiers) {
                  const tiers = parseTiersValue(configJson.Martin_Tiers);
                  const autoMax = tiers.length > 0 ? calculateMaxLayersFromTiers(tiers) : (Number(value) || 11);
                  return (
                    <div key={key} className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground truncate block">
                        MaxMartinLevels <span className="text-green-400">🔒 自動計算</span>
                      </Label>
                      <Input
                        className="h-8 text-xs bg-muted cursor-not-allowed"
                        type="number"
                        value={autoMax}
                        disabled
                      />
                      <p className="text-[10px] text-green-400">
                        💡 自動讀取分層表格最後一層，目前為第 {autoMax} 層
                      </p>
                    </div>
                  );
                }
                // UI-1（Pasted_content_22）：Max_Layers 唯讀 + 自動計算
                if (key === "Max_Layers") {
                  return (
                    <div key={key} className="space-y-1">
                      <Label
                        className="text-[10px] text-muted-foreground truncate block"
                        title="Max_Layers（由階梯式分層自動計算；無分層時回退預設 5）"
                      >
                        Max_Layers <span className="text-amber-500">🔒 自動計算</span>
                      </Label>
                      <Input
                        className="h-8 text-xs bg-muted cursor-not-allowed"
                        type="number"
                        value={autoMaxLayers}
                        disabled
                        data-testid="max-layers-readonly"
                      />
                      <p className="text-[10px] text-muted-foreground">
                        💡 自動讀取分層表格最後一層，目前為第 {autoMaxLayers} 層
                      </p>
                    </div>
                  );
                }
                // UI-2（Pasted_content_22）：Martin_Multiplier 條件式鎖定
                if (key === "Martin_Multiplier") {
                  return (
                    <div key={key} className="space-y-1">
                      <Label
                        className="text-[10px] text-muted-foreground truncate block"
                        title="Martin_Multiplier（固定乘數；啟用階梯式分層時自動鎖定）"
                      >
                        Martin_Multiplier
                        {hasLayeredMartin && <span className="text-yellow-500"> ⛔ 已鎖定</span>}
                      </Label>
                      <Input
                        className={`h-8 text-xs ${hasLayeredMartin ? "bg-muted cursor-not-allowed" : ""}`}
                        type="number"
                        min="0"
                        step="any"
                        lang="en"
                        inputMode="decimal"
                        value={String(value)}
                        disabled={hasLayeredMartin}
                        onChange={(e) => updateConfig(key, e.target.value)}
                        data-testid="martin-multiplier-input"
                      />
                      {hasLayeredMartin ? (
                        <p className="text-[10px] text-yellow-500">
                          🔒 已啟用階梯式分層，固定乘數已鎖定，請在分層表格設定各層乘數
                        </p>
                      ) : (
                        <p className="text-[10px] text-muted-foreground">
                          💡 未啟用分層時，所有層數使用此固定乘數
                        </p>
                      )}
                    </div>
                  );
                }
                // 🔥 UI-2（Pasted_content_24）：Martin_Step_Pct 條件式鎖定 + 語意標註
                if (key === "Martin_Step_Pct") {
                  const layersRaw = configJson["Martin_Layers"];
                  const currentLayers = parseLayersValue(layersRaw);
                  const isStepLocked = hasAnyLayerStepPct(currentLayers);
                  return (
                    <div key={key} className="space-y-1 col-span-2">
                      <Label
                        className="text-[10px] text-muted-foreground truncate block"
                        title="Martin_Step_Pct（全局加倉間距百分比）"
                      >
                        Martin_Step_Pct（全局加倉間距 %）ⓘ
                        {isStepLocked && (
                          <span className="text-[9px] text-yellow-500 ml-2">
                            🔒 分層間距已啟用
                          </span>
                        )}
                      </Label>
                      <Input
                        className={`h-8 text-xs ${isStepLocked ? "opacity-50 cursor-not-allowed" : ""}`}
                        type="number"
                        min="0"
                        step="any"
                        lang="en"
                        inputMode="decimal"
                        value={String(value)}
                        onChange={(e) => updateConfig(key, e.target.value)}
                        disabled={isStepLocked}
                      />
                      {isStepLocked ? (
                        <p className="text-[10px] text-yellow-500/80">
                          💡 分層已設定專屬間距，全局間距自動鎖定。如需使用全局間距，請清空分層表格中的間距欄位。
                        </p>
                      ) : (
                        <p className="text-[10px] text-blue-400">
                          💡 全局加倉間距：當分層未設定專屬間距時，所有層數使用此值。
                        </p>
                      )}
                    </div>
                  );
                }
                // V6.1 entry_zone_mode 下拉選擇器
                if (key === "entry_zone_mode") {
                  return (
                    <div key={key} className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground truncate block" title="入場模式：breakout=突破區域邊界觸發, inside=價格在區域內觸發">
                        入場模式 (entry_zone_mode)
                      </Label>
                      <Select
                        value={String(value) || "breakout"}
                        onValueChange={(v) =>
                          setConfigJson((prev) => ({ ...prev, entry_zone_mode: v }))
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="breakout">突破模式 (Breakout)</SelectItem>
                          <SelectItem value="inside">內部模式 (Inside)</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-muted-foreground">
                        💡 Breakout：價格穿出 KAMA±buffer 區域觸發 | Inside：價格在區域內觸發
                      </p>
                    </div>
                  );
                }
                // V6.1 direction_mode 下拉選擇器
                if (key === "direction_mode") {
                  return (
                    <div key={key} className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground truncate block" title="方向模式：hybrid=順勢+震盪雙向, trend=僅順勢, both=純雙向">
                        方向模式 (direction_mode)
                      </Label>
                      <Select
                        value={String(value) || "hybrid"}
                        onValueChange={(v) =>
                          setConfigJson((prev) => ({ ...prev, direction_mode: v }))
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="hybrid">順勢+震盪雙向 (Hybrid)</SelectItem>
                          <SelectItem value="trend">僅順勢 (Trend)</SelectItem>
                          <SelectItem value="both">純雙向 (Both)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  );
                }
                // O3：布林參數（如 Reentry_On_Trend）開關下拉
                if (typeof value === "boolean" || value === "true" || value === "false") {
                  const boolVal = value === true || value === "true";
                  return (
                    <div key={key} className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground truncate block" title={paramTitle(key)}>
                        {key}
                      </Label>
                      <Select
                        value={boolVal ? "true" : "false"}
                        onValueChange={(v) =>
                          setConfigJson((prev) => ({ ...prev, [key]: v === "true" }))
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">啟用</SelectItem>
                          <SelectItem value="false">停用</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  );
                }
                const isNumeric = typeof value === "number";
                return (
                  <div key={key} className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground truncate block" title={paramTitle(key)}>
                      {key}
                    </Label>
                    <Input
                      className="h-8 text-xs"
                      type={isNumeric ? "number" : "text"}
                      step="any"
                      lang="en"
                      inputMode={isNumeric ? "decimal" : undefined}
                      value={String(value)}
                      onChange={(e) => updateConfig(key, e.target.value)}
                    />
                  </div>
                );
              };

              const v40EntryGateKeys = new Set([
                "enableThreeKFilter",
                "threeKPatternMode",
                "enableKamaDirectionLock",
                "enableSameDirectionReentry",
              ]);
              const v41EntryConditionKeys = new Set([
                "strategyKey",
                "configVersion",
                "entryConditionLogic",
                "enableThreeKFilter",
                "threeKMode",
                "enableKamaFastSlowCross",
                "enableKamaPriceVsSlow",
                "enableSameDirectionReentry",
              ]);
              const entries = Object.entries(configJson).filter(
                ([k]) => groupOfParam(k) !== 0
                  && !(strategyKey === V40_STRATEGY_KEY && v40EntryGateKeys.has(k))
                  && !(strategyKey === V41_STRATEGY_KEY && v41EntryConditionKeys.has(k)),
              );
              const g1 = entries.filter(([k]) => groupOfParam(k) === 1);
              const g2 = entries.filter(([k]) => groupOfParam(k) === 2);
              const g3 = entries.filter(([k]) => groupOfParam(k) === 3);
              return (
                <div className="space-y-4">
                  <Label className="text-xs text-muted-foreground">策略參數</Label>
                  {g1.length > 0 && (
                    <div className="border-l-4 border-blue-500 pl-3 space-y-2" data-testid="param-block-trend">
                      <h3 className="text-xs font-semibold text-blue-500">📊 趨勢與形態參數</h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                        {g1.map(([k, v]) => renderParam(k, v))}
                      </div>
                    </div>
                  )}
                  {g2.length > 0 && (
                    <div className="border-l-4 border-yellow-500 pl-3 space-y-2" data-testid="param-block-martin">
                      <h3 className="text-xs font-semibold text-yellow-500">📈 馬丁加倉與分層參數</h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                        {g2.map(([k, v]) => renderParam(k, v))}
                      </div>
                    </div>
                  )}
                  {g3.length > 0 && (
                    <div className="border-l-4 border-red-500 pl-3 space-y-2" data-testid="param-block-risk">
                      <h3 className="text-xs font-semibold text-red-500">🛡️ 主動風控與止盈參數</h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                        {g3.map(([k, v]) => renderParam(k, v))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="flex items-center gap-3 flex-wrap">
              <Button
                onClick={handleRun}
                disabled={runMutation.isPending || Boolean(v41Validation && !v41Validation.valid)}
                title={v41Validation && !v41Validation.valid ? "V4.1 至少啟用一個方向條件，且所有 canonical 參數必須有效" : undefined}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                <Play className="w-4 h-4 mr-1" />
                {runMutation.isPending ? "提交中..." : phase === "running" ? "再提交一個回測" : "開始回測"}
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowSnapshotModal(true)}
                title="從已儲存的參數快照導入配置"
              >
                <Download className="w-4 h-4 mr-1" />
                從快照導入
              </Button>
              <Button
                variant="outline"
                onClick={handleSaveSnapshot}
                disabled={saveSnapshotMutation.isPending || Boolean(v41Validation && !v41Validation.valid)}
                title="將當前參數儲存為快照（可於快照庫查看）"
              >
                <Save className="w-4 h-4 mr-1" />
                {saveSnapshotMutation.isPending ? "儲存中..." : "儲存為快照"}
              </Button>
              {(phase === "done" || phase === "failed" || phase === "cancelled") && (
                <Button variant="outline" onClick={handleReset}>
                  <RotateCcw className="w-4 h-4 mr-1" />
                  重新設定
                </Button>
              )}
            </div>

            {/* 進度條 */}
            {phase === "running" && (
              <div className={`space-y-3 rounded-lg border p-3 ${isJobStale ? "border-amber-500/50 bg-amber-500/5" : "border-border/70 bg-muted/20"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="gap-1 font-medium">
                    {isJobStale ? <AlertTriangle className="h-3 w-3 text-amber-500" /> : <Activity className="h-3 w-3 text-blue-500" />}
                    {durablePhaseLabel}
                  </Badge>
                  {isJobStale && (
                    <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">
                      心跳逾時，正在等候接管
                    </Badge>
                  )}
                  <span className="ml-auto text-[11px] font-mono text-muted-foreground">
                    Job {jobId ?? "建立中"}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <Progress value={progress} className="flex-1" />
                  <span className="w-12 text-right text-xs font-mono text-foreground">{Math.round(progress)}%</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={cancelMutation.isPending}
                    className="h-7 px-2 text-xs text-red-500 hover:text-red-600"
                    onClick={async () => {
                      if (!jobId) return;
                      try {
                        const response = await cancelMutation.mutateAsync({ jobId });
                        setPhase("cancelled");
                        setProgressMsg(response.message);
                        await Promise.all([
                          utils.backtest.getProgress.invalidate({ jobId }),
                          utils.backtest.getQueueStatus.invalidate(),
                          utils.backtest.getActiveCount.invalidate(),
                        ]);
                        toast.info("取消要求已持久化，工作已終止");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "取消失敗");
                      }
                    }}
                  >
                    {cancelMutation.isPending
                      ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      : <XCircle className="mr-1 h-3 w-3" />}
                    {cancelMutation.isPending ? "取消中" : "取消"}
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] md:grid-cols-4">
                  <div>
                    <p className="text-muted-foreground">K 棒進度</p>
                    <p className="font-mono font-medium text-foreground">
                      {processedBars.toLocaleString()} / {totalBars > 0 ? totalBars.toLocaleString() : "載入中"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">最後心跳</p>
                    <p className={`font-medium ${isJobStale ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
                      {heartbeatAgeMs === null ? "尚未回報" : `${Math.floor(heartbeatAgeMs / 1000)} 秒前`}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">經過時間</p>
                    <p className="font-mono font-medium text-foreground">{formatElapsedDuration(elapsedMs)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">執行嘗試</p>
                    <p className="font-mono font-medium text-foreground">第 {durableProgress?.attemptCount ?? 0} 次</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
                  <span>開始：{formatBacktestTimestamp(durableProgress?.startedAt)}</span>
                  <span>心跳：{formatBacktestTimestamp(durableProgress?.heartbeatAt)}</span>
                </div>
                <p className="text-xs text-foreground">{progressMsg || "工作已提交，等待 durable worker 回報..."}</p>
                {isJobStale && (
                  <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                    這個 worker 的心跳已超過 120 秒。工作不會再無限停留於舊百分比；資料庫 lease 到期後，排程 worker 會接管重試，超過重試上限則回傳明確錯誤碼。
                  </p>
                )}
              </div>
            )}
            {phase === "failed" && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400">
                <p className="font-semibold">回測失敗{durableProgress?.errorCode ? ` · ${durableProgress.errorCode}` : ""}</p>
                <p className="mt-1 leading-relaxed">{progressMsg || "工作未能完成，請重新提交。"}</p>
                {totalBars > 0 && <p className="mt-2 font-mono text-[11px]">停止於 {processedBars.toLocaleString()} / {totalBars.toLocaleString()} 根 K 棒</p>}
              </div>
            )}
            {phase === "cancelled" && (
              <div className="rounded-lg border border-slate-500/40 bg-slate-500/5 p-3 text-xs text-muted-foreground">
                <p className="font-semibold text-foreground">回測已取消</p>
                <p className="mt-1">{progressMsg || "取消要求已保存，worker lease 已撤銷。"}</p>
                {totalBars > 0 && <p className="mt-2 font-mono text-[11px]">終止於 {processedBars.toLocaleString()} / {totalBars.toLocaleString()} 根 K 棒</p>}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 任務佇列狀態面板 */}
        {queueStatusQuery.data && (queueStatusQuery.data.running > 0 || queueStatusQuery.data.queued > 0) && (
          <Card className="border-blue-500/30 bg-blue-500/5">
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
                  <span className="font-medium">進行中</span>
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{queueStatusQuery.data.running}/{queueStatusQuery.data.maxConcurrent}</Badge>
                </div>
                {queueStatusQuery.data.queued > 0 && (
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-amber-500" />
                    <span className="font-medium">排隊中</span>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{queueStatusQuery.data.queued}</Badge>
                  </div>
                )}
                <div className="flex items-center gap-1.5 ml-auto">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="text-muted-foreground">已完成 {queueStatusQuery.data.completed}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* 績效報告 */}
        {phase === "done" && result && (
          <BacktestReport
            runId={(result as any).runId ?? jobId}
            strategyName={(result as any).strategyName ?? selectedStrategy?.name}
            strategyKey={(result as any).strategyKey ?? strategyKey}
            metrics={result.metrics as ReportMetrics}
            trades={result.trades as ReportTrade[]}
            equityCurve={result.equityCurve}
            config={(result as any).config ?? configJson}
            executionMode={(result as any).executionMode ?? executionPolicy.mode}
            executionPolicy={(result as any).executionPolicy ?? executionPolicy}
            endPositionPolicy={(result as any).endPositionPolicy ?? endPositionPolicy}
            candleCount={(result as any).candleCount}
            accounting={(result as any).accounting ?? null}
            dataQuality={(result as any).dataQuality ?? null}
            engineSemantics={(result as any).engineSemantics ?? null}
            environment={(result as any).environment ?? null}
            reentryDiagnostics={(result as any).reentryDiagnostics ?? null}
            backtestSettings={{
              exchange,
              symbol: symbol.trim(),
              timeframe: `${tfValue}${tfUnit}`,
              startDate,
              endDate,
              initialCapital: Number(initialCapital),
              tradeAmount: Number(tradeAmount) || undefined,
              endPositionPolicy,
              configJson,
              baseLotSize: Number(tradeAmount) || undefined,
              baseLotSizeMode: strategyKey === KAMA_RAINBOW_MARTIN_STRATEGY_KEY ? positionMode : "usdt",
            }}
          />
        )}
        {phase === "done" && resultQuery.isLoading && (
          <p className="text-sm text-muted-foreground">載入結果中...</p>
        )}

        {/* 任務 C1/C2：歷史回測記錄與多策略對比 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">歷史回測記錄</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="h-8">
                <TabsTrigger value="run" className="text-xs">記錄列表與對比</TabsTrigger>
                {loadedRunId && (
                  <TabsTrigger value="loaded" className="text-xs">歷史報告檢視</TabsTrigger>
                )}
              </TabsList>
              <TabsContent value="run" className="mt-3" forceMount>
                <div className={activeTab !== "run" ? "hidden" : undefined}>
                  <BacktestHistory
                    strategyNameMap={strategyNameMap}
                    onLoadRun={(runId) => {
                      setLoadedRunId(runId);
                      setActiveTab("loaded");
                    }}
                  />
                </div>
              </TabsContent>
              {loadedRunId && (
                <TabsContent value="loaded" className="mt-3">
                  <div className="mb-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setActiveTab("run")}
                    >
                      <ArrowLeft className="h-3 w-3 mr-1" /> 返回列表
                    </Button>
                  </div>
                  {loadedRunQuery.isLoading && (
                    <p className="text-sm text-muted-foreground">載入歷史報告中...</p>
                  )}
                  {loadedRunQuery.error && (
                    <p className="text-sm text-red-500">載入失敗：{loadedRunQuery.error.message}</p>
                  )}
                  {loadedRun && loadedRun.metrics && (
                    <BacktestReport
                      runId={loadedRun.run.runId}
                      strategyName={strategyNameMap[loadedRun.run.strategyKey] ?? loadedRun.run.strategyKey}
                      strategyKey={loadedRun.run.strategyKey}
                      metrics={loadedRun.metrics as ReportMetrics}
                      trades={loadedRun.trades as ReportTrade[]}
                      equityCurve={(loadedRun.equityCurve ?? []) as Array<{ timestamp: number; equity: number; price: number }>}
                      config={loadedRun.run.config}
                      executionMode={(loadedRun.run as any).executionMode ?? "SINGLE_EXCLUSIVE"}
                      executionPolicy={(loadedRun.run as any).executionPolicy ?? createDefaultStrategyExecutionPolicy(
                        loadedRun.run.strategyKey,
                        (loadedRun.run as any).executionMode ?? "SINGLE_EXCLUSIVE",
                      )}
                      endPositionPolicy={(loadedRun.run as any).endPositionPolicy}
                      candleCount={(loadedRun.run as any).candleCount}
                      accounting={(loadedRun.run as any).accounting ?? null}
                      dataQuality={(loadedRun.run as any).dataQuality ?? null}
                      engineSemantics={(loadedRun.run as any).engineSemantics ?? null}
                      environment={(loadedRun as any).environment ?? null}
                      reentryDiagnostics={(loadedRun.run as any).reentryDiagnostics ?? (loadedRun as any).reentryDiagnostics ?? null}
                    />
                  )}
                  {loadedRun && !loadedRun.metrics && (
                    <p className="text-sm text-muted-foreground">此記錄無績效數據（可能為舊版本或失敗任務）</p>
                  )}
                </TabsContent>
              )}
            </Tabs>
          </CardContent>
        </Card>
      </div>

      {/* V5.6：快照導入 Modal */}
      <Dialog open={showSnapshotModal} onOpenChange={(open) => {
        setShowSnapshotModal(open);
        if (!open) { setSelectedSnapshotId(null); setImportMessage(""); }
      }}>
        <DialogContent className="max-h-[86vh] max-w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>從快照導入參數</DialogTitle>
          </DialogHeader>

          <p className="text-sm text-muted-foreground mb-3">
            選擇一個已儲存的參數快照，將自動填入回測表單。
          </p>

          {snapshotsQuery.isLoading ? (
            <div className="text-center py-8 text-muted-foreground">載入中...</div>
          ) : !snapshotsQuery.data?.length ? (
            <div className="text-center py-8 text-muted-foreground">
              <Save className="mx-auto mb-3 h-9 w-9 text-muted-foreground/60" />
              <p>尚無此策略的參數快照</p>
              <p className="text-sm">請先執行回測並儲存快照</p>
            </div>
          ) : (
            <div className="space-y-3 mb-4">
              {snapshotsQuery.data.map((snap: any) => (
                <div
                  key={snap.id}
                  className={`p-4 border rounded-lg cursor-pointer transition ${
                    selectedSnapshotId === snap.id
                      ? "border-purple-500 bg-purple-50 dark:bg-purple-950/30"
                      : "border-border hover:border-muted-foreground/30"
                  }`}
                  onClick={() => setSelectedSnapshotId(snap.id)}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-medium text-sm">{snap.snapshotName}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(snap.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={`font-medium text-sm ${snap.totalReturn >= 0 ? "text-green-500" : "text-red-500"}`}>
                        {snap.totalReturn.toFixed(2)}%
                      </div>
                      <div className="text-xs text-muted-foreground">
                        勝率 {snap.winRate.toFixed(1)}%
                      </div>
                    </div>
                  </div>
                  {strategyKey === RAINBOW_20415_STRATEGY_KEY ? (() => {
                    const cfg = normalizeRainbow20415Config(snap.config);
                    const finalLayer = deriveRainbow20415FinalEnabledLayer(cfg.Martin_Ranges);
                    return (
                      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                        {[
                          ["雙節奏", `${formatRainbow20415Timeframe(cfg.Entry_Timeframe_Minutes)} / ${formatRainbow20415Timeframe(cfg.Management_Interval_Minutes)}`],
                          ["七線", cfg.Lines.map((line) => line.period).join("·")],
                          ["底倉", `${cfg.Base_Lot_Size.value} ${cfg.Base_Lot_Size.mode.toUpperCase()}`],
                          ["最終戰層", `L${finalLayer}`],
                          ["成本止盈", `${cfg.Take_Profit_Pct}%`],
                        ].map(([label, value]) => (
                          <div key={label} className="rounded-md border border-cyan-400/15 bg-cyan-400/[0.04] px-2.5 py-2">
                            <p className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
                            <p className="mt-1 truncate font-mono text-[10px] font-semibold text-cyan-700 dark:text-cyan-200">{value}</p>
                          </div>
                        ))}
                      </div>
                    );
                  })() : strategyKey === V41_STRATEGY_KEY ? (() => {
                    const cfg = normalizeV41Config(snap.config);
                    return (
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                        <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300">
                          入場邏輯：{cfg.entryConditionLogic.toUpperCase()}
                        </Badge>
                        <Badge variant="outline">ENTRY CONDITIONS {countEnabledV41EntryConditions(cfg)}/3</Badge>
                        <span className="min-w-0 break-words text-muted-foreground">{summarizeV41EntryConfig(cfg)}</span>
                      </div>
                    );
                  })() : (
                    <div className="mt-2 truncate text-xs text-muted-foreground">
                      {Object.entries(snap.config || {}).slice(0, 6).map(([k, v]) => (
                        <span key={k} className="mr-3">{k}: {typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                      ))}
                      {Object.keys(snap.config || {}).length > 6 && <span>...</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 參數預覽 */}
          {previewConfig && strategyKey === RAINBOW_20415_STRATEGY_KEY && (
            <div className="mt-4 space-y-3">
              <div>
                <p className="text-sm font-semibold">七彩虹契約覆核</p>
                <p className="mt-1 text-xs text-muted-foreground">下列配置將完整填入回測表單；合法的 0、false 與停用區間均原樣保留。</p>
              </div>
              <Rainbow20415ConfigPanel value={previewConfig} onChange={() => undefined} disabled context="snapshot" />
            </div>
          )}
          {previewConfig && strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY && (
            <div className="mt-4 space-y-3">
              <div>
                <p className="text-sm font-semibold">七彩虹線趨勢跟蹤契約覆核</p>
                <p className="mt-1 text-xs text-muted-foreground">下列配置將完整填入回測表單；馬丁分層表、進場參數、止盈風控均原樣保留。</p>
              </div>
              <RainbowTrendLadderConfigPanel value={previewConfig} onChange={() => undefined} disabled context="snapshot" />
            </div>
          )}
          {previewConfig && strategyKey === V41_STRATEGY_KEY && (
            <div className="mt-4 space-y-3">
              <div>
                <p className="text-sm font-semibold">V4.1 入場條件契約覆核</p>
                <p className="mt-1 text-xs text-muted-foreground">完整同 key 配置將替換目前表單；AND／OR、false、三 K 模式與特殊重入均原樣保留。</p>
              </div>
              <V41EntryConditionsPanel
                value={previewConfig}
                onChange={() => undefined}
                context="snapshot"
                disabled
                readOnly
                validationIssues={previewV41Validation?.issues}
              />
            </div>
          )}
          {previewConfig && strategyKey !== RAINBOW_20415_STRATEGY_KEY && strategyKey !== RAINBOW_TREND_LADDER_STRATEGY_KEY && strategyKey !== V41_STRATEGY_KEY && (
            <div className="mt-4 p-4 bg-muted/50 rounded-lg">
              <div className="text-sm font-medium mb-2">參數預覽（將自動填入）</div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                {Object.entries(previewConfig).slice(0, 12).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-muted-foreground">{k}:</span>{" "}
                    <span className="font-mono">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                  </div>
                ))}
                {Object.keys(previewConfig).length > 12 && <div className="text-muted-foreground">...</div>}
              </div>
            </div>
          )}

          {importMessage && <p className="text-sm text-green-600 mt-2">{importMessage}</p>}

          <DialogFooter className="mt-4">
            <Button
              onClick={handleImportSnapshot}
              disabled={!selectedSnapshotId || !previewConfig || Boolean(previewV41Validation && !previewV41Validation.valid)}
              className="bg-purple-600 hover:bg-purple-700 text-white"
            >
              確認導入
            </Button>
            <Button variant="outline" onClick={() => {
              setShowSnapshotModal(false);
              setSelectedSnapshotId(null);
              setImportMessage("");
            }}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* V5.6 P1：儲存快照命名 Dialog */}
      <Dialog open={showSaveDialog} onOpenChange={(open) => {
        setShowSaveDialog(open);
        if (!open) setSnapshotName("");
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>儲存參數快照</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">快照名稱</label>
              <input
                type="text"
                value={snapshotName}
                onChange={(e) => setSnapshotName(e.target.value)}
                placeholder="輸入自訂名稱，留空則自動生成"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmSaveSnapshot();
                }}
              />
              <p className="text-xs text-muted-foreground">
                提示：可使用參數組合描述（如「EMA5線_階梯800-1500_止盈2%」）方便後續辨識
              </p>
            </div>
            <div className="p-3 bg-muted/50 rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">策略：{selectedStrategy?.name || strategyKey}</div>
              <div className="text-xs text-muted-foreground">參數數量：{Object.keys(configJson).length} 項</div>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={confirmSaveSnapshot}
              disabled={saveSnapshotMutation.isPending}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              <Save className="w-4 h-4 mr-1" />
              {saveSnapshotMutation.isPending ? "儲存中..." : "確認儲存"}
            </Button>
            <Button variant="outline" onClick={() => setShowSaveDialog(false)}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
