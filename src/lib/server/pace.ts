/**
 * **送り出しの具合** (`#lib/rungs.ts` の `Pace`)。回線が細いのか、サーバのエンコードが遅いのかを、画面が読み分けるために
 * サーバが知っていることだけを出す。段を上げ下げするかを決めるのは画面 (`adapt.ts`) で、ここでは決めない
 * (docs/stream.md「回線に合わせて画質を下げる」)。
 *
 * | 経路 | `backlog` | `dropped` | `speed` |
 * | --- | --- | --- | --- |
 * | WebSocket (ライブ・追っかけ) | 接続の送れずに溜まっている量 (`ws.ts`) | 溜まりすぎて捨てた映像の塊の数 | 出した映像の時刻の進み ÷ 実時間 |
 * | HTTP の変換 (`/api/recordings/<id>/stream`) | 0 (送る速さは TCP が決める) | 0 (捨てない) | 出した映像の時刻の進み ÷ ffmpeg が出すのを待った時間 |
 *
 * WebSocket は `pace` の通知で 2 秒ごとか変わったときに送る (`PaceMeter`)。HTTP は応答の途中で何かを足せないので、
 * 応答のヘッダで id を返し、画面が `GET /api/playback/pace?id=` で読む (`openPace`)
 */

import type { Pace } from "#lib/rungs.js";
import {
  Fmp4Splitter,
  type Fmp4Track,
  readFragment,
  readInit,
} from "#lib/ts/fmp4.js";

/** エンコードの速さを測る窓 (ms)。これより古い点は捨てる */
const SPEED_WINDOW = 5_000;
/** 測った幅がこれより短いうちは測れていない (null)。出だしの 1 秒は ffmpeg が入口の解析で読んだぶんを一度に出す */
const SPEED_LEAST = 1_000;
/**
 * 出す速さの上限。HTTP の変換は、ffmpeg を待たずに済んでいる (回線のほうが遅い) と待った時間が 0 に近づき、割った値が
 * いくらでも大きくなる。1 を大きく超えれば「エンコードは遅れていない」と読めれば足りる
 */
export const SPEED_MOST = 10;

/**
 * **エンコードの速さ** (`Pace.speed`)。出した映像の長さ (秒) を、使った時間と組にして窓の中で割る。
 * 使った時間はライブなら実時間、HTTP の変換なら ffmpeg が出すのを待った時間 (`StreamPace`)
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
/** 溜まりがこれだけ動いたら、`PACE_EVERY` を待たずに送る (バイト) */
export const PACE_STEP = 512 * 1024;

/**
 * **WebSocket の `pace` をいつ送るか。** `PACE_CHECK` ごとに呼び、送るものがあれば返す。
 * 送るのは `PACE_EVERY` ごとか、前に送ってから塊を捨てた・溜まりが `PACE_STEP` 以上動いたとき。
 * `dropped` は前に送ってからの数にして返す
 */
export class PaceMeter {
  private sentAt = Number.NEGATIVE_INFINITY;
  private dropped = 0;
  private backlog = 0;

  /** @param droppedTotal 接続を開いてから捨てた塊の数 (`Connection.dropped`) */
  next(
    now: number,
    backlog: number,
    droppedTotal: number,
    speed: number | null,
  ): Pace | null {
    const dropped = droppedTotal - this.dropped;
    const moved = dropped > 0 || Math.abs(backlog - this.backlog) >= PACE_STEP;
    if (!moved && now - this.sentAt < PACE_EVERY) return null;
    this.sentAt = now;
    this.dropped = droppedTotal;
    this.backlog = backlog;
    return { backlog, dropped, speed };
  }
}

/**
 * **HTTP の変換 1 本ぶんの具合** (`server/playback.ts` の `transcodeBody` が出力と待ち時間を渡す)。
 * 映像を写すだけ (`encoding` が false) なら `speed` は null
 */
export class StreamPace {
  private readonly splitter = new Fmp4Splitter();
  private readonly length = new VideoLength();
  private readonly meter = new SpeedMeter();
  private media = 0;
  private waited = 0;

  constructor(private readonly encoding: boolean) {}

  /** ffmpeg が出したもの (区切りは問わない) */
  output(chunk: Uint8Array, now = Date.now()): void {
    if (!this.encoding) return;
    for (const segment of this.splitter.feed(chunk)) {
      if (segment.kind === "init") this.length.init(segment.data);
      else this.media += this.length.media(segment.data);
    }
    this.meter.record(now, this.media, this.waited);
  }

  /** 読みに来て、ffmpeg が出すまで待った時間 (ms) */
  wait(ms: number): void {
    this.waited += ms;
  }

  read(now = Date.now()): Pace {
    return {
      backlog: 0,
      dropped: 0,
      speed: this.encoding ? this.meter.speed(now) : null,
    };
  }
}

/** 流している HTTP の応答の具合。id → 読む関数 */
const open = new Map<string, () => Pace>();

/**
 * 具合を読めるようにする。id を応答のヘッダ (`#lib/ts/playback.ts` の `PACE_HEADER`) で返し、閉じたら `close` を呼ぶ。
 * id はランダムな UUID (v4。122 ビット) で、連番のように推測できない。読む `GET /api/playback/pace` はほかの API と同じく
 * 認証を通る (`hooks.server.ts`。素通しの `OPEN_PATHS` に入れていない)。返すのは数だけで、録画の中身や名前は出さない
 */
export function openPace(read: () => Pace): { id: string; close: () => void } {
  const id = crypto.randomUUID();
  open.set(id, read);
  return { id, close: () => open.delete(id) };
}

/** いまの具合 (`GET /api/playback/pace?id=`)。閉じた・知らない id なら null */
export function readPace(id: string): Pace | null {
  return open.get(id)?.() ?? null;
}
