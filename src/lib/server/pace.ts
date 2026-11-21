/**
 * **送り出しの具合** (`#lib/rungs.ts` の `Pace`)。回線が細いのか、サーバのエンコードが遅いのかを、画面が読み分けるために
 * サーバで測れる値だけを出す。段を上げ下げするかを決めるのは画面 (`adapt.ts`) で、ここでは決めない
 * (docs/stream.md「回線に合わせて画質を下げる」)。
 *
 * | 経路 | `backlog` | `dropped` | `speed` |
 * | --- | --- | --- | --- |
 * | WebSocket (ライブ・追っかけ) | 接続の送れずに溜まっている量 (`ws.ts`) | 溜まりすぎて捨てた塊 (映像と、変換せずに送る TS) の数 | 出した映像の時刻の進み ÷ 実時間 |
 * | HTTP の変換 (`/api/recordings/<id>/stream`) | 0 (送る速さは TCP が決める) | 0 (捨てない) | 出した映像の時刻の進み ÷ ffmpeg が出すのを待った時間 |
 *
 * HTTP はほかに `wait` (ffmpeg が出すのを待っていた時間の割合) を返す。WebSocket は省略する。
 *
 * WebSocket は `pace` の通知で 2 秒ごとか変わったときに送る (`PaceMeter`)。HTTP は応答の途中で何かを足せないので、
 * 応答のヘッダで id を返し、画面が `GET /api/playback/pace?id=` で読む (`openPace`)
 */

import { type Pace, SOURCE_GAP } from "#lib/rungs.js";
import {
  Fmp4Splitter,
  type Fmp4Track,
  readFragment,
  readInit,
} from "#lib/ts/fmp4.js";

/** エンコードの速さを測る窓 (ms)。これより古い点は捨てる */
const SPEED_WINDOW = 5_000;
/** 測った幅がこれより短いうちは測れていない (null)。出だしの 1 秒は ffmpeg が入力の解析で読んだぶんを一度に出す */
const SPEED_LEAST = 1_000;
/**
 * 出す速さの上限。HTTP の変換は、ffmpeg を待たずに済んでいる (回線のほうが遅い) と待った時間が 0 に近づき、割った値が
 * いくらでも大きくなる。1 を大きく超えれば「エンコードは遅れていない」と読めれば足りる
 */
export const SPEED_MOST = 10;

/**
 * **エンコードの速さ** (`Pace.speed`)。出した映像の長さ (秒) を、使った時間と組にして窓の中で割る。
 * 使った時間はライブなら実時間、HTTP の変換なら ffmpeg が出すのを待った時間 (`StreamPace`)。
 * HTTP の変換は、待った時間が窓の実時間に占める割合も出す (`share`)
 */
export class SpeedMeter {
  private readonly points: { at: number; media: number; spent: number }[] = [];

  /** `at` の時点で、出した映像の長さの合計が `media` 秒、使った時間の合計が `spent` ms */
  record(at: number, media: number, spent: number): void {
    this.points.push({ at, media, spent });
    while (this.points.length > 2 && this.points[1]!.at < at - SPEED_WINDOW)
      this.points.shift();
  }

  /** 窓の中の速さ。小数 2 桁に丸め、`SPEED_MOST` で頭打ち。測れていなければ null */
  speed(now: number): number | null {
    const live = this.points.filter((p) => p.at >= now - SPEED_WINDOW);
    const first = live[0];
    const last = live.at(-1);
    if (first === undefined || last === undefined) return null;
    if (last.at - first.at < SPEED_LEAST) return null;
    const media = last.media - first.media;
    const spent = (last.spent - first.spent) / 1000;
    const speed = spent <= 0 ? SPEED_MOST : media / spent;
    return Math.round(Math.min(SPEED_MOST, speed) * 100) / 100;
  }

  /**
   * 窓の中で、使った時間が実時間に占める割合 (0〜1。小数 2 桁)。測れていなければ null。
   * HTTP の変換では ffmpeg が出すのを待っていた割合で、1 に近ければ送る速さはエンコードが決めている (`Pace.wait`)
   */
  share(now: number): number | null {
    const live = this.points.filter((p) => p.at >= now - SPEED_WINDOW);
    const first = live[0];
    const last = live.at(-1);
    if (first === undefined || last === undefined) return null;
    const span = last.at - first.at;
    if (span < SPEED_LEAST) return null;
    const share = (last.spent - first.spent) / span;
    return Math.round(Math.min(1, Math.max(0, share)) * 100) / 100;
  }
}

