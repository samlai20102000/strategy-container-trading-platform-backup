import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDefaultExecutionPolicy } from "../../shared/executionModes";
import { assessBacktestRiskIntegrity } from "../../server/services/backtest/backtestRiskIntegrity";

const artifactDir = resolve("artifacts/backtest-100dd");
const equityCurve = JSON.parse(readFileSync(
  resolve(artifactDir, "job_1785770356467_b7fe7008_equity_curve.json"),
  "utf8",
));
const trades = JSON.parse(readFileSync(
  resolve(artifactDir, "job_1785770356467_b7fe7008_trades.json"),
  "utf8",
));

const assessment = assessBacktestRiskIntegrity({
  runId: "bt_KAMARAINBOWMARTINV1_1785770363974_tx4",
  strategyKey: "KAMA_RAINBOW_MARTIN_V1",
  initialCapital: 10_000,
  leverage: 1,
  executionPolicy: createDefaultExecutionPolicy("SINGLE_EXCLUSIVE"),
  trades,
  equityCurve,
  hasRuntimeRiskEvidence: false,
});

const output = {
  source: {
    jobId: "job_1785770356467_b7fe7008",
    runId: "bt_KAMARAINBOWMARTINV1_1785770363974_tx4",
    equityPointCount: equityCurve.length,
    tradeCount: trades.length,
  },
  assessment,
};

writeFileSync(
  resolve(artifactDir, "persisted_job_risk_integrity_assessment.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output, null, 2));
