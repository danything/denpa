/**
 * 詰め替えを確かめる録画と、詰め替えた fMP4 を作る (Linux のランナーで回す。`.github/workflows/webkit-remux.yml`)。
 *
 *     bun tests/webkit-remux/make.ts <録画の種類> <出力先>
 *
 * 1. 作り物の映像 (1080p59.94・150 秒・AAC) を x264・x265 で Matroska にエンコードする
 * 2. 映像のキーフレームの印が付いたコマを全部並べ、NAL の種類と `cleanStart` の答えを書く
 * 3. 開く位置ごとに、v2.50.0 の動き (`cleanFrom` を通さない) と v2.51.0 の動き (通す) で `copyArgs` の ffmpeg を回し、
 *    出力の先頭 `LIMIT` バイトを fMP4 として残す
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { loadCues, loadMkvHead, MkvDemuxer } from "#lib/ts/mkv-media.js";
import { cleanStart, nalLengthSize, sliceType } from "#lib/ts/random-access.js";

import { cleanFrom } from "../../src/lib/server/clean-start";
import { copyArgs, mediaInfo } from "../../src/lib/server/playback";

const [variant, outRoot] = process.argv.slice(2);
if (variant === undefined || outRoot === undefined)
  throw new Error("使い方: make.ts <録画の種類> <出力先>");

/** 長さ (秒)。手元で短く試すときは `DURATION` で替える */
const DURATION = Number(process.env["DURATION"] ?? 150);
/** 途中の IDR を置く位置 (秒)。録画の種類によっては、ここと先頭だけが IDR */
const IDR_AT = 70;
/** 残す fMP4 の大きさ (バイト)。4 Mbit/s でおよそ 48 秒 (v2.51.0 が 30 秒手前の IDR から送っても、開く位置の先まで入る) */
const LIMIT = 24 * 1024 * 1024;
/**
 * 開く位置 (秒)。30.3 は手前 60 秒に先頭の IDR、100.3 は 70 秒の IDR がある。140.3 は手前 60 秒に IDR が無い
 * (途中のキーフレームが IDR でない録画のとき)
 */
