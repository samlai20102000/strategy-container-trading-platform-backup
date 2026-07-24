CREATE TABLE `bar_locks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`lockKey` varchar(120) NOT NULL,
	`strategyId` int NOT NULL,
	`barTimestamp` bigint NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bar_locks_id` PRIMARY KEY(`id`),
	CONSTRAINT `bar_locks_lockKey_unique` UNIQUE(`lockKey`)
);
