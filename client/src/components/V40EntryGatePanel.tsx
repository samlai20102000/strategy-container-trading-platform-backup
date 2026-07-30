import { Badge } from "@/components/ui/badge";
import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  Activity,
  CandlestickChart,
  LockKeyhole,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

export const V40_STRATEGY_KEY = "20415_KAMA_MARTIN_V35" as const;

export type V40ThreeKPatternMode = "breakout" | "three_body_same_direction";

export interface V40EntryGateValue {
  enableThreeKFilter: boolean;
  threeKPatternMode: V40ThreeKPatternMode;
  enableKamaDirectionLock: boolean;
  enableSameDirectionReentry: boolean;
}

export const V40_ENTRY_GATE_DEFAULTS: V40EntryGateValue = {
  enableThreeKFilter: true,
  threeKPatternMode: "breakout",
  enableKamaDirectionLock: true,
  enableSameDirectionReentry: true,
};

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

export function normalizeV40EntryGateValue(
  input: Record<string, unknown> | null | undefined,
): V40EntryGateValue {
  return {
    enableThreeKFilter: normalizeBoolean(
      input?.enableThreeKFilter,
      V40_ENTRY_GATE_DEFAULTS.enableThreeKFilter,
    ),
    threeKPatternMode: input?.threeKPatternMode === "three_body_same_direction"
      ? "three_body_same_direction"
      : "breakout",
    enableKamaDirectionLock: normalizeBoolean(
      input?.enableKamaDirectionLock,
      V40_ENTRY_GATE_DEFAULTS.enableKamaDirectionLock,
    ),
    enableSameDirectionReentry: normalizeBoolean(
      input?.enableSameDirectionReentry,
      V40_ENTRY_GATE_DEFAULTS.enableSameDirectionReentry,
    ),
  };
}

interface V40EntryGatePanelProps {
  value: Record<string, unknown> | V40EntryGateValue;
  onChange: (next: V40EntryGateValue) => void;
  context: "strategy" | "backtest";
  disabled?: boolean;
  className?: string;
}

function GateToggle({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  icon: Icon,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  icon: typeof ShieldCheck;
}) {
  return (
    <div
      className={cn(
        "flex min-h-24 items-start justify-between gap-4 rounded-lg border px-4 py-3 transition-[border-color,background-color,transform] duration-150",
        checked
          ? "border-emerald-500/35 bg-emerald-500/[0.07]"
          : "border-border/70 bg-background/45",
      )}
    >
      <div className="flex min-w-0 gap-3">
        <div
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
            checked
              ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-300"
              : "border-border bg-muted/35 text-muted-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <Label htmlFor={id} className="cursor-pointer text-sm font-semibold text-foreground">
            {title}
          </Label>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          aria-label={`${title}：${checked ? "已啟用" : "已停用"}`}
          data-testid={`${id}-switch`}
        />
        <span className={cn("font-mono text-[9px] font-bold tracking-wider", checked ? "text-emerald-400" : "text-muted-foreground")}>
          {checked ? "ENABLED" : "DISABLED"}
        </span>
      </div>
    </div>
  );
}

