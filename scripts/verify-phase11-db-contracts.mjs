import assert from "node:assert/strict";
import mysql from "mysql2/promise";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not available");

const connection = await mysql.createConnection(databaseUrl);

try {
  await connection.query(`
    CREATE TEMPORARY TABLE phase11_deployments (
      id INT PRIMARY KEY,
      userId INT NOT NULL,
      revision INT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      activationState VARCHAR(32) NOT NULL,
      executionMode VARCHAR(32) NOT NULL,
      preflightStatus VARCHAR(16) NOT NULL DEFAULT 'NOT_RUN',
      preflightReport JSON NULL,
      preflightHash VARCHAR(64) NULL
    )
  `);
  await connection.query(`
    CREATE TEMPORARY TABLE phase11_transitions (
      transitionKey VARCHAR(128) PRIMARY KEY,
      deploymentId INT NOT NULL,
      expectedRevision INT NOT NULL,
      resultingRevision INT NULL,
      status VARCHAR(16) NOT NULL
    )
  `);
  await connection.query(`
    CREATE TEMPORARY TABLE phase11_exposure_facts (
      deploymentId INT NOT NULL,
      factType VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL
    )
  `);

  await connection.beginTransaction();
  await connection.query(
    `INSERT INTO phase11_deployments
      (id, userId, revision, enabled, activationState, executionMode)
     VALUES
      (1, 101, 1, FALSE, 'DRAFT', 'MULTI_POSITION'),
      (2, 202, 1, FALSE, 'DRAFT', 'HEDGE_GUARDED'),
      (3, 101, 1, TRUE, 'LEGACY', 'SINGLE_EXCLUSIVE')`,
  );

  const [ownerRows] = await connection.query(
    "SELECT id FROM phase11_deployments WHERE userId = ? ORDER BY id",
    [101],
  );
  assert.deepEqual(ownerRows.map(row => row.id), [1, 3]);

  const preflightReport = {
    status: "PASSED",
    checkedRevision: 1,
    blockerCodes: [],
    expiresAtMs: Date.now() + 60_000,
  };
  const [firstUpdate] = await connection.query(
    `UPDATE phase11_deployments
       SET preflightStatus = 'PASSED', preflightReport = ?, preflightHash = ?,
           activationState = 'READY_DISABLED', revision = revision + 1
     WHERE id = ? AND userId = ? AND revision = ?`,
    [JSON.stringify(preflightReport), "a".repeat(64), 1, 101, 1],
  );
  assert.equal(firstUpdate.affectedRows, 1);

  const [staleUpdate] = await connection.query(
    `UPDATE phase11_deployments
       SET activationState = 'ACTIVE', enabled = TRUE, revision = revision + 1
     WHERE id = ? AND userId = ? AND revision = ?`,
    [1, 101, 1],
  );
  assert.equal(staleUpdate.affectedRows, 0);

  const [persistedRows] = await connection.query(
    "SELECT revision, enabled, activationState, preflightStatus, preflightReport, preflightHash FROM phase11_deployments WHERE id = ? AND userId = ?",
    [1, 101],
  );
  assert.equal(persistedRows[0].revision, 2);
  assert.equal(Boolean(persistedRows[0].enabled), false);
  assert.equal(persistedRows[0].activationState, "READY_DISABLED");
  assert.equal(persistedRows[0].preflightStatus, "PASSED");
  assert.equal(persistedRows[0].preflightHash, "a".repeat(64));
  const persistedReport =
    typeof persistedRows[0].preflightReport === "string"
      ? JSON.parse(persistedRows[0].preflightReport)
      : persistedRows[0].preflightReport;
  assert.equal(persistedReport.checkedRevision, 1);

  await connection.query(
    `INSERT INTO phase11_transitions
      (transitionKey, deploymentId, expectedRevision, resultingRevision, status)
     VALUES (?, ?, ?, ?, 'APPLIED')`,
    ["phase11:transition:1", 1, 1, 2],
  );
  let duplicateRejected = false;
  try {
    await connection.query(
      `INSERT INTO phase11_transitions
        (transitionKey, deploymentId, expectedRevision, resultingRevision, status)
       VALUES (?, ?, ?, ?, 'APPLIED')`,
      ["phase11:transition:1", 1, 2, 3],
    );
  } catch (error) {
    duplicateRejected = error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;
  }
  assert.equal(duplicateRejected, true);

  await connection.query(
    `INSERT INTO phase11_exposure_facts (deploymentId, factType, status)
     VALUES
      (1, 'POSITION_LEG', 'OPEN'),
      (1, 'ORDER_INTENT', 'SUBMITTING'),
      (1, 'HEDGE_RELATIONSHIP', 'ACTIVE')`,
  );
  const [blockedFacts] = await connection.query(
    `SELECT COUNT(*) AS blockerCount
       FROM phase11_exposure_facts
      WHERE deploymentId = ?
        AND status IN ('PENDING', 'OPEN', 'REDUCING', 'CREATED', 'SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'ARMING', 'ACTIVE', 'UNWINDING')`,
    [1],
  );
  assert.equal(Number(blockedFacts[0].blockerCount), 3);

  await connection.query("DELETE FROM phase11_exposure_facts WHERE deploymentId = ?", [1]);
  const [flatFacts] = await connection.query(
    "SELECT COUNT(*) AS blockerCount FROM phase11_exposure_facts WHERE deploymentId = ?",
    [1],
  );
  assert.equal(Number(flatFacts[0].blockerCount), 0);

  const [legacyMigration] = await connection.query(
    `UPDATE phase11_deployments
       SET activationState = 'DISABLED', enabled = FALSE, revision = revision + 1
     WHERE id = ? AND userId = ? AND activationState = 'LEGACY'`,
    [3, 101],
  );
  assert.equal(legacyMigration.affectedRows, 1);
  const [migratedRows] = await connection.query(
    "SELECT enabled, activationState, revision FROM phase11_deployments WHERE id = ? AND userId = ?",
    [3, 101],
  );
  assert.equal(Boolean(migratedRows[0].enabled), false);
  assert.equal(migratedRows[0].activationState, "DISABLED");
  assert.equal(migratedRows[0].revision, 2);

  await connection.rollback();

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        checks: {
          ownerIsolation: true,
          optimisticRevisionLock: true,
          staleRevisionRejected: true,
          preflightJsonPersistence: true,
          idempotencyCollisionRejected: true,
          modeSwitchFlatGateFacts: true,
          legacyMigrationRemainsDisabled: true,
        },
        persistentRowsWritten: 0,
      },
      null,
      2,
    ),
  );
} catch (error) {
  try {
    await connection.rollback();
  } catch {
    // Best effort only; temporary tables disappear with the session.
  }
  throw error;
} finally {
  await connection.end();
}

process.exit(0);
