CREATE TABLE `caption_index` (
	`recording_id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`library_path` text,
	`ts_path` text,
	`encode_skip` real,
	`lines` integer DEFAULT 0 NOT NULL,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `caption_lines` (
	`id` integer PRIMARY KEY NOT NULL,
	`recording_id` integer NOT NULL,
	`at_ms` integer NOT NULL,
	`language` integer DEFAULT 1 NOT NULL,
	`text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `caption_lines_recording` ON `caption_lines` (`recording_id`,`at_ms`);