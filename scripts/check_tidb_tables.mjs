import mysql from "mysql2/promise";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("❌ DATABASE_URL 未設定");
  process.exit(1);
}

const pool = await mysql.createPool(dbUrl);
const conn = await pool.getConnection();

console.log("🔍 檢查 TiDB 中的表...\n");

const [tables] = await conn.execute(
  "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME"
);

console.log(`✅ 共找到 ${tables.length} 個表：\n`);
tables.forEach((t, i) => {
  console.log(`  ${i + 1}. ${t.TABLE_NAME}`);
});

// 檢查每個表的列數
console.log("\n📊 表結構詳情：\n");
for (const table of tables) {
  const [columns] = await conn.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [table.TABLE_NAME]
  );
  console.log(`${table.TABLE_NAME} (${columns.length} 列):`);
  columns.slice(0, 5).forEach((col) => {
    console.log(`    - ${col.COLUMN_NAME}: ${col.COLUMN_TYPE}`);
  });
  if (columns.length > 5) {
    console.log(`    ... 及其他 ${columns.length - 5} 列`);
  }
  console.log();
}

// 檢查數據量
console.log("📈 數據量統計：\n");
for (const table of tables) {
  const [result] = await conn.execute(`SELECT COUNT(*) as cnt FROM ${table.TABLE_NAME}`);
  console.log(`  ${table.TABLE_NAME}: ${result[0].cnt} 筆記錄`);
}

await conn.release();
await pool.end();

console.log("\n✅ TiDB 檢查完成");
process.exit(0);
