-- 通知先の名前 (webhooks.name) は画面から外して久しく、誰も読まない。列ごと消す
ALTER TABLE `webhooks` DROP COLUMN `name`;