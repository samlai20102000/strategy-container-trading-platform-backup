CREATE TABLE `parameter_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`strategyKey` varchar(100) NOT NULL,
	`strategyName` varchar(200),
	`snapshotName` varchar(200),
	`config` json NOT NULL,
	`metrics` json NOT NULL,
	`totalReturn` decimal(10,2),
	`winRate` decimal(8,2),
	`sharpeRatio` decimal(8,3),
	`profitFactor` decimal(8,2),
	`maxDrawdown` decimal(8,2),
	`isFavorite` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `parameter_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `scan_jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`strategyKey` varchar(100) NOT NULL,
	`strategyName` varchar(200),
	`symbol` varchar(40) NOT NULL,
	`timeframe` varchar(10) NOT NULL,
	`startTime` bigint NOT NULL,
	`endTime` bigint NOT NULL,
	`initialCapital` decimal(20,8) NOT NULL,
	`baseConfig` json NOT NULL,
	`scanParams` json NOT NULL,
	`totalCombinations` int NOT NULL DEFAULT 0,
	`completedCombinations` int NOT NULL DEFAULT 0,
	`status` varchar(20) NOT NULL DEFAULT 'pending',
	`results` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `scan_jobs_id` PRIMARY KEY(`id`)
);
