CREATE TABLE `channel_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`at` integer NOT NULL,
	`seen_at` integer
);
