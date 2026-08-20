/**
 * データ放送で配ったものを覚えておく。**遅れて繋いだ人に配り直すため。**
 *
 * 解くのは [bml.ts](bml.ts) で、
 * ここはその出力を受けて「いま出すのに要るもの」だけを持つ。**流れ込む口も
 * 出ていく口も持たない** — 繋ぐのは [server/databroadcast.ts](../server/databroadcast.ts)。
 *
 * ## なぜ覚えるのか
 *
 * カルーセルは回り続けるので、途中から見た人もそのうち揃う。**`pmt` だけは
 * 1回しか来ない**ので、それを逃すと「何番のコンポーネントを出すか」が分からず、
 * 揃ったモジュールを渡しても始まらない。字幕で最後の1枚を配り直しているのと
 * 同じ理由 (`server/live.ts` の `showing`)。
 *
 * 覚えるのは4つだけ:
 *
 * - `pmt` … 最後の1つ。差し替わったら上書き
 * - `programInfo` … 同じく最後の1つ
 * - `moduleListUpdated` … コンポーネントごとに最後の1つ (DII)
 * - `moduleDownloaded` … コンポーネントとモジュールの組ごとに最後の1つ。
 *   **版が上がると中身が変わる**ので、来るたびに置き換える
 *
 * ## DII (`moduleListUpdated`) を覚える理由
 *
 * **「そのコンポーネントに、そのモジュールが在るか」はここにしか書いていない。**
 * 放送のアプリは `beitem[type="ModuleUpdated"]` を subscribe した時点で
 * 借りものに問い合わせ、**DII をまだ受け取っていなければ黙って待ちます**
 * (`interface/DOM.ts` の `subscribeModuleUpdated`)。
 *
 * ライブは回り続けるので数秒待てば次の DII が来ますが、**録画の巻き戻しでは
 * 来ません** — 変化ログを積み直す作りなので、覚えていないものは二度と流れない。
 * テレビ朝日の入口の文書がまさにこれで、番組連動データ (`/50`) の DII を
 * 待ったまま止まり、**データ放送が何も出ませんでした** (実機の録画で再現)。
 *
 * `pcr` と `currentTime` は覚えない。**次がすぐ来る**もので、古いものを配ると
 * かえって時計が狂う。
 *
 * ## 配る価値のあるものだけ通す
 *
 * `take` は「配る価値があるか」を返す。**サイドチャネルは映像と同じ1本**なので、
 * 中身の変わらないものを流し続けると、受け側がそれを捌くだけで手一杯になる。
 *
 * - **`pcr` は通さない。** 毎秒50個ほど来るうえ、denpa では**映像そのものが時計**
 *   (受け側は `<video>` の再生位置で動いている)。放送の PCR を渡す先が無い
 * - **`pmt` と `programInfo` は変わったときだけ。** 放送は同じ表を何度も送るので、
 *   そのまま通すと同じものが延々流れる
 *
 * 実際に詰まらせたことがある。作りものの放送 (e2e) で表を細かく送ったら、
 * **受け側の 250ms の目覚ましが回らなくなって操作列が消えなくなった**。
 * 映像が出ないより先に、こういう形で出る
 */

import type { ResponseMessage } from 'web-bml/protocol';

/**
 * 覚えておくモジュールの上限。**溜め込みすぎない歯止め。**
 *
 * 実機のテレビ朝日で、40秒ぶんの中に揃ったのは 16個・約1.4MB だった。
 * データ放送の作りによってはもっと多いので上限を置く。溢れたら**古いほうから
 * 落とす** — 新しいほうが、いま出ている画面に近い
 */
export const KEEP_MODULES = 256;

/** コンポーネントとモジュールの組で1つ */
function moduleKey(message: { componentId: number; moduleId: number }): string {
    return `${message.componentId}/${message.moduleId}`;
}

export class Carousel {
    private pmt: ResponseMessage | null = null;
    private programInfo: ResponseMessage | null = null;
    /** DII。**コンポーネントごとに最後の1つ** (上の説明) */
    private readonly lists = new Map<number, ResponseMessage>();
    private readonly modules = new Map<string, ResponseMessage>();

    /**
     * 1つ受ける。**覚えるかどうかと、配る価値があるかをここで決める**
     *
     * @returns 配る価値があるか (上の説明)
     */
    take(message: ResponseMessage): boolean {
        // 時計は映像が持っている。放送の PCR は渡す先が無い
        if (message.type === 'pcr') return false;
        if (message.type === 'pmt') {
            const same = this.pmt !== null && JSON.stringify(this.pmt) === JSON.stringify(message);
            this.pmt = message;
            return !same;
        }
        if (message.type === 'programInfo') {
            const same =
                this.programInfo !== null && JSON.stringify(this.programInfo) === JSON.stringify(message);
            this.programInfo = message;
            return !same;
        }
        /*
         * **DII は覚えるが、通すのは毎回。** 放送のアプリは「変わったこと」を
         * DII の繰り返しで知る (版とデータイベント番号を突き合わせる) ので、
         * 同じものでも間引かない
         */
        if (message.type === 'moduleListUpdated') {
            this.lists.set(message.componentId, message);
            return true;
        }
        if (message.type !== 'moduleDownloaded') return true;
        const key = moduleKey(message);
        /*
         * **入れ直す前に消す。** Map は入れた順に並ぶので、上書きしただけでは
         * 古い位置に居座る。溢れたときに落とすのは「いちばん古く**来た**もの」で
         * ありたいので、来るたびに末尾へ動かす
         */
        this.modules.delete(key);
        this.modules.set(key, message);
        while (this.modules.size > KEEP_MODULES) {
            const oldest = this.modules.keys().next().value;
            if (oldest === undefined) break;
            this.modules.delete(oldest);
        }
        return true;
    }

    /**
     * 繋いできた人に渡すぶん。
     *
     * **出す順は pmt → programInfo → DII → モジュール** — 何番のコンポーネントを
     * 出すかが決まってからでないと、モジュールを渡しても置き場所が無い。DII は
     * モジュールより先に置く (「在る」と言う前に中身だけ来ても、受け側は
     * 在ることを知らないまま)
     */
    replay(): ResponseMessage[] {
        const out: ResponseMessage[] = [];
        if (this.pmt !== null) out.push(this.pmt);
        if (this.programInfo !== null) out.push(this.programInfo);
        for (const held of this.lists.values()) out.push(held);
        for (const held of this.modules.values()) out.push(held);
        return out;
    }

    /** 覚えているモジュールの数。**画面には出さない** (切り分け用) */
    get held(): number {
        return this.modules.size;
    }
}
