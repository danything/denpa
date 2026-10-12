/**
 * 偽 ffmpeg のライブの出口 (エンコードしたもの)。**作り置きの fMP4 を、時刻を進めながら繰り返し流す。**
 *
 * 偽 ffmpeg はふだん入ってきた TS をそのまま流すだけで、画面の MSE は何も映さない (絵が要らない
 * テストばかりなので)。互換モード (canvas に描く道。`src/lib/raw/fmp4.ts`) は**実際にデコードして描く
 * ところまで**見たいので、本物の ffmpeg に書かせた fMP4 を流す。組はライブと同じ (H.264 + AAC・AV1 + Opus):
 *
 *     ffmpeg -f lavfi -i testsrc2=size=320x180:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 \
 *       -c:v libx264 -preset ultrafast -tune zerolatency -crf 35 -g 30 -pix_fmt yuv420p -c:a aac -b:a 64k -ac 2 \
 *       -f mp4 -movflags +empty_moov+default_base_moof -frag_duration 50000 live-h264.mp4
 *     ffmpeg -f lavfi -i testsrc2=size=320x180:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 \
 *       -c:v libsvtav1 -preset 12 -g 30 -pix_fmt yuv420p -c:a libopus -b:a 64k -ac 2 \
 *       -f mp4 -movflags +empty_moov+default_base_moof -frag_duration 50000 live-av1.mp4
 *
 * 形はライブの ffmpeg と同じ (`server/live.ts` の `+empty_moov+default_base_moof`)。2秒ぶんを
 * 頭 (ftyp + moov) を1回だけ出してから、媒体 (moof + mdat) を**時刻 (tfdt) を1周ぶんずつ
 * 足して**繰り返す。速さは実時間 (本物のライブと同じく、先へは溜めない)。
 *
 *     bun tests/fake/fmp4-loop.ts <fMP4>
 *
 * 入口 (TS) は読んで捨てる。読まないとパイプが詰まって、送る側 (`server/live.ts`) が止まる
 */

import { readFileSync } from 'node:fs';
import { readClip, shiftFragment } from './fmp4-clip';

const clip = readClip(new Uint8Array(readFileSync(process.argv[2] ?? '')));

// 入口の TS は読んで捨てる (上の説明)
void (async () => {
    for await (const _ of Bun.stdin.stream()) {
        // 捨てる
    }
})();

const out = Bun.stdout.writer();
out.write(clip.head);
await out.flush();

const started = performance.now();
for (let round = 0; ; round++) {
    for (const fragment of clip.fragments) {
        const data = shiftFragment(clip, fragment, clip.period * round);
        const due = (round * clip.period + fragment.seconds) * 1000 - (performance.now() - started);
        if (due > 0) await Bun.sleep(due);
        out.write(data);
        await out.flush();
    }
}
