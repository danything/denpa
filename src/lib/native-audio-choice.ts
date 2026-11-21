/**
 * **ライブの音を `<video>` と別に鳴らすか** (`raw/native-audio.ts`)。WebKit (Safari、iPhone のどのブラウザも) だけ。
 *
 * WebKit は MSE / ManagedMediaSource で流している `<video>` の音を Web Audio に通すと無音しか渡さない
 * ([WebKit #266922](https://bugs.webkit.org/show_bug.cgi?id=266922)) ので、音量のつまみ (`volume.svelte.ts`) が効かない。
 * **設定には出さず UA で決める**。起きるかはブラウザで決まり、使う人が選ぶことではない。
 * Chromium (テスラ・Android も) は UA に `Chrome/` などの印がある。Firefox は `AppleWebKit/` を名乗らない
 */
export function isWebKit(ua: string): boolean {
  // `\b` は付けない (ヘッドレスの Chromium は `HeadlessChrome/`)
  return /AppleWebKit\//.test(ua) && !/(Chrome|Chromium|Edg|OPR)\//.test(ua);
}

/**
 * **`<video>` の音を Web Audio に通すと無音になるか。** WebKit で、MSE (ManagedMediaSource) で流しているとき (#266922)。
 * 観る画面は音を別に鳴らさないので、このときは通さずに `video.volume` で下げる (`volume.svelte.ts` の `silentTap`)。
 * macOS の Safari は `video.volume` が効く。iOS は変えられないので、放送のままの大きさで鳴る
 */
export function tapSilent(ua: string, mse: boolean): boolean {
  return mse && isWebKit(ua);
}

/** この端末でライブの音を別に鳴らすか */
export function separateLiveAudio(): boolean {
  return typeof navigator !== "undefined" && isWebKit(navigator.userAgent);
}
