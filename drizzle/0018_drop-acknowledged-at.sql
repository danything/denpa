-- 失敗をホームの通知に出していた頃の確認の時刻 (recordings.acknowledged_at)。読みも書きもしなくなって久しいので、列ごと消す
ALTER TABLE `recordings` DROP COLUMN `acknowledged_at`;