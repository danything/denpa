-- CM検出だけやり直すジョブ (encode_jobs.kind = 'cm')。エンコード済みを切ったか (cm_kept) と、エンコードするときに頭から捨てた長さ (encode_skip) を
-- 録画に覚えて、元のTSの時刻をエンコード済みの時刻へ直す (docs/cm.md「CM 検出だけやり直す」)。前にエンコードした録画はどちらも NULL
ALTER TABLE `encode_jobs` ADD `kind` text DEFAULT 'encode' NOT NULL;--> statement-breakpoint
ALTER TABLE `recordings` ADD `cm_kept` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `encode_skip` real;