/// <reference lib="webworker" />
/**
 * **エンコードしたもの (fMP4) を canvas に描く**、worker の中の半分 (`messages.ts` の `fmp4`)。
 *
 *     fMP4 ─→ 箱を読む (ts/fmp4.ts) ┬→ 映像: WebCodecs の VideoDecoder → 2D で描く
 *                                   └→ 音声: AAC は ADTS の頭を付けて / Opus はそのまま → WASM (worker.ts)
 *
 * **<video> の再生が止まる端末のための経路。** テスラの車載ブラウザは停車中でも <video> を
 * 止めるが、canvas に描くものは止めない。放送のままの MPEG-2 (worker.ts) と同じ考えで、時計は画面が
 * 鳴らしている音 (`playout.ts`)、ここは番が来たコマを出すだけ。
 *
 * MPEG-2 の経路との違い:
 *
 * - **デコードするのはブラウザ** (VideoDecoder)。たいてい GPU 経由で、デコードしたフレームは VideoFrame
 *   (GPU の上のフレーム) として出てくる。**描いたらすぐ閉じる** — 閉じずに持つと、デコーダの
 *   フレームの置き場が尽きて止まる (`DECODED_MOST` 枚より先にはデコードさせない)
 * - 描くのは 2D (`drawImage`)。インタレ解除はサーバが済ませている
 * - 時刻は MP4 の物差し (0 から数える。一周しない)。字幕・時計の通知も同じ物差しで来る
 * - 間に合っているかは VideoDecoder の詰まりと遅れで見る (`budget.ts` の `timed: false`)
 *
 * サーバは詰まった客には媒体を捨てる (`server/live.ts` の `hand`) ので、**コマの時刻が
 * 飛んだら次のキーフレームまで捨てる** — 参照するコマが欠けたまま渡すと、デコーダは崩れたフレームを
 * 出すか転ぶ。転んだら (`error`) 開き直してキーフレームから入り直し、続けて転ぶなら諦める。
 */

import { ascii, concatBytes, u32 } from "#lib/ts/bytes.js";
import {
  adtsHeader,
  type Fmp4Sample,
  type Fmp4Track,
  opusHead,
  readFragment,
  readInit,
} from "#lib/ts/fmp4.js";
import { CLOCK } from "#lib/ts/pes.js";

import { downscale } from "./downscale";
import type { GrabSize } from "./messages";

/** 番のこれだけ前からデコードする (90kHz) */
const AHEAD = 0.3 * CLOCK;
/**
 * デコードできたフレームと、渡したまま出てきていないフレームを合わせてこれだけまで (VideoFrame は GPU の置き場を使う)。
 * **少なすぎても多すぎても止まる** — 実測 (`tests/bench`。docs/stream.md#デコードしたフレームを持つ数) では、GPU で
 * デコードする H.264 (B フレームあり) は 4 以下だとデコーダが次を出せずに毎秒 30 コマ前後まで落ち、12 にすると
 * GPU の置き場が尽きてデコーダが止まった (「再生が追いつきません」)。数えていない手前の分を含めると、
 * 実際に抱えるのはこれより 2 枚ほど多い
 */
const DECODED_MOST = 8;
/** 圧縮のまま持っておく上限 (90kHz)。止めている間に溜め込まない */
const PENDING_MOST = 8 * CLOCK;
/** これだけ遅れたら、デコードしながら追いつくのをやめてキーフレームまで飛ぶ (90kHz) */
const BEHIND_MOST = 0.5 * CLOCK;
/** 1コマの長さの目安 (90kHz)。59.94 コマ。実際の間隔が分かればそれを使う */
const FRAME = 1501;
/**
 * 追っかけ (`follow`) で圧縮のまま持っておく上限。**時間 (90kHz) とバイト数の小さいほう** —
 * サーバは倍速で送り込んでくるので、観ている先が伸び続ける。超えたら受け取るのをやめて
 * `full` を返し、画面が手元の尽きる前に再生している位置からリクエストし直す (エンコードする経路の MSE の `BUDGET` と同じ量)
 */
