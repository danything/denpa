/**
 * **この端末で生の TS を解けるか** (docs/stream.md §5.5)。解けなければ理由を返す。
 *
 * 要るのは4つ: WebAssembly (MPEG-2 の復号器)、worker の中の WebGL2 (描く)、AudioDecoder
 * の AAC (音)、AudioContext (鳴らす)。**AudioDecoder は安全な繋ぎ (https か localhost)
 * でしか出てこない** — LAN でも http で開いていると使えない
 * ([player.md](../../../docs/player.md)「LAN でも https で開く」)。
 *
 * 1つでも欠けていれば、画面は最初から焼いたものを頼む (設定を入れていても)。
 */

let answer: Promise<string | null> | null = null;

/** 解けない理由。解けるなら null。**1回だけ調べて覚える** */
export function rawUnsupported(): Promise<string | null> {
    answer ??= probe();
    return answer;
}

async function probe(): Promise<string | null> {
    if (typeof WebAssembly !== 'object') return 'WebAssembly が使えません';
    if (typeof Worker !== 'function') return 'worker が使えません';
    if (typeof AudioContext !== 'function') return '音を鳴らせません (AudioContext が無い)';
    const canvas = document.createElement('canvas');
    if (typeof canvas.transferControlToOffscreen !== 'function') return 'OffscreenCanvas が使えません';
    // 画面の側で WebGL2 が作れれば、worker の OffscreenCanvas でも作れる (どちらも同じ GPU の道)
    if (canvas.getContext('webgl2') === null) return 'WebGL2 が使えません';
    if (typeof AudioDecoder !== 'function') {
        return isSecureContext
            ? 'AudioDecoder が使えません'
            : 'https で開いていないので、AudioDecoder が使えません';
    }
    try {
        const { supported } = await AudioDecoder.isConfigSupported({
            codec: 'mp4a.40.2',
            sampleRate: 48000,
            numberOfChannels: 2,
        });
        if (supported !== true) return 'AAC を解けません';
    } catch {
        return 'AAC を解けません';
    }
    return null;
}
