/**
 * 歷史數據獲取腳本（pasted_content_4.txt 任務 7）
 * 用法：npx tsx scripts/fetch_historical_data.ts [symbol] [timeframe] [days] [exchange]
 * 範例：npx tsx scripts/fetch_historical_data.ts BTC-USDT 1h 365 okx
 */

import { ensureOHLCVData } from "../server/services/backtest/dataFetcher";
import { getBacktestDatabase } from "../server/services/backtest/backtestDatabase";

async function main() {
  const [symbolArg, timeframeArg, daysArg, exchangeArg] = process.argv.slice(2);
  const symbols = symbolArg ? [symbolArg] : ["BTC-USDT", "ETH-USDT", "SOL-USDT"];
  const timeframe = timeframeArg || "1h";
  const days = Number(daysArg) || 365;
  const exchange = (exchangeArg === "bybit" ? "bybit" : "okx") as "okx" | "bybit";

  const endMs = Date.now();
  const startMs = endMs - days * 86400000;

  console.log(`開始抓取歷史數據：${symbols.join(", ")} | ${timeframe} | ${days} 天 | ${exchange}`);

  for (const symbol of symbols) {
    console.log(`\n=== ${symbol} ===`);
    try {
      const rows = await ensureOHLCVData(symbol, timeframe, startMs, endMs, exchange, (p) =>
        process.stdout.write(`\r${p.message}          `),
      );
      console.log(`\n✅ ${symbol}: 共 ${rows.length} 根 K 線已入庫`);
    } catch (e) {
      console.error(`\n❌ ${symbol}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const db = getBacktestDatabase();
  console.log(`\n數據庫可用交易對：${db.getAvailableSymbols().join(", ")}`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
