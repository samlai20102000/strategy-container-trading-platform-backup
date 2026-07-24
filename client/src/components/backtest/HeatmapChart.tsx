/**
 * 參數掃描熱力圖組件（V4.1）
 * 使用 CSS Grid + 色階渲染 2D 參數空間的績效分佈
 * 不依賴 echarts，純 React + Tailwind 實現
 */

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface HeatmapDataPoint {
  param1: number;
  param2: number;
  value: number;
}

interface Props {
  data: HeatmapDataPoint[];
  param1Name: string;
  param2Name: string;
  /** 目標函數名稱（用於色階標籤） */
  objectiveName?: string;
  height?: number;
}

/** 線性插值色階：紅 → 黃 → 綠 */
function getHeatColor(ratio: number): string {
  // ratio: 0 = worst (red), 1 = best (green)
  const clamped = Math.max(0, Math.min(1, ratio));
  if (clamped < 0.5) {
    // red → yellow
    const t = clamped * 2;
    const r = 220;
    const g = Math.round(50 + t * 170);
    const b = 50;
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    // yellow → green
    const t = (clamped - 0.5) * 2;
    const r = Math.round(220 - t * 170);
    const g = 220;
    const b = 50;
    return `rgb(${r}, ${g}, ${b})`;
  }
}

export default function HeatmapChart({
  data,
  param1Name,
  param2Name,
  objectiveName = "目標值",
  height = 400,
}: Props) {
  const [hoveredCell, setHoveredCell] = useState<HeatmapDataPoint | null>(null);

  // 提取唯一的 param1 和 param2 值（排序）
  const { param1Values, param2Values, grid, minVal, maxVal } = useMemo(() => {
    const p1Set = new Set<number>();
    const p2Set = new Set<number>();
    data.forEach((d) => {
      p1Set.add(d.param1);
      p2Set.add(d.param2);
    });
    const p1Vals = Array.from(p1Set).sort((a, b) => a - b);
    const p2Vals = Array.from(p2Set).sort((a, b) => a - b);

    // 建立 grid map
    const gridMap = new Map<string, number>();
    let min = Infinity;
    let max = -Infinity;
    data.forEach((d) => {
      const key = `${d.param1}_${d.param2}`;
      gridMap.set(key, d.value);
      if (d.value !== -Infinity && Number.isFinite(d.value)) {
        min = Math.min(min, d.value);
        max = Math.max(max, d.value);
      }
    });

    return {
      param1Values: p1Vals,
      param2Values: p2Vals,
      grid: gridMap,
      minVal: min === Infinity ? 0 : min,
      maxVal: max === -Infinity ? 1 : max,
    };
  }, [data]);

  if (data.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          無熱力圖數據（需要至少 2 個掃描參數）
        </CardContent>
      </Card>
    );
  }

  const range = maxVal - minVal || 1;
  const cols = param1Values.length;
  const rows = param2Values.length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">參數掃描熱力圖</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {param1Name} × {param2Name}
          </Badge>
          {hoveredCell && (
            <Badge className="bg-zinc-700 text-xs font-mono">
              {param1Name}={hoveredCell.param1}, {param2Name}={hoveredCell.param2} → {hoveredCell.value.toFixed(3)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          {/* Y 軸標籤 + Grid */}
          <div className="flex gap-1" style={{ minHeight: height }}>
            {/* Y 軸 */}
            <div className="flex flex-col justify-between text-xs text-muted-foreground pr-2 py-1">
              <span className="font-mono">{param2Name}</span>
              {param2Values.slice().reverse().map((v) => (
                <span key={v} className="font-mono text-[10px]">{v}</span>
              ))}
            </div>

            {/* 熱力圖格子 */}
            <div className="flex-1">
              <div
                className="grid gap-[1px]"
                style={{
                  gridTemplateColumns: `repeat(${cols}, 1fr)`,
                  gridTemplateRows: `repeat(${rows}, 1fr)`,
                  height: `${Math.min(height, rows * 40)}px`,
                }}
              >
                {param2Values.slice().reverse().map((p2) =>
                  param1Values.map((p1) => {
                    const key = `${p1}_${p2}`;
                    const val = grid.get(key);
                    const ratio = val !== undefined && Number.isFinite(val)
                      ? (val - minVal) / range
                      : 0;
                    const color = val !== undefined && Number.isFinite(val)
                      ? getHeatColor(ratio)
                      : "rgb(40, 40, 40)";

                    return (
                      <Tooltip key={key}>
                        <TooltipTrigger asChild>
                          <div
                            className="rounded-sm cursor-pointer transition-all hover:ring-2 hover:ring-white/50 hover:z-10"
                            style={{ backgroundColor: color, minHeight: "20px" }}
                            onMouseEnter={() => setHoveredCell({ param1: p1, param2: p2, value: val ?? 0 })}
                            onMouseLeave={() => setHoveredCell(null)}
                          />
                        </TooltipTrigger>
                        <TooltipContent className="font-mono text-xs">
                          <p>{param1Name}: {p1}</p>
                          <p>{param2Name}: {p2}</p>
                          <p>{objectiveName}: {val?.toFixed(4) ?? "N/A"}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  }),
                )}
              </div>

              {/* X 軸標籤 */}
              <div className="flex justify-between mt-1 text-[10px] text-muted-foreground font-mono">
                {param1Values.map((v) => (
                  <span key={v}>{v}</span>
                ))}
              </div>
              <div className="text-center text-xs text-muted-foreground mt-1">
                {param1Name}
              </div>
            </div>

            {/* 色階圖例 */}
            <div className="flex flex-col items-center justify-between ml-3 py-1">
              <span className="text-[10px] text-muted-foreground font-mono">{maxVal.toFixed(2)}</span>
              <div
                className="w-4 flex-1 rounded-sm my-1"
                style={{
                  background: "linear-gradient(to bottom, rgb(50, 220, 50), rgb(220, 220, 50), rgb(220, 50, 50))",
                }}
              />
              <span className="text-[10px] text-muted-foreground font-mono">{minVal.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
