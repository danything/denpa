CREATE TABLE `recorded_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`service_name` text DEFAULT '' NOT NULL,
	`end_at` integer NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recorded_history_source_unique` ON `recorded_history` (`source`);--> statement-breakpoint
ALTER TABLE `rules` ADD `skip_earlier` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `recordings_series` ON `recordings` (`series`);