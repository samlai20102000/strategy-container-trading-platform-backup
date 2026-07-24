import DashboardLayout from "@/components/DashboardLayout";
import { ExchangeBadge, PnlValue } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SymbolCombobox, parseSymbolClient } from "@/components/SymbolCombobox";
import MartinLayersEditor, { parseLayersValue, validateLayersUI } from "@/components/backtest/MartinLayersEditor";
import { DynamicForm, type SchemaConfig, type FieldSchema } from "@/components/DynamicForm";
import { STRATEGIES_DYNAMIC_SCHEMA, STRATEGIES_V20_SCHEMA, getSchemaForStrategy } from "./_strategies_dynamic_schema";
import { V70ConfigPanel, serializeV70Config, deserializeV70Config, type V70Config } from "@/components/V70ConfigPanel";
import { V25ConfigPanel } from "@/components/V25ConfigPanel";
import { trpc } from "@/lib/trpc";
import {
  V25_STRATEGY_KEY,
  createV25DefaultConfig,
  deriveV25MaxMartinLayer,
  normalizeV25Config,
  validateV25Config,
  type V25StrategyConfig,
} from "@shared/strategies/kama3kBreakoutV25";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  FlaskConical,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
  Upload,
  XCircle,
  Zap,
  AlertTriangle,
  LockKeyhole,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";

interface MartinLayerPreviewRow {
  layer: number;
  multiplier: number;
  cumulativeX: number;
  estimatedCost: number;
  avgPrice: number;
  triggerPrice: number;
  lotSize: number;
}

export default function StrategiesPage() {
  return (
    <DashboardLayout>
      <StrategiesContent />
    </DashboardLayout>
  );
}

type StrategyForm = {
  id?: number;
  name: string;
  description: string;
  apiKeyId: string;
  symbol: string;
  positionSize: string;
  positionValue: number | string;  // 倉位大小（USDT 或 BTC 數量）
  positionMode: 'quantity' | 'usdt';  // 倉位模式
  leverage: string;
  direction: "long" | "short" | "both";
  orderType: "market" | "limit";
  maxPositionPct: string;
  stopLossPct: string;
  takeProfitPct: string;
  maxDailyLoss: string;
  martinMultiplier: string;
  maxMartinLevel: string;
  martinSpacingPct: string;
  strategyKey: string;
  /** O1：階梯式馬丁分層（JSON 字串，空 = 固定倍率） */
  martinLayersJson: string;
  /** 🆕 V3.7：硬止損觸發閾值（總浮虧 %，0 = 不啟用） */
  maxLossPct: string;
  /** V3.7：移動止盈回撤（%） */
  callbackPct: string;
  /** V3.7：K 線週期（分鐘） */
  kLinePeriod: string;
  /** O3：第 0 層順勢重入 */
  reentryOnTrend: boolean;
  /** O4：絕對金額限損（USDT，0 = 不啟用） */
  maxLossUsdt: string;
  Initial_Capital: string;
  First_Order_Pct: string;
  Max_Loss_Pct: string;
  /** V4.5：馬丁模式（fixed=固定乘數, layered=階梯式分層） */
  martin_mode: "fixed" | "layered";
  // V6.0：EMA 均線回歸馬丁格爾（優化版）參數
  v2_0?: {
    ema_killer: number;
    ema_wave: number;
    ema_enter: number;
    K_Line_Period: number;
    buffer_points: number;
    Point_Value: number;
    slope_threshold: number;
    Initial_Capital: number;
    multiplier: number;
    max_layers: number;
    pip_step_base: number;
    enable_dynamic_pip: boolean;
    atr_period: number;
    pipstep_atr_multiplier: number;
    pipstep_min: number;
    pipstep_max: number;
    tp_normal: number;
    tp_trend: number;
    trail_normal: number;
    trail_trend: number;
    trend_threshold: number;
    hard_stop_max: number;
    hard_stop_atr_multiplier: number;
  };
  // V7.0：龍捲風雙渦輪配置
  v7_0?: Record<string, any>;
  // V6.1：高頻掃射完整配置
  v6_1?: Record<string, any>;
  // V2.5：KAMA 三K突破｜階梯式馬丁完整配置
  v2_5?: V25StrategyConfig;
};

type SnapshotImportSource = {
  id: number;
  snapshotName: string;
  strategyKey: string;
  strategyName: string;
  config: Record<string, unknown>;
};

function finiteSnapshotNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatSnapshotValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const emptyForm: StrategyForm = {
  name: "",
  description: "",
  apiKeyId: "",
  symbol: "BTCUSDT",
  positionSize: "0.01",
  positionValue: 0.01,  // 默認 BTC 數量模式
  positionMode: 'quantity',  // 默認為數量模式
  leverage: "1",
  direction: "both",
  orderType: "market",
  maxPositionPct: "0",
  stopLossPct: "0",
  takeProfitPct: "0",
  maxDailyLoss: "0",
  martinMultiplier: "1",
  maxMartinLevel: "1",
  martinSpacingPct: "0",
  strategyKey: "none",
  martinLayersJson: "",
  maxLossPct: "6",
  callbackPct: "0.1",
  kLinePeriod: "15",
  reentryOnTrend: true,
  maxLossUsdt: "15",
    Initial_Capital: "100",
  First_Order_Pct: "0.5",
  Max_Loss_Pct: "6",
  martin_mode: "fixed",
  v2_5: createV25DefaultConfig(),
  v2_0: {
    ema_killer: 3,
    ema_wave: 6,
    ema_enter: 15,
    K_Line_Period: 30,
    buffer_points: 8000,
    Point_Value: 0.01,
    slope_threshold: 3.0,
    Initial_Capital: 10000,
    multiplier: 1.5,
    max_layers: 12,
    pip_step_base: 500,
    enable_dynamic_pip: true,
    atr_period: 14,
    pipstep_atr_multiplier: 0.15,
    pipstep_min: 200,
    pipstep_max: 800,
    tp_normal: 150,
    tp_trend: 250,
    trail_normal: 25,
    trail_trend: 30,
    trend_threshold: 50,
    hard_stop_max: -1200,
    hard_stop_atr_multiplier: 0.6,
  },
};

