CREATE TABLE `agent_channels` (
	`agent_id` integer NOT NULL,
	`type` text NOT NULL,
	`channel` text NOT NULL,
	`network_id` integer NOT NULL,
	`transport_stream_id` integer NOT NULL,
	`transport` text NOT NULL,
	PRIMARY KEY(`agent_id`, `type`, `channel`)
);
--> statement-breakpoint
CREATE INDEX `agent_channels_ts` ON `agent_channels` (`type`,`network_id`,`transport_stream_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_channel_reception` (
	`agent_id` integer NOT NULL,
	`type` text NOT NULL,
	`channel` text NOT NULL,
	`ok_at` integer,
	`failed_at` integer,
	`failing_since` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`unreceivable` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`agent_id`, `type`, `channel`)
);
--> statement-breakpoint
-- 上げる前の受信の記録は、選局に使っていた並びの先頭のエージェントのものにする。エージェントの行がまだ無い (0038 と一緒に当たる) なら捨てる (取得の 2 周で決め直す)
INSERT INTO `__new_channel_reception`("agent_id", "type", "channel", "ok_at", "failed_at", "failing_since", "failures", "unreceivable") SELECT (SELECT `id` FROM `agents` ORDER BY `position`, `id` LIMIT 1), "type", "channel", "ok_at", "failed_at", "failing_since", "failures", "unreceivable" FROM `channel_reception` WHERE EXISTS (SELECT 1 FROM `agents`);--> statement-breakpoint
DROP TABLE `channel_reception`;--> statement-breakpoint
ALTER TABLE `__new_channel_reception` RENAME TO `channel_reception`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `services` ADD `transport_stream_id` integer;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `channel`;--> statement-breakpoint
-- 0038 は TUNER_AGENT_URL を書いたままの形で origin に入れていた。今の突き合わせ (agents.parseAgentUrl) と同じく、ホスト名を小文字にして :443 を落とす。
-- 合わないままだと、次の起動で別の行として足し直され、保存した証明書と受信の記録が消える
UPDATE `agents` SET `origin` = 'https://' || lower(substr(`origin`, 9)) WHERE instr(substr(`origin`, 9), '/') = 0;--> statement-breakpoint
UPDATE `agents` SET `origin` = 'https://' || lower(substr(`origin`, 9, instr(substr(`origin`, 9), '/') - 1)) || substr(`origin`, 8 + instr(substr(`origin`, 9), '/')) WHERE instr(substr(`origin`, 9), '/') > 0;--> statement-breakpoint
UPDATE `agents` SET `origin` = substr(`origin`, 1, length(`origin`) - 4) WHERE instr(substr(`origin`, 9), '/') = 0 AND substr(`origin`, -4) = ':443';--> statement-breakpoint
UPDATE `agents` SET `origin` = substr(`origin`, 1, 3 + instr(substr(`origin`, 9), '/')) || substr(`origin`, 8 + instr(substr(`origin`, 9), '/')) WHERE instr(substr(`origin`, 9), '/') > 0 AND substr(`origin`, 4 + instr(substr(`origin`, 9), '/'), 4) = ':443';
