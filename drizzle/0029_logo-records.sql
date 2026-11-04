CREATE TABLE `logo_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`channel` text NOT NULL,
	`origin` text NOT NULL,
	`opened_ms` integer NOT NULL,
	`outcome` text NOT NULL,
	`received` integer NOT NULL,
	`found` integer NOT NULL,
	`packets` integer NOT NULL,
	`errors` integer NOT NULL,
	`pmt` integer NOT NULL,
	`es_pids` integer NOT NULL,
	`es_packets` integer NOT NULL,
	`dii` integer NOT NULL,
	`ddb` integer NOT NULL,
	`sdtt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `logo_records_started` ON `logo_records` (`started_at`);