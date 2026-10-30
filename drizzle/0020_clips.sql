CREATE TABLE `clips` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`taken_at` integer NOT NULL,
	`place` text NOT NULL,
	`recording_id` integer,
	`service_id` integer NOT NULL,
	`event_id` integer,
	`program_start_at` integer,
	`program_name` text DEFAULT '' NOT NULL,
	`service_name` text DEFAULT '' NOT NULL,
	`offset_ms` integer,
	`captions` text DEFAULT '' NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`file` text DEFAULT '' NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clips_taken` ON `clips` (`taken_at`);--> statement-breakpoint
CREATE INDEX `clips_recording` ON `clips` (`recording_id`);--> statement-breakpoint
CREATE INDEX `clips_service` ON `clips` (`service_id`);