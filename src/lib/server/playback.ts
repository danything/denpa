/**
 * **録画の観方を決めて、流す** (`GET /api/recordings/<id>/playback` と `/stream`。取り決めは `ts/playback.ts`)。
 *
 * サーバが決めるのは「何を出せるか・どの形式で出すか・時刻の物差し」まで。どれを使うかは画面が決める
 * (端末で再生できるか、人が選んだコーデック)。サーバは端末が何かを知らない。
 *
 * ## 何を出すか
 *
 * | 録画にあるもの | 求められた形式 | 出し方 |
 * | --- | --- | --- |
 * | エンコード済み (同じコーデック) | H.264 / AV1 | ファイルそのまま (`file`)。そのまま読めない端末には詰め替え (`stream`、映像は写すだけ) |
 * | エンコード済み (違うコーデック) | H.264 / AV1 | **エンコード済みを元に**その場で変換 (`stream`) |
 * | 元の TS だけ | H.264 / AV1 | TS からその場で変換 (`stream`) |
 * | 元の TS | MPEG-2 | TS を飛び先から流す (`raw`。画面が自分で再生する) |
 * | エンコード済みだけ | MPEG-2 | 出さない |
 * | CM を切ってエンコードした録画 | MPEG-2 | 出さない (時刻が合わない) |
 *
 * 時刻の物差しは 1 ページで 1 つ (`PlayAxis`): エンコード済みがあればその時刻、無ければ元の TS の頭を 0。
 * どの出し方でもストリームの時刻はこの物差しに乗せる — 字幕・チャプター・データ放送・続きの位置を
 * `currentTime` のまま引けるようにするため。
 *
 * ## 飛び方
 *
 * - **エンコード済みが元** … `-ss <from> -copyts`。ファイルの時刻のまま出す (詰め替えの話は `copyArgs`)
 * - **TS が元** … 時刻からバイトの位置を引いて (`ts/seek.ts` の二分探索)、そこから ffmpeg の標準入力へ
 *   流し込む。出口の時刻は `-copyts` と `-output_ts_offset` で物差しに合わせる (`tsOffset`)
 *
 * ## 枠
 *
 * その場で変換するもの (映像をエンコードし直す) は枠を 1 つ使う (`transcode.ts`)。埋まっていたら
 * 503。詰め替え・元の TS をそのまま流すのは軽いので数えない。**読まれずに詰まった ffmpeg は
 * 5 分で畳む** (止めたまま放っておかれた画面のぶんの枠を返すため)
 */

import { existsSync, statSync } from "node:fs";
import { error } from "@sveltejs/kit";
import {
  type AudioTrack,
  audioTracks,
  parseAudios,
  pickTrack,
} from "#lib/arib.js";
import type { LiveCodec } from "#lib/live.js";
import type { FileSource } from "#lib/source.js";
import { CLOCK, WRAP } from "#lib/ts/pes.js";
import {
  BUSY,
  type EncodedSource,
  ORIGIN_HEADER,
  type PlayAudio,
  type PlaybackInfo,
  type PlayCodec,
  type PlayOffer,
} from "#lib/ts/playback.js";
import {
  lastVideoPts,
  type ReadAt,
  seekTs,
  sinceHead,
  tsHead,
} from "#lib/ts/seek.js";
import { fromTsTime, type Ruler } from "#lib/ts/watch.js";
import type { Recording } from "#lib/types.js";
import { programSpec } from "./captions";
import { chapterList } from "./cm";
import { config } from "./config";
import type { LiveHw } from "./hwenc";
import {
  aribServiceId,
  audioArgs,
  blameLiveHw,
  codecsFor,
  panArgs,
  pickLiveHw,
  videoArgs,
} from "./live";
import { settings } from "./settings";
import { endInput, run } from "./stream";
import { holdTranscode } from "./transcode";

/** エンコード済みのファイル 1 本の中身 (ffprobe で読む。`probeMedia`) */
export interface MediaFile {
  source: EncodedSource;
  /** 映像の codecs 文字列 (`avc1.640028` / `av01.0.08M.08`)。読めない・無ければ null */
  video: string | null;
  /** 音声の codecs 文字列 (`opus` / `mp4a.40.2`)。読めない・無ければ null */
  audio: string | null;
  /** 音声トラックの名前 (入れ物の title)。無名は空文字 */
  audios: string[];
  /** 尺 (秒)。読めなければ null */
  duration: number | null;
}

interface ProbedStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  pix_fmt?: string;
  tags?: { title?: string; TITLE?: string };
}

/** H.264 の profile 名 → codecs の頭 (profile_idc と制約の印) */
const AVC_PROFILES: Record<string, string> = {
  Baseline: "4200",
  "Constrained Baseline": "42e0",
  Main: "4d00",
  Extended: "5800",
  High: "6400",
  "High 10": "6e00",
  "High 4:2:2": "7a00",
  "High 4:4:4 Predictive": "f400",
};
const AV1_PROFILES: Record<string, number> = {
  Main: 0,
  High: 1,
  Professional: 2,
};

