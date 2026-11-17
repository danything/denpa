CREATE TABLE `ranking_link` (
	`id` integer PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`slot` integer NOT NULL,
	`next_at` integer NOT NULL,
	`sent_at` integer,
	`failed_at` integer,
	`failure` text,
	`joined_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ranking_sent` (
	`network_id` integer NOT NULL,
	`service_id` integer NOT NULL,
	`event_id` integer NOT NULL,
	`start_at` integer NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`network_id`, `service_id`, `event_id`)
);
