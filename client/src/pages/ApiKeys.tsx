import DashboardLayout from "@/components/DashboardLayout";
import { ExchangeBadge, formatTime } from "@/components/shared";
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
import { trpc } from "@/lib/trpc";
import {
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function ApiKeysPage() {
  return (
    <DashboardLayout>
      <ApiKeysContent />
    </DashboardLayout>
  );
}

type EditingKey = {
  id?: number;
  label: string;
  exchange: "bybit" | "okx";
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  isTestnet: boolean;
};

const emptyForm: EditingKey = {
  label: "",
  exchange: "bybit",
  apiKey: "",
  apiSecret: "",
  passphrase: "",
  isTestnet: false,
};

function ApiKeysContent() {
  const utils = trpc.useUtils();
  const { data: keys, isLoading } = trpc.apiKeys.list.useQuery();
  const { data: serverIp } = trpc.apiKeys.getServerIP.useQuery(undefined, {
    staleTime: 10 * 60 * 1000,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<EditingKey>(emptyForm);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [formTestResult, setFormTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // 任務 1.4：表單內測試連線（儲存前以原始憑證驗證）
  const testCredentialsMutation = trpc.apiKeys.testCredentials.useMutation({
    onSuccess: (result) => {
      console.log('[testCredentials] Success:', result);
      setFormTestResult(result);
      if (result.success) toast.success(result.message);
      else toast.error(result.message);
    },
    onError: (e: any) => {
      console.error('[testCredentials] Error:', e);
      const msg = e?.message || e?.toString?.() || 'Unknown error';
      setFormTestResult({ success: false, message: msg });
      toast.error(msg);
    },
  });

  const handleFormTest = () => {
    if (!form.apiKey || !form.apiSecret) {
      toast.error("請先輸入 API Key 與 Secret");
      return;
    }
    if (form.exchange === "okx" && !form.passphrase) {
      toast.error("OKX 需要提供 Passphrase");
      return;
    }
    setFormTestResult(null);
    testCredentialsMutation.mutate({
      exchange: form.exchange,
      apiKey: form.apiKey,
      apiSecret: form.apiSecret,
      passphrase: form.passphrase || undefined,
      isTestnet: form.isTestnet,
    });
  };

  const createMutation = trpc.apiKeys.create.useMutation({
    onSuccess: () => {
      toast.success("API 金鑰已新增（已加密儲存）");
      utils.apiKeys.list.invalidate();
      setDialogOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMutation = trpc.apiKeys.update.useMutation({
    onSuccess: () => {
      toast.success("API 金鑰已更新");
      utils.apiKeys.list.invalidate();
      setDialogOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMutation = trpc.apiKeys.delete.useMutation({
    onSuccess: () => {
      toast.success("API 金鑰已刪除");
      utils.apiKeys.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const testMutation = trpc.apiKeys.testConnection.useMutation({
    onSuccess: (result) => {
      if (result.success) toast.success(result.message);
      else toast.error(result.message);
      utils.apiKeys.list.invalidate();
      setTestingId(null);
    },
    onError: (e) => {
      toast.error(e.message);
      setTestingId(null);
    },
  });

  const openCreate = () => {
    setForm(emptyForm);
    setFormTestResult(null);
    setDialogOpen(true);
  };

  const openEdit = (k: NonNullable<typeof keys>[number]) => {
    setForm({
      id: k.id,
      label: k.label,
      exchange: k.exchange as "bybit" | "okx",
      apiKey: "",
      apiSecret: "",
      passphrase: "",
      isTestnet: k.isTestnet,
    });
    setFormTestResult(null);
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!form.label.trim()) {
      toast.error("請輸入名稱");
      return;
    }
    if (form.id) {
      updateMutation.mutate({
        id: form.id,
        label: form.label,
        apiKey: form.apiKey || undefined,
        apiSecret: form.apiSecret || undefined,
        passphrase: form.passphrase || undefined,
        isTestnet: form.isTestnet,
      });
    } else {
      if (!form.apiKey || !form.apiSecret) {
        toast.error("請輸入 API Key 與 Secret");
        return;
      }
      if (form.exchange === "okx" && !form.passphrase) {
        toast.error("OKX 需要提供 Passphrase");
        return;
      }
      createMutation.mutate({
        label: form.label,
        exchange: form.exchange,
        apiKey: form.apiKey,
        apiSecret: form.apiSecret,
        passphrase: form.passphrase || undefined,
        isTestnet: form.isTestnet,
      });
    }
  };

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API 設定</h1>
          <p className="text-sm text-muted-foreground mt-1">
            管理交易所 API 金鑰，所有金鑰皆以 AES-256-GCM 加密儲存
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" />
          新增金鑰
        </Button>
      </div>

      {/* 任務 1.5：伺服器公網 IP，供用戶加入交易所白名單；附 TradingView Webhook IP 提示 */}
      <Card className="border-sky-500/25 bg-sky-500/5">
        <CardContent className="py-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Server className="h-4 w-4 text-sky-400 shrink-0" />
            <span className="text-muted-foreground">伺服器公網 IP：</span>
            {(serverIp?.allIps && serverIp.allIps.length > 0
              ? serverIp.allIps
              : [serverIp?.ip ?? "載入中..."]
            ).map((ip) => (
              <code
                key={ip}
                className="font-mono-nums bg-background/60 border rounded px-2 py-0.5"
              >
                {ip}
              </code>
            ))}
            {serverIp?.ip && serverIp.ip !== "無法取得" && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="複製全部伺服器 IP"
                onClick={() => {
                  const text = (serverIp.allIps?.length ? serverIp.allIps : [serverIp.ip]).join(", ");
                  navigator.clipboard.writeText(text);
                  toast.success("已複製伺服器 IP");
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              請將以上 IP 加入 Bybit / OKX 的 API 白名單，否則請求將被拒絕
            </span>
          </div>
          {serverIp?.tradingViewIPs && serverIp.tradingViewIPs.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground border-t border-sky-500/15 pt-2">
              <span>TradingView Webhook 發送來源 IP（如需防火牆白名單）：</span>
              {serverIp.tradingViewIPs.map((ip) => (
                <code
                  key={ip}
                  className="font-mono-nums bg-background/60 border rounded px-1.5 py-0.5"
                >
                  {ip}
                </code>
              ))}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                title="複製 TradingView IP 列表"
                onClick={() => {
                  navigator.clipboard.writeText(serverIp.tradingViewIPs.join(", "));
                  toast.success("已複製 TradingView IP 列表");
                }}
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {isLoading ? (
        <Card>
          <CardContent className="py-8 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : !keys || keys.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <KeyRound className="h-8 w-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              尚未新增任何 API 金鑰。新增 Bybit 或 OKX 金鑰後即可開始自動交易。
            </p>
            <Button variant="outline" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" />
              新增第一組金鑰
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {keys.map((k) => (
            <Card key={k.id}>
              <CardContent className="pt-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{k.label}</span>
                    <ExchangeBadge exchange={k.exchange} />
                    {k.isTestnet && (
                      <Badge variant="outline" className="text-[10px] border-violet-500/40 text-violet-400">
                        測試網
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEdit(k)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => {
                        if (confirm(`確定刪除金鑰「${k.label}」？`)) {
                          deleteMutation.mutate({ id: k.id });
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="text-sm space-y-1">
                  <p className="font-mono-nums text-muted-foreground">
                    API Key: {k.apiKeyMasked}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {k.lastTestStatus === "success" ? (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" />
                        連線正常
                      </span>
                    ) : k.lastTestStatus === "failed" ? (
                      <span className="flex items-center gap-1 text-rose-400">
                        <XCircle className="h-3 w-3" />
                        連線失敗
                      </span>
                    ) : (
                      <span>尚未測試</span>
                    )}
                    {k.lastTestAt && <span>· {formatTime(k.lastTestAt)}</span>}
                  </div>
                  {k.lastTestMessage && k.lastTestStatus === "failed" && (
                    <p className="text-xs text-rose-400/80">{k.lastTestMessage}</p>
                  )}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={testingId === k.id && testMutation.isPending}
                  onClick={() => {
                    setTestingId(k.id);
                    testMutation.mutate({ id: k.id });
                  }}
                >
                  {testingId === k.id && testMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <PlugZap className="h-3.5 w-3.5 mr-1" />
                  )}
                  測試連線
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? "編輯 API 金鑰" : "新增 API 金鑰"}</DialogTitle>
            <DialogDescription>
              {form.id
                ? "留空 Key/Secret 欄位表示不變更；填寫則覆蓋原值。"
                : "金鑰將以 AES-256-GCM 加密後儲存於資料庫，絕不明文保存。"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>名稱</Label>
              <Input
                placeholder="例如：Bybit 主帳戶"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
            </div>
            {!form.id && (
              <div className="space-y-1.5">
                <Label>交易所</Label>
                <Select
                  value={form.exchange}
                  onValueChange={(v) =>
                    setForm({ ...form, exchange: v as "bybit" | "okx" })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bybit">Bybit</SelectItem>
                    <SelectItem value="okx">OKX</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>API Key</Label>
              <Input
                placeholder={form.id ? "（不變更）" : "輸入 API Key"}
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>API Secret</Label>
              <Input
                type="password"
                placeholder={form.id ? "（不變更）" : "輸入 API Secret"}
                value={form.apiSecret}
                onChange={(e) => setForm({ ...form, apiSecret: e.target.value })}
              />
            </div>
            {form.exchange === "okx" && (
              <div className="space-y-1.5">
                <Label>Passphrase（OKX 必填）</Label>
                <Input
                  type="password"
                  placeholder={form.id ? "（不變更）" : "輸入 Passphrase"}
                  value={form.passphrase}
                  onChange={(e) =>
                    setForm({ ...form, passphrase: e.target.value })
                  }
                />
              </div>
            )}
            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div>
                <Label className="text-sm">測試網模式</Label>
                <p className="text-xs text-muted-foreground">
                  使用交易所測試網／模擬盤環境
                </p>
              </div>
              <Switch
                checked={form.isTestnet}
                onCheckedChange={(v) => setForm({ ...form, isTestnet: v })}
              />
            </div>
            {/* 任務 1.4：測試結果顯示 */}
            {formTestResult && (
              <div
                className={`rounded-lg border px-3 py-2.5 text-sm ${
                  formTestResult.success
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-400"
                }`}
              >
                {formTestResult.success ? "✅ " : "❌ "}
                {formTestResult.message}
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={handleFormTest}
              disabled={testCredentialsMutation.isPending || !form.apiKey || !form.apiSecret}
              className="sm:mr-auto"
            >
              {testCredentialsMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <PlugZap className="h-4 w-4 mr-1" />
              )}
              測試連線
            </Button>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {form.id ? "儲存變更" : "新增"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
