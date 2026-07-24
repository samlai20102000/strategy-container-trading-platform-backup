import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  CheckCircle2,
  Code2,
  Copy,
  FileUp,
  FlaskConical,
  Loader2,
  Lock,
  Pencil,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

export default function StudioPage() {
  return (
    <DashboardLayout>
      <StudioContent />
    </DashboardLayout>
  );
}

const TEMPLATE_CODE = `import {
  BaseStrategy,
  MarketData,
  MartinState,
  StrategyAction,
  StrategyInstanceConfig,
  StrategySignal,
} from "../base";

/**
 * 自訂策略範本：請修改 key / name / defaultConfig 與 generateActions 邏輯
 * 規則：
 * - key 必須全域唯一（英數/底線/連字號，3-100 字元）
 * - 必須實作 generateActions，回傳 OPEN_LONG / OPEN_SHORT / CLOSE_ALL / HOLD
 * - 禁止使用 fs / net / http / child_process / eval 等 API（純計算）
 */
export class MyCustomStrategy extends BaseStrategy {
  readonly key = "my_custom_strategy";
  readonly name = "我的自訂策略";

  readonly defaultConfig = {
    initial_lot: 0.01,
    martin_multiplier: 1.5,
    max_martin_level: 3,
  };

  generateActions(
    signal: StrategySignal,
    instance: StrategyInstanceConfig,
    marketData: MarketData | null,
    martinState: MartinState,
  ): StrategyAction {
    const cfg = this.mergeConfig(instance);
    const lotSize = this.calcMartinLot(
      Number(cfg.initial_lot) || instance.positionSize,
      Number(cfg.martin_multiplier) || 1.5,
      martinState.lossCount,
      Number(cfg.max_martin_level) || 3,
    );

    if (signal.action === "CLOSE") {
      return { action: "CLOSE_ALL", lotSize: 0, reason: "收到 CLOSE 訊號" };
    }
    if (signal.action === "BUY") {
      return { action: "OPEN_LONG", lotSize, reason: "BUY 訊號開多" };
    }
    if (signal.action === "SELL") {
      return { action: "OPEN_SHORT", lotSize, reason: "SELL 訊號開空" };
    }
    return { action: "HOLD", lotSize: 0, reason: "觀望" };
  }
}
`;

