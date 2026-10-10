-- CM検出だけやり直すジョブ (encode_jobs.kind = 'cm')。焼いたものを切ったか (cm_kept) と、焼くときに頭から捨てた長さ (encode_skip) を
-- 録画に覚えて、生TSの時刻を焼いたものの時刻へ直す (docs/encode.md「CM 検出だけやり直す」)。前に焼いた録画はどちらも NULL
ALTER TABLE `encode_jobs` ADD `kind` text DEFAULT 'encode' NOT NULL;--> statement-breakpoint
ALTER TABLE `recordings` ADD `cm_kept` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `encode_skip` real;