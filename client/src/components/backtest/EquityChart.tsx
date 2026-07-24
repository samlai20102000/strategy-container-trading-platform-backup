/**
 * 權益曲線圖表（pasted_content_4.txt 任務 10）
 * lightweight-charts v5 API（chart.addSeries(LineSeries, ...)）
 * 深色主題 + 買賣標記 + 重置縮放
 */

import { useEffect, useRef } from "react";
import {
  createChart,
  createSeriesMarkers,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import { Button } from "@/components/ui/button";

export interface EquityChartPoint {
  timestamp: number;
  equity: number;
  price: number;
}

export interface EquityChartTrade {
  entryTime: number;
  exitTime: number;
  side: string;
  pnl: number;
}

interface Props {
  equityCurve: EquityChartPoint[];
  trades?: EquityChartTrade[];
  height?: number;
}

export default function EquityChart({ equityCurve, trades = [], height = 350 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || equityCurve.length === 0) return;

    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { color: "#131722" },
        textColor: "#d1d4dc",
      },
      grid: {
        vertLines: { color: "#2a2e39" },
        horzLines: { color: "#2a2e39" },
      },
      timeScale: {
        timeVisible: true,
        borderColor: "#2a2e39",
      },
      rightPriceScale: {
        borderColor: "#2a2e39",
      },
    });
    chartRef.current = chart;

    // 權益曲線（藍色主線）
    const lineSeries = chart.addSeries(LineSeries, {
      color: "#2962FF",
      lineWidth: 3,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    // 去重並排序（lightweight-charts 要求時間嚴格遞增）
    const seen = new Set<number>();
    const lineData = equityCurve
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((p) => {
        const t = Math.floor(p.timestamp / 1000);
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      })
      .map((p) => ({
        time: Math.floor(p.timestamp / 1000) as UTCTimestamp,
        value: p.equity,
      }));
    lineSeries.setData(lineData);

    // 買賣標記（histogram：多單綠 / 空單紅，落在出場時間）
    if (trades.length > 0) {
      const histSeries = chart.addSeries(HistogramSeries, {
        priceScaleId: "trades",
        priceFormat: { type: "volume" },
      });
      chart.priceScale("trades").applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });
      const seenT = new Set<number>();
      const histData = trades
        .slice()
        .sort((a, b) => a.exitTime - b.exitTime)
        .filter((t) => {
          const ts = Math.floor(t.exitTime / 1000);
          if (seenT.has(ts)) return false;
          seenT.add(ts);
          return true;
        })
        .map((t) => ({
          time: Math.floor(t.exitTime / 1000) as UTCTimestamp,
          value: Math.abs(t.pnl),
          color: t.side === "long" ? "#26a69a" : "#ef5350",
        }));
      histSeries.setData(histData);

      // 任務 C3：買賣箭頭標記（入場 ↑/↓ + 出場 ●，多單綠/空單紅）
      const markers: SeriesMarker<UTCTimestamp>[] = [];
      const markerSeen = new Set<string>();
      for (const t of trades.slice().sort((a, b) => a.entryTime - b.entryTime)) {
        const entryTs = Math.floor(t.entryTime / 1000) as UTCTimestamp;
        const exitTs = Math.floor(t.exitTime / 1000) as UTCTimestamp;
        const isLong = t.side === "long";
        const entryKey = `e${entryTs}`;
        if (!markerSeen.has(entryKey)) {
          markerSeen.add(entryKey);
          markers.push({
            time: entryTs,
            position: isLong ? "belowBar" : "aboveBar",
            color: isLong ? "#26a69a" : "#ef5350",
            shape: isLong ? "arrowUp" : "arrowDown",
            text: isLong ? "買升" : "買跌",
          });
        }
        const exitKey = `x${exitTs}`;
        if (!markerSeen.has(exitKey)) {
          markerSeen.add(exitKey);
          markers.push({
            time: exitTs,
            position: "aboveBar",
            color: t.pnl >= 0 ? "#26a69a" : "#ef5350",
            shape: "circle",
            text: `平 ${t.pnl >= 0 ? "+" : ""}${Math.round(t.pnl * 100) / 100}`,
          });
        }
      }
      markers.sort((a, b) => (a.time as number) - (b.time as number));
      createSeriesMarkers(lineSeries, markers);
    }

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);
    handleResize();

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [equityCurve, trades, height]);

  if (equityCurve.length === 0) {
    return (
      <div className="flex items-center justify-center h-[350px] text-muted-foreground text-sm">
        暫無權益曲線數據
      </div>
    );
  }

  return (
    <div className="relative">
      <div ref={containerRef} className="w-full rounded-md overflow-hidden" />
      <Button
        variant="outline"
        size="sm"
        className="absolute top-2 right-2 z-10 bg-background/80 text-xs"
        onClick={() => chartRef.current?.timeScale().fitContent()}
      >
        重置縮放
      </Button>
    </div>
  );
}
