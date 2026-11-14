/**
 * **録画の観方を決めて、流す** (`GET /api/recordings/<id>/playback` と `/stream`。取り決めは `ts/playback.ts`)。
 *
 * サーバが決めるのは「何を出せるか・どの形式で出すか・時刻の物差し」まで。どれを使うかは画面が決める
 * (端末で再生できるか、人が選んだコーデック)。端末の種類では決めない。
 *
 * ## 何を出すか
 *
 * | 録画にあるもの | 求められた形式 | 出し方 |
 * | --- | --- | --- |
 * | エンコード済み (同じコーデック) | H.264 / H.265 / AV1 | ファイルそのまま (`file`)。そのまま読めない端末には詰め替え (`stream`、映像は写すだけ) |
 * | エンコード済み (違うコーデック) | H.264 / AV1 | **エンコード済みを元に**その場で変換 (`stream`) |
 * | H.265 のエンコード済みが無い | H.265 | 出さない (H.265 はその場の変換で作らない) |
 * | 元の TS だけ | H.264 / AV1 | TS からその場で変換 (`stream`) |
 * | 元の TS | MPEG-2 | TS を飛び先から流す (`raw`。画面が自分で再生する) |
 * | エンコード済みだけ | MPEG-2 | 出さない |
 * | v2.37 までに CM を切ってエンコードした録画 | MPEG-2 | 出さない (時刻が合わない) |
 * | エンコード済みか元の TS | 段を下げる (`?rung=`) | 同じコーデックでも変換 (`stream`)。コーデックはサーバが選び、H.265 も GPU があれば作る |
 * | エンコード済みか元の TS | 音声だけ (`?codec=audio`) | 音声だけを AAC にして流す (`stream`) |
 * | 4K の局の元の録画 (`.mmts`) だけ | H.265 | 放送の HEVC と AAC を詰め替えて流す (`stream`。エンコードしない) |
 * | 4K の局の元の録画 (`.mmts`) だけ | H.264 / AV1 | 詰め替えたものを縮めて SDR にして変換 (`stream`。ライブの `uhdVideoArgs` と同じ) |
 * | 4K の局の元の録画 (`.mmts`) | MPEG-2 | 出さない (MPEG-2 の TS ではない) |
 * | TS で送る 4K の局の元の TS だけ | H.265 | 映像を写して音声を AAC にして流す (`stream`。エンコードしない) |
 * | TS で送る 4K の局の元の TS だけ | H.264 / AV1 | 縮めて SDR にして変換 (`stream`。ライブの `uhdVideoArgs` と同じ) |
 * | TS で送る 4K の局の元の TS | MPEG-2 | 出さない (映像が HEVC) |
 *
 * TS で送る 4K の局の録画は、拡張子では分からないので元の TS の PMT を読んで決める (`recorded-broadcast.ts`)。
 *
 * 時刻の物差しは 1 ページで 1 つ (`PlayAxis`)。エンコード済みがあればその時刻、無ければ元の TS の先頭を 0 にする。
 * どの出し方でもストリームの時刻はこの物差しに乗せる。字幕・チャプター・データ放送・続きの位置を
 * `currentTime` のまま引けるようにするため。
 *
 * ## 飛び方
 *
 * - **エンコード済みが元** … `-ss <from> -copyts`。ファイルの時刻のまま出す (詰め替えの話は `copyArgs`)
 * - **TS が元** … 時刻からバイトの位置を引いて (`ts/seek.ts` の二分探索)、そこから ffmpeg の標準入力へ
 *   流し込む。出力の時刻は `-copyts` と `-output_ts_offset` で物差しに合わせる (`tsOffset`)
 * - **4K の局の録画 (`.mmts`) が元** … バイト比例で当たりを付けて読み (`mmts.mmtsOffset`)、denpa が物差しの時刻の fMP4 に詰め替える
 *   (`mmts.mmtsFmp4`)。変換するときは、それを ffmpeg の標準入力へ流し込んで `-copyts` で時刻を運ぶ
 *
 * ## 枠
 *
 * その場で変換するもの (映像をエンコードし直す) は枠を 1 つ使う (`transcode.ts`)。埋まっていたら
 * 503。詰め替え・元の TS をそのまま流すのは軽いので数えない。**読まれずに詰まった ffmpeg は
 * 5 分で畳む** (止めたまま放っておかれた画面のぶんの枠を返すため)
 */

import { existsSync, statSync } from "node:fs";

import { CLOCK, WRAP } from "@danything/arib/pes";
import { error } from "@sveltejs/kit";

import {
  type AudioTrack,
  audioTracks,
  parseAudios,
  pickTrack,
} from "#lib/arib.js";
import { encodedCodec } from "#lib/encoded-codec.js";
import type { HwCodec } from "#lib/hw.js";
import type { BroadcastCodec } from "#lib/live-choice.js";
import { BROADCAST_HEVC, codecsFor, type LiveCodec } from "#lib/live.js";
import { LOWEST_RUNG, parseRung, type Rung } from "#lib/rungs.js";
import { type FileSource, recordedTransport, tsPathOf } from "#lib/source.js";
import {
  BUSY,
  CODEC_HEADER,
  type EncodedSource,
  ORIGIN_HEADER,
  PACE_HEADER,
  type PlayAudio,
  type PlaybackInfo,
  type PlayCodec,
  type PlayOffer,
  RUNG_HEADER,
} from "#lib/ts/playback.js";
import {
  inWrap,
  lastVideoPts,
  type ReadAt,
  readHead,
  seekTs,
  sinceHead,
} from "#lib/ts/seek.js";
import { fromTsTime, type Ruler } from "#lib/ts/watch.js";
import type { Recording } from "#lib/types.js";

import { programSpec } from "./captions";
import { chapterList } from "./cm";
import { config } from "./config";
import { type LiveHw, nvencBusy } from "./hwenc";
import { type EncodedColumns, encodedFile, encodedFiles } from "./library";
import {
  aribServiceId,
  audioArgs,
  blameLiveHw,
  liveRungCodec,
  panArgs,
  parsePlayable,
  pickLiveHw,
  rungCodec,
  softwareEncodes,
  uhdVideoArgs,
  videoArgs,
} from "./live";
import { sidecarPaths } from "./metadata";
import { LEAD, type MmtsFile, mmtsFmp4, mmtsOffset, probeMmts } from "./mmts";
import { openPace, StreamPace } from "./pace";
import { recordedBroadcast } from "./recorded-broadcast";
import {
  readRecording,
  recordingInput,
  recordingProbeInput,
  recordingStream,
} from "./recording-io";
import { endInput, run } from "./stream";
import { holdTranscode } from "./transcode";

/** エンコード済みのファイル 1 本の中身 (ffprobe で読む。`probeMedia`) */
interface MediaFile {
  source: EncodedSource;
  /** 映像の codecs 文字列 (`avc1.640028` / `av01.0.08M.08`)。読めない・無ければ null */
  video: string | null;
  /** 音声の codecs 文字列 (`opus` / `mp4a.40.2`)。読めない・無ければ null */
  audio: string | null;
  /** 音声トラックの名前 (入れ物の title)。無名は空文字 */
  audios: string[];
  /** 尺 (秒)。読めなければ null */
  duration: number | null;
  /** 映像のコマ数 (毎秒)。段を下げた変換で、30 コマ以下ならそのままのコマ数で縮める (`live.videoArgs`)。読めなければ null */
  fps: number | null;
  /**
   * HLG (4K の局の録画を AV1 にエンコードしたもの。`encoder.ts`) か。変換するときは縮めて SDR に直す
   * (`live.uhdVideoArgs`。ライブの 4K の局と同じ)
   */
  hlg: boolean;
}

