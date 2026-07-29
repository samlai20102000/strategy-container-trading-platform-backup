ALTER TABLE `backtest_jobs` ADD `endPositionPolicy` varchar(20) DEFAULT 'mark_to_market' NOT NULL;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `candleCount` int;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `accounting` json;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `dataQuality` json;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `engineSemantics` json;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `environment` json;