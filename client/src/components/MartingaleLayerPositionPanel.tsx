import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RouterOutputs } from "@/lib/trpc";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Layers3,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

type LayerSnapshot = RouterOutputs["strategies"]["martingaleLayerSnapshots"][number];
type LayerSummary = RouterOutputs["strategies"]["martingaleLayerSummaries"][number];

type Props = {
  strategyId: number;
  maxLayers: number;
  summary?: LayerSummary;
  snapshot?: LayerSnapshot;
  summaryLoading: boolean;
  detailLoading: boolean;
  detailFetching: boolean;
  refreshing: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
};

const QUALITY_LABEL: Record<LayerSnapshot["quality"], string> = {
  exact: "精確對帳",
  account_aggregate: "帳戶合併",
  mismatch: "數量不一致",
  stale: "資料逾期",
  unavailable: "行情不可用",
};

function qualityTone(quality: LayerSnapshot["quality"] | undefined) {
  if (quality === "exact") return "border-emerald-500/35 bg-emerald-500/5 text-emerald-300";
  if (quality === "account_aggregate" || quality === "stale") return "border-amber-500/35 bg-amber-500/5 text-amber-300";
  if (quality === "mismatch" || quality === "unavailable") return "border-rose-500/35 bg-rose-500/5 text-rose-300";
  return "border-cyan-500/25 bg-cyan-500/[0.04] text-cyan-200";
}

function formatPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 1_000 ? 2 : abs >= 1 ? 4 : 8;
  return value.toLocaleString("zh-TW", { maximumFractionDigits: digits });
}

function formatQuantity(value: number) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-TW", { maximumFractionDigits: 10 });
}

