CREATE TABLE `cm_shots` (
	`recording_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`hash_hi` integer NOT NULL,
	`hash_lo` integer NOT NULL,
	`length` real NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cm_shots_recording` ON `cm_shots` (`recording_id`,`seq`);