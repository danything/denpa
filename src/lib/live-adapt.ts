/**
 * **ライブと追っかけで、回線に合わせて段を上げ下げするときの組み立て** (段を決めるのは `adapt.ts` の `RungAdapter`)。
 * 指示に足すもの・`tuned` から読む段・受け取りの速さを、DOM に触らずに組むところだけをここに置く
 * (`live-player.svelte.ts` が使う。docs/stream.md「ライブと追っかけの画面」)。
 *
 * 段 0 は「自動で決まった形式」(家の中なら MPEG-2) のまま。段 1〜3 は変換で、コーデックはサーバが `playable` から選ぶ。
 * 音声だけ (`"audio"`) は `codec: "audio"` で、音声は段 3 と同じ 96k にする (`rung: 3`)
 */

import { LAG_SPAN, type Step } from "./adapt";
import { type LiveCodec, type Notice } from "./live";
import { LOWEST_RUNG, type Rung } from "./rungs";

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

/** `tuned` から、いま再生中の段を読む。音声だけなら `"audio"`、放送のままは 0 */
export function servedStep(notice: Extract<Notice, { type: "tuned" }>): Step {
  if (notice.codec === "audio") return "audio";
  return notice.raw ? 0 : notice.rung;
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

/**
 * **サーバが軽い組み合わせでエンコードし直したときの断り書き** (`server/live.ts` の `Session.lighten` が `notice` で送る)。
 * 画面は `encode` の文に替えてよいかを見分けるのに使う (`replacesWarning`)
 */
export const LIGHT_NOTE = {
  half: "サーバのエンコードが追いつかないため、30 コマに切り替えました",
  gpu: "サーバのエンコードが追いつかないため、GPU のエンコードに切り替えました",
} as const;

/**
 * **`encode`・`pinned` の断り書きを、いま出ている断り書き (`warning`) の代わりに出すか。** ほかの理由の断り書きは上書きしない。
 * 出すのは、何も出ていないときと、前に出したこの種類の文 (`standing`) が残っているとき。
 * `encode` は、サーバが軽くしたときの文 (`LIGHT_NOTE`) も替える。軽くしたあとも遅れているなら、その文はもう当たっていないため
 */
export function replacesWarning(
  reason: "encode" | "pinned",
  warning: string,
  standing: string | null,
): boolean {
  if (warning === "" || warning === standing) return true;
  return (
    reason === "encode" &&
    (Object.values(LIGHT_NOTE) as string[]).includes(warning)
  );
}

/** 1 回渡すあいだにこれより遅れが伸びたら、端が戻ったと見る (秒)。刻みは 0.5 秒なので、届かなくても 0.5 秒しか伸びない */
const LAG_JUMP = 5;
/** 遅れを比べる両端の幅 (ms)。端どうしの、それぞれの中のいちばん小さい遅れを比べる (届き方の揺れを除く) */
const LAG_EDGE = 1_000;

/**
 * **放送に対する遅れの伸びを測る** (`AdaptSample.lag`)。刻むたびに、届いた映像の端の時刻 (メディアの時刻、秒) を渡す。
 * 遅れは「実時間 − 届いた端」で、届く速さが流している段に足りていれば一定、足りなければ足りないぶん伸びていく。
 * 溜まりがサーバ・中継・カーネル・リバースプロキシのどこにあっても、画面に届くのが遅れれば伸びるので、
 * サーバの `backlog` が 0 のままでも細い回線を見分けられる (手元で 2 Mbit/s に絞って 3 Mbit/s の段を流したとき、
 * `backlog` は 0 のままだった)。
 *
 * 両端 (`LAG_EDGE`) のいちばん小さい遅れどうしを比べる。キーフレームの大きな塊は遅れて届くので、1 回ずつだと揺れる。
 * ストリームが替わったら (選局・段の切り替え・作り直し) 物差しが変わるので `reset` する
 */
export class LagMeter {
  #samples: { at: number; lag: number }[] = [];

  reset(): void {
    this.#samples = [];
  }

  /** `now` (ms) の時点で届いている映像の端 (秒)。測れなければ渡さない */
  push(now: number, edge: number): void {
    const lag = now / 1000 - edge;
    const last = this.#samples.at(-1);
    // 端が戻った (シークで捨てた・別のストリーム)。1 回の刻みで `LAG_JUMP` も伸びることは無いので、前の値とは比べない
    if (last !== undefined && lag - last.lag > LAG_JUMP) this.#samples = [];
    this.#samples.push({ at: now, lag });
    const from = now - LAG_SPAN - LAG_EDGE;
    while (this.#samples.length > 0 && this.#samples[0]!.at < from)
      this.#samples.shift();
  }

  /** ここ `LAG_SPAN` で伸びた遅れ (秒)。縮んでいれば負。まだ `LAG_SPAN` ぶん測れていなければ null */
  growth(now: number): number | null {
    const first = this.#samples[0];
    if (first === undefined || now - first.at < LAG_SPAN) return null;
    let old = Infinity;
    let recent = Infinity;
    for (const s of this.#samples) {
      if (s.at < first.at + LAG_EDGE) old = Math.min(old, s.lag);
      if (s.at > now - LAG_EDGE) recent = Math.min(recent, s.lag);
    }
    return Number.isFinite(old) && Number.isFinite(recent)
      ? recent - old
      : null;
  }
}

/**
 * 詰まりとして数えるまでの長さ (ms)。`<video>` が先を持たない状態 (`readyState` が `HAVE_FUTURE_DATA` 未満) が
 * これだけ続いたら詰まっていると見る。画面が自分で 1 コマ飛んだとき (`unslip`) の短い空きは数えない。
 * `waiting` の知らせは、飛んだあと 3 秒数えない (`quiet`) ので、細い回線で止まっては飛ぶのを繰り返すと詰まりが見えなくなっていた
 */
export const STUCK_LEAST = 500;

/** 試しのデータの量を決める長さ (ms)。測りたい速さで、これだけかかる量を取る */
export const PROBE_SPAN = 1_000;
/** 試しのデータの量の下限と上限 (バイト)。小さすぎると TCP の立ち上がりで遅く見える。サーバもこの値を使う (`GET /api/playback/probe`) */
export const PROBE_LEAST = 64 * 1024;
export const PROBE_MOST = 4 * 1024 * 1024;
/**
 * 試しのデータを取るのをやめる長さ (ms)。測りたい速さが出ていればこの半分で取り終わる。細い回線で取り続けると、
 * そのぶん再生中の映像が細る
 */
export const PROBE_GIVE_UP = 2 * PROBE_SPAN;

/**
 * 上げる前に取る試しのデータの量 (バイト)。`need` は回線全体に要る速さ (`RungAdapter.wantProbe`)、`stream` はいま再生中の
 * 段の受け取りの速さ (bit/s)。再生中の段のぶんは試しのデータで測らず、残りだけを `PROBE_SPAN` ぶん取る
 */
export function probeBytes(need: number, stream: number): number {
  const rest = Math.max(0, need - stream);
  return Math.round(
    Math.min(PROBE_MOST, Math.max(PROBE_LEAST, (rest * PROBE_SPAN) / 8000)),
  );
}

/**
 * 試しのデータの速さ (bit/s)。時刻は ms。最初の塊が届いてから最後の塊までで割る (最初の塊までは往復の待ちで、回線の
 * 速さではない)。塊が 1 つしか来なかったとき (速い回線で小さく取ったとき) は、取り始めてからで割る (往復のぶん遅く出る)。
 * `PROBE_GIVE_UP` でやめたときは、`lastAt` にやめた時刻を渡し、そこまでに届いた量で割る (足りないと分かれば十分)。
 * 測れなければ null
 */
export function probeRate(o: {
  startAt: number;
  firstAt: number | null;
  firstBytes: number;
  lastAt: number;
  bytes: number;
}): number | null {
  if (o.firstAt !== null && o.lastAt > o.firstAt && o.bytes > o.firstBytes)
    return ((o.bytes - o.firstBytes) * 8 * 1000) / (o.lastAt - o.firstAt);
  if (o.bytes > 0 && o.lastAt > o.startAt)
    return (o.bytes * 8 * 1000) / (o.lastAt - o.startAt);
  return null;
}

/** 試しのデータの量 (`GET /api/playback/probe?bytes=`) を `PROBE_LEAST`〜`PROBE_MOST` に丸める。読めない値は `PROBE_LEAST` */
export function probeSize(asked: string | null): number {
  const n = Number(asked);
  if (asked === null || !Number.isFinite(n)) return PROBE_LEAST;
  return Math.round(Math.min(PROBE_MOST, Math.max(PROBE_LEAST, n)));
}