interface ProbedStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  pix_fmt?: string;
  /** 平均のコマ数 (`30000/1001`。読めなければ `0/0`) */
  avg_frame_rate?: string;
  /** 映像の伝達特性 (`arib-std-b67` が HLG) */
  color_transfer?: string;
  tags?: { title?: string; TITLE?: string };
}

/** ffprobe のコマ数 (`24000/1001`) を数にする。読めない・0 なら null */
function frameRate(stream: ProbedStream | undefined): number | null {
  const match = /^(\d+)\/(\d+)$/.exec(stream?.avg_frame_rate ?? "");
  if (match === null) return null;
  const rate = Number(match[1]) / Number(match[2]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** H.264 の profile 名 → codecs の先頭 (profile_idc と制約の印) */
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
/** H.265 の profile 名 → codecs の profile と互換の印 */
const HEVC_PROFILES: Record<string, string> = {
  Main: "1.6",
  "Main 10": "2.4",
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
  if (stream.codec_name === "hevc") {
    /*
     * `hvc1.<profile>.<互換の印>.<tier と level>.<制約>` (ISO/IEC 14496-15 の付録 E)。互換の印は profile ごとの
     * 決まった値 (Main は 1 と 2 が立って 6、Main 10 は 2 だけで 4)。tier は ffprobe が言わないので Main tier (L)。
     * 制約は「プログレッシブでフレームだけ」の 90 と決め打つ (ffprobe が言わない。ブラウザはここで断らない前提)。
     * 詰め替えでも `hvc1` と名乗らせる (`copyArgs`。Safari は `hev1` を受け取らない)
     */
    const head = HEVC_PROFILES[stream.profile ?? ""] ?? "1.6";
    return `hvc1.${head}.L${level ?? 120}.90`;
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
  const video = streams.find((stream) => stream.codec_type === "video");
  return {
    source,
    video: videoCodec(video),
    audio: audioCodec(audios[0]),
    audios: audios.map(
      (stream) => stream.tags?.title ?? stream.tags?.TITLE ?? "",
    ),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    fps: frameRate(video),
    hlg: video?.color_transfer === "arib-std-b67",
  };
}

/** ffprobe の待ち時間の上限。壊れたファイルで待ち続けない */
export const PROBE_TIMEOUT = 15_000;

/** 読んだ中身の控え。開くたびに聞くので、同じファイル (パスと更新時刻) なら読み直さない */
const probed = new Map<string, { mtime: number; file: MediaFile }>();
/** 控えの上限。古いものから捨てる */
const KEEP = 64;

/** 控えに入れる。新しいものを後ろに置き、上限を超えたら古いもの (先頭) から捨てる */
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
      ...recordingProbeInput(path),
    ],
    { timeoutMs: PROBE_TIMEOUT, stdout: true },
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
  codec: HwCodec | null;
  media: MediaFile;
}

/** 元の TS */
interface TsFile {
  path: string;
  size: number;
  /** 入れ物の始まり (90kHz。`ts/seek.ts` の `tsHead`) */
  head: number;
  /** 先頭から最後の映像まで (秒)。読めなければ null */
  duration: number | null;
}

/** 決めたこと。画面へ渡すもの (`info`) と、流すときに要るもの */
interface PlaybackPlan {
  info: PlaybackInfo;
  encoded: EncodedFile[];
  /** 元の TS。録り終えていて読めて、時刻を物差しに乗せられるときだけ */
  ts: TsFile | null;
  /** 4K の局の元の録画 (`.mmts`)。録り終えていて読めて、エンコード済みが無いときだけ (物差しは録画の先頭) */
  mmts: MmtsFile | null;
  /** 物差しの 0 が、TS の先頭から何秒か (`encode_skip`)。TS が物差しなら 0 */
  skip: number;
  /** TS の音声 (`arib.audioTracks`)。TS から変換するときに使う */
  tracks: AudioTrack[];
  /** ffmpeg に名指しさせる放送の番号 */
  program: number;
  /**
   * 元の録画の放送のコーデック (`recorded-broadcast.ts`)。4K の局の録画 (`.mmts`) と、PMT の映像が HEVC の TS
   * (TS で送る 4K の局) は `hevc`。元の録画が無ければ `mpeg2`
   */
  broadcast: BroadcastCodec;
}

/** 中身の codecs (映像) からコーデックを読む */
function codecOf(video: string | null): HwCodec | null {
  if (video?.startsWith("avc1") === true) return "h264";
  if (video?.startsWith("hvc1") === true) return "hevc";
  if (video?.startsWith("av01") === true) return "av1";
  return null;
}

/**
 * fMP4 にしたときの音声の codecs。H.264 は AAC、AV1 は Opus (ライブと同じ組。`live.audioArgs`)。
 * H.265 は AAC。H.265 を MSE で受け取りたいのは AV1 をデコードできない端末 (Safari など) で、MP4 の Opus を
 * 受け取れるとは限らないため
 */
function streamAudio(codec: HwCodec): string {
  return codec === "av1" ? "Opus" : "mp4a.40.2";
}

/** 変換したときの codecs (`#lib/live.ts` の `codecsFor` の中身) */
function transcodedCodecs(codec: LiveCodec): string {
  return /codecs="([^"]+)"/.exec(codecsFor(codec))?.[1] ?? "";
}

/** ファイルを少しずつ読むリーダー (`ts/seek.ts`) */
function reader(path: string): ReadAt {
  return (offset, length) => readRecording(path, offset, length);
}

/** 尺を出すのに末尾から読む量。最後の映像の PES が入る長さ */
const TAIL_BYTES = 4 * 1024 * 1024;

/** 読んだ TS の控え。開くたびに聞くので、同じファイル (パス・大きさ・更新時刻) なら読み直さない */
const tsProbed = new Map<string, { key: string; ts: TsFile | null }>();

