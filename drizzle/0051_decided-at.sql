ALTER TABLE `reservations` ADD `decided_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `claimed_from` text;--> statement-breakpoint
ALTER TABLE `rules` ADD `decided_at` integer DEFAULT 0 NOT NULL;