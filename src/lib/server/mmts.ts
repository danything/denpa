/**
 * **4K の局の録画 (`.mmts`) を読む。** 録画は 1 局に絞った TLV のまま置いてある (`recorder.ts`)。
 * ここで映像と音声を fMP4 に詰め替え、字幕 (TTML) を文字の配置にする。ffmpeg も ffprobe も TLV を読めないので、
 * 4K の録画を読む所はどこもここを通す。
 *
 * - 観る画面の詰め替えと変換 (`playback.ts` の `mmtsAttempts`・`mmtsBody`)
 * - エンコードの前の詰め替え (`encoder.ts` の `runJob`。`remuxMmts` で作業ファイルの MP4 を作り、あとは TS の録画と同じ)
 * - 字幕 (`api/recordings/<id>/captions.json`。`mmtsCaptions`)
 *
 * **物差しは録画の先頭を 0 とした秒** (`MmtsFile.head`)。先頭はファイルの最初の頭出しできる映像のコマの DTS
 * (`MmtFmp4.origin` と同じ決め方)。TS の録画の物差し (先頭の PTS を 0) と同じ役で、字幕・チャプター・続きの位置もこれで数える
 */

import type { CaptionPages } from "@danything/arib/caption-text";
import { CAPTION_TEXT_VERSION } from "@danything/arib/caption-text";
import {
  CLOCK,
  type MediaEvent,
  MmtMediaReader,
} from "@danything/arib/mmt-media";
import { ttmlPages } from "@danything/arib/ttml";

import { type Fmp4Segment, MmtFmp4 } from "#lib/mp4/mmt.js";

import { readRecording, recordingStream } from "./recording-io";
import { chunks } from "./stream";

/** 読んだ結果 (`MmtsReader`) */
export interface MmtsOut {
  /** 詰め替えた fMP4 (init と media) */
  segments: Fmp4Segment[];
  /** 字幕の文字の配置。`at` は物差しの秒 */
  captions: CaptionPages["pages"];
}

/**
 * 1 局に絞った TLV を読んで、fMP4 と字幕を返す。`live-mmt.ts` の `MmtLive` の録画版で、違いは 2 つ。
 *
 * - 時刻 0 を決めて渡せる (`base`)。途中から読んでも録画の物差しの時刻で出す
 * - 番組が替わってアセットの並び (MPT) が変わっても作り直さない。録画は 1 本の fMP4 にするので、init を出し直せない。
 *   アセットを選び直しても、映像と音声はそれぞれのトラックに続けて入れる (4K の局は番組が替わっても HEVC と AAC のままと見ている。推定)
 */
export class MmtsReader {
  private readonly reader: MmtMediaReader;
  private muxer: MmtFmp4 | null = null;

  /**
   * @param serviceId 局の service_id (MPT の MMT_package_id)
   * @param base 時刻 0 に当てる放送の時刻 (90 kHz。`MmtsFile.head`)。省けば最初に使う頭出しできるコマの DTS
   */
  constructor(
    serviceId: number,
    private readonly base: number | null = null,
  ) {
    this.reader = new MmtMediaReader(serviceId);
  }

  /** スクランブルされていて読めなかった MMTP のパケットの数 (`MmtMediaReader.scrambled`) */
  get scrambled(): number {
    return this.reader.scrambled;
  }

  /** 最初に使った頭出しできる映像のコマの DTS (90 kHz)。init を出すまでは null */
  get origin(): number | null {
    return this.muxer?.origin ?? null;
  }

  feed(chunk: Uint8Array): MmtsOut {
    return this.take(this.reader.feed(chunk));
  }

  /** 終わりまで読んだ。組み立て中のものを閉じて、溜めているぶんを出す */
  end(): MmtsOut {
    const out = this.take(this.reader.end());
    if (this.muxer !== null) out.segments.push(...this.muxer.flush());
    return out;
  }

  private take(events: Iterable<MediaEvent>): MmtsOut {
    const out: MmtsOut = { segments: [], captions: [] };
    for (const event of events) {
      if (event.kind === "assets") {
        this.muxer ??= new MmtFmp4(event.assets, this.base);
        continue;
      }
      const muxer = this.muxer;
      if (muxer === null) continue;
      if (event.kind === "caption") {
        const zero = muxer.zero;
        if (zero === null) continue;
        for (const shown of ttmlPages(event.document, event.pts))
          out.captions.push({
            at: (shown.at - zero) / CLOCK,
            page: shown.page,
          });
        continue;
      }
      out.segments.push(...muxer.push(event));
    }
    return out;
  }
}

/** 4K の録画の先頭と尺 (`probeMmts`) */
export interface MmtsFile {
  path: string;
  /** ファイルの大きさ (バイト) */
  size: number;
  /** 物差しの 0 に当たる放送の時刻 (90 kHz)。最初の頭出しできる映像のコマの DTS */
  head: number;
  /** 尺 (秒)。最後の映像のコマまで。読めなければ null */
  duration: number | null;
}

/**
 * 先頭と末尾から読む量。**頭出しできるコマと MPT が入る長さ。** MPT は 0.1 秒おき、頭出しできるコマは 0.5 秒おきに来る
 * (実機のケーブルの BS4K)。1 局で約 33 Mbps なので、8 MB は約 2 秒
 */
const SPAN_BYTES = 8 * 1024 * 1024;

/** 測ったものの控え。同じファイル (大きさと更新時刻) なら読み直さない */
const probed = new Map<string, { key: string; file: MmtsFile | null }>();
const PROBED_MOST = 32;

/**
 * **4K の録画の先頭と尺を測る。** 先頭の 8 MB で最初の頭出しできるコマを、末尾の 8 MB で最後の映像のコマを読む。
 * 先頭が読めなければ null (録り始めたばかり・スクランブルされたまま)
 *
 * @param key 控えの鍵 (大きさと更新時刻)。変わっていなければ測り直さない
 */