/** 映像の codecs 文字列。知らないものは null (判断に使わない) */
function videoCodec(stream: ProbedStream | undefined): string | null {
  if (stream === undefined) return null;
  const level =
    typeof stream.level === "number" && stream.level > 0 ? stream.level : null;
  if (stream.codec_name === "h264") {
    const head = AVC_PROFILES[stream.profile ?? ""] ?? "6400";
    return `avc1.${head}${(level ?? 40).toString(16).padStart(2, "0")}`;
  }
  if (stream.codec_name === "av1") {
    const profile = AV1_PROFILES[stream.profile ?? ""] ?? 0;
    const depth = /10/.test(stream.pix_fmt ?? "") ? "10" : "08";
    // tier は ffprobe が言わない。放送の再エンコードは Main tier
    return `av01.${profile}.${String(level ?? 8).padStart(2, "0")}M.${depth}`;
  }
  return null;
}

/** 音声の codecs 文字列 */
function audioCodec(stream: ProbedStream | undefined): string | null {
  if (stream?.codec_name === "opus") return "opus";
  if (stream?.codec_name === "aac") return "mp4a.40.2";
  return null;
}

/** ffprobe (`-show_streams -show_format` の JSON) から中身を起こす。読めなければ全部 null */
export function mediaInfo(source: EncodedSource, json: string): MediaFile {
  let parsed: { streams?: ProbedStream[]; format?: { duration?: string } } = {};
  try {
    parsed = JSON.parse(json);
  } catch {
    // 読めない。判断に使わない形式で返す
  }
  const streams = parsed.streams ?? [];
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  const duration = Number(parsed.format?.duration);
  return {
    source,
    video: videoCodec(streams.find((stream) => stream.codec_type === "video")),
    audio: audioCodec(audios[0]),
    audios: audios.map(
      (stream) => stream.tags?.title ?? stream.tags?.TITLE ?? "",
    ),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

/** 待ち時間の上限。壊れたファイルで居座らせない */
const TIMEOUT = 15_000;

/** 読んだ中身の控え。開くたびに聞くので、同じファイル (パスと更新時刻) なら読み直さない */
const probed = new Map<string, { mtime: number; file: MediaFile }>();
/** 控えの上限。古いものから捨てる */
const KEEP = 64;

/** 控えに入れる。新しいものを後ろに置き、上限を超えたら古いもの (頭) から捨てる */
function keep<T>(memo: Map<string, T>, path: string, value: T): void {
  memo.delete(path);
  memo.set(path, value);
  if (memo.size > KEEP) memo.delete(memo.keys().next().value as string);
}

/** エンコードしたファイルの中身を読む (見出しだけ。一瞬で返る) */
async function probeMedia(
  source: EncodedSource,
  path: string,
): Promise<MediaFile> {
  let mtime = -1;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // 無い。読んでも同じなので null で返る
  }
  const held = probed.get(path);
  if (held !== undefined && held.mtime === mtime)
    return { ...held.file, source };
  const result = await run(
    [
      config.ffprobe,
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-print_format",
      "json",
      path,
    ],
    { timeoutMs: TIMEOUT, stdout: true },
  );
  const file = mediaInfo(
    source,
    result.code === 0 ? new TextDecoder().decode(result.stdout) : "",
  );
  if (result.code === 0) keep(probed, path, { mtime, file });
  return file;
}
/** エンコード済みのファイル 1 本 */
interface EncodedFile {
  source: EncodedSource;
  path: string;
  /** 中身から読んだコーデック。読めなければ null */
  codec: LiveCodec | null;
  media: MediaFile;
}

/** 元の TS */
interface TsFile {
  path: string;
  size: number;
  /** 入れ物の始まり (90kHz。`ts/seek.ts` の `tsHead`) */
  head: number;
  /** 頭から尻の映像まで (秒)。読めなければ null */
  duration: number | null;
}

/** 決めたこと。画面へ渡すもの (`info`) と、流すときに要るもの */
export interface PlaybackPlan {
  info: PlaybackInfo;
  encoded: EncodedFile[];
  /** 元の TS。録り終えていて、読めるときだけ */
  ts: TsFile | null;
  /** 物差しの 0 が、TS の頭から何秒か (`encode_skip`)。TS が物差しなら 0 */
  skip: number;
  /** TS の音声 (`arib.audioTracks`)。TS から変換するときに使う */
  tracks: AudioTrack[];
  /** ffmpeg に名指しさせる放送の番号 */
  program: number;
}

/** 中身の codecs (映像) からコーデックを読む */
function codecOf(video: string | null): LiveCodec | null {
  if (video?.startsWith("avc1") === true) return "h264";
  if (video?.startsWith("av01") === true) return "av1";
  return null;
}

/** fMP4 にしたときの音声の codecs。H.264 は AAC、AV1 は Opus (ライブと同じ組。`live.audioArgs`) */
function streamAudio(codec: LiveCodec): string {
  return codec === "av1" ? "opus" : "mp4a.40.2";
}

/** 変換したときの codecs (`live.codecsFor` の中身) */
function transcodedCodecs(codec: LiveCodec): string {
  return /codecs="([^"]+)"/.exec(codecsFor(codec))?.[1] ?? "";
}

