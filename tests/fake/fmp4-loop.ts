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
 * 形式はライブの ffmpeg と同じ (`server/live.ts` の `+empty_moov+default_base_moof`)。2 秒ぶんを
 * 先頭 (ftyp + moov) を 1 回だけ出してから、媒体 (moof + mdat) を**時刻 (tfdt) を 1 周ぶんずつ
 * 足して**繰り返す。速さは実時間 (本物のライブと同じく、先へは溜めない)。
 *
 *     bun tests/fake/fmp4-loop.ts <fMP4>
 *
 * 入口 (TS) は読んで捨てる。読まないとパイプが詰まって、送る側 (`server/live.ts`) が止まる
 */

import { readFileSync } from "node:fs";

import { readClip, shiftFragment } from "./fmp4-clip";

/**
 * 入口の TS から最初の PCR (秒) を読む。読めるまでは null。`clock` のときだけ、本物の ffmpeg と同じく
 * 入力の見出し (`start:`) にして標準エラーへ出す。サーバはこれで時計 (`clock` の通知) を配る (`server/live.ts` の `startPts`)
 */
let firstPcr: number | null = null;
/** 最初の PCR を読むか (`Rough` の `clock`。下で目印を読んでから決める) */
let wantClock = false;
let pending = new Uint8Array(0);
function readPcr(chunk: Uint8Array): void {
  const joined = new Uint8Array(pending.length + chunk.length);
  joined.set(pending);
  joined.set(chunk, pending.length);
  let at = joined.indexOf(0x47);
  while (at >= 0 && at + 188 <= joined.length && firstPcr === null) {
    const packet = joined.subarray(at, at + 188);
    if (
      (packet[3]! & 0x20) !== 0 &&
      packet[4]! >= 7 &&
      (packet[5]! & 0x10) !== 0
    )
      firstPcr =
        (packet[6]! * 2 ** 25 +
          packet[7]! * 2 ** 17 +
          packet[8]! * 2 ** 9 +
          packet[9]! * 2 +
          (packet[10]! >> 7)) /
        90_000;
    at += 188;
  }
  pending = joined.slice(Math.max(0, at));
  if (firstPcr !== null)
    process.stderr.write(
      `Input #0, mpegts, from 'pipe:0':\n  Duration: N/A, start: ${firstPcr.toFixed(6)}, bitrate: N/A\n`,
    );
}

// 入口の TS は読んで捨てる (上の説明)。`clock` のときは最初の PCR だけ読む
void (async () => {
  for await (const chunk of Bun.stdin.stream()) {
    if (wantClock && firstPcr === null) readPcr(chunk);
  }
})();

/**
 * **届き方を荒らす** (ライブの貯め方の E2E。`50-live-pacing.spec.ts`)。目印のファイルに JSON で書く。空なら一定に流す:
 *
 * - `gapEvery` [最短, 最長] (秒) と `gapMs` [最短, 最長] (ms) … ときどき長く空ける (空いた間のぶんは後でまとめて出す)。
 *   回線や中継がたまに詰まる経路のまね (#1210)
 * - `gapFirst` (秒) … 最初に空ける時刻 (流し始めてから)。省けば `gapEvery` の間から選ぶ。
 *   空きを何回か通すのに、最初の空きまで待たずに済ませる (`51-live-gaps`)
 * - `burstMs` [最短, 最長] (ms) … いつも束にして出す。届き方が荒い経路のまね
 * - `audioFirst` … 音声が映像より先に始まる作り置き (`live-h264-audio-first.mp4`。H.264 だけ) を流す。本物の ffmpeg が
 *   途中から読んだ放送で作るときのように、最初の塊が音声だけで、映像のキーフレームは次の塊に入る (`ts/key-gate.ts`)。
 *   作り方は上の H.264 に `-itsoffset 0.1` (映像の入力の前) を足したもの
 * - `headStartMs` (ms) … 先頭のこの尺ぶんを、待たずにまとめて出す。本物の ffmpeg は立ち上がりで読み込んだぶんを
 *   一度に出すので、選局の直後は貯まりが狙いより多く、画面はすぐ速めにかかる (`pacing`)
 * - `clock` … 入口の TS の最初の PCR を、本物の ffmpeg と同じ見出し (`start:`) で出す。サーバが時計 (`clock` の通知) を配り、
 *   画面は別の ffmpeg がエンコードした段どうしの位置を突き合わせられる (`69-live-handoff.spec.ts`)
 */
interface Rough {
  gapEvery?: [number, number];
  gapFirst?: number;
  gapMs?: [number, number];
  burstMs?: [number, number];
  audioFirst?: boolean;
  headStartMs?: number;
  clock?: boolean;
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
wantClock = rough.clock === true;
const between = ([low, high]: [number, number]) =>
  low + Math.random() * (high - low);
/** 次に長く空ける時刻 (ms) */
let nextGap =
  rough.gapEvery === undefined
    ? Number.POSITIVE_INFINITY
    : (rough.gapFirst ?? between(rough.gapEvery)) * 1000;
/** この時刻 (ms) までは出さずに溜める */
let holdUntil = 0;
const held: Uint8Array[] = [];

const source = process.argv[2] ?? "";
const clip = readClip(
  new Uint8Array(
    readFileSync(
      rough.audioFirst === true
        ? source.replace(/\.mp4$/, "-audio-first.mp4")
        : source,
    ),
  ),
);

const out = Bun.stdout.writer();
out.write(clip.head);
await out.flush();

// 先頭のぶんは、その尺だけ前に始めていたことにして待たずに出す
const started = performance.now() - (rough.headStartMs ?? 0);
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
