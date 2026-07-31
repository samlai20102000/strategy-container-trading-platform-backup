import mysql from "mysql2/promise";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not available");
}

const expectedStrategyColumns = [
  "executionMode",
  "executionPolicy",
  "executionPolicyVersion",
  "deploymentRevision",
  "activationState",
  "preflightStatus",
  "preflightReport",
  "preflightCheckedAt",
  "capabilitySnapshot",
];

const indexRequirements = {
  mode_transitions: {
    uniqueColumns: ["transitionKey"],
    namedIndexes: ["mode_transitions_deployment_created_idx", "mode_transitions_user_status_idx"],
  },
  position_legs: {
    uniqueColumns: ["legId"],
    namedIndexes: ["position_legs_strategy_status_idx", "position_legs_account_symbol_side_idx"],
  },
  execution_decisions: {
    uniqueColumns: ["decisionId"],
    namedIndexes: ["execution_decision_strategy_created_idx"],
  },
  execution_order_intents: {
    uniqueColumns: ["intentId", "idempotencyKey"],
    namedIndexes: [],
  },
};

const connection = await mysql.createConnection(databaseUrl);

try {
  const [strategyColumns] = await connection.query("SHOW COLUMNS FROM strategies");
  const strategyColumnNames = new Set(strategyColumns.map(row => row.Field));
  const missingStrategyColumns = expectedStrategyColumns.filter(name => !strategyColumnNames.has(name));

  const missingIndexes = {};
  for (const [table, requirement] of Object.entries(indexRequirements)) {
    const [rows] = await connection.query(`SHOW INDEX FROM \`${table}\``);
    const indexNames = new Set(rows.map(row => row.Key_name));
    const missingNamed = requirement.namedIndexes.filter(name => !indexNames.has(name));
    const missingUniqueColumns = requirement.uniqueColumns.filter(
      column => !rows.some(row => row.Column_name === column && Number(row.Non_unique) === 0),
    );
    const missing = [
      ...missingNamed.map(name => `index:${name}`),
      ...missingUniqueColumns.map(column => `unique:${column}`),
    ];
    if (missing.length > 0) missingIndexes[table] = missing;
  }

  const [distributionRows] = await connection.query(`
    SELECT
      COUNT(*) AS deploymentCount,
      SUM(CASE WHEN activationState <> 'LEGACY' THEN 1 ELSE 0 END) AS canonicalCount,
      SUM(CASE WHEN activationState = 'ACTIVE' THEN 1 ELSE 0 END) AS activeCount,
      SUM(CASE WHEN activationState IN ('BLOCKED', 'DRAINING', 'PREFLIGHT_FAILED') THEN 1 ELSE 0 END) AS actionRequiredCount
    FROM strategies
  `);

  const [modeStateRows] = await connection.query(`
    SELECT executionMode, activationState, COUNT(*) AS deploymentCount
    FROM strategies
    GROUP BY executionMode, activationState
    ORDER BY executionMode, activationState
  `);

  const summary = {
    schemaStatus:
      missingStrategyColumns.length === 0 && Object.keys(missingIndexes).length === 0
        ? "PASS"
        : "FAIL",
    missingStrategyColumns,
    missingIndexes,
    deploymentDistribution: distributionRows[0],
    modeStateDistribution: modeStateRows,
  };

  console.log(JSON.stringify(summary, null, 2));

  process.exitCode = summary.schemaStatus === "PASS" ? 0 : 1;
} finally {
  await connection.end();
}

process.exit(process.exitCode ?? 0);
