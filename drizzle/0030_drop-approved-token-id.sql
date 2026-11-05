PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_device_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`name` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_polled_at` integer,
	`approved_at` integer,
	`approved_by` text,
	`consumed_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_device_codes`("id", "device_code_hash", "user_code", "name", "source", "created_at", "expires_at", "last_polled_at", "approved_at", "approved_by", "consumed_at") SELECT "id", "device_code_hash", "user_code", "name", "source", "created_at", "expires_at", "last_polled_at", "approved_at", "approved_by", "consumed_at" FROM `device_codes`;--> statement-breakpoint
DROP TABLE `device_codes`;--> statement-breakpoint
ALTER TABLE `__new_device_codes` RENAME TO `device_codes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_device_code_hash_unique` ON `device_codes` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_code_unique` ON `device_codes` (`user_code`);--> statement-breakpoint
CREATE INDEX `device_codes_expires` ON `device_codes` (`expires_at`);