ALTER TABLE `trades` MODIFY COLUMN `pnlSource` enum('exchange','local_estimate','legacy','unavailable','exchange_settlement','fill_calculation','position_snapshot','legacy_time_match','legacy_existing','unknown') NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE `trades` ADD `netRealizedPnl` decimal(20,8);--> statement-breakpoint
ALTER TABLE `trades` ADD `strategyName` varchar(100);--> statement-breakpoint
ALTER TABLE `trades` ADD `strategyKey` varchar(100);