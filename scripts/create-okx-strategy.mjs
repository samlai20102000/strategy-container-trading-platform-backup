import { getDb } from '../server/db.ts';
import { strategies, apiKeys, users } from '../drizzle/schema.ts';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

const db = await getDb();

if (!db) {
  console.error('❌ 無法連接資料庫');
  process.exit(1);
}

// 查詢現有 OKX API 金鑰
const okxKeysList = await db.select().from(apiKeys).where(eq(apiKeys.exchange, 'okx')).limit(1);

if (!okxKeysList.length) {
  console.error('❌ 未找到 OKX API 金鑰，請先在平台配置');
  process.exit(1);
}

const okxKey = okxKeysList[0];
console.log(`✅ 找到 OKX 金鑰: ${okxKey.label}`);

// 查詢用戶
const usersList = await db.select().from(users).limit(1);
if (!usersList.length) {
  console.error('❌ 未找到用戶');
  process.exit(1);
}

const user = usersList[0];

// 建立 OKX V3.5 策略實例
const webhookSecret = crypto.randomBytes(32).toString('hex');
const webhookUrl = `https://strat-trade-ihzfgkdl.manus.space/api/webhook/60004?secret=${webhookSecret}`;

await db.insert(strategies).values({
  userId: user.id,
  name: 'OKX V3.5 KAMA 馬丁策略',
  description: '使用 OKX 交易所的 V3.5 KAMA+3K 馬丁自動交易策略',
  strategyKey: '20415_KAMA_MARTIN_V35',
  symbol: 'BTCUSDT',
  exchange: 'okx',
  apiKeyId: okxKey.id,
  enabled: true,
  webhookSecret,
  positionSize: '0.001',
  leverage: 1,
  direction: 'both',
  orderType: 'market',
  maxPositionPct: '0',
  stopLossPct: '10',
  takeProfitPct: '1.5',
  maxDailyLoss: '0',
  martinMultiplier: '1.5',
  maxMartinLevel: 5,
  martinSpacingPct: '0',
});

console.log(`\n✅ OKX 策略實例已建立`);
console.log(`\n📋 TradingView Webhook URL:`);
console.log(webhookUrl);
console.log(`\n💾 請保存上述 URL，配置到 TradingView Alert`);

process.exit(0);
