-- EPGStation から移した録画 (program_id は EPGStation の ID の符号を反転したもの。migrate.ts) を視聴済みにする。
-- 観たかどうかは移せないので、denpa の「未視聴」は denpa で録ってまだ観ていないものだけにする —
-- 移した何年分もが未視聴に並ぶと、開いたときにいちばん古いものへ送られる (#1930)。
-- 時刻は取り込んだ時刻。denpa で観終えたもの (印がある) と途中まで観たもの (続きのバーが出る) は変えない
UPDATE `recordings` SET `watched_at` = `created_at` WHERE `program_id` < 0 AND `watched_at` IS NULL AND `resume_ms` IS NULL;
