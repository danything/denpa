/**
 * **録画の途中から現れる音声 (野球中継の副音声など) を、エンコードしたものに残す。**
 *
 * エンコードする ffmpeg は、録画の先頭を探った (`ts-probe.tsProbe`) 範囲で見つけた音声しか扱えない。
 *
 * - 途中で PMT に足された ES は、ffmpeg が開いた後に現れるので `-map` に当たらない
 * - 先頭から PMT にあっても中身の無い ES は、パラメータが分からない (`cm.probeLiveAudio` で外している)。
 *   `-map` すると、ffmpeg はその ES の中身が来るまでエンコーダを開けず、ほかのトラックのパケットを書き出さずに溜める。
 *   短い偽の TS では通った (ffmpeg 9.0.2) が、長い番組では溜める量の上限を超えて失敗すると見ている (推定)
 *
 * そこで、録画全体の PMT と音声の PES を読み (`scanAudioEs`)、先頭の探りで中身の無かった ES を見つける (`lateAudio`)。
 * 見つけた ES は、現れる手前から別の ffmpeg で音声だけを Opus にし (`lateAudioArgs`)、
 * チャプターを書き足すときに `-c copy` で足す (`cm.chapterArgs` の `extra`)。時刻は元の TS の PTS のまま読み
 * (`-copyts`)、本編と同じ物差しへずらして書く (`lateOffset`)
 */

import { existsSync } from "node:fs";

import { CLOCK, readStamp, WRAP } from "@danything/arib/pes";
import {
  componentTagOf,
  findSync,
  PACKET,
  packetPid,
  PID_PAT,
  pmtStreams,
  PmtTracker,
  STREAM_AAC,
  SYNC,
  TABLE_PMT,
} from "@danything/arib/psi";

import { type Audio, audioChannels, audioTracks, onPmt } from "#lib/arib.js";

import type { LiveAudio } from "./cm";
import { config } from "./config";
import { removeIfExists } from "./fsx";
import { openRecording, recordingInput } from "./recording-io";
import { run } from "./stream";
import { TS_PROBE } from "./ts-probe";

/** 録画に入っている音声の ES 1 本 */
export interface AudioEs {
  pid: number;
  /** 初めて挙がった PMT での、音声の何本目か (`STREAM_AAC` だけを PMT の順に数える。番組表と突き合わせる) */
  index: number;
  /** 初めて挙がった PMT の音声の部品タグ (PMT の順。`arib.audioTracks` の `pmt`) */
  tags: (number | null)[];
  /** 最初の PES の手前にある PAT の位置 (バイト)。ffmpeg はここから読めば PAT → PMT → ES の順に見つける */
  resume: number;
  /** 最初の PES の PTS (90 kHz。放送の時刻そのもの) */
  first: number;
  /** 最後の PES の PTS (90 kHz) */
  last: number;
}

/**
 * **TS のパケットを順に受け取り、音声の ES が現れる位置を記録する。** ファイルを読むのは `scanAudioEs`。
 * 1 局に絞った TS を渡す (録画の TS は 1 局。PAT の最初の局を追う)
 */
export class AudioEsScanner {
  private readonly pmt = new PmtTracker();
  /** PMT に挙がった音声の ES。PES を見る前のものも入る */
  private readonly listed = new Map<
    number,
    { index: number; tags: (number | null)[] }
  >();
  private readonly found = new Map<number, AudioEs>();
  /** 最後に見た PAT のパケットの位置 */
  private lastPat = 0;

  /** パケットを 1 つ。`at` はファイルの先頭からの位置 (バイト) */
  feed(packet: Uint8Array, at: number): void {
    const pid = packetPid(packet);
    if (pid === PID_PAT) this.lastPat = at;
    if (pid === PID_PAT || pid === this.pmt.pid) {
      for (const section of this.pmt.feed(packet, pid))
        if (section[0] === TABLE_PMT) this.readPmt(section);
      return;
    }
    // PES の先頭 (payload_unit_start_indicator) だけを見る
    if ((packet[1]! & 0x40) === 0) return;
    const es = this.listed.get(pid);
    if (es === undefined) return;
    const pts = pesPts(packet);
    if (pts === null) return;
    const seen = this.found.get(pid);
    if (seen !== undefined) {
      seen.last = pts;
      return;
    }
    this.found.set(pid, {
      pid,
      index: es.index,
      tags: es.tags,
      resume: this.lastPat,
      first: pts,
      last: pts,
    });
  }

  /** 中身 (PES) が 1 つでも来た音声の ES。現れた順 */
  result(): AudioEs[] {
    return [...this.found.values()];
  }

