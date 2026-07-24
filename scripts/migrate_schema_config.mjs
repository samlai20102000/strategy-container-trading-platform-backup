/**
 * V4.2 數據遷移腳本：將內建策略的 schemaConfig 寫入 strategyDefinitions 表
 * 用途：讓前端動態渲染參數表單時有結構定義可用
 * 
 * 運行方式：npx tsx scripts/migrate_schema_config.mjs
 */

import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { eq } from "drizzle-orm";
import { strategyDefinitions } from "../drizzle/schema.ts";

// V4.0 KAMA+3K 策略的參數結構定義
const KAMA_V35_SCHEMA_CONFIG = {
  groups: [
    {
      name: "資金管理",
      fields: ["Initial_Capital", "Base_Lot_Size", "First_Order_Pct", "Max_Loss_Pct"],
    },
    {
      name: "KAMA 指標",
      fields: ["KAMA_Fast_Length", "p2_fastest", "p3_slowest", "KAMA_Slow_Length", "q2_fastest", "q3_slowest"],
    },
    {
      name: "馬丁格爾",
      fields: ["Martin_Multiplier", "Max_Layers", "Martin_Step_Pct", "Martin_Layers"],
    },
    {
      name: "止盈止損",
      fields: ["Target_TP_Pct", "Callback_Pct", "K_Line_Period"],
    },
  ],
  fields: {
    Initial_Capital: {
      type: "number",
      label: "初始資金 (USDT)",
      default: 10000,
      min: 100,
      max: 10000000,
      step: 100,
      description: "策略初始資金，用於計算百分比倉位和風控",
    },
    Base_Lot_Size: {
      type: "number",
      label: "首單金額 (USDT)",
      default: 30,
      min: 1,
      max: 100000,
      step: 1,
      description: "首單固定金額（USDT 金本位模式）",
    },
    First_Order_Pct: {
      type: "number",
      label: "首單百分比 (%)",
      default: 0.3,
      min: 0.01,
      max: 10,
      step: 0.01,
      description: "首單佔初始資金的百分比（回退用）",
    },
    Max_Loss_Pct: {
      type: "number",
      label: "硬止損 (%)",
      default: 5.0,
      min: 0.5,
      max: 50,
      step: 0.5,
      description: "當倉位總虧損達到初始資金的此百分比時全平",
    },
    Martin_Multiplier: {
      type: "number",
      label: "馬丁倍率",
      default: 1.5,
      min: 1.0,
      max: 5.0,
      step: 0.1,
      description: "全局馬丁加倉倍率（有分層時被分層覆蓋）",
    },
    Max_Layers: {
      type: "number",
      label: "最大層數",
      default: 11,
      min: 1,
      max: 20,
      step: 1,
      description: "馬丁格爾最大加倉層數",
    },
    Max_Drawdown_Pct: {
      type: "number",
      label: "最大回撤 (%)",
      default: 10,
      min: 1,
      max: 50,
      step: 1,
      description: "V3.x 兼容：最大回撤百分比",
    },
    KAMA_Fast_Length: {
      type: "number",
      label: "KAMA 快線長度",
      default: 50,
      min: 5,
      max: 200,
      step: 1,
      description: "快速 KAMA 指標的計算週期",
    },
    p2_fastest: {
      type: "number",
      label: "快線最快常數",
      default: 10,
      min: 2,
      max: 50,
      step: 1,
      description: "KAMA 快線的最快平滑常數",
    },
    p3_slowest: {
      type: "number",
      label: "快線最慢常數",
      default: 2,
      min: 1,
      max: 30,
      step: 1,
      description: "KAMA 快線的最慢平滑常數",
    },
    KAMA_Slow_Length: {
      type: "number",
      label: "KAMA 慢線長度",
      default: 50,
      min: 5,
      max: 200,
      step: 1,
      description: "慢速 KAMA 指標的計算週期",
    },
    q2_fastest: {
      type: "number",
      label: "慢線最快常數",
      default: 10,
      min: 2,
      max: 50,
      step: 1,
      description: "KAMA 慢線的最快平滑常數",
    },
    q3_slowest: {
      type: "number",
      label: "慢線最慢常數",
      default: 6,
      min: 1,
      max: 30,
      step: 1,
      description: "KAMA 慢線的最慢平滑常數",
    },
    Martin_Step_Pct: {
      type: "number",
      label: "全局加倉間距 (%)",
      default: 2.0,
      min: 0.1,
      max: 20,
      step: 0.1,
      description: "每層加倉的價格偏離百分比",
    },
    Martin_Layers: {
      type: "json",
      label: "階梯式馬丁分層",
      default: [
        { start: 1, end: 4, multiplier: 1.5 },
        { start: 5, end: 9, multiplier: 1.1 },
        { start: 10, end: 11, multiplier: 1.0 },
      ],
      description: "分層乘數設定（JSON 格式），可含 stepPct 自定義間距",
    },
    Target_TP_Pct: {
      type: "number",
      label: "止盈 (%)",
      default: 1.0,
      min: 0.1,
      max: 20,
      step: 0.1,
      description: "均價上漲此百分比時激活移動止盈",
    },
    Callback_Pct: {
      type: "number",
      label: "回撤出場 (%)",
      default: 0.1,
      min: 0.01,
      max: 5,
      step: 0.01,
      description: "從最高點回撤此百分比時觸發平倉",
    },
    K_Line_Period: {
      type: "number",
      label: "K 線週期 (分鐘)",
      default: 15,
      min: 1,
      max: 1440,
      step: 1,
      description: "策略使用的 K 線時間框架",
    },
  },
};

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("❌ DATABASE_URL 未設定");
    process.exit(1);
  }

  const connection = await mysql.createConnection(dbUrl);
  const db = drizzle(connection);

  console.log("🔄 開始遷移 schemaConfig...");

  // 查找內建策略
  const builtIns = await db
    .select()
    .from(strategyDefinitions)
    .where(eq(strategyDefinitions.isBuiltIn, true));

  console.log(`  找到 ${builtIns.length} 個內建策略`);

  for (const def of builtIns) {
    if (def.key.includes("KAMA") || def.key.includes("20415")) {
      await db
        .update(strategyDefinitions)
        .set({ schemaConfig: KAMA_V35_SCHEMA_CONFIG })
        .where(eq(strategyDefinitions.id, def.id));
      console.log(`  ✅ ${def.key} → schemaConfig 已寫入`);
    }
  }

  // 如果沒有找到內建策略（可能還未初始化），直接更新所有含 KAMA 的
  if (builtIns.length === 0) {
    console.log("  ⚠️ 未找到內建策略記錄，嘗試按 key 匹配...");
    const allDefs = await db.select().from(strategyDefinitions);
    for (const def of allDefs) {
      if (def.key.includes("KAMA") || def.key.includes("20415")) {
        await db
          .update(strategyDefinitions)
          .set({ schemaConfig: KAMA_V35_SCHEMA_CONFIG })
          .where(eq(strategyDefinitions.id, def.id));
        console.log(`  ✅ ${def.key} → schemaConfig 已寫入`);
      }
    }
  }

  console.log("✅ 遷移完成");
  await connection.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ 遷移失敗:", e);
  process.exit(1);
});
