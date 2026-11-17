/**
 * 詰め替えを確かめる録画と、詰め替えた fMP4 を作る (Linux のランナーで回す。`.github/workflows/webkit-remux.yml`)。
 *
 *     bun tests/webkit-remux/make.ts <録画の種類> <出力先>
 *
 * 1. 作り物の映像 (1080p59.94・150 秒・AAC) を x264・x265 で Matroska にエンコードする
 * 2. 映像のキーフレームの印が付いたコマを全部並べ、NAL の種類と `startable` の答えを書く
 * 3. 開く位置ごとに、2〜3 通りで fMP4 を作り、先頭 `LIMIT` バイトを残す
 *    - copy: `cleanFrom` を通さずに `copyArgs` で詰め替える (v2.50.0 までの動き)
 *    - fixed: サーバと同じ。`cleanFrom` で始める位置を決め、`ts/fmp4-marks.ts` で sync の印を直す。
 *      手前に始められるキーフレームが無ければ `fileTranscodeArgs` で変換する (GPU の無いランナーなので、ソフトウェアで。
 *      H.265 は libx265 に替える。`transcodeArgs`)
 *    - busy: 変換するところだけ。変換の枠が埋まっていたときのサーバ (観る画面の WebKit と同じく `?clean=1`) と同じく、
 *      `FAR` 秒手前までの始められるキーフレームから詰め替える (無ければサーバは 503 で断るので作らない)
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { SyncMarks } from "#lib/ts/fmp4-marks.js";
import { loadCues, loadMkvHead, MkvDemuxer } from "#lib/ts/mkv-media.js";
import { nalLengthSize, sliceType, startable } from "#lib/ts/random-access.js";

import { cleanFrom, FAR } from "../../src/lib/server/clean-start";
import {
  copyArgs,
  fileTranscodeArgs,
  mediaInfo,
} from "../../src/lib/server/playback";

const [variant, outRoot] = process.argv.slice(2);
if (variant === undefined || outRoot === undefined)
  throw new Error("使い方: make.ts <録画の種類> <出力先>");

/** 長さ (秒)。手元で短く試すときは `DURATION` で替える */
const DURATION = Number(process.env["DURATION"] ?? 150);
/** 途中の IDR を置く位置 (秒)。録画の種類によっては、ここと先頭だけが IDR */
const IDR_AT = 70;
/** 残す fMP4 の大きさ (バイト)。4 Mbit/s でおよそ 72 秒 (20 秒手前の IDR から送っても、開く位置の先まで十分に入る) */
const LIMIT = 36 * 1024 * 1024;
/**
 * 開く位置 (秒)。先頭のほかに IDR が 70 秒にしか無い録画では、手前の IDR までの間が 10・30・15・30・70 秒になる。
 * 間が 20 秒 (`clean-start.ts` の `LOOKBACK`) より長ければ変換する
 */
const POSITIONS = [0, 10.3, 30.3, 85.3, 100.3, 140.3];

const forcedIdr = ["-force_key_frames", `0,${IDR_AT}`, "-forced-idr", "1"];
const x264 = [
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-b:v",
  "4M",
  "-g",
  "250",
];
const x265 = [
  "-c:v",
  "libx265",
  "-preset",
  "ultrafast",
  "-b:v",
  "4M",
  "-g",
  "250",
];

/**
 * `keysEvery` があれば、エンコードしたあとで映像のこれだけのコマごとにキーフレームの印を付け直す (`markKeys`)。
 * MediaCodec が P のコマ (TRAIL) に印を付けた録画のふり
 */
const VARIANTS: Record<
  string,
  { codec: "h264" | "hevc"; args: string[]; keysEvery?: number }
