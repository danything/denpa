/**
 * **同梱の ffprobe が、denpa が読む形式を読めるか** (tests/native-smoke.ts が呼ぶ。Windows と Mac の配布物)。
 *
 * Windows と Mac の ffprobe は、ffmpeg とは別に読む部品 (デコーダ・デマクサ・パーサ・bsf) だけで組んでいる
 * (.github/ffmpeg-windows.sh・.github/ffmpeg-macos.sh)。部品の一覧が ffmpeg と同じかは組むときに比べているので、
 * ここでは本物のファイルを denpa と同じ引数で読ませる。
 *
 * - 放送と同じ形の TS (HEVC Main10・AAC・ARIB 字幕) を組み立て、m2ts (192 バイトのパケット) にもする。
 *   素材の HEVC は `@danything/arib/synth-mmt-av` のもの (64x64・16 コマ)。同梱の ffmpeg は HEVC をソフトウェアで
 *   エンコードできない (GPU だけ) ので、ffmpeg を通さずにパケットに詰める
 * - 同梱の ffmpeg で mkv (字幕は S_ARIBSUB)・mp4・fMP4 に写す (`-c copy`)
 * - native-smoke.ts が作った MPEG-2 の TS、H.264 と AV1 (Opus) の mkv、ライブの fMP4、チャプターの付いた mkv も読む
 *
 * 読み方は 3 つ。`playback.probeMedia` の `-show_streams -show_format` (JSON)、`cm.probeLeadIn` の `-show_frames`
 * (映像をデコードして最初のコマの時刻を出す)、チャプターの API の `-show_chapters`。どれも `-v error` で、
 * 標準エラーに何か出たら止める
 */

import { concatBytes } from "../packages/arib/src/bytes.ts";
import {
  AUDIO_TICKS,
  packetizePes,
  pes,
  silentAac,
} from "../packages/arib/src/synth-av.ts";
import {
  encodeAribText,
  management,
  text,
} from "../packages/arib/src/synth-caption.ts";
import {
  base64Bytes,
  HEVC,
  hevcPictures,
  VIDEO_TIMES,
} from "../packages/arib/src/synth-mmt-av.ts";
import {
  captionDescriptors,
  packetize,
  patSection,
  programMap,
} from "../packages/arib/src/synth.ts";

const PMT_PID = 0x1f0;
const VIDEO_PID = 0x100;
const AUDIO_PID = 0x110;
const CAPTION_PID = 0x130;
/** 時刻の始まり (90kHz)。素材の DTS は負から始まるので、1 秒ずらす */
const BASE = 90_000;

/** PES の PTS・DTS の 5 バイト。`prefix` は 0x3 (DTS の付いた PTS) / 0x1 (DTS) */
function stamp(prefix: number, t: number): number[] {
  return [
    (prefix << 4) | ((Math.floor(t / 2 ** 30) & 0x07) << 1) | 1,
    (t >> 22) & 0xff,
    (((t >> 15) & 0x7f) << 1) | 1,
    (t >> 7) & 0xff,
    ((t & 0x7f) << 1) | 1,
  ];
}

/** 映像の PES (PTS と DTS。B ピクチャがあるので DTS も書く)。長さは 0 (放送と同じ) */
function videoPes(pts: number, dts: number, data: Uint8Array): Uint8Array {
  return concatBytes([
    Uint8Array.from([
      0x00,
      0x00,
      0x01,
      0xe0,
      0x00,
      0x00,
      0x80,
      0xc0,
      10,
      ...stamp(0x3, pts),
      ...stamp(0x1, dts),
    ]),
    data,
  ]);
}

