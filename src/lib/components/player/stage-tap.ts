import { type Tap, tap, zoneOf } from '#lib/ts/watch.js';

/**
 * 絵を押されたときの口。**観る画面と追っかけで同じ** — 観ているものは焼き上がった
 * 録画と同じなので、焼く前だけ押し方が違うと迷う。読み方は `ts/watch.ts` の `tap` が決め、
 * ここは効かせるだけ。
 *
 * - マウス … 1回で再生/一時停止、左右の端を素早く2回で 10秒
 * - 指 … 1回で操作列の出し入れ、真ん中を素早く2回で再生/一時停止、端2回で 10秒
 *
 * 指かどうかは押すたびに見る (`(pointer: coarse)` は「いま使っている指し手が粗いか」なので、
 * タッチのノートPCでも当たる)
 */
export function stageTap(on: {
    toggle: () => void;
    controls: () => void;
    seekBy: (seconds: number) => void;
}): (event: MouseEvent) => void {
    let last: Tap | null = null;
    return (event) => {
        const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const coarse = window.matchMedia('(pointer: coarse)').matches;
        const { action, next } = tap(
            last,
            event.timeStamp,
            zoneOf(event.clientX - box.left, box.width),
            coarse,
        );
        last = next;
        if (action.kind === 'play') on.toggle();
        // 出し入れの判断は `controls` が持つ (押す前に出ていたかで決める)
        else if (action.kind === 'controls') on.controls();
        else {
            // 2回目。マウスは1回目で再生を切り替えているので、それも戻す
            if (action.undo) on.toggle();
            on.seekBy(action.by);
        }
    };
}
