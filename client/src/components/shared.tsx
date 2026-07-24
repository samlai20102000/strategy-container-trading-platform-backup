import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
      {value.toFixed(2)}
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
