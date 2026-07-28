ALTER TABLE `signals` ADD `strategyName` varchar(100);--> statement-breakpoint
ALTER TABLE `signals` ADD `strategyKey` varchar(100);--> statement-breakpoint
ALTER TABLE `trades` ADD `fee` decimal(20,8);--> statement-breakpoint
ALTER TABLE `trades` ADD `netRealizedPnl` decimal(20,8);--> statement-breakpoint
ALTER TABLE `trades` ADD `pnlSource` enum('exchange','local_estimate','legacy','unavailable') DEFAULT 'unavailable' NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `strategyName` varchar(100);--> statement-breakpoint
ALTER TABLE `trades` ADD `strategyKey` varchar(100);