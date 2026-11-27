/**
 * データ放送の NPT (Normal Play Time)。**サーバが送る NPT 参照 (`nptUpdated`) と、映しているコマの時刻から、いまの NPT を出す。**
 *
 * 画面は PCR を受け取らない (映像の再生位置で動く)。そこでサーバが、参照を使い始める STC に時刻を付けて送る
 * (`timeUnixMillis`。ライブはサーバが受け取った時刻、録画は TS の先頭から PCR が進んだぶん)。画面は映しているコマの時刻を
 * 同じ物差しで出す (`BmlOptions.shownAt`) ので、その差だけ参照の速さで NPT を進めればよい。止める・飛ぶ・速さを変えると
 * コマの時刻がそのとおりに動くので、NPT もそれに付いてくる。
 *
 * **参照は、コマの時刻が参照の時刻に達してから使う。** ライブはコマが放送より遅れて映るので、参照はコマより先に届く。
 * 届いた時点で替えると、前の番組の終わりで次の番組の NPT を答える。録画の変化ログも TDT の粒度で並ぶので、少し先に届く。
 *
 * 速さは運用される 1/1 (進む) と 0/1 (止まっている) だけを扱う (サーバの `dueEvents` と同じ。TR-B14 第二分冊の NPT 値の算出)。
 * ほかの速さの参照のあいだは、NPT は分からない。
 *
 * **使い始める STC が参照の STC_Reference より前なら、達するまでは速さを入れ替える** (同じ算出。サーバは使っている参照が
 * 無いときに、まだ達していない参照を届いた時点から使う)。進む参照は達するまで NPT_Reference で止まっていて、
 * 止まる参照は達するまで進んでいる
 */

import type { NPTUpdatedMessage } from "@danything/arib/bml-protocol";

/** 33 ビットで一周する (NPT・STC。90 kHz で 26.5 時間) */
const WRAP = 2 ** 33;
/** 1 ミリ秒の刻み (90 kHz) */
const TICKS_PER_MS = 90;
/** 覚えておく参照の数。コマの時刻が戻ったとき (ライブで少し戻すなど) に、前の参照で答えるため */
const KEEP = 8;

interface Anchor {
  /** この参照を使い始める時刻 (ミリ秒。映しているコマの時刻と同じ物差し) */
  at: number;
  /** `at` の NPT (90 kHz)。null は NPT が無い (参照が無くなった・運用されない速さ) */
  npt: number | null;
  /** 1 ミリ秒で進む量 (90 kHz)。止まっている参照は 0 */
  step: number;
  /** 参照を運んだ部品 (component_tag)。NPTReferred の es_ref と突き合わせる */
  component: number;
  /**
   * 届いた参照ごとに違う印。**同じ参照を配り直されても同じ** (遅れて繋いだときの配り直し)。
   * 達する前から使う参照は 2 つの区切りになるが、印は同じ (NPTReferred は参照ごとに 1 回)
   */
  key: string;
}

/** NPT が分かっている参照 (`NptClock.referred`) */
export interface Referred {
  component: number;
  key: string;
}

const since = (from: number, to: number) =>
  (((to - from) % WRAP) + WRAP) % WRAP;

export class NptClock {
  /** 使い始める時刻の順 */
  private anchors: Anchor[] = [];

  /**
   * サーバの `nptUpdated` を 1 つ受ける。`timeUnixMillis` が無いもの (時刻を付けない送り手) は、
   * 受け取ったときのコマの時刻 (`shown`) から使う。どちらも無ければ捨てる
   */
  update(message: NPTUpdatedMessage, shown: number | null): void {
    const at = message.timeUnixMillis ?? shown;
    if (at === null || !Number.isFinite(at)) return;
    const reference = message.reference;
    const base = {
      component: message.componentId,
      key: JSON.stringify([message.componentId, reference, message.stc, at]),
    };
    const anchors: Anchor[] = [{ ...base, at, npt: null, step: 0 }];
    if (
      reference !== null &&
      reference.scaleDenominator === 1 &&
      (reference.scaleNumerator === 0 || reference.scaleNumerator === 1)
    ) {
      const step = reference.scaleNumerator === 1 ? TICKS_PER_MS : 0;
      const passed = since(reference.STCReference, message.stc);
      if (passed < WRAP / 2) {
        anchors[0] = {
          ...base,
          at,
          npt:
            step > 0
              ? (reference.NPTReference + passed) % WRAP
              : reference.NPTReference,
          step,
        };
      } else {
        // まだ達していない。達するまでは速さを入れ替え、達した時刻からは参照のとおり
        const ahead = WRAP - passed;
        anchors[0] = {
          ...base,
          at,
          npt:
            step > 0
              ? reference.NPTReference
              : (reference.NPTReference - ahead + WRAP) % WRAP,
          step: TICKS_PER_MS - step,
        };
        anchors.push({
          ...base,
          at: at + ahead / TICKS_PER_MS,
          npt: reference.NPTReference,
          step,
        });
      }
    }
    // 後から届いたものが正しい。同じ時刻か後ろに置いていたものは置き換える
    this.anchors = this.anchors.filter((held) => held.at < at);
    this.anchors.push(...anchors);
    while (this.anchors.length > KEEP) this.anchors.shift();
  }

  /** コマの時刻 `shown` (ミリ秒) の NPT (ミリ秒)。分からなければ null */
  at(shown: number | null): number | null {
    const anchor = this.anchorAt(shown);
    if (anchor === null || anchor.npt === null || shown === null) return null;
    const npt = (anchor.npt + (shown - anchor.at) * anchor.step) % WRAP;
    return Math.floor(npt / TICKS_PER_MS);
  }

  /** NPT が進んでいるか (止まっている参照・分からないときは false)。タイマーを細かく見るかを決める */
  running(shown: number | null): boolean {
    const anchor = this.anchorAt(shown);
    return anchor !== null && anchor.npt !== null && anchor.step > 0;
  }

  /** `shown` のときに NPT が分かっている参照 (NPTReferred を起こす)。分からなければ null */
  referred(shown: number | null): Referred | null {
    const anchor = this.anchorAt(shown);
    return anchor === null || anchor.npt === null
      ? null
      : { component: anchor.component, key: anchor.key };
  }

  /** `shown` の次に参照が替わるまでのミリ秒 (コマの時刻で)。先に届いている参照が無ければ null */
  nextChange(shown: number | null): number | null {
    if (shown === null || !Number.isFinite(shown)) return null;
    const next = this.anchors.find((anchor) => anchor.at > shown);
    return next === undefined ? null : next.at - shown;
  }

  /** `shown` のときに使う参照。まだどの参照の時刻にも達していなければ null */
  private anchorAt(shown: number | null): Anchor | null {
    if (shown === null || !Number.isFinite(shown)) return null;
    for (let i = this.anchors.length - 1; i >= 0; i--)
      if (this.anchors[i]!.at <= shown) return this.anchors[i]!;
    return null;
  }
}