/** 元の TS の先頭と尺を読む。読めなければ null */
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
  const head = await readHead(read);
  let ts: TsFile | null = null;
  if (head !== null) {
    const last = lastVideoPts(
      await read(Math.max(0, size - TAIL_BYTES), TAIL_BYTES),
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

/** 4K の局の元の録画 (`.mmts`) の先頭と尺 (`mmts.probeMmts`)。読めなければ null */
async function probeMmtsFile(
  path: string,
  serviceId: number,
): Promise<MmtsFile | null> {
  try {
    const stat = statSync(path);
    if (stat.size === 0) return null;
    return await probeMmts(
      path,
      stat.size,
      `${stat.size}:${stat.mtimeMs}`,
      serviceId,
    );
  } catch {
    return null;
  }
}

/** 録画の尺 (秒)。番組表の尺ではなく録れた長さで、エンコードし終えたら出来上がりの長さ (`encoder.ts`)。古い行は予定の長さ */
function recordedSec(recording: Recording): number {
  return (
    (recording.duration_ms ?? recording.end_at - recording.start_at) / 1000
  );
}

/**
 * **何を出せるかを決める。** エンコード済みも元の TS も無ければ null。
 *
 * ffprobe が中身を読めなかったエンコード済み (ffprobe が無い・壊れている) は、置き場の名前のコーデック
 * (`… [H265].mkv` など) でエンコードしたものとみなしてファイルだけ出す (詰め替えも変換も、中身が分からないと組めない)
 */
export async function playbackPlan(
  recording: Recording,
): Promise<PlaybackPlan | null> {
  const encoded: EncodedFile[] = await Promise.all(
    encodedFiles(recording).map(async ({ source, path }) => {
      const media = await probeMedia(source, path);
      return { source, path, codec: codecOf(media.video), media };
    }),
  );

  // エンコードせずに置いた録画 (「エンコードしない」) は、置き場の TS が元の TS そのもの
  const tsPath = tsPathOf(recording);
  const program = aribServiceId(recording.service_id);
  /*
   * 4K の局の録画 (`.mmts`) は MPEG-2 の TS ではないので、TS としては読まない。エンコード済みがあればそちらだけを出し
   * (物差しもそちら)、無いときだけ元の録画を詰め替えて出す
   */
  const uhd = tsPath !== null && recordedTransport(tsPath) === "tlv";
  // 録っている最中の TS は伸びている。追っかけ再生 (`/chase`) の受け持ち
  const done = tsPath !== null && recording.finished_at !== null;
  const ts = done && !uhd ? await probeTs(tsPath) : null;
  const mmts =
    done && uhd && encoded.length === 0
      ? await probeMmtsFile(tsPath, program)
      : null;
  if (encoded.length === 0 && ts === null && mmts === null) return null;
  /*
   * TS で送る 4K の局の録画は、拡張子では分からないので PMT を読む。MPEG-2 の TS としては出さず (画面の MPEG-2 のデコーダは
   * HEVC をデコードできない)、エンコード済みが無ければ 4K の局の元の録画 (`.mmts`) と同じ形式を出す
   */
  const broadcast =
    tsPath === null ? "mpeg2" : recordedBroadcast(tsPath, program);
  const hevcTs = ts !== null && broadcast === "hevc" && encoded.length === 0;

  const axis = encoded.length > 0 ? "encoded" : "ts";
  const skip = axis === "encoded" ? (recording.encode_skip ?? 0) : 0;
  const known = encoded.filter((file) => file.codec !== null);

  const offers: PlayOffer[] = [];
  for (const file of encoded) {
    // 中身を読めなければ、置き場の名前で (`… [H265].mkv`。`encodedPath` の逆)
    const named = encodedCodec(file.path);
    const codec: PlayCodec = file.codec ?? (named === "mpeg2" ? "av1" : named);
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
  }
  /*
   * H.265 は詰め替えだけ (エンコード済みの H.265 があるときだけ)。その場の変換では H.265 を作らない。
   * ブラウザの H.265 は端末しだいで、AV1 か H.264 に変換すれば足りる (docs/encode.md「H.265 は GPU でだけ」)
   */
  const hevc = known.find((file) => file.codec === "hevc");
  if (hevc !== undefined) {
    offers.push({
      codec: "hevc",
      way: "stream",
      codecs: `${hevc.media.video},${streamAudio("hevc")}`,
    });
  }
  /*
   * 4K の局の元の録画は、放送の HEVC と AAC の詰め替え (ライブの 4K の局の「放送のまま」と同じ。`BROADCAST_HEVC`)。
   * TS で送る 4K の局の録画は、ffmpeg で映像を写して音声を AAC にする (`tsTranscodeArgs`)
   */
  if (mmts !== null || hevcTs) {
    offers.push({
      codec: "hevc",
      way: "stream",
      codecs: /codecs="([^"]+)"/.exec(BROADCAST_HEVC)?.[1] ?? "",
    });
  }
  for (const codec of ["h264", "av1"] as const) {
    const same = known.find((file) => file.codec === codec);
    if (same !== undefined) {
      offers.push({
        codec,
        way: "stream",
        codecs: `${same.media.video},${streamAudio(codec)}`,
      });
    } else if (
      known.length > 0 ||
      (encoded.length === 0 && (ts !== null || mmts !== null))
    ) {
      offers.push({ codec, way: "stream", codecs: transcodedCodecs(codec) });
    }
  }
  /*
   * MPEG-2 は元の TS の時刻をそのまま運ぶので、物差しに乗せられるときだけ。v2.37 までに CM を切ったものは
   * 途中が詰まっていて合わない。捨てた先頭を覚えていない古い録画も合わせようがない
   */
  if (
    ts !== null &&
    broadcast === "mpeg2" &&
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
      ? // エンコードし終えた行の `duration_ms` は出来上がりの長さ (先頭を捨てたあと) なので、skip は引かない
        (encoded[0]?.media.duration ?? recordedSec(recording))
      : (ts?.duration ?? mmts?.duration ?? recordedSec(recording));

  return {
    info: {
      duration,
      axis,
      audios,
      offers,
      // 放送のままが HEVC の録画 (4K の局) だけ。自動の順で MPEG-2 の場所に HEVC を入れる (`ts/playback.ts` の `pickOffer`)
      ...(mmts === null && !hevcTs ? {} : { broadcast: "hevc" as const }),
      // 物差しの時刻を元の TS の時刻に戻すための情報。エンコードしたものの物差しのときだけ (`rulerOf` と同じ中身)
      ...(axis === "encoded"
        ? { ruler: { kept: recording.cm_kept, skip } }
        : {}),
    },
    encoded,
    /*
     * エンコードしたものの物差しで TS から変換するのは、TS の時刻を物差しに乗せられるときだけ (MPEG-2 と同じ条件)。
     * v2.37 までに CM を切ったものと、捨てた先頭を覚えていない古い録画は、字幕・チャプター・続きの位置とずれる
     */
    ts:
      axis === "ts" ||
      (recording.cm_kept === null && recording.encode_skip !== null)
        ? ts
        : null,
    mmts,
    skip,
    tracks,
    program,
    broadcast,
  };
}

/** 失敗の理由だけ出させる (`transcodeBody` がログへ回す) */
const QUIET = ["-hide_banner", "-nostats", "-loglevel", "error"];

/** 詰め替えと変換で共通の出力。時刻はそのまま書かせる (`copyArgs` の説明) */
const FMP4_OUT = [
  "-f",
  "mp4",
  "-movflags",
  "+empty_moov+default_base_moof+frag_discont+negative_cts_offsets",
  // 1 秒ずつ。キーフレームごと (数秒) だと、最初の映像が出るまでそのぶん待つ
  "-frag_duration",
  "1000000",
  "pipe:1",
];

/**
 * **エンコード済みを詰め替える引数** (映像は写すだけ。音声は H.264・H.265 なら AAC、AV1 なら Opus。`streamAudio`)。
 * H.265 は `hvc1` と名乗らせる。mp4 の muxer の既定は `hev1` で、Safari は `hev1` を受け取らない。
 * `hvc1` は「パラメータセットは入れ物の先頭に」の印で、GPU のエンコーダがキーフレームごとに中にも
 * 書いているものはそのまま残るが、ブラウザはそれで断らない前提 (実機では見ていない)。
 * `audio` は入れ物の中の何本目の音声か (主・副で分けてエンコードしてある。`encoder.ts`)。
 *
 * ## 位置はファイルの時刻のまま出す
 *
 * - `-ss` を `-i` の前に置く。映像は写すので、`from` の手前のキーフレームから始まる
 * - `-copyts` で入力の時刻を出力まで運ぶ
 * - mp4 の muxer は既定で先頭を 0 に詰め直す。`frag_discont` で塊の時刻 (tfdt) を
 *   そのまま書かせ、`negative_cts_offsets` で B フレームのぶんを編集リストに逃がさせない
 *   (逃がすと先頭がずれる。ブラウザの MSE は編集リストを当てにできない)
 * - 先頭 (`from` = 0) だけは AAC の前置きと B フレームのぶん時刻が負になり、そのままでは
 *   tfdt が壊れる (負の数が符号なしで書かれる)。`make_non_negative` で全体を揃って
 *   ずらす。ずれは数十 ms (手元で試して 0.067 秒) で、映像と音声の間は崩れない
 *
 * 手元の ffmpeg (9.x の開発ビルド) で試した tfdt (秒、映像・音声の順):
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
  codec: HwCodec,
): string[] {
  return [
    ...QUIET,
    ...(from > 0 ? ["-ss", from.toFixed(3)] : []),
    "-copyts",
    ...recordingInput(path),
    "-map",
    "0:v:0",
    "-map",
    `0:a:${audio}?`,
    "-c:v",
    "copy",
    ...(codec === "hevc" ? ["-tag:v", "hvc1"] : []),
    // モノラル (デュアルモノを分けたもの) も両耳へ。エンコード方法はライブと同じ (`live.audioArgs`)
    ...audioArgs(codec === "av1" ? "av1" : "h264"),
    "-avoid_negative_ts",
    "make_non_negative",
    ...FMP4_OUT,
  ];
}

/**
 * **エンコード済みを別のコーデックに変換する引数。** 飛び方と時刻の運び方は詰め替え (`copyArgs`) と同じ。
 * 映像のエンコード方法はライブと同じ (`live.videoArgs`)。インタレ解除は済んでいるので挟まない。
 * `rung` は回線に合わせて下げた段 (`#lib/rungs.ts`)。段を下げるなら、エンコード済みと同じコーデックにも変換する。
 * `fps` は元のコマ数 (`MediaFile.fps`)。段を下げるとき、30 コマ以下ならそのままのコマ数で縮める
 */
export function fileTranscodeArgs(
  path: string,
  from: number,
  audio: number,
  codec: LiveCodec,
  hw: LiveHw | null,
  rung: Rung = 0,
  fps: number | null = null,
  hlg = false,
): string[] {
  // HLG (4K の局の録画を AV1 にしたもの) は、縮めて SDR に直す (ライブの 4K の局と同じ)
  const video = hlg
    ? uhdVideoArgs(codec, hw, rung, false)
    : videoArgs(codec, hw, false, rung, fps);
  return [
    ...QUIET,
    ...video.input,
    ...(from > 0 ? ["-ss", from.toFixed(3)] : []),
    "-copyts",
    ...recordingInput(path),
    "-map",
    "0:v:0",
    "-map",
    `0:a:${audio}?`,
    ...(video.filter === "" ? [] : ["-vf", video.filter]),
    ...video.encoder,
    // 時刻を入力のまま運ぶ (`-copyts`)。既定 (mp4 は cfr) にコマを揃え直させない
    "-fps_mode",
    "passthrough",
    ...audioArgs(codec, rung),
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
 * **TS から変換するときの `-output_ts_offset`。** 流し込む最初の映像の PES の PTS (`pts`) が、物差しで
 * `at` 秒になるように。ffmpeg は `-copyts` で入力の時刻 (`presented`) をそのまま運ぶので、差を足せば
 * 出力が物差しの時刻になる。一周をまたいでも ffmpeg が増え続ける数にしてくれる。
 *
 * **`-fps_mode passthrough` が要る。** 既定 (mp4 は cfr) は時刻が負のコマを捨てるので、一周の手前 60 秒から
 * 流し込むと (`presented` が負) 映像がまるごと消えた。`-t` を出力に置くと `-copyts` の絶対時刻で数えるので
 * 置かない。
 *
 * ffmpeg 9.0.2 で、120 秒の MPEG-2 の TS (先頭の PTS が 1000 秒・一周の 30 秒前・40 秒前の 3 本) を
 * 途中から標準入力へ流して測った最初の tfdt (物差しの時刻からの差):
 *
 *     要求した位置   映像 (次のキーフレームから)   音声 (映像より先に多重化されている)
 *     20 秒        +0.39〜+0.40 秒             -0.43 秒
 *     70 秒        +0.56〜+0.57 秒             -0.09 秒
 *
 * 3 本とも同じ (差は 1 コマ未満)。一周をまたぐところも隙間なく続いた。`-copyts` を付けずに
 * `-output_ts_offset <物差しの時刻>` だけにすると、映像も音声も 65ms ずれた (流し込んだ位置で変わる)
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
 * TS で送る 4K の局の録画 (`broadcast` が `hevc`) は、ライブの TS で送る 4K の局と同じく、`hevc` なら映像を写し (`-c:v copy -tag:v hvc1`)、
 * ほかのコーデックなら縮めて SDR にする (`live.uhdVideoArgs`。段 0 の `hevc` だけが写す。段を下げた H.265 は呼ぶ側が選ばない)
 *
 * @param offset `tsOffset`
 * @param rung 回線に合わせて下げた段 (`#lib/rungs.ts`)
 * @param broadcast 録画の放送のコーデック (`recorded-broadcast.ts`)
 */
export function tsTranscodeArgs(
  program: number,
  audio: AudioTrack,
  codec: LiveCodec,
  hw: LiveHw | null,
  offset: number,
  rung: Rung = 0,
  broadcast: BroadcastCodec = "mpeg2",
): string[] {
  const copy = broadcast === "hevc" && codec === "hevc" && rung === 0;
  const video = copy
    ? { input: [], filter: "", encoder: ["-c:v", "copy", "-tag:v", "hvc1"] }
    : broadcast === "hevc"
      ? uhdVideoArgs(codec, hw, rung, false)
      : videoArgs(codec, hw, true, rung);
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
    ...(video.filter === "" ? [] : ["-vf", video.filter]),
    ...video.encoder,
    /*
     * 時刻を詰め直させない (`tsOffset` の説明)。既定 (mp4 は cfr) だと負の時刻のコマを捨てる。
     * ライブのようにコマ数の上限 (`-fpsmax`) は付けられない。 passthrough と一緒だと ffmpeg が
     * 「矛盾している」と断って変換が始まらない。探りは既定の大きさなのでコマ数を読み違えない。
     * 映像を写すときはエンコーダが無いので付けない
     */
    ...(copy ? [] : ["-fps_mode", "passthrough"]),
    ...panArgs(audio),
    ...audioArgs(codec, rung),
    "-output_ts_offset",
    offset.toFixed(6),
    // 先頭から観るときだけ、AAC の前置きのぶん負になる (`copyArgs` の説明)
    "-avoid_negative_ts",
    "make_non_negative",
    /*
     * 映像を写すときは、moov を最初の映像のパケットを見てから書く (ライブの `HEVC_COPY_PROBE` と同じ理由)。
     * 飛び先から流し込むので、探りの間に VPS・SPS・PPS を読み切れないことがある (推定)
     */
    ...(copy
      ? FMP4_OUT.map((flag) =>
          flag.startsWith("+empty_moov") ? `${flag}+delay_moov` : flag,
        )
      : FMP4_OUT),
  ];
}

/**
 * **4K の局の元の録画を変換する引数。** 入力は denpa が物差しの時刻で詰め替えた fMP4 (`mmts.mmtsFmp4`。標準入力から)。
 * `-copyts` で時刻をそのまま運ぶ。映像は縮めて SDR に直す (ライブの 4K の局と同じ `live.uhdVideoArgs`)。
 * 局は 1 つ、音声は 1 本 (MPT の最初の音声のアセット) なので名指ししない
 */
export function mmtsTranscodeArgs(
  codec: LiveCodec,
  hw: LiveHw | null,
  rung: Rung = 0,
): string[] {
  const video = uhdVideoArgs(codec, hw, rung, false);
  return [
    ...QUIET,
    ...video.input,
    "-copyts",
    "-f",
    "mp4",
    "-i",
    "pipe:0",
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    video.filter,
    ...video.encoder,
    // 時刻を詰め直させない (`tsTranscodeArgs` と同じ)
    "-fps_mode",
    "passthrough",
    ...audioArgs(codec, rung),
    "-avoid_negative_ts",
    "make_non_negative",
    ...FMP4_OUT,
  ];
}

/**
 * **音声だけの引数** (`?codec=audio`。段 3 でも回線が足りないときの最後の手)。映像は出さず、音声を AAC の 96k
 * (段を下げたときと同じ。`live.audioArgs`) にして fMP4 で流す。飛び方と時刻の運び方は映像のあるときと同じなので、
 * 映像に戻すときも同じ物差しのまま続けられる。`source` はエンコード済み (`path` と入れ物の中の何本目か) か、
 * 元の TS (局と音声・`tsOffset`。TS は標準入力から)
 */
export function audioOnlyArgs(
  source:
    | { path: string; from: number; audio: number }
    | { program: number; audio: AudioTrack; offset: number }
    | { fmp4: true },
): string[] {
  const input =
    "fmp4" in source
      ? // 4K の局の元の録画を詰め替えた fMP4 (`mmtsTranscodeArgs` と同じ。時刻は物差しのまま)
        ["-copyts", "-f", "mp4", "-i", "pipe:0", "-map", "0:a:0?"]
      : "path" in source
        ? [
            ...(source.from > 0 ? ["-ss", source.from.toFixed(3)] : []),
            "-copyts",
            ...recordingInput(source.path),
            "-map",
            `0:a:${source.audio}?`,
          ]
        : [
            "-copyts",
            "-f",
            "mpegts",
            "-i",
            "pipe:0",
            "-map",
            `${programSpec(source.program)}:a:${source.audio.stream}?`,
            ...panArgs(source.audio),
          ];
  return [
    ...QUIET,
    ...input,
    "-vn",
    ...audioArgs("h264", LOWEST_RUNG),
    ...("offset" in source
      ? ["-output_ts_offset", source.offset.toFixed(6)]
      : []),
    "-avoid_negative_ts",
    "make_non_negative",
    ...FMP4_OUT,
  ];
}

/**
 * **録画ファイルの音声だけ** (`GET /api/recordings/<id>/file?audio=only`。スマートスピーカーへの Cast など)。
 * 元がどれ (元の TS・4K の局の元の録画・AV1・H.265・H.264) でも同じ形式で出せるよう、主音声を AAC 192k に再エンコードして ADTS で流す。
 * 4K の局の元の録画 (`.mmts`) は ffmpeg が読めないので、denpa が詰め替えた fMP4 を標準入力へ流す (`audioResponse` と同じ)。
 * 読めなければ null。本文は `transcodeBody` で作る。止まった ffmpeg・読まれなくなった応答は、観る画面の変換と同じく畳む。
 * 音声だけなので、その場で変換する本数の枠は使わない (`audioResponse` と同じ理由)
 */
export async function fileAudioBody(
  path: string,
  serviceId: number,
  idle?: { limit: number; every: number },
): Promise<ReadableStream<Uint8Array> | null> {
  const output = ["-vn", "-c:a", "aac", "-b:a", "192k", "-f", "adts", "pipe:1"];
  let attempt: Attempt;
  if (recordedTransport(path) === "tlv") {
    const mmts = await probeMmtsFile(path, serviceId);
    if (mmts === null) return null;
    attempt = {
      argv: [
        config.ffmpeg,
        ...QUIET,
        ...["-f", "mp4", "-i", "pipe:0", "-map", "0:a:0"],
        ...output,
      ],
      input: () => mmtsFmp4(mmts, serviceId, 0),
    };
  } else {
    attempt = {
      argv: [
        config.ffmpeg,
        ...QUIET,
        ...recordingInput(path),
        "-map",
        "0:a:0",
        ...output,
      ],
    };
  }
  return transcodeBody(
    [attempt],
    `[audio] 音声だけの取り出し ${path}`,
    () => undefined,
    idle,
  );
}

/** 読まれずに詰まった ffmpeg を畳むまで (ms) */
const IDLE_LIMIT = 5 * 60_000;
/** 詰まりを見る間隔 (ms) */
const IDLE_CHECK = 30_000;

/** ffmpeg を 1 回起こすぶん */
interface Attempt {
  argv: string[];
  /** 標準入力へ流し込むもの (TS が元)。起こすたびに読み直す */
  input?: () => ReadableStream<Uint8Array>;
  /**
   * 前の手が 1 バイトも出せずに降り、これで出せたときに呼ぶ (GPU のせいだったと覚える)。
   * 渡すのは降りた前の手の標準エラーの全文 (理由で覚えるかを決める。`hwenc.nvencBusy`)
   */
  blame?: (failed: string) => void;
  /**
   * これが 1 バイトも出せずに降り、次の手も無いときに呼ぶ (標準エラーの全文を渡す)。ソフトウェアに降りられない GPU
   * (段を下げた AV1・H.265) が、降りた方式を覚えるのに使う (`withFallback`)
   */
  gaveUp?: (failed: string) => void;
}

/**
 * **ffmpeg の出力を応答の本文にする。** 録画をその場で変換・詰め替えして HTTP で流すものは全部これを通す
 * (録画ファイルの音声だけ `fileAudioBody` も)。
 *
 * - 読まれたぶんしか読み出さない。相手が読まなければ出力が詰まり、ffmpeg も止まる
 * - 1 バイトも出さずに降りたら、次の手 (GPU → ソフトウェア) で起こし直す。次で出せたら、降りた手の標準エラーを添えて `blame` を呼ぶ
 * - `IDLE_LIMIT` のあいだ読まれなければ畳む。閉じられた・読み切った・落ちたときも畳む
 * - **読みに来て ffmpeg が出すのを待っている間は、「読まれない」ではなく「ffmpeg が出さない」として数える。**
 *   上限は同じ `IDLE_LIMIT`。分けていなかった頃は、出だしの遅い ffmpeg を待っている相手を
 *   「読まれない」(`idle`) で切っていた (単体テストで `sh` の起動が上限の 50ms に間に合わなかった回に落ちた)。
 *   何も出さずに固まった ffmpeg は、相手が切らなくても畳む (枠を持ったまま残さない)
 * - 畳んだら `done` を呼ぶ (枠を返す)
 * - `pace` があれば、出したものと ffmpeg を待った時間を渡す (送り出しの具合。`server/pace.ts`)
 */
export function transcodeBody(
  attempts: Attempt[],
  what: string,
  done: () => void,
  idle = { limit: IDLE_LIMIT, every: IDLE_CHECK },
  pace: StreamPace | null = null,
): ReadableStream<Uint8Array> {
  let index = 0;
  let proc: ReturnType<typeof spawnAttempt> | null = null;
  let sent = false;
  /** 1 つ前の手が降りたときの標準エラー (`Attempt.blame` に渡す) */
  let failed = "";
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
      // 起こせなければ (ffmpeg が無いなど) 枠を返してから断る。返さないと変換の枠が減ったままになる
      try {
        proc = spawnAttempt(attempts[0]!);
      } catch (error) {
        finish();
        throw error;
      }
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
      const since = Date.now();
      waitingSince = since;
      try {
        await fill(controller);
      } finally {
        waitingSince = null;
        lastRead = Date.now();
        pace?.wait(lastRead - since);
      }
    },
    cancel() {
      finish();
    },
  });

  /** ffmpeg の出力から 1 つ渡す (1 バイトも出さずに降りていたら次の手で起こし直す) */
  async function fill(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    for (;;) {
      const current = proc;
      if (current === null || finished) return;
      const { done: ended, value } = await current.read();
      if (finished) return;
      if (!ended) {
        if (!sent && index > 0) attempts[index]?.blame?.(failed);
        sent = true;
        pace?.output(value);
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
      if (finished) return;
      if (!sent && index + 1 < attempts.length) {
        console.warn(`${what}をやり直します (${code}): ${why}`);
        failed = await current.log();
        // 待っている間に接続が切れた。ここで次を起こすと、その ffmpeg は止められずに残る
        if (finished) return;
        index++;
        try {
          proc = spawnAttempt(attempts[index]!);
        } catch (error) {
          finish();
          controller.error(error);
          return;
        }
        continue;
      }
      console.warn(`${what}が止まりました (${code}): ${why}`);
      if (!sent) attempts[index]?.gaveUp?.(await current.log());
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
        // ffmpeg が先に降りたときも、読みかけのファイルを閉じる
        source.cancel().catch(() => undefined);
      }
    })().catch(() => undefined);
  }
  return {
    read: () => out.read(),
    exited: proc.exited,
    why: async () => (await stderr).trim().split("\n").slice(-3).join(" / "),
    /** 標準エラーの全文。降りた理由の行が最後の 3 行に入るとは限らない (`Attempt.blame`) */
    log: () => stderr,
    stop: () => {
      source?.cancel().catch(() => undefined);
      proc.kill();
    },
  };
}

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

