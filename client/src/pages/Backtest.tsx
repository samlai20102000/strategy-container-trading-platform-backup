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
import { Play, RotateCcw, Download, Save, Loader2, XCircle, Clock, CheckCircle2, Trash2, ArrowLeft } from "lucide-react";
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

type JobPhase = "idle" | "running" | "done" | "failed";

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
  const [configJson, setConfigJson] = useState<Record<string, unknown>>({});

  // ===== 任務狀態 =====
  const [jobId, setJobId] = useState<string | null>(null);
  const [phase, setPhase] = useState<JobPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");

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
      return registryQuery.data.map(s => ({ key: s.key, name: s.name, defaultConfig: s.defaultConfig as Record<string, unknown>, schemaConfig: s.schemaConfig as SchemaConfig | null }));
    }
    if (backtestStrategiesQuery.data) {
      return backtestStrategiesQuery.data.map(s => ({ ...s, schemaConfig: null as SchemaConfig | null }));
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

  // 選中策略的默認配置
  const selectedStrategy = useMemo(
    () => strategiesQuery.data?.find((s) => s.key === strategyKey),
    [strategiesQuery.data, strategyKey],
  );
  // V4.3: 獲取選中策略的 schemaConfig 用於 DynamicForm fallback
  const selectedSchemaConfig = useMemo(
    () => selectedStrategy && 'schemaConfig' in selectedStrategy ? (selectedStrategy as any).schemaConfig as SchemaConfig | null : null,
    [selectedStrategy],
  );
  // V4.3: 是否使用 DynamicForm（非 KAMA 策略或有 schemaConfig 但無特殊定制的策略）
  const useDynamicFormMode = useMemo(() => {
    if (!strategyKey) return false;
    // KAMA V3.5 策略使用深度定制面板
    if (strategyKey === '20415_KAMA_MARTIN_V35') return false;
    // strategy_20415 (EMATrendMartingale) 也使用深度定制面板
    if (strategyKey === 'strategy_20415') return false;
    // V6.1 高頻掃射策略使用深度定制面板（需要 V4.0 風格馬丁分層 UI）
    if (strategyKey === 'KAMA_3K_HF_V61') return false;
    // 其他策略如果有 schemaConfig 則使用 DynamicForm
    return !!selectedSchemaConfig;
  }, [strategyKey, selectedSchemaConfig]);

  // 策略切換時載入默認配置
  useEffect(() => {
    if (selectedStrategy?.defaultConfig) {
      setConfigJson({ ...selectedStrategy.defaultConfig });
      // 🔥 同步 initialCapital 與 configJson.Initial_Capital，避免參數衝突
      const ic = selectedStrategy.defaultConfig.Initial_Capital;
      if (typeof ic === 'number' && ic > 0) {
        setInitialCapital(String(ic));
      }
      // 🔥 同步 tradeAmount 與 configJson.base_lot_size / Base_Lot_Size
      const bls = selectedStrategy.defaultConfig.base_lot_size ?? selectedStrategy.defaultConfig.Base_Lot_Size;
      if (typeof bls === 'number' && bls > 0) {
        setTradeAmount(String(bls));
      } else if (typeof bls === 'object' && bls !== null && (bls as any).value) {
        setTradeAmount(String((bls as any).value));
      }
    }
  }, [selectedStrategy]);

  // 輪詢進度更新（作為 fallback）
  useEffect(() => {
    const p = progressQuery.data;
    if (!p) return;
    setProgress(p.progress);
    setProgressMsg(p.message);
    if (p.status === "completed") setPhase("done");
    else if (p.status === "failed") {
      setPhase("failed");
      toast.error(p.error ?? "回測失敗");
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
    // O1：Martin_Layers 提交前驗證（與後端 validateMartinLayers 一致）
    if ("Martin_Layers" in configJson) {
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
        timeframe,
        startDate: startMs,
        endDate: endMs,
        initialCapital: capital,
        config: configJson,
        exchange,
        strategyName: selectedStrategy?.name,
        tradeAmount: Number(tradeAmount) || undefined,
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
      Base_Lot_Size: {
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

  const handleImportSnapshot = () => {
    if (!previewConfig) return;
    // 將快照配置合併到當前 configJson
    setConfigJson((prev) => ({ ...prev, ...previewConfig }));
    // 同步 initialCapital
    const ic = (previewConfig as Record<string, unknown>).Initial_Capital;
    if (typeof ic === "number" && ic > 0) setInitialCapital(String(ic));

    // ✅ 完整還原回測設定（交易所、交易對、時間框架、日期、資金、交易金額）
    const snapshotData = snapshotConfigQuery.data;
    const bs = snapshotData?.backtestSettings;
    if (bs) {
      if (bs.exchange) setExchange(bs.exchange as "okx" | "bybit");
      if (bs.symbol) setSymbol(bs.symbol);
      if (bs.timeframe) {
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
    const cfg = { ...configJson, Initial_Capital: Number(initialCapital) || 10000 };
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
      // ✅ 傳遞完整回測設定（交易所、交易對、時間框架、日期、資金、交易金額）
      backtestSettings: {
        exchange,
        symbol: symbol.trim(),
        timeframe: `${tfValue}${tfUnit}`,
        startDate,
        endDate,
        initialCapital: Number(initialCapital) || 10000,
        tradeAmount: Number(tradeAmount) || undefined,
        configJson: cfg,
        baseLotSize: Number(tradeAmount) || undefined,
        baseLotSizeMode: "usdt",
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
                  if (m) { setTfValue(m[1]); setTfUnit(m[2] as "m" | "h" | "d"); }
                }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
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
                <Label className="text-xs">每次交易金額（USDT）</Label>
                <Input
                  type="number"
                  min="1"
                  step="any"
                  lang="en"
                  inputMode="decimal"
                  value={tradeAmount}
                  onChange={(e) => {
                    setTradeAmount(e.target.value);
                    const num = Number(e.target.value);
                    if (Number.isFinite(num) && num > 0) {
                      setConfigJson((prev) => ({
                        ...prev,
                        base_lot_size: num,
                        Base_Lot_Size: num,
                      }));
                    }
                  }}
                  placeholder="每次首單下單金額"
                />
                <p className="text-[10px] text-muted-foreground">首單固定金額，加倉按馬丁倍率遞增</p>
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

            {/* 動態策略參數（UI-3：三大模組化區塊分類）- 內建策略深度定制面板 */}
            {!useDynamicFormMode && Object.keys(configJson).length > 0 && (() => {
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

              const entries = Object.entries(configJson).filter(([k]) => groupOfParam(k) !== 0);
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
                disabled={runMutation.isPending}
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
                disabled={saveSnapshotMutation.isPending}
                title="將當前參數儲存為快照（可於快照庫查看）"
              >
                <Save className="w-4 h-4 mr-1" />
                {saveSnapshotMutation.isPending ? "儲存中..." : "儲存為快照"}
              </Button>
              {(phase === "done" || phase === "failed") && (
                <Button variant="outline" onClick={handleReset}>
                  <RotateCcw className="w-4 h-4 mr-1" />
                  重新設定
                </Button>
              )}
            </div>

            {/* 進度條 */}
            {phase === "running" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Progress value={progress} className="flex-1" />
                  <span className="text-xs font-mono text-muted-foreground w-10 text-right">{Math.round(progress)}%</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs text-red-500 hover:text-red-600"
                    onClick={async () => {
                      if (!jobId) return;
                      try {
                        await cancelMutation.mutateAsync({ jobId });
                        setPhase("idle");
                        setJobId(null);
                        toast.info("任務已取消");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "取消失敗");
                      }
                    }}
                  >
                    <XCircle className="w-3 h-3 mr-0.5" /> 取消
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{progressMsg || "執行中..."}</p>
              </div>
            )}
            {phase === "failed" && (
              <p className="text-xs text-red-500">回測失敗：{progressMsg}</p>
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
            backtestSettings={{
              exchange,
              symbol: symbol.trim(),
              timeframe: `${tfValue}${tfUnit}`,
              startDate,
              endDate,
              initialCapital: Number(initialCapital),
              tradeAmount: Number(tradeAmount) || undefined,
              configJson,
              baseLotSize: Number(tradeAmount) || undefined,
              baseLotSizeMode: "usdt",
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
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
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
              <div className="text-4xl mb-2">📭</div>
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
                  <div className="mt-2 text-xs text-muted-foreground truncate">
                    {Object.entries(snap.config || {}).slice(0, 6).map(([k, v]) => (
                      <span key={k} className="mr-3">{k}: {String(v)}</span>
                    ))}
                    {Object.keys(snap.config || {}).length > 6 && <span>...</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 參數預覽 */}
          {previewConfig && (
            <div className="mt-4 p-4 bg-muted/50 rounded-lg">
              <div className="text-sm font-medium mb-2">📋 參數預覽（將自動填入）</div>
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
              disabled={!selectedSnapshotId || !previewConfig}
              className="bg-purple-600 hover:bg-purple-700 text-white"
            >
              ✅ 確認導入
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
