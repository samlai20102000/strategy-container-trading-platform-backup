CREATE TABLE `favorite_symbols` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`exchange` enum('bybit','okx') NOT NULL,
	`symbol` varchar(40) NOT NULL,
	`favKey` varchar(120) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `favorite_symbols_id` PRIMARY KEY(`id`),
	CONSTRAINT `favorite_symbols_favKey_unique` UNIQUE(`favKey`)
);