/**
 * **`GET /api/recordings/<id>/stream` に答える。** `codec` は `h264` / `hevc` / `av1` / `mpeg2` / `audio`、`from` は物差しの秒、
 * `audio` は `playback` の `audios` の `id`。出せない形式は 404、枠が埋まっていれば 503。
 *
 * - `rung` (1〜3) は回線に合わせて下げた段 (`#lib/rungs.ts`)。エンコード済みと同じコーデックでも写さずに変換し、
 *   コーデックはサーバが `playable` から選ぶ (`live.rungCodec`)。H.265 のエンコード済みでも、GPU があれば H.265 のまま下げられる。
 *   `mpeg2` では効かない (放送のまま流す)
 * - `codec=audio` は音声だけ (AAC 96k の fMP4。`audioOnlyArgs`)。段 3 でも足りないときの最後の手で、枠は使わない
 *
 * fMP4 の応答には、中身のコーデック (`CODEC_HEADER`)・段 (`RUNG_HEADER`)・送り出しの具合を読む id (`PACE_HEADER`) を付ける
 */
export async function streamResponse(
  recording: Recording,
  query: URLSearchParams,
): Promise<Response> {
  const asked = query.get("codec");
  const codec: PlayCodec | "audio" | null =
    asked === "h264" ||
    asked === "hevc" ||
    asked === "av1" ||
    asked === "mpeg2" ||
    asked === "audio"
      ? asked
      : null;
  if (codec === null)
    error(400, "codec は h264 / hevc / av1 / mpeg2 / audio のどれかです");
  const fromRaw = Number(query.get("from") ?? 0);
  const from = Number.isFinite(fromRaw) ? Math.max(0, fromRaw) : 0;

  const plan = await playbackPlan(recording);
  if (plan === null) error(404, "この形式では再生できません");
  // 変換の元。エンコード済み (中身を読めたもの) があればそれ、無ければ元の TS
  const source = plan.encoded.find((file) => file.codec !== null);
  const label = `[stream] 録画 ${recording.id} (${codec})`;
  if (codec === "audio") return audioResponse(plan, source, from, query, label);
  if (codec === "mpeg2") {
    if (!plan.info.offers.some((o) => o.codec === "mpeg2"))
      error(404, "この形式では再生できません");
    return rawResponse(plan, from);
  }

  // 段を下げないなら `offers` にあるものだけ。下げるなら、変換の元があればどの形式でもよい (コーデックはサーバが選ぶ)
  const rung = parseRung(query.get("rung"));
  const offered =
    rung === 0
      ? plan.info.offers.some((o) => o.codec === codec && o.way !== "file")
      : source !== undefined || plan.ts !== null || plan.mmts !== null;
  if (!offered) error(404, "この形式では再生できません");

  // 4K の局の元の録画の H.265 は、放送の HEVC と AAC の詰め替え (エンコードしない。枠も使わない)
  if (plan.mmts !== null && codec === "hevc" && rung === 0)
    return mmtsPassthrough(plan.mmts, plan.program, from);

  // TS で送る 4K の局の元の録画の H.265 は、映像を写して音声を AAC にする (`tsTranscodeArgs`。エンコードしないので枠を使わない)
  if (
    source === undefined &&
    plan.broadcast === "hevc" &&
    plan.ts !== null &&
    codec === "hevc" &&
    rung === 0
  ) {
    const attempts = await tsAttempts(
      plan,
      from,
      pickTrack(plan.tracks, query.get("audio") ?? undefined),
      "hevc",
      0,
    );
    if (attempts === null) error(404, "この形式では再生できません");
    const pace = new StreamPace(false);
    const opened = openPace(() => pace.read());
    return new Response(
      transcodeBody(attempts, `${label} の写し`, opened.close, undefined, pace),
      { headers: mp4Headers("hevc", 0, opened.id) },
    );
  }

  const same = plan.encoded.find((file) => file.codec === codec);
  if (same !== undefined && rung === 0) {
    const pace = new StreamPace(false);
    const opened = openPace(() => pace.read());
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
        opened.close,
        undefined,
        pace,
      ),
      { headers: mp4Headers(codec, 0, opened.id) },
    );
  }
  // 段を下げないなら H.265 は詰め替えだけ (`playbackPlan`)。offers にあればファイルがあるので、ここには来ない
  if (codec === "hevc" && rung === 0) error(404, "この形式では再生できません");

  /*
   * 段を下げるならコーデックはサーバが選ぶ。H.265・AV1 は GPU があるときだけ選ばれる (`live.rungCodec`)。
   * 4K の局 (元の録画か、HLG のエンコード済み) は H.265 にエンコードしない (`live.liveRungCodec`。ライブと同じ)。
   * 元の録画が TS で送る 4K の局のもの (`broadcast` が `hevc`) も同じ
   */
  const playable = parsePlayable(query.get("playable"), codec);
  const uhd =
    source === undefined ? plan.broadcast === "hevc" : source.media.hlg;
  const output =
    rung === 0
      ? codec
      : uhd
        ? liveRungCodec(playable, "hevc")
        : rungCodec(playable, source === undefined);

  const held = holdTranscode();
  if (held === null) error(503, BUSY);
  const pace = new StreamPace(true);
  const opened = openPace(() => pace.read());
  const release = () => {
    held();
    opened.close();
  };
  let attempts: Attempt[] | null;
  try {
    attempts =
      source !== undefined
        ? fileAttempts(
            source,
            from,
            audioIndex(query.get("audio")),
            output,
            rung,
          )
        : plan.mmts !== null
          ? mmtsAttempts(plan.mmts, plan.program, from, output, rung)
          : await tsAttempts(
              plan,
              from,
              pickTrack(plan.tracks, query.get("audio") ?? undefined),
              output,
              rung,
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
  return new Response(
    transcodeBody(attempts, `${label} の変換`, release, undefined, pace),
    { headers: mp4Headers(output, rung, opened.id) },
  );
}

/** fMP4 の応答ヘッダ。中身のコーデック・段・送り出しの具合を読む id (`#lib/ts/playback.ts`) */
function mp4Headers(
  codec: LiveCodec | "audio",
  rung: Rung,
  pace: string,
): Record<string, string> {
  return {
    "Content-Type": codec === "audio" ? "audio/mp4" : "video/mp4",
    "Cache-Control": "no-store",
    [CODEC_HEADER]: codec,
    [RUNG_HEADER]: String(rung),
    [PACE_HEADER]: pace,
  };
}

/**
 * 音声だけ (`?codec=audio`。`audioOnlyArgs`)。**その場で変換する本数の枠は使わない。** 枠は映像のデコードとエンコードで
 * CPU (GPU) を食い潰さないためのもので、音声だけなら映像はデコードもエンコードもしない (`-vn`)。AAC 96k のエンコードは
 * 映像のエンコードと比べてずっと軽い (本数ごとの重さは測っていない)。録画ファイルの `?audio=only` とライブの `?audio=only` も
 * 数えていないので、同じ扱いにする。上限の設定は足さない
 */
async function audioResponse(
  plan: PlaybackPlan,
  source: EncodedFile | undefined,
  from: number,
  query: URLSearchParams,
  label: string,
): Promise<Response> {
  let attempt: Attempt | null = null;
  if (source !== undefined) {
    attempt = {
      argv: [
        config.ffmpeg,
        ...audioOnlyArgs({
          path: source.path,
          from,
          audio: audioIndex(query.get("audio")),
        }),
      ],
    };
  } else if (plan.mmts !== null) {
    const mmts = plan.mmts;
    attempt = {
      argv: [config.ffmpeg, ...audioOnlyArgs({ fmp4: true })],
      input: () => mmtsFmp4(mmts, plan.program, mmtsOffset(mmts, from)),
    };
  } else if (plan.ts !== null) {
    const ts = plan.ts;
    const mark = await seekFrom(ts, plan.skip, from);
    if (mark !== null) {
      attempt = {
        argv: [
          config.ffmpeg,
          ...audioOnlyArgs({
            program: plan.program,
            audio: pickTrack(plan.tracks, query.get("audio") ?? undefined),
            offset: tsOffset(
              mark.pts,
              sinceHead(mark.pts, ts.head) - plan.skip,
            ),
          }),
        ],
        input: () => recordingStream(ts.path, mark.at),
      };
    }
  }
  if (attempt === null) error(404, "この形式では再生できません");
  const pace = new StreamPace(false);
  const opened = openPace(() => pace.read());
  return new Response(
    transcodeBody(
      [attempt],
      `${label} の音声だけ`,
      opened.close,
      undefined,
      pace,
    ),
    { headers: mp4Headers("audio", 0, opened.id) },
  );
}

/**
 * GPU でエンコードできるなら GPU、駄目ならソフトウェア。GPU が 1 バイトも出せずに降りたら覚える。
 * NVENC の同時に開ける数を超えただけなら覚えない (`live.blameLiveHw`)。
 *
 * **段を下げた AV1・H.265 はソフトウェアに降りない** (`live.softwareEncodes`)。GPU が降りたらそこで止め、降りた方式を覚える (`gaveUp`)。
 * 画面が同じ段をリクエストし直すと、覚えている間は次のコーデックになる (`live.rungCodec`)
 */
function withFallback(
  codec: LiveCodec,
  interlaced: boolean,
  build: (hw: LiveHw | null) => Attempt,
  rung: Rung,
): Attempt[] {
  const hw = pickLiveHw(codec, interlaced);
  if (hw === null) return [build(null)];
  const blame = (failed: string) => {
    blameLiveHw(codec, hw, nvencBusy(failed));
  };
  if (!softwareEncodes(codec, rung)) return [{ ...build(hw), gaveUp: blame }];
  return [build(hw), { ...build(null), blame }];
}

function fileAttempts(
  source: EncodedFile,
  from: number,
  audio: number,
  codec: LiveCodec,
  rung: Rung,
): Attempt[] {
  return withFallback(
    codec,
    false,
    (hw) => ({
      argv: [
        config.ffmpeg,
        ...fileTranscodeArgs(
          source.path,
          from,
          audio,
          codec,
          hw,
          rung,
          source.media.fps,
          source.media.hlg,
        ),
      ],
    }),
    rung,
  );
}

/** 4K の局の元の録画から変換する (`mmtsTranscodeArgs`)。プログレッシブなので GPU はインタレ解除の無いものを選ぶ */
function mmtsAttempts(
  mmts: MmtsFile,
  program: number,
  from: number,
  codec: LiveCodec,
  rung: Rung,
): Attempt[] {
  const offset = mmtsOffset(mmts, from);
  return withFallback(
    codec,
    false,
    (hw) => ({
      argv: [config.ffmpeg, ...mmtsTranscodeArgs(codec, hw, rung)],
      input: () => mmtsFmp4(mmts, program, offset),
    }),
    rung,
  );
}

/**
 * **4K の局の元の録画の H.265。** 放送の HEVC と AAC を物差しの時刻の fMP4 に詰め替えて流す (`mmts.mmtsFmp4`)。
 * ffmpeg は起こさず、枠も使わない (エンコード済みの詰め替えと同じく軽い)。時刻は物差しの秒なので、`from` の手前の
 * 頭出しできるコマから始まる
 */
function mmtsPassthrough(
  mmts: MmtsFile,
  program: number,
  from: number,
): Response {
  const pace = new StreamPace(false);
  const opened = openPace(() => pace.read());
  const reader = mmtsFmp4(mmts, program, mmtsOffset(mmts, from)).getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const since = Date.now();
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch (error) {
        // 読んでいる途中で録画を消されたなど。送り出しの具合の登録を残さない
        opened.close();
        controller.error(error);
        return;
      }
      const { done, value } = read;
      pace.wait(Date.now() - since);
      if (done) {
        opened.close();
        controller.close();
        return;
      }
      pace.output(value);
      controller.enqueue(value);
    },
    async cancel() {
      opened.close();
      await reader.cancel();
    },
  });
  return new Response(body, { headers: mp4Headers("hevc", 0, opened.id) });
}