/** ファイルを少しずつ読むリーダー (`ts/seek.ts`) */
function reader(path: string): ReadAt {
  return async (offset, length) =>
    new Uint8Array(
      await Bun.file(path)
        .slice(offset, offset + length)
        .arrayBuffer(),
    );
}

/** 頭と尻を読む量。頭は映像と音声の最初の PES が必ず入る長さ、尻は最後の映像の PES が入る長さ */
const PROBE_BYTES = 4 * 1024 * 1024;

/** 読んだ TS の控え。開くたびに聞くので、同じファイル (パス・大きさ・更新時刻) なら読み直さない */
const tsProbed = new Map<string, { key: string; ts: TsFile | null }>();

/** 元の TS の頭と尺を読む。読めなければ null */
async function probeTs(path: string): Promise<TsFile | null> {
  let size = 0;
  let mtime = 0;
  try {
    const stat = statSync(path);
    size = stat.size;
    mtime = stat.mtimeMs;
  } catch {
    return null;
  }
  if (size === 0) return null;
  const key = `${size}:${mtime}`;
  const held = tsProbed.get(path);
  if (held?.key === key) return held.ts;
  const read = reader(path);
  const head = tsHead(await read(0, PROBE_BYTES));
  let ts: TsFile | null = null;
  if (head !== null) {
    const last = lastVideoPts(
      await read(Math.max(0, size - PROBE_BYTES), PROBE_BYTES),
    );
    const duration = last === null ? null : sinceHead(last, head);
    ts = {
      path,
      size,
      head,
      duration: duration !== null && duration > 0 ? duration : null,
    };
  }
  keep(tsProbed, path, { key, ts });
  return ts;
}

/** 録画の尺 (秒)。番組表の尺ではなく録れた長さ。古い行は予定の長さ */
function recordedSec(recording: Recording): number {
  return (
    (recording.duration_ms ?? recording.end_at - recording.start_at) / 1000
  );
}

/**
 * **何を出せるかを決める。** エンコード済みも元の TS も無ければ null。
 *
 * ffprobe が中身を読めなかったエンコード済み (ffprobe が無い・壊れている) は、いまの設定の
 * コーデックでエンコードしたものとみなしてファイルだけ出す (詰め替えも変換も、中身が分からないと組めない)
 */
export async function playbackPlan(
  recording: Recording,
): Promise<PlaybackPlan | null> {
  const guessed = settings().codecs;
  const files = (
    [
      ["encoded", recording.library_path],
      ["alt", recording.alt_path],
    ] as const
  ).filter(
    (entry): entry is readonly [EncodedSource, string] =>
      entry[1]?.endsWith(".mkv") === true && existsSync(entry[1]),
  );
  const encoded: EncodedFile[] = await Promise.all(
    files.map(async ([source, path]) => {
      const media = await probeMedia(source, path);
      return { source, path, codec: codecOf(media.video), media };
    }),
  );

  // エンコードせずに置いた録画 (「エンコードしない」) は、置き場の TS が元の TS そのもの
  const tsPath = tsPathOf(recording);
  // 録っている最中の TS は伸びている。追っかけ再生 (`/chase`) の受け持ち
  const ts =
    tsPath !== null && recording.finished_at !== null
      ? await probeTs(tsPath)
      : null;
  if (encoded.length === 0 && ts === null) return null;

  const axis = encoded.length > 0 ? "encoded" : "ts";
  const skip = axis === "encoded" ? (recording.encode_skip ?? 0) : 0;
  const known = encoded.filter((file) => file.codec !== null);

  const offers: PlayOffer[] = [];
  encoded.forEach((file, index) => {
    const codec: PlayCodec =
      file.codec ?? guessed[index] ?? (index === 0 ? "av1" : "h264");
    const codecs =
      file.media.video === null
        ? undefined
        : file.media.audio === null
          ? file.media.video
          : `${file.media.video},${file.media.audio}`;
    offers.push({
      codec,
      way: "file",
      source: file.source,
      ...(codecs === undefined ? {} : { codecs }),
    });
  });
  for (const codec of ["h264", "av1"] as const) {
    const same = known.find((file) => file.codec === codec);
    if (same !== undefined) {
      offers.push({
        codec,
        way: "stream",
        codecs: `${same.media.video},${streamAudio(codec)}`,
      });
    } else if (known.length > 0 || (encoded.length === 0 && ts !== null)) {
      offers.push({ codec, way: "stream", codecs: transcodedCodecs(codec) });
    }
  }
  /*
   * MPEG-2 は元の TS の時刻をそのまま運ぶので、物差しに乗せられるときだけ。CM を切ったものは
   * 途中が詰まっていて合わない。捨てた頭を覚えていない古い録画も合わせようがない
   */
  if (
    ts !== null &&
    recording.cm_kept === null &&
    (axis === "ts" || recording.encode_skip !== null)
  ) {
    offers.push({ codec: "mpeg2", way: "raw" });
  }

  const tracks = audioTracks(parseAudios(recording));
  const audios: PlayAudio[] =
    axis === "encoded"
      ? (encoded[0]?.media.audios ?? []).map((label, index) => ({
          id: String(index),
          label,
        }))
      : tracks.map((track) => ({ id: track.id, label: track.label }));
  const duration =
    axis === "encoded"
      ? (encoded[0]?.media.duration ??
        Math.max(0, recordedSec(recording) - skip))
      : (ts?.duration ?? recordedSec(recording));

  return {
    info: { duration, axis, audios, offers },
    encoded,
    ts,
    skip,
    tracks,
    program: aribServiceId(recording.service_id),
  };
}

