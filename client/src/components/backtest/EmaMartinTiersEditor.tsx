/**
 * EMA 馬丁專用：階梯式馬丁分層編輯器（pipstep 版本）
 *
 * 設計參考用戶提供的 UI 截圖：
 * - 起始層 / 結束層 / 乘數 / 間距(pipstep) / 間距(USDT 自動計算)
 * - USDT = pipstep × Point_Value
 * - Martin_Multiplier 已鎖定（由分層表格控制）
 * - Max_Layers 自動讀取最後一層 end
 * - pipstep=0 表示使用全局 Global_Pipstep
 */
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";

export interface MartinTierRule {
  start: number;
  end: number;
  multiplier: number;
  pipstep: number; // 0 = 使用全局 Global_Pipstep
}

/** 解析 Martin_Tiers JSON */
export function parseTiersValue(raw: unknown): MartinTierRule[] {
  if (Array.isArray(raw)) {
    return raw.map((r: any) => ({
      start: Number(r.start) || 1,
      end: Number(r.end) || 1,
      multiplier: Number(r.multiplier) || 1,
      pipstep: Number(r.pipstep) || 0,
    }));
  }
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.map((r: any) => ({
          start: Number(r.start) || 1,
          end: Number(r.end) || 1,
          multiplier: Number(r.multiplier) || 1,
          pipstep: Number(r.pipstep) || 0,
        }));
      }
    } catch {
      return [];
    }
  }
  return [];
}

/** 驗證分層規則 */
export function validateTiersUI(rules: MartinTierRule[]): string | null {
  if (rules.length === 0) return null;
  for (const r of rules) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || !Number.isFinite(r.multiplier)) {
      return "分層規則含空白或非法數值";
    }
    if (r.start < 1) return `起始層必須 ≥ 1（收到 ${r.start}）`;
    if (r.start > r.end) return `起始層 ${r.start} 不可大於結束層 ${r.end}`;
    if (r.multiplier <= 0) return `乘數必須 > 0（收到 ${r.multiplier}）`;
    if (r.pipstep < 0) return `間距必須 ≥ 0（收到 ${r.pipstep}）`;
  }
  const sorted = [...rules].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) {
      return `層數範圍重疊：${sorted[i - 1].start}-${sorted[i - 1].end} 與 ${sorted[i].start}-${sorted[i].end}`;
    }
    if (sorted[i].start > sorted[i - 1].end + 1) {
      return `層數範圍不連續：第 ${sorted[i - 1].end} 層到第 ${sorted[i].start} 層之間有間隙`;
    }
  }
  return null;
}

/** 計算最大層數 */
export function calculateMaxLayersFromTiers(tiers: MartinTierRule[]): number {
  if (!tiers || tiers.length === 0) return 11;
  const sorted = [...tiers].sort((a, b) => a.start - b.start);
  return sorted[sorted.length - 1].end;
}

