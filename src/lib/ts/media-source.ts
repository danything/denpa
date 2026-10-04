/**
 * **MSE の器を選ぶ。** 無ければ `ManagedMediaSource` (iPhone の Safari、iOS 17.1+)。
 *
 * iPhone の Safari には `MediaSource` が無く、代わりに `ManagedMediaSource` だけがある。
 * 使い方はほぼ同じ (`MediaSource` を継いでいる) だが、違いが3つある:
 *
 * - **`disableRemotePlayback = true` にしないと開かない** (`sourceopen` が来ない)。
 *   AirPlay へ渡せる別の道 (HLS の `<source>`) を添えない限り要る
 * - **送り込む頃合いをブラウザが言う** (`startstreaming` / `endstreaming`)
 * - **溜めたものをブラウザが勝手に捨てる** (`bufferedchange`)
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

/** 器のありか。**試しで差し替えられるように**受け取る (既定は `globalThis`) */
export interface MediaSourceScope {
    MediaSource?: MediaSourceClass;
    ManagedMediaSource?: MediaSourceClass;
}

/** 使える器。**どちらも無ければ null** (この端末では焼いたものを出せない) */
export function pickMediaSource(
    scope: MediaSourceScope = globalThis as unknown as MediaSourceScope,
): PickedMediaSource | null {
    if (typeof scope.MediaSource === 'function') return { Source: scope.MediaSource, managed: false };
    if (typeof scope.ManagedMediaSource === 'function') {
        return { Source: scope.ManagedMediaSource, managed: true };
    }
    return null;
}
