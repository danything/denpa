/**
 * **ライブと追っかけで、回線に合わせて段を上げ下げするときの組み立て** (段を決めるのは `adapt.ts` の `RungAdapter`)。
 * 指示に足すもの・`tuned` から読む段・断り書きの文・受け取りの速さを、DOM に触らずに組むところだけをここに置く
 * (`live-player.svelte.ts` が使う。docs/stream.md「ライブと追っかけの画面」)。
 *
 * 段 0 は「自動で決まった形式」(家の中なら MPEG-2) のまま。段 1〜3 は変換で、コーデックはサーバが `playable` から選ぶ。
 * 音声だけ (`"audio"`) は `codec: "audio"` で、音声は段 3 と同じ 96k にする (`rung: 3`)
 */

import { type AdaptDecision, type Step } from "./adapt";
import { type LiveCodec, type Notice } from "./live";
import { formatLabel, type LiveFormat } from "./live-choice";
import { LOWEST_RUNG, type Rung, rungLabel } from "./rungs";

/** 段を指示に足すもの (`ChaseCommand` に重ねる。追っかけには音声だけが無い) */
export interface RungFields {
  rung?: Rung;
  playable?: LiveCodec[];
  raw?: false;
}

/** 段を選局の指示に足すもの (`TuneCommand` に重ねる) */
export interface StepFields extends RungFields {
  codec?: "audio";
}

/**
 * **段から、指示に足すものを組む。** 段 0 は何も足さない (形式はメニューの選択どおり)。段 1〜3 は `rung` と、端末が再生できる
 * コーデック (`playable`)。変換なので放送のまま (`raw`) は外す
 */
export function rungFields(rung: Rung, playable: LiveCodec[]): RungFields {
  return rung === 0 ? {} : { rung, playable, raw: false };
}

/** 選局の指示に足すもの (`rungFields`)。音声だけは `codec: "audio"` と、音声を 96k にする `rung: 3` */
export function stepFields(step: Step, playable: LiveCodec[]): StepFields {
  if (step === "audio")
    return { codec: "audio", rung: LOWEST_RUNG, raw: false };
  return rungFields(step, playable);
}

/** `tuned` から、いま流れている段を読む。音声だけなら `"audio"`、放送のままは 0 */
export function servedStep(notice: Extract<Notice, { type: "tuned" }>): Step {
  if (notice.codec === "audio") return "audio";
  return notice.raw ? 0 : notice.rung;
}

/** 段の並び。数が大きいほど軽い (`adapt.ts` と同じ) */
export function stepOrder(step: Step): number {
  return step === "audio" ? LOWEST_RUNG + 1 : step;
}

/**
 * コーデックのメニューの「自動」の行に添える値 (「H.264 540p」「音声だけ」)。段 0 は形式だけ (「MPEG-2」)
 */
export function stepFormatLabel(format: LiveFormat, step: Step): string {
  if (step === "audio") return "音声だけ";
  const height = rungLabel(step);
  return height === null
    ? formatLabel(format)
    : `${formatLabel(format)} ${height}`;
}

/**
 * **断り書きに出す文** (docs/writing.md)。段を動かしたときは動かした先、`encode` と `pinned` は段を動かさない理由と、
 * 何をすればどうなるか
 */
export function adaptMessage(decision: AdaptDecision): string {
  const { step, reason } = decision;
  if (reason === "encode")
    return "サーバのエンコードが追いついていないため、画質を下げずに流しています";
  if (reason === "pinned")
    return "回線が細いため、再生が止まります。コーデックを「自動」にすると、画質を下げて再生を続けます";
  // 下げる先は段 1 から下、上げる先は段 3 から上 (`adapt.ts`)。段 0 へ下げることと、音声だけへ上げることは無い
  const height = step === "audio" ? null : rungLabel(step);
  if (reason === "slow")
    return height === null
      ? "回線が細いため、音声だけにしました"
      : `回線が細いため、${height} に下げました`;
  return height === null
    ? "回線が戻ったため、元の画質に戻しました"
    : `回線が戻ったため、${height} に上げました`;
}

/** 受け取りの速さを測る窓 (ms) */
export const RATE_WINDOW = 5_000;
/** これより短い間しか測れていなければ、速さは分からないことにする (ms) */
export const RATE_LEAST = 2_000;

/**
 * **受け取った量から、受け取りの速さ (bit/s) を出す** (`AdaptSample.throughput`)。直近 `RATE_WINDOW` の窓で数える。
 * ライブは実時間でしか送られないので、足りているときはストリームのビットレート、足りないときは回線の上限に近い値になる。
 * `adapt.ts` は下げ先を決めるのにだけ使う
 */
export class Throughput {
  #samples: { at: number; bytes: number }[] = [];
  #since = Number.NaN;

  /** 選局し直したとき。前のストリームのぶんは数えない */
  reset(now: number): void {
    this.#samples = [];
    this.#since = now;
  }

  push(now: number, bytes: number): void {
    if (Number.isNaN(this.#since)) this.#since = now;
    this.#samples.push({ at: now, bytes });
    this.#drop(now);
  }

  /** 速さ (bit/s)。測り始めて `RATE_LEAST` に届かなければ null */
  rate(now: number): number | null {
    this.#drop(now);
    if (Number.isNaN(this.#since)) return null;
    const span = Math.min(RATE_WINDOW, now - this.#since);
    if (span < RATE_LEAST) return null;
    const bytes = this.#samples.reduce((sum, s) => sum + s.bytes, 0);
    return (bytes * 8 * 1000) / span;
  }

  #drop(now: number): void {
    const from = now - RATE_WINDOW;
    let i = 0;
    while (i < this.#samples.length && this.#samples[i]!.at < from) i++;
    if (i > 0) this.#samples = this.#samples.slice(i);
  }
}
