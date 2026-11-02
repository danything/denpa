CREATE TABLE `niconico_link` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`access_token` blob,
	`refresh_token` blob,
	`access_expires_at` integer NOT NULL,
	`linked_at` integer NOT NULL,
	`linked_by` text NOT NULL,
	`lost_at` integer
);
