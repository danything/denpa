CREATE TABLE `api_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `device_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_polled_at` integer,
	`approved_at` integer,
	`approved_by` text,
	`approved_token_id` integer,
	`consumed_at` integer,
	FOREIGN KEY (`approved_token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_device_code_hash_unique` ON `device_codes` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_code_unique` ON `device_codes` (`user_code`);--> statement-breakpoint
CREATE INDEX `device_codes_expires` ON `device_codes` (`expires_at`);