/** HEVC Main10・AAC (ADTS)・ARIB 字幕の TS。映像の PID に PCR を載せる */
function hevcTs(): Uint8Array {
  const pictures = hevcPictures(base64Bytes(HEVC));
  /** [時刻 (DTS), PID, PES, PCR を載せるか] */
  const units: [number, number, Uint8Array, boolean][] = [];
  pictures.forEach((nals, i) => {
    // 素材の時刻は 180000 の単位なので 90kHz に直す
    const [pts, dts] = VIDEO_TIMES[i]!.map((t) => BASE + Math.round(t / 2));
    const data = concatBytes(
      nals.map((nal) => concatBytes([Uint8Array.of(0, 0, 0, 1), nal])),
    );
    units.push([dts!, VIDEO_PID, videoPes(pts!, dts!, data), true]);
  });
  const end = BASE + Math.round(VIDEO_TIMES.at(-1)![0] / 2);
  for (let t = BASE; t <= end; t += AUDIO_TICKS)
    units.push([t, AUDIO_PID, pes(0xc0, t, silentAac()), false]);
  units.push([BASE, CAPTION_PID, pes(0xbd, BASE, management()), false]);
  units.push([
    BASE + 3003,
    CAPTION_PID,
    pes(0xbd, BASE + 3003, text(encodeAribText("字幕"))),
    false,
  ]);
  units.sort((a, b) => a[0] - b[0]);

  const parts = [
    packetize(0x0000, patSection([[1, PMT_PID]])),
    packetize(
      PMT_PID,
      programMap(1, VIDEO_PID, [
        [0x24, VIDEO_PID],
        [0x0f, AUDIO_PID],
        [0x06, CAPTION_PID, captionDescriptors()],
      ]),
    ),
  ];
  const counters = new Map<number, number>();
  for (const [at, pid, data, pcr] of units) {
    const out = packetizePes(
      pid,
      data,
      counters.get(pid) ?? 0,
      pcr ? at - 4500 : null,
    );
    counters.set(pid, out.counter);
    parts.push(out.packets);
  }
  return concatBytes(parts);
}

/** TS を m2ts (パケットごとに 4 バイトの到着時刻を前に付けた 192 バイト) にする */
function m2ts(ts: Uint8Array): Uint8Array {
  const count = ts.length / 188;
  const out = new Uint8Array(count * 192);
  for (let i = 0; i < count; i++) {
    // 27MHz の到着時刻 (30 ビット)。コピー制御の 2 ビットは 0
    const arrival = (i * 2700) & 0x3fffffff;
    out.set(
      [
        arrival >>> 24,
        (arrival >> 16) & 0xff,
        (arrival >> 8) & 0xff,
        arrival & 0xff,
      ],
      i * 192,
    );
    out.set(ts.subarray(i * 188, (i + 1) * 188), i * 192 + 4);
  }
  return out;
}

interface Stream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  channels?: number;
}

/** 読めたものとして求める中身 */
interface Want {
  video: string;
  /** 映像の profile と画素の形式 (HEVC Main10・AV1 の 10 ビット) */
  profile?: string;
  pixFmt?: string;
  audio: string;
  /** 音声の数 (2 ヶ国語を分けた mkv は 2 本) */
  audios?: number;
  /** ARIB 字幕が入っているか */
  caption?: boolean;
  /** チャプターの数 */
  chapters?: number;
}

/** ffprobe を `-v error` で起こす。落ちたか標準エラーに何か出たら止める */
function ffprobe(bin: string, args: string[]): string {
  const run = Bun.spawnSync([bin, "-v", "error", ...args]);
  const err = run.stderr.toString().trim();
  if (run.exitCode !== 0 || err !== "")
    throw new Error(`ffprobe ${args.join(" ")}\n${err}`);
  return run.stdout.toString();
}

