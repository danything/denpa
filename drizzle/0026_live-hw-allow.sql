-- GPU のエンコーダを録画とライブで別々に選べるようにした (設定 `liveHwAllow`。docs/encode.md)。
-- これまでライブ・追っかけ・その場の変換は録画の印 (`hwAllow`) を使っていたので、上げたときに同じ選び方から始める。
-- すでにある (このバージョンを一度起動したあと) なら触らない
INSERT INTO `settings` (`key`, `value`, `updated_at`) SELECT 'liveHwAllow', `value`, `updated_at` FROM `settings` WHERE `key` = 'hwAllow' ON CONFLICT DO NOTHING;