/** fMP4 の映像の塊から、映像の長さ (秒) を読む。init を先に渡す。映像のトラックが無ければ 0 */
export class VideoLength {
  private video: Fmp4Track | null = null;

  init(data: Uint8Array): void {
    this.video = readInit(data).find((track) => track.kind === "video") ?? null;
  }

  /** 塊 1 つ (moof + mdat) に入っている映像の長さ (秒) */
  media(data: Uint8Array): number {
    const video = this.video;
    if (video === null || video.timescale <= 0) return 0;
    let ticks = 0;
    for (const sample of readFragment(data, [video])) ticks += sample.duration;
    return ticks / video.timescale;
  }
}

/** WebSocket で `pace` を送るか見る間隔 (ms) */
export const PACE_CHECK = 500;
/** 何も変わらなくても送る間隔 (ms) */
export const PACE_EVERY = 2_000;
/** バッファの量がこれだけ動いたら、`PACE_EVERY` を待たずに送る (バイト) */
export const PACE_STEP = 512 * 1024;

/**
 * **WebSocket の `pace` をいつ送るか。** `PACE_CHECK` ごとに呼び、送るものがあれば返す。
 * 送るのは `PACE_EVERY` ごとか、前に送ってから塊を捨てた・バッファの量が `PACE_STEP` 以上動いたとき。
 * `dropped` は前に送ってからの数にして返す
 */
export class PaceMeter {
  private sentAt = Number.NEGATIVE_INFINITY;
  private dropped = 0;
  private backlog = 0;

  /**
   * @param droppedTotal 接続を開いてから捨てた塊の数 (`Connection.dropped`)
   * @param gap チューナーから届かなかった間 (`InputGaps.longest`)。測らない経路 (追っかけ) は null で、`pace` に入れない
   */
  next(
    now: number,
    backlog: number,
    droppedTotal: number,
    speed: number | null,
    gap: number | null = null,
  ): Pace | null {
    const dropped = droppedTotal - this.dropped;
    const moved = dropped > 0 || Math.abs(backlog - this.backlog) >= PACE_STEP;
    if (!moved && now - this.sentAt < PACE_EVERY) return null;
    this.sentAt = now;
    this.dropped = droppedTotal;
    this.backlog = backlog;
    return { backlog, dropped, speed, ...(gap === null ? {} : { gap }) };
  }
}

/**
 * **チューナーから TS が届くのを待っていた間** (`Pace.gap`)。読む前に `begin`、届いたら `end` を呼び、直近 `SPEED_WINDOW` のうち
 * いちばん長い待ちを返す。いま待っている最中の間も入れる。測るのは読みに行ってから届くまでだけで、受け取ったものを ffmpeg に
 * 書くのを待った間 (エンコードが遅いとき) は入れない。窓をエンコードの速さと同じにするのは、届かなかった間はエンコードの速さも
 * 下がるため (`server/live.ts` の `EncodeLag` はこの間を遅れに数えない)
 */
export class InputGaps {
  /** 窓の中の待ちの、終わった時刻と長さ (ms) */
  private gaps: { at: number; ms: number }[] = [];
  /**
   * いま待っている読み出しの、読みに行った時刻 (`begin` が返す番号ごと)。起こし直しの直後は、古い読み出しと新しい読み出しが
   * 同時に待つことがあるので、1 つの時刻で持たない (上書きすると待ちの長さがずれる)
   */
  private pending = new Map<number, number>();
  private nextId = 0;
  /** 1 つでも届いたか。最初の塊までは選局の待ちなので数えない */
  private fed = false;

  /** @param onGap 待ちが `SOURCE_GAP` 以上になって届いたときに、待った長さ (ms) を受け取る (ログに出力する) */
  constructor(private readonly onGap: (ms: number) => void = () => {}) {}

  /** 読みに行った。返す番号を `end` か `cancel` に渡す */
  begin(now: number): number {
    const id = this.nextId++;
    this.pending.set(id, now);
    return id;
  }

  /**
   * 届いた。**これより前に読みに行ったまま終わっていない読み出しも捨てる。** 起こし直しで手放された古い読み出しが `end` も
   * `cancel` も呼ばずに残っても、新しい読み出しに届いた時点でチューナーは流れているので、待ちとして数え続けない
   */
  end(id: number, now: number): void {
    const since = this.pending.get(id);
    this.pending.delete(id);
    if (since !== undefined)
      for (const [other, start] of this.pending)
        if (start <= since) this.pending.delete(other);
    if (since !== undefined && this.fed) {
      const ms = now - since;
      this.gaps.push({ at: now, ms });
      if (ms >= SOURCE_GAP) this.onGap(ms);
    }
    this.fed = true;
    this.drop(now);
  }