function check(bin: string, file: string, want: Want): void {
  const name = file.split(/[\\/]/).at(-1);
  const fail = (what: string) => {
    throw new Error(`ffprobe が ${name} を読めません: ${what}`);
  };
  // playback.probeMedia と同じ引数
  const probed = JSON.parse(
    ffprobe(bin, [
      "-show_streams",
      "-show_format",
      "-print_format",
      "json",
      file,
    ]),
  ) as { streams?: Stream[]; format?: { duration?: string } };
  const streams = probed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (video?.codec_name !== want.video)
    fail(`映像が ${video?.codec_name} (${want.video} のはず)`);
  if (want.profile !== undefined && video?.profile !== want.profile)
    fail(`映像の profile が ${video?.profile} (${want.profile} のはず)`);
  if (want.pixFmt !== undefined && video?.pix_fmt !== want.pixFmt)
    fail(`映像の画素の形式が ${video?.pix_fmt} (${want.pixFmt} のはず)`);
  const audios = streams.filter((s) => s.codec_type === "audio");
  if (audios.length !== (want.audios ?? 1))
    fail(`音声が ${audios.length} 本 (${want.audios ?? 1} 本のはず)`);
  for (const audio of audios) {
    if (audio.codec_name !== want.audio)
      fail(`音声が ${audio.codec_name} (${want.audio} のはず)`);
    // 音声のチャンネル数 (cm.probeLiveAudio が中身のある音声を見分ける)。デコードして初めて分かる
    if ((audio.channels ?? 0) <= 0) fail("音声のチャンネル数が 0");
  }
  const caption = streams.some(
    (s) => s.codec_type === "subtitle" && s.codec_name === "arib_caption",
  );
  if (caption !== (want.caption ?? false))
    fail(`ARIB 字幕が${caption ? "あります" : "ありません"}`);
  if (!(Number(probed.format?.duration) > 0))
    fail(`尺が ${probed.format?.duration}`);

  // cm.probeLeadIn と同じ引数。映像をデコードして、最初のコマの時刻を出す
  const frames = ffprobe(bin, [
    "-select_streams",
    "v:0",
    "-show_frames",
    "-read_intervals",
    "%+6",
    "-show_entries",
    "frame=best_effort_timestamp_time",
    "-of",
    "default=nw=1",
    file,
  ]);
  if (!/^best_effort_timestamp_time=-?[\d.]+/m.test(frames))
    fail("映像のコマをデコードできません");

  if (want.chapters !== undefined) {
    // チャプターの API (routes/api/recordings/[id]/chapters) と同じ引数
    const chapters = JSON.parse(
      ffprobe(bin, ["-show_chapters", "-print_format", "json", file]),
    ) as { chapters?: unknown[] };
    if (chapters.chapters?.length !== want.chapters)
      fail(
        `チャプターが ${chapters.chapters?.length} 個 (${want.chapters} 個のはず)`,
      );
  }
  console.log(`ffprobe ${name}: ok`);
}

/**
 * @param ff 同梱の ffmpeg を起こす (native-smoke.ts の `ff`。標準エラーに何か出たら止める)
 * @param at 作業場所のファイルのパス。native-smoke.ts が作ったものも同じ場所にある
 */
export async function probeSmoke(
  bin: string,
  ff: (...args: string[]) => Promise<void>,
  at: (name: string) => string,
): Promise<void> {
  const ts = hevcTs();
  await Bun.write(at("hevc.ts"), ts);
  await Bun.write(at("hevc.m2ts"), m2ts(ts));
  // 字幕はそのまま写す (encoder.ts と同じ。Matroska では S_ARIBSUB)。mp4 は ARIB 字幕を持てない
  await ff(
    "-i",
    at("hevc.ts"),
    "-map",
    "0",
    "-c",
    "copy",
    "-f",
    "matroska",
    at("hevc.mkv"),
  );
  const mp4 = [
    "-i",
    at("hevc.ts"),
    "-map",
    "0:v",
    "-map",
    "0:a",
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    "-tag:v",
    "hvc1",
    "-f",
    "mp4",
  ];
  await ff(...mp4, at("hevc.mp4"));
  await ff(
    ...mp4,
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    at("hevc-frag.mp4"),
  );

  const hevc = {
    video: "hevc",
    profile: "Main 10",
    pixFmt: "yuv420p10le",
    audio: "aac",
  };
  check(bin, at("hevc.ts"), { ...hevc, caption: true });
  check(bin, at("hevc.m2ts"), { ...hevc, caption: true });
  check(bin, at("hevc.mkv"), { ...hevc, caption: true });
  check(bin, at("hevc.mp4"), hevc);
  check(bin, at("hevc-frag.mp4"), hevc);
  check(bin, at("in.ts"), { video: "mpeg2video", audio: "aac" });
  check(bin, at("h264.mkv"), { video: "h264", audio: "opus", audios: 2 });
  check(bin, at("chapters.mkv"), {
    video: "h264",
    audio: "opus",
    audios: 2,
    chapters: 1,
  });
  check(bin, at("av1.mkv"), {
    video: "av1",
    pixFmt: "yuv420p10le",
    audio: "opus",
  });
  check(bin, at("live.mp4"), { video: "h264", audio: "aac" });
}
