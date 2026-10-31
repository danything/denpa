ALTER TABLE `clips` ADD `has_captions` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `clips` ADD `has_comments` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `clips` ADD `show_captions` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `clips` ADD `show_comments` integer DEFAULT 0 NOT NULL;