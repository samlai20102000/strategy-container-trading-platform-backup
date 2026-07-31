ALTER TABLE `parameter_snapshots`
  ADD COLUMN `artifactContractVersion` varchar(64) NULL AFTER `strategyVersion`;

ALTER TABLE `parameter_snapshots`
  ADD COLUMN `artifactHash` varchar(64) NULL AFTER `artifactScope`;

ALTER TABLE `parameter_snapshots`
  ADD COLUMN `strategyLogicHash` varchar(64) NULL AFTER `artifactHash`;

ALTER TABLE `parameter_snapshots`
  ADD COLUMN `executionPolicyHash` varchar(64) NULL AFTER `strategyLogicHash`;

ALTER TABLE `parameter_snapshots`
  ADD COLUMN `capabilityManifest` json NULL AFTER `executionPolicyHash`;

ALTER TABLE `parameter_snapshots`
  ADD COLUMN `artifactSource` json NULL AFTER `capabilityManifest`;

ALTER TABLE `parameter_snapshots`
  ADD INDEX `idx_ps_artifact_hash` (`artifactHash`);
