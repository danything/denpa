/**
 * 偽 ffmpeg のライブの出口 (エンコードしたもの)。**作り置きの fMP4 を、時刻を進めながら繰り返し流す。**
 *
 * 偽 ffmpeg はふだん入ってきた TS をそのまま流すだけで、画面の MSE は何も映さない (映像が要らない
 * テストばかりなので)。互換モード (canvas に描く方式。`src/lib/raw/fmp4.ts`) は**実際にデコードして描く
 * ところまで**見たいので、本物の ffmpeg に書かせた fMP4 を流す。組はライブと同じ (H.264 + AAC・AV1 + Opus):
 *
 *     ffmpeg -f lavfi -i testsrc2=size=320x180:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 \
 *       -c:v libx264 -preset ultrafast -tune zerolatency -crf 35 -g 30 -pix_fmt yuv420p -c:a aac -b:a 64k -ac 2 \
 *       -f mp4 -movflags +empty_moov+default_base_moof -frag_duration 50000 live-h264.mp4
 *     ffmpeg -f lavfi -i testsrc2=size=320x180:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 \
 *       -c:v libsvtav1 -preset 12 -g 30 -pix_fmt yuv420p -c:a libopus -b:a 64k -ac 2 \
 *       -f mp4 -movflags +empty_moov+default_base_moof -frag_duration 50000 live-av1.mp4
 *
 * 形式はライブの ffmpeg と同じ (`server/live.ts` の `+empty_moov+default_base_moof`)。2秒ぶんを
 * 頭 (ftyp + moov) を1回だけ出してから、媒体 (moof + mdat) を**時刻 (tfdt) を1周ぶんずつ
 * 足して**繰り返す。速さは実時間 (本物のライブと同じく、先へは溜めない)。
 *
 *     bun tests/fake/fmp4-loop.ts <fMP4>
 *
 * 入口 (TS) は読んで捨てる。読まないとパイプが詰まって、送る側 (`server/live.ts`) が止まる
 */

import { readFileSync } from "node:fs";

import { readClip, shiftFragment } from "./fmp4-clip";

const clip = readClip(new Uint8Array(readFileSync(process.argv[2] ?? "")));

// 入口の TS は読んで捨てる (上の説明)
void (async () => {
  for await (const _ of Bun.stdin.stream()) {
    // 捨てる
  }
})();

const out = Bun.stdout.writer();
out.write(clip.head);
await out.flush();

/**
 * **届き方を荒らす** (ライブの貯め方の E2E。`50-live-pacing.spec.ts`)。目印のファイルに JSON で書く。空なら一定に流す:
 *
 * - `gapEvery` [最短, 最長] (秒) と `gapMs` [最短, 最長] (ms) … ときどき長く空ける (空いた間のぶんは後でまとめて出す)。
 *   回線や中継がたまに詰まる経路のまね (#1210)
 * - `burstMs` [最短, 最長] (ms) … いつも束にして出す。届き方が荒い経路のまね
 */
interface Rough {
  gapEvery?: [number, number];
  gapMs?: [number, number];
  burstMs?: [number, number];
}
const rough: Rough = (() => {
  try {
    const text = readFileSync(
      process.env["FAKE_FFMPEG_LIVE_FMP4_FILE"] ?? "",
      "utf8",
    ).trim();
    return text === "" ? {} : (JSON.parse(text) as Rough);
  } catch {
    return {};
  }
})();
const between = ([low, high]: [number, number]) =>
  low + Math.random() * (high - low);
/** 次に長く空ける時刻 (ms) */
let nextGap =
  rough.gapEvery === undefined
    ? Number.POSITIVE_INFINITY
    : between(rough.gapEvery) * 1000;
/** この時刻 (ms) までは出さずに溜める */
let holdUntil = 0;
const held: Uint8Array[] = [];

const started = performance.now();
for (let round = 0; ; round++) {
  for (const fragment of clip.fragments) {
    const data = shiftFragment(clip, fragment, clip.period * round);
    const due =
      (round * clip.period + fragment.seconds) * 1000 -
      (performance.now() - started);
    if (due > 0) await Bun.sleep(due);
    held.push(data);
    const now = performance.now() - started;
    if (rough.gapEvery !== undefined && now >= nextGap) {
      holdUntil = now + between(rough.gapMs ?? [700, 700]);
      nextGap = holdUntil + between(rough.gapEvery) * 1000;
    }
    if (now < holdUntil) continue;
    for (const piece of held) out.write(piece);
    held.length = 0;
    await out.flush();
    if (rough.burstMs !== undefined) holdUntil = now + between(rough.burstMs);
  }
}
