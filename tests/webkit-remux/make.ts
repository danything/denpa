/**
 * 詰め替えを確かめる録画と、詰め替えた fMP4 を作る (Linux のランナーで回す。`.github/workflows/webkit-remux.yml`)。
 *
 *     bun tests/webkit-remux/make.ts <録画の種類> <出力先>
 *
 * 1. 作り物の映像 (1080p59.94・150 秒・AAC) を x264・x265 で Matroska にエンコードする
 * 2. 映像のキーフレームの印が付いたコマを全部並べ、NAL の種類と `startable` の答えを書く
 * 3. 開く位置ごとに、2 通りで fMP4 を作り、先頭 `LIMIT` バイトを残す
 *    - copy: `cleanFrom` を通さずに `copyArgs` で詰め替える (v2.50.0 までの動き)
 *    - fixed: サーバと同じ。`cleanFrom` で始める位置を決め、`ts/fmp4-marks.ts` で sync の印を直す。
 *      手前に始められるキーフレームが無ければ `fileTranscodeArgs` で変換する (GPU の無いランナーなので H.264 はソフトウェア。
 *      H.265 は変換できないので、サーバと同じく印を直さずに詰め替える)
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { SyncMarks } from "#lib/ts/fmp4-marks.js";
import { loadCues, loadMkvHead, MkvDemuxer } from "#lib/ts/mkv-media.js";
import { nalLengthSize, sliceType, startable } from "#lib/ts/random-access.js";

import { cleanFrom } from "../../src/lib/server/clean-start";
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

const VARIANTS: Record<string, { codec: "h264" | "hevc"; args: string[] }> = {
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
  mkv,
]);
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
  version: "copy" | "fixed" | "both";
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

async function make(pos: number, version: Made["version"]): Promise<void> {
  const name = `${String(pos).replace(".", "_")}-${version}.mp4`;
  let from = pos;
  let how: Made["how"] = "copy";
  let cleared = 0;
  if (version === "copy") {
    await produce(copyArgs(mkv, pos, 0, spec!.codec), name, null);
  } else {
    const start = await cleanFrom(mkv, pos);
    if (start.missing && spec!.codec === "h264") {
      how = "transcode";
      from = start.decodeFrom;
      await produce(
        fileTranscodeArgs(mkv, start.decodeFrom, 0, spec!.codec, null),
        name,
        null,
      );
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
    codecs,
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
}

writeFileSync(
  `${out}/manifest.json`,
  JSON.stringify({ variant, codec: spec.codec, codecs, keys, made }, null, 2),
);