/** 失敗の理由だけ出させる (`transcodeBody` がログへ回す) */
const QUIET = ["-hide_banner", "-nostats", "-loglevel", "error"];

/** 詰め替えの共通の出口。時刻はそのまま書かせる (`copyArgs` の説明) */
const FMP4_OUT = [
  "-f",
  "mp4",
  "-movflags",
  "+empty_moov+default_base_moof+frag_discont+negative_cts_offsets",
  // 1秒ずつ。キーフレームごと (数秒) だと、頭の映像が出るまでそのぶん待つ
  "-frag_duration",
  "1000000",
  "pipe:1",
];

/**
 * **エンコード済みを詰め替える引数** (映像は写すだけ。音声は H.264 なら AAC、AV1 なら Opus)。
 * `audio` は入れ物の中の何本目の音声か (主・副で分けてエンコードしてある。`encoder.ts`)。
 *
 * ## 位置はファイルの時刻のまま出す
 *
 * - `-ss` を `-i` の前に置く。映像は写すので、`from` の手前のキーフレームから始まる
 * - `-copyts` で入口の時刻を出口まで運ぶ
 * - mp4 の muxerは既定で頭を 0 に詰め直す。`frag_discont` で塊の時刻 (tfdt) を
 *   そのまま書かせ、`negative_cts_offsets` で B フレームのぶんを編集リストに逃がさせない
 *   (逃がすと頭がずれる。ブラウザの MSE は編集リストを当てにできない)
 * - 頭 (`from` = 0) だけは AAC の前置きと B フレームのぶん時刻が負になり、そのままでは
 *   tfdt が壊れる (負の数が符号なしで書かれる)。`make_non_negative` で全体を揃って
 *   ずらす。ずれは数十ms (手元の試しで 0.067秒) で、映像と音声の間は崩れない
 *
 * 手元の ffmpeg (9.x の開発版) で試した tfdt (秒、映像・音声の順):
 *
 *     -ss 10   8.342 (キーフレーム)   9.979 (AAC の前置きぶん手前)
 *     -ss 30  25.025               …
 *     -ss 0    0.067                0.046
 *
 * 音声の無い入れ物でも降りないよう `?` を付ける
 */
export function copyArgs(
  path: string,
  from: number,
  audio: number,
  codec: LiveCodec,
): string[] {
  return [
    ...QUIET,
    ...(from > 0 ? ["-ss", from.toFixed(3)] : []),
    "-copyts",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-map",
    `0:a:${audio}?`,
    "-c:v",
    "copy",
    // モノラル (デュアルモノを分けたもの) も両耳へ。音量の揃え方はライブと同じ
    ...audioArgs(codec),
    "-avoid_negative_ts",
    "make_non_negative",
    ...FMP4_OUT,
  ];
}

/**
 * **エンコード済みを別のコーデックに変換する引数。** 飛び方と時刻の運び方は詰め替え (`copyArgs`) と同じ。
 * 映像のエンコード方法はライブと同じ (`live.videoArgs`)。インタレ解除は済んでいるので挟まない
 */
export function fileTranscodeArgs(
  path: string,
  from: number,
  audio: number,
  codec: LiveCodec,
  hw: LiveHw | null,
): string[] {
  const video = videoArgs(codec, hw, false);
  return [
    ...QUIET,
    ...video.input,
    ...(from > 0 ? ["-ss", from.toFixed(3)] : []),
    "-copyts",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-map",
    `0:a:${audio}?`,
    ...(video.filter === "" ? [] : ["-vf", video.filter]),
    ...video.encoder,
    // 時刻を入口のまま運ぶ (`-copyts`)。既定 (mp4 は cfr) にコマを揃え直させない
    "-fps_mode",
    "passthrough",
    ...audioArgs(codec),
    "-avoid_negative_ts",
    "make_non_negative",
    ...FMP4_OUT,
  ];
}

