/**
 * **読み込めた画像をふわっと出す** (録画の一覧のポスター。`Poster.svelte` の `poster` から呼ぶ)。
 * もう読み込めている画像 (キャッシュにあった・描く前に届いた) は何もしない — 一瞬で出す。
 * 待つものだけ透明にしておき、届いたら `app.css` の `img[data-fade]` が出す。
 * 透明にするのは JS が動いてからなので、JS の無いうちは素のまま出る。
 * 読めなかったときも透明を外す (隠すかどうかは呼ぶ側。録画の一覧は `Poster.svelte` の `poster` で隠す)
 */
export function fadeIn(image: HTMLImageElement): void {
  if (image.complete) return;
  image.dataset["fade"] = "pending";
  const shown = (): void => {
    image.dataset["fade"] = "in";
  };
  image.addEventListener("load", shown, { once: true });
  image.addEventListener("error", shown, { once: true });
}
