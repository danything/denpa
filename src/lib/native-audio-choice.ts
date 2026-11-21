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
 * macOS の Safari は `video.volume` が効く。iOS は変えられない (`volumeFixed`)
 */
export function tapSilent(ua: string, mse: boolean): boolean {
  return mse && isWebKit(ua);
}

/**
 * **ページから `<video>`・`<audio>` の音量を変えられないか。** `volume` に 0.5 を入れて読み返し、1 のままなら変えられない。
 * iOS と iPadOS の WebKit がこれ (音量は本体のボタンで決める)。macOS の Safari は変えられる。
 *
 * UA では決めない。iPadOS はデスクトップの UA を名乗るので、macOS の Safari と見分けられない
 */
export function volumeFixed(media: { volume: number }): boolean {
  try {
    media.volume = 0.5;
  } catch {
    return true;
  }
  return media.volume === 1;
}

let fixedHere: boolean | null = null;

/**
 * この端末で `<video>` の音量を変えられないか (`volumeFixed`)。**観る画面と追っかけでは、つまみを出さず、放送のままの
 * 大きさで鳴らす** (`volume.svelte.ts` の `fixed`)。1 度だけ確かめて覚えておく。サーバで組むときは false
 */
export function fixedMediaVolume(): boolean {
  if (typeof document === "undefined") return false;
  fixedHere ??= volumeFixed(document.createElement("audio"));
  return fixedHere;
}

/** この端末でライブの音を別に鳴らすか */
export function separateLiveAudio(): boolean {
  return typeof navigator !== "undefined" && isWebKit(navigator.userAgent);
}