/**
 * ffmpeg が `-copyts` で出す PTS (秒)。**一周の手前 60 秒に入っていると、負の数にされる。**
 *
 * libavformat の `update_wrap_reference` は、最初に読んだ時刻 `ref` が一周の手前 60 秒より前なら、
 * `ref` の 60 秒前より小さい時刻に一周ぶん足す (一周をまたいだあとも増え続ける)。手前 60 秒に
 * 入っていれば、`ref` の 60 秒前より大きい時刻から一周ぶん引く (今の時刻が負になる)
 */
export function presented(pts: number): number {
  return (pts >= WRAP - 60 * CLOCK ? pts - WRAP : pts) / CLOCK;
}

/**
 * **TS から変換するときの `-output_ts_offset`。** 流し込む頭の映像の PES の PTS (`pts`) が、物差しで
 * `at` 秒になるように。ffmpeg は `-copyts` で入口の時刻 (`presented`) をそのまま運ぶので、差を足せば
 * 出口が物差しの時刻になる。一周をまたいでも ffmpeg が増え続ける数にしてくれる。
 *
 * **`-fps_mode passthrough` が要る。** 既定 (mp4 は cfr) は時刻が負のコマを捨てるので、一周の手前 60 秒から
 * 流し込むと (`presented` が負) 映像がまるごと消えた。`-t` を出口に置くと `-copyts` の絶対時刻で数えるので
 * 置かない。
 *
 * ffmpeg 9.0.2 で、120 秒の MPEG-2 の TS (頭の PTS が 1000 秒・一周の 30 秒前・40 秒前の 3 本) を
 * 途中から標準入力へ流して測った頭の tfdt (物差しの時刻からの差):
 *
 *     要求した位置   映像 (次のキーフレームから)   音声 (映像より先に多重化されている)
 *     20 秒        +0.39〜+0.40 秒             -0.43 秒
 *     70 秒        +0.56〜+0.57 秒             -0.09 秒
 *
 * 3 本とも同じ (差は 1 コマ未満)。一周をまたぐところも隙間なく続いた。`-copyts` を付けずに
 * `-output_ts_offset <物差しの時刻>` だけにすると、映像も音声も 65ms ずれた (流し込んだ頭で変わる)
 */
export function tsOffset(pts: number, at: number): number {
  return at - presented(pts);
}

/**
 * **元の TS を変換する引数。** TS は標準入力から (飛び先から流し込む)。
 *
 * 局と音声は名指しする (`0:p:<局>`。理屈はライブと同じ)。音声は途中から流し込むと探りの間に
 * 見つからないことがあるので `?` を付ける。デュアルモノは選んだ側を両耳へ
 * (`live.encodeArgs` と同じ)。映像のエンコード方法とインタレ解除もライブと同じ (`live.videoArgs`)
 *
 * @param offset `tsOffset`
 */
export function tsTranscodeArgs(
  program: number,
  audio: AudioTrack,
  codec: LiveCodec,
  hw: LiveHw | null,
  offset: number,
): string[] {
  const video = videoArgs(codec, hw, true);
  const from = programSpec(program);
  return [
    ...QUIET,
    ...video.input,
    "-copyts",
    "-f",
    "mpegts",
    "-i",
    "pipe:0",
    "-map",
    `${from}:v:0`,
    "-map",
    `${from}:a:${audio.stream}?`,
    "-vf",
    video.filter,
    ...video.encoder,
    // 時刻を詰め直させない (`tsOffset` の説明)。既定 (mp4 は cfr) だと負の時刻のコマを捨てる。
    // ライブのようにコマ数の上限 (`-fpsmax`) は付けられない — passthrough と一緒だと ffmpeg が
    // 「矛盾している」と断って変換が始まらない。探りは既定の大きさなのでコマ数を読み違えない
    "-fps_mode",
    "passthrough",
    ...panArgs(audio),
    ...audioArgs(codec),
    "-output_ts_offset",
    offset.toFixed(6),
    // 頭から観るときだけ、AAC の前置きのぶん負になる (`copyArgs` の説明)
    "-avoid_negative_ts",
    "make_non_negative",
    ...FMP4_OUT,
  ];
}

/** 読まれずに詰まった ffmpeg を畳むまで (ms) */
const IDLE_LIMIT = 5 * 60_000;
/** 詰まりを見る間隔 (ms) */
const IDLE_CHECK = 30_000;

/** ffmpeg を 1 回起こすぶん */
export interface Attempt {
  argv: string[];
  /** 標準入力へ流し込むもの (TS が元)。起こすたびに読み直す */
  input?: () => ReadableStream<Uint8Array>;
  /** これで 1 バイトも出せずに降り、次で出せたときに呼ぶ (GPU のせいだったと覚える) */
  blame?: () => void;
}

