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
