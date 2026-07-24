/**
 * 運行 2025 年至今 BTC-USDT-SWAP 30 分鐘線回測
 * 直接調用回測引擎（繞過 API 認證）
 */
// 先導入 strategyStudio 觸發策略註冊
import { initStrategyStudio } from '../server/services/strategyStudio.ts';
import { backtestEngine } from '../server/services/backtest/backtestEngine.ts';

const config = {
  Initial_Capital: 10000,
  Base_Lot_Size: 30,
  Martin_Step_Pct: 2.0,
  Martin_Multiplier: 1.5,
  Max_Layers: 11,
  Max_Drawdown_Pct: 10,
  Max_Loss_Pct: 5.0,
  Target_TP_Pct: 1.0,
  Callback_Pct: 0.1,
  K_Line_Period: 30,
  KAMA_Fast_Length: 50,
  p2_fastest: 10,
  p3_slowest: 2,
  KAMA_Slow_Length: 50,
  q2_fastest: 10,
  q3_slowest: 6,
  Martin_Layers: JSON.stringify([
    { start: 1, end: 4, multiplier: 1.5 },
    { start: 5, end: 9, multiplier: 1.1 },
    { start: 10, end: 11, multiplier: 1.0 },
  ]),
};

const request = {
  strategyKey: '20415_KAMA_MARTIN_V35',
  symbol: 'BTC-USDT-SWAP',
  timeframe: '30m',
  startDate: new Date('2025-01-01T00:00:00Z').getTime(),
  endDate: Date.now(),
  initialCapital: 10000,
  config,
  commission: 0.0006,
  slippage: 0.0002,
  exchange: 'okx',
};

async function main() {
  await initStrategyStudio();
  console.log('=== BTC-USDT-SWAP 2025 年至今 30 分鐘線回測 ===');
  console.log('策略：V4.0 KAMA+3K 動態馬丁策略（固定金本位）');
  console.log(`參數：Initial_Capital=${config.Initial_Capital}, Base_Lot_Size=${config.Base_Lot_Size} USDT`);
  console.log(`分層：1-4層×1.5, 5-9層×1.1, 10-11層×1.0`);
  console.log(`風控：TP=${config.Target_TP_Pct}%, CB=${config.Callback_Pct}%, MaxLoss=${config.Max_Loss_Pct}%`);
  console.log(`時間：2025-01-01 ~ ${new Date().toISOString().split('T')[0]}`);
  console.log('');

  console.log('開始回測...');
  const result = await backtestEngine.runBacktest(request, (pct, msg) => {
    process.stdout.write(`\r進度: ${pct}% - ${msg}`);
  });
  console.log('\n');

  const m = result.metrics;
  console.log('=== 回測結果 ===');
  console.log('');
  console.log('【績效指標】');
  console.log(`  總回報率：${m.totalReturn}%`);
  console.log(`  年化回報：${m.annualizedReturn}%`);
  console.log(`  勝率：${m.winRate}%`);
  console.log(`  盈虧比：${m.profitFactor}`);
  console.log(`  最大回撤：${m.maxDrawdown}%`);
  console.log(`  夏普比率：${m.sharpeRatio}`);
  console.log(`  Calmar 比率：${m.calmarRatio ?? 'N/A'}`);
  console.log('');
  console.log('【交易統計】');
  console.log(`  總交易筆數：${m.totalTrades}`);
  console.log(`  盈利筆數：${m.winningTrades}`);
  console.log(`  虧損筆數：${m.losingTrades}`);
  console.log(`  平均盈利：${m.avgWin} USDT`);
  console.log(`  平均虧損：${m.avgLoss} USDT`);
  console.log(`  最大單筆盈利：${m.maxWin} USDT`);
  console.log(`  最大單筆虧損：${m.maxLoss} USDT`);
  console.log('');
  console.log('【資金曲線】');
  console.log(`  初始資金：${request.initialCapital} USDT`);
  console.log(`  最終資金：${(request.initialCapital * (1 + m.totalReturn / 100)).toFixed(2)} USDT`);
  console.log(`  淨盈虧：${(request.initialCapital * m.totalReturn / 100).toFixed(2)} USDT`);
  console.log('');

  if (result.trades && result.trades.length > 0) {
    console.log(`【交易明細（共 ${result.trades.length} 筆，顯示前 5 筆和後 5 筆）】`);
    const showTrades = (trades, label) => {
      console.log(`  --- ${label} ---`);
      for (const t of trades) {
        const time = new Date(t.exitTime || t.entryTime).toISOString().replace('T', ' ').slice(0, 16);
        console.log(`  ${time} | ${t.side} | 入${t.entryPrice?.toFixed(1)} → 出${t.exitPrice?.toFixed(1)} | PnL: ${t.pnl?.toFixed(2)} USDT | ${t.exitReason || ''}`);
      }
    };
    showTrades(result.trades.slice(0, 5), '前 5 筆');
    showTrades(result.trades.slice(-5), '後 5 筆');
  }

  console.log('\n=== 回測完成 ===');
}

main().catch(err => {
  console.error('錯誤:', err.message || err);
  process.exit(1);
});
