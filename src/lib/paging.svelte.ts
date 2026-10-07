import { matches } from './paging';

/**
 * 長い一覧を**少しずつ出す**。
 *
 * ルール・予約・録画の一覧は、溜まると数百〜数千行になる。全部を一度に描くと
 * 画面遷移の直後に一瞬止まって見える (描き終わるまで何も動かない)。最初は
 * 画面に入るぶんだけ描き、下端に近づいたら続きを足す — いわゆる無限スクロール。
 *
 * **並べ替えや絞り込みで顔ぶれが変わったら先頭に戻す** (`reset`)。前の一覧で
 * 3ページ目まで開いていても、絞ったあとの一覧が同じ長さとは限らない。
 *
 * **全部は描かないので Ctrl+F では探せない。** 一覧を持つ画面には絞り込みの
 * 欄を置く (`filter`)。
 *
 * 使い方:
 *
 * ```svelte
 * const paged = new Paged(() => rows, 60);
 * {#each paged.rows as row (row.id)} … {/each}
 * {#if paged.more}<div use:sentinel={() => paged.reveal()}></div>{/if}
 * ```
 */
export class Paged<T> {
    /** いま出している行数 (頭から) */
    shown = $state(0);
    /** 尻から出している行数。`ends` のときだけ使う */
    tailShown = $state(0);

    /**
     * @param items 元の一覧。絞り込み後のものを渡す
     * @param step 一度に足す行数。1画面ぶんより少し多め
     * @param ends **頭と尻の両方から出す**か。一番下から見せる一覧 (録画の枠) のため。
     *     間を空けて両端を半分ずつ描き、続きは間に足す。**描く数は片側だけのときと同じ** —
     *     両端に `step` ずつ描くと、開いたときにハイドレーションする行が倍になり、
     *     4倍遅い CPU で操作できるまでが 1 秒以上延びた
     */
    constructor(
        private readonly items: () => T[],
        readonly step = 60,
        private readonly ends: () => boolean = () => false,
    ) {
        this.reset();
    }

    /** 片側に一度に足す行数 */
    private get side(): number {
        return this.ends() ? Math.ceil(this.step / 2) : this.step;
    }

    /** 出す行 (頭のほう)。間が無くなれば全部 */
    get rows(): T[] {
        const all = this.items();
        return this.more ? all.slice(0, this.shown) : all;
    }

    /** 尻のほう。間 (`more`) より後ろに描く。頭からだけ出すときは空 */
    get tail(): T[] {
        if (!this.more || !this.ends()) return [];
        const all = this.items();
        return all.slice(all.length - this.tailShown);
    }

    /** まだ出していない行があるか */
    get more(): boolean {
        return this.rest > 0;
    }

    /** 出していない残り */
    get rest(): number {
        return Math.max(0, this.items().length - this.shown - (this.ends() ? this.tailShown : 0));
    }

    /** 続きを足す。両端から出すときは両方に足す (見えていないほうに足しても位置は動かない) */
    reveal(): void {
        const length = this.items().length;
        this.shown = Math.min(length, this.shown + this.side);
        this.tailShown = Math.min(length, this.tailShown + this.side);
    }

    /** 先頭に戻す。絞り込みや並べ替えで顔ぶれが変わったとき */
    reset(): void {
        this.shown = this.side;
        this.tailShown = this.side;
    }
}

/**
 * 画面に入ったら呼ぶ。一覧の末尾に置いて、続きを足す合図にする。
 *
 * 一度呼んだあとも見えたままなら (足した行が画面に収まりきって、まだ見えている)、
 * 次の描画で観測し直してもう一度呼ぶ。`IntersectionObserver` は見え方が
 * **変わった**ときにしか鳴らないので、外して付け直す。
 */
export function sentinel(node: HTMLElement, onSeen: () => void) {
    let observer: IntersectionObserver | null = null;
    let seen = onSeen;
    let frame = 0;
    /**
     * 外されたか。**外されたあとに積んであった `watch` が走ると、外れた要素を
     * 見張る observer がもう1つできて、誰にも切られない** — 最後の1回を足した
     * 直後に一覧が出尽くして印ごと消えるとそうなる
     */
    let gone = false;

    const watch = (): void => {
        if (gone) return;
        observer?.disconnect();
        observer = new IntersectionObserver(
            (entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                seen();
                // 足したあとにまだ見えているなら、もう一度鳴らす
                frame = requestAnimationFrame(watch);
            },
            { rootMargin: '200px 0px' },
        );
        observer.observe(node);
    };
    watch();

    return {
        update(next: () => void) {
            seen = next;
        },
        destroy() {
            gone = true;
            cancelAnimationFrame(frame);
            observer?.disconnect();
            observer = null;
        },
    };
}

export { matches };
