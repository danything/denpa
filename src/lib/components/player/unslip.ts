/**
 * **映像だけ遅れたら、その場へ飛び直す。** ライブ (`live-player.svelte.ts`) と観る画面で同じ決まり。
 *
 * デコードが間に合わないと映像だけ取り残され、Chrome は遅れたまま出し続けて戻らない (実機の Android)。
 * 音と字幕は再生位置に乗るので、口の動きだけずれる。飛び直すとデコーダは積み残しを捨てて出し直す。
 * 遅れは映した 1 枚の時刻 (`requestVideoFrameCallback` の `mediaTime`) と再生位置の差で測る
 * ([frames.ts](frames.ts))。
 */

/**
 * 映像だけがこれだけ遅れたら飛び直す (秒)。声と口のずれが分かりはじめるのが 0.1 秒あたり。
 * 実機で無事なときの遅れは最大 0.058 秒だったので、飛んでばかりにはならない (0.15 では分かるのに直らなかった)
 */
export const SLIP_MOST = 0.1;

/** 飛び直す間隔の下限 (ms)。**デコードが追いつかない状態は飛んでも直らない** */
export const UNSLIP_EVERY = 3_000;
/*
 * コマ落ちでは飛び直さない。実機の Windows Edge は落ち着いたあとでも絶えず 5.6% 落ちていて、合図にすると
 * 3 秒ごとに飛び続けた (飛ぶたびに音が 0.02 秒飛ぶ)。飛んでもコマ落ちは減らなかった
 */

/** 飛び直す幅 (秒)。**同じ値を入れ直すのは飛んだことにならない**ので、1 コマぶんだけ前へ */
export const UNSLIP_STEP = 0.02;

/** 映した 1 枚が再生位置からどれだけ遅れているか (秒。進んでいれば 0) */
export function slipOf(currentTime: number, mediaTime: number): number {
  return Math.max(currentTime - mediaTime, 0);
}

/**
 * 観る画面の飛び直し。映した 1 枚ごとに `check` を呼ぶ。飛び直したら true。
 * 止めている間・飛んでいる最中は飛ばない。連発はさせない (`UNSLIP_EVERY`)
 */
export function unslipper(now: () => number = Date.now) {
  let after = 0;
  return {
    check(video: HTMLVideoElement, mediaTime: number): boolean {
      if (slipOf(video.currentTime, mediaTime) <= SLIP_MOST) return false;
      const at = now();
      if (at < after || video.paused || video.seeking) return false;
      after = at + UNSLIP_EVERY;
      video.currentTime += UNSLIP_STEP;
      return true;
    },
  };
}
