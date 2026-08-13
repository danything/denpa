import { DOUBLE_TAP } from '$lib/ts/watch';

/**
 * **真ん中あたりを素早く2回で再生/一時停止** (スマホの VLC と同じ癖)。
 * ライブと追っかけが使う。録画視聴は端の2回タップ (10秒送り) と一体の
 * 決まりを持っているので、あちらは `ts/watch.ts` の `tap`。
 *
 * 指だけ — 指の1回目は操作列の出し入れで、2回目で初めて再生に触る。
 * マウスは1回目で何もしないので、2回目に意味を持たせるものが無い。
 *
 * @param toggle 再生/一時停止
 * @param fallback 2回目でなかったときの従来の動き (操作列の出し入れ)
 */
export function centerTap(
    toggle: () => void,
    fallback: (event: MouseEvent) => void,
): (event: MouseEvent) => void {
    let last = 0;
    return (event) => {
        if (window.matchMedia('(pointer: coarse)').matches) {
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
