import { DOUBLE_TAP } from "#lib/ts/watch.js";

/**
 * **真ん中あたりを素早く 2 回で再生/一時停止**。
 * ライブだけが使う。録画視聴と追っかけは端の 2 回タップ (10 秒送り) と一体の
 * 決まりを持っているので、あちらは `ts/watch.ts` の `tap`。
 *
 * 指だけ。指の 1 回目は操作バーの出し入れで、2 回目で初めて再生に触る。
 * マウスは 1 回目で何もしないので、2 回目に意味を持たせるものが無い。
 *
 * @param toggle 再生/一時停止
 * @param fallback 2 回目でなかったときの従来の動き (操作バーの出し入れ)
 */
export function centerTap(
  toggle: () => void,
  fallback: (event: MouseEvent) => void,
): (event: MouseEvent) => void {
  let last = 0;
  return (event) => {
    if (window.matchMedia("(pointer: coarse)").matches) {
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const ratio = (event.clientX - box.left) / Math.max(1, box.width);
      const middle = ratio >= 0.3 && ratio <= 0.7;
      const at = Date.now();
      if (middle && at - last < DOUBLE_TAP) {
        last = 0;
        toggle();
        return;
      }
      last = middle ? at : 0;
    }
    fallback(event);
  };
}
