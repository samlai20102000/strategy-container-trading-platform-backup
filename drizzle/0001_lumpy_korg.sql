CREATE TABLE `api_keys` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`label` varchar(100) NOT NULL,
	`exchange` enum('bybit','okx') NOT NULL,
	`apiKeyEncrypted` text NOT NULL,
	`apiSecretEncrypted` text NOT NULL,
	`passphraseEncrypted` text,
	`isTestnet` boolean NOT NULL DEFAULT false,
	`lastTestStatus` enum('untested','success','failed') NOT NULL DEFAULT 'untested',
	`lastTestAt` timestamp,
	`lastTestMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `risk_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`strategyId` int NOT NULL,
	`userId` int NOT NULL,
	`eventType` enum('stop_loss','take_profit','daily_loss_limit','max_position') NOT NULL,
	`detail` text,
	`positionClosed` boolean NOT NULL DEFAULT false,
	`strategyDisabled` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `risk_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`strategyId` int,
	`userId` int,
	`rawPayload` text NOT NULL,
	`parsedAction` varchar(20),
	`parsedSymbol` varchar(32),
	`parsedPrice` decimal(20,8),
	`status` enum('received','executed','failed','rejected','skipped') NOT NULL DEFAULT 'received',
	`message` text,
	`exchangeResponse` text,
	`orderId` varchar(100),
	`latencyMs` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `signals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` text,
	`apiKeyId` int NOT NULL,
	`exchange` enum('bybit','okx') NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`positionSize` decimal(20,8) NOT NULL,
	`leverage` int NOT NULL DEFAULT 1,
	`direction` enum('long','short','both') NOT NULL DEFAULT 'both',
	`orderType` enum('market','limit') NOT NULL DEFAULT 'market',
	`enabled` boolean NOT NULL DEFAULT true,
	`webhookSecret` varchar(64) NOT NULL,
	`maxPositionPct` decimal(6,2) NOT NULL DEFAULT '0',
	`stopLossPct` decimal(6,2) NOT NULL DEFAULT '0',
	`takeProfitPct` decimal(6,2) NOT NULL DEFAULT '0',
	`maxDailyLoss` decimal(20,2) NOT NULL DEFAULT '0',
	`disabledReason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `strategies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`strategyId` int NOT NULL,
	`userId` int NOT NULL,
	`signalId` int,
	`exchange` enum('bybit','okx') NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`side` enum('buy','sell') NOT NULL,
	`orderType` enum('market','limit') NOT NULL,
	`orderId` varchar(100),
	`size` decimal(20,8) NOT NULL,
	`price` decimal(20,8),
	`reduceOnly` boolean NOT NULL DEFAULT false,
	`realizedPnl` decimal(20,8),
	`status` enum('submitted','filled','failed','cancelled') NOT NULL DEFAULT 'submitted',
	`triggerSource` varchar(30) NOT NULL DEFAULT 'webhook',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `trades_id` PRIMARY KEY(`id`)
);
