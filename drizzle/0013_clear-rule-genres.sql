-- 2.0 で、今あるルールのジャンルの条件を全部外す (NULL = 全ジャンル。schema.ts の rules.genres)。
-- 局によって付け方が揺れ、同じシリーズでも回によってジャンルが違うことがあり、絞ると録り逃す。
-- 予約は起動直後の当て直し (epg.sync → settle → rules.applyRules) で新しい条件にそろう
UPDATE `rules` SET `genres` = NULL WHERE `genres` IS NOT NULL;
