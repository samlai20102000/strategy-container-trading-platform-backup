/**
 * 階梯式馬丁分層編輯器（Pasted_content_21 O1 + Pasted_content_24 UI-1/UI-5）
 *
 * - 以「起始層 / 結束層 / 乘數 / 間距 %」列表方式編輯 Martin_Layers
 * - 支援新增 / 刪除分層
 * - 即時驗證：start >= 1、start <= end、multiplier > 0、各層區間不可重疊/間隙
 * - 🔥 UI-5：新增 stepPct 欄位（選填，留空使用全局 Martin_Step_Pct）
 * - 對外值為 JSON 字串（與後端 parseMartinLayers 對接）
 */
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";

export interface MartinLayerRuleUI {
  start: number;
  end: number;
  multiplier: number;
  stepPct?: number; // 🔥 UI-5：該層專屬間距（%，選填）
}

/** 解析 JSON 字串為分層規則陣列（失敗回傳空陣列） */
export function parseLayersValue(raw: unknown): { start: number; end: number; multiplier: number; stepPct?: number; }[] {
  if (Array.isArray(raw)) {
    return raw.map((r: any) => ({
      start: Number(r.start),
      end: Number(r.end),
      multiplier: Number(r.multiplier),
      stepPct: r.stepPct !== undefined && r.stepPct !== "" ? Number(r.stepPct) : undefined,
    }));
  }
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.map((r: any) => ({
          start: Number(r.start),
          end: Number(r.end),
          multiplier: Number(r.multiplier),
          stepPct: r.stepPct,
        }));
      }
    } catch {
      return [];
    }
  }
  return [];
}

/** 前端驗證（與後端 validateMartinLayers + parameterValidator 邏輯一致） */
export function validateLayersUI(rules: MartinLayerRuleUI[]): string | null {
  if (rules.length === 0) return null; // 空 = 使用固定乘數，合法
  const parsed = rules.map((r) => ({
    start: Number(r.start),
    end: Number(r.end),
    multiplier: Number(r.multiplier),
    stepPct: r.stepPct,
  }));
  for (const r of parsed) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || !Number.isFinite(r.multiplier)) {
      return "分層規則含空白或非法數值";
    }
    if (r.start < 1) return `起始層必須 ≥ 1（收到 ${r.start}）`;
    if (r.start > r.end) return `起始層 ${r.start} 不可大於結束層 ${r.end}`;
    if (r.multiplier <= 0) return `乘數必須 > 0（收到 ${r.multiplier}）`;
    // stepPct 驗證（僅檢查非負數，不設最低限制）
    if (r.stepPct !== undefined) {
      if (!Number.isFinite(r.stepPct) || r.stepPct < 0) {
        return `間距必須 ≥ 0（收到 ${r.stepPct}）`;
      }
    }
  }
  const sorted = [...parsed].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) {
      return `層數範圍重疊：${sorted[i - 1].start}-${sorted[i - 1].end} 與 ${sorted[i].start}-${sorted[i].end} 衝突`;
    }
    if (sorted[i].start > sorted[i - 1].end + 1) {
      return `層數範圍不連續：第 ${sorted[i - 1].end} 層到第 ${sorted[i].start} 層之間有間隙，請補齊`;
    }
  }
  return null;
}

/**
 * 計算最大層數：取 Martin_Layers 最後一層的 end 值；無分層時回退預設 5
 */
export function calculateMaxLayers(martinLayers: MartinLayerRuleUI[]): number {
  if (!martinLayers || martinLayers.length === 0) {
    return 5;
  }
  const sorted = [...martinLayers]
    .map((r) => ({ start: Number(r.start), end: Number(r.end) }))
    .filter((r) => Number.isFinite(r.end))
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return 5;
  return sorted[sorted.length - 1].end;
}

/**
 * 🔥 UI-2：檢查是否有任何分層設定了專屬間距
 */
export function hasAnyLayerStepPct(rules: MartinLayerRuleUI[]): boolean {
  return rules.some(
    (r) => r.stepPct !== undefined && r.stepPct > 0,
  );
}

export default function MartinLayersEditor({
  value,
  onChange,
}: {
  /** Martin_Layers 當前值（JSON 字串或陣列） */
  value: unknown;
  /** 變更回調（回傳 JSON 字串，空陣列回傳 ""） */
  onChange: (jsonStr: string) => void;
}) {
  const rules = useMemo(() => parseLayersValue(value), [value]);
  const error = useMemo(() => validateLayersUI(rules), [rules]);

  const emit = (next: MartinLayerRuleUI[]) => {
    onChange(next.length === 0 ? "" : JSON.stringify(next));
  };

  const updateRule = (idx: number, field: keyof MartinLayerRuleUI, v: string) => {
    const next = rules.map((r, i) =>
      i === idx ? { ...r, [field]: v === "" ? undefined : Number(v) } : r,
    );
    emit(next);
  };

  const addRule = () => {
    const lastEnd = rules.length > 0 ? rules[rules.length - 1].end : 0;
    emit([...rules, { start: lastEnd + 1, end: lastEnd + 3, multiplier: 1.2, stepPct: undefined }]);
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

  return (
    <div className="space-y-1 col-span-2 md:col-span-4 lg:col-span-6" data-testid="martin-layers-editor">
      <Label
        className="text-[10px] text-muted-foreground truncate block"
        title="Martin_Layers（階梯式馬丁分層：乘數 + 間距）"
      >
        📊 階梯式馬丁分層（乘數 + 間距）
        <span className="text-[9px] text-muted-foreground/60 ml-2">
          （任意設定各層間距，無上下限）
        </span>
      </Label>
      <div className="space-y-1.5 rounded-md border border-border p-2">
        {rules.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            未設定分層，將使用固定 Martin_Multiplier 和全局 Martin_Step_Pct。點「新增分層」啟用階梯式乘數 + 動態間距。
          </p>
        )}
        {/* 表頭 */}
        {rules.length > 0 && (
          <div className="grid grid-cols-[5rem_5rem_2rem_5.5rem_5.5rem_4.5rem_2rem] gap-1.5 text-[9px] text-muted-foreground/70 font-medium px-0.5">
            <span>起始</span>
            <span>結束</span>
            <span></span>
            <span>乘數</span>
            <span>間距%</span>
            <span>累積</span>
            <span></span>
          </div>
        )}
        {rules.map((r, idx) => (
          <div key={idx} className="grid grid-cols-[5rem_5rem_2rem_5.5rem_5.5rem_4.5rem_2rem] gap-1.5 items-center">
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
            {/* 🔥 UI-1：間距 % 欄位（新增） */}
            <Input
              className="h-7 text-xs"
              type="number"
              min="0"
              step="any"
              lang="en"
              inputMode="decimal"
              value={r.stepPct !== undefined ? String(r.stepPct) : ""}
              onChange={(e) => updateRule(idx, "stepPct", e.target.value)}
              placeholder="全局"
              aria-label={`分層 ${idx + 1} 間距`}
              title="留空使用全局 Martin_Step_Pct"
            />
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
          💡 間距留空則使用「全局加倉間距」。層數範圍不可重疊且需連續，最後一層將自動設定 Max_Layers。間距無上下限，完全由用戶自行設定。
        </p>
      </div>
    </div>
  );
}
