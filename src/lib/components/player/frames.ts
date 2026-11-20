/**
 * **映した 1 枚ごとに呼ぶ。** ライブと観る画面で同じもの。
 *
 * ライブは字幕の貼り直しと映像の遅れの実測、観る画面は字幕と CM の跨ぎと映像の遅れの実測を、
 * いま画面に出ているフレームに合わせる。`timeupdate` はブラウザが 250ms ごとにしか出さないので、
 * **そこに載せると最大 250ms・平均 125ms 遅れる** (実機では字幕が遅れて見え、CM は飛ばすまでに 7 コマぶん映った)。
 */

/** 映した 1 枚のこと。`requestVideoFrameCallback` を持つブラウザでだけ分かる */
interface Frame {
  /** **そのフレームの時刻。** 再生位置 (`currentTime`) とは違う。あちらは先に進む */
  mediaTime: number;
}

type WithCallback = HTMLVideoElement & {
  requestVideoFrameCallback?(
    callback: (at: number, frame: Frame) => void,
  ): number;
};

/**
 * `video` が 1 枚映すたびに `run` を呼ぶ。**`run` が false を返したら終い。**
 *
 * `requestVideoFrameCallback` を持たないブラウザでは、代わりに画面の書き換えごとに呼ぶ (60Hz なら 16ms)。
 * そのときは `frame` が `undefined` で、**映したフレームの時刻が分からない** (`currentTime` は
 * 位置を代入した時点で飛んだ先を返すので、着いたかどうかの判断には使えない)。
 *
 * **止めて見ている間は呼ばない** (`requestVideoFrameCallback` の決まり)。
 */
export function eachFrame(
  video: HTMLVideoElement,
  run: (frame?: Frame) => boolean,
): void {
  const step = (): void => {
    const request = (video as WithCallback).requestVideoFrameCallback;
    if (typeof request === "function") {
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