const FOLLOW_AHEAD_MOST = 120 * CLOCK;
/** MPEG-2 の worker の録画 (`worker.ts`) も同じ量で切る */
export const FOLLOW_BYTES_MOST = 120 * 1024 * 1024;
/** デコーダが転んでも開き直す回数。**これより続けて転んだら諦める** (1コマでも描ければ数え直す) */
const ERRORS_MOST = 3;

/** 音の1フレームを画面へ渡す関数 (WASM でデコードするのは worker.ts) */
interface AudioSink {
  /** 開き直す。`opus` のときは OpusHead を渡す。**開けなければ false** */
  open(codec: "aac" | "opus", config: Uint8Array | null): boolean;
  /** 1コマデコードして画面へ。時刻は 90kHz */
  push(data: Uint8Array, pts: number): void;
}

export interface Fmp4Host {
  audio: AudioSink;
  /** 1コマ描いた (小窓へ写す・数える)。`first` は選局し直してから最初の1枚 */
  drew(first: boolean): void;
  fail(reason: string): void;
  /** 1コマをデコードするのに掛かった時間 (ms。渡してから出てくるまで) */
  record(ms: number): void;
  /** 抱えきれなくなって、届いたものを捨て始めた (`follow` のときだけ) */
  full(): void;
}

interface Pending {
  pts: number;
  dts: number;
  duration: number;
  key: boolean;
  data: Uint8Array;
}

/** 90kHz に直す */
function ticks(value: number, timescale: number): number {
  return Math.round((value * CLOCK) / timescale);
}

export class Fmp4Video {
  private readonly context: OffscreenCanvasRenderingContext2D;
  private tracks: Fmp4Track[] = [];
  private video: Fmp4Track | null = null;
  private decoder: VideoDecoder | null = null;
  private config: VideoDecoderConfig | null = null;
  /** 圧縮のまま待たせている映像 (デコードする順) */
  private pending: Pending[] = [];
  /** デコードできたフレーム (見せる順)。**描いたら閉じる** */
  private frames: VideoFrame[] = [];
  /** キーフレームを待っているか。開き直した・時刻が飛んだ・選局し直した */
  private needKey = true;
  /** 次に来るはずのコマの時刻 (90kHz)。**飛んだらキーフレームまで捨てる** */
  private expected: number | null = null;
  /** 渡した時刻 (µs → performance.now())。デコードするのに掛かった時間を測る */
  private readonly started = new Map<number, number>();
  private errors = 0;
  /** 追っかけで抱えきれなくなったか。**次の init (リクエストし直し) まで、届いたものは捨てる** */
  private overflowed = false;
  /** 圧縮のまま持っているバイト数 (`FOLLOW_BYTES_MOST`) */
  private pendingBytes = 0;
  private shownSinceReset = false;
  /**
   * 飛び先 (µs。`reset` の `from`)。**これより前に出てきたフレームは描かずに閉じる** — 録画のサーバは
   * 飛び先の手前のキーフレームから流してくる。最初の1枚を描いたら外す
   */
  private floor: number | null = null;
  private lastPts: number | null = null;
  /** いま出しているコマの時刻 (90kHz) */
  current: number | null = null;
  frameTicks = FRAME;
  dropped = 0;

