#!/usr/bin/env node
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'trading_db';

const STRATEGY_ID = 210008; // KAMA 3K 策略 ID

async function main() {
  const connection = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });

  try {
    console.log('正在導出 KAMA 3K 策略數據...\n');

    // 1. 獲取策略基本信息
    const [strategies] = await connection.query(
      'SELECT * FROM strategies WHERE id = ?',
      [STRATEGY_ID]
    );
    const strategy = strategies[0];
    if (!strategy) {
      console.error(`策略 ${STRATEGY_ID} 不存在`);
      return;
    }

    console.log('✓ 策略信息：');
    console.log(`  名稱: ${strategy.name}`);
    console.log(`  交易對: ${strategy.symbol}`);
    console.log(`  倉位模式: ${strategy.positionMode}`);
    console.log(`  倉位大小: ${strategy.positionSize}`);
    console.log(`  狀態: ${strategy.enabled ? '啟用' : '禁用'}`);
    console.log();

    // 2. 獲取所有交易記錄
    const [trades] = await connection.query(
      `SELECT * FROM trades 
       WHERE strategy_id = ? 
       ORDER BY entry_time ASC`,
      [STRATEGY_ID]
    );
    console.log(`✓ 交易記錄: ${trades.length} 筆`);

    // 3. 獲取所有信號
    const [signals] = await connection.query(
      `SELECT * FROM signals 
       WHERE strategy_id = ? 
       ORDER BY timestamp ASC`,
      [STRATEGY_ID]
    );
    console.log(`✓ 信號記錄: ${signals.length} 筆`);

    // 4. 獲取馬丁狀態歷史
    const [martinStates] = await connection.query(
      `SELECT * FROM martin_states 
       WHERE strategy_id = ? 
       ORDER BY updated_at ASC`,
      [STRATEGY_ID]
    );
    console.log(`✓ 馬丁狀態: ${martinStates.length} 條記錄`);

    // 5. 獲取 Heartbeat 日誌
    const [heartbeatLogs] = await connection.query(
      `SELECT * FROM heartbeat_logs 
       WHERE strategy_id = ? 
       ORDER BY timestamp ASC`,
      [STRATEGY_ID]
    );
    console.log(`✓ Heartbeat 日誌: ${heartbeatLogs.length} 條記錄`);

    // 6. 計算統計信息
    const totalTrades = trades.length;
    const winTrades = trades.filter(t => parseFloat(t.realized_pnl) > 0).length;
    const lossTrades = trades.filter(t => parseFloat(t.realized_pnl) < 0).length;
    const totalRealizedPnl = trades.reduce((sum, t) => sum + parseFloat(t.realized_pnl || 0), 0);
    const avgRealizedPnl = totalTrades > 0 ? totalRealizedPnl / totalTrades : 0;
    const winRate = totalTrades > 0 ? (winTrades / totalTrades * 100).toFixed(2) : 0;

    console.log();
    console.log('📊 統計信息：');
    console.log(`  總交易數: ${totalTrades}`);
    console.log(`  勝利: ${winTrades} | 虧損: ${lossTrades}`);
    console.log(`  勝率: ${winRate}%`);
    console.log(`  總實現盈虧: ${totalRealizedPnl.toFixed(2)} USDT`);
    console.log(`  平均每筆: ${avgRealizedPnl.toFixed(2)} USDT`);
    console.log();

    // 7. 導出為 JSON
    const exportData = {
      strategy: {
        id: strategy.id,
        name: strategy.name,
        symbol: strategy.symbol,
        positionMode: strategy.positionMode,
        positionSize: strategy.positionSize,
        enabled: strategy.enabled,
        createdAt: strategy.created_at,
      },
      statistics: {
        totalTrades,
        winTrades,
        lossTrades,
        winRate: parseFloat(winRate),
        totalRealizedPnl: parseFloat(totalRealizedPnl.toFixed(2)),
        avgRealizedPnl: parseFloat(avgRealizedPnl.toFixed(2)),
      },
      trades: trades.map(t => ({
        id: t.id,
        strategyId: t.strategy_id,
        symbol: t.symbol,
        side: t.side,
        entryTime: t.entry_time,
        entryPrice: parseFloat(t.entry_price),
        exitTime: t.exit_time,
        exitPrice: parseFloat(t.exit_price),
        quantity: parseFloat(t.quantity),
        realizedPnl: parseFloat(t.realized_pnl),
        unrealizedPnl: parseFloat(t.unrealized_pnl),
        martinLevel: t.martin_level,
        status: t.status,
      })),
      signals: signals.map(s => ({
        id: s.id,
        strategyId: s.strategy_id,
        timestamp: s.timestamp,
        symbol: s.symbol,
        action: s.action,
        price: parseFloat(s.price),
        confidence: parseFloat(s.confidence),
        source: s.source,
        status: s.status,
        message: s.message,
      })),
      martinStates: martinStates.map(m => ({
        id: m.id,
        strategyId: m.strategy_id,
        currentLot: parseFloat(m.current_lot),
        lossCount: m.loss_count,
        maxLayers: m.max_layers,
        updatedAt: m.updated_at,
      })),
      heartbeatLogs: heartbeatLogs.map(h => ({
        id: h.id,
        strategyId: h.strategy_id,
        timestamp: h.timestamp,
        result: h.result,
        signal: h.signal,
        detail: h.detail,
        errorMessage: h.error_message,
      })),
    };

    // 8. 寫入 JSON 文件
    const jsonPath = path.join(__dirname, `kama_3k_export_${Date.now()}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(exportData, null, 2), 'utf-8');
    console.log(`✓ JSON 導出: ${jsonPath}`);

    // 9. 導出為 CSV（交易記錄）
    const csvHeader = [
      '交易ID',
      '交易對',
      '方向',
      '入場時間',
      '入場價',
      '出場時間',
      '出場價',
      '數量',
      '實現盈虧',
      '未實現盈虧',
      '馬丁層級',
      '狀態',
    ].join(',');
    const csvRows = trades.map(t =>
      [
        t.id,
        t.symbol,
        t.side,
        t.entry_time,
        t.entry_price,
        t.exit_time || '',
        t.exit_price || '',
        t.quantity,
        t.realized_pnl,
        t.unrealized_pnl,
        t.martin_level || '',
        t.status,
      ].join(',')
    );
    const csvContent = [csvHeader, ...csvRows].join('\n');
    const csvPath = path.join(__dirname, `kama_3k_trades_${Date.now()}.csv`);
    fs.writeFileSync(csvPath, csvContent, 'utf-8');
    console.log(`✓ CSV 導出: ${csvPath}`);

    // 10. 導出為 CSV（信號記錄）
    const signalCsvHeader = [
      '信號ID',
      '時間戳',
      '交易對',
      '動作',
      '價格',
      '信心度',
      '來源',
      '狀態',
      '訊息',
    ].join(',');
    const signalCsvRows = signals.map(s =>
      [
        s.id,
        s.timestamp,
        s.symbol,
        s.action,
        s.price,
        s.confidence,
        s.source,
        s.status,
        `"${(s.message || '').replace(/"/g, '""')}"`,
      ].join(',')
    );
    const signalCsvContent = [signalCsvHeader, ...signalCsvRows].join('\n');
    const signalCsvPath = path.join(__dirname, `kama_3k_signals_${Date.now()}.csv`);
    fs.writeFileSync(signalCsvPath, signalCsvContent, 'utf-8');
    console.log(`✓ 信號 CSV 導出: ${signalCsvPath}`);

    console.log('\n✅ 導出完成！');
    console.log(`\n文件位置：${__dirname}`);
  } catch (error) {
    console.error('導出失敗:', error.message);
  } finally {
    await connection.end();
  }
}

main();
