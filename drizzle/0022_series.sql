ALTER TABLE `programs` ADD `series_id` integer;--> statement-breakpoint
ALTER TABLE `programs` ADD `series_repeat` integer;--> statement-breakpoint
ALTER TABLE `programs` ADD `series_episode` integer;--> statement-breakpoint
ALTER TABLE `programs` ADD `series_last_episode` integer;--> statement-breakpoint
ALTER TABLE `programs` ADD `series_name` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `series_episode` integer;--> statement-breakpoint
ALTER TABLE `recordings` ADD `series_last_episode` integer;--> statement-breakpoint
ALTER TABLE `recordings` ADD `series_repeat` integer;