CREATE TABLE `heartbeat_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`strategyId` int NOT NULL,
	`userId` int NOT NULL,
	`result` enum('hold','signal','executed','failed','error') NOT NULL,
	`detail` text,
	`signalAction` varchar(20),
	`signalPrice` decimal(20,8),
	`latencyMs` int,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `heartbeat_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `signals` ADD `source` enum('webhook','auto','manual') DEFAULT 'webhook' NOT NULL;