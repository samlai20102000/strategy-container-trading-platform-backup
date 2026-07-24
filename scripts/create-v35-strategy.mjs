import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import crypto from "node:crypto";

const db = drizzle(process.env.DATABASE_URL);

const webhookSecret = crypto.randomBytes(24).toString("hex");

// V3.5 完整參數（依 Pasted_content_17.txt 規格）
const martinState = {
  version: "v35",
  martinLayer: 0,
  avgEntryPrice: 0,
  totalQty: 0,
  direction: null,
  cooldownUntil: 0,
  trailingActive: false,
  trailingPeak: 0,
  config: {
    kamaPeriod: 10,
    kamaFast: 2,
    kamaSlow: 30,
    kLinePeriodMinutes: 30,
    baseLot: 0.001,
    martinMultiplier: 1.5,
    maxMartinLayer: 5,
    martinStepPct: 1.5,
    targetTpPct: 1.0,
    callbackPct: 0.2,
    maxDrawdownPct: 10,
    lastLayerDeviationPct: 3,
  },
};

const result = await db.execute(sql`
  INSERT INTO strategies
    (userId, name, description, apiKeyId, exchange, symbol, positionSize, leverage,
     direction, orderType, enabled, webhookSecret, maxPositionPct, stopLossPct,
     takeProfitPct, maxDailyLoss, martinMultiplier, maxMartinLevel, martinSpacingPct,
     martinState, strategyKey)
  VALUES
    (1, 'V3.5 KAMA 馬丁 BTCUSDT', '趨勢雙核心（KAMA + 3K 形態破位）動態馬丁策略 V3.5：五層信號驗證、馬丁加倉（1.5x / 5層）、移動止盈（1%激活/0.2%回撤）、極限防爆倉止損（浮虧10% 或 偏離3%）',
     30002, 'bybit', 'BTCUSDT', 0.001, 1,
     'both', 'market', 1, ${webhookSecret}, 0, 0,
     0, 0, 1.50, 5, 1.50,
     ${JSON.stringify(martinState)}, '20415_KAMA_MARTIN_V35')
`);

const insertId = result[0].insertId;
console.log("CREATED_STRATEGY_ID:", insertId);
console.log("WEBHOOK_SECRET:", webhookSecret);
console.log("WEBHOOK_URL:", `https://strat-trade-ihzfgkdl.manus.space/api/webhook/${insertId}?secret=${webhookSecret}`);
process.exit(0);
