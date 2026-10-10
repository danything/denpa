-- 設定の「CMの探し方」を外した。いつもロゴで探し、ロゴが使えなければ無音と尺で決める (docs/encode.md)
DELETE FROM `settings` WHERE `key` = 'cmDetector';
