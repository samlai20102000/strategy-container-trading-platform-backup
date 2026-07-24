/**
 * 回測數據層（pasted_content_4.txt 任務 2）
 * better-sqlite3 + WAL 模式，儲存 K 線快取與回測結果
 *
 * 架構說明：SQLite 作為本地 K 線快取（可隨時從交易所重新抓取），
 * 適用於沙盒開發與回測執行；部署環境檔案系統非持久，冷啟動後快取自動重建。
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export interface OHLCVRow {
  symbol: string;
  timeframe: string;
  timestamp: number; // 毫秒
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestRunRow {
  run_id: string;
  strategy_key: string;
  symbol: string;
  timeframe: string;
  start_date: number;
  end_date: number;
  initial_capital: number;
  config: string;
  status: string;
  created_at: number;
}

export class BacktestDatabase {
  private db: Database.Database;

  constructor(dbPath: string = "./data/backtest_data.db") {
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = 10000");

    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ohlcv (
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        PRIMARY KEY (symbol, timeframe, timestamp)
      );

      CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_timeframe
        ON ohlcv (symbol, timeframe, timestamp);

      CREATE TABLE IF NOT EXISTS backtest_runs (
        run_id TEXT PRIMARY KEY,
        strategy_key TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        start_date INTEGER NOT NULL,
        end_date INTEGER NOT NULL,
        initial_capital REAL NOT NULL,
        config TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runs_created_at
        ON backtest_runs (created_at DESC);

      CREATE TABLE IF NOT EXISTS backtest_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        entry_time INTEGER NOT NULL,
        exit_time INTEGER NOT NULL,
        side TEXT NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        size REAL NOT NULL,
        pnl REAL NOT NULL,
        pnl_pct REAL NOT NULL,
        exit_reason TEXT NOT NULL,
        martin_layer INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_trades_run_id
        ON backtest_trades (run_id);

      CREATE TABLE IF NOT EXISTS performance_metrics (
        run_id TEXT PRIMARY KEY,
        metrics TEXT NOT NULL,
        equity_curve TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /** 批次插入 K 線（transaction 高速寫入，重複主鍵自動覆蓋） */
  insertOHLCV(rows: OHLCVRow[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ohlcv (symbol, timeframe, timestamp, open, high, low, close, volume)
      VALUES (@symbol, @timeframe, @timestamp, @open, @high, @low, @close, @volume)
    `);
    const insertMany = this.db.transaction((items: OHLCVRow[]) => {
      for (const item of items) stmt.run(item);
      return items.length;
    });
    return insertMany(rows);
  }

  /** 讀取 K 線（按時間昇冪） */
  getOHLCV(symbol: string, timeframe: string, startMs: number, endMs: number): OHLCVRow[] {
    return this.db
      .prepare(
        `SELECT symbol, timeframe, timestamp, open, high, low, close, volume
         FROM ohlcv
         WHERE symbol = ? AND timeframe = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
      )
      .all(symbol, timeframe, startMs, endMs) as OHLCVRow[];
  }

  /** K 線筆數 */
  countOHLCV(symbol: string, timeframe: string, startMs: number, endMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM ohlcv
         WHERE symbol = ? AND timeframe = ? AND timestamp >= ? AND timestamp <= ?`,
      )
      .get(symbol, timeframe, startMs, endMs) as { cnt: number };
    return row.cnt;
  }

  getAvailableSymbols(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT symbol FROM ohlcv`).all() as { symbol: string }[];
    return rows.map((r) => r.symbol);
  }

  getAvailableTimeframes(symbol: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT timeframe FROM ohlcv WHERE symbol = ?`)
      .all(symbol) as { timeframe: string }[];
    return rows.map((r) => r.timeframe);
  }

  /** 保存回測結果（run + trades） */
  saveBacktestResult(
    run: BacktestRunRow,
    trades: Array<{
      entryTime: number;
      exitTime: number;
      side: string;
      entryPrice: number;
      exitPrice: number;
      size: number;
      pnl: number;
      pnlPct: number;
      exitReason: string;
      martinLayer: number;
    }>,
  ): void {
    const insertRun = this.db.prepare(`
      INSERT OR REPLACE INTO backtest_runs
        (run_id, strategy_key, symbol, timeframe, start_date, end_date, initial_capital, config, status, created_at)
      VALUES (@run_id, @strategy_key, @symbol, @timeframe, @start_date, @end_date, @initial_capital, @config, @status, @created_at)
    `);
    const insertTrade = this.db.prepare(`
      INSERT INTO backtest_trades
        (run_id, entry_time, exit_time, side, entry_price, exit_price, size, pnl, pnl_pct, exit_reason, martin_layer)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const txn = this.db.transaction(() => {
      insertRun.run(run);
      this.db.prepare(`DELETE FROM backtest_trades WHERE run_id = ?`).run(run.run_id);
      for (const t of trades) {
        insertTrade.run(
          run.run_id,
          t.entryTime,
          t.exitTime,
          t.side,
          t.entryPrice,
          t.exitPrice,
          t.size,
          t.pnl,
          t.pnlPct,
          t.exitReason,
          t.martinLayer,
        );
      }
    });
    txn();
  }

  /** 保存績效指標與權益曲線 */
  savePerformanceMetrics(runId: string, metrics: unknown, equityCurve: unknown): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO performance_metrics (run_id, metrics, equity_curve, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(runId, JSON.stringify(metrics), JSON.stringify(equityCurve), Date.now());
  }

  getBacktestRuns(limit: number = 50): BacktestRunRow[] {
    return this.db
      .prepare(`SELECT * FROM backtest_runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as BacktestRunRow[];
  }

  getBacktestRun(runId: string): BacktestRunRow | undefined {
    return this.db.prepare(`SELECT * FROM backtest_runs WHERE run_id = ?`).get(runId) as
      | BacktestRunRow
      | undefined;
  }

  getBacktestTrades(runId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY entry_time ASC`)
      .all(runId) as Array<Record<string, unknown>>;
  }

  getPerformanceMetrics(runId: string): { metrics: unknown; equityCurve: unknown } | null {
    const row = this.db
      .prepare(`SELECT metrics, equity_curve FROM performance_metrics WHERE run_id = ?`)
      .get(runId) as { metrics: string; equity_curve: string } | undefined;
    if (!row) return null;
    return { metrics: JSON.parse(row.metrics), equityCurve: JSON.parse(row.equity_curve) };
  }

  close(): void {
    this.db.close();
  }

  getDB(): Database.Database {
    return this.db;
  }
}

/** 全域單例（避免多個連線競爭 WAL 檔案） */
let singleton: BacktestDatabase | null = null;

export function getBacktestDatabase(dbPath?: string): BacktestDatabase {
  if (!singleton) {
    singleton = new BacktestDatabase(dbPath ?? "./data/backtest_data.db");
  }
  return singleton;
}
