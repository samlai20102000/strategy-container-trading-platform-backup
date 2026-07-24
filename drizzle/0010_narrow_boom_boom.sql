ALTER TABLE `strategies` ADD `tradeMode` enum('webhook','auto') DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategies` ADD `heartbeatTaskUid` varchar(100);--> statement-breakpoint
ALTER TABLE `strategies` ADD `kLinePeriod` int DEFAULT 15 NOT NULL;