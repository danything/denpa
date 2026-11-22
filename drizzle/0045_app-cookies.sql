CREATE TABLE `app_cookies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`value_hash` text NOT NULL,
	`token_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_cookies_value_hash_unique` ON `app_cookies` (`value_hash`);--> statement-breakpoint
CREATE INDEX `app_cookies_token` ON `app_cookies` (`token_id`);--> statement-breakpoint
CREATE INDEX `app_cookies_expires` ON `app_cookies` (`expires_at`);