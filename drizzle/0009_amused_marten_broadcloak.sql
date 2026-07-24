ALTER TABLE `strategies` MODIFY COLUMN `positionSize` decimal(20,8);--> statement-breakpoint
ALTER TABLE `strategies` ADD `positionSizeObject` json;--> statement-breakpoint
ALTER TABLE `strategies` ADD `reentryEnabled` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `strategies` ADD `reentryCooldownBars` int DEFAULT 1 NOT NULL;