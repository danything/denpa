CREATE TABLE `series_heads` (
	`key` text PRIMARY KEY NOT NULL,
	`last_adopted` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `series_titles` (
	`station` text NOT NULL,
	`series` text NOT NULL,
	`title` text NOT NULL,
	`titles` integer NOT NULL,
	`movie_only` integer DEFAULT 0 NOT NULL,
	`last_seen` integer NOT NULL,
	PRIMARY KEY(`station`, `series`)
);
--> statement-breakpoint
CREATE INDEX `series_titles_last_seen` ON `series_titles` (`last_seen`);