import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatPnlAmount } from "@shared/pnl";

export const PNL_SOURCE_LABELS: Record<string, string> = {
  exchange: "交易所真值",
  local_estimate: "本地估算",
  legacy: "歷史記錄",
  unavailable: "待同步",
};

export function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 訊號來源顯示；首頁與完整訊號日誌共用，避免標籤分叉。 */
export function SourceBadge({ source }: { source?: string | null }) {
  if (!source) return <span className="text-xs text-muted-foreground">—</span>;
  const config: Record<string, { label: string; className: string }> = {
    webhook: { label: "Webhook", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
    auto: { label: "自動交易", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
    manual: { label: "手動觸發", className: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  };
  const item = config[source] ?? {
    label: source,
    className: "bg-secondary text-secondary-foreground",
  };
  return (
    <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px] font-medium", item.className)}>
      {item.label}
    </Badge>
  );
}

export type SignalPnlRecord = {
  parsedAction?: string | null;
  status?: string | null;
  hasClosingTrade?: boolean | null;
  realizedPnl?: unknown;
  fee?: unknown;
  netRealizedPnl?: unknown;
  pnlSource?: string | null;
};

/**
 * 已實現盈虧唯一顯示契約：交易所真值／本地估算／歷史記錄／待同步。
 * 數值 0 是有效結果，不能被當成缺值；開倉則明示「未實現」。
 */
export function SignalPnl({ signal }: { signal: SignalPnlRecord }) {
  const gross = finiteNumber(signal.realizedPnl);
  const fee = finiteNumber(signal.fee);
  const net = finiteNumber(signal.netRealizedPnl) ?? gross;
  const isClose = Boolean(signal.hasClosingTrade) || signal.parsedAction === "close";

  if (net !== null) {
    const source = signal.pnlSource
      ? (PNL_SOURCE_LABELS[signal.pnlSource] ?? signal.pnlSource)
      : "已實現";
    const detail = [
      `淨盈虧：${net.toFixed(8)} USDT`,
      gross !== null ? `毛盈虧：${gross.toFixed(8)} USDT` : null,
      fee !== null ? `本次費用：${fee.toFixed(8)} USDT` : null,
      `來源：${source}`,
    ].filter(Boolean).join("\n");
    return (
      <div className="flex flex-col items-end gap-0.5" title={detail}>
        <span className={cn("font-semibold", net >= 0 ? "text-emerald-400" : "text-rose-400")}>
          {net >= 0 ? "+" : ""}{net.toFixed(2)} U
        </span>
        <span className="text-[9px] text-muted-foreground">{source}</span>
      </div>
    );
  }

  if (signal.status !== "executed") {
    return <span className="text-[11px] text-muted-foreground">未成交</span>;
  }
  if (isClose) {
    return (
      <span className="text-[11px] text-amber-400" title="平倉已執行，但歷史資料尚未取得可核對的已實現盈虧">
        待同步
      </span>
    );
  }
  if (signal.parsedAction === "buy" || signal.parsedAction === "sell") {
    return (
      <span className="text-[11px] text-sky-400" title="開倉或加倉尚未產生已實現盈虧">
        未實現
      </span>
    );
  }
  return <span className="text-[11px] text-muted-foreground">不適用</span>;
}

/** 盈虧數值顯示，正綠負紅 */
export function PnlValue({
  value,
  suffix = " USDT",
  className,
}: {
  value: number;
  suffix?: string;
  className?: string;
}) {
  const positive = value > 0;
  const negative = value < 0;
  return (
    <span
      className={cn(
        "font-mono-nums",
        positive && "text-profit",
        negative && "text-loss",
        className,
      )}
    >
      {positive ? "+" : ""}
      {formatPnlAmount(value)}
      {suffix}
    </span>
  );
}

export function ExchangeBadge({ exchange }: { exchange: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "uppercase text-[10px] tracking-wider",
        exchange === "bybit"
          ? "border-amber-500/40 text-amber-400"
          : "border-sky-500/40 text-sky-400",
      )}
    >
      {exchange}
    </Badge>
  );
}

export function SideBadge({ side }: { side: string }) {
  const isLong = side === "long" || side === "buy";
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px]",
        isLong
          ? "border-emerald-500/40 text-emerald-400"
          : "border-rose-500/40 text-rose-400",
      )}
    >
      {isLong ? (side === "buy" ? "買入" : "多") : side === "sell" ? "賣出" : "空"}
    </Badge>
  );
}

const signalStatusMap: Record<string, { label: string; cls: string }> = {
  received: { label: "已接收", cls: "border-sky-500/40 text-sky-400" },
  executed: { label: "已執行", cls: "border-emerald-500/40 text-emerald-400" },
  failed: { label: "失敗", cls: "border-rose-500/40 text-rose-400" },
  rejected: { label: "已拒絕", cls: "border-orange-500/40 text-orange-400" },
  skipped: { label: "已跳過", cls: "border-amber-500/40 text-amber-400" },
};

export function SignalStatusBadge({ status }: { status: string }) {
  const info = signalStatusMap[status] ?? {
    label: status,
    cls: "border-zinc-500/40 text-zinc-400",
  };
  return (
    <Badge variant="outline" className={cn("text-[10px]", info.cls)}>
      {info.label}
    </Badge>
  );
}

export function formatTime(d: Date | string | null | undefined): string {
  if (!d) return "-";
  return new Date(d).toLocaleString("zh-TW", { hour12: false });
}
