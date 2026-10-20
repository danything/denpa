CREATE TABLE `cm_materials` (
	`recording_id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`data` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade
);