function StrategiesContent() {
  const utils = trpc.useUtils();
  const { data: strategies, isLoading } = trpc.strategies.list.useQuery(undefined, { refetchInterval: 10_000, staleTime: 5_000 });
  const { data: apiKeys } = trpc.apiKeys.list.useQuery();
  // V4.2: 使用 registry 統一數據源
  const { data: registryDefs } = trpc.registry.listDefinitions.useQuery(undefined);
  const { data: studioDefs } = trpc.studio.list.useQuery();
  const definitions = (registryDefs && registryDefs.length > 0) ? registryDefs : studioDefs;
  const [rangeDays, setRangeDays] = useState<string>("30");
  const perfInput = useMemo(() => {
    if (rangeDays === "all") return {};
    const startTime = new Date(Date.now() - parseInt(rangeDays) * 86400_000);
    return { startTime };
  }, [rangeDays]);
  const { data: performance } = trpc.performance.byStrategy.useQuery(perfInput);

  // 🔥 批量獲取有持倉策略的實時價格（供盈虧計算）
  const tickerPairs = useMemo(() => {
    if (!strategies) return [];
    const pairs: { exchange: "bybit" | "okx"; symbol: string }[] = [];
    const seen = new Set<string>();
    for (const s of strategies) {
      const ms = (s as any).martinState;
      const sz = Number(ms?.totalSize) || 0;
      if (sz > 0 && s.exchange && s.symbol) {
        const key = `${s.exchange}:${s.symbol}`;
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push({ exchange: s.exchange as "bybit" | "okx", symbol: s.symbol });
        }
      }
    }
    return pairs;
  }, [strategies]);
  const { data: liveTickersData } = trpc.exchange.getBatchTickers.useQuery(
    { pairs: tickerPairs },
    { enabled: tickerPairs.length > 0, refetchInterval: 10_000, staleTime: 5_000 },
  );
  // 建立 symbol → price 的快速查找 Map
  const livePriceMap = useMemo(() => {
    const m = new Map<string, number>();
    if (liveTickersData) {
      for (const t of liveTickersData) {
        m.set(`${t.exchange}:${t.symbol}`, t.price);
      }
    }
    return m;
  }, [liveTickersData]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<StrategyForm>(emptyForm);

  // V5.3: 從回測報告「以參數建立新策略」跳轉過來時自動讀取 sessionStorage 預填參數
  useEffect(() => {
    const raw = sessionStorage.getItem("importParams");
    if (!raw) return;
    sessionStorage.removeItem("importParams");
    try {
      const imported = JSON.parse(raw) as {
        definitionKey?: string;
        config?: Record<string, any>;
        suggestedName?: string;
        sourceMetrics?: Record<string, number>;
      };
      const cfg = imported.config || {};
      const martinLayersJson = typeof cfg.Martin_Layers === 'string' ? cfg.Martin_Layers : cfg.Martin_Layers ? JSON.stringify(cfg.Martin_Layers) : '';
      const isV25Import = imported.definitionKey === V25_STRATEGY_KEY;
      const v25Config = normalizeV25Config(cfg);
      setForm({
        ...emptyForm,
        name: imported.suggestedName || `${imported.definitionKey || '未知策略'}_導入`,
        symbol: (cfg.symbol || cfg.Symbol || 'BTCUSDT').toUpperCase(),
        strategyKey: imported.definitionKey || 'none',
        positionValue: isV25Import ? v25Config.Base_Lot_Size : (cfg.Base_Lot_Size ?? cfg.First_Order_Pct ?? 0.01),
        positionMode: isV25Import ? "usdt" : emptyForm.positionMode,
        leverage: String(cfg.Leverage || 1),
        direction: cfg.Direction || 'both',
        stopLossPct: isV25Import ? String(v25Config.Hard_Stop_Loss_Pct) : emptyForm.stopLossPct,
        takeProfitPct: isV25Import ? String(v25Config.Take_Profit_Pct) : emptyForm.takeProfitPct,
        martinMultiplier: String(isV25Import ? (v25Config.Martin_Ranges[0]?.multiplier ?? 1) : (cfg.Martin_Multiplier ?? 1.5)),
        maxMartinLevel: String(isV25Import ? Math.max(1, deriveV25MaxMartinLayer(v25Config.Martin_Ranges)) : (cfg.Max_Layers ?? 11)),
        martinSpacingPct: String(isV25Import ? (v25Config.Martin_Ranges[0]?.gap ?? 0) : (cfg.Martin_Step_Pct ?? 2)),
        martinLayersJson,
        maxLossPct: String(cfg.Max_Loss_Pct || 6),
        callbackPct: String(cfg.Callback_Pct || 0.1),
        kLinePeriod: String(isV25Import ? v25Config.K_Line_Period : (cfg.K_Line_Period ?? 15)),
        reentryOnTrend: isV25Import ? v25Config.Reentry_On_Trend : cfg.Reentry_On_Trend !== false,
        maxLossUsdt: String(cfg.Max_Loss_USDT || cfg.EscapeLossUSD || 15),
        Initial_Capital: String(cfg.Initial_Capital || 100),
        First_Order_Pct: String(cfg.First_Order_Pct || 0.5),
        Max_Loss_Pct: String(cfg.Max_Loss_Pct || 6),
        martin_mode: martinLayersJson.trim() ? 'layered' : 'fixed',
        v2_5: isV25Import ? v25Config : createV25DefaultConfig(),
        apiKeyId: apiKeys?.[0] ? String(apiKeys[0].id) : '',
      });
      setDialogOpen(true);
      toast.success(`已從回測報告導入參數，請選擇 API 金鑰後建立策略`);
    } catch {
      // ignore parse errors
    }
  }, [apiKeys]);

  // 從快照導入
  const [showSnapshotImport, setShowSnapshotImport] = useState(false);
  const [snapshotImportSource, setSnapshotImportSource] = useState<SnapshotImportSource | null>(null);
  const snapshotsQuery = trpc.backtest.getSnapshots.useQuery({ limit: 50 }, { enabled: showSnapshotImport });
  // T3：建立成功引導彈窗
  const [successInfo, setSuccessInfo] = useState<{
    name: string;
    symbol: string;
    exchange: string;
    webhookUrl: string | null;
  } | null>(null);

  const createMutation = trpc.strategies.create.useMutation({
    onSuccess: (r) => {
      utils.strategies.list.invalidate();
      setDialogOpen(false);
      setSnapshotImportSource(null);
      setSuccessInfo({
        name: r.name,
        symbol: r.symbol,
        exchange: r.exchange,
        webhookUrl: r.webhookUrl,
      });
    },
    onError: (e) => toast.error(e.message),
  });
  const importSnapshotMutation = trpc.backtest.importSnapshotAsNew.useMutation({
    onSuccess: (r, variables) => {
      const selectedKey = (apiKeys ?? []).find((key) => key.id === variables.apiKeyId);
      utils.strategies.list.invalidate();
      setDialogOpen(false);
      setSnapshotImportSource(null);
      setSuccessInfo({
        name: variables.name,
        symbol: variables.symbol,
        exchange: selectedKey?.exchange ?? "",
        webhookUrl: null,
      });
      toast.success(r.message);
    },
    onError: (e) => toast.error(e.message),
  });
  const updateMutation = trpc.strategies.update.useMutation({
    onSuccess: () => {
      toast.success("策略已更新");
      utils.strategies.list.invalidate();
      setDialogOpen(false);
      setSnapshotImportSource(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const toggleMutation = trpc.strategies.toggle.useMutation({
    onMutate: async (input) => {
      await utils.strategies.list.cancel();
      const prev = utils.strategies.list.getData();
      utils.strategies.list.setData(undefined, (old) =>
        old?.map((s) =>
          s.id === input.id ? { ...s, enabled: input.enabled } : s,
        ),
      );
      return { prev };
    },
    onError: (e, _input, ctx) => {
      if (ctx?.prev) utils.strategies.list.setData(undefined, ctx.prev);
      toast.error(e.message);
    },
    onSettled: () => utils.strategies.list.invalidate(),
  });
  const deleteMutation = trpc.strategies.delete.useMutation({
    onSuccess: () => {
      toast.success("策略已刪除");
      utils.strategies.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const regenMutation = trpc.strategies.regenerateSecret.useMutation({
    onSuccess: () => {
      toast.success("Webhook Secret 已重新產生");
      utils.strategies.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const closeMutation = trpc.strategies.closePosition.useMutation({
    onSuccess: (r) => {
      if (r.success) {
        toast.success(r.message, { duration: 5000 });
      } else {
        toast.error(
          r.exchangeError
            ? `平倉失敗：${r.exchangeError}`
            : r.message,
          { duration: 10000 }
        );
      }
      utils.strategies.list.invalidate();
    },
    onError: (e) => toast.error(`平倉請求異常：${e.message}`, { duration: 10000 }),
  });
  // T2：策略狀態控制（暫停/恢復/停止）
  const setStatusMutation = trpc.strategies.setStatus.useMutation({
    onSuccess: (r) => {
      toast.success(r.message);
      utils.strategies.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const testSignalMutation = trpc.signals.sendTestSignal.useMutation({
    onSuccess: (r) => toast.success(r.message),
    onError: (e) => toast.error(e.message),
  });
  const resetStateMutation = trpc.strategies.resetMartinState.useMutation({
    onSuccess: (r) => {
      toast.success(r.message);
      utils.strategies.list.invalidate();
    },
    onError: (e) => toast.error(`重置失敗：${e.message}`),
  });

  const openCreate = () => {
    setSnapshotImportSource(null);
    setForm({ ...emptyForm, apiKeyId: apiKeys?.[0] ? String(apiKeys[0].id) : "" });
    setDialogOpen(true);
  };

  const openEdit = (s: NonNullable<typeof strategies>[number]) => {
    setSnapshotImportSource(null);
    const positionValue = parseFloat(s.positionSize ?? '0') || 0.01;
    const strategyKey = (s as any).strategyKey || "none";
    const state = ((s as any).martinState as Record<string, any> | null) ?? {};
    const isV25 = strategyKey === V25_STRATEGY_KEY;
    const positionMode: 'quantity' | 'usdt' = isV25 ? "usdt" : ((s as any).positionMode || 'quantity');
    
    setForm({
      id: s.id,
      name: s.name,
      description: s.description ?? "",
      apiKeyId: String(s.apiKeyId),
      symbol: s.symbol,
      positionSize: s.positionSize ?? '',
      positionValue,
      positionMode,
      leverage: String(s.leverage),
      direction: s.direction as StrategyForm["direction"],
      orderType: s.orderType as StrategyForm["orderType"],
      maxPositionPct: s.maxPositionPct,
      stopLossPct: s.stopLossPct,
      takeProfitPct: s.takeProfitPct,
      maxDailyLoss: s.maxDailyLoss,
      martinMultiplier: (s as any).martinMultiplier ?? "1",
      maxMartinLevel: String((s as any).maxMartinLevel ?? 1),
      martinSpacingPct: (s as any).martinSpacingPct ?? "0",
      strategyKey,
      v2_5: isV25 ? normalizeV25Config(state.__v25Config ?? state.__snapshotConfig) : createV25DefaultConfig(),
      // 從 martinState.__v35Config 載入 V3.7 優化參數（若存在）
      ...((): Pick<StrategyForm, "martinLayersJson" | "maxLossPct" | "callbackPct" | "kLinePeriod" | "reentryOnTrend" | "maxLossUsdt" | "Initial_Capital" | "First_Order_Pct" | "Max_Loss_Pct" | "martin_mode"> => {
        const v35 = ((s as any).martinState as Record<string, any> | null)?.__v35Config;
        if (!v35 || typeof v35 !== "object") {
          return { martinLayersJson: "", maxLossPct: "6", callbackPct: "0.1", kLinePeriod: "15", reentryOnTrend: true, maxLossUsdt: "15", Initial_Capital: "100", First_Order_Pct: "0.5", Max_Loss_Pct: "6", martin_mode: "fixed" };
        }
        const martinLayersJson = typeof v35.Martin_Layers === "string" ? v35.Martin_Layers : v35.Martin_Layers ? JSON.stringify(v35.Martin_Layers) : "";
        return {
          martinLayersJson,
          maxLossPct: String(v35.Max_Loss_Pct ?? 6),
          callbackPct: String(v35.Callback_Pct ?? 0.1),
          kLinePeriod: String(v35.K_Line_Period ?? 15),
          reentryOnTrend: v35.Reentry_On_Trend !== false && v35.Reentry_On_Trend !== "false",
          maxLossUsdt: String(v35.Max_Loss_USDT ?? 15),
          Initial_Capital: String(v35.Initial_Capital ?? 100),
          First_Order_Pct: String(v35.First_Order_Pct ?? 0.5),
          Max_Loss_Pct: String(v35.Max_Loss_Pct ?? 6),
          martin_mode: martinLayersJson.trim() ? "layered" : "fixed",
        };
      })(),
      // V6.0：從 martinState.__v2_0Config 載入 EMA 馬丁參數
      ...((): { v2_0?: StrategyForm["v2_0"] } => {
        const v20 = ((s as any).martinState as Record<string, any> | null)?.__v2_0Config;
        if (!v20 || typeof v20 !== "object") return {};
        return {
          v2_0: {
            ema_killer: v20.ema_killer ?? 3,
            ema_wave: v20.ema_wave ?? 6,
            ema_enter: v20.ema_enter ?? 15,
            K_Line_Period: v20.K_Line_Period ?? 30,
            buffer_points: v20.buffer_points ?? 8000,
            Point_Value: v20.Point_Value ?? 0.01,
            slope_threshold: v20.slope_threshold ?? 3.0,
            Initial_Capital: v20.Initial_Capital ?? 10000,
            multiplier: v20.multiplier ?? 1.5,
            max_layers: v20.max_layers ?? 12,
            pip_step_base: v20.pip_step_base ?? 500,
            enable_dynamic_pip: v20.enable_dynamic_pip ?? true,
            atr_period: v20.atr_period ?? 14,
            pipstep_atr_multiplier: v20.pipstep_atr_multiplier ?? 0.15,
            pipstep_min: v20.pipstep_min ?? 200,
            pipstep_max: v20.pipstep_max ?? 800,
            tp_normal: v20.tp_normal ?? 150,
            tp_trend: v20.tp_trend ?? 250,
            trail_normal: v20.trail_normal ?? 25,
            trail_trend: v20.trail_trend ?? 30,
            trend_threshold: v20.trend_threshold ?? 50,
            hard_stop_max: v20.hard_stop_max ?? -1200,
            hard_stop_atr_multiplier: v20.hard_stop_atr_multiplier ?? 0.6,
          },
        };
      })(),
      // V6.1：從 martinState.__v61Config 載入高頻掃射參數
      ...((): { v6_1?: Record<string, any> } => {
        const v61 = ((s as any).martinState as Record<string, any> | null)?.__v61Config;
        if (!v61 || typeof v61 !== "object") return {};
        return { v6_1: v61 };
      })(),
      // V7.0：從 martinState.__v70Config 載入龍捲風雙渦輪參數
      ...((): { v7_0?: Record<string, any> } => {
        const v70 = ((s as any).martinState as Record<string, any> | null)?.__v70Config;
        if (!v70 || typeof v70 !== "object") return {};
        return { v7_0: v70 };
      })(),
    });
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!form.name.trim()) return toast.error("請輸入策略名稱");
    if (!form.apiKeyId) return toast.error("請選擇 API 金鑰");
    if (!form.symbol.trim()) return toast.error("請輸入交易對");
    const isV25 = form.strategyKey === V25_STRATEGY_KEY;
    const v25Validation = isV25 ? validateV25Config(form.v2_5) : null;
    if (v25Validation && !v25Validation.valid) {
      return toast.error(`V2.5 參數設定錯誤：${v25Validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
    }
    const positionValue = isV25
      ? (v25Validation?.config.Base_Lot_Size ?? 0)
      : parseFloat(String(form.positionValue));
    const effectivePositionMode: "quantity" | "usdt" = isV25 ? "usdt" : form.positionMode;
    if (!Number.isFinite(positionValue) || positionValue <= 0)
      return toast.error("倉位大小需為正數");
    // 第二輪優化 3：依交易對規格驗證（數量模式檢查最小量；USDT 模式檢查預估數量）
    if (effectivePositionMode === "quantity" && selectedSpec?.minOrderQty && positionValue < selectedSpec.minOrderQty) {
      return toast.error(
        `倉位小於交易所最小下單量 ${selectedSpec.minOrderQty} ${positionBaseCurrency}`,
      );
    }
    if (effectivePositionMode === "usdt" && estimatedBelowMin) {
      return toast.error(
        `依當前市價換算的數量低於最小下單量 ${selectedSpec?.minOrderQty} ${positionBaseCurrency}，請提高 USDT 金額`,
      );
    }
    // 第二輪優化 3：數量模式需符合步長（qtyStep 整數倍），不符合時自動向下校正並提示確認
    if (effectivePositionMode === "quantity" && selectedSpec?.qtyStep && selectedSpec.qtyStep > 0) {
      const step = selectedSpec.qtyStep;
      const steps = Math.round(positionValue / step);
      const remainder = Math.abs(positionValue - steps * step);
      // 容忍浮點誤差（步長的百萬分之一）
      if (remainder > step * 1e-6) {
        const corrected = Math.max(
          selectedSpec.minOrderQty ?? step,
          Math.floor(positionValue / step) * step,
        );
        const rounded = parseFloat(corrected.toFixed(8));
        setForm((prev) => ({ ...prev, positionValue: rounded }));
        return toast.warning(
          `倉位需為步長 ${step} 的整數倍，已自動校正為 ${rounded} ${positionBaseCurrency}，請確認後再次提交`,
        );
      }
    }

    // O1：Martin_Layers 提交前驗證（重疊/非法値）
    // V4.5：僅在階梯式模式下驗證 layers
    if (form.martin_mode === "layered" && form.martinLayersJson.trim()) {
      const layersErr = validateLayersUI(parseLayersValue(form.martinLayersJson));
      if (layersErr) return toast.error(`階梯式馬丁分層設定錯誤：${layersErr}`);
    }

    if (snapshotImportSource) {
      if (form.id) return toast.error("快照導入只能建立新策略，不能覆蓋現有策略");
      if (form.strategyKey !== snapshotImportSource.strategyKey) {
        return toast.error("策略引擎與快照來源不一致，已停止建立");
      }
      importSnapshotMutation.mutate({
        snapshotId: snapshotImportSource.id,
        name: form.name.trim(),
        apiKeyId: parseInt(form.apiKeyId),
        symbol: form.symbol.trim().toUpperCase(),
        positionSize: positionValue,
        positionMode: effectivePositionMode,
        leverage: parseInt(form.leverage) || 1,
        direction: form.direction,
        orderType: form.orderType,
      });
      return;
    }

    const payload = {
      name: form.name,
      description: form.description || undefined,
      apiKeyId: parseInt(form.apiKeyId),
      symbol: form.symbol,
      positionSize: positionValue,
      leverage: parseInt(form.leverage) || 1,
      direction: form.direction,
      orderType: form.orderType,
      maxPositionPct: parseFloat(form.maxPositionPct) || 0,
      stopLossPct: parseFloat(form.stopLossPct) || 0,
      takeProfitPct: parseFloat(form.takeProfitPct) || 0,
      maxDailyLoss: parseFloat(form.maxDailyLoss) || 0,
      martinMultiplier: parseFloat(form.martinMultiplier) || 1,
      maxMartinLevel: parseInt(form.maxMartinLevel) || 1,
      martinSpacingPct: parseFloat(form.martinSpacingPct) || 0,
      strategyKey: form.strategyKey === "none" ? null : form.strategyKey,
      positionMode: effectivePositionMode,
      v25Config: isV25 ? v25Validation?.config : undefined,
      // V3.7 優化參數（後端存入 martinState.__v35Config）
      v35Config: (form.strategyKey !== V25_STRATEGY_KEY && form.strategyKey !== "strategy_20415" && form.strategyKey !== "KAMA_3K_ULTIMATE_V50") ? {
        Martin_Layers: form.martin_mode === "layered" ? (form.martinLayersJson.trim() || "") : "",
        Reentry_On_Trend: form.reentryOnTrend,
        Max_Loss_USDT: parseFloat(form.maxLossUsdt) || 0,
        Callback_Pct: parseFloat(form.callbackPct) || 0.1,
        K_Line_Period: parseFloat(form.kLinePeriod) || 15,
        Initial_Capital: parseFloat(form.Initial_Capital) || 100,
        First_Order_Pct: parseFloat(form.First_Order_Pct) || 0.5,
        Max_Loss_Pct: parseFloat(form.Max_Loss_Pct) || 6,
      } : undefined,
      // V5.0 極致優化參數（後端存入 martinState.__v50Config）
      v50Config: form.strategyKey === "KAMA_3K_ULTIMATE_V50" ? {
        Initial_Capital: parseFloat(form.Initial_Capital) || 10000,
        Base_Lot_Size: parseFloat(String(form.positionValue)) || 30,
        First_Order_Pct: parseFloat(form.First_Order_Pct) || 0.3,
        Martin_Layers: form.martin_mode === "layered" ? (form.martinLayersJson.trim() || "") : undefined,
        Martin_Multiplier: parseFloat(form.martinMultiplier) || 1.5,
        Max_Layers: parseInt(form.maxMartinLevel) || 13,
        Martin_Step_Pct: parseFloat(form.martinSpacingPct) || 2.0,
        Target_TP_Pct: parseFloat(form.takeProfitPct) || 1.0,
        Callback_Pct: parseFloat(form.callbackPct) || 0.1,
        Max_Loss_Pct: parseFloat(form.Max_Loss_Pct) || 6,
        Max_Drawdown_Pct: 10,
        Max_Loss_USDT: parseFloat(form.maxLossUsdt) || 0,
        K_Line_Period: parseFloat(form.kLinePeriod) || 15,
        Reentry_On_Trend: form.reentryOnTrend,
        KAMA_Fast_Length: 30,
        p2_fastest: 8,
        p3_slowest: 2,
        KAMA_Slow_Length: 55,
        q2_fastest: 10,
        q3_slowest: 8,
        enable_regime_switch: true,
        adx_period: 14,
        atr_period: 14,
        adx_strong_threshold: 30,
        adx_weak_threshold: 20,
        enable_partial_tp: true,
        partial_tp_layer_4: 0.3,
        partial_tp_layer_6: 0.3,
        partial_tp_layer_8: 0.2,
        partial_tp_trigger_pct: 0.5,
        enable_dynamic_tp: true,
        tp_min_pct: 0.8,
        tp_atr_multiplier: 2.5,
        enable_time_filter: true,
        allowed_start_hour: 12,
        allowed_end_hour: 22,
        enable_vol_position: true,
        target_vol_pct: 1.5,
        vol_min_scale: 0.5,
        vol_max_scale: 2.0,
        enable_ai_filter: true,
        kama_slope_lookback: 5,
        kama_slope_min: 0.05,
        volume_ma_period: 20,
        volume_expansion_threshold: 1.5,
      } : undefined,
      // V6.0：EMA 馬丁參數（後端存入 martinState.__v2_0Config）
      v2_0Config: form.strategyKey === "strategy_20415" && form.v2_0 ? {
        ema_killer: form.v2_0.ema_killer,
        ema_wave: form.v2_0.ema_wave,
        ema_enter: form.v2_0.ema_enter,
        K_Line_Period: form.v2_0.K_Line_Period,
        buffer_points: form.v2_0.buffer_points,
        Point_Value: form.v2_0.Point_Value,
        slope_threshold: form.v2_0.slope_threshold,
        Initial_Capital: form.v2_0.Initial_Capital,
        multiplier: form.v2_0.multiplier,
        max_layers: form.v2_0.max_layers,
        pip_step_base: form.v2_0.pip_step_base,
        enable_dynamic_pip: form.v2_0.enable_dynamic_pip,
        atr_period: form.v2_0.atr_period,
        pipstep_atr_multiplier: form.v2_0.pipstep_atr_multiplier,
        pipstep_min: form.v2_0.pipstep_min,
        pipstep_max: form.v2_0.pipstep_max,
        tp_normal: form.v2_0.tp_normal,
        tp_trend: form.v2_0.tp_trend,
        trail_normal: form.v2_0.trail_normal,
        trail_trend: form.v2_0.trail_trend,
        trend_threshold: form.v2_0.trend_threshold,
        hard_stop_max: form.v2_0.hard_stop_max,
        hard_stop_atr_multiplier: form.v2_0.hard_stop_atr_multiplier,
      } : undefined,
      // V6.1：高頻掃射參數（後端存入 martinState.__v61Config）
      // 馬丁參數統一由分層表格控制：max_layers 自動從 Martin_Layers 計算
      v61Config: form.strategyKey === "KAMA_3K_HF_V61" ? (() => {
        const martinLayersStr = form.martin_mode === "layered" ? (form.martinLayersJson.trim() || "") : undefined;
        // 從分層表格自動計算 max_layers（與 V4.0 架構一致）
        let effectiveMaxLayers = parseInt(form.maxMartinLevel) || 13;
        if (martinLayersStr) {
          try {
            const parsed = JSON.parse(martinLayersStr);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const sorted = [...parsed].sort((a: any, b: any) => a.start - b.start);
              effectiveMaxLayers = sorted[sorted.length - 1].end;
            }
          } catch { /* fallback to form value */ }
        }
        // 從 form.v6_1（快照/編輯載入的完整配置）讀取 KAMA 參數，否則使用策略默認值
        const v61Prev = (form as any).v6_1 as Record<string, any> | undefined;
        return {
          // 保留已有的完整配置（從快照/編輯載入）
          ...(v61Prev ? v61Prev : {}),
          // 以下欄位始終從表單控件讀取（覆蓋快照值）
          initial_capital: parseFloat(form.Initial_Capital) || 500,
          base_lot_size: parseFloat(String(form.positionValue)) || 15,
          max_drawdown_pct: parseFloat(form.Max_Loss_Pct) || 15,
          // KAMA 參數：優先使用 v6_1 中的值（來自快照/編輯），否則使用策略默認值
          kama_fast_length: Number(v61Prev?.kama_fast_length) || 30,
          kama_fast_fastest: Number(v61Prev?.kama_fast_fastest) || 8,
          kama_fast_slowest: Number(v61Prev?.kama_fast_slowest) || 2,
          kama_slow_length: Number(v61Prev?.kama_slow_length) || 55,
          kama_slow_fastest: Number(v61Prev?.kama_slow_fastest) || 10,
          kama_slow_slowest: Number(v61Prev?.kama_slow_slowest) || 8,
          // 區域觸發參數
          zone_width_pct: Number(v61Prev?.zone_width_pct) || 0.3,
          zone_tp_pct: Number(v61Prev?.zone_tp_pct) || 0.4,
          zone_sl_pct: Number(v61Prev?.zone_sl_pct) || 0.6,
          trailing_callback_pct: parseFloat(form.callbackPct) || Number(v61Prev?.trailing_callback_pct) || 0.15,
          martin_step_pct: parseFloat(form.martinSpacingPct) || 2.0,
          martin_multiplier: parseFloat(form.martinMultiplier) || 1.5,
          max_layers: effectiveMaxLayers,
          Max_Layers: effectiveMaxLayers,
          martin_mode: form.martin_mode || "fixed",
          Martin_Layers: martinLayersStr,
          Martin_Multiplier: parseFloat(form.martinMultiplier) || 1.5,
          Martin_Step_Pct: parseFloat(form.martinSpacingPct) || 2.0,
          timeframe: parseFloat(form.kLinePeriod) || 15,
          cooldown_bars: Number(v61Prev?.cooldown_bars) ?? 2,
          enable_bar_lock: v61Prev?.enable_bar_lock !== undefined ? v61Prev.enable_bar_lock : true,
          enable_partial_tp: v61Prev?.enable_partial_tp !== undefined ? v61Prev.enable_partial_tp : true,
          partial_tp_layer_4: Number(v61Prev?.partial_tp_layer_4) || 0.3,
          partial_tp_layer_6: Number(v61Prev?.partial_tp_layer_6) || 0.3,
          partial_tp_layer_8: Number(v61Prev?.partial_tp_layer_8) || 0.2,
          partial_tp_trigger_pct: Number(v61Prev?.partial_tp_trigger_pct) || 0.3,
          // 額外保留 V6.1 專屬參數
          buffer_atr_multiplier_trend: Number(v61Prev?.buffer_atr_multiplier_trend) || 0.25,
          buffer_atr_multiplier_weak: Number(v61Prev?.buffer_atr_multiplier_weak) || 0.30,
          buffer_atr_multiplier_ranging: Number(v61Prev?.buffer_atr_multiplier_ranging) || 0.50,
          entry_zone_mode: v61Prev?.entry_zone_mode || "breakout",
          direction_mode: v61Prev?.direction_mode || "hybrid",
          min_atr_ratio: Number(v61Prev?.min_atr_ratio) || 0.7,
          enable_continuous_entry: v61Prev?.enable_continuous_entry !== undefined ? v61Prev.enable_continuous_entry : true,
          cooldown_minutes: Number(v61Prev?.cooldown_minutes) || 0,
          adx_period: Number(v61Prev?.adx_period) || 14,
          adx_trend_threshold: Number(v61Prev?.adx_trend_threshold) || 25,
          adx_strong_threshold: Number(v61Prev?.adx_strong_threshold) || 30,
          atr_ratio_threshold: Number(v61Prev?.atr_ratio_threshold) || 1.2,
        };
      })() : undefined,
      // V7.0：龍捲風雙渦輪配置
      v70Config: form.strategyKey === "KAMA_3K_TORNADO_V70" ? (() => {
        const v70Prev = form.v7_0 as Record<string, any> | undefined;
        return {
          ...(v70Prev ? v70Prev : {}),
          base_lot_size_usdt: Number(v70Prev?.base_lot_size_usdt) || 150,
          leverage: Number(v70Prev?.leverage) || 5,
          timeframe: String(v70Prev?.timeframe || "5m"),
          ma200_enabled: v70Prev?.ma200_enabled !== false,
          ma200_period: Number(v70Prev?.ma200_period) || 200,
          ma200_type: v70Prev?.ma200_type || "SMA",
          ma200_oscillation_filter_pct: Number(v70Prev?.ma200_oscillation_filter_pct) ?? 0.015,
          kama_fast_er_period: Number(v70Prev?.kama_fast_er_period) || 50,
          kama_fast_fast_const: Number(v70Prev?.kama_fast_fast_const) || 10,
          kama_fast_slow_const: Number(v70Prev?.kama_fast_slow_const) || 2,
          kama_slow_er_period: Number(v70Prev?.kama_slow_er_period) || 50,
          kama_slow_fast_const: Number(v70Prev?.kama_slow_fast_const) || 10,
          kama_slow_slow_const: Number(v70Prev?.kama_slow_slow_const) || 6,
          cross_mode: v70Prev?.cross_mode || "both",
          risk_hard_stop_pct: Number(v70Prev?.risk_hard_stop_pct) ?? 4.5,
          risk_ma_force_liq: v70Prev?.risk_ma_force_liq !== false,
          risk_reverse_cross_close: v70Prev?.risk_reverse_cross_close !== false,
          risk_reverse_cross_profit_limit: Number(v70Prev?.risk_reverse_cross_profit_limit) ?? 1.5,
          trailing_enabled: v70Prev?.trailing_enabled !== false,
          trailing_activation_pct: Number(v70Prev?.trailing_activation_pct) || 3.0,
          trailing_retracement_pct: Number(v70Prev?.trailing_retracement_pct) || 1.5,
          martin_enabled: v70Prev?.martin_enabled !== false,
          martin_max_layers: Number(v70Prev?.martin_max_layers) || 11,
          martin_layer_tp_long: Number(v70Prev?.martin_layer_tp_long) || 0.30,
          martin_layer_tp_short: Number(v70Prev?.martin_layer_tp_short) || 0.20,
          martin_layers: v70Prev?.martin_layers || JSON.stringify([
            {start:1,end:4,multiplier:1.5,gap_long:0.60,gap_short:0.40},
            {start:5,end:9,multiplier:1.1,gap_long:1.00,gap_short:0.70},
            {start:10,end:11,multiplier:1.0,gap_long:1.80,gap_short:1.20}
          ]),
        };
      })() : undefined,
    };
    if (form.id) updateMutation.mutate({ ...payload, id: form.id });
    else createMutation.mutate(payload);
  };

  const saving = createMutation.isPending || updateMutation.isPending || importSnapshotMutation.isPending;

  // 優化 1：由所選 API 金鑰推導交易所（供交易對下拉選單拉取對應清單）
  const selectedApiKeyObj = (apiKeys ?? []).find((k) => String(k.id) === form.apiKeyId);
  const selectedExchange: "bybit" | "okx" =
    (selectedApiKeyObj?.exchange as "bybit" | "okx") || "okx";
  // ★ 核心修復：獲取所選 API Key 的 isTestnet 狀態，用於過濾交易對清單
  const selectedTestnet = selectedApiKeyObj?.isTestnet ?? false;

  // 優化 2：從交易對提取基礎貨幣（BTCUSDT → BTC，ETHUSDT → ETH），倉位單位動態跟隨
  const positionBaseCurrency = parseSymbolClient(form.symbol || "BTCUSDT").base;

  // 第二輪優化 3：從交易對清單中找出所選交易對的規格（最小下單量/步長）
  // ★ 核心修復：傳入 testnet 參數，確保規格匹配對應環境
  const symbolsForSpecs = trpc.exchange.getSymbols.useQuery(
    { exchange: selectedExchange, category: "linear", testnet: selectedTestnet },
    { enabled: dialogOpen, staleTime: 10 * 60 * 1000 },
  );
  const selectedSpec = (symbolsForSpecs.data ?? []).find((s) => s.symbol === form.symbol);

  // 第二輪優化 2：USDT 模式即時換算預估數量（依當前市價，15 秒自動刷新）
  const tickerQuery = trpc.exchange.getTicker.useQuery(
    { exchange: selectedExchange, symbol: form.symbol, category: "linear" },
    {
      enabled: dialogOpen && form.positionMode === "usdt" && !!form.symbol,
      refetchInterval: 15000,
      staleTime: 5000,
      retry: 1,
    },
  );
  const estimatedQty = (() => {
    const usdt = parseFloat(String(form.positionValue));
    const price = tickerQuery.data?.price;
    if (form.positionMode !== "usdt" || !price || !Number.isFinite(usdt) || usdt <= 0) return null;
    let qty = usdt / price;
    // 依步長向下取整，更貧實地反映實際可下單數量
    if (selectedSpec?.qtyStep && selectedSpec.qtyStep > 0) {
      qty = Math.floor(qty / selectedSpec.qtyStep) * selectedSpec.qtyStep;
    }
    return qty;
  })();
  // 預估數量低於最小下單量時提醒
  const estimatedBelowMin =
    estimatedQty !== null && !!selectedSpec?.minOrderQty && estimatedQty < selectedSpec.minOrderQty;

  // ❗ 多策略共用帳戶警告：偵測同一 API Key + 同一幣對的其他策略
  const sharedAccountWarning = useMemo(() => {
    if (!form.apiKeyId || !form.symbol || !strategies) return null;
    const conflicting = strategies.filter(
      (s) =>
        String(s.apiKeyId) === form.apiKeyId &&
        s.symbol.toUpperCase() === form.symbol.toUpperCase() &&
        s.id !== form.id // 排除自己（編輯模式）
    );
    if (conflicting.length === 0) return null;
    return conflicting.map((s) => s.name).join("、");
  }, [form.apiKeyId, form.symbol, form.id, strategies]);

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label}已複製`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">策略交易</h1>
          <p className="text-sm text-muted-foreground mt-1">
            管理交易策略，支援 Webhook 信號觸發與 Heartbeat 自動交易兩種模式
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" />
            新增策略
          </Button>
          <Button variant="outline" className="border-cyan-600 text-cyan-400 hover:bg-cyan-600/10" onClick={() => setShowSnapshotImport(true)}>
            <Upload className="h-4 w-4 mr-1" />
            從快照導入
          </Button>
        </div>
      </div>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">策略列表</TabsTrigger>
          <TabsTrigger value="performance">績效統計</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4">
          {isLoading ? (
            <Card>
              <CardContent className="py-8 flex justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </CardContent>
            </Card>
          ) : !strategies || strategies.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center space-y-3">
                <Settings2 className="h-8 w-8 mx-auto text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">
                  尚未建立策略。
                  {(!apiKeys || apiKeys.length === 0) && (
                    <>
                      請先前往
                      <Link href="/api-keys" className="text-primary hover:underline mx-1">
                        API 設定
                      </Link>
                      新增交易所金鑰。
                    </>
                  )}
                </p>
                <Button variant="outline" onClick={openCreate}>
                  <Plus className="h-4 w-4 mr-1" />
                  建立第一個策略
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {strategies.map((s) => (
                <Card key={s.id} className={!s.enabled ? "opacity-70" : ""}>
                  <CardContent className="pt-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium truncate">{s.name}</span>
                        <ExchangeBadge exchange={s.exchange} />
                        <Badge variant="outline" className="text-[10px]">
                          {s.symbol}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {s.enabled ? (
                          <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]" variant="outline">
                            運行中
                          </Badge>
                        ) : s.disabledReason === "手動暫停" ? (
                          <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px]" variant="outline">
                            已暫停
                          </Badge>
                        ) : (
                          <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/30 text-[10px]" variant="outline">
                            已停止
                          </Badge>
                        )}
                        <Switch
                          checked={s.enabled}
                          title={s.enabled ? "關閉即暫停接收訊號" : "開啟即恢復接收訊號"}
                          onCheckedChange={(v) =>
                            toggleMutation.mutate({ id: s.id, enabled: v })
                          }
                        />
                      </div>
                    </div>

                    {!s.enabled && s.disabledReason && (
                      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-400">
                        停用原因：{s.disabledReason}
                      </div>
                    )}

                    <div className="grid grid-cols-4 gap-2 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">倉位</p>
                        <p className="font-mono-nums">{s.positionSize}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">槓桿</p>
                        <p className="font-mono-nums">{s.leverage}x</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">方向</p>
                        <p>
                          {s.direction === "both"
                            ? "雙向"
                            : s.direction === "long"
                              ? "只多"
                              : "只空"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">下單類型</p>
                        <p>{s.orderType === "market" ? "市價" : "限價"}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-4 gap-2 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">最大倉位%</p>
                        <p className="font-mono-nums">
                          {parseFloat(s.maxPositionPct) > 0 ? `${s.maxPositionPct}%` : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">止損</p>
                        <p className="font-mono-nums">
                          {parseFloat(s.stopLossPct) > 0 ? `${s.stopLossPct}%` : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">止盈</p>
                        <p className="font-mono-nums">
                          {parseFloat(s.takeProfitPct) > 0 ? `${s.takeProfitPct}%` : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">日虧上限</p>
                        <p className="font-mono-nums">
                          {parseFloat(s.maxDailyLoss) > 0 ? `${s.maxDailyLoss}U` : "—"}
                        </p>
                      </div>
                    </div>

                    {/* 本策略持倉狀態 */}
                    {(() => {
                      const ms = (s.martinState as any) || {};
                      const sz = Number(ms.totalSize) || 0;
                      const layer = Number(ms.currentLayer) || 0;
                      const avgP = Number(ms.avgPrice) || 0;
                      const dir = ms.isLong ? 'Long' : 'Short';
                      const baseCurrency = s.symbol.replace(/USDT$|USD$|-USDT-SWAP$|-USD-SWAP$/i, '');
                      // 實時價格查找
                      const livePrice = livePriceMap.get(`${s.exchange}:${s.symbol}`) || 0;
                      // 當前市值 = 持倉數量 × 實時價格
                      const currentValue = livePrice > 0 ? sz * livePrice : sz * avgP;
                      // 入場成本 = 持倉數量 × 均價
                      const entryCost = sz * avgP;
                      // 保證金 = 入場成本 / 槓桿倍數（與 OKX 一致）
                      const leverage = Number(s.leverage) || 1;
                      const margin = entryCost / leverage;
                      // 未實現盈虧（考慮做多/做空方向）
                      const unrealizedPnl = livePrice > 0
                        ? (ms.isLong ? (livePrice - avgP) * sz : (avgP - livePrice) * sz)
                        : 0;
                      // 🔥 盈虧百分比基於保證金（而非入場成本），與 OKX 一致
                      const unrealizedPnlPct = margin > 0 && livePrice > 0
                        ? (unrealizedPnl / margin) * 100
                        : 0;
                      if (sz > 0) {
                        return (
                          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5">
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-emerald-400 font-medium">本策略持倉</span>
                              <span className="text-xs text-muted-foreground">第 {layer} 層</span>
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="font-mono-nums text-sm font-semibold text-foreground">{parseFloat(sz.toPrecision(10))} {baseCurrency}</span>
                              <span className="font-mono-nums text-xs text-muted-foreground">(≈ {entryCost.toFixed(2)} USDT)</span>
                              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ms.isLong ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{dir}</span>
                              {avgP > 0 && <span className="text-xs text-muted-foreground">均價 {avgP.toFixed(2)}</span>}
                            </div>
                            {/* 實時盈虧顯示 */}
                            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-emerald-500/20">
                              {livePrice > 0 ? (
                                <>
                                  <span className="text-xs text-muted-foreground">現價</span>
                                  <span className="font-mono-nums text-xs font-semibold text-foreground">{livePrice.toFixed(2)}</span>
                                  <span className="text-xs text-muted-foreground">市值</span>
                                  <span className="font-mono-nums text-xs font-semibold text-foreground">{currentValue.toFixed(2)} USDT</span>
                                  <span className={`font-mono-nums text-xs font-bold ${unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    {unrealizedPnl >= 0 ? '+' : ''}{unrealizedPnl.toFixed(2)} USDT ({unrealizedPnlPct >= 0 ? '+' : ''}{unrealizedPnlPct.toFixed(2)}%)
                                  </span>
                                </>
                              ) : (
                                <span className="text-xs text-muted-foreground animate-pulse">載入實時價格中...</span>
                              )}
                            </div>
                            {/* 距下一層加倉提示 */}
                            {(() => {
                              const strategyKey = (s as any).strategyKey || '';
                              const maxLayers = Number((s as any).maxMartinLevel) || 11;
                              // 已滿層不顯示
                              if (layer >= maxLayers) {
                                return (
                                  <div className="flex items-center gap-1.5 mt-1.5 px-2 py-1 rounded bg-amber-500/10 border border-amber-500/20">
                                    <span className="text-[10px] text-amber-400">⚠️ 已達最大層數 {layer}/{maxLayers}，等待止盈/止損</span>
                                  </div>
                                );
                              }
                              // 計算加倉觸發價格和距離百分比
                              // 全系統統一：deviation = (lastLayerPrice - currentPrice) / lastLayerPrice >= stepPct（方向感知）
                              // 基準價 = lastLayerPrice（上一層加倉價格），確保每層加倉都是從上一層偏離 stepPct%
                              const lastLayerPrice = Number(ms.lastLayerPrice) || avgP;
                              const isLong = ms.isLong === true;
                              let stepPct = 2.0; // 默認
                              let basePrice = lastLayerPrice; // 統一用 lastLayerPrice
                              let useLastLayer = true;

                              if (strategyKey === 'KAMA_3K_ULTIMATE_V50' || strategyKey === 'KAMA_3K_HF_V61') {
                                // V5.0/V6.1 用 lastLayerPrice
                                basePrice = lastLayerPrice;
                                useLastLayer = true;
                                // 讀取配置中的全局 Martin_Step_Pct
                                const cfgKey = strategyKey === 'KAMA_3K_ULTIMATE_V50' ? '__v50Config' : '__v61Config';
                                const cfg = (ms as any)?.[cfgKey];
                                if (cfg) {
                                  const globalStep = Number(cfg.Martin_Step_Pct ?? cfg.martin_step_pct) || parseFloat((s as any).martinSpacingPct) || 2.0;
                                  // 🔥 修復：Martin_Layers 可能是 JSON 字串或陣列，統一解析
                                  let parsedLayers: any[] = [];
                                  const martinLayers = cfg.Martin_Layers;
                                  if (Array.isArray(martinLayers)) {
                                    parsedLayers = martinLayers;
                                  } else if (typeof martinLayers === 'string' && martinLayers.trim() && martinLayers.trim() !== '[]') {
                                    try { parsedLayers = JSON.parse(martinLayers); } catch { /* ignore */ }
                                  }
                                  if (parsedLayers.length > 0) {
                                    const nextL = layer + 1;
                                    const matchedRule = parsedLayers.find((r: any) => nextL >= r.start && nextL <= r.end);
                                    stepPct = (matchedRule?.stepPct && matchedRule.stepPct > 0) ? matchedRule.stepPct : globalStep;
                                  } else {
                                    stepPct = globalStep;
                                  }
                                }
                              } else if (strategyKey === '20415_KAMA_MARTIN_V35') {
                                // V3.5/V4.0 用 lastLayerPrice（與後端一致，從上一層價格偏離 stepPct%）
                                basePrice = lastLayerPrice;
                                useLastLayer = true;
                                const v35Cfg = (ms as any)?.__v35Config;
                                if (v35Cfg) {
                                  const globalStep = Number(v35Cfg.Martin_Step_Pct) || parseFloat((s as any).martinSpacingPct) || 2.0;
                                  // 🔥 修復：Martin_Layers 可能是 JSON 字串或陣列，統一解析
                                  let parsedLayers: any[] = [];
                                  const martinLayers = v35Cfg.Martin_Layers;
                                  if (Array.isArray(martinLayers)) {
                                    parsedLayers = martinLayers;
                                  } else if (typeof martinLayers === 'string' && martinLayers.trim() && martinLayers.trim() !== '[]') {
                                    try { parsedLayers = JSON.parse(martinLayers); } catch { /* ignore */ }
                                  }
                                  if (parsedLayers.length > 0) {
                                    const nextL = layer + 1;
                                    const matchedRule = parsedLayers.find((r: any) => nextL >= r.start && nextL <= r.end);
                                    stepPct = (matchedRule?.stepPct && matchedRule.stepPct > 0) ? matchedRule.stepPct : globalStep;
                                  } else {
                                    stepPct = globalStep;
                                  }
                                }
                              } else if (strategyKey === 'strategy_20415') {
                                // V2.0 EMA 馬丁：用 pip_step_base（USD 絕對值），不用百分比
                                basePrice = lastLayerPrice;
                                useLastLayer = true;
                                const v20Cfg = (ms as any)?.__v2_0Config;
                                const pipStepBase = Number(v20Cfg?.pip_step_base) || 500;
                                // 轉換為百分比：pipStepBase / basePrice * 100
                                stepPct = basePrice > 0 ? (pipStepBase / basePrice) * 100 : 2.0;
                              } else {
                                // 通用策略：使用頂層 martinSpacingPct
                                stepPct = parseFloat((s as any).martinSpacingPct) || 2.0;
                              }

                              if (basePrice <= 0 || stepPct <= 0) return null;

                              // 🔥 stepPct 已是基於價格偏離%（不乘槓桿），觸發價直接用 stepPct
                              const leverage = Number(s.leverage) || 1;

                              // 計算觸發價格（基於價格偏離%）
                              let triggerPrice: number;
                              if (isLong) {
                                // 做多：價格下跌觸發加倉
                                triggerPrice = basePrice * (1 - stepPct / 100);
                              } else {
                                // 做空：價格上漲觸發加倉
                                triggerPrice = basePrice * (1 + stepPct / 100);
                              }

                              // 計算當前偏離（基於價格偏離%，不乘槓桿）
                              let currentDeviation: number;
                              if (isLong) {
                                currentDeviation = livePrice > 0 ? ((basePrice - livePrice) / basePrice) * 100 : 0;
                              } else {
                                currentDeviation = livePrice > 0 ? ((livePrice - basePrice) / basePrice) * 100 : 0;
                              }

                              // 剩餘距離百分比
                              const remainingPct = stepPct - currentDeviation;
                              const progressPct = stepPct > 0 ? Math.min(100, Math.max(0, (currentDeviation / stepPct) * 100)) : 0;

                              if (livePrice <= 0) return null;

                              return (
                                <div className="mt-1.5 px-2 py-1.5 rounded bg-blue-500/5 border border-blue-500/15">
                                  <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-blue-400/80">距第 {layer + 1} 層加倉</span>
                                    <span className="text-[10px] text-muted-foreground">
                                      {useLastLayer ? '基準: 上層價' : '基準: 均價'} {basePrice.toFixed(2)}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 mt-1">
                                    <div className="flex-1 h-1.5 rounded-full bg-muted/30 overflow-hidden">
                                      <div
                                        className={`h-full rounded-full transition-all duration-300 ${
                                          progressPct >= 80 ? 'bg-red-500' : progressPct >= 50 ? 'bg-amber-500' : 'bg-blue-500'
                                        }`}
                                        style={{ width: `${progressPct}%` }}
                                      />
                                    </div>
                                    <span className={`font-mono-nums text-[11px] font-semibold ${
                                      remainingPct <= 0.5 ? 'text-red-400' : remainingPct <= 1.0 ? 'text-amber-400' : 'text-blue-400'
                                    }`}>
                                      {remainingPct > 0 ? `還差 ${remainingPct.toFixed(2)}%` : '已達觸發條件'}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between mt-0.5">
                                    <span className="text-[10px] text-muted-foreground">
                                      觸發價 {triggerPrice.toFixed(2)} | 間距 {stepPct.toFixed(1)}%
                                    </span>
                                    <span className="text-[10px] text-muted-foreground">
                                      已偏離 {currentDeviation.toFixed(2)}%
                                    </span>
                                  </div>
                                </div>
                              );
                            })()}
                            {/* 🔥 方案 B：與交易所同步按鈕 */}
                            <SyncExchangeButton strategyId={s.id} />
                          </div>
                        );
                      }
                      return (
                        <div className="rounded-lg border border-muted/30 bg-muted/5 p-2.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">本策略持倉</span>
                            <span className="text-xs text-muted-foreground">— 無持倉</span>
                          </div>
                        </div>
                      );
                    })()}

                    {/* 交易模式切換 */}
                    <AutoTradeModeSection strategy={s} />

                    {/* Webhook URL - 僅在 webhook 模式下顯示 */}
                    {((s as any).tradeMode || "webhook") === "webhook" && (
                    <div className="rounded-lg border bg-secondary/30 p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          TradingView Webhook URL
                        </span>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            title="複製 URL"
                            onClick={() => copyText(s.webhookUrl, "Webhook URL ")}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            title="重新產生 Secret"
                            onClick={() => {
                              if (confirm("重新產生後，舊的 Webhook URL 將失效。確定？")) {
                                regenMutation.mutate({ id: s.id });
                              }
                            }}
                          >
                            <RefreshCw className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      <p className="text-[11px] font-mono-nums text-muted-foreground break-all leading-relaxed">
                        {s.webhookUrl}
                      </p>
                      <button
                        className="text-[11px] text-primary hover:underline"
                        onClick={() =>
                          copyText(
                            JSON.stringify({
                              action: "buy",
                              symbol: "{{ticker}}",
                              price: "{{close}}",
                            }).replace('"{{close}}"', "{{close}}"),
                            "Alert 訊息範本",
                          )
                        }
                      >
                        複製 TradingView Alert 訊息範本（action 可為 buy / sell / close）
                      </button>
                    </div>
                    )}

                    <div className="flex items-center gap-2">
                      {/* T2：暫停 / 恢復 / 停止 控制按鈕 */}
                      {s.enabled ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          disabled={setStatusMutation.isPending}
                          title="暫停：不再接收訊號，保留馬丁狀態"
                          onClick={() =>
                            setStatusMutation.mutate({ id: s.id, status: "paused" })
                          }
                        >
                          <Pause className="h-3.5 w-3.5 mr-1" />
                          暫停
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 border-emerald-500/40 text-emerald-400 hover:text-emerald-300"
                          disabled={setStatusMutation.isPending}
                          title="恢復接收訊號並自動交易"
                          onClick={() =>
                            setStatusMutation.mutate({ id: s.id, status: "running" })
                          }
                        >
                          <Play className="h-3.5 w-3.5 mr-1" />
                          恢復
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        disabled={setStatusMutation.isPending || (!s.enabled && s.disabledReason !== "手動暫停")}
                        title="停止：不再接收訊號並重置馬丁狀態"
                        onClick={() => {
                          if (confirm(`停止策略「${s.name}」？\n停止後將重置馬丁加倉狀態，下次啟動從初始倉位開始。`)) {
                            setStatusMutation.mutate({ id: s.id, status: "stopped" });
                          }
                        }}
                      >
                        <Square className="h-3.5 w-3.5 mr-1" />
                        停止
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-red-500/40 text-red-400 hover:text-red-300"
                        disabled={closeMutation.isPending}
                        title="精確平倉：只平本策略記錄的持倉數量，不影響同帳戶其他策略"
                        onClick={() => {
                          const ms = (s.martinState as any) || {};
                          const sz = Number(ms.totalSize) || 0;
                          const dir = ms.isLong ? 'long' : 'short';
                          if (
                            confirm(`確定對 ${s.symbol} 執行精確平倉？\n平倉數量: ${parseFloat(sz.toPrecision(10))} (${dir})\n不影響同帳戶其他策略`) &&
                            confirm(`【二次確認】將以市價立即平掉本策略的 ${parseFloat(sz.toPrecision(10))} ${s.symbol} (${dir})，並自動暫停策略。此操作不可撤銷，確定執行？`)
                          ) {
                            closeMutation.mutate({ id: s.id, pauseAfterClose: true });
                          }
                        }}
                      >
                        {closeMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 mr-1" />
                        )}
                        平倉
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => openEdit(s)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 border-amber-500/40 text-amber-400 hover:text-amber-300"
                        disabled={resetStateMutation.isPending}
                        title="精確重置：只平本策略記錄的持倉 + 清零本地狀態，不影響同帳戶其他策略"
                        onClick={() => {
                          const ms = (s.martinState as any) || {};
                          const sz = Number(ms.totalSize) || 0;
                          const dir = ms.isLong ? 'long' : 'short';
                          if (confirm(`確定重置策略「${s.name}」？\n\n此操作將：\n1. 精確平掉本策略記錄的持倉（${sz > 0 ? `${parseFloat(sz.toPrecision(10))} ${dir}` : '無持倉'}）\n2. 清零本地馬丁狀態\n3. 下次輪詢將從首單開倉開始\n\nℹ️ 不影響同帳戶其他策略的持倉`)) {
                            resetStateMutation.mutate({ id: s.id });
                          }
                        }}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        disabled={testSignalMutation.isPending}
                        title="發送模擬 BUY 信號至訊號日誌（不實際下單）"
                        onClick={() => testSignalMutation.mutate({ strategyId: s.id })}
                      >
                        {testSignalMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        ) : (
                          <FlaskConical className="h-3.5 w-3.5 mr-1" />
                        )}
                        測試信號
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive shrink-0"
                        onClick={() => {
                          if (confirm(`確定刪除策略「${s.name}」？`)) {
                            deleteMutation.mutate({ id: s.id });
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="performance" className="mt-4 space-y-4">
          <div className="flex items-center gap-2">
            <Label className="text-sm text-muted-foreground">時間範圍</Label>
            <Select value={rangeDays} onValueChange={setRangeDays}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">近 7 天</SelectItem>
                <SelectItem value="30">近 30 天</SelectItem>
                <SelectItem value="90">近 90 天</SelectItem>
                <SelectItem value="all">全部</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Card>
            <CardContent className="pt-5">
              {!performance || performance.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  尚無績效資料
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b">
                        <th className="pb-2 pr-4 font-medium">策略</th>
                        <th className="pb-2 pr-4 font-medium">交易對</th>
                        <th className="pb-2 pr-4 font-medium text-right">交易次數</th>
                        <th className="pb-2 pr-4 font-medium text-right">已平倉</th>
                        <th className="pb-2 pr-4 font-medium text-right">勝率</th>
                        <th className="pb-2 pr-4 font-medium text-right">總盈虧</th>
                        <th className="pb-2 font-medium text-right">最大回撤</th>
                      </tr>
                    </thead>
                    <tbody>
                      {performance.map((p) => (
                        <tr key={p.strategyId} className="border-b border-border/50 last:border-0">
                          <td className="py-2.5 pr-4">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{p.strategyName}</span>
                              {!p.enabled && (
                                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                  停用
                                </Badge>
                              )}
                            </div>
                          </td>
                          <td className="py-2.5 pr-4">
                            <div className="flex items-center gap-1.5">
                              <ExchangeBadge exchange={p.exchange} />
                              <span className="text-xs">{p.symbol}</span>
                            </div>
                          </td>
                          <td className="py-2.5 pr-4 text-right font-mono-nums">{p.tradeCount}</td>
                          <td className="py-2.5 pr-4 text-right font-mono-nums">{p.closedTradeCount}</td>
                          <td className="py-2.5 pr-4 text-right font-mono-nums">
                            {p.winRate.toFixed(1)}%
                          </td>
                          <td className="py-2.5 pr-4 text-right">
                            <PnlValue value={p.totalPnl} suffix="" />
                          </td>
                          <td className="py-2.5 text-right font-mono-nums text-loss">
                            {p.maxDrawdown > 0 ? `-${p.maxDrawdown.toFixed(2)}` : "0.00"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* 建立/編輯 Dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setSnapshotImportSource(null);
        }}
      >
        <DialogContent className={form.strategyKey === V25_STRATEGY_KEY ? "sm:max-w-6xl max-h-[92vh] overflow-y-auto" : "sm:max-w-lg max-h-[90vh] overflow-y-auto"}>
          <DialogHeader>
            <DialogTitle>
              {form.id ? "編輯策略" : snapshotImportSource ? "從快照建立策略" : "新增策略"}
            </DialogTitle>
            <DialogDescription>
              {snapshotImportSource
                ? "原策略引擎及全部回測參數已由快照鎖定；你只需選擇部署帳戶並確認倉位設定。"
                : "設定交易參數與風險控管，建立後將自動產生 Webhook URL。"}
            </DialogDescription>
          </DialogHeader>
          {snapshotImportSource && (
            <div className="rounded-lg border border-cyan-500/35 bg-cyan-500/8 p-3 text-sm">
              <div className="flex items-start gap-2.5">
                <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" />
                <div className="min-w-0 space-y-1">
                  <p className="font-medium text-cyan-100">快照部署契約已啟用</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    來源「{snapshotImportSource.snapshotName}」；系統會由伺服器直接保存完整原始配置，
                    不會套用內建預設或允許改綁其他引擎。
                  </p>
                </div>
              </div>
            </div>
          )}
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 col-span-2">
                <Label>策略名稱</Label>
                <Input
                  placeholder="例如：BTC 突破策略"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>API 金鑰（交易所帳戶）</Label>
                <Select
                  value={form.apiKeyId}
                  onValueChange={(v) => setForm({ ...form, apiKeyId: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="選擇金鑰" />
                  </SelectTrigger>
                  <SelectContent>
                    {(apiKeys ?? []).map((k) => (
                      <SelectItem key={k.id} value={String(k.id)}>
                        {k.label}（{k.exchange.toUpperCase()}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>交易對</Label>
                <SymbolCombobox
                  value={form.symbol}
                  exchange={selectedExchange}
                  testnet={selectedTestnet}
                  onChange={(option) => {
                    // 第二輪優化 3：選擇交易對後，若數量模式且當前倉位低於最小下單量，自動帶入最小量
                    setForm((prev) => {
                      const next = { ...prev, symbol: option.symbol };
                      const cur = parseFloat(String(prev.positionValue));
                      if (
                        prev.positionMode === "quantity" &&
                        option.minOrderQty &&
                        (!Number.isFinite(cur) || cur < option.minOrderQty)
                      ) {
                        next.positionValue = option.minOrderQty;
                      }
                      return next;
                    });
                  }}
                />
              </div>
              {/* ❗ 多策略共用帳戶警告 */}
              {sharedAccountWarning && (
                <div className="col-span-2 flex items-start gap-2 rounded-md border border-yellow-500/50 bg-yellow-500/10 px-3 py-2.5 text-xs text-yellow-200">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-400 mt-0.5" />
                  <div>
                    <p className="font-medium text-yellow-300">多策略共用帳戶警告</p>
                    <p className="mt-0.5">
                      以下策略使用相同的 API Key 和交易對：<span className="font-medium text-yellow-300">{sharedAccountWarning}</span>。
                      建議使用不同子帳戶避免持倉互相干擾。
                    </p>
                  </div>
                </div>
              )}
              <div className="space-y-1.5 col-span-2">
                <Label>倉位大小</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    step={(form.strategyKey === V25_STRATEGY_KEY || form.positionMode === 'usdt') ? '1' : String(selectedSpec?.qtyStep ?? 0.001)}
                    min={(form.strategyKey === V25_STRATEGY_KEY || form.positionMode === 'usdt') ? '1' : String(selectedSpec?.minOrderQty ?? 0.001)}
                    className="flex-1"
                    value={form.positionValue}
                    disabled={Boolean(snapshotImportSource) || form.strategyKey === V25_STRATEGY_KEY}
                    onChange={(e) => setForm({ ...form, positionValue: parseFloat(e.target.value) || 0 })}
                    placeholder={(form.strategyKey === V25_STRATEGY_KEY || form.positionMode === 'usdt') ? '輸入 USDT 金額' : `輸入 ${positionBaseCurrency} 數量`}
                  />
                  <Select
                    value={form.strategyKey === V25_STRATEGY_KEY ? "usdt" : form.positionMode}
                    disabled={Boolean(snapshotImportSource) || form.strategyKey === V25_STRATEGY_KEY}
                    onValueChange={(v) => setForm({ ...form, positionMode: v as 'quantity' | 'usdt' })}
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="quantity">{positionBaseCurrency} 數量</SelectItem>
                      <SelectItem value="usdt">USDT 金額</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {/* 第二輪優化 2：USDT 模式即時換算預覽 */}
                {(form.strategyKey === V25_STRATEGY_KEY || form.positionMode === 'usdt') && (
                  <p className={`text-xs mt-1 ${estimatedBelowMin ? 'text-loss' : 'text-muted-foreground'}`}>
                    {tickerQuery.isLoading
                      ? '⏳ 正在獲取市價...'
                      : tickerQuery.data && estimatedQty !== null
                        ? `≈ ${estimatedQty.toFixed(6).replace(/\.?0+$/, '')} ${positionBaseCurrency}（市價 ${tickerQuery.data.price.toLocaleString()} USDT）${estimatedBelowMin ? ` ⚠️ 低於最小下單量 ${selectedSpec?.minOrderQty} ${positionBaseCurrency}` : ''}`
                        : tickerQuery.isError
                          ? '⚠️ 無法獲取市價，下單時將以實時價格換算'
                          : '💡 系統將根據市價自動換算為合約數量'}
                  </p>
                )}
                {form.positionMode === 'quantity' && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {selectedSpec?.minOrderQty
                      ? `💡 最小下單量 ${selectedSpec.minOrderQty} ${positionBaseCurrency}，步長 ${selectedSpec.qtyStep ?? '—'}`
                      : `💡 輸入 ${positionBaseCurrency} 數量（如 0.001）`}
                  </p>
                )}
                {snapshotImportSource && (
                  <p className="text-xs text-cyan-300/90">
                    倉位單位由快照還原並鎖定，避免把回測 USDT 金額誤作幣種數量。
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>槓桿倍數</Label>
                <Input
                  type="number"
                  min="1"
                  max="125"
                  value={form.leverage}
                  onChange={(e) => setForm({ ...form, leverage: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>交易方向</Label>
                <Select
                  value={form.direction}
                  onValueChange={(v) =>
                    setForm({ ...form, direction: v as StrategyForm["direction"] })
                  }
                >
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
              <div className="space-y-1.5">
                <Label>下單類型</Label>
                <Select
                  value={form.orderType}
                  onValueChange={(v) =>
                    setForm({ ...form, orderType: v as StrategyForm["orderType"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="market">市價單</SelectItem>
                    <SelectItem value="limit">限價單（用訊號價格）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* 快照配置只供檢視；真正建立時由伺服器按 snapshotId 讀取完整原始配置 */}
            {snapshotImportSource ? (
              <div className="space-y-4">
                {snapshotImportSource.strategyKey === V25_STRATEGY_KEY && (
                  <V25ConfigPanel
                    value={snapshotImportSource.config}
                    onChange={() => undefined}
                    disabled
                    context="snapshot"
                  />
                )}
                <div className="space-y-2 rounded-lg border border-border/70 bg-secondary/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">快照參數（唯讀）</p>
                    <p className="text-xs text-muted-foreground">
                      共 {Object.keys(snapshotImportSource.config).length} 個原始參數，包含合法的 0 與 false 值。
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0 border-cyan-500/35 text-cyan-300">
                    完整導入
                  </Badge>
                </div>
                <div className="max-h-56 overflow-y-auto rounded-md border border-border/60 bg-background/45">
                  {Object.entries(snapshotImportSource.config).map(([key, value]) => (
                    <div key={key} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-3 border-b border-border/40 px-3 py-2 last:border-b-0">
                      <span className="break-all font-mono text-[11px] text-muted-foreground">{key}</span>
                      <span className="break-all text-right font-mono text-[11px] text-foreground">
                        {formatSnapshotValue(value)}
                      </span>
                    </div>
                  ))}
                </div>
                </div>
              </div>
            ) : form.strategyKey === V25_STRATEGY_KEY ? (
              <V25ConfigPanel
                value={form.v2_5}
                onChange={(nextConfig) => {
                  const firstRange = nextConfig.Martin_Ranges[0];
                  setForm((prev) => ({
                    ...prev,
                    v2_5: nextConfig,
                    positionValue: nextConfig.Base_Lot_Size,
                    positionMode: "usdt",
                    stopLossPct: String(nextConfig.Hard_Stop_Loss_Pct),
                    takeProfitPct: String(nextConfig.Take_Profit_Pct),
                    martinMultiplier: String(firstRange?.multiplier ?? 1),
                    maxMartinLevel: String(Math.max(1, deriveV25MaxMartinLayer(nextConfig.Martin_Ranges))),
                    martinSpacingPct: String(firstRange?.gap ?? 0),
                    kLinePeriod: String(nextConfig.K_Line_Period),
                    reentryOnTrend: nextConfig.Reentry_On_Trend,
                  }));
                }}
                context="strategy"
              />
            ) : form.strategyKey === "KAMA_3K_TORNADO_V70" ? (
              <V70ConfigPanel
                config={deserializeV70Config(form.v7_0)}
                onChange={(newCfg) => {
                  setForm((prev) => ({ ...prev, v7_0: serializeV70Config(newCfg) }));
                }}
                mode="editable"
              />
            ) : form.strategyKey === "strategy_20415" ? (
              <DynamicForm
                schema={STRATEGIES_V20_SCHEMA}
                values={{
                  ema_killer: form.v2_0?.ema_killer ?? 3,
                  ema_wave: form.v2_0?.ema_wave ?? 6,
                  ema_enter: form.v2_0?.ema_enter ?? 15,
                  K_Line_Period: form.v2_0?.K_Line_Period ?? 30,
                  buffer_points: form.v2_0?.buffer_points ?? 8000,
                  Point_Value: form.v2_0?.Point_Value ?? 0.01,
                  slope_threshold: form.v2_0?.slope_threshold ?? 3.0,
                  Base_Lot_Size: parseFloat(form.positionSize) || 0.01,
                  Initial_Capital: form.v2_0?.Initial_Capital ?? 10000,
                  multiplier: form.v2_0?.multiplier ?? 1.5,
                  max_layers: form.v2_0?.max_layers ?? 12,
                  pip_step_base: form.v2_0?.pip_step_base ?? 500,
                  enable_dynamic_pip: form.v2_0?.enable_dynamic_pip ?? true,
                  atr_period: form.v2_0?.atr_period ?? 14,
                  pipstep_atr_multiplier: form.v2_0?.pipstep_atr_multiplier ?? 0.15,
                  pipstep_min: form.v2_0?.pipstep_min ?? 200,
                  pipstep_max: form.v2_0?.pipstep_max ?? 800,
                  tp_normal: form.v2_0?.tp_normal ?? 150,
                  tp_trend: form.v2_0?.tp_trend ?? 250,
                  trail_normal: form.v2_0?.trail_normal ?? 25,
                  trail_trend: form.v2_0?.trail_trend ?? 30,
                  trend_threshold: form.v2_0?.trend_threshold ?? 50,
                  hard_stop_max: form.v2_0?.hard_stop_max ?? -1200,
                  hard_stop_atr_multiplier: form.v2_0?.hard_stop_atr_multiplier ?? 0.6,
                }}
                onChange={(vals) => {
                  setForm((prev) => ({
                    ...prev,
                    positionSize: vals.Base_Lot_Size != null ? String(vals.Base_Lot_Size) : prev.positionSize,
                    v2_0: {
                      ema_killer: vals.ema_killer ?? prev.v2_0?.ema_killer ?? 3,
                      ema_wave: vals.ema_wave ?? prev.v2_0?.ema_wave ?? 6,
                      ema_enter: vals.ema_enter ?? prev.v2_0?.ema_enter ?? 15,
                      K_Line_Period: vals.K_Line_Period ?? prev.v2_0?.K_Line_Period ?? 30,
                      buffer_points: vals.buffer_points ?? prev.v2_0?.buffer_points ?? 8000,
                      Point_Value: vals.Point_Value ?? prev.v2_0?.Point_Value ?? 0.01,
                      slope_threshold: vals.slope_threshold ?? prev.v2_0?.slope_threshold ?? 3.0,
                      Initial_Capital: vals.Initial_Capital ?? prev.v2_0?.Initial_Capital ?? 10000,
                      multiplier: vals.multiplier ?? prev.v2_0?.multiplier ?? 1.5,
                      max_layers: vals.max_layers ?? prev.v2_0?.max_layers ?? 12,
                      pip_step_base: vals.pip_step_base ?? prev.v2_0?.pip_step_base ?? 500,
                      enable_dynamic_pip: vals.enable_dynamic_pip ?? prev.v2_0?.enable_dynamic_pip ?? true,
                      atr_period: vals.atr_period ?? prev.v2_0?.atr_period ?? 14,
                      pipstep_atr_multiplier: vals.pipstep_atr_multiplier ?? prev.v2_0?.pipstep_atr_multiplier ?? 0.15,
                      pipstep_min: vals.pipstep_min ?? prev.v2_0?.pipstep_min ?? 200,
                      pipstep_max: vals.pipstep_max ?? prev.v2_0?.pipstep_max ?? 800,
                      tp_normal: vals.tp_normal ?? prev.v2_0?.tp_normal ?? 150,
                      tp_trend: vals.tp_trend ?? prev.v2_0?.tp_trend ?? 250,
                      trail_normal: vals.trail_normal ?? prev.v2_0?.trail_normal ?? 25,
                      trail_trend: vals.trail_trend ?? prev.v2_0?.trail_trend ?? 30,
                      trend_threshold: vals.trend_threshold ?? prev.v2_0?.trend_threshold ?? 50,
                      hard_stop_max: vals.hard_stop_max ?? prev.v2_0?.hard_stop_max ?? -1200,
                      hard_stop_atr_multiplier: vals.hard_stop_atr_multiplier ?? prev.v2_0?.hard_stop_atr_multiplier ?? 0.6,
                    },
                  }));
                }}
                showPreview={false}
              />
            ) : (
              <DynamicForm
                schema={STRATEGIES_DYNAMIC_SCHEMA}
                values={{
                  Initial_Capital: parseFloat(form.Initial_Capital) || 10000,
                  First_Order_Pct: parseFloat(form.First_Order_Pct) || 0.3,
                  Max_Loss_Pct: parseFloat(form.Max_Loss_Pct) || 5,
                  martin_mode: form.martin_mode,
                  Martin_Step_Pct: parseFloat(form.martinSpacingPct) || 2.0,
                  Martin_Multiplier: parseFloat(form.martinMultiplier) || 1.5,
                  Max_Layers: parseInt(form.maxMartinLevel) || 11,
                  martinLayersJson: form.martinLayersJson,
                  Target_TP_Pct: parseFloat(form.takeProfitPct) || 1.0,
                  Callback_Pct: parseFloat(form.callbackPct) || 0.1,
                  K_Line_Period: parseFloat(form.kLinePeriod) || 30,
                  Reentry_On_Trend: form.reentryOnTrend,
                  Max_Loss_USDT: parseFloat(form.maxLossUsdt) || 0,
                  max_single_position_pct: parseFloat(form.maxPositionPct) || 0,
                  stop_loss_pct: parseFloat(form.stopLossPct) || 0,
                  daily_loss_limit: parseFloat(form.maxDailyLoss) || 0,
                }}
                onChange={(vals) => {
                  setForm((prev) => ({
                    ...prev,
                    Initial_Capital: String(vals.Initial_Capital ?? prev.Initial_Capital),
                    First_Order_Pct: String(vals.First_Order_Pct ?? prev.First_Order_Pct),
                    Max_Loss_Pct: String(vals.Max_Loss_Pct ?? prev.Max_Loss_Pct),
                    martin_mode: vals.martin_mode ?? prev.martin_mode,
                    martinSpacingPct: String(vals.Martin_Step_Pct ?? prev.martinSpacingPct),
                    martinMultiplier: String(vals.Martin_Multiplier ?? prev.martinMultiplier),
                    maxMartinLevel: String(vals.Max_Layers ?? prev.maxMartinLevel),
                    martinLayersJson: vals.martinLayersJson ?? prev.martinLayersJson,
                    takeProfitPct: String(vals.Target_TP_Pct ?? prev.takeProfitPct),
                    callbackPct: String(vals.Callback_Pct ?? prev.callbackPct),
                    kLinePeriod: String(vals.K_Line_Period ?? prev.kLinePeriod),
                    reentryOnTrend: vals.Reentry_On_Trend ?? prev.reentryOnTrend,
                    maxLossUsdt: String(vals.Max_Loss_USDT ?? prev.maxLossUsdt),
                    maxPositionPct: String(vals.max_single_position_pct ?? prev.maxPositionPct),
                    stopLossPct: String(vals.stop_loss_pct ?? prev.stopLossPct),
                    maxDailyLoss: String(vals.daily_loss_limit ?? prev.maxDailyLoss),
                  }));
                }}
                showPreview={true}
                martinLayersEditor={
                  form.martin_mode === "layered" ? (
                    <MartinLayersEditor
                      value={form.martinLayersJson}
                      onChange={(jsonStr) => setForm((prev) => ({ ...prev, martinLayersJson: jsonStr }))}
                    />
                  ) : undefined
                }
              />
            )}

            {/* 策略引擎綁定 */}
            {snapshotImportSource ? (
              <div className="space-y-1.5">
                <Label>策略引擎（由快照鎖定）</Label>
                <div className="flex items-center gap-2 rounded-md border border-cyan-500/35 bg-cyan-500/5 px-3 py-2.5">
                  <LockKeyhole className="h-4 w-4 shrink-0 text-cyan-400" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{snapshotImportSource.strategyName}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{snapshotImportSource.strategyKey}</p>
                  </div>
                  <Badge className="ml-auto shrink-0 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/15">不可更換</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  此身份由伺服器再次驗證；若原引擎未註冊，系統會停止建立，絕不回退至其他內建策略。
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>策略引擎（選用後由策略代碼決定開平倉與倉位）</Label>
                <Select
                  value={form.strategyKey}
                  onValueChange={(v) => {
                    setForm((prev) => {
                      if (v !== V25_STRATEGY_KEY) return { ...prev, strategyKey: v };
                      const nextConfig = prev.v2_5 ?? createV25DefaultConfig();
                      const firstRange = nextConfig.Martin_Ranges[0];
                      return {
                        ...prev,
                        strategyKey: v,
                        v2_5: nextConfig,
                        positionValue: nextConfig.Base_Lot_Size,
                        positionMode: "usdt",
                        stopLossPct: String(nextConfig.Hard_Stop_Loss_Pct),
                        takeProfitPct: String(nextConfig.Take_Profit_Pct),
                        martinMultiplier: String(firstRange?.multiplier ?? 1),
                        maxMartinLevel: String(Math.max(1, deriveV25MaxMartinLayer(nextConfig.Martin_Ranges))),
                        martinSpacingPct: String(firstRange?.gap ?? 0),
                        kLinePeriod: String(nextConfig.K_Line_Period),
                        reentryOnTrend: nextConfig.Reentry_On_Trend,
                      };
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不使用（訊號直接執行）</SelectItem>
                    {(definitions ?? []).map((d) => (
                      <SelectItem key={d.key} value={d.key}>
                        {d.name}{d.isBuiltIn ? "（內建）" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  可至「策略工作室」貼上或上傳自訂策略代碼。
                </p>
              </div>
            )}

            {/* V3.5 專用：分組參數說明 + 馬丁倉位預覽表 */}
            {!snapshotImportSource && form.strategyKey === "20415_KAMA_MARTIN_V35" && (
                  <V35ConfigPanel
                    initialCapital={parseFloat(form.Initial_Capital) || 100}
                    firstOrderPct={parseFloat(form.First_Order_Pct) || 0.5}
                    maxLossPct={parseFloat(form.Max_Loss_Pct) || 6}
                    martinLayers={parseLayersValue(form.martinLayersJson)}
                    maxLayers={parseInt(form.maxMartinLevel) || 1}
                    stepPct={parseFloat(form.martinSpacingPct) || 1.5}
                  />
            )}

            {/* V5.0 專用：分組參數說明 + 馬丁倉位預覽表 */}
            {!snapshotImportSource && form.strategyKey === "KAMA_3K_ULTIMATE_V50" && (
                  <V50ConfigPanel
                    initialCapital={parseFloat(form.Initial_Capital) || 10000}
                    firstOrderPct={parseFloat(form.First_Order_Pct) || 0.3}
                    maxLossPct={parseFloat(form.Max_Loss_Pct) || 6}
                    martinLayers={parseLayersValue(form.martinLayersJson)}
                    maxLayers={parseInt(form.maxMartinLevel) || 13}
                    stepPct={parseFloat(form.martinSpacingPct) || 2.0}
                  />
            )}

            {/* V6.1 專用：高頻掃射參數說明 + 馬丁倉位預覽表 */}
            {!snapshotImportSource && form.strategyKey === "KAMA_3K_HF_V61" && (
                  <V61ConfigPanel
                    initialCapital={parseFloat(form.Initial_Capital) || 500}
                    baseLotSize={parseFloat(String(form.positionValue)) || 15}
                    maxDrawdownPct={parseFloat(form.Max_Loss_Pct) || 15}
                    martinLayers={parseLayersValue(form.martinLayersJson)}
                    maxLayers={(() => {
                      // 統一從分層表格計算 maxLayers（與 V4.0 架構一致）
                      const layers = parseLayersValue(form.martinLayersJson);
                      if (layers.length > 0) {
                        const sorted = [...layers].sort((a, b) => a.start - b.start);
                        return sorted[sorted.length - 1].end;
                      }
                      return parseInt(form.maxMartinLevel) || 13;
                    })()}
                    stepPct={parseFloat(form.martinSpacingPct) || 2.0}
                  />
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
                setSnapshotImportSource(null);
              }}
            >
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {form.id ? "儲存變更" : "建立策略"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* T3：建立成功引導彈窗 */}
      <Dialog open={!!successInfo} onOpenChange={(open) => !open && setSuccessInfo(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              策略建立成功
            </DialogTitle>
            <DialogDescription>
              「{successInfo?.name}」（{successInfo?.exchange.toUpperCase()} · {successInfo?.symbol}）已建立並啟用，請依下列步驟完成 TradingView 串接。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border bg-secondary/30 p-3 space-y-2">
              <p className="text-xs text-muted-foreground font-medium">
                步驟 1：複製專屬 Webhook URL
              </p>
              <p className="text-xs font-mono break-all bg-background/60 border rounded p-2">
                {successInfo?.webhookUrl ?? "請至策略卡片取得 Webhook URL"}
              </p>
              {successInfo?.webhookUrl && (
                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => copyText(successInfo.webhookUrl!, "Webhook URL ")}
                >
                  <Copy className="h-3.5 w-3.5 mr-1" />
                  複製 Webhook URL
                </Button>
              )}
            </div>
            <div className="rounded-lg border p-3 space-y-1.5 text-sm">
              <p className="text-xs text-muted-foreground font-medium">
                步驟 2：在 TradingView 建立警示（Alert）
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                開啟圖表 → 建立 Alert → 「通知」分頁勾選 Webhook URL 並貼上上方網址 → 訊息欄貼上訊號範本（action 可為 buy / sell / close）。
              </p>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() =>
                  copyText(
                    JSON.stringify({
                      action: "buy",
                      symbol: "{{ticker}}",
                      price: "{{close}}",
                    }).replace('"{{close}}"', "{{close}}"),
                    "Alert 訊息範本",
                  )
                }
              >
                <Copy className="h-3.5 w-3.5 mr-1" />
                複製 Alert 訊息範本
              </Button>
            </div>
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
              <p className="text-xs text-emerald-400 leading-relaxed">
                步驟 3：完成後，TradingView 觸發警示時即自動下單。可至「訊號日誌」頁面即時確認每筆訊號的接收與執行狀態。
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSuccessInfo(null)}>
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 從快照導入對話框 */}
      <Dialog open={showSnapshotImport} onOpenChange={setShowSnapshotImport}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>從快照導入參數到新策略</DialogTitle>
            <DialogDescription>
              選擇快照後，系統會鎖定原策略引擎並由伺服器完整導入原始參數；你無須再次選擇策略。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            {snapshotsQuery.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !snapshotsQuery.data || snapshotsQuery.data.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                尚無快照。請先在回測報告中「儲存快照」。
              </div>
            ) : (
              snapshotsQuery.data.map((snap: any) => (
                <div
                  key={snap.id}
                  className="rounded-lg border border-border/60 p-3 hover:border-cyan-500/50 hover:bg-cyan-500/5 cursor-pointer transition-colors"
                  onClick={() => {
                    const strategyKey = typeof snap.strategyKey === "string" ? snap.strategyKey.trim() : "";
                    if (!strategyKey) {
                      toast.error("此快照缺少策略引擎身份，為避免套用錯誤策略，無法建立");
                      return;
                    }

                    const cfg = (snap.config && typeof snap.config === "object"
                      ? snap.config
                      : {}) as Record<string, unknown>;
                    const bs = (snap.backtestSettings && typeof snap.backtestSettings === "object"
                      ? snap.backtestSettings
                      : {}) as {
                      exchange?: string;
                      symbol?: string;
                      timeframe?: string;
                      initialCapital?: number;
                      tradeAmount?: number;
                      baseLotSizeMode?: "quantity" | "usdt";
                    };
                    const martinLayersJson = typeof cfg.Martin_Layers === 'string' ? cfg.Martin_Layers : cfg.Martin_Layers ? JSON.stringify(cfg.Martin_Layers) : '';
                    const importSymbol = String(bs.symbol ?? cfg.symbol ?? cfg.Symbol ?? "BTCUSDT");
                    const importCapital = finiteSnapshotNumber(bs.initialCapital ?? cfg.Initial_Capital ?? cfg.initial_capital, 100);
                    const positionMode: "quantity" | "usdt" = bs.baseLotSizeMode === "quantity" ? "quantity" : "usdt";
                    const configuredLot = positionMode === "quantity"
                      ? cfg.Base_Lot_Size ?? cfg.base_lot_size
                      : cfg.base_lot_size_usdt ?? cfg.Base_Lot_Size_USDT;
                    const percentageLot = importCapital * finiteSnapshotNumber(cfg.First_Order_Pct, 0.5) / 100;
                    const importTradeAmount = finiteSnapshotNumber(
                      bs.tradeAmount ?? configuredLot ?? (positionMode === "usdt" ? percentageLot : undefined),
                      positionMode === "usdt" ? Math.max(1, percentageLot) : 0.01,
                    );
                    const importedDirection = cfg.Direction === "long" || cfg.Direction === "short" || cfg.Direction === "both"
                      ? cfg.Direction
                      : "both";
                    const importedOrderType = cfg.Order_Type === "limit" || cfg.orderType === "limit" ? "limit" : "market";

                    setSnapshotImportSource({
                      id: snap.id,
                      snapshotName: snap.snapshotName || `快照 #${snap.id}`,
                      strategyKey,
                      strategyName: snap.strategyName || strategyKey,
                      config: cfg,
                    });
                    setForm({
                      ...emptyForm,
                      name: `${snap.strategyName || strategyKey} - 導入`,
                      apiKeyId: apiKeys?.[0] ? String(apiKeys[0].id) : "",
                      symbol: importSymbol.replace(/-/g, '').toUpperCase(),
                      positionSize: String(importTradeAmount),
                      positionValue: importTradeAmount,
                      positionMode,
                      leverage: String(finiteSnapshotNumber(cfg.Leverage ?? cfg.leverage, 1)),
                      direction: importedDirection,
                      orderType: importedOrderType,
                      strategyKey,
                      martinMultiplier: String(cfg.Martin_Multiplier ?? cfg.martin_multiplier ?? 1.5),
                      maxMartinLevel: String(cfg.Max_Layers ?? cfg.max_layers ?? 11),
                      martinSpacingPct: String(cfg.Martin_Step_Pct ?? cfg.martin_step_pct ?? 2),
                      martinLayersJson,
                      maxLossPct: String(cfg.Max_Loss_Pct ?? cfg.max_drawdown_pct ?? 6),
                      callbackPct: String(cfg.Callback_Pct ?? cfg.trailing_callback_pct ?? 0.1),
                      kLinePeriod: String(cfg.K_Line_Period ?? cfg.timeframe ?? 15),
                      reentryOnTrend: cfg.Reentry_On_Trend !== false,
                      maxLossUsdt: String(cfg.Max_Loss_USDT ?? cfg.EscapeLossUSD ?? 15),
                      Initial_Capital: String(importCapital),
                      First_Order_Pct: String(cfg.First_Order_Pct ?? 0.5),
                      Max_Loss_Pct: String(cfg.Max_Loss_Pct ?? cfg.max_drawdown_pct ?? 6),
                      martin_mode: martinLayersJson.trim() ? 'layered' : 'fixed',
                      v6_1: strategyKey === "KAMA_3K_HF_V61" ? cfg : undefined,
                      v7_0: strategyKey === "KAMA_3K_TORNADO_V70" ? cfg : undefined,
                    });
                    setShowSnapshotImport(false);
                    setDialogOpen(true);
                    toast.success(`已載入「${snap.snapshotName}」；原引擎與完整參數已鎖定，請選擇 API 金鑰後建立`);
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{snap.snapshotName}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {snap.strategyName} · {new Date(snap.createdAt).toLocaleString('zh-TW', { hour12: false })}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-mono ${snap.totalReturn >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        {snap.totalReturn >= 0 ? '+' : ''}{snap.totalReturn.toFixed(2)}%
                      </p>
                      <p className="text-xs text-muted-foreground">
                        勝率 {(snap.winRate * 100).toFixed(1)}%
                      </p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSnapshotImport(false)}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * 自動交易模式區塊：在策略卡片中顯示交易模式切換和 Heartbeat 狀態
 */
const K_LINE_PERIODS = [
  { value: 15, label: "15 分鐘" },
  { value: 30, label: "30 分鐘" },
  { value: 60, label: "1 小時" },
  { value: 240, label: "4 小時" },
  { value: 1440, label: "1 天" },
];

function SyncExchangeButton({ strategyId }: { strategyId: number }) {
  const utils = trpc.useUtils();
  const syncMutation = trpc.strategies.syncWithExchange.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        toast.success(result.message);
        utils.strategies.list.invalidate();
      } else {
        toast.error(result.message);
      }
    },
    onError: (err) => toast.error(`同步失敗: ${err.message}`),
  });

  return (
    <div className="flex justify-end mt-1.5">
      <button
        className="text-[10px] px-2 py-0.5 rounded border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-50"
        disabled={syncMutation.isPending}
        onClick={(e) => {
          e.stopPropagation();
          syncMutation.mutate({ strategyId });
        }}
      >
        {syncMutation.isPending ? '同步中...' : '↔ 同步交易所'}
      </button>
    </div>
  );
}

function AutoTradeModeSection({ strategy }: { strategy: any }) {
  const utils = trpc.useUtils();
  const tradeMode: "webhook" | "auto" = strategy.tradeMode || "webhook";
  const kLinePeriod: number = strategy.kLinePeriod || 15;

  // Heartbeat status query
  const { data: heartbeatData } = trpc.autoTrade.getHeartbeatStatus.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const strategyStatus = heartbeatData?.statuses?.find(
    (s: any) => s.strategyId === strategy.id
  );

  // Mutations
  const createHeartbeat = trpc.autoTrade.createHeartbeatTask.useMutation({
    onSuccess: (data) => {
      toast.success("自動交易模式已啟用");
      utils.strategies.list.invalidate();
      utils.autoTrade.getHeartbeatStatus.invalidate();
    },
    onError: (err) => toast.error(`啟用失敗: ${err.message}`),
  });

  const deleteHeartbeat = trpc.autoTrade.deleteHeartbeatTask.useMutation({
    onSuccess: () => {
      toast.success("已切換回 Webhook 模式");
      utils.strategies.list.invalidate();
      utils.autoTrade.getHeartbeatStatus.invalidate();
    },
    onError: (err) => toast.error(`切換失敗: ${err.message}`),
  });

  const triggerTask = trpc.autoTrade.triggerHeartbeatTask.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        const exec = (data as any).execution;
        if (exec?.status === 'executed') {
          toast.success(`✅ 已執行: ${data.signal?.action?.toUpperCase()} @ ${data.signal?.price || 'market'}${exec.orderId ? ` | 訂單 ${exec.orderId}` : ''}`);
        } else if (exec?.status === 'skipped') {
          toast.warning(`⚠️ 已跳過: ${exec.message || '策略條件未滿足'}`);
        } else if (exec?.status === 'failed') {
          toast.error(`❌ 執行失敗: ${exec.message || '未知錯誤'}`);
        } else {
          toast.success(`信號生成: ${data.signal?.action || "HOLD"}`);
        }
      } else {
        // 顯示具體的 HOLD 原因
        const holdType = (data as any).holdType;
        if (holdType === 'disabled') {
          toast.warning(`⛔ 策略已停用，跳過執行`);
        } else if (holdType === 'no_data' || holdType === 'no_engine') {
          toast.warning(`⚠️ ${data.message || '無法獲取數據'}`);
        } else if (holdType === 'validation_failed') {
          toast.info(`🔍 ${data.message || '驗證未通過'}`);
        } else if (holdType === 'kama_insufficient' || holdType === 'kama_no_direction') {
          toast.info(`📊 ${data.message || 'KAMA 方向不明確'}`);
        } else {
          toast.info(`⏸️ ${data.message || '無交易信號 (HOLD)'}`);
        }
      }
      utils.autoTrade.getHeartbeatStatus.invalidate();
      utils.autoTrade.listHeartbeatLogs.invalidate();
      utils.signals.list.invalidate();
    },
    onError: (err) => toast.error(`觸發失敗: ${err.message}`),
  });

  const [selectedPeriod, setSelectedPeriod] = useState(kLinePeriod);

  const handleSwitchMode = (toAuto: boolean) => {
    if (toAuto) {
      createHeartbeat.mutate({
        strategyId: strategy.id,
        kLinePeriod: selectedPeriod,
      });
    } else {
      if (confirm("確定切換回 Webhook 模式？\n將停止自動交易並刪除 Heartbeat 任務。")) {
        deleteHeartbeat.mutate({ strategyId: strategy.id });
      }
    }
  };

  return (
    <div className="rounded-lg border border-border/60 p-2.5 space-y-2">
      {/* 模式切換列 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">交易模式</span>
          {tradeMode === "webhook" ? (
            <Badge variant="outline" className="text-[10px] border-blue-500/30 text-blue-400">
              <Radio className="h-2.5 w-2.5 mr-0.5" />
              Webhook
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">
              <Zap className="h-2.5 w-2.5 mr-0.5" />
              自動
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {tradeMode === "webhook" ? (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px] border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
              disabled={createHeartbeat.isPending || !strategy.strategyKey}
              title={!strategy.strategyKey ? "需要綁定策略引擎才能啟用自動模式" : "切換到自動交易模式"}
              onClick={() => handleSwitchMode(true)}
            >
              {createHeartbeat.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-0.5" />
              ) : (
                <Zap className="h-3 w-3 mr-0.5" />
              )}
              啟用自動
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px]"
              disabled={deleteHeartbeat.isPending}
              onClick={() => handleSwitchMode(false)}
            >
              {deleteHeartbeat.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-0.5" />
              ) : (
                <Radio className="h-3 w-3 mr-0.5" />
              )}
              切回 Webhook
            </Button>
          )}
        </div>
      </div>

      {/* 自動模式詳情 */}
      {tradeMode === "auto" && (
        <div className="space-y-1.5 pt-1 border-t border-border/40">
          <div className="grid grid-cols-4 gap-2 text-xs">
            <div>
              <p className="text-muted-foreground">分析週期</p>
              <p className="font-medium">
                {K_LINE_PERIODS.find((p) => p.value === kLinePeriod)?.label || `${kLinePeriod}分`}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">輪詢頻率</p>
              <p className="font-medium text-amber-400">每 1 分鐘</p>
            </div>
            <div>
              <p className="text-muted-foreground">上次檢測</p>
              <p className="font-medium">
                {strategyStatus?.lastSignalTime
                  ? new Date(strategyStatus.lastSignalTime).toLocaleString("zh-TW", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "尚未執行"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">狀態</p>
              <p className={`font-medium ${strategy.enabled ? "text-emerald-400" : "text-zinc-400"}`}>
                {strategy.enabled ? "運行中" : "已暫停"}
              </p>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground/70">
            每分鐘檢測一次策略條件，條件達成即觸發信號（最大延遲 ≤ 1 分鐘）
          </p>
          {/* 手動觸發按鈕 */}
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-[11px]"
            disabled={triggerTask.isPending || !strategy.enabled}
            onClick={() => triggerTask.mutate({ strategyId: strategy.id, symbol: strategy.symbol })}
          >
            {triggerTask.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <FlaskConical className="h-3 w-3 mr-1" />
            )}
            手動觸發信號生成
          </Button>
          {/* Heartbeat 輪詢日誌面板 */}
          <HeartbeatLogsPanel strategyId={strategy.id} />
        </div>
      )}

      {/* Webhook 模式下的分析週期選擇器（用於切換到自動模式時使用） */}
      {tradeMode === "webhook" && strategy.strategyKey && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground shrink-0">分析 K 線週期：</span>
          <select
            className="bg-secondary border border-border/60 rounded px-1.5 py-0.5 text-xs"
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(Number(e.target.value))}
          >
            {K_LINE_PERIODS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <span className="text-muted-foreground/60 text-[10px]">(每分鐘輪詢)</span>
        </div>
      )}
    </div>
  );
}

/**
 * V3.5 專用配置面板：分組參數說明 + 馬丁倉位預覽表
 * 依據 Pasted_content_17.txt 的動態表單要求實作
 */
function V35ConfigPanel({
  initialCapital,
  firstOrderPct,
  maxLossPct,
  martinLayers,
  maxLayers: propMaxLayers,
  stepPct,
}: {
  initialCapital: number;
  firstOrderPct: number;
  maxLossPct: number;
  martinLayers: { start: number; end: number; multiplier: number; }[];
  maxLayers: number;
  stepPct: number;
}) {
  const [refPrice, setRefPrice] = useState("50000");
  const entryPrice = parseFloat(refPrice) || 50000;

  const { data: previewRows, isLoading: previewLoading } = trpc.studio.previewMartinLayers.useQuery<MartinLayerPreviewRow[]>(
      {
        Initial_Capital: initialCapital,
        First_Order_Pct: firstOrderPct,
        Max_Loss_Pct: maxLossPct,
        Martin_Layers: martinLayers,
        Max_Layers: Math.max(propMaxLayers, 1),
        Martin_Step_Pct: Math.max(stepPct, 0.01),
        Target_TP_Pct: 1.0, // Placeholder, not used in preview
        Callback_Pct: 0.1, // Placeholder, not used in preview
        K_Line_Period: 15, // Placeholder, not used in preview
      },
      { enabled: true }, // Always enable for preview, as placeholders are used
    );

  return (
    <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-3 space-y-3">
      <p className="text-sm font-medium text-cyan-400">
        V3.5 KAMA+3K 馬丁策略 — 參數對照與倉位預覽
      </p>

      {/* 分組參數說明 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground">
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">資金配置</p>
          <p>首單倉位（上方「單筆倉位」）= Base_Lot_Size</p>
          <p>極限止損 = 浮虧 ≥ 初始資本 × 10%（條件 A）</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">馬丁引擎</p>
          <p>倍率（Martin_Multiplier）建議 1.5</p>
          <p>層數上限（Max_Layers）建議 5</p>
          <p>加倉間距（Martin_Step_Pct）建議 1.5%</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">移動止盈</p>
          <p>激活：盈利 ≥ 1.0%（Target_TP_Pct）</p>
          <p>回撤平倉：從最優價回撤 0.2%（Callback_Pct）</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">信號防禦</p>
          <p>KAMA 方向鎖 + 3K 破位驗證（TradingView 端）</p>
          <p>Bar-Lock 同 K 線去重 + 冷卻期（伺服器端）</p>
        </div>
      </div>

      {/* 馬丁倉位預覽表 */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs shrink-0">參考進場價（USDT）</Label>
          <Input
            type="number"
            step="any"
            min="0"
            className="h-8 w-32"
            value={refPrice}
            onChange={(e) => setRefPrice(e.target.value)}
          />
        </div>
        {previewLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 計算中…
          </div>
        ) : previewRows && previewRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <th className="text-left py-1.5 pr-2">層</th>
                  <th className="text-right py-1.5 px-2">觸發價（多）</th>
                  <th className="text-right py-1.5 px-2">本層倉位</th>
                  <th className="text-right py-1.5 px-2">累計倉位</th>
                  <th className="text-right py-1.5 px-2">累計成本</th>
                  <th className="text-right py-1.5 pl-2">均價</th>
                  <th className="text-right py-1.5 pl-2">觸發價（空）</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r) => (
                  <tr key={r.layer} className="border-b border-border/30">
                    <td className="py-1.5 pr-2 font-medium">{r.layer}</td>
                    <td className="text-right py-1.5 px-2 font-mono">
                      {r.triggerPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-1.5 px-2 font-mono">{r.lotSize.toFixed(8)}</td>
                    <td className="text-right py-1.5 px-2 font-mono">{r.cumulativeX.toFixed(2)}</td>
                    <td className="text-right py-1.5 px-2 font-mono">
                      {r.estimatedCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-1.5 pl-2 font-mono">
                      {r.avgPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-1.5 pl-2 font-mono">
                      {r.triggerPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              最大資金需求約{" "}
              <span className="font-mono text-amber-400">
                {previewRows[previewRows.length - 1].estimatedCost.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT
              </span>
              （滿層 {propMaxLayers} 層、不含槓桿與手續費），請確保帳戶保證金充足。
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * V5.0 KAMA+3K 極致優化馬丁策略 — 參數對照與倉位預覽
 */
function V50ConfigPanel({
  initialCapital,
  firstOrderPct,
  maxLossPct,
  martinLayers,
  maxLayers: propMaxLayers,
  stepPct,
}: {
  initialCapital: number;
  firstOrderPct: number;
  maxLossPct: number;
  martinLayers: { start: number; end: number; multiplier: number; }[];
  maxLayers: number;
  stepPct: number;
}) {
  const [refPrice, setRefPrice] = useState("50000");
  const entryPrice = parseFloat(refPrice) || 50000;

  const { data: previewRows, isLoading: previewLoading } = trpc.studio.previewMartinLayers.useQuery<MartinLayerPreviewRow[]>(
      {
        Initial_Capital: initialCapital,
        First_Order_Pct: firstOrderPct,
        Max_Loss_Pct: maxLossPct,
        Martin_Layers: martinLayers,
        Max_Layers: Math.max(propMaxLayers, 1),
        Martin_Step_Pct: Math.max(stepPct, 0.01),
        Target_TP_Pct: 1.0,
        Callback_Pct: 0.1,
        K_Line_Period: 15,
      },
      { enabled: true },
    );

  return (
    <div className="rounded-lg border border-violet-500/25 bg-violet-500/5 p-3 space-y-3">
      <p className="text-sm font-medium text-violet-400">
        V5.0 KAMA+3K 極致優化馬丁 — 參數對照與倉位預覽
      </p>

      {/* 分組參數說明 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs text-muted-foreground">
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">F1 市場制度切換</p>
          <p>ADX 驅動動態馬丁參數</p>
          <p>強趨勢：減層 + 加寬間距</p>
          <p>盤整：加層 + 縮小間距</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">F2 部分獲利</p>
          <p>層數 ≥ 4/6/8 時分批平倉</p>
          <p>降低深層馬丁風險暴露</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">F3 ATR 動態止盈</p>
          <p>TP = MAX(tp_min, ATR/price × mult)</p>
          <p>波動大時自動放寬止盈</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">F4 時間濾網</p>
          <p>僅在活躍時段開新倉</p>
          <p>避免低流動性時段假突破</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">F5 波動率倉位</p>
          <p>首單 = base × (target_vol / ATR%)</p>
          <p>低波動加大、高波動縮小</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">F6 AI 輔助過濾</p>
          <p>KAMA 斜率 + 成交量放大</p>
          <p>過濾弱勢假信號</p>
        </div>
      </div>

      {/* 馬丁倉位預覽表 */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs shrink-0">參考進場價（USDT）</Label>
          <Input
            type="number"
            step="any"
            min="0"
            className="h-8 w-32"
            value={refPrice}
            onChange={(e) => setRefPrice(e.target.value)}
          />
        </div>
        {previewLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 計算中…
          </div>
        ) : previewRows && previewRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <th className="text-left py-1.5 pr-2">層</th>
                  <th className="text-right py-1.5 px-2">觸發價（多）</th>
                  <th className="text-right py-1.5 px-2">本層倉位</th>
                  <th className="text-right py-1.5 px-2">累計倉位</th>
                  <th className="text-right py-1.5 px-2">累計成本</th>
                  <th className="text-right py-1.5 pl-2">均價</th>
                  <th className="text-right py-1.5 pl-2">觸發價（空）</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r) => (
                  <tr key={r.layer} className="border-b border-border/30">
                    <td className="py-1.5 pr-2 font-medium">{r.layer}</td>
                    <td className="text-right py-1.5 px-2 font-mono">
                      {r.triggerPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-1.5 px-2 font-mono">{r.lotSize.toFixed(8)}</td>
                    <td className="text-right py-1.5 px-2 font-mono">{r.cumulativeX.toFixed(2)}</td>
                    <td className="text-right py-1.5 px-2 font-mono">
                      {r.estimatedCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-1.5 pl-2 font-mono">
                      {r.avgPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-1.5 pl-2 font-mono">
                      {r.triggerPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              最大資金需求約{" "}
              <span className="font-mono text-violet-400">
                {previewRows[previewRows.length - 1].estimatedCost.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT
              </span>
              （滿層 {propMaxLayers} 層、不含槓桿與手續費），請確保帳戶保證金充足。
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}


/**
 * V6.1 KAMA 3K 高頻掃射極致版 — 參數對照與倉位預覽
 */
function V61ConfigPanel({
  initialCapital,
  baseLotSize,
  maxDrawdownPct,
  martinLayers,
  maxLayers: propMaxLayers,
  stepPct,
}: {
  initialCapital: number;
  baseLotSize: number;
  maxDrawdownPct: number;
  martinLayers: { start: number; end: number; multiplier: number; }[];
  maxLayers: number;
  stepPct: number;
}) {
  const [refPrice, setRefPrice] = useState("50000");

  const { data: previewRows, isLoading: previewLoading } = trpc.studio.previewMartinLayers.useQuery<MartinLayerPreviewRow[]>(
      {
        Initial_Capital: initialCapital,
        First_Order_Pct: (baseLotSize / initialCapital) * 100,
        Max_Loss_Pct: maxDrawdownPct,
        Martin_Layers: martinLayers,
        Max_Layers: Math.max(propMaxLayers, 1),
        Martin_Step_Pct: Math.max(stepPct, 0.01),
        Target_TP_Pct: 0.4,
        Callback_Pct: 0.15,
        K_Line_Period: 15,
      },
      { enabled: true },
    );

  return (
    <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-3 space-y-3">
      <p className="text-sm font-medium text-cyan-400">
        V6.1 KAMA+3K 高頻掃射極致版 — 參數對照與倉位預覽
      </p>

      {/* 分組參數說明 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs text-muted-foreground">
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">區域觸發模式</p>
          <p>KAMA 雙線區域觸碰開倉</p>
          <p>價格觸及上線區域做空、下線區域做多</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">高頻掃射</p>
          <p>小止盈 + 小止損 + 快速循環</p>
          <p>預設 zone_tp=0.4% / zone_sl=0.6%</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">緊湊馬丁</p>
          <p>預設間距 0.6% / 倍率 1.3×</p>
          <p>高頻小區間快速攝平均價</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">Bar-Lock</p>
          <p>同一根 K 線僅開倉一次</p>
          <p>避免同根 K 線重複觸發</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">冷卻機制</p>
          <p>平倉後等待 N 根 K 線</p>
          <p>避免連續假突破損失</p>
        </div>
        <div className="rounded border border-border/50 p-2 space-y-1">
          <p className="font-medium text-foreground">部分獲利</p>
          <p>層數 ≥ 4/6/8 時分批平倉</p>
          <p>降低深層馬丁風險暴露</p>
        </div>
      </div>

      {/* 馬丁倉位預覽表 */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs shrink-0">參考進場價（USDT）</Label>
          <Input
            type="number"
            step="any"
            min="0"
            className="h-8 w-32"
            value={refPrice}
            onChange={(e) => setRefPrice(e.target.value)}
          />
        </div>
        {previewLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 計算中…
          </div>
        ) : previewRows && previewRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <th className="text-left py-1.5 pr-2">層</th>
                  <th className="text-right py-1.5 px-2">觸發價（多）</th>
                  <th className="text-right py-1.5 px-2">本層倉位</th>
                  <th className="text-right py-1.5 px-2">累計倉位</th>
                  <th className="text-right py-1.5 px-2">累計成本</th>
                  <th className="text-right py-1.5 pl-2">均價</th>
                  <th className="text-right py-1.5 pl-2">觸發價（空）</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r) => (
                  <tr key={r.layer} className="border-b border-border/30">
                    <td className="py-1.5 pr-2 font-medium">{r.layer}</td>
                    <td className="text-right py-1.5 px-2 font-mono">
                      {r.triggerPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-1.5 px-2 font-mono">{r.lotSize.toFixed(8)}</td>
                    <td className="text-right py-1.5 px-2 font-mono">{r.cumulativeX.toFixed(2)}</td>
                    <td className="text-right py-1.5 px-2 font-mono">
                      {r.estimatedCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-1.5 pl-2 font-mono">
                      {r.avgPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-1.5 pl-2 font-mono">
                      {r.triggerPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              最大資金需求約{" "}
              <span className="font-mono text-cyan-400">
                {previewRows[previewRows.length - 1].estimatedCost.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT
              </span>
              （滿層 {propMaxLayers} 層、不含槓桿與手續費），請確保帳戶保證金充足。
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}


/**
 * Heartbeat 輪詢日誌面板
 * 顯示每次 Heartbeat 輪詢的結果（HOLD/信號/下單/失敗/錯誤）
 * 支持翻頁和每頁數量選擇
 */
function HeartbeatLogsPanel({ strategyId }: { strategyId: number }) {
  const [pageSize, setPageSize] = useState(5);
  const [page, setPage] = useState(0);
  const [excludeHold, setExcludeHold] = useState(false);

  const queryInput = useMemo(
    () => ({
      strategyId,
      limit: pageSize,
      offset: page * pageSize,
      excludeHold,
    }),
    [strategyId, pageSize, page, excludeHold],
  );

  const { data, isLoading } = trpc.autoTrade.listHeartbeatLogs.useQuery(queryInput, {
    refetchInterval: 30_000,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  /** 根據 detail 內容判斷 HOLD 子類型 */
  const getHoldSubtype = (detail: string | null | undefined): 'disabled' | 'no_data' | 'strategy_hold' | 'validation_failed' | 'kama' => {
    if (!detail) return 'strategy_hold';
    if (detail.includes('[disabled]')) return 'disabled';
    if (detail.includes('[no_data]') || detail.includes('[no_engine]')) return 'no_data';
    if (detail.includes('[validation_failed]')) return 'validation_failed';
    if (detail.includes('[kama_insufficient]') || detail.includes('[kama_no_direction]')) return 'kama';
    return 'strategy_hold';
  };

  const resultBadge = (result: string, detail?: string | null) => {
    if (result === 'hold') {
      const subtype = getHoldSubtype(detail);
      const holdConfig: Record<string, { label: string; className: string }> = {
        disabled: { label: "已停用", className: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
        no_data: { label: "無數據", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
        validation_failed: { label: "驗證未過", className: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
        kama: { label: "方向不明", className: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30" },
        strategy_hold: { label: "HOLD", className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
      };
      const c = holdConfig[subtype];
      return (
        <Badge variant="outline" className={`text-[9px] px-1 py-0 ${c.className}`}>
          {c.label}
        </Badge>
      );
    }
    const config: Record<string, { label: string; className: string }> = {
      signal: { label: "信號", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
      executed: { label: "已下單", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
      failed: { label: "失敗", className: "bg-red-500/15 text-red-400 border-red-500/30" },
      error: { label: "錯誤", className: "bg-red-500/15 text-red-400 border-red-500/30" },
    };
    const c = config[result] || { label: result, className: "bg-secondary text-secondary-foreground" };
    return (
      <Badge variant="outline" className={`text-[9px] px-1 py-0 ${c.className}`}>
        {c.label}
      </Badge>
    );
  };

  return (
    <div className="mt-2 pt-2 border-t border-border/40">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">輪詢日誌</span>
          <button
            className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
              excludeHold
                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
                : "bg-secondary/50 text-muted-foreground/60 border-border/40 hover:text-muted-foreground"
            }`}
            onClick={() => { setExcludeHold(!excludeHold); setPage(0); }}
            title={excludeHold ? "顯示所有記錄" : "只顯示交易動作（過濾 HOLD）"}
          >
            {excludeHold ? "✓ 只看交易" : "過濾 HOLD"}
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">每頁</span>
          <select
            className="bg-secondary border border-border/60 rounded px-1 py-0 text-[10px] h-5"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(0);
            }}
          >
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={50}>50</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="py-3 flex justify-center">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </div>
      ) : !data || data.items.length === 0 ? (
        <p className="text-[10px] text-muted-foreground/60 text-center py-2">
          尚無輪詢記錄
        </p>
      ) : (
        <>
          <div className="space-y-0.5 max-h-48 overflow-y-auto">
            {(() => {
              // 合併連續相同子類型的 HOLD 記錄為一條顯示
              const merged: any[] = [];
              const items = data.items as any[];
              let i = 0;
              while (i < items.length) {
                const log = items[i];
                if (log.result === 'hold') {
                  // 收集連續相同子類型的 HOLD
                  const currentSubtype = getHoldSubtype(log.detail);
                  const holdGroup: any[] = [log];
                  let j = i + 1;
                  while (j < items.length && items[j].result === 'hold' && getHoldSubtype(items[j].detail) === currentSubtype) {
                    holdGroup.push(items[j]);
                    j++;
                  }
                  if (holdGroup.length > 1) {
                    const firstTime = new Date(holdGroup[0].createdAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                    const lastTime = new Date(holdGroup[holdGroup.length - 1].createdAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                    merged.push({ type: 'hold_group', logs: holdGroup, firstTime, lastTime, count: holdGroup.length, detail: holdGroup[0].detail || '', subtype: currentSubtype });
                  } else {
                    merged.push({ type: 'single', log });
                  }
                  i = j;
                } else {
                  merged.push({ type: 'single', log });
                  i++;
                }
              }
              return (merged as any[]).map((item: any, idx: number) => {
                if (item.type === 'hold_group') {
                  // 簡化顯示的 detail：去掉 [type] 前綴
                  const displayDetail = (item.detail || '').replace(/^\[[^\]]+\]\s*/, '');
                  return (
                    <div
                      key={`hold-group-${idx}`}
                      className="py-1 px-1 rounded hover:bg-secondary/30"
                    >
                      <div className="flex items-center gap-2 text-[10px]">
                        <span className="text-muted-foreground/70 shrink-0">
                          {item.firstTime} ~ {item.lastTime}
                        </span>
                        {resultBadge('hold', item.detail)}
                        <span className="text-muted-foreground/60 text-[10px]">
                          ×{item.count}
                        </span>
                      </div>
                      {displayDetail && (
                        <p className="text-[10px] text-muted-foreground/60 mt-0.5 pl-0.5 leading-relaxed break-words">
                          {displayDetail}
                        </p>
                      )}
                    </div>
                  );
                }
                const log = item.log;
                const logDetail = (log.detail || log.errorMessage || '').replace(/^\[[^\]]+\]\s*/, '');
                return (
                  <div
                    key={log.id}
                    className="py-1 px-1 rounded hover:bg-secondary/30"
                  >
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="text-muted-foreground/70 shrink-0 w-14">
                        {new Date(log.createdAt).toLocaleTimeString("zh-TW", {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                      {resultBadge(log.result, log.detail)}
                      {log.signalAction && (
                        <span className="font-medium text-[10px]">
                          {log.signalAction.toUpperCase()}
                        </span>
                      )}
                      {log.signalPrice && (
                        <span className="font-mono-nums text-[10px] text-muted-foreground">
                          @{Number(log.signalPrice).toFixed(1)}
                        </span>
                      )}
                    </div>
                    {logDetail && (
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5 pl-0.5 leading-relaxed break-words">
                        {logDetail}
                      </p>
                    )}
                  </div>
                );
              });
            })()}
          </div>

          {data.total > pageSize && (
            <div className="flex items-center justify-between mt-1.5 pt-1 border-t border-border/30">
              <span className="text-[9px] text-muted-foreground">
                {page + 1}/{totalPages} 頁（共 {data.total} 筆）
              </span>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