> = {
  "h264-closed": {
    codec: "h264",
    args: [...x264, "-x264-params", "scenecut=0"],
  },
  "h264-opengop": {
    codec: "h264",
    args: [...x264, "-x264-params", "open-gop=1:scenecut=0", ...forcedIdr],
  },
  "h264-intra-refresh": {
    codec: "h264",
    args: [...x264, "-x264-params", "intra-refresh=1:scenecut=0", ...forcedIdr],
  },
  "hevc-closed": {
    codec: "hevc",
    args: [...x265, "-x265-params", "open-gop=0:scenecut=0"],
  },
  "hevc-cra-rasl": {
    codec: "hevc",
    args: [
      ...x265,
      "-x265-params",
      "open-gop=1:scenecut=0:bframes=3",
      ...forcedIdr,
    ],
  },
  "hevc-cra-norasl": {
    codec: "hevc",
    args: [
      ...x265,
      "-x265-params",
      "open-gop=1:scenecut=0:bframes=0",
      ...forcedIdr,
    ],
  },
  // 先頭のほかに IRAP が無く、途中の印は TRAIL (P) に付いている H.265 (#2884 の報告者の録画の見立て)
  "hevc-trail-keys": {
    codec: "hevc",
    args: [...x265, "-x265-params", "intra-refresh=1:scenecut=0"],
    keysEvery: 250,
  },
};

const spec = VARIANTS[variant];
if (spec === undefined) throw new Error(`知らない種類: ${variant}`);

const out = `${outRoot}/${variant}`;
mkdirSync(out, { recursive: true });
const mkv = `${out}/rec.mkv`;

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`失敗: ${cmd.join(" ")}`);
  return text;
}

/** EBML の可変長整数。`id` なら印のビットを残す。読めなければ null */
function vint(
  bytes: Uint8Array,
  at: number,
  id: boolean,
): { value: number; next: number } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  let value = id ? first : first & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i]!;
  // 大きさが「不明」(全部 1) なら、親の終わりまで
  const unknown = !id && value === 2 ** (7 * length) - 1;
  return {
    value: unknown ? Number.POSITIVE_INFINITY : value,
    next: at + length,
  };
}

/**
 * **映像の `every` コマごとにキーフレームの印を付けた Matroska を作る** (MediaCodec が P のコマに印を付けた録画のふり)。
 * SimpleBlock の印のビットを書き換えてから、ffmpeg で写し直す (Cues と Cluster の区切りを印に合わせて作り直させる)
 */
