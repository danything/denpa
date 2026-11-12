CREATE TABLE `agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`origin` text NOT NULL,
	`cert` text,
	`fingerprint` text,
	`from_env` integer NOT NULL,
	`position` integer NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_fingerprint_unique` ON `agents` (`fingerprint`);