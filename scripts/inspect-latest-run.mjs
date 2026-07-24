import Database from "better-sqlite3";
const db = new Database("./data/backtest_data.db", { readonly: true });
const runCols = db.prepare("PRAGMA table_info(backtest_runs)").all().map((c) => c.name);
console.log("run cols:", runCols.join(", "));
const run = db.prepare("SELECT * FROM backtest_runs ORDER BY rowid DESC LIMIT 1").get();
console.log("latest run id:", run.run_id ?? run.id, "strategy:", run.strategy_key ?? run.strategyKey, "symbol:", run.symbol);
const tradeCols = db.prepare("PRAGMA table_info(backtest_trades)").all().map((c) => c.name);
console.log("trade cols:", tradeCols.join(", "));
const runKey = run.run_id ?? run.id;
const trades = db.prepare("SELECT * FROM backtest_trades WHERE run_id = ?").all(runKey);
const byReason = {};
let maxLayer = 0;
for (const t of trades) {
  const reason = t.reason ?? t.exit_reason;
  byReason[reason] = (byReason[reason] ?? 0) + 1;
  const layer = t.martin_layer ?? t.layer ?? 0;
  if (layer > maxLayer) maxLayer = layer;
}
console.log("trades:", trades.length, "byReason:", JSON.stringify(byReason), "maxLayerInTrades:", maxLayer);
db.close();