export default function EmaMartinTiersEditor({
  value,
  onChange,
  pointValue,
  globalPipstep,
}: {
  value: unknown;
  onChange: (jsonStr: string) => void;
  pointValue: number;
  globalPipstep: number;
}) {
  const rules = useMemo(() => parseTiersValue(value), [value]);
  const error = useMemo(() => validateTiersUI(rules), [rules]);

  const emit = (next: MartinTierRule[]) => {
    onChange(next.length === 0 ? "" : JSON.stringify(next));
  };

  const updateRule = (idx: number, field: keyof MartinTierRule, v: string) => {
    const next = rules.map((r, i) =>
      i === idx ? { ...r, [field]: v === "" ? 0 : Number(v) } : r,
    );
    emit(next);
  };

  const addRule = () => {
    const lastEnd = rules.length > 0 ? rules[rules.length - 1].end : 0;
    emit([...rules, { start: lastEnd + 1, end: lastEnd + 3, multiplier: 1.2, pipstep: 0 }]);
  };

  const removeRule = (idx: number) => {
    emit(rules.filter((_, i) => i !== idx));
  };

  // 計算累積倍數
  const getCumulative = (targetEnd: number): string => {
    let cum = 1;
    for (let i = 1; i <= targetEnd; i++) {
      let mult = 1.0;
      for (const rule of rules) {
        if (i >= rule.start && i <= rule.end) {
          mult = rule.multiplier;
          break;
        }
      }
      cum *= mult;
    }
    return cum.toFixed(2);
  };

  // 計算 USDT 距離
  const getUsdtDistance = (pipstep: number): string => {
    const effectivePipstep = pipstep > 0 ? pipstep : globalPipstep;
    const usdt = effectivePipstep * pointValue;
    return usdt.toFixed(2);
  };

  const maxLayers = calculateMaxLayersFromTiers(rules);

  return (
    <div className="space-y-1 col-span-2 md:col-span-4 lg:col-span-6" data-testid="ema-martin-tiers-editor">
      {/* 頂部摘要 */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Label className="text-[10px] text-orange-400 font-medium">Martin_Multiplier</Label>
          <span className="text-[10px] text-red-400">🔒 已鎖定</span>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-[10px] text-green-400 font-medium">Max_Layers</Label>
          <span className="text-[10px] text-green-400">🔒 自動計算</span>
          <span className="text-xs font-mono text-foreground">{maxLayers}</span>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">
        🔒 已啟用階梯式分層，固定乘數已鎖定，請在分層表格設定各層乘數
      </p>
      <p className="text-[10px] text-green-400">
        💡 自動讀取分層表格最後一層，目前為第 {maxLayers} 層
      </p>

      {/* 分層表格 */}
      <Label className="text-[10px] text-muted-foreground block mt-2">
        📊 階梯式馬丁分層（乘數 + 間距）
        <span className="text-[9px] text-muted-foreground/60 ml-2">
          （第 5 層以上建議間距拉寬至 2.0-3.0%）
        </span>
      </Label>
      <div className="space-y-1.5 rounded-md border border-border p-2">
        {rules.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            未設定分層。點「新增分層」啟用階梯式乘數 + 動態間距。
          </p>
        )}
        {/* 表頭 */}
        {rules.length > 0 && (
          <div className="grid grid-cols-[4.5rem_4.5rem_2rem_5rem_6rem_5rem_4.5rem_2rem] gap-1.5 text-[9px] text-muted-foreground/70 font-medium px-0.5">
            <span>起始</span>
            <span>結束</span>
            <span></span>
            <span>乘數</span>
            <span>間距(pipstep)</span>
            <span>間距(USDT)</span>
            <span>累積</span>
            <span></span>
          </div>
        )}
        {rules.map((r, idx) => (
          <div key={idx} className="grid grid-cols-[4.5rem_4.5rem_2rem_5rem_6rem_5rem_4.5rem_2rem] gap-1.5 items-center">
            <Input
              className="h-7 text-xs"
              type="number"
              min="1"
              step="1"
              lang="en"
              inputMode="numeric"
              value={String(r.start)}
              onChange={(e) => updateRule(idx, "start", e.target.value)}
              aria-label={`分層 ${idx + 1} 起始層`}
            />
            <Input
              className="h-7 text-xs"
              type="number"
              min="1"
              step="1"
              lang="en"
              inputMode="numeric"
              value={String(r.end)}
              onChange={(e) => updateRule(idx, "end", e.target.value)}
              aria-label={`分層 ${idx + 1} 結束層`}
            />
            <span className="text-[10px] text-muted-foreground">層</span>
            <Input
              className="h-7 text-xs"
              type="number"
              min="0"
              step="any"
              lang="en"
              inputMode="decimal"
              value={String(r.multiplier)}
              onChange={(e) => updateRule(idx, "multiplier", e.target.value)}
              aria-label={`分層 ${idx + 1} 乘數`}
            />
            <Input
              className="h-7 text-xs"
              type="number"
              min="0"
              step="100"
              lang="en"
              inputMode="numeric"
              value={String(r.pipstep)}
              onChange={(e) => updateRule(idx, "pipstep", e.target.value)}
              placeholder="全局"
              aria-label={`分層 ${idx + 1} 間距(pipstep)`}
              title="0 = 使用全局 Global_Pipstep"
            />
            {/* USDT 自動計算（唯讀） */}
            <span className="text-[11px] text-blue-400 text-center font-mono">
              ${getUsdtDistance(r.pipstep)}
            </span>
            {/* 累積倍數 */}
            <span className="text-[10px] text-muted-foreground/60 text-center">
              {getCumulative(Number(r.end))}x
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-red-500"
              onClick={() => removeRule(idx)}
              aria-label={`刪除分層 ${idx + 1}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-2 pt-0.5">
          <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={addRule}>
            <Plus className="w-3 h-3 mr-1" />
            新增分層
          </Button>
          {error && <span className="text-[11px] text-red-500">{error}</span>}
        </div>
        <p className="text-[10px] text-muted-foreground">
          💡 間距留空(0)則使用「全局加倉間距」；第 5 層以上建議設定專屬間距。層數範圍不可重疊且需連續，最後一層將自動設定 Max_Layers。
        </p>
        <p className="text-[10px] text-blue-400">
          💡 全局加倉間距：當分層未設定專屬間距時，所有層數使用此值。
        </p>
        <p className="text-[10px] text-muted-foreground">
          📐 USDT 計算：pipstep × Point_Value = 實際距離。例：pipstep=10000, Point_Value=0.01 → $100
        </p>
      </div>
    </div>
  );
}
