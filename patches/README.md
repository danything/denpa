# ffmpeg に当てる直し

Dockerfile の `ffmpeg` 段で、組む前に `patch -p1 --fuzz=0` で当てます
(`ffmpeg-*.patch` の名前で拾う)。**上流に投げるつもりのものだけ**を置きます — 手元の都合で
ffmpeg の挙動を変えたくなったら、まず denpa 側で済ませられないかを考えます。

**いまは当てているものはありません。** 以前は字幕を絵にする libaribcaption まわりの直し
(`ffmpeg-aribcaption-clear.patch` / `ffmpeg-aribcaption-render-leak.patch` /
`libaribcaption-drcs.patch`) を当てていましたが、字幕を解かずに写して denpa が解くように
なって libaribcaption ごと外したので、一緒に消しました。中身と経緯は git の履歴にあります
(`git log -- patches/`)。外字の置き換え表に足した分は `src/lib/ts/b24-tables.ts` に引き継いでいます。

## `ffmpeg-sched-overflow.patch` (9.0.2 で取り下げ)

**9.0 / 9.0.1 で、長い録画を 60コマで焼くと 20〜25分あたりで音声が黙って終わるのを直していました**
(2026-08-17 に実機の 2 時間の映画で AV1 版 23:28・H.264 版 22:07 で音声トラックが終わり、
エラーは 1 行も出なかった)。

ffmpeg 9.0 の CLI (`fftools/ffmpeg_sched.c`) は、先に進みすぎたデコーダを止めている間も
デマルチプレクサが詰まらないように、パケットを**デコーダごとの溢れ用 FIFO**
(`SchDec.overflow`) に溜めていました。上限は **1 MB ぶんのポインタ = 131,072 個**。
映像のエンコードが重くて音声デコーダが長く止められると (60コマの映像 + 音声は軽い)、
そこに当たって書き込みが `ENOSPC` で失敗し、デコーダスレッドは負の戻り値をすべて EOF と
見なして「Decoder thread received EOF packet」で終わる。残りの音声は捨てられる。
実測で数が合いました: 読んだ音声パケット 197,716 − 復号した 66,641 = 131,075。

直しは「満杯なら、止められていても最古のパケットを渡す」で、当てた 9.0.1 で 2 時間の映画を
通しで焼くと音声が最後まで揃いました (60 ms 超の途切れ 0)。

**9.0.2 (2026-09-18) で、この溢れ FIFO とデコーダを止める仕組みそのものが
`fftools/ffmpeg_sched.c` から外れました** (`SchDec.overflow` / `SchDec.waiter` /
`UNCHOKE_DECODE` が無い。8.1 までと同じ、デマルチプレクサ側で待つ作り)。
パッチは 4 つのハンクとも当たらなくなり (renovate の 9.0.2 への上げでイメージのビルドが
落ちた、2026-09-18〜19)、直していた経路自体が無いので取り下げました。中身は git の
履歴 (`git log -- patches/ffmpeg-sched-overflow.patch`) にあります。

**9.0.2 で長尺を通しで焼いた実測はまだありません。** 次に 1 時間超の録画を焼いたら、
音声が最後まであるかを一度見ること (`docs/encode.md`)。

