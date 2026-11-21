CREATE TABLE `ranking_watched` (
	`network_id` integer NOT NULL,
	`service_id` integer NOT NULL,
	`event_id` integer NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`name` text NOT NULL,
	`service_name` text NOT NULL,
	`genres` text NOT NULL,
	`recording_id` integer,
	`reserved` integer DEFAULT 0 NOT NULL,
	`recorded` integer DEFAULT 0 NOT NULL,
	`live_ms` integer DEFAULT 0 NOT NULL,
	`timeshift_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`network_id`, `service_id`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `ranking_watched_recording` ON `ranking_watched` (`recording_id`);