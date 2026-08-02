CREATE TABLE `backtest_worker_registry` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(80) NOT NULL,
	`schedule_cron_task_uid` varchar(65) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`lastHeartbeatAt` timestamp,
	`lastResult` varchar(40),
	`lastSummary` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `backtest_worker_registry_id` PRIMARY KEY(`id`),
	CONSTRAINT `backtest_worker_registry_name_unique` UNIQUE(`name`),
	CONSTRAINT `backtest_worker_registry_schedule_cron_task_uid_unique` UNIQUE(`schedule_cron_task_uid`)
);
--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `phase` enum('QUEUED','PREPARING','RUNNING','FINALIZING','COMPLETED','FAILED','CANCELLED') DEFAULT 'QUEUED' NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `processedBars` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `totalBars` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `requestSnapshot` json;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `logicHash` varchar(128);--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `timeoutSeconds` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `heartbeatAt` timestamp;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `leaseToken` varchar(64);--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `leaseExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `cancelRequested` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `attemptCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `errorCode` varchar(100);--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `updatedAt` timestamp DEFAULT (now()) NOT NULL ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
CREATE INDEX `backtest_worker_task_uid_idx` ON `backtest_worker_registry` (`schedule_cron_task_uid`);--> statement-breakpoint
CREATE INDEX `backtest_jobs_status_lease_idx` ON `backtest_jobs` (`status`,`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `backtest_jobs_cancel_idx` ON `backtest_jobs` (`cancelRequested`,`status`);--> statement-breakpoint
CREATE INDEX `backtest_jobs_heartbeat_idx` ON `backtest_jobs` (`heartbeatAt`);