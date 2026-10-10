-- CM検出から join_logo_scp を外した (1本の ffmpeg で読み、境目は TS で決める。docs/encode.md)。
-- 覚え書きの目印を新しい言い方にそろえる (format.LOGO_OK / LOGO_UNUSABLE)。古いままだと、うまくいった録画にも
-- 「join_logo_scp」が出て、ロゴを使えなかった録画の印も消える
UPDATE `recordings` SET `cm_note` = 'ロゴ' WHERE `cm_note` = 'join_logo_scp';--> statement-breakpoint
UPDATE `recordings` SET `cm_note` = replace(`cm_note`, 'jls は使えず', 'ロゴは使えず') WHERE `cm_note` LIKE '%jls は使えず%';--> statement-breakpoint
-- 「CMの探し方」の jls は、ロゴで探す既定 (logo) になった。「ロゴの重み」(join_logo_scp の logo_level) は無くなった
UPDATE `settings` SET `value` = 'logo' WHERE `key` = 'cmDetector' AND `value` = 'jls';--> statement-breakpoint
DELETE FROM `settings` WHERE `key` = 'logoLevel';