export async function probeMmts(
  path: string,
  size: number,
  key: string,
  serviceId: number,
): Promise<MmtsFile | null> {
  const held = probed.get(path);
  if (held?.key === key) return held.file;
  let file: MmtsFile | null = null;
  const first = new MmtsReader(serviceId);
  first.feed(await readRecording(path, 0, SPAN_BYTES));
  first.end();
  const head = first.origin;
  if (head !== null) {
    const tail = new MmtMediaReader(serviceId);
    let last: number | null = null;
    const look = (events: Iterable<MediaEvent>) => {
      for (const event of events)
        if (event.kind === "video") last = Math.max(last ?? 0, event.pts);
    };
    look(
      tail.feed(
        await readRecording(path, Math.max(0, size - SPAN_BYTES), SPAN_BYTES),
      ),
    );
    look(tail.end());
    const span = last === null ? null : (last - head) / CLOCK;
    file = {
      path,
      size,
      head,
      duration: span !== null && span > 0 ? span : null,
    };
  }
  probed.delete(path);
  probed.set(path, { key, file });
  if (probed.size > PROBED_MOST) probed.delete(probed.keys().next().value!);
  return file;
}

/** 求められた時刻のこれだけ手前から読む (秒)。頭出しできるコマを 1 つ含めるため (TS の `playback.ts` の `LEAD` と同じ) */
const LEAD = 1;

/**
 * 物差しの `from` 秒を出すために、ファイルのどこから読むか (バイト)。**バイト比例で当たりを付ける**
 * (追っかけの `chase.chasePlan` と同じ。TLV のパケットの途中からでも `TlvStream` が合わせ直す)
 */
export function mmtsOffset(file: MmtsFile, from: number): number {
  if (file.duration === null || from <= LEAD) return 0;
  const ratio = Math.min(1, (from - LEAD) / file.duration);
  return Math.floor(file.size * ratio);
}

/**
 * **4K の録画を `offset` バイト目から読んで、fMP4 を流す。** 時刻は物差しの秒 (`head` を 0)。読み終えたら閉じる。
 * 読む側が詰まっている間は読まない (`pull` で 1 つずつ渡す)
 */
export function mmtsFmp4(
  file: MmtsFile,
  serviceId: number,
  offset: number,
): ReadableStream<Uint8Array> {
  const reader = new MmtsReader(serviceId, file.head);
  const source = chunks(recordingStream(file.path, offset));
  const queue: Uint8Array[] = [];
  let ended = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (queue.length === 0 && !ended) {
        const next = await source.next();
        const out = next.done === true ? reader.end() : reader.feed(next.value);
        if (next.done === true) ended = true;
        for (const segment of out.segments) queue.push(segment.data);
      }
      const data = queue.shift();
      if (data === undefined) controller.close();
      else controller.enqueue(data);
    },
    async cancel() {
      await source.return(undefined);
    },
  });
}

/** 詰め替えた結果 (`remuxMmts`) */
export interface Remuxed {
  /** 1 バイトでも書けたか */
  wrote: boolean;
  /** スクランブルされていて読めなかった MMTP のパケットの数 */
  scrambled: number;
  /** 字幕の文字の配置。`at` は書いた MP4 の時刻 (秒。最初の頭出しできるコマの DTS を 0) */
  captions: CaptionPages["pages"];
}

/**
 * **4K の録画を、作業ファイルの MP4 (fragmented MP4) に詰め替える** (`encoder.ts`)。映像と音声はエンコードせずに写し、
 * 字幕は文字の配置にして返す。書いたものは ffmpeg と ffprobe が読める (ファイルの fMP4 は尺も読める。Debian の ffmpeg 7.1 で確かめた)。
 * 止めの合図が来たら書きかけのまま返す (消すのは呼ぶ側)
 */
export async function remuxMmts(
  path: string,
  serviceId: number,
  target: string,
  signal?: AbortSignal,
): Promise<Remuxed> {
  const reader = new MmtsReader(serviceId);
  const sink = Bun.file(target).writer();
  const captions: CaptionPages["pages"] = [];
  let wrote = false;
  const write = (out: MmtsOut) => {
    for (const segment of out.segments) {
      sink.write(segment.data);
      wrote = true;
    }
    captions.push(...out.captions);
  };
  try {
    for await (const chunk of chunks(recordingStream(path))) {
      if (signal?.aborted === true) break;
      write(reader.feed(chunk));
      await sink.flush();
    }
    if (signal?.aborted !== true) write(reader.end());
  } finally {
    await sink.end();
  }
  return { wrote, scrambled: reader.scrambled, captions };
}

/**
 * **4K の録画の字幕を、物差しの時刻で全部読む** (`api/recordings/<id>/captions.json`。エンコード済みが無い録画)。
 * 映像と音声は組まずに字幕のアセットだけを読む。字幕は第 1 言語の 1 つだけ (MPT の最初の字幕のアセット)
 */
export async function mmtsCaptions(
  file: MmtsFile,
  serviceId: number,
): Promise<CaptionPages> {
  const reader = new MmtMediaReader(serviceId);
  const pages: CaptionPages["pages"] = [];
  const take = (events: Iterable<MediaEvent>) => {
    for (const event of events) {
      if (event.kind !== "caption") continue;
      for (const shown of ttmlPages(event.document, event.pts))
        pages.push({ at: (shown.at - file.head) / CLOCK, page: shown.page });
    }
  };
  for await (const chunk of chunks(recordingStream(file.path)))
    take(reader.feed(chunk));
  take(reader.end());
  return { v: CAPTION_TEXT_VERSION, pages };
}