  /**
   * @param follow 放送の今を追わない (互換モードの追っかけ)。溜まっても先へ飛ばず、溢れそうなら
   *   受け取るのをやめる (`messages.ts` の `follow`)
   */
  constructor(
    private readonly canvas: OffscreenCanvas,
    private readonly host: Fmp4Host,
    private readonly follow = false,
  ) {
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) throw new Error("2D で描けません");
    this.context = context;
  }

  /** 渡したまま出てきていない枚数 (`budget.ts`) */
  get queued(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  /** デコードできて待っているフレームの数。**0 のまま表示時刻を過ぎていれば遅れている** */
  get waiting(): number {
    return this.frames.length;
  }

  /** 箱を1つぶん (init か媒体)。サーバは箱の切れ目で送ってくる */
  feed(bytes: Uint8Array): void {
    // init (ftyp + moov)。**来るたびに開き直す** — 選局し直し・音声やコーデックの選び直しで中身が変わる
    if (bytes.length >= 8 && hasBox(bytes, "moov")) {
      this.configure(readInit(bytes));
      return;
    }
    if (this.tracks.length === 0) return;
    this.push(readFragment(bytes, this.tracks));
  }

  /**
   * 読めたコマを渡す (時刻はそのトラックの刻み)。**fMP4 でなくても同じ入口** — 端末に保存した録画の
   * Matroska も、読んだコマをここへ渡す (`mkv.ts`)
   */
  push(samples: readonly Fmp4Sample[]): void {
    if (this.tracks.length === 0 || this.overflowed) return;
    if (this.follow && this.overfull()) {
      this.overflowed = true;
      this.host.full();
      return;
    }
    for (const sample of samples) {
      const track = this.tracks.find((t) => t.id === sample.track);
      if (track === undefined) continue;
      const pts = ticks(sample.pts, track.timescale);
      if (track === this.video) {
        this.queue({
          pts,
          dts: ticks(sample.dts, track.timescale),
          duration: ticks(sample.duration, track.timescale),
          key: sample.key,
          data: sample.data,
        });
      } else if (track.codec === "opus") {
        this.host.audio.push(sample.data, pts);
      } else {
        const head = adtsHeader(track.config, sample.data.length);
        if (head !== null)
          this.host.audio.push(concatBytes([head, sample.data]), pts);
      }
    }
  }

  /** 映像・音声の形式を受け取って開き直す (fMP4 の init。Matroska は Tracks から組む) */
  configure(tracks: Fmp4Track[]): void {
    this.tracks = tracks;
    const video = tracks.find((t) => t.kind === "video") ?? null;
    const audio = tracks.find((t) => t.kind === "audio") ?? null;
    if (audio !== null) {
      const opus = audio.codec === "opus";
      const config = opus ? opusHead(audio.config) : null;
      if (
        (opus && config === null) ||
        !this.host.audio.open(opus ? "opus" : "aac", config)
      ) {
        this.host.fail("音声を再生できません");
        return;
      }
    }
    this.video = video;
    if (video === null) return;
    this.config = {
      codec: video.codec,
      description: video.config,
      codedWidth: video.width,
      codedHeight: video.height,
      optimizeForLatency: true,
    };
    this.open();
  }

  /** VideoDecoder を開く (開き直す)。**キーフレームから入り直す** */
  private open(): void {
    this.dropFrames();
    this.started.clear();
    this.needKey = true;
    const config = this.config;
    if (config === null) return;
    if (this.decoder === null || this.decoder.state === "closed") {
      this.decoder = new VideoDecoder({
        output: (frame) => this.output(frame),
        error: () => this.broke(),
      });
    }
    try {
      this.decoder.configure(config);
    } catch {
      this.host.fail("この形式を再生できません");
    }
  }

  /** 転んだ (壊れたコマ・端末の都合)。**開き直してキーフレームから入り直す**。続けて転ぶなら諦める */
  private broke(): void {
    if (++this.errors > ERRORS_MOST) {
      this.host.fail("映像を再生できません");
      return;
    }
    // 転んだデコーダは閉じている。作り直す
    this.decoder = null;
    this.open();
    /*
     * **待たせている圧縮の頭も、次のキーフレームまで捨てる。** 開き直したデコーダに差分のコマから
     * 渡すと、また転ぶ (`ERRORS_MOST` を使い切って諦めてしまう)。キーフレームが無ければこれから来るぶんを待つ
     */
    const key = this.pending.findIndex((item) => item.key);
    this.keep(key < 0 ? [] : this.pending.slice(key));
    this.needKey = key < 0;
  }

  private queue(item: Pending): void {
    // 時刻が飛んだ (サーバが詰まって捨てた)。**次のキーフレームまで捨てる** (上の説明)
    if (
      this.expected !== null &&
      Math.abs(item.dts - this.expected) > item.duration + 2
    )
      this.needKey = true;
    this.expected = item.dts + item.duration;
    if (this.needKey) {
      if (!item.key) return;
      this.needKey = false;
    }
    this.pending.push(item);
    this.pendingBytes += item.data.length;
    // 溜め込みすぎ (止めている・裏に回っている)。いちばん新しいキーフレームから持ち直す。追っかけは捨てない (`overfull`)
    if (
      !this.follow &&
      this.pending.length > 1 &&
      this.pending.at(-1)!.dts - this.pending[0]!.dts > PENDING_MOST
    ) {
      this.skipTo(Number.POSITIVE_INFINITY);
    }
  }

  /**
   * `target` より手前でいちばん新しいキーフレームまで飛ぶ。**デコーダも開き直す** —
   * 飛ばしたコマを参照するフレームを出させないため
   */
  private skipTo(target: number): void {
    let found = -1;
    for (let i = 0; i < this.pending.length; i++) {
      if (this.pending[i]!.dts > target) break;
      if (this.pending[i]!.key) found = i;
    }
    if (found <= 0) return;
    this.keep(this.pending.slice(found));
    this.decoder?.reset();
    this.open();
    // 開き直しでキーフレームを待つ印が立つが、頭はキーフレームなのでそのまま渡せる
    this.needKey = false;
  }

  /** 圧縮の待ちを差し替える */
  private keep(pending: Pending[]): void {
    this.pending = pending;
    this.pendingBytes = pending.reduce(
      (sum, item) => sum + item.data.length,
      0,
    );
  }

  /** 圧縮の待ちの頭を1つ取り出す */
  private take(): Pending {
    const item = this.pending.shift() as Pending;
    this.pendingBytes -= item.data.length;
    return item;
  }

  /** 追っかけで抱えきれる量を超えたか (`FOLLOW_AHEAD_MOST` / `FOLLOW_BYTES_MOST`) */
  private overfull(): boolean {
    const first = this.pending[0];
    const last = this.pending.at(-1);
    if (first === undefined || last === undefined) return false;
    return (
      last.dts - first.dts > FOLLOW_AHEAD_MOST ||
      this.pendingBytes > FOLLOW_BYTES_MOST
    );
  }

  private decode(item: Pending): void {
    const decoder = this.decoder;
    if (decoder === null || decoder.state !== "configured") return;
    const timestamp = Math.round((item.pts * 1_000_000) / CLOCK);
    this.started.set(timestamp, performance.now());
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: item.key ? "key" : "delta",
          timestamp,
          duration: Math.round((item.duration * 1_000_000) / CLOCK),
          // 届いた ArrayBuffer の一部 (共有のメモリではない)
          data: item.data as Uint8Array<ArrayBuffer>,
        }),
      );
    } catch {
      this.broke();
    }
  }

  private output(frame: VideoFrame): void {
    const began = this.started.get(frame.timestamp);
    if (began !== undefined) {
      this.started.delete(frame.timestamp);
      this.host.record(performance.now() - began);
    }
    // 飛び先より前 (参照に使うためデコードしただけ)
    if (this.floor !== null && frame.timestamp < this.floor) {
      frame.close();
      return;
    }
    // 出てくるのは見せる順。念のため並べ直す (同じ時刻の後ろへ)
    let at = this.frames.length;
    while (at > 0 && this.frames[at - 1]!.timestamp > frame.timestamp) at--;
    this.frames.splice(at, 0, frame);
  }

  /** 刻むたびに: 番の近いものを渡し、番が来たコマを描く。`at` は時計 (90kHz。止まっていれば null) */
  tick(at: number | null): void {
    const decoder = this.decoder;
    if (decoder === null || decoder.state !== "configured") return;

    /*
     * **新しい局の1枚目は、デコードできたらすぐ出して待つ** (worker.ts の MPEG-2 と同じ理由)。
     * 録画で飛んだあと (`floor`) は、飛び先より前をデコードして捨てながら進むので、詰められるだけ渡す
     */
    if (!this.shownSinceReset) {
      if (this.floor !== null) {
        while (
          this.frames.length === 0 &&
          this.pending.length > 0 &&
          decoder.decodeQueueSize < DECODED_MOST
        ) {
          this.decode(this.take());
        }
      } else if (
        this.frames.length === 0 &&
        decoder.decodeQueueSize === 0 &&
        this.pending.length > 0
      ) {
        this.decode(this.take());
      }
      const first = this.frames.shift();
      if (first !== undefined) this.draw(first);
    }
    if (at === null) return;

    // 大きく遅れている (裏から戻った・止めていた)。デコードしながら追うよりキーフレームまで飛ぶ
    const head = this.pending[0];
    if (
      head !== undefined &&
      head.dts < at - BEHIND_MOST &&
      this.frames.length === 0
    )
      this.skipTo(at);

    while (
      this.pending.length > 0 &&
      this.frames.length + decoder.decodeQueueSize < DECODED_MOST &&
      this.pending[0]!.dts <= at + AHEAD
    ) {
      this.decode(this.take());
    }

    const now = Math.round((at * 1_000_000) / CLOCK);
    // 次のフレームがもう表示時刻を迎えているなら、手前のフレームは描かずに捨てる
    while (this.frames.length >= 2 && this.frames[1]!.timestamp <= now) {
      this.frames.shift()?.close();
      this.dropped++;
    }
    const next = this.frames[0];
    if (next !== undefined && next.timestamp <= now)
      this.draw(this.frames.shift() as VideoFrame);
  }

  /** 1コマ描いて閉じる。**大きさはフレームに合わせる** (見せる大きさ。縦横比はフレームが持っている) */
  private draw(frame: VideoFrame): void {
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.context.drawImage(frame, 0, 0, width, height);
    const pts = Math.round((frame.timestamp * CLOCK) / 1_000_000);
    frame.close();
    if (this.lastPts !== null) {
      const gap = pts - this.lastPts;
      if (gap > 0 && gap < 3 * FRAME * 2) this.frameTicks = gap;
    }
    this.lastPts = pts;
    this.current = pts;
    this.errors = 0;
    const first = !this.shownSinceReset;
    this.shownSinceReset = true;
    // 飛び先に着いた。ここから先は見せる順に出るので、もう比べない
    this.floor = null;
    this.host.drew(first);
  }

  /** いま出しているコマ (切り抜き)。2D は描いたものが残るので、そのまま写す。`size` があれば縮めて (`messages.ts` の `grab`) */
  async grab(size?: GrabSize): Promise<ImageBitmap | null> {
    if (this.current === null) return null;
    return size === undefined
      ? createImageBitmap(this.canvas)
      : downscale(this.canvas, this.canvas.width, this.canvas.height, size);
  }

  /**
   * 選局し直した・録画で飛んだ。**前の局のものは全部捨てる** (出ているフレームは次が出るまで残る)。
   * `from` (90kHz) を渡すと、それより前のフレームは描かない (`floor`)
   */
  reset(from: number | null = null): void {
    this.floor = from === null ? null : Math.round((from * 1_000_000) / CLOCK);
    this.keep([]);
    this.overflowed = false;
    this.dropFrames();
    this.started.clear();
    this.tracks = [];
    this.video = null;
    this.config = null;
    this.expected = null;
    this.needKey = true;
    this.shownSinceReset = false;
    this.lastPts = null;
    this.current = null;
    this.errors = 0;
    // 次の init で開き直す。開いたままのデコーダの中身は捨てる
    if (this.decoder !== null && this.decoder.state === "configured")
      this.decoder.reset();
  }

  close(): void {
    this.dropFrames();
    if (this.decoder !== null && this.decoder.state !== "closed")
      this.decoder.close();
    this.decoder = null;
  }

  private dropFrames(): void {
    for (const frame of this.frames) frame.close();
    this.frames = [];
  }
}

/** 頭に並んだ箱の中に `type` があるか (中まで読まない) */
function hasBox(bytes: Uint8Array, type: string): boolean {
  for (let at = 0; at + 8 <= bytes.length;) {
    if (ascii(bytes, at + 4, 4) === type) return true;
    const size = u32(bytes, at);
    if (size < 8) return false;
    at += size;
  }
  return false;
}
