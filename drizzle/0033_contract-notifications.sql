CREATE TABLE `contract_notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` text NOT NULL,
	`service_id` integer NOT NULL,
	`event` text NOT NULL,
	`valid_until` integer NOT NULL,
	`notified_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contract_notifications_event_idx` ON `contract_notifications` (`card_id`,`service_id`,`event`,`valid_until`);