/**
 * **ffmpeg の出口を応答の本文にする** (`stream.ffmpegBody` に、降りたときの次の手と詰まりの見張りを足したもの)。
 *
 * - 読まれたぶんしか読み出さない。相手が読まなければ出口が詰まり、ffmpeg も止まる
 * - 1 バイトも出さずに降りたら、次の手 (GPU → ソフトウェア) で起こし直す
 * - `IDLE_LIMIT` のあいだ読まれなければ畳む。閉じられた・読み切った・落ちたときも畳む
 * - **読みに来て ffmpeg が出すのを待っている間は、「読まれない」ではなく「ffmpeg が出さない」として数える。**
 *   上限は同じ `IDLE_LIMIT`。分けていなかった頃は、出だしの遅い ffmpeg を待っている相手を
 *   「読まれない」(`idle`) で切っていた (単体テストで `sh` の起動が上限の 50ms に間に合わなかった回に落ちた)。
 *   何も出さずに固まった ffmpeg は、相手が切らなくても畳む (枠を持ったまま残さない)
 * - 畳んだら `done` を呼ぶ (枠を返す)
 */
export function transcodeBody(
  attempts: Attempt[],
  what: string,
  done: () => void,
  idle = { limit: IDLE_LIMIT, every: IDLE_CHECK },
): ReadableStream<Uint8Array> {
  let index = 0;
  let proc: ReturnType<typeof spawnAttempt> | null = null;
  let sent = false;
  let finished = false;
  let lastRead = Date.now();
  /** 読みに来て ffmpeg が出すのを待ちはじめた時刻。待っていなければ null */
  let waitingSince: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearInterval(timer);
    proc?.stop();
    done();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      proc = spawnAttempt(attempts[0]!);
      timer = setInterval(() => {
        const now = Date.now();
        // 待っている間は ffmpeg の側、待っていなければ相手の側を見る
        const stalled =
          waitingSince !== null && now - waitingSince >= idle.limit;
        const unread = waitingSince === null && now - lastRead >= idle.limit;
        if (!stalled && !unread) return;
        console.warn(
          stalled
            ? `${what}の ffmpeg が何も出さないので止めます`
            : `${what}が読まれないので止めます`,
        );
        finish();
        try {
          controller.error(new Error(stalled ? "stalled" : "idle"));
        } catch {
          // もう閉じている
        }
      }, idle.every);
    },
    async pull(controller) {
      waitingSince = Date.now();
      try {
        await fill(controller);
      } finally {
        waitingSince = null;
        lastRead = Date.now();
      }
    },
    cancel() {
      finish();
    },
  });

  /** ffmpeg の出口から 1 つ渡す (1 バイトも出さずに降りていたら次の手で起こし直す) */
  async function fill(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    for (;;) {
      const current = proc;
      if (current === null || finished) return;
      const { done: ended, value } = await current.read();
      if (finished) return;
      if (!ended) {
        if (!sent && index > 0) attempts[index]?.blame?.();
        sent = true;
        controller.enqueue(value);
        return;
      }
      const code = await current.exited;
      if (finished) return;
      if (code === 0) {
        finish();
        controller.close();
        return;
      }
      const why = await current.why();
      if (!sent && index + 1 < attempts.length) {
        console.warn(`${what}をやり直します (${code}): ${why}`);
        index++;
        proc = spawnAttempt(attempts[index]!);
        continue;
      }
      console.warn(`${what}が止まりました (${code}): ${why}`);
      finish();
      controller.error(new Error(`ffmpeg exited with ${code}`));
      return;
    }
  }
}