const POSITIONS = [0, 30.3, 100.3, 140.3];

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
          clean: cleanStart(
            spec.codec,
            lengthSize,
            frame.data,
            frames[i + 1]?.data ?? null,
          ),
        },
      ]
    : [],
);
console.log(
  `${variant}: キーフレーム ${keys.length} (IDR として始められるもの ${keys.filter((k) => k.clean).length})、Cues ${cues.length}`,
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
  version: "v2.50.0" | "v2.51.0" | "both";
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

async function remux(
  pos: number,
  version: Made["version"],
  from: number,
): Promise<void> {
  const name = `${String(pos).replace(".", "_")}-${version}.mp4`;
  const args = copyArgs(mkv, from, 0, spec!.codec);
  // 出力先 (`pipe:1`) をファイルに替え、`-fs` で LIMIT バイトのところで止める
  if (args.at(-1) !== "pipe:1")
    throw new Error("copyArgs の出力先が pipe:1 ではありません");
  await run([
    "ffmpeg",
    ...args.slice(0, -1),
    "-fs",
    String(LIMIT),
    "-y",
    `${out}/${name}`,
  ]);
  const size = statSync(`${out}/${name}`).size;
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
  let first: Made["first"] = null;
  if (p !== undefined) {
    const pts = Number(p.pts_time);
    const match = keys.reduce<(typeof keys)[number] | null>(
      (best, k) =>
        best === null || Math.abs(k.time - pts) < Math.abs(best.time - pts)
          ? k
          : best,
      null,
    );
    const near = match !== null && Math.abs(match.time - pts) < 0.1;
    first = {
      pts,
      dts: Number(p.dts_time),
      type: near ? match.type : null,
      clean: near ? match.clean : null,
    };
  }
  made.push({
    variant: variant!,
    codec: spec!.codec,
    codecs,
    pos,
    version,
    from,
    file: `${variant}/${name}`,
    bytes: size,
    first,
  });
  console.log(
    `${variant} ${pos} ${version}: -ss ${from} → 先頭 ${JSON.stringify(first)} ${size} バイト`,
  );
}

/** IDR (H.265 は IRAP) か。WebKit に「ここから始めてよい」と伝えてよいコマ */
function startable(frame: Uint8Array): boolean {
  const type = sliceType(spec!.codec, frame, lengthSize);
  if (type === null) return false;
  return spec!.codec === "h264" ? type === 5 : type >= 16 && type <= 21;
}

/**
 * **fMP4 の映像の sync の印を、IDR (IRAP) にだけ残す。** 直し方の候補を確かめるためのもの。
 * moof > traf > trun の sample_flags を書き換えるだけで、大きさは変わらない。映像はトラック 1 (`copyArgs` の `-map 0:v:0`)
 */
function fixSync(src: Uint8Array): { data: Uint8Array; cleared: number } {
  const data = src.slice();
  const view = new DataView(data.buffer);
  const type = (at: number) =>
    String.fromCharCode(...data.subarray(at + 4, at + 8));
  let cleared = 0;
  const children = (
    start: number,
    end: number,
    each: (at: number, size: number) => void,
  ) => {
    for (let at = start; at + 8 <= end;) {
      const size = view.getUint32(at);
      if (size < 8 || at + size > end) return;
      each(at, size);
      at += size;
    }
  };
  children(0, data.length, (moof, moofSize) => {
    if (type(moof) !== "moof") return;
    children(moof + 8, moof + moofSize, (traf, trafSize) => {
      if (type(traf) !== "traf") return;
      let track = 0;
      let defaultSize = 0;
      let defaultFlagsAt = -1;
      children(traf + 8, traf + trafSize, (box) => {
        if (type(box) !== "tfhd") return;
        const flags = view.getUint32(box + 8) & 0xffffff;
        track = view.getUint32(box + 12);
        let p = box + 16;
        if (flags & 0x01) p += 8;
        if (flags & 0x02) p += 4;
        if (flags & 0x08) p += 4;
        if (flags & 0x10) {
          defaultSize = view.getUint32(p);
          p += 4;
        }
        if (flags & 0x20) defaultFlagsAt = p;
      });
      if (track !== 1) return;
      children(traf + 8, traf + trafSize, (box) => {
        if (type(box) !== "trun") return;
        const flags = view.getUint32(box + 8) & 0xffffff;
        const count = view.getUint32(box + 12);
        let p = box + 16;
        let offset = 0;
        if (flags & 0x01) {
          offset = view.getInt32(p);
          p += 4;
        }
        let firstFlagsAt = -1;
        if (flags & 0x04) {
          firstFlagsAt = p;
          p += 4;
        }
        let dataAt = moof + offset;
        for (let i = 0; i < count; i++) {
          if (flags & 0x100) p += 4;
          let size = defaultSize;
          if (flags & 0x200) {
            size = view.getUint32(p);
            p += 4;
          }
          // 既定値 (tfhd の default_sample_flags) を書き換えると、同じ traf の全部のサンプルに効く。ffmpeg は
          // trun にサンプルごと (か先頭だけ) の flags を書くので、既定値に落ちるのは flags が全部同じときだけ
          let flagsAt =
            i === 0 && firstFlagsAt >= 0 ? firstFlagsAt : defaultFlagsAt;
          if (flags & 0x400) {
            flagsAt = p;
            p += 4;
          }
          if (flags & 0x800) p += 4;
          if (flagsAt >= 0 && dataAt + size <= data.length) {
            const sampleFlags = view.getUint32(flagsAt);
            const sync = (sampleFlags & 0x10000) === 0;
            if (sync && !startable(data.subarray(dataAt, dataAt + size))) {
              // sample_is_non_sync_sample を立て、sample_depends_on を「ほかを参照する」(1) にする
              view.setUint32(
                flagsAt,
                ((sampleFlags | 0x10000) & ~0x03000000) | 0x01000000,
              );
              cleared++;
            }
          }
          dataAt += size;
        }
      });
    });
  });
  return { data, cleared };
}

for (const pos of POSITIONS) {
  if (pos === 0) {
    await remux(pos, "both", 0);
    continue;
  }
  await remux(pos, "v2.50.0", pos);
  await remux(pos, "v2.51.0", await cleanFrom(mkv, pos));
}

// 直し方の候補: sync の印を IDR にだけ残したもの。外した印が無ければ同じ中身なので作らない
for (const base of [...made]) {
  const { data, cleared } = fixSync(
    new Uint8Array(readFileSync(`${outRoot}/${base.file}`)),
  );
  console.log(`${base.file}: sync の印を ${cleared} 個外しました`);
  if (cleared === 0) continue;
  const file = base.file.replace(/\.mp4$/, "+sync.mp4");
  writeFileSync(`${outRoot}/${file}`, data);
  made.push({
    ...base,
    version: `${base.version}+sync` as Made["version"],
    file,
  });
}

writeFileSync(
  `${out}/manifest.json`,
  JSON.stringify({ variant, codec: spec.codec, codecs, keys, made }, null, 2),
);
