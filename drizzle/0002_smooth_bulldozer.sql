CREATE TABLE `strategy_definitions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`key` varchar(100) NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	`sourceCode` text,
	`defaultConfig` json,
	`sourceType` enum('system','paste','upload') NOT NULL DEFAULT 'paste',
	`isBuiltIn` boolean NOT NULL DEFAULT false,
	`isActive` boolean NOT NULL DEFAULT true,
	`filePath` varchar(300),
	`version` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `strategy_definitions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `strategies` ADD `martinMultiplier` decimal(6,2) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategies` ADD `maxMartinLevel` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `strategies` ADD `martinSpacingPct` decimal(6,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategies` ADD `martinState` json;--> statement-breakpoint
ALTER TABLE `strategies` ADD `strategyKey` varchar(100);