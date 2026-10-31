/**
 * 録画のデータ放送。**実時刻つきで並べた変化から、その時点の画面を積み直す。**
 *
 * ライブは「常に今」なので [carousel.ts](carousel.ts) が「各モジュールの最後の1つ」
 * だけ持てば足りる。録画は**巻き戻し・番組またぎ**があるので、それでは足りない —
 * 30分の番組の途中で天気が差し替わったなら、10分の位置では古いほう、20分の位置では
 * 新しいほうを出したい。
 *
 * そこで、エンコードのついでに元の TS をもう一度 [bml.ts](../../../packages/arib/src/bml.ts) に通し、**配る価値の
 * あった変化だけ**を放送の実時刻 (TDT/TOT) つきで並べておく
 * ([data-capture.ts](data-capture.ts) の `DataBroadcastCapture`。**TS をデコードする側は
 * サーバ専用**なので別ファイル — ここは観る画面 (ブラウザ) も読み込む)。
 * 再生時は、再生位置に当たる実時刻までの変化を新しい `Carousel` に流し込めば、
 * **その時点の画面**が復元できる (`replayAt`)。シークもこれで作り直すだけ。
 *
 * ## なぜ「変化ログ」で足りるのか
 *
 * カルーセルは同じものを何度も回すが、[bml.ts](../../../packages/arib/src/bml.ts) は**バージョンかカルーセルの回 (dataEventId) が変わったときだけ**
 * `moduleDownloaded` を出し、`Carousel.take` は変わらない `pmt`/`programInfo` を
 * 落とす。だから `take` が通したものを順に集めれば、それがそのまま
 * 「いつ何が変わったか」の記録になる。再生は「そこまでの変化を積む」だけ。
 *
 * DOM も時計も触らないので、ここだけ単体で確かめられる。
 */

import type { ResponseMessage } from "@danything/arib/bml-protocol";

import { Carousel } from "./carousel";
import { fromTsTime, type Ruler } from "./watch";

export interface TimedMessage {
  /**
   * 放送の実時刻 (TDT/TOT 由来, unix ms)。**頭で時計を見る前のものは null。**
   *
   * TDT は数秒おきにしか来ないので、間のメッセージは「最後に見た時刻」を負う。
   * データ放送は秒単位で変わるものなので、この粒度で足りる
   */
  at: number | null;
  message: ResponseMessage;
}

/**
 * 放送の実時刻 (unix ms) を、エンコードしたものの**再生位置** (ms) に写す。
 *
 * タイムラインは放送の実時刻 (TDT) で並ぶが、再生時に突き合わせたいのは
 * 動画の再生位置。2段で直す:
 *
 * 1. **元の TS の物差しへ。** `headUnixMs` は「元の TS の頭の放送実時刻」
 *    (`DataBroadcastCapture.head`)。番組の始まり (`start_at`) ではない — 録画は
 *    前のマージンのぶん早く始まるので、そちらを基準にすると番組連動がマージン (既定 10秒) ぶん早く出る
 * 2. **エンコードしたものの物差しへ** (`ruler`。観る画面の `Ruler` と同じもの)。
 *    頭から捨てた長さ (`encode_skip`) を引き、CM を切ったものは残した区間 (`cm_kept`) だけを積む。
 *    CM の穴に落ちた時刻は、その後の本編の頭に寄せる (`fromTsTime`)
 */
export function playbackMsAt(
  atUnixMs: number,
  headUnixMs: number,
  ruler: Ruler,
): number {
  return Math.round(fromTsTime((atUnixMs - headUnixMs) / 1000, ruler) * 1000);
}

/** 再生位置 (ms) を負ったメッセージ。サイドカーに書くのはこの形式 */
export interface PlacedMessage {
  /** 動画の再生位置 (ms)。頭の準備 (`at === null`) は 0 に寄せる */
  at: number;
  message: ResponseMessage;
}

/**
 * タイムラインの放送実時刻を、まとめて再生位置に写す。
 *
 * **写すのは録画の側 (エンコード時)。** サイドカーに再生位置で書いておけば、
 * 再生側は `video.currentTime` と比べるだけでよく、基準も CM も知らずに済む。
 */
export function toPlaybackTimeline(
  timeline: readonly TimedMessage[],
  headUnixMs: number,
  ruler: Ruler,
): PlacedMessage[] {
  return timeline.map((item) => ({
    at: item.at === null ? 0 : playbackMsAt(item.at, headUnixMs, ruler),
    message: item.message,
  }));
}

/** 再生駆動が「次に何をするか」。`reset` なら入れ物を作り直してから `messages` を流す */
export interface Feed {
  /** 入れ物を作り直すか。**戻ったとき** (先に出した画面を捨てて積み直す) だけ true */
  reset: boolean;
  /** エンジン (`Bml.feed`) に順に流すもの */
  messages: ResponseMessage[];
}

/**
 * 再生位置が `fromMs` から `toMs` に動いたときに、データ放送へ何を流すか。
 *
 * **進んだら足すだけ、戻ったら作り直す。** ライブは時間が前にしか進まないので
 * 届いた順に流せばよいが、録画は巻き戻し・シークがある。前に進むぶんはその間に
 * 配られた変化を足せばよい (入れ物は積み上がっている)。**戻ると入れ物には「まだ配られて
 * いないはずの先の画面」が残っている**ので、作り直して `toMs` まで積み直す。
 *
 * `fromMs` に負の値 (まだ一度も流していない) を渡せば、頭から `toMs` まで積む。
 */
export function feedFor(
  timeline: readonly PlacedMessage[],
  fromMs: number,
  toMs: number,
): Feed {
  // 戻った (シークで巻き戻し)。先に出した画面を捨てて、頭から積み直す
  if (toMs < fromMs) return { reset: true, messages: replayAt(timeline, toMs) };
  // 進んだ。その間に配られた変化だけ足す (入れ物はそのまま)
  const messages: ResponseMessage[] = [];
  for (const item of timeline) {
    if (item.at > toMs) break;
    if (item.at > fromMs) messages.push(item.message);
  }
  return { reset: false, messages };
}

/**
 * 実時刻 `at` の時点の画面。**そこまでの変化を積んで復元する。**
 *
 * 出す順は `Carousel` に委ねる (pmt → programInfo → DII → モジュール)。シークで戻った
 * ときも、頭から積み直すだけで正しい状態になる — 変化ログなので、積む順は届いた順。
 *
 * `at` の物差しは渡すタイムラインに合わせる。本番 (観る画面と `feedFor`) は再生位置 (ms) つきの
 * `PlacedMessage[]`、テストは放送の実時刻 (unix ms) つきの `TimedMessage[]` も渡す。
 * 時計を見る前のもの (`at === null`) はテストでしか来ない。
 *
 * @param at その時刻までに配られたものを積む
 */
export function replayAt(
  timeline: readonly TimedMessage[],
  at: number,
): ResponseMessage[] {
  const carousel = new Carousel();
  for (const item of timeline) {
    // 時計を見る前のもの (at === null) は頭の準備なので常に含める。
    // 実時刻が付いていて、それが越えていたら、そこから先はまだ配られていない
    if (item.at !== null && item.at > at) break;
    carousel.take(item.message);
  }
  return carousel.replay();
}
