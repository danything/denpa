/**
 * **映した1枚ごとに呼ぶ。** ライブと観る画面で同じもの。
 *
 * どちらも「いま画面に出ている絵に合わせて何かする」ために要ります —
 * ライブは字幕の貼り直しと絵の遅れの実測、観る画面は字幕とCMの跨ぎ。
 * `timeupdate` はブラウザが 250ms ごとにしか出さないので、**そこに載せると
 * 最大 250ms・平均 125ms 遅れます** (実機では字幕が遅れて見え、CMは
 * 気付くまでの7コマぶん映っていた)。
 *
 * 呼び出し側に書いていた頃は、`requestVideoFrameCallback` を持っているか
 * 調べる**同じ十数行が2箇所**にあり、型の付け方まで別々でした。
 */

/** 映した1枚のこと。`requestVideoFrameCallback` を持つブラウザでだけ分かる */
export interface Frame {
    /** **その絵の時刻。** 再生位置 (`currentTime`) とは違う — あちらは先に進む */
    mediaTime: number;
}

type WithCallback = HTMLVideoElement & {
    requestVideoFrameCallback?(callback: (at: number, frame: Frame) => void): number;
};

/**
 * `video` が1枚映すたびに `run` を呼ぶ。**`run` が false を返したら終い。**
 *
 * `requestVideoFrameCallback` を持たないブラウザでは画面の書き換えごとに
 * 代えます (60Hz なら 16ms)。そのときは `frame` が `undefined` — **映した絵の
 * 時刻が分からない**ので、呼ぶ側はそのつもりで受けること (`currentTime` は
 * 位置を代入した時点で跳んだ先を返すので、着いたかどうかの判断には使えない)。
 *
 * **止めて見ている間は来ません** (`requestVideoFrameCallback` の決まり)。
 */
export function eachFrame(video: HTMLVideoElement, run: (frame?: Frame) => boolean): void {
    const step = (): void => {
        const request = (video as WithCallback).requestVideoFrameCallback;
        if (typeof request === 'function') {
            request.call(video, (_at, frame) => {
                if (run(frame)) step();
            });
        } else {
            requestAnimationFrame(() => {
                if (run()) step();
            });
        }
    };
    step();
}
