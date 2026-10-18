import { tick } from 'svelte';

/**
 * **画面の切り替えの動き (View Transitions)。** 見た目 (時間・曲線・何を動かさないか) は
 * `app.css` の「画面の切り替え」、ページを移るときに始めるのは `+layout.svelte` の `onNavigate`。
 *
 * どれも**使えないブラウザと、動かさない設定の端末では何もしない** (中身をそのまま入れ替える)。
 * 映像の要素には名前を付けない — 切り替えの間は名前の付いた要素が写しに置き換わるので、
 * 映っているものを止めて見せることになる
 */

/** 動かしてよいか。使えないブラウザと、動かさない設定 (`prefers-reduced-motion: reduce`) では偽 */
export function canTransition(): boolean {
    return (
        typeof document !== 'undefined' &&
        typeof document.startViewTransition === 'function' &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches
    );
}

/**
 * 切り替えを1回始める。`update` で中身を入れ替える (返す Promise が済むまでが「新しい姿」)。
 * 動かせないときは `update` をそのまま呼ぶだけ。
 *
 * **途中で畳まれても騒がない。** 次の切り替えに追い越されたり、中身の入れ替えが失敗したりすると
 * `ready`・`finished` が拒否される。どちらも動きが無くなるだけなので、ここで受け止める
 */
export function startTransition(update: () => void | Promise<void>): Promise<void> {
    if (!canTransition()) return Promise.resolve(update());
    const transition = document.startViewTransition(update);
    transition.ready.catch(() => {});
    return transition.finished.catch(() => {});
}

/** 走っている `morph` の数。開く途中で閉じると前のぶんが後から済むので、最後の1つが済んでから印を外す */
let morphing = 0;

function beginMorph(): () => void {
    morphing++;
    document.documentElement.dataset['morph'] = '';
    return () => {
        morphing--;
        if (morphing === 0) delete document.documentElement.dataset['morph'];
    };
}

/**
 * **元の要素から広げて開く / 元の要素へ縮めて閉じる** (番組表のマス → 詳細)。
 *
 * 同じ名前が同時に 2 つあると切り替えごと捨てられるので、名前は**どちらか一方にだけ**付ける:
 * 開く前は元の要素、開いた後は開いた箱 (箱の側は `name` を常に持たせておく)。閉じるときは逆。
 * 元の要素がもう画面に無ければ (表を描き直した)、ふつうに入れ替える。
 *
 * **写しにするのはこの要素だけ** (`<html data-morph>`。`app.css` の「画面の切り替え」)。ページ全体 (root) や
 * ヘッダー・下のタブを写しにすると、切り替えの間それらは開いた詳細の幕より上に重なり、
 * 幕で暗くならずに明るいまま残って、終わった瞬間に暗くなる (ヘッダーがちらつく)。
 * 写しにしなければ、ほかは生のまま描かれ、幕もふつうにふわっと出る
 */
export function morph(
    source: HTMLElement | null,
    name: string,
    direction: 'open' | 'close',
    update: () => void,
): void {
    if (source === null || !source.isConnected || !canTransition()) {
        update();
        return;
    }
    const done = beginMorph();
    if (direction === 'open') {
        source.style.viewTransitionName = name;
        void startTransition(async () => {
            source.style.viewTransitionName = '';
            update();
            await tick();
        }).then(done);
        return;
    }
    void startTransition(async () => {
        update();
        await tick();
        if (source.isConnected) source.style.viewTransitionName = name;
    }).then(() => {
        source.style.viewTransitionName = '';
        done();
    });
}

/**
 * **読み込めた画像をふわっと出す** (`use:fadeIn`。録画の一覧のポスター)。
 * もう読み込めている画像 (キャッシュにあった・描く前に届いた) は何もしない — 一瞬で出す。
 * 待つものだけ透明にしておき、届いたら `app.css` の `img[data-fade]` が出す。
 * 透明にするのは JS が動いてからなので、JS の無いうちは素のまま出る。
 * 読めなかったときも透明を外す (隠すかどうかは呼ぶ側。録画の一覧はポスターに付けるもの (`+page.svelte` の `poster`) で隠す)
 */
export function fadeIn(image: HTMLImageElement): void {
    if (image.complete) return;
    image.dataset['fade'] = 'pending';
    const shown = (): void => {
        image.dataset['fade'] = 'in';
    };
    image.addEventListener('load', shown, { once: true });
    image.addEventListener('error', shown, { once: true });
}
