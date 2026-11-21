/**
 * **観る画面の出どころ (Feed)。録画をサーバから読む** ([library.md](../../../docs/library.md#何で観るかはサーバが出せるものから画面が選ぶ))。
 *
 * ライブ (`feed-live.ts`) は WebSocket で押し込まれるが、録画は範囲を指定して読める。何をどこから読むかの組み立てをここに置く。
 *
 * - その場で流すもの (`/stream`。詰め替え・変換・段を下げた変換・音声だけ) のリクエスト先 (`streamUrl`・`stepUrl`)
 * - ファイルの直再生 (`/file?source=`) と、段 0 のビットレート (ファイルの大きさと尺から出す。`readBaseKbps`)
 * - 字幕 (`captions.json`)・データ放送の変化ログ (`databroadcast`)・チャプター (`chapters`) の取得先
 *
 * 読み出し (`fetch`・繋ぎ直し・受け取りの速さ) は MSE で受ける `remux-player.ts` と canvas に描く `canvas-player.ts` が持つ。
 * どれを観るか (`pickOffer`) と、いつ段を替えるかは画面が決める
 */

import { resolve } from "$app/paths";

import type { Step } from "#lib/adapt.js";
import { codecsFor, type LiveCodec } from "#lib/live.js";
import type { StreamUrl } from "#lib/remux-player.js";
import { pickMediaSource, wantsCleanStart } from "#lib/ts/media-source.js";
import {
  AUDIO_TYPE,
  type CanvasCodec,
  ENCODED_ORDER,
  type Picked,
  type PlayCodec,
} from "#lib/ts/playback.js";
import { rungQuery } from "#lib/watch-adapt.js";

type StreamPlan = Extract<Picked, { way: "stream" }>;

export class RecordingFeed {
  /**
   * 観る画面ごとの値 (`/stream` の `?viewer=`)。手前に始めてよいコマが無い録画の変換で、サーバが同じ画面の前の変換を止めて
   * 枠を譲らせるのに使う (`transcode.ts` の `yieldTranscodes`)
   */
  readonly viewer = Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  /**
   * 段 0 のビットレート (kbit/s)。ファイル (`?source=`。元の TS は `ts`) ごとに、ファイルの大きさと尺から出す。
   * 形式を選び直して前のファイルに戻ったときも、そのファイルの値で比べる。
   * キーは録画とファイルの組 (`fileKey`)。別の録画へ移ってもページは作り直されないことがあるため
   */
  private readonly base = new Map<string, number>();
  /** ビットレートを読みにいったファイル。読めなくても同じファイルはリクエストし直さない (シーク・作り直しのたびに増やさない) */
  private readonly baseAsked = new Set<string>();

  /** `recording` はいま観ている録画の番号 (画面を作り直さずに別の録画へ移ることがあるので、読むたびに聞く) */
  constructor(private readonly recording: () => number) {}

  /** `api/recordings/<id>/<path>` */
  private api(path: string): string {
    return resolve(`api/recordings/${this.recording()}/${path}`);
  }

  /** 何で観られるか (`/playback`) */
  get playbackUrl(): string {
    return this.api("playback");
  }

  /** データ放送の変化ログ (`/databroadcast`) */
  get timelineUrl(): string {
    return this.api("databroadcast");
  }

  /** チャプター (`/chapters`) */
  get chaptersUrl(): string {
    return this.api("chapters");
  }

  /** 字幕 (`/captions.json`) */
  get captionsUrl(): string {
    return this.api("captions.json");
  }

  /** ファイルの直再生 (`/file?source=`) */
  fileUrl(source: string): string {
    return this.api(`file?source=${source}`);
  }

  /**
   * その場で流すもの (`/stream`) のリクエスト先。`at` 秒から、`audio` の音声で。
   * WebKit なら、始めてよいコマから始まるものを求める (`?clean=1`。`wantsCleanStart`)
   */
  streamUrl(codec: PlayCodec | "audio", at: number, audio: string): string {
    return this.api(
      `stream?codec=${codec}&from=${at.toFixed(3)}&audio=${encodeURIComponent(audio)}&viewer=${this.viewer}${wantsCleanStart() ? "&clean=1" : ""}`,
    );
  }

  /** その段のリクエスト先。段 0 は選んだもの (`plan`) そのまま。段を下げるならサーバがコーデックを `playable` から選ぶ */
  stepUrl(at: Step, plan: StreamPlan): StreamUrl {
    if (at === "audio")
      return (from, audio) => this.streamUrl("audio", from, audio);
    const query = rungQuery(at, playable());
    return (from, audio) => this.streamUrl(plan.codec, from, audio) + query;
  }

  /** その段の MSE の型。段を下げた変換はサーバがコーデックを選ぶので、応答を受けてから決める (null) */
  stepType(at: Step, plan: StreamPlan): string | null {
    if (at === "audio") return AUDIO_TYPE;
    return at === 0 ? plan.type : null;
  }

  /**
   * canvas に描くときのリクエスト先。段 0 は選んだ形式そのまま。段を下げるなら変換で、コーデックはサーバが
   * 描ける形式 (`drawable`) から選ぶ (MPEG-2 からは H.264 の変換としてリクエストする。`rungQuery`)。互換モードは音声だけにしない
   */
  canvasUrl(
    step: Step,
    codec: CanvasCodec,
    at: number,
    audio: string,
    drawable: LiveCodec[],
  ): string {
    if (step === 0 || step === "audio") return this.streamUrl(codec, at, audio);
    return (
      this.streamUrl(codec === "mpeg2" ? "h264" : codec, at, audio) +
      rungQuery(step, drawable)
    );
  }

  /** `base`・`baseAsked` のキー (録画と `?source=` の組) */
  private fileKey(source: string): string {
    return `${this.recording()}:${source}`;
  }

  /** ファイルの大きさから段 0 のビットレートを読む (`HEAD`)。読めなければ null のまま (`adapt.ts` の目安を使う) */
  async readBaseKbps(source: string, duration: number): Promise<void> {
    const key = this.fileKey(source);
    if (this.baseAsked.has(key)) return;
    this.baseAsked.add(key);
    try {
      const res = await fetch(this.fileUrl(source), { method: "HEAD" });
      const bytes = Number(res.headers.get("Content-Length"));
      if (res.ok && bytes > 0 && duration > 0)
        this.base.set(key, (bytes * 8) / duration / 1000);
    } catch {
      // 分からなければ `adapt.ts` の目安を使う
    }
  }

  /** `source` のファイルのビットレート (kbit/s)。読めていなければ null */
  baseOf(source: string | null): number | null {
    return source === null
      ? null
      : (this.base.get(this.fileKey(source)) ?? null);
  }
}

/** 端末が MSE で受け取れるコーデック (`?playable=`。段を下げたときはこの中からサーバが選ぶ) */
export function playable(): LiveCodec[] {
  const source = pickMediaSource();
  if (source === null) return [];
  return ENCODED_ORDER.filter((codec) =>
    source.Source.isTypeSupported(codecsFor(codec)),
  );
}
