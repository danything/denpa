/**
 * **この端末で生の TS を解けるか** (docs/stream.md §5.5)。解けなければ理由を返す。
 *
 * 要るのは4つ: WebAssembly (MPEG-2 と AAC の復号器)、worker、worker の中の WebGL2 (描く)、
 * AudioContext (鳴らす)。AAC も WASM で解くので、WebCodecs (AudioDecoder) は要らない —
 * http で開いた LAN や、AudioDecoder の無い iPhone の Safari (iOS 26 より前) でも生にできる。
 *
 * 1つでも欠けていれば、MPEG-2 を選んでも画面は焼いたものを頼む。
 */

let answer: string | null | undefined;

/** 解けない理由。解けるなら null。**1回だけ調べて覚える** */
export function rawUnsupported(): Promise<string | null> {
    if (answer === undefined) answer = probe();
    return Promise.resolve(answer);
}

function probe(): string | null {
    if (typeof WebAssembly !== 'object') return 'WebAssembly が使えません';
    if (typeof Worker !== 'function') return 'worker が使えません';
    if (typeof AudioContext !== 'function') return '音を鳴らせません (AudioContext が無い)';
    const canvas = document.createElement('canvas');
    if (typeof canvas.transferControlToOffscreen !== 'function') return 'OffscreenCanvas が使えません';
    // 画面の側で WebGL2 が作れれば、worker の OffscreenCanvas でも作れる (どちらも同じ GPU の道)
    if (canvas.getContext('webgl2') === null) return 'WebGL2 が使えません';
    return null;
}
