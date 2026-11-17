/**
 * **MSE の実装を選ぶ。** 無ければ `ManagedMediaSource` (iPhone の Safari、iOS 17.1+)。
 *
 * iPhone の Safari には `MediaSource` が無く、代わりに `ManagedMediaSource` だけがある。
 * 使い方はほぼ同じ (`MediaSource` を継いでいる) だが、違いが 3 つある。
 *
 * - **`disableRemotePlayback = true` にしないと開かない** (`sourceopen` が来ない)。
 *   AirPlay へ渡せる別の経路 (HLS の `<source>`) を添えない限り要る
 * - **送り込んでよい間をブラウザが知らせる** (`startstreaming` / `endstreaming`)
 * - **溜めたものを、ページが消さなくてもブラウザが捨てる** (`bufferedchange`)
 *
 * TS の lib.dom にはまだ無いので、使うぶんだけ書いておく
 */
export interface MediaSourceClass {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
}

export interface PickedMediaSource {
  Source: MediaSourceClass;
  /** `ManagedMediaSource` のほうか。**`disableRemotePlayback` を立てるかの分かれ目** */
  managed: boolean;
}

/** MediaSource のありか。**テストで差し替えられるように**受け取る (既定は `globalThis`) */
interface MediaSourceScope {
  MediaSource?: MediaSourceClass;
  ManagedMediaSource?: MediaSourceClass;
}

/** 使える実装。**どちらも無ければ null** (この端末ではエンコードしたものを出せない) */
export function pickMediaSource(
  scope: MediaSourceScope = globalThis as unknown as MediaSourceScope,
): PickedMediaSource | null {
  if (typeof scope.MediaSource === "function")
    return { Source: scope.MediaSource, managed: false };
  if (typeof scope.ManagedMediaSource === "function")
    return { Source: scope.ManagedMediaSource, managed: true };
  return null;
}

/**
 * **始めてよいコマから始まるストリームを求めるか** (録画の `/stream` の `?clean=1`。`server/playback.ts`)。
 * `ManagedMediaSource` があれば求める。iPhone の Safari と Mac の Safari 17 以降 (WebKit) にあり、UA を見ずに WebKit の MSE を見分けるのに使う。
 *
 * WebKit は飛ぶとき・開くときに、目標の手前でいちばん近い sync のコマからデコーダに渡すので、印の付いた P のコマからは始められない
 * (`ts/fmp4-marks.ts`)。Chrome・Edge は始められるので、変換の枠が埋まっていれば印を直さずに詰め替えたものを受け取る (観はじめが早い)。
 * ほかのブラウザが `ManagedMediaSource` を持っても、観はじめが遅くなるか、枠が埋まっているときに 503 (混んでいる) を受けるだけで、デコードには失敗しない
 */
export function wantsCleanStart(
  scope: MediaSourceScope = globalThis as unknown as MediaSourceScope,
): boolean {
  return typeof scope.ManagedMediaSource === "function";
}