function StudioContent() {
  const utils = trpc.useUtils();
  // V4.2: 使用 registry 統一數據源，同時保留 studio.list 作為 fallback
  const { data: registryStrategies, isLoading: registryLoading } = trpc.registry.listDefinitions.useQuery(undefined);
  const { data: studioStrategies, isLoading: studioLoading } = trpc.studio.list.useQuery();
  // 優先使用 registry，若無數據則 fallback 到 studio
  const strategies = (registryStrategies && registryStrategies.length > 0)
    ? registryStrategies
    : studioStrategies;
  const isLoading = registryLoading && studioLoading;
  const [code, setCode] = useState("");
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const registerMutation = trpc.studio.register.useMutation({
    onSuccess: (r) => {
      setLastResult({ success: true, message: r.message });
      toast.success(r.message);
      utils.studio.list.invalidate();
      utils.registry.listDefinitions.invalidate();
    },
    onError: (e) => {
      setLastResult({ success: false, message: e.message });
      toast.error("策略註冊失敗");
    },
  });

  const deleteMutation = trpc.studio.delete.useMutation({
    onSuccess: (r) => {
      toast.success(r.message);
      utils.studio.list.invalidate();
      utils.registry.listDefinitions.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const renameMutation = trpc.registry.renameStrategy.useMutation({
    onSuccess: (r) => {
      toast.success(`策略已重命名為「${r.newName}」（貫通全系統）`);
      utils.studio.list.invalidate();
      utils.registry.listDefinitions.invalidate();
    },
    onError: (e) => toast.error(`重命名失敗：${e.message}`),
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".ts") && !file.name.endsWith(".js")) {
      toast.error("僅支援 .ts 或 .js 檔案");
      return;
    }
    if (file.size > 200 * 1024) {
      toast.error("檔案超過 200KB 上限");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCode(String(reader.result ?? ""));
      setUploadName(file.name);
      toast.success(`已讀取 ${file.name}，請點擊「註冊策略」`);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleRegister = () => {
    if (code.trim().length < 50) {
      toast.error("請先貼上或上傳策略代碼");
      return;
    }
    setLastResult(null);
    registerMutation.mutate({
      code,
      sourceType: uploadName ? "upload" : "paste",
      filename: uploadName ?? undefined,
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">策略工作室</h1>
        <p className="text-sm text-muted-foreground mt-1">
          貼上或上傳 TypeScript 策略代碼，即時編譯並熱重載註冊（免重啟伺服器）
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 左：代碼編輯區 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Code2 className="h-4 w-4" />
                策略代碼
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCode(TEMPLATE_CODE);
                    setUploadName(null);
                    toast.success("已載入範本代碼");
                  }}
                >
                  <Copy className="h-3.5 w-3.5 mr-1" />
                  載入範本
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileUp className="h-3.5 w-3.5 mr-1" />
                  上傳 .ts 檔案
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".ts,.js"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {uploadName && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Upload className="h-3.5 w-3.5" />
                已載入檔案：{uploadName}
              </div>
            )}
            <Textarea
              placeholder={`在此貼上策略代碼（繼承 BaseStrategy 並實作 generateActions）...\n\n點擊「載入範本」查看範例格式`}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (uploadName) setUploadName(null);
              }}
              className="min-h-[420px] font-mono text-xs leading-relaxed"
              spellCheck={false}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {code.length > 0 ? `${(code.length / 1024).toFixed(1)} KB` : ""}
              </span>
              <Button
                onClick={handleRegister}
                disabled={registerMutation.isPending || code.trim().length < 50}
              >
                {registerMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <FlaskConical className="h-4 w-4 mr-1" />
                )}
                {registerMutation.isPending ? "編譯中..." : "註冊策略"}
              </Button>
            </div>

            {lastResult && (
              <div
                className={`rounded-md border px-3 py-2.5 text-xs whitespace-pre-wrap break-all ${
                  lastResult.success
                    ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
                    : "border-red-500/30 bg-red-500/5 text-red-400"
                }`}
              >
                <div className="flex items-start gap-2">
                  {lastResult.success ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  )}
                  <span>{lastResult.message}</span>
                </div>
              </div>
            )}

            <div className="rounded-md border bg-secondary/30 px-3 py-2.5 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">安全限制</p>
              <p>
                策略代碼僅能進行純計算，禁止使用 fs / net / http / child_process /
                eval / process.env 等 API。代碼經 esbuild 編譯與驗證後才會註冊，並持久化至資料庫（伺服器重啟自動重載）。
              </p>
            </div>
          </CardContent>
        </Card>

        {/* 右：已註冊策略列表 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">已註冊策略</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="py-8 flex justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !strategies || strategies.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                尚無已註冊策略
              </p>
            ) : (
              <div className="space-y-3">
                {strategies.map((s) => (
                  <div
                    key={s.key}
                    className="rounded-lg border p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium text-sm truncate">
                          {s.name}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            const newName = prompt(`修改策略名稱（貫通全系統）`, s.name);
                            if (newName && newName.trim() && newName.trim() !== s.name) {
                              renameMutation.mutate({ key: s.key, newName: newName.trim() });
                            }
                          }}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        {s.isBuiltIn ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-amber-500/40 text-amber-400"
                          >
                            <Lock className="h-2.5 w-2.5 mr-0.5" />
                            內建
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            {s.sourceType === "upload" ? "上傳" : "貼上"} v{s.version}
                          </Badge>
                        )}
                        {!s.isBuiltIn && !s.loaded && (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-red-500/40 text-red-400"
                          >
                            未載入
                          </Badge>
                        )}
                      </div>
                      {!s.isBuiltIn && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive shrink-0"
                          disabled={deleteMutation.isPending}
                          onClick={() => {
                            if (confirm(`確定刪除策略「${s.name}」？`)) {
                              deleteMutation.mutate({ key: s.key });
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono">
                      key: {s.key}
                    </p>
                    {s.description && (
                      <p className="text-xs text-muted-foreground">
                        {s.description}
                      </p>
                    )}
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        預設參數
                      </summary>
                      <pre className="mt-1.5 rounded-md bg-secondary/40 border p-2 overflow-x-auto text-[11px]">
                        {JSON.stringify(s.defaultConfig, null, 2)}
                      </pre>
                    </details>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-4">
              註冊後，於「策略管理」建立或編輯策略實例時，可在「策略引擎」欄位綁定此策略。
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
