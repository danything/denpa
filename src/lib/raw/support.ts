/**
 * **この端末で元の TS をデコードできるか** (docs/stream.md §5.5)。デコードできなければ理由を返す。
 *
 * 要るのは4つ: WebAssembly (MPEG-2 と AAC のデコーダ)、worker、worker の中の WebGL2 (描く)、
 * AudioContext (鳴らす)。AAC も WASM でデコードするので、WebCodecs (AudioDecoder) は要らない —
 * http で開いた LAN や、AudioDecoder の無い iPhone の Safari (iOS 26 より前) でも生にできる。
 *
 * 1つでも欠けていれば、MPEG-2 を選んでも画面はエンコードしたものを頼む。
 *
 * ## エンコードしたものを canvas で描けるか (互換モード。`canvasSupport`)
 *
 * 映像をデコードするのはブラウザの VideoDecoder (WebCodecs) で、**形ごとに端末次第**。
 * VideoDecoder は安全な繋ぎ (https か localhost) でしか出てこないので、http で開いた LAN では
 * どちらも使えない (MPEG-2 は使える)。音は WASM でデコードするので、ほかに要るものは生と同じ
 * (WebGL2 は要らない — 2D で描く)
 */

let answer: string | null | undefined;

/** デコードできない理由。デコードできるなら null。**1回だけ調べて覚える** */
export function rawUnsupported(): Promise<string | null> {
    if (answer === undefined) answer = probe();
    return Promise.resolve(answer);
}

function probe(): string | null {
    const common = commonProblem();
    if (common !== null) return common;
    // 画面の側で WebGL2 が作れれば、worker の OffscreenCanvas でも作れる (どちらも同じ GPU の道)
    if (document.createElement('canvas').getContext('webgl2') === null) return 'WebGL2 が使えません';
    return null;
}

/** 生でも互換モードでも要るもの */
function commonProblem(): string | null {
    if (typeof WebAssembly !== 'object') return 'WebAssembly が使えません';
    if (typeof Worker !== 'function') return 'worker が使えません';
    if (typeof AudioContext !== 'function') return '音声を再生できません (AudioContext がありません)';
    const canvas = document.createElement('canvas');
    if (typeof canvas.transferControlToOffscreen !== 'function') return 'OffscreenCanvas が使えません';
    return null;
}

/** 互換モードで描ける形 (`canvasSupport`) */
export interface CanvasSupport {
    h264: boolean;
    av1: boolean;
}

/**
 * 問い合わせる形。サーバがエンコードする形と同じ (`server/live.ts` の `codecsFor`)。
 * 実際にデコードするときは moov から読んだ形で開く (`ts/fmp4.ts` の `readInit`) — エンコード方式が同じなので同じになる
 */
const PROBE = { h264: 'avc1.640029', av1: 'av01.0.08M.08' } as const;

let canvasAnswer: Promise<CanvasSupport> | undefined;

/** 互換モードで H.264 / AV1 を描けるか。**1回だけ調べて覚える** */
export function canvasSupport(): Promise<CanvasSupport> {
    canvasAnswer ??= probeCanvas();
    return canvasAnswer;
}

async function probeCanvas(): Promise<CanvasSupport> {
    const none = { h264: false, av1: false };
    if (commonProblem() !== null || typeof VideoDecoder !== 'function') return none;
    const ask = async (codec: string): Promise<boolean> => {
        try {
            const result = await VideoDecoder.isConfigSupported({
                codec,
                codedWidth: 1920,
                codedHeight: 1080,
            });
            return result.supported === true;
        } catch {
            return false;
        }
    };
    const [h264, av1] = await Promise.all([ask(PROBE.h264), ask(PROBE.av1)]);
    return { h264, av1 };
}
