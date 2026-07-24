import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

const db = drizzle(process.env.DATABASE_URL);
const keys = await db.execute(sql`SELECT id, userId, label, exchange, isTestnet FROM api_keys`);
console.log("API_KEYS:", JSON.stringify(keys[0]));
const strats = await db.execute(sql`SELECT id, name, strategyKey, symbol, enabled FROM strategies`);
console.log("STRATEGIES:", JSON.stringify(strats[0]));
process.exit(0);
