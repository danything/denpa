CREATE TABLE `agent_faults` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer NOT NULL,
	`at` integer NOT NULL,
	`text` text NOT NULL,
	`context` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_faults_line` ON `agent_faults` (`agent_id`,`at`,`text`);--> statement-breakpoint
CREATE INDEX `agent_faults_at` ON `agent_faults` (`at`);