  private readPmt(section: Uint8Array): void {
    const audios = [...pmtStreams(section)].filter(
      ([type]) => type === STREAM_AAC,
    );
    const tags = audios.map(([, , info]) => componentTagOf(info));
    audios.forEach(([, pid], index) => {
      if (!this.listed.has(pid)) this.listed.set(pid, { index, tags });
    });
  }
}

/** パケットの中身の先頭にある PES ヘッダの PTS。無ければ null */
function pesPts(packet: Uint8Array): number | null {
  const adaptation = (packet[3]! >> 4) & 0x03;
  if (adaptation === 0 || adaptation === 2) return null;
  const start = adaptation === 3 ? 5 + packet[4]! : 4;
  if (start + 14 > PACKET) return null;
  if (packet[start] !== 0 || packet[start + 1] !== 0 || packet[start + 2] !== 1)
    return null;
  // PTS_DTS_flags の上のビットが PTS
  if ((packet[start + 7]! & 0x80) === 0) return null;
  return readStamp(packet, start + 9);
}

/** 1 回に読む大きさ。188 の倍数で約 1 MB */
const CHUNK = PACKET * 5577;

/**
 * **録画全体を読んで、音声の ES が現れる位置を返す。** 読めなければ空。
 *
 * 映像も音声もデコードせず、パケットの先頭だけを見るので、読む速さはディスクで決まる。
 * チャンクごとに await してイベントループを止めない (`recorded-bml.ts` の `capture` と同じ考え)。
 * 188 バイトのパケットの並びでなければ (同期が取れなければ) 何も見つからない
 */
export async function scanAudioEs(
  path: string,
  signal?: AbortSignal,
): Promise<AudioEs[]> {
  const scanner = new AudioEsScanner();
  const file = await openRecording(path);
  try {
    const buffer = Buffer.alloc(CHUNK);
    let position = 0;
    for (;;) {
      if (signal?.aborted === true) return [];
      const { bytesRead } = await file.read(buffer, 0, CHUNK, position);
      if (bytesRead < PACKET) break;
      let at = 0;
      while (at + PACKET <= bytesRead) {
        if (buffer[at] !== SYNC) {
          const next = findSync(buffer, at, bytesRead);
          if (next < 0) break;
          at = next;
          continue;
        }
        scanner.feed(buffer.subarray(at, at + PACKET), position + at);
        at += PACKET;
      }
      // 同期を探せなかったときも、次のチャンクで探し直せるよう 1 パケット手前までは進める
      position += Math.max(at, bytesRead - PACKET, 1);
    }
  } finally {
    await file.close();
  }
  return scanner.result();
}

/** 1 周 (33 ビット) を秒で */
const WRAP_SECONDS = WRAP / CLOCK;

/**
 * PTS を、録画の先頭 (`formatStart`。`cm.probeVideo`) からの秒にする。
 * 録画の途中で PTS が 1 周していても、先頭より後ろとして数える
 */
export function sinceStart(pts: number, formatStart: number): number {
  const seconds = pts / CLOCK - formatStart;
  return ((seconds % WRAP_SECONDS) + WRAP_SECONDS) % WRAP_SECONDS;
}

/**
 * 足す ES を選ぶ。**エンコードする ffmpeg が使う ES (`live`。先頭の探りで中身のあったものの PID) は除き、
 * 番組の間 (`programStart` から `programEnd`。録画の先頭からの秒) に中身のあるものだけを残す。**
 *
 * - 番組が終わってから現れるもの (末尾に入った次の番組の副音声) は足さない
 * - 番組が始まる前に消えたもの (先頭に入った前の番組の副音声) は足さない
 *
 * 録画の先頭の時刻 (`formatStart`) が分からなければ、位置を決められないので何も足さない
 */
export function lateAudio(
  found: readonly AudioEs[],
  live: readonly number[],
  span: { formatStart: number; programStart: number; programEnd: number },
): AudioEs[] {
  if (!Number.isFinite(span.formatStart)) return [];
  return found.filter(
    (es) =>
      !live.includes(es.pid) &&
      sinceStart(es.first, span.formatStart) < span.programEnd &&
      sinceStart(es.last, span.formatStart) >= span.programStart,
  );
}

/**
 * **足すときのずらし幅 (秒)。** 本編は録画の先頭 (`formatStart`) から `skip` 秒を捨てたところを 0 秒として
 * 数えている (`encoder.buildArgs` の `-ss`)。途中から読んだ ffmpeg は PTS のまま読む (`-copyts`) ので、そのぶんを引く。
 *
 * 録画の先頭より後で PTS が 1 周していると、途中から読んだ ffmpeg は周回後の小さな値で読む。そのときは 1 周を足す
 */
