import type { Attachment } from "svelte/attachments";

/**
 * **ボタンの長押しで、押したときとは別の操作をする** (`{@attach}`)。データ放送のボタン (d) で、自動で受信するかを切り替える
 * (`data-receive.ts`)。ライブの右端の列のボタンと、観る画面の ⚙ の「データ放送」の行で同じ。
 *
 * - タッチとペンは、押したまま `ms` たったら `onHold` を呼ぶ。指が 10px より動いたか離したら取り消す。
 *   長押しのあとに来る click は捨てる (開く・閉じるを起こさない)
 * - マウスは右クリック (`contextmenu`)。ブラウザのメニューは出さない。Android の Chrome は長押しでも `contextmenu` を出すので、
 *   タッチの長押しを済ませた直後のものは数えない (2 回切り替えない)
 * - キーボードは Shift+D (ボタンに焦点があるとき。焦点がほかにあるときは画面のキー操作 `keys.ts` の `D`)
 *
 * iOS の Safari は長押しで文字の選択と呼び出しのメニューを出すので、付けた要素の `-webkit-touch-callout` と `user-select` を切る
 */

/** 長押しとみなすまでの長さ (ms)。タッチとペンで押し続けたとき */
export const HOLD_MS = 500;

export function hold(
  onHold: () => void,
  ms = HOLD_MS,
): Attachment<HTMLElement> {
  return (node) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    /** タッチの長押しを済ませた時刻。直後の click と contextmenu を捨てる */
    let heldAt = 0;
    const SLOP = 10;
    const QUIET = 800;

    node.style.setProperty("-webkit-touch-callout", "none");
    node.style.userSelect = "none";

    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      cancel();
      startX = event.clientX;
      startY = event.clientY;
      timer = setTimeout(() => {
        timer = null;
        heldAt = Date.now();
        onHold();
      }, ms);
    };
    const move = (event: PointerEvent) => {
      if (timer === null) return;
      if (
        Math.abs(event.clientX - startX) > SLOP ||
        Math.abs(event.clientY - startY) > SLOP
      )
        cancel();
    };
    const recent = () => Date.now() - heldAt < QUIET;
    const click = (event: MouseEvent) => {
      if (!recent()) return;
      // 長押しのあとの click。押したときの操作 (開く・閉じる) はしない
      heldAt = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const menu = (event: MouseEvent) => {
      event.preventDefault();
      // タッチの長押しで切り替えたあとに Chrome が出すもの、または長押しを待っている間に出たもの
      if (recent()) return;
      if (timer !== null) {
        cancel();
        heldAt = Date.now();
      }
      onHold();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "D" || event.ctrlKey || event.altKey || event.metaKey)
        return;
      event.preventDefault();
      event.stopPropagation();
      onHold();
    };

    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", cancel);
    node.addEventListener("pointercancel", cancel);
    node.addEventListener("pointerleave", cancel);
    node.addEventListener("click", click, true);
    node.addEventListener("contextmenu", menu);
    node.addEventListener("keydown", key);
    return () => {
      cancel();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", cancel);
      node.removeEventListener("pointercancel", cancel);
      node.removeEventListener("pointerleave", cancel);
      node.removeEventListener("click", click, true);
      node.removeEventListener("contextmenu", menu);
      node.removeEventListener("keydown", key);
    };
  };
}
