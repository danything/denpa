ALTER TABLE `services` ADD `listed` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- 上げる前は「いちばん新しい取り込みの時刻」の局を一覧にしていた (epg.currentServices)。同じ局を一覧に残す
UPDATE `services` SET `listed` = 0 WHERE `updated_at` < (SELECT MAX(`updated_at`) FROM `services`);
