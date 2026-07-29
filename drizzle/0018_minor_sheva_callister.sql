ALTER TABLE `signals` ADD `executionId` varchar(128);--> statement-breakpoint
ALTER TABLE `signals` ADD `cycleId` varchar(128);--> statement-breakpoint
ALTER TABLE `trades` ADD `executionId` varchar(128);--> statement-breakpoint
ALTER TABLE `trades` ADD `cycleId` varchar(128);--> statement-breakpoint
ALTER TABLE `trades` ADD `exchangeTradeId` varchar(128);--> statement-breakpoint
ALTER TABLE `trades` ADD `requestedSize` decimal(20,8);--> statement-breakpoint
ALTER TABLE `trades` ADD `requestedPrice` decimal(20,8);--> statement-breakpoint
ALTER TABLE `trades` ADD `grossPnl` decimal(20,8);--> statement-breakpoint
ALTER TABLE `trades` ADD `fee` decimal(20,8);--> statement-breakpoint
ALTER TABLE `trades` ADD `fundingFee` decimal(20,8);--> statement-breakpoint
ALTER TABLE `trades` ADD `realizedPnlPct` decimal(12,6);--> statement-breakpoint
ALTER TABLE `trades` ADD `pnlCurrency` varchar(16);--> statement-breakpoint
ALTER TABLE `trades` ADD `pnlSource` enum('exchange_settlement','fill_calculation','position_snapshot','legacy_time_match','legacy_existing','unknown') DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `dataQuality` enum('exchange_confirmed','calculated','pending_reconciliation','legacy_time_matched','legacy_unresolved','not_applicable') DEFAULT 'legacy_unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `reconciliationStatus` enum('not_required','pending','confirmed','failed','unresolved') DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `reconciliationAttempts` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `lastReconciledAt` timestamp;--> statement-breakpoint
ALTER TABLE `trades` ADD `reconciliationError` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `filledAt` timestamp;--> statement-breakpoint
ALTER TABLE `trades` ADD `updatedAt` timestamp DEFAULT (now()) NOT NULL ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `signals` ADD CONSTRAINT `signals_executionId_unique` UNIQUE(`executionId`);--> statement-breakpoint
ALTER TABLE `trades` ADD CONSTRAINT `trades_executionId_unique` UNIQUE(`executionId`);--> statement-breakpoint
CREATE INDEX `signals_strategy_created_idx` ON `signals` (`strategyId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `signals_order_idx` ON `signals` (`orderId`);--> statement-breakpoint
CREATE INDEX `signals_cycle_idx` ON `signals` (`cycleId`);--> statement-breakpoint
CREATE INDEX `trades_signal_idx` ON `trades` (`signalId`);--> statement-breakpoint
CREATE INDEX `trades_order_idx` ON `trades` (`orderId`);--> statement-breakpoint
CREATE INDEX `trades_strategy_created_idx` ON `trades` (`strategyId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `trades_cycle_idx` ON `trades` (`cycleId`);--> statement-breakpoint
CREATE INDEX `trades_reconciliation_idx` ON `trades` (`reconciliationStatus`,`createdAt`);