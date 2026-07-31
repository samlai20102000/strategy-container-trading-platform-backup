-- Phase 6：保存通過 BacktestEngine finalize Gate 的完整版本化 execution context。
-- 僅新增 nullable JSON 欄位，不改寫既有回測歷史。
ALTER TABLE `backtest_jobs`
  ADD COLUMN `executionContext` JSON NULL AFTER `executionPolicyVersion`;
