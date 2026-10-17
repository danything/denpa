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

/**
 * **元の要素から広げて開く / 元の要素へ縮めて閉じる** (番組表のマス → 詳細)。
 *
 * 同じ名前が同時に 2 つあると切り替えごと捨てられるので、名前は**どちらか一方にだけ**付ける:
 * 開く前は元の要素、開いた後は開いた箱 (箱の側は `name` を常に持たせておく)。閉じるときは逆。
 * 元の要素がもう画面に無ければ (表を描き直した)、ふつうに入れ替える
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
    if (direction === 'open') {
        source.style.viewTransitionName = name;
        void startTransition(async () => {
            source.style.viewTransitionName = '';
            update();
            await tick();
        });
        return;
    }
    void startTransition(async () => {
        update();
        await tick();
        if (source.isConnected) source.style.viewTransitionName = name;
    }).then(() => {
        source.style.viewTransitionName = '';
    });
}

/**
 * **録画の一覧 → 観る画面で、押した行の番組名を観る画面の題名へ広げる。**
 * 一覧で押した録画を覚えておき (`rememberHero`)、一覧はその行の名前に、観る画面は題名に
 * 同じ名前を付ける (`heroName`)。観る画面から戻ったときも同じ行へ縮んで帰る。
 *
 * 名前が付くのはいつも 1 行だけで、**要るあいだだけ** — 観る画面の外へ移る切り替えが済んだら
 * 忘れる (`+layout.svelte`)。動かせないときは覚えない (名前を付けたままにしない)
 */
const hero = $state<{ recording: number | null }>({ recording: null });

export function rememberHero(id: number): void {
    if (canTransition()) hero.recording = id;
}

export function forgetHero(): void {
    hero.recording = null;
}

/** 一覧の行と観る画面の題名に付ける名前。覚えている録画でなければ付けない */
export function heroName(id: number): string | undefined {
    return hero.recording === id ? 'recording-hero' : undefined;
}

/**
 * **読み込めた画像をふわっと出す** (`use:fadeIn`。録画の一覧のポスター)。
 * もう読み込めている画像 (キャッシュにあった・描く前に届いた) は何もしない — 一瞬で出す。
 * 待つものだけ透明にしておき、届いたら `app.css` の `img[data-fade]` が出す。
 * 透明にするのは JS が動いてからなので、JS の無いうちは素のまま出る。
 * 読めなかったときも透明を外す (隠すかどうかは呼ぶ側。録画の一覧は `onerror` で隠す)
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
