CREATE TABLE `card_contracts` (
	`card_id` text NOT NULL,
	`service_id` integer NOT NULL,
	`state` text NOT NULL,
	`code` integer,
	`valid_until` integer,
	`decode_ok` integer,
	`decoded_at` integer,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`card_id`, `service_id`)
);
--> statement-breakpoint
ALTER TABLE `programs` ADD `contract_verification` text;