async function tsAttempts(
  plan: PlaybackPlan,
  from: number,
  audio: AudioTrack,
  codec: LiveCodec,
  rung: Rung,
): Promise<Attempt[] | null> {
  const ts = plan.ts;
  if (ts === null) return null;
  const mark = await seekFrom(ts, plan.skip, from);
  if (mark === null) return null;
  const offset = tsOffset(mark.pts, sinceHead(mark.pts, ts.head) - plan.skip);
  const input = () => recordingStream(ts.path, mark.at);
  const build = (hw: LiveHw | null): Attempt => ({
    argv: [
      config.ffmpeg,
      ...tsTranscodeArgs(
        plan.program,
        audio,
        codec,
        hw,
        offset,
        rung,
        plan.broadcast,
      ),
    ],
    input,
  });
  // TS で送る 4K の局の段 0 の H.265 は映像を写す。GPU は使わない
  if (plan.broadcast === "hevc" && codec === "hevc" && rung === 0)
    return [build(null)];
  // 4K の局はプログレッシブなので、GPU はインタレ解除の無いものを選ぶ (`mmtsAttempts` と同じ)
  return withFallback(codec, plan.broadcast !== "hevc", build, rung);
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
  const origin = inWrap(ts.head + Math.round(plan.skip * CLOCK));
  return new Response(recordingStream(ts.path, mark.at), {
    headers: {
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-store",
      // `live`・`chase` の放送のままと同じ値 (`codec=mpeg2` でリクエストされても `raw`)
      [CODEC_HEADER]: "raw",
      [ORIGIN_HEADER]: String(origin),
    },
  });
}