export function V40EntryGatePanel({
  value,
  onChange,
  context,
  disabled = false,
  className,
}: V40EntryGatePanelProps) {
  const normalized = normalizeV40EntryGateValue(value as Record<string, unknown>);
  const entryGateCount = Number(normalized.enableThreeKFilter) + Number(normalized.enableKamaDirectionLock);
  const contextLabel = context === "strategy" ? "策略交易" : "回測中心";

  const update = <K extends keyof V40EntryGateValue>(key: K, nextValue: V40EntryGateValue[K]) => {
    onChange({ ...normalized, [key]: nextValue });
  };

  return (
    <Card
      className={cn(
        "overflow-hidden border-slate-700/80 bg-[linear-gradient(145deg,rgba(15,23,42,0.96),rgba(9,15,27,0.96))] text-slate-100 shadow-[0_16px_48px_rgba(2,6,23,0.28)]",
        className,
      )}
      data-testid={`v40-entry-gate-${context}`}
    >
      <div className="border-b border-slate-700/75 bg-slate-950/45 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
              <LockKeyhole className="size-4" aria-hidden="true" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold tracking-wide text-slate-100">V4.0 入場安全閘</h3>
                <Badge className="border-cyan-400/30 bg-cyan-400/10 text-[9px] tracking-[0.14em] text-cyan-200 hover:bg-cyan-400/10">
                  {contextLabel}
                </Badge>
              </div>
              <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-slate-400">
                僅控制新首單與第 0 層順勢獲利後的特殊原地重入；不改動馬丁加倉、止盈、止損或平倉。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-950/55 px-2.5 py-1.5">
            <Activity className="size-3.5 text-emerald-400" aria-hidden="true" />
            <span className="font-mono text-[10px] font-semibold text-slate-300">
              ENTRY GATES {entryGateCount}/2
            </span>
          </div>
        </div>
      </div>

      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 lg:grid-cols-3">
          <GateToggle
            id={`v40-three-k-${context}`}
            title="三 K 形態確認"
            description="啟用後，每次新首單必須通過下方所選的唯一三 K 模式。"
            checked={normalized.enableThreeKFilter}
            onCheckedChange={(checked) => update("enableThreeKFilter", checked)}
            disabled={disabled}
            icon={CandlestickChart}
          />
          <GateToggle
            id={`v40-kama-lock-${context}`}
            title="KAMA 方向鎖"
            description="做多要求 price > slow KAMA；做空要求 price < slow KAMA。資料不足即 HOLD。"
            checked={normalized.enableKamaDirectionLock}
            onCheckedChange={(checked) => update("enableKamaDirectionLock", checked)}
            disabled={disabled}
            icon={ShieldCheck}
          />
          <GateToggle
            id={`v40-same-direction-reentry-${context}`}
            title="特殊原地重入"
            description="只控制第 0 層順勢獲利平倉後、方向仍一致時的立即原地重入。"
            checked={normalized.enableSameDirectionReentry}
            onCheckedChange={(checked) => update("enableSameDirectionReentry", checked)}
            disabled={disabled}
            icon={RefreshCw}
          />
        </div>

        <div
          className={cn(
            "rounded-lg border p-3.5 transition-[opacity,border-color,background-color] duration-200",
            normalized.enableThreeKFilter
              ? "border-cyan-400/30 bg-cyan-400/[0.055]"
              : "border-slate-700 bg-slate-950/30 opacity-65",
          )}
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-bold tracking-wide text-slate-200">三 K 模式｜強制二選一</p>
              <p className="mt-0.5 text-[10px] text-slate-400">
                模式值會保留；三 K 總開關停用時不執行所選模式。
              </p>
            </div>
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-[9px] tracking-wider",
                normalized.enableThreeKFilter
                  ? "border-cyan-400/35 text-cyan-300"
                  : "border-slate-600 text-slate-500",
              )}
            >
              {normalized.enableThreeKFilter ? "MODE ARMED" : "MODE STANDBY"}
            </Badge>
          </div>

          <RadioGroup
            value={normalized.threeKPatternMode}
            onValueChange={(mode) => update("threeKPatternMode", mode as V40ThreeKPatternMode)}
            disabled={disabled || !normalized.enableThreeKFilter}
            className="grid gap-3 md:grid-cols-2"
            aria-label="V4.0 三 K 模式"
          >
            <Label
              htmlFor={`v40-breakout-${context}`}
              className={cn(
                "flex min-h-28 cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-[border-color,background-color,transform] duration-150 active:scale-[0.99]",
                normalized.threeKPatternMode === "breakout"
                  ? "border-cyan-400/45 bg-cyan-400/10"
                  : "border-slate-700 bg-slate-950/35 hover:border-slate-500",
                (!normalized.enableThreeKFilter || disabled) && "cursor-not-allowed",
              )}
            >
              <RadioGroupItem id={`v40-breakout-${context}`} value="breakout" className="mt-0.5 border-cyan-300 text-cyan-300" />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-slate-100">A｜前兩根同向＋第三根收盤破位</span>
                <span className="mt-1.5 block text-[11px] font-normal leading-relaxed text-slate-400">
                  前兩根 K 線實體同向；第三根收盤突破前兩根最高價（做多）或最低價（做空）。
                </span>
              </span>
            </Label>

            <Label
              htmlFor={`v40-three-body-${context}`}
              className={cn(
                "flex min-h-28 cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-[border-color,background-color,transform] duration-150 active:scale-[0.99]",
                normalized.threeKPatternMode === "three_body_same_direction"
                  ? "border-cyan-400/45 bg-cyan-400/10"
                  : "border-slate-700 bg-slate-950/35 hover:border-slate-500",
                (!normalized.enableThreeKFilter || disabled) && "cursor-not-allowed",
              )}
            >
              <RadioGroupItem id={`v40-three-body-${context}`} value="three_body_same_direction" className="mt-0.5 border-cyan-300 text-cyan-300" />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-slate-100">B｜三根 K 線實體全部連續同向</span>
                <span className="mt-1.5 block text-[11px] font-normal leading-relaxed text-slate-400">
                  做多要求三根皆收紅；做空要求三根皆收黑。不另外要求第三根突破前高或前低。
                </span>
              </span>
            </Label>
          </RadioGroup>
        </div>

        <div
          className={cn(
            "flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[11px] leading-relaxed",
            entryGateCount === 0
              ? "border-amber-400/35 bg-amber-400/[0.07] text-amber-100"
              : "border-slate-700 bg-slate-950/35 text-slate-300",
          )}
          role="status"
          data-testid={`v40-entry-gate-summary-${context}`}
        >
          {entryGateCount === 0 ? (
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden="true" />
          ) : (
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden="true" />
          )}
          <p>
            {entryGateCount === 0
              ? "Fail-safe：三 K 與 KAMA 方向鎖同時停用時，自動分析與回測不推導方向，維持 HOLD；外部 BUY／SELL 仍須通過方向與策略限制。"
              : `有效首單規則：${normalized.enableThreeKFilter ? (normalized.threeKPatternMode === "breakout" ? "三 K 突破模式" : "三根實體同向模式") : "不檢查三 K"}；${normalized.enableKamaDirectionLock ? "啟用 slow KAMA 方向鎖" : "不檢查 KAMA 方向"}。`}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default V40EntryGatePanel;
