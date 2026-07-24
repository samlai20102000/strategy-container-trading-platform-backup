ALTER TABLE `parameter_snapshots` ADD `dataHash` varchar(64);--> statement-breakpoint
ALTER TABLE `parameter_snapshots` ADD `engineVersion` varchar(20);--> statement-breakpoint
ALTER TABLE `parameter_snapshots` ADD `leverage` decimal(8,2);--> statement-breakpoint
ALTER TABLE `parameter_snapshots` ADD `commission` decimal(8,6);--> statement-breakpoint
ALTER TABLE `parameter_snapshots` ADD `slippage` decimal(8,6);