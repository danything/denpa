/**
 * **選んでいる印を、前の場所から滑らせる** (`use:slide`。上のナビの下線・下のタブの印・番組表の種別)。
 *
 * 印は選んでいる項目の中にだけ描くので、選び直すと古い印が消えて新しい印ができる。できたときに、同じ組 (`group`)
 * の前の印があった場所から今の場所へ、印の要素だけを動かす (80ms。`app.css` の `--dp-duration`)。
 *
 * **画面全体の写しは取らない。** 以前は View Transitions で滑らせていたが、ページを移るたびにブラウザが古い画面を
 * 写し取ってから描き替えるので、押してから一拍遅れて切り替わっていた (本番で 70〜100ms)。
 *
 * 滑らせるのは、前の印が**いまの描き替えの中で**消えたときだけ (`RECENT` 以内)。ほかの画面から戻ってきたときの
 * 番組表の種別のように、前の印がずっと前に消えたものは、その場に出す。動かさない設定の端末では何もしない
 */
const RECENT = 500;
const DURATION = 80;
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
/** 組ごとの、いま出ている印 */
const live = new Map<string, HTMLElement>();
/** 組ごとの、最後に消えた印の場所と時刻 */
const gone = new Map<string, { rect: DOMRect; at: number }>();

function still(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function slide(node: HTMLElement, group: string) {
  const before = live.get(group);
  const left = gone.get(group);
  const from = before?.isConnected
    ? before.getBoundingClientRect()
    : left !== undefined && performance.now() - left.at < RECENT
      ? left.rect
      : null;
  live.set(group, node);
  // 消えるときには外れていて測れないことがあるので、できたときの場所を覚えておく
  let rect = node.getBoundingClientRect();
  if (from !== null && !still()) {
    const to = rect;
    if (
      to.width > 0 &&
      (Math.abs(from.left - to.left) > 0.5 ||
        Math.abs(from.width - to.width) > 0.5)
    ) {
      node.animate(
        [
          {
            transform: `translateX(${from.left - to.left}px) scaleX(${from.width / to.width})`,
            transformOrigin: "left center",
          },
          { transform: "none", transformOrigin: "left center" },
        ],
        { duration: DURATION, easing: EASE },
      );
    }
  }
  return {
    destroy() {
      if (live.get(group) === node) live.delete(group);
      if (node.isConnected) rect = node.getBoundingClientRect();
      gone.set(group, { rect, at: performance.now() });
    },
  };
}

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