async function markKeys(raw: string, every: number): Promise<void> {
  const bytes = new Uint8Array(readFileSync(raw));
  const head = await loadMkvHead(async (offset, length) =>
    bytes.subarray(offset, offset + length),
  );
  const track = head?.tracks.find((t) => t.kind === "video")?.number;
  if (track === undefined) throw new Error("映像のトラックがありません");
  let frame = 0;
  let marked = 0;
  const walk = (start: number, end: number): void => {
    for (let at = start; at < end;) {
      const id = vint(bytes, at, true);
      const size = id === null ? null : vint(bytes, id.next, false);
      if (id === null || size === null) return;
      const bodyEnd = Math.min(end, size.next + size.value);
      if (id.value === 0x18538067 || id.value === 0x1f43b675)
        walk(size.next, bodyEnd);
      else if (id.value === 0xa3) {
        const number = vint(bytes, size.next, false);
        if (number !== null && number.value === track) {
          if (frame % every === 0 && frame > 0) {
            bytes[number.next + 2]! |= 0x80;
            marked++;
          }
          frame++;
        }
      }
      at = bodyEnd;
    }
  };
  walk(0, bytes.length);
  writeFileSync(`${raw}.marked.mkv`, bytes);
  await run([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    `${raw}.marked.mkv`,
    "-map",
    "0",
    "-c",
    "copy",
    mkv,
  ]);
  console.log(`${variant}: ${frame} コマのうち ${marked} コマに印を付けました`);
}
// 1. エンコード
const started = performance.now();
await run([
  "ffmpeg",
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=1920x1080:rate=60000/1001:duration=${DURATION}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=440:sample_rate=48000:duration=${DURATION}`,
  "-pix_fmt",
  "yuv420p",
  ...spec.args,
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-ac",
  "2",
  spec.keysEvery === undefined ? mkv : `${out}/raw.mkv`,
]);
if (spec.keysEvery !== undefined)
  await markKeys(`${out}/raw.mkv`, spec.keysEvery);
console.log(
  `${variant}: エンコード ${((performance.now() - started) / 1000).toFixed(0)} 秒`,
);

// 2. キーフレームの印の付いたコマを並べる
const bytes = new Uint8Array(readFileSync(mkv));
const read = async (offset: number, length: number) =>
  bytes.subarray(offset, offset + length);
const head = await loadMkvHead(read);
if (head === null) throw new Error("先頭が読めません");
const video = head.tracks.find((t) => t.kind === "video")!;
const lengthSize = nalLengthSize(spec.codec, video.config)!;
const cues = await loadCues(read, head, video.number);
const demuxer = new MkvDemuxer();
const frames: {
  time: number;
  key: boolean;
  type: number | null;
  data: Uint8Array;
}[] = [];
for (let at = 0; at < bytes.length; at += 1 << 20)
  for (const block of demuxer.feed(bytes.subarray(at, at + (1 << 20))).blocks)
    if (block.track === video.number)
      frames.push({
        time: (block.at * head.scale) / 1e9,
        key: block.key,
        type: sliceType(spec.codec, block.data, lengthSize),
        data: block.data,
      });
const keys = frames.flatMap((frame, i) =>
  frame.key
    ? [
        {
          time: Number(frame.time.toFixed(3)),
          type: frame.type,
          nextType: frames[i + 1]?.type ?? null,
          clean: startable(spec.codec, lengthSize, frame.data),
        },
      ]
    : [],
);
console.log(
  `${variant}: キーフレーム ${keys.length} (始められるもの ${keys.filter((k) => k.clean).length})、Cues ${cues.length}`,
);

const probe = await run([
  "ffprobe",
  "-v",
  "error",
  "-show_streams",
  "-show_format",
  "-of",
  "json",
  mkv,
]);
const info = mediaInfo({} as never, probe);
const codecs = `${info.video},mp4a.40.2`;

// 3. 詰め替え
interface Made {
  variant: string;
  codec: string;
  codecs: string;
  pos: number;
  version: "copy" | "fixed" | "busy" | "both" | "silent";
  /** fixed のときの作り方。詰め替え (印を直した・直していない) か変換 */
  how: "copy" | "marked" | "transcode";
  from: number;
  file: string;
  bytes: number;
  /** fMP4 の最初の映像のコマ (デコードの順) の時刻と、Matroska でのそのコマ */
  first: {
    pts: number;
    dts: number;
    type: number | null;
    clean: boolean | null;
  } | null;
}
const made: Made[] = [];

/** `args` (出力先が `pipe:1`) の ffmpeg を回して `name` に書く。`LIMIT` バイトで止める。`marks` があれば印を直す */
async function produce(
  args: string[],
  name: string,
  marks: { codec: "h264" | "hevc"; lengthSize: number } | null,
): Promise<number> {
  if (args.at(-1) !== "pipe:1")
    throw new Error("ffmpeg の出力先が pipe:1 ではありません");
  await run([
    "ffmpeg",
    ...args.slice(0, -1),
    "-fs",
    String(LIMIT),
    "-y",
    `${out}/${name}`,
  ]);
  if (marks === null) return 0;
  const fixer = new SyncMarks(marks.codec, marks.lengthSize);
  const parts = [
    ...fixer.push(new Uint8Array(readFileSync(`${out}/${name}`))),
    ...fixer.end(),
  ];
  writeFileSync(`${out}/${name}`, Buffer.concat(parts));
  return fixer.cleared;
}

/** fMP4 の最初の映像のコマと、Matroska でのそのコマ */
async function firstFrame(name: string): Promise<Made["first"]> {
  const packets = JSON.parse(
    await run([
      "ffprobe",
      "-v",
      "quiet",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time,dts_time,flags",
      "-read_intervals",
      "%+#1",
      "-of",
      "json",
      `${out}/${name}`,
    ]),
  ).packets as { pts_time: string; dts_time: string }[];
  const p = packets[0];
  if (p === undefined) return null;
  const pts = Number(p.pts_time);
  const match = keys.reduce<(typeof keys)[number] | null>(
    (best, k) =>
      best === null || Math.abs(k.time - pts) < Math.abs(best.time - pts)
        ? k
        : best,
    null,
  );
  const near = match !== null && Math.abs(match.time - pts) < 0.1;
  return {
    pts,
    dts: Number(p.dts_time),
    type: near ? match.type : null,
    clean: near ? match.clean : null,
  };
}

/**
 * サーバが変換するときと同じ引数 (`fileTranscodeArgs`)。H.265 はサーバでは GPU (報告者の端末なら MediaCodec) で
 * エンコードするが、ランナーには GPU が無いので、H.264 のソフトウェアの引数のエンコーダだけを libx265 に替える
 */
function transcodeArgs(from: number): string[] {
  const args = fileTranscodeArgs(
    mkv,
    from,
    0,
    "h264",
    null,
    0,
    null,
    false,
    true,
  );
  if (spec!.codec === "h264") return args;
  const at = args.indexOf("libx264");
  if (at < 1 || args[at - 1] !== "-c:v")
    throw new Error("fileTranscodeArgs に libx264 がありません");
  // -c:v libx264 -preset ultrafast -tune zerolatency を、libx265 の同じ速さの設定に替える
  const end = args.indexOf("-g", at);
  return [
    ...args.slice(0, at - 1),
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-x265-params",
    "log-level=error",
    "-tag:v",
    "hvc1",
    ...args.slice(end),
  ];
}
async function make(pos: number, version: Made["version"]): Promise<void> {
  const name = `${String(pos).replace(".", "_")}-${version}.mp4`;
  let from = pos;
  let how: Made["how"] = "copy";
  let cleared = 0;
  if (version === "copy") {
    await produce(copyArgs(mkv, pos, 0, spec!.codec), name, null);
  } else if (version === "silent") {
    // 音声の無い詰め替え (音声の何本目かに無い番号を渡すと `0:a:<n>?` が何も選ばない)。止まるのが音声のせいかを見る
    await produce(copyArgs(mkv, pos, 99, spec!.codec), name, null);
  } else {
    let start = await cleanFrom(mkv, pos);
    // 枠が埋まっている (busy)。観る画面の WebKit と同じく `?clean=1` で、FAR 秒手前までたどり直す
    if (start.missing && version === "busy") {
      const far = await cleanFrom(mkv, pos, FAR);
      // サーバは、それも無く枠が埋まっていれば 503 で断る。作るものは無い
      if (far.missing) return;
      start = far;
    }
    // 変換する。H.265 は、変換できるサーバ (#2884 の報告者の端末は MediaCodec で H.265 をエンコードできる) と同じく libx265 で
    if (start.missing) {
      how = "transcode";
      from = start.decodeFrom;
      await produce(transcodeArgs(start.decodeFrom), name, null);
    } else {
      from = start.from;
      const marks = start.missing ? null : start.marks;
      how = marks === null ? "copy" : "marked";
      cleared = await produce(
        copyArgs(mkv, start.from, 0, spec!.codec),
        name,
        marks,
      );
    }
  }
  const size = statSync(`${out}/${name}`).size;
  const first = await firstFrame(name);
  made.push({
    variant: variant!,
    codec: spec!.codec,
    codecs: version === "silent" ? (info.video ?? "") : codecs,
    pos,
    version,
    how,
    from,
    file: `${variant}/${name}`,
    bytes: size,
    first,
  });
  console.log(
    `${variant} ${pos} ${version} (${how}): -ss ${from} → 先頭 ${JSON.stringify(first)} ${size} バイト、印を ${cleared} 個外した`,
  );
}

for (const pos of POSITIONS) {
  if (pos === 0) {
    await make(pos, "both");
    continue;
  }
  await make(pos, "copy");
  await make(pos, "fixed");
  if (variant === "h264-closed") await make(pos, "silent");
  // 変換するところは、枠が埋まっていたときのもの (busy) も作る
  if ((await cleanFrom(mkv, pos)).missing) await make(pos, "busy");
}

writeFileSync(
  `${out}/manifest.json`,
  JSON.stringify({ variant, codec: spec.codec, codecs, keys, made }, null, 2),
);
