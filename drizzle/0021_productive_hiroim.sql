ALTER TABLE `order_policy_events`
  ADD COLUMN `policyRunId` varchar(40) NOT NULL AFTER `id`;
--> statement-breakpoint
CREATE INDEX `order_policy_run_time_idx`
  ON `order_policy_events` (`policyRunId`, `eventAt`);
--> statement-breakpoint
CREATE TABLE `order_policy_recovery_schedules` (
  `id` int AUTO_INCREMENT NOT NULL,
  `taskUid` varchar(128) NOT NULL,
  `enabled` boolean NOT NULL DEFAULT true,
  `lastRunAt` timestamp NULL,
  `lastResult` enum('SUCCESS','PARTIAL','FAILED') NULL,
  `lastSummary` json NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `order_policy_recovery_schedules_id` PRIMARY KEY(`id`),
  CONSTRAINT `order_policy_recovery_schedules_taskUid_unique` UNIQUE(`taskUid`)
);