export function lateOffset(
  es: AudioEs,
  formatStart: number,
  skip: number,
): number {
  const wrapped = es.first / CLOCK < formatStart ? WRAP_SECONDS : 0;
  return wrapped - formatStart - skip;
}

/**
 * **途中から現れる ES を、音声だけ Opus にする ffmpeg の引数。**
 *
 * - 現れる手前の PAT から読む (`-skip_initial_bytes`)。先頭から開くと、途中で PMT に足された ES を ffmpeg が見つけられない
 * - ES は PID で名指しする (`0:i:<PID>`)。途中から開くと、音声の何本目かが録画の先頭と食い違う
 * - 時刻は PTS のまま読み (`-copyts`)、本編の物差しへずらす (`offset`。`lateOffset`)
 * - **本編の 0 秒から ES が現れるまでは無音で埋める** (`aresample` の `first_pts=0`)。途中で途切れた所も埋める (`async`)。
 *   埋めないと、その音声へ切り替えたときに、現れるまでの間は音声が無く再生が進まない
 * - ビットレートは本編の音声と同じ (`encoder.buildArgs`)。チャンネル数は番組表の構成にそろえる
 */
export function lateAudioArgs(
  input: string,
  es: AudioEs,
  output: string,
  offset: number,
  channels?: number,
): string[] {
  const shift = `${offset < 0 ? "-" : "+"}${Math.abs(offset).toFixed(6)}`;
  return [
    config.ffmpeg,
    "-y",
    "-v",
    "error",
    "-copyts",
    "-skip_initial_bytes",
    String(es.resume),
    ...TS_PROBE,
    ...recordingInput(input),
    "-map",
    `0:i:${es.pid}`,
    "-af",
    `asetpts=PTS${shift}/TB,aresample=async=1:first_pts=0`,
    "-c:a",
    "libopus",
    "-b:a",
    "256k",
    ...(channels === undefined ? [] : ["-ac", String(channels)]),
    "-f",
    "matroska",
    output,
  ];
}

/** 足す音声 1 本 (`findLateAudio` が見つけたもの) */
export interface LateAudio {
  es: AudioEs;
  /** トラックの名前 (番組表と同じ言い方。`arib.audioTracks`)。分からなければ空 */
  title: string;
  /** チャンネル数 (番組表の構成。`arib.audioChannels`) */
  channels: number | undefined;
}

/**
 * **途中から現れる音声を探す。** 録画全体を読む (`scanAudioEs`) ので、エンコードと並行して呼ぶ。
 *
 * 先頭の探りで中身のあった音声 (`live`) が分からなければ (ffprobe が使えない・PID が読めない)、何が途中から
 * 現れたかを決められないので何も探さない
 */
export async function findLateAudio(
  input: string,
  options: {
    live: readonly LiveAudio[];
    formatStart: number;
    programStart: number;
    programEnd: number;
    audios: Audio[];
    signal: AbortSignal;
  },
): Promise<LateAudio[]> {
  const pids = options.live.flatMap((audio) =>
    audio.pid === null ? [] : [audio.pid],
  );
  if (pids.length === 0 || pids.length < options.live.length) return [];
  if (!Number.isFinite(options.formatStart)) return [];
  const found = lateAudio(
    await scanAudioEs(input, options.signal),
    pids,
    options,
  );
  return found.map((es) => {
    const audio = onPmt(options.audios, es.tags)[es.index];
    const title =
      audioTracks(options.audios, es.tags).find(
        (track) => track.stream === es.index && track.side === "both",
      )?.label ?? "";
    return {
      es,
      title,
      channels:
        audio === undefined ? undefined : audioChannels(audio.componentType),
    };
  });
}

/**
 * 見つけた音声を 1 本、本編の物差し (`offset`) で Opus にして `output` に書く。書けたら true。
 * 書けなかったものは足さないだけで、本編のエンコードは止めない
 */
export async function encodeLateAudio(
  input: string,
  late: LateAudio,
  offset: number,
  output: string,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await run(
    lateAudioArgs(input, late.es, output, offset, late.channels),
    { signal, lowPriority: true, stderr: true },
  );
  if (result.code === 0 && existsSync(output)) return true;
  removeIfExists(output);
  if (!signal.aborted)
    console.error(
      `[encode] 途中から現れる音声 (PID ${late.es.pid}) をエンコードできませんでした。足さずに置きます: ${result.stderr.slice(-500)}`,
    );
  return false;
}
