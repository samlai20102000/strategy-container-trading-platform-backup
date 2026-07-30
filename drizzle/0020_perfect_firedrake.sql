CREATE TABLE `account_position_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`snapshotKey` varchar(96) NOT NULL,
	`contractVersion` varchar(40) NOT NULL DEFAULT 'exchange-position-v3',
	`userId` int NOT NULL,
	`apiKeyId` int NOT NULL,
	`exchange` enum('bybit','okx') NOT NULL,
	`status` enum('available','error') NOT NULL,
	`positions` json NOT NULL,
	`sanitizedError` text,
	`capturedAt` timestamp NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `account_position_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `account_position_snapshots_snapshotKey_unique` UNIQUE(`snapshotKey`)
);
--> statement-breakpoint
CREATE TABLE `position_cycles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`cycleId` varchar(128) NOT NULL,
	`contractVersion` varchar(32) NOT NULL DEFAULT 'martin-layers-v1',
	`userId` int NOT NULL,
	`strategyId` int NOT NULL,
	`apiKeyId` int NOT NULL,
	`exchange` enum('bybit','okx') NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`side` enum('long','short') NOT NULL,
	`status` enum('open','closed','reconciliation_required') NOT NULL DEFAULT 'open',
	`dataQuality` enum('live_exact','legacy_reconstructed','reconciliation_required') NOT NULL DEFAULT 'live_exact',
	`openedAt` timestamp NOT NULL,
	`closedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `position_cycles_id` PRIMARY KEY(`id`),
	CONSTRAINT `position_cycles_cycleId_unique` UNIQUE(`cycleId`)
);
--> statement-breakpoint
CREATE TABLE `position_layer_close_allocations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`allocationKey` varchar(180) NOT NULL,
	`userId` int NOT NULL,
	`strategyId` int NOT NULL,
	`cycleId` varchar(128) NOT NULL,
	`layerEventId` int NOT NULL,
	`layerIndex` int NOT NULL,
	`closeExecutionId` varchar(128) NOT NULL,
	`allocatedQuantity` decimal(20,8) NOT NULL,
	`closePrice` decimal(20,8),
	`grossPnl` decimal(20,8),
	`feeShare` decimal(20,8),
	`realizedPnl` decimal(20,8),
	`allocationPolicy` enum('fifo') NOT NULL DEFAULT 'fifo',
	`dataQuality` enum('live_exact','legacy_reconstructed','reconciliation_required') NOT NULL DEFAULT 'live_exact',
	`allocatedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `position_layer_close_allocations_id` PRIMARY KEY(`id`),
	CONSTRAINT `position_layer_close_allocations_allocationKey_unique` UNIQUE(`allocationKey`)
);
--> statement-breakpoint
CREATE TABLE `position_layer_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`strategyId` int NOT NULL,
	`apiKeyId` int NOT NULL,
	`cycleId` varchar(128) NOT NULL,
	`layerIndex` int NOT NULL,
	`executionId` varchar(128) NOT NULL,
	`layerIntentId` varchar(128) NOT NULL,
	`orderId` varchar(100),
	`exchangeTradeId` varchar(128),
	`side` enum('buy','sell') NOT NULL,
	`quantity` decimal(20,8) NOT NULL,
	`entryPrice` decimal(20,8) NOT NULL,
	`fee` decimal(20,8),
	`source` enum('live_execution','legacy_reconstructed','reconciliation_adjustment') NOT NULL DEFAULT 'live_execution',
	`dataQuality` enum('live_exact','legacy_reconstructed','reconciliation_required') NOT NULL DEFAULT 'live_exact',
	`filledAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `position_layer_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `position_layer_events_executionId_unique` UNIQUE(`executionId`)
);
--> statement-breakpoint
CREATE INDEX `account_position_snapshot_owner_idx` ON `account_position_snapshots` (`userId`,`apiKeyId`);--> statement-breakpoint
CREATE INDEX `account_position_snapshot_expiry_idx` ON `account_position_snapshots` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `position_cycles_strategy_status_idx` ON `position_cycles` (`strategyId`,`status`);--> statement-breakpoint
CREATE INDEX `position_cycles_owner_status_idx` ON `position_cycles` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `position_cycles_account_position_idx` ON `position_cycles` (`apiKeyId`,`symbol`,`side`,`status`);--> statement-breakpoint
CREATE INDEX `position_layer_close_cycle_idx` ON `position_layer_close_allocations` (`cycleId`,`layerIndex`);--> statement-breakpoint
CREATE INDEX `position_layer_close_execution_idx` ON `position_layer_close_allocations` (`closeExecutionId`);--> statement-breakpoint
CREATE INDEX `position_layer_close_event_idx` ON `position_layer_close_allocations` (`layerEventId`);--> statement-breakpoint
CREATE INDEX `position_layer_cycle_layer_idx` ON `position_layer_events` (`cycleId`,`layerIndex`);--> statement-breakpoint
CREATE INDEX `position_layer_strategy_cycle_idx` ON `position_layer_events` (`strategyId`,`cycleId`);--> statement-breakpoint
CREATE INDEX `position_layer_order_idx` ON `position_layer_events` (`orderId`);