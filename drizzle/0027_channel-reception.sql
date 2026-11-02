CREATE TABLE `channel_reception` (
	`type` text NOT NULL,
	`channel` text NOT NULL,
	`ok_at` integer,
	`failed_at` integer,
	`failing_since` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`unreceivable` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`type`, `channel`)
);