/**
 * 続きの位置の物差し (`ts/watch.ts` の `Ruler`)。`source` は観ているファイル (`?source=` と同じ語彙)。
 * null なら観る画面と同じ決め方 (エンコードしたものがあればそれ、無ければ元の TS。`playbackPlan` の `axis`)。
 * 元の TS の物差しなら null
 */
export function rulerOf(
  recording: EncodedColumns & Pick<Recording, "cm_kept" | "encode_skip">,
  source: FileSource | null,
): Ruler | null {
  const encoded =
    source === null ? encodedFile(recording) !== null : source !== "ts";
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
 * 元の TS の位置のまま出来上がりの尺から引くと、捨てた先頭 (v2.37 までに CM を切ったものは切った CM も) のぶん食い違う。
 * 続きが無い・直すと先頭になる (捨てた先頭の中で止めた) ものは null
 */
export function watchProgress(
  recording: Pick<
    Recording,
    | "library_path"
    | "hevc_path"
    | "alt_path"
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
 * **エンコード済みが無い録画の、CM 飛ばしのチャプター。** 検出した CM の区間 (`cm_ranges`) は
 * 元の TS の先頭からの秒で持っている (`encoder.ts` の `runCmJob`) ので、物差し (`ts`) にそのまま乗る
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
  // 4K の局の録画 (`.mmts`) の物差しは録画の先頭 (`mmts.ts`)。CM の区間も同じ物差しで覚えている (`encoder.runCmJob`)
  const duration =
    recordedTransport(path) === "tlv"
      ? (await probeMmtsFile(path, aribServiceId(recording.service_id)))
          ?.duration
      : (await probeTs(path))?.duration;
  return chapterList(recording.cm_ranges, duration ?? recordedSec(recording));
}

/**
 * **字幕のストリームだけを抜く引数** (`api/recordings/<id>/captions.json`)。デコードせずに写す (デコードするのは denpa)。
 *
 * エンコード済みがあればそこから。無ければ元の TS から抜き、時刻を物差し (TS の先頭を 0) に揃える
 * (`-copyts` で放送の PTS を運び、先頭のぶん引く。`presented`)。どちらも無ければ null
 */
export async function captionArgs(recording: Recording): Promise<{
  argv: string[];
  /** 抜くファイル (エンコード済み)。元の TS から抜くときは null */
  path: string | null;
} | null> {
  const encoded = encodedFile(recording);
  const out = ["-c:s", "copy", "-f", "matroska", "pipe:1"];
  if (encoded !== null) {
    return {
      argv: [
        "-v",
        "error",
        ...recordingInput(encoded),
        "-map",
        "0:s:0",
        ...out,
      ],
      path: encoded,
    };
  }
  const path = tsPathOf(recording);
  // 4K の局の録画は TTML で、ffmpeg では抜けない (`uhdCaptionSource`)
  const ts =
    path === null || recordedTransport(path) === "tlv"
      ? null
      : await probeTs(path);
  if (ts === null) return null;
  return {
    argv: [
      "-v",
      "error",
      "-copyts",
      ...recordingInput(ts.path),
      "-map",
      `${programSpec(aribServiceId(recording.service_id))}:s:0`,
      "-output_ts_offset",
      (-presented(ts.head)).toFixed(6),
      ...out,
    ],
    path: null,
  };
}

/**
 * **4K の局の録画の字幕の在り処** (`api/recordings/<id>/captions.json`)。TTML は ffmpeg では抜けないので (`captionArgs`)、
 * エンコード済みがあればその隣の文字の配置 (`….captions.json`。`encoder.writeCaptions`)、無ければ元の録画 (`.mmts`) を読む
 * (`mmts.mmtsCaptions`)。エンコード済みの隣に文字の配置が無いとき (TS の局の録画と、字幕の無い 4K の局の録画) と、
 * 元の録画が TS のときは null (TS の局の字幕は `captionArgs`)
 */
export async function uhdCaptionSource(
  recording: Recording,
): Promise<
  | { sidecar: string }
  | { mmts: MmtsFile; serviceId: number }
  | { missing: true }
  | null
> {
  const encoded = encodedFile(recording);
  if (encoded !== null) {
    const sidecar = sidecarPaths(encoded).captions;
    return existsSync(sidecar) ? { sidecar } : null;
  }
  const path = tsPathOf(recording);
  if (path === null || recordedTransport(path) !== "tlv") return null;
  const serviceId = aribServiceId(recording.service_id);
  const mmts =
    recording.finished_at === null
      ? null
      : await probeMmtsFile(path, serviceId);
  return mmts === null ? { missing: true } : { mmts, serviceId };
}
