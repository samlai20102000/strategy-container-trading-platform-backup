CREATE TABLE `order_policy_setting_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`revision` int NOT NULL,
	`eventType` enum('CREATED','UPDATED','RESET') NOT NULL,
	`previousConfig` json,
	`nextConfig` json NOT NULL,
	`reason` varchar(500),
	`eventAt` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `order_policy_setting_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `order_policy_settings` (
	`userId` int NOT NULL,
	`standardTtlMs` int NOT NULL DEFAULT 30000,
	`standardMaxAttempts` int NOT NULL DEFAULT 3,
	`emergencyTtlMs` int NOT NULL DEFAULT 2000,
	`emergencyMakerAttempts` int NOT NULL DEFAULT 2,
	`allowStopLossTaker` boolean NOT NULL DEFAULT true,
	`allowDailyLossTaker` boolean NOT NULL DEFAULT true,
	`allowKillSwitchTaker` boolean NOT NULL DEFAULT true,
	`revision` int NOT NULL DEFAULT 0,
	`updatedByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `order_policy_settings_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
CREATE INDEX `order_policy_setting_owner_time_idx` ON `order_policy_setting_events` (`userId`,`eventAt`);