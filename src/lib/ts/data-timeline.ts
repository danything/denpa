/**
 * 録画のデータ放送。**TS を解いて、変化を実時刻つきで並べる。**
 *
 * ライブは「常に今」なので [carousel.ts](carousel.ts) が「各モジュールの最後の1つ」
 * だけ持てば足りる。録画は**巻き戻し・番組またぎ**があるので、それでは足りない —
 * 30分の番組の途中で天気が差し替わったなら、10分の位置では古いほう、20分の位置では
 * 新しいほうを出したい。
 *
 * そこで、エンコードのついでに元TSをもう一度 [bml.ts](bml.ts) に通し、**配る価値の
 * あった変化だけ**を放送の実時刻 (TDT/TOT) つきで並べておく (`captureDataBroadcast`)。
 * 再生時は、再生位置に当たる実時刻までの変化を新しい `Carousel` に流し込めば、
 * **その時点の画面**が復元できる (`replayAt`)。シークもこれで作り直すだけ。
 *
 * ## なぜ「変化ログ」で足りるのか
 *
 * カルーセルは同じものを何度も回すが、[bml.ts](bml.ts) は**版が上がったときだけ**
 * `moduleDownloaded` を出し、`Carousel.take` は変わらない `pmt`/`programInfo` を
 * 落とす。だから `take` が通したものを順に集めれば、それがそのまま
 * 「いつ何が変わったか」の記録になる。再生は「そこまでの変化を積む」だけ。
 *
 * DOM も時計も触らないので、ここだけ単体で確かめられる。
 */

import type { ResponseMessage } from '$lib/vendor/web-bml/server/ws_api';
import { BmlDecoder } from './bml';
import { Carousel } from './carousel';

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
 * TS を解いて、データ放送の変化を実時刻つきで並べる。
 *
 * @param chunks 1局に絞った TS のチャンク列 (録画の生TSをそのまま流してよい)
 */
export function captureDataBroadcast(chunks: Iterable<Uint8Array>): TimedMessage[] {
    const timeline: TimedMessage[] = [];
    // 「配る価値があるか」の判定はライブと同じ土俵に乗せる (pcr は落ち、変わらない
    // pmt/programInfo も落ちる)。中の記憶そのものは使わない — 使うのは take の判定だけ
    const gate = new Carousel();
    let at: number | null = null;
    const decoder = new BmlDecoder((message) => {
        // 時計は別に持つ。放送の実時刻はここでしか分からない
        if (message.type === 'currentTime') {
            at = message.timeUnixMillis;
            return;
        }
        if (!gate.take(message)) return;
        timeline.push({ at, message });
    });
    for (const chunk of chunks) decoder.feed(chunk);
    return timeline;
}

/** CM を実カットした録画で残した区間 (秒)。off/chapter のときは切らないので null */
export interface KeptRange {
    start: number;
    end: number;
}

/**
 * 放送の実時刻 (unix ms) を、録画の**再生位置** (ms) に写す。
 *
 * タイムラインは放送の実時刻 (TDT) で並ぶが、再生時に突き合わせたいのは
 * 動画の再生位置。基準 `anchorUnixMs` は「再生位置 0 のときの放送実時刻」で、
 * 録画の `start_at` か、最初に見た TDT を渡す (データ放送は秒単位で動くので、
 * 数秒の基準ずれは効かない)。
 *
 * **CM を実カットした録画 (`keep`) は時間軸が縮む。** 合わせないと番組連動が
 * 数分ずれるので、残した区間だけを積んでカット後の位置に直す。CM 位置があるより
 * 手前 (まだ残っている区間の途中) はそのぶんだけ、CM の穴に落ちた時刻は
 * その手前の残り終わりに寄せる。off/chapter (切っていない) なら `keep` は null で、
 * そのまま比例する。
 */
export function playbackMsAt(
    atUnixMs: number,
    anchorUnixMs: number,
    keep: readonly KeptRange[] | null,
): number {
    const tsSeconds = (atUnixMs - anchorUnixMs) / 1000;
    if (tsSeconds <= 0) return 0;
    if (keep === null) return Math.round(tsSeconds * 1000);
    let kept = 0;
    for (const range of keep) {
        if (tsSeconds <= range.start) break;
        kept += Math.min(tsSeconds, range.end) - range.start;
    }
    return Math.round(kept * 1000);
}

/** 再生位置 (ms) を負ったメッセージ。サイドカーに書くのはこの形 */
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
    anchorUnixMs: number,
    keep: readonly KeptRange[] | null,
): PlacedMessage[] {
    return timeline.map((item) => ({
        at: item.at === null ? 0 : playbackMsAt(item.at, anchorUnixMs, keep),
        message: item.message,
    }));
}

/** 再生駆動が「次に何をするか」。`reset` なら器を作り直してから `messages` を流す */
export interface Feed {
    /** 器を作り直すか。**戻ったとき** (先に出した画面を捨てて積み直す) だけ true */
    reset: boolean;
    /** `BMLBrowser.emitMessage` に順に流すもの */
    messages: ResponseMessage[];
}

/**
 * 再生位置が `fromMs` から `toMs` に動いたときに、データ放送へ何を流すか。
 *
 * **進んだら足すだけ、戻ったら作り直す。** ライブは時間が前にしか進まないので
 * 届いた順に流せばよいが、録画は巻き戻し・シークがある。前に進むぶんはその間に
 * 配られた変化を足せばよい (器は積み上がっている)。**戻ると器には「まだ配られて
 * いないはずの先の画面」が残っている**ので、作り直して `toMs` まで積み直す。
 *
 * `fromMs` に負の値 (まだ一度も流していない) を渡せば、頭から `toMs` まで積む。
 */
export function feedFor(timeline: readonly PlacedMessage[], fromMs: number, toMs: number): Feed {
    // 戻った (シークで巻き戻し)。先に出した画面を捨てて、頭から積み直す
    if (toMs < fromMs) return { reset: true, messages: replayAt(timeline, toMs) };
    // 進んだ。その間に配られた変化だけ足す (器はそのまま)
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
 * 出す順は `Carousel` に委ねる (pmt → programInfo → モジュール)。シークで戻った
 * ときも、頭から積み直すだけで正しい状態になる — 変化ログなので、積む順は届いた順。
 *
 * @param timeline `captureDataBroadcast` の出力
 * @param at 放送の実時刻 (unix ms)。この時刻までに配られたものを積む
 */
export function replayAt(timeline: readonly TimedMessage[], at: number): ResponseMessage[] {
    const carousel = new Carousel();
    for (const item of timeline) {
        // 時計を見る前のもの (at === null) は頭の準備なので常に含める。
        // 実時刻が付いていて、それが越えていたら、そこから先はまだ配られていない
        if (item.at !== null && item.at > at) break;
        carousel.take(item.message);
    }
    return carousel.replay();
}