/** ffmpeg を起こして、標準入力へ流し込む (あれば) */
function spawnAttempt(attempt: Attempt) {
  const proc = Bun.spawn(attempt.argv, {
    stdin: attempt.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text().catch(() => "");
  const out = proc.stdout.getReader();
  const source = attempt.input?.().getReader() ?? null;
  if (source !== null) {
    // 流し込み。**書けたことを待つ** (ffmpeg が詰まったら読むのも止まる)
    void (async () => {
      const writer = proc.stdin as import("bun").FileSink;
      try {
        for (;;) {
          const { done, value } = await source.read();
          if (done) break;
          await writer.write(value);
          await writer.flush();
        }
      } finally {
        endInput(proc);
      }
    })().catch(() => undefined);
  }
  return {
    read: () => out.read(),
    exited: proc.exited,
    why: async () => (await stderr).trim().split("\n").slice(-3).join(" / "),
    stop: () => {
      source?.cancel().catch(() => undefined);
      proc.kill();
    },
  };
}

/** TS を流しはじめる位置を、求められた時刻のこれだけ手前にする (秒)。キーフレームを 1 つ含めるため */
const LEAD = 1;

/** 物差しの `from` 秒を流すために、TS のどこから読むか (`ts/seek.ts`)。読めなければ null */
function seekFrom(ts: TsFile, skip: number, from: number) {
  return seekTs(
    reader(ts.path),
    ts.size,
    ts.head,
    Math.max(0, from + skip - LEAD),
  );
}

/** `?audio=` の、入れ物の中の何本目か (エンコード済みが元)。読めなければ 0 */
function audioIndex(asked: string | null): number {
  const n = Number(asked ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

const MP4_HEADERS = {
  "Content-Type": "video/mp4",
  "Cache-Control": "no-store",
};

/**
 * **`GET /api/recordings/<id>/stream` に答える。** `codec` は `h264` / `av1` / `mpeg2`、`from` は物差しの秒、
 * `audio` は `playback` の `audios` の `id`。出せない形式は 404、枠が埋まっていれば 503
 */
export async function streamResponse(
  recording: Recording,
  query: URLSearchParams,
): Promise<Response> {
  const asked = query.get("codec");
  const codec: PlayCodec | null =
    asked === "h264" || asked === "av1" || asked === "mpeg2" ? asked : null;
  if (codec === null) error(400, "codec は h264 / av1 / mpeg2 のどれかです");
  const fromRaw = Number(query.get("from") ?? 0);
  const from = Number.isFinite(fromRaw) ? Math.max(0, fromRaw) : 0;

  const plan = await playbackPlan(recording);
  const offer = plan?.info.offers.find(
    (o) => o.codec === codec && o.way !== "file",
  );
  if (plan === null || offer === undefined)
    error(404, "この形式では再生できません");

  if (codec === "mpeg2") return rawResponse(plan, from);

  const same = plan.encoded.find((file) => file.codec === codec);
  const label = `[stream] 録画 ${recording.id} (${codec})`;
  if (same !== undefined) {
    return new Response(
      transcodeBody(
        [
          {
            argv: [
              config.ffmpeg,
              ...copyArgs(
                same.path,
                from,
                audioIndex(query.get("audio")),
                codec,
              ),
            ],
          },
        ],
        `${label} の詰め替え`,
        () => undefined,
      ),
      { headers: MP4_HEADERS },
    );
  }

  const release = holdTranscode();
  if (release === null) error(503, BUSY);
  const source = plan.encoded.find((file) => file.codec !== null);
  let attempts: Attempt[] | null;
  try {
    attempts =
      source !== undefined
        ? fileAttempts(source.path, from, audioIndex(query.get("audio")), codec)
        : await tsAttempts(
            plan,
            from,
            pickTrack(plan.tracks, query.get("audio") ?? undefined),
            codec,
          );
  } catch (failure) {
    // TS を読めなかった (消されたなど)。取った枠は返す
    release();
    throw failure;
  }
  if (attempts === null) {
    release();
    error(404, "この形式では再生できません");
  }
  return new Response(transcodeBody(attempts, `${label} の変換`, release), {
    headers: MP4_HEADERS,
  });
}

/** GPU でエンコードできるなら GPU、駄目ならソフトウェア。GPU が 1 バイトも出せずに降りたら覚える */
function withFallback(
  codec: LiveCodec,
  interlaced: boolean,
  build: (hw: LiveHw | null) => Attempt,
): Attempt[] {
  const hw = pickLiveHw(codec, interlaced);
  const software = build(null);
  if (hw === null) return [software];
  return [build(hw), { ...software, blame: () => blameLiveHw(codec, hw) }];
}

function fileAttempts(
  path: string,
  from: number,
  audio: number,
  codec: LiveCodec,
): Attempt[] {
  return withFallback(codec, false, (hw) => ({
    argv: [config.ffmpeg, ...fileTranscodeArgs(path, from, audio, codec, hw)],
  }));
}

async function tsAttempts(
  plan: PlaybackPlan,
  from: number,
  audio: AudioTrack,
  codec: LiveCodec,
): Promise<Attempt[] | null> {
  const ts = plan.ts;
  if (ts === null) return null;
  const mark = await seekFrom(ts, plan.skip, from);
  if (mark === null) return null;
  const offset = tsOffset(mark.pts, sinceHead(mark.pts, ts.head) - plan.skip);
  const input = () => Bun.file(ts.path).slice(mark.at).stream();
  return withFallback(codec, true, (hw) => ({
    argv: [
      config.ffmpeg,
      ...tsTranscodeArgs(plan.program, audio, codec, hw, offset),
    ],
    input,
  }));
}

/**
 * **MPEG-2 は元の TS を飛び先から流す。** 物差しの 0 にあたる PTS をヘッダで渡す (`ORIGIN_HEADER`)。
 * 画面は PES の PTS から自分で時刻を出す。枠は使わない (サーバは読んで渡すだけ)
 */
async function rawResponse(
  plan: PlaybackPlan,
  from: number,
): Promise<Response> {
  const ts = plan.ts;
  if (ts === null) error(404, "この形式では再生できません");
  const mark = await seekFrom(ts, plan.skip, from);
  if (mark === null) error(404, "この形式では再生できません");
  const origin =
    (((ts.head + Math.round(plan.skip * CLOCK)) % WRAP) + WRAP) % WRAP;
  return new Response(Bun.file(ts.path).slice(mark.at).stream(), {
    headers: {
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-store",
      [ORIGIN_HEADER]: String(origin),
    },
  });
}

/** エンコード済みのファイル (Matroska)。無ければ null。在るものが物差しになる (`PlayAxis`) */
export function encodedPath(
  recording: Pick<Recording, "library_path">,
): string | null {
  return recording.library_path?.endsWith(".mkv") === true
    ? recording.library_path
    : null;
}

/**
 * 続きの位置の物差し (`ts/watch.ts` の `Ruler`)。`source` は観ているファイル (`?source=` と同じ語彙)。
 * null なら観る画面と同じ決め方 (エンコードしたものがあればそれ、無ければ元の TS。`playbackPlan` の `axis`)。
 * 元の TS の物差しなら null
 */
export function rulerOf(
  recording: Pick<Recording, "library_path" | "cm_kept" | "encode_skip">,
  source: FileSource | null,
): Ruler | null {
  const encoded =
    source === null ? encodedPath(recording) !== null : source !== "ts";
  return encoded
    ? { kept: recording.cm_kept, skip: recording.encode_skip ?? 0 }
    : null;
}

/**
 * 一覧の「残り」に使う、続きの位置と尺 (ms)。**どちらも観る物差し** (`rulerOf(recording, null)`。
 * エンコードしたものがあればその時刻。`GET /api/recordings` の `resumeMs` と同じ)。
 *
 * - 位置 (`resume_ms`) は元の TS の物差しで覚えているので直す
 * - 尺 (`duration_ms`) はエンコードし終えると出来上がりの長さに書き換わる (`encoder.ts`) ので、
 *   エンコードしたものがあれば、もうその物差し。無い (古い行) ときは番組表の尺を直して代わりにする
 *
 * 元の TS の位置のまま出来上がりの尺から引くと、CM を切ったものでは切った CM のぶん食い違う。
 * 続きが無い・直すと頭になる (捨てた頭の中で止めた) ものは null
 */
export function watchProgress(
  recording: Pick<
    Recording,
    | "library_path"
    | "cm_kept"
    | "encode_skip"
    | "resume_ms"
    | "duration_ms"
    | "start_at"
    | "end_at"
  >,
): { at: number; length: number } | null {
  if (recording.resume_ms === null) return null;
  const ruler = rulerOf(recording, null);
  const at = Math.round(fromTsTime(recording.resume_ms / 1000, ruler) * 1000);
  if (at <= 0) return null;
  const length =
    recording.duration_ms ??
    Math.round(
      fromTsTime((recording.end_at - recording.start_at) / 1000, ruler) * 1000,
    );
  return { at, length };
}

/**
 * 元の TS。エンコードせずに置いた録画 (「エンコードしない」) は置き場の TS がそれ。無ければ null。
 * 録っている最中のものも返す (伸びている)
 */
export function tsPathOf(
  recording: Pick<Recording, "ts_path" | "library_path">,
): string | null {
  return (
    recording.ts_path ??
    (recording.library_path?.endsWith(".mkv") === false
      ? recording.library_path
      : null)
  );
}

/**
 * **エンコード済みが無い録画の、CM 飛ばしのチャプター。** 検出した CM の区間 (`cm_ranges`) は
 * 元の TS の頭からの秒で持っている (`encoder.ts` の `runCmJob`) ので、物差し (`ts`) にそのまま乗る。
 * CM の扱いが「何もしない」なら、エンコード済みにチャプターを書かないのと揃えて出さない
 */
export async function tsChapters(
  recording: Recording,
): Promise<{ start: number; end: number; title: string }[]> {
  const path = tsPathOf(recording);
  if (
    path === null ||
    recording.cm_ranges === null ||
    recording.cm_ranges.length === 0
  )
    return [];
  if (settings().cmCut === "off") return [];
  const ts = await probeTs(path);
  return chapterList(
    recording.cm_ranges,
    ts?.duration ?? recordedSec(recording),
  );
}

/**
 * **字幕の筋だけを抜く引数** (`api/recordings/<id>/captions.json`)。デコードせずに写す (デコードするのは denpa)。
 *
 * エンコード済みがあればそこから。無ければ元の TS から抜き、時刻を物差し (TS の頭を 0) に揃える
 * (`-copyts` で放送の PTS を運び、頭のぶん引く。`presented`)。どちらも無ければ null
 */
export async function captionArgs(
  recording: Recording,
): Promise<{ argv: string[]; ts: boolean } | null> {
  const encoded = encodedPath(recording);
  const out = ["-c:s", "copy", "-f", "matroska", "pipe:1"];
  if (encoded !== null) {
    return {
      argv: ["-v", "error", "-i", encoded, "-map", "0:s:0", ...out],
      ts: false,
    };
  }
  const path = tsPathOf(recording);
  const ts = path === null ? null : await probeTs(path);
  if (ts === null) return null;
  return {
    argv: [
      "-v",
      "error",
      "-copyts",
      "-i",
      ts.path,
      "-map",
      `${programSpec(aribServiceId(recording.service_id))}:s:0`,
      "-output_ts_offset",
      (-presented(ts.head)).toFixed(6),
      ...out,
    ],
    ts: true,
  };
}
