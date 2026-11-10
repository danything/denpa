ALTER TABLE `services` ADD `decodable` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- 上げる前に入っていた SKY の局は復号できない (types.ts の decodableService)。取り込み (epg.syncServices) が決め直すまでの間も、番組表とライブに出さない
UPDATE `services` SET `decodable` = 0 WHERE `type` = 'SKY';