  /** 読み出しが例外で終わった。待ちとして数えずに捨てる (残すと、その後ずっと待っている最中と数え続ける) */
  cancel(id: number): void {
    this.pending.delete(id);
  }

  /** 直近の窓でいちばん長い待ち (ms)。いま待っている最中の間も入れる。まだ 1 つも届いていなければ null */
  longest(now: number): number | null {
    if (!this.fed) return null;
    this.drop(now);
    let most = 0;
    for (const since of this.pending.values())
      most = Math.max(most, now - since);
    for (const gap of this.gaps) most = Math.max(most, gap.ms);
    return most;
  }

  private drop(now: number): void {
    while (this.gaps.length > 0 && this.gaps[0]!.at < now - SPEED_WINDOW)
      this.gaps.shift();
  }
}

/** `source` を読み、1 つずつ届くまでの待ちを `gaps` に数える (`InputGaps`)。抜けたら `source` も閉じる */
export async function* timedInput<T>(
  source: AsyncIterable<T>,
  gaps: InputGaps,
): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const id = gaps.begin(Date.now());
      let next: IteratorResult<T>;
      try {
        next = await it.next();
      } catch (error) {
        gaps.cancel(id);
        throw error;
      }
      gaps.end(id, Date.now());
      if (next.done === true) return;
      yield next.value;
    }
  } finally {
    await it.return?.();
  }
}

/**
 * **HTTP の変換 1 本ぶんの具合** (`server/playback.ts` の `transcodeBody` が、読みに来た時刻と出力を渡す)。
 * 映像を写すだけ (`encoding` が false) なら `speed` は null。`wait` は写すだけでも測る
 */
export class StreamPace {
  private readonly splitter = new Fmp4Splitter();
  private readonly length = new VideoLength();
  private readonly meter = new SpeedMeter();
  private media = 0;
  private waited = 0;
  /** 読みに来て、まだ何も渡していなければその時刻 (ms)。渡したら null */
  private askedAt: number | null = null;

  constructor(private readonly encoding: boolean) {}

  /** 読みに来た (ffmpeg が出すのを待ち始めた) */
  ask(now = Date.now()): void {
    this.askedAt = now;
  }

  /**
   * ffmpeg が出したもの (区切りは問わない)。読みに来てからここまでを待った時間に足してから、出した映像の長さと組にする。
   * 渡し終えてから足すと、待った時間が塊 1 つぶん遅れて入る (ffmpeg が 1 秒ごとに塊を出すなら、5 秒の窓で 2 割ずれる)
   */
  output(chunk: Uint8Array, now = Date.now()): void {
    if (this.askedAt !== null) {
      this.waited += Math.max(0, now - this.askedAt);
      this.askedAt = null;
    }
    if (this.encoding)
      for (const segment of this.splitter.feed(chunk)) {
        if (segment.kind === "init") this.length.init(segment.data);
        else this.media += this.length.media(segment.data);
      }
    this.meter.record(now, this.media, this.waited);
  }

  read(now = Date.now()): Pace {
    return {
      backlog: 0,
      dropped: 0,
      speed: this.encoding ? this.meter.speed(now) : null,
      wait: this.meter.share(now),
    };
  }
}

/** 流している HTTP の応答の具合。id → 読む関数 */
const open = new Map<string, () => Pace>();

/**
 * 具合を読めるようにする。id を応答のヘッダ (`#lib/ts/playback.ts` の `PACE_HEADER`) で返し、閉じたら `close` を呼ぶ。
 * id はランダムな UUID (v4。122 ビット) で、連番のように推測できない。読む `GET /api/playback/pace` はほかの API と同じく
 * 認証を通る (`hooks.server.ts`。`auth.ts` の素通しの `OPEN_PATHS` に入れていない)。返すのは数だけで、録画の中身や名前は出さない
 */
export function openPace(read: () => Pace): { id: string; close: () => void } {
  const id = crypto.randomUUID();
  open.set(id, read);
  return { id, close: () => open.delete(id) };
}

/** いまの具合 (`GET /api/playback/pace?id=`)。閉じた・発行していない id なら null */
export function readPace(id: string): Pace | null {
  return open.get(id)?.() ?? null;
}
