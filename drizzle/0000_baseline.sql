-- 最初のマイグレーション (drizzle-kit が schema.ts から出したもの)。
-- **手で IF NOT EXISTS を足してある。** 1.7.x までは起動のたびに CREATE TABLE IF NOT EXISTS で
-- 同じ形に整えていたので、その頃の DB にはもうテーブルがある。素の CREATE だとそこで
-- 止まってしまう。以降のマイグレーションは出たまま触らない

CREATE TABLE IF NOT EXISTS `encode_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recording_id` integer NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'encode' NOT NULL,
	`percent` real DEFAULT 0 NOT NULL,
	`eta_ms` integer,
	`log` text DEFAULT '' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `encode_jobs_state` ON `encode_jobs` (`state`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `encode_jobs_recording` ON `encode_jobs` (`recording_id`,`id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `programs` (
	`id` integer PRIMARY KEY NOT NULL,
	`service_id` integer NOT NULL,
	`network_id` integer NOT NULL,
	`event_id` integer NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`extended` text,
	`genres` text,
	`genre_detail` text,
	`is_free` integer DEFAULT 1 NOT NULL,
	`audio_type` integer,
	`audios` text,
	`video_type` text,
	`video_resolution` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `programs_time` ON `programs` (`start_at`,`end_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `programs_service_time` ON `programs` (`service_id`,`start_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `recordings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reservation_id` integer,
	`program_id` integer,
	`service_id` integer NOT NULL,
	`service_name` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`series` text DEFAULT '' NOT NULL,
	`subtitle` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`extended` text,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`audio_type` integer,
	`ts_path` text,
	`ts_size` integer DEFAULT 0 NOT NULL,
	`library_path` text,
	`alt_path` text,
	`finished_at` integer,
	`error` text,
	`cm_ranges` text,
	`genre_detail` text,
	`audios` text,
	`duration_ms` integer,
	`fps` integer,
	`deleted_at` integer,
	`acknowledged_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text GENERATED ALWAYS AS (
        CASE
            WHEN deleted_at IS NOT NULL THEN 'deleted'
            WHEN error IS NOT NULL THEN 'failed'
            WHEN finished_at IS NULL THEN 'recording'
            WHEN library_path IS NOT NULL THEN 'available'
            ELSE 'recorded'
        END) VIRTUAL NOT NULL,
	`cm_note` text,
	`record_from` integer,
	`record_to` integer,
	`resume_ms` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `recordings_state` ON `recordings` (`state`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `recordings_start` ON `recordings` ("start_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `recordings_program` ON `recordings` (`program_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reservations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`program_id` integer NOT NULL,
	`rule_id` integer,
	`service_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`priority` integer DEFAULT 2 NOT NULL,
	`manual` integer DEFAULT 0 NOT NULL,
	`encode` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT 'scheduled' NOT NULL,
	`started_at` integer,
	`conflict_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`record_from` integer,
	`record_to` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `reservations_program_id_unique` ON `reservations` (`program_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reservations_state_time` ON `reservations` (`state`,`start_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`keyword` text DEFAULT '' NOT NULL,
	`ignore_keyword` text DEFAULT '' NOT NULL,
	`search_fields` text DEFAULT 'name' NOT NULL,
	`service_ids` text,
	`service_types` text,
	`genres` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`priority` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`source` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `services` (
	`id` integer PRIMARY KEY NOT NULL,
	`service_id` integer NOT NULL,
	`network_id` integer NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`service_type` integer DEFAULT 1 NOT NULL,
	`channel` text NOT NULL,
	`remote_control_key` integer,
	`has_logo` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`logo_area` text,
	`logo_area_auto` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `share_links` (
	`recording_id` integer PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `webhooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_status` text,
	`last_sent_at` integer,
	`created_at` integer NOT NULL
);