function formatPnl(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(4)} U`;
}

function formatTimestamp(value: number | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-TW", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function LayerQualityBadge({ quality }: { quality: LayerSnapshot["quality"] }) {
  return (
    <Badge variant="outline" className={`h-5 px-1.5 text-[9px] ${qualityTone(quality)}`}>
      {QUALITY_LABEL[quality]}
    </Badge>
  );
}

export function MartingaleLayerPositionPanel({
  strategyId,
  maxLayers,
  summary,
  snapshot,
  summaryLoading,
  detailLoading,
  detailFetching,
  refreshing,
  expanded,
  onToggle,
  onRefresh,
}: Props) {
  if (summaryLoading && !summary) {
    return (
      <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.03] px-3 py-2" data-martingale-layer-loading>
        <div className="flex items-center gap-2 text-xs text-cyan-200/80">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在核對馬丁逐層持倉…
        </div>
      </div>
    );
  }

  // 馬丁策略未開倉時不顯示逐層區；非馬丁策略根本不會 render 此元件。
  if (!summary || summary.availability === "no_open_position") return null;

  if (summary.availability === "awaiting_reconciliation") {
    return (
      <section
        className="rounded-lg border border-amber-500/35 bg-amber-500/[0.05] px-3 py-3 text-amber-100"
        data-martingale-layer-reconciliation
        data-strategy-id={strategyId}
      >
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-foreground">馬丁逐層持倉待對帳</span>
              <Badge variant="outline" className="h-5 border-amber-500/35 px-1.5 text-[9px] text-amber-300">
                暫不顯示逐層數據
              </Badge>
            </div>
            <p className="text-[11px] leading-relaxed text-amber-100/80">
              已偵測到此馬丁策略有現存持倉，但尚未建立可稽核的逐層成交 ledger。
              系統不會推算各層成交價或顯示偽精確盈虧；完成嚴格成交對帳後會自動恢復。
            </p>
            <p className="text-[10px] text-muted-foreground">
              此提示為唯讀資料品質狀態，不會改變策略、持倉或任何下單／平倉行為。
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (summary.activeCycleCount === 0 || summary.openLayerCount === 0) return null;

  const busy = detailLoading || detailFetching || refreshing;

  return (
    <section
      className={`overflow-hidden rounded-lg border ${qualityTone(snapshot?.quality)}`}
      data-martingale-layer-panel
      data-strategy-id={strategyId}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-controls={`martingale-layers-${strategyId}`}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <Layers3 className="h-4 w-4 shrink-0 text-cyan-300" />
          <span className="truncate text-xs font-semibold text-foreground">馬丁逐層持倉</span>
          <Badge variant="outline" className="h-5 shrink-0 border-cyan-500/35 px-1.5 text-[9px] text-cyan-200">
            已開 {summary.openLayerCount}/{Math.max(maxLayers, summary.openLayerCount)} 層
          </Badge>
          {summary.activeCycleCount > 1 && (
            <Badge variant="outline" className="h-5 shrink-0 border-amber-500/35 px-1.5 text-[9px] text-amber-300">
              {summary.activeCycleCount} 個活躍循環
            </Badge>
          )}
        </button>
        {expanded && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title="立即重新同步行情與持倉（同一帳戶共用）"
            aria-label="立即重新同步馬丁逐層持倉"
            disabled={busy}
            onClick={onRefresh}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
          </Button>
        )}
      </div>

      {expanded && (
        <div id={`martingale-layers-${strategyId}`} className="border-t border-current/10 bg-black/10 px-3 py-3">
          {detailLoading && !snapshot ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              讀取逐層成交與一分鐘行情快照…
            </div>
          ) : !snapshot ? (
            <div className="flex items-start gap-2 py-2 text-xs text-rose-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              未能取得逐層資料；已停止顯示估算價格及盈虧，請稍後重試。
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-cyan-300" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">唯讀成交稽核</span>
                  <LayerQualityBadge quality={snapshot.quality} />
                  {snapshot.pnlHidden && (
                    <Badge variant="outline" className="h-5 border-rose-500/35 px-1.5 text-[9px] text-rose-300">
                      已隱藏過期 PnL
                    </Badge>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground">
                  每 60 秒更新 · 同步 {formatTimestamp(snapshot.capturedAt)}
                </span>
              </div>

              {(snapshot.refreshError || snapshot.quality !== "exact") && (
                <div className="flex items-start gap-1.5 rounded border border-current/15 bg-black/10 px-2 py-1.5 text-[10px]">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {snapshot.refreshError ?? "逐層數量與交易所帳戶持倉未達精確一對一；系統已降級顯示並禁止偽精確盈虧。"}
                  </span>
                </div>
              )}

              {snapshot.cycles.map(cycle => (
                <div key={cycle.cycleId} className="overflow-hidden rounded-md border border-white/10 bg-background/35">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-2.5 py-2">
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className={`rounded px-1.5 py-0.5 font-semibold ${cycle.side === "long" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>
                        {cycle.side === "long" ? "LONG" : "SHORT"}
                      </span>
                      <span>{cycle.layers[0]?.symbol ?? "—"}</span>
                      <span>開倉 {formatTimestamp(cycle.layers.length > 0 ? Math.min(...cycle.layers.map(layer => layer.filledAt)) : null)}</span>
                    </div>
                    <span className="font-mono text-[10px] text-muted-foreground">剩餘 {formatQuantity(cycle.totalOpenQuantity)}</span>
                  </div>

                  <div className="hidden overflow-x-auto md:block">
                    <table className="w-full min-w-[680px] text-left text-xs">
                      <thead className="bg-white/[0.025] text-[10px] uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-2.5 py-2 font-medium">層</th>
                          <th className="px-2.5 py-2 font-medium">交易對</th>
                          <th className="px-2.5 py-2 font-medium">方向</th>
                          <th className="px-2.5 py-2 text-right font-medium">剩餘數量</th>
                          <th className="px-2.5 py-2 text-right font-medium">成交價</th>
                          <th className="px-2.5 py-2 text-right font-medium">目前價</th>
                          <th className="px-2.5 py-2 text-right font-medium">本層毛浮盈虧</th>
                          <th className="px-2.5 py-2 font-medium">品質</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {cycle.layers.map(layer => (
                          <tr key={layer.layerEventId}>
                            <td className="px-2.5 py-2 font-mono font-semibold">L{layer.layerIndex}</td>
                            <td className="px-2.5 py-2 font-mono">{layer.symbol}</td>
                            <td className="px-2.5 py-2">
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${layer.side === "buy" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>
                                {layer.side.toUpperCase()}
                              </span>
                            </td>
                            <td className="px-2.5 py-2 text-right font-mono">{formatQuantity(layer.remainingQuantity)}</td>
                            <td className="px-2.5 py-2 text-right font-mono">{formatPrice(layer.entryPrice)}</td>
                            <td className="px-2.5 py-2 text-right font-mono">{formatPrice(layer.markPrice)}</td>
                            <td className={`px-2.5 py-2 text-right font-mono font-semibold ${layer.grossUnrealizedPnl === null ? "text-muted-foreground" : layer.grossUnrealizedPnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                              {formatPnl(layer.grossUnrealizedPnl)}
                            </td>
                            <td className="px-2.5 py-2"><LayerQualityBadge quality={layer.quality} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="divide-y divide-white/5 md:hidden">
                    {cycle.layers.map(layer => (
                      <div key={layer.layerEventId} className="space-y-2 p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-bold">L{layer.layerIndex}</span>
                            <span className="font-mono text-xs">{layer.symbol}</span>
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${layer.side === "buy" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>
                              {layer.side.toUpperCase()}
                            </span>
                          </div>
                          <LayerQualityBadge quality={layer.quality} />
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                          <div><p className="text-[10px] text-muted-foreground">剩餘數量</p><p className="font-mono">{formatQuantity(layer.remainingQuantity)}</p></div>
                          <div><p className="text-[10px] text-muted-foreground">成交價</p><p className="font-mono">{formatPrice(layer.entryPrice)}</p></div>
                          <div><p className="text-[10px] text-muted-foreground">目前價</p><p className="font-mono">{formatPrice(layer.markPrice)}</p></div>
                          <div><p className="text-[10px] text-muted-foreground">本層毛浮盈虧</p><p className={`font-mono font-semibold ${layer.grossUnrealizedPnl === null ? "text-muted-foreground" : layer.grossUnrealizedPnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{formatPnl(layer.grossUnrealizedPnl)}</p></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <p className="text-[10px] text-muted-foreground">
                逐層盈虧為未扣手續費及資金費的毛值；最終淨盈虧以交易所帳單與實際平倉成交為準。
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
