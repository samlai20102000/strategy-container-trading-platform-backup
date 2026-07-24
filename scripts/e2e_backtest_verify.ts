/**
 * 端到端回測驗證腳本
 * 1) 優先從交易所 API 抓取真實 K 線
 * 2) 若沙盒網路受限，使用確定性合成數據（趨勢+震盪）驗證引擎全流程
 */

import { getBacktestDatabase } from "../server/services/backtest/backtestDatabase";
import { backtestEngine } from "../server/services/backtest/backtestEngine";
import { ensureOHLCVData } from "../server/services/backtest/dataFetcher";

const SYMBOL = "BTC-USDT";
const TF = "1h";
const DAYS = 90;

function generateSyntheticCandles(startMs: number, count: number, tfMs: number) {
  // 確定性偽隨機（LCG），混合趨勢段與震盪段
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const candles = [];
  let price = 60000;
  for (let i = 0; i < count; i++) {
    // 每 200 根切換趨勢方向：上升 → 震盪 → 下降 → 震盪
    const phase = Math.floor(i / 200) % 4;
    const drift = phase === 0 ? 0.0015 : phase === 2 ? -0.0015 : 0;
    const vol = phase % 2 === 0 ? 0.004 : 0.008;
    const change = drift + (rand() - 0.5) * vol;
    const open = price;
    const close = price * (1 + change);
    const high = Math.max(open, close) * (1 + rand() * 0.002);
    const low = Math.min(open, close) * (1 - rand() * 0.002);
    candles.push({
      symbol: SYMBOL,
      timeframe: TF,
      timestamp: startMs + i * tfMs,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: Math.round(rand() * 100 * 100) / 100,
    });
    price = close;
  }
  return candles;
}

async function main() {
  const endMs = Date.now();
  const startMs = endMs - DAYS * 86400000;
  const tfMs = 3600_000;
  const db = getBacktestDatabase();

  // 1) 嘗試抓取真實數據
  let dataSource = "real";
  try {
    const rows = await ensureOHLCVData(SYMBOL, TF, startMs, endMs, "okx", (p) =>
      process.stdout.write(`\r${p.message}        `),
    );
    console.log(`\n✅ 真實數據就緒：${rows.length} 根 K 線`);
    if (rows.length < 100) throw new Error("數據不足");
  } catch (e) {
    console.warn(`\n⚠️ 真實數據抓取失敗（${e instanceof Error ? e.message : e}），改用合成數據驗證引擎`);
    dataSource = "synthetic";
    const candles = generateSyntheticCandles(startMs, DAYS * 24, tfMs);
    db.insertOHLCV(candles);
    console.log(`✅ 合成數據就緒：${candles.length} 根 K 線`);
  }

  // 2) 執行回測
  console.log("\n開始回測...");
  const result = await backtestEngine.runBacktest(
    {
      strategyKey: "20415_KAMA_MARTIN_V35",
      symbol: SYMBOL,
      timeframe: TF,
      startDate: startMs,
      endDate: endMs,
      initialCapital: 10000,
      config: {},
      exchange: "okx",
    },
    (pct, msg) => process.stdout.write(`\r[${pct}%] ${msg}          `),
  );

  console.log(`\n\n===== 回測結果（數據來源：${dataSource}）=====`);
  console.log(`runId: ${result.runId}`);
  console.log(`摘要: ${result.summary}`);
  const m = result.metrics;
  console.log(`總回報: ${m.totalReturn}% (${m.totalReturnUSDT} USDT)`);
  console.log(`勝率: ${m.winRate}% (${m.winningTrades}勝/${m.losingTrades}負, 共${m.totalTrades}筆)`);
  console.log(`最大回撤: ${m.maxDrawdown}%`);
  console.log(`夏普: ${m.sharpeRatio} | 利潤因子: ${m.profitFactor} | Calmar: ${m.calmarRatio}`);
  console.log(`馬丁觸發: ${m.martinTriggerCount} 次, 最大層數: ${m.maxMartinLayer}`);
  console.log(`權益曲線點數: ${result.equityCurve.length}`);
  console.log(`交易明細: ${result.trades.length} 筆`);

  // 3) 驗證持久化
  const saved = db.getBacktestRun(result.runId);
  console.log(`\nSQLite 持久化驗證: run=${saved ? "OK" : "MISSING"}`);
  const savedTrades = db.getBacktestTrades(result.runId);
  console.log(`交易明細持久化: ${savedTrades.length} 筆`);
  const perf = db.getPerformanceMetrics(result.runId);
  console.log(`績效持久化: ${perf ? "OK" : "MISSING"}`);

  if (result.trades.length > 0) {
    console.log("\n前 3 筆交易:");
    for (const t of result.trades.slice(0, 3)) {
      console.log(
        `  ${new Date(t.exitTime).toISOString()} ${t.side} 入場${t.entryPrice} 出場${t.exitPrice} PnL=${t.pnl} (${t.exitReason}, L${t.martinLayer})`,
      );
    }
  }
  console.log("\n✅ 端到端驗證完成");
}

main().catch((e) => {
  console.error("驗證失敗:", e);
  process.exit(1);
});
