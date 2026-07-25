import { AlertTriangle, Ban, Loader2, LockKeyhole, ShieldCheck, UnlockKeyhole } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export interface RainbowTrendLadderSafetyControlsProps {
  strategyId: number;
  strategyName: string;
}

function StatusBadge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px]",
        ok
          ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
          : "border-amber-500/35 bg-amber-500/10 text-amber-300",
      )}
    >
      {children}
    </Badge>
  );
}

export function RainbowTrendLadderSafetyControls({
  strategyId,
  strategyName,
}: RainbowTrendLadderSafetyControlsProps) {
  const utils = trpc.useUtils();
  const statusQuery = trpc.autoTrade.rainbowTrendLadderSafetyStatus.useQuery(
    { strategyId },
    { refetchInterval: 10_000, staleTime: 5_000 },
  );
  const refresh = async () => {
    await Promise.all([
      utils.autoTrade.rainbowTrendLadderSafetyStatus.invalidate({ strategyId }),
      utils.strategies.list.invalidate(),
    ]);
  };
  const killMutation = trpc.autoTrade.killRainbowTrendLadder.useMutation({
    onSuccess: async (result) => {
      await refresh();
      if (result.success) {
        toast.success("KILL 已完成：策略、排程與自有持倉均已處理");
      } else {
        toast.warning(`KILL 已鎖定策略；平倉未執行：${result.execution.message}`, { duration: 12_000 });
      }
      if (result.heartbeatWarning) toast.warning(result.heartbeatWarning, { duration: 12_000 });
    },
    onError: (error) => toast.error(`KILL 失敗：${error.message}`, { duration: 12_000 }),
  });
  const releaseMutation = trpc.autoTrade.releaseRainbowTrendLadderKill.useMutation({
    onSuccess: async (result) => {
      await refresh();
      toast.success(result.message);
    },
    onError: (error) => toast.error(`解除 KILL 鎖定失敗：${error.message}`),
  });

  const status = statusQuery.data;
  return (
    <div className="space-y-3 rounded-lg border border-cyan-500/25 bg-[#061019]/80 p-3 shadow-inner shadow-black/20">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {status?.killed ? (
            <LockKeyhole className="h-4 w-4 text-rose-400" />
          ) : (
            <ShieldCheck className="h-4 w-4 text-cyan-300" />
          )}
          <div>
            <p className="text-xs font-semibold text-slate-100">階梯策略安全隔離</p>
            <p className="text-[10px] text-slate-500">獨立狀態、專用帳戶檢查、只平可證明自有持倉</p>
          </div>
        </div>
        {statusQuery.isLoading ? <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> : null}
      </div>

      {statusQuery.isError ? (
        <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/8 p-2 text-[11px] text-rose-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          安全狀態讀取失敗：{statusQuery.error.message}
        </div>
      ) : status ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            <StatusBadge ok={status.configValid}>配置{status.configValid ? "有效" : "無效"}</StatusBadge>
            <StatusBadge ok={status.dedicatedAccountReady}>專用帳戶{status.dedicatedAccountReady ? "就緒" : "衝突"}</StatusBadge>
            <StatusBadge ok={!status.liveTradingArmed}>實盤{status.liveTradingArmed ? "已武裝" : "未武裝"}</StatusBadge>
            <StatusBadge ok={status.environment === "demo"}>{status.environment === "demo" ? "模擬環境" : "正式環境"}</StatusBadge>
            <StatusBadge ok={!status.killed}>{status.killed ? "KILL 已鎖定" : "KILL 未鎖定"}</StatusBadge>
            <StatusBadge ok={!status.hasLocalPosition}>{status.blindMode ? `盲人模式 L${status.currentLayer}` : "等待 M30"}</StatusBadge>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-md border border-slate-800 bg-black/20 p-2 text-[11px]">
            <div>
              <p className="text-slate-500">本地自有持倉</p>
              <p className="font-mono text-slate-200">{status.totalSize} @ {status.avgPrice || "—"}</p>
            </div>
            <div>
              <p className="text-slate-500">最後決策</p>
              <p className="line-clamp-2 text-slate-300">{status.lastDecisionReason}</p>
            </div>
          </div>
          {status.conflictingStrategies.length > 0 ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/8 p-2 text-[11px] text-amber-200">
              同帳戶仍有啟用策略：{status.conflictingStrategies.map((item) => item.name).join("、")}；實盤武裝將被安全拒絕。
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="min-w-32 flex-1"
              disabled={killMutation.isPending || status.killed}
              onClick={() => {
                const literal = window.prompt(`緊急停止「${strategyName}」：請輸入 KILL`);
                if (literal !== "KILL") return toast.error("輸入不符，已取消 KILL");
                if (!window.confirm("二次確認：立即停用策略與排程，並只在所有權可證明時市價平掉本策略持倉？")) return;
                killMutation.mutate({ strategyId, confirmation: "KILL" });
              }}
            >
              {killMutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Ban className="mr-1 h-3.5 w-3.5" />}
              KILL 緊急停止
            </Button>
            {status.killed ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-w-32 flex-1 border-amber-500/35 text-amber-300"
                disabled={releaseMutation.isPending}
                onClick={() => {
                  const literal = window.prompt("解除只移除本地鎖且不會重啟策略；請輸入 RELEASE KILL");
                  if (literal !== "RELEASE KILL") return toast.error("輸入不符，已取消解除");
                  if (!window.confirm("確認只解除 KILL 鎖？策略仍會保持停用。")) return;
                  releaseMutation.mutate({ strategyId, confirmation: "RELEASE KILL" });
                }}
              >
                {releaseMutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <UnlockKeyhole className="mr-1 h-3.5 w-3.5" />}
                解除 KILL 鎖
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
