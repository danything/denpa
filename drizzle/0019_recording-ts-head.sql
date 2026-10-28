-- 録画の頭の放送時刻 (unix ms)。実況のコメントを再生位置に合わせるのに使う。測れていない録画は NULL
ALTER TABLE `recordings` ADD `ts_head` integer;