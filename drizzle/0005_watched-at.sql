ALTER TABLE `recordings` ADD `watched_at` integer;--> statement-breakpoint
-- 上げる前に録り終えていたものは「観終えた」扱いにする (schema.ts の watched_at)。
-- 観たかどうかは残っていないので、溜まった録画が全部「未視聴」に光らないほうを採る。
-- 途中まで観たもの (resume_ms が残っている) は観終えていないので NULL のまま。進捗バーが出る
UPDATE `recordings` SET `watched_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE `finished_at` IS NOT NULL AND `resume_ms` IS NULL;
