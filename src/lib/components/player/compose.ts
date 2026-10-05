/**
 * 小窓 (PiP) へ**字幕ごと**出す絵の流れを作る (`pip.svelte.ts`)。
 *
 * 字幕は `<video>` の上に重ねた canvas に描いている (`paint.ts`) ので、`<video>` を
 * そのまま小窓にすると字幕は付いていかない。流れてくるコマ1枚ずつに、いま画面に
 * 出している字幕の canvas をそのまま重ねて、別の流れに書き込む。
 *
 * - **時刻は画面の字幕と同じ** — 重ねるのは画面の canvas そのものなので、出し消し
 *   (字幕のボタン) も出す時刻もそちらに乗る
 * - **字幕が出ていないコマは素通し** (描き直さない)。描いているかは canvas の印で見る
 *   (`paint.ts` の `drawOverlay` が立てる `data-drawn`)
 * - **コマが来るたびに回す** (`MediaStreamTrackProcessor`)。画面の更新 (`requestAnimationFrame`
 *   や canvas の `captureStream`) に頼ると、窓が隠れたときに絵が止まる (`raw/worker.ts` の `toPip`)
 *
 * 使えるのは `MediaStreamTrackProcessor` と `MediaStreamTrackGenerator` を持つブラウザ
 * (Chrome・Edge) だけ。無ければ字幕無しの小窓のまま。
 *
 * **重さ**: 字幕が出ている間は 1080 のコマを毎回描き直す。GPU の無いヘッドレスの Chromium
 * (SwiftShader) で 30fps の 1920x1080 を測ると、素通しの 3% に対して 1 コアの 35% ほど。
 * 1280 幅に縮めて描くと拡大縮小のぶんかえって重かった (40%) ので、そのままの大きさで描く。
 * 用意するのは小窓に出している間だけ (`pip.svelte.ts`)
 */

type Processor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };
type Generator = new (init: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };

function apis(): { Processor: Processor; Generator: Generator } | null {
    const scope = globalThis as {
        MediaStreamTrackProcessor?: Processor;
        MediaStreamTrackGenerator?: Generator;
    };
    const { MediaStreamTrackProcessor: Processor, MediaStreamTrackGenerator: Generator } = scope;
    if (typeof Processor !== 'function' || typeof Generator !== 'function') return null;
    if (typeof OffscreenCanvas !== 'function' || typeof VideoFrame !== 'function') return null;
    return { Processor, Generator };
}

/** この端末で字幕を重ねられるか */
export function canCompose(): boolean {
    return apis() !== null;
}

/** 字幕を描いているか (`paint.ts` の `drawOverlay` / `clearOverlay` が出し入れする印) */
export function captionDrawn(canvas: HTMLCanvasElement | null): canvas is HTMLCanvasElement {
    return canvas !== null && canvas.dataset['drawn'] !== undefined && canvas.width > 0 && canvas.height > 0;
}

export interface Composed {
    /** 字幕を重ねた流れ。代わりの `<video>` に繋ぐ */
    readonly stream: MediaStream;
    /** 畳む。**元の流れも止める** (`captureStream` で取ったものは止めないと取り続ける) */
    stop: () => void;
}

/**
 * `input` のコマに、`overlay` (字幕の canvas) を**コマいっぱいに引き伸ばして**重ねる。
 * 字幕の面は映像の絵のある枠いっぱいに敷いている (`paint.ts` の `fitRect`) ので、これで同じ所に出る。
 * 使えない端末では null
 */
export function compose(input: MediaStreamTrack, overlay: () => HTMLCanvasElement | null): Composed | null {
    const found = apis();
    if (found === null) return null;
    let processor: InstanceType<Processor>;
    let generator: InstanceType<Generator>;
    try {
        processor = new found.Processor({ track: input });
        generator = new found.Generator({ kind: 'video' });
    } catch {
        return null;
    }
    let canvas: OffscreenCanvas | null = null;
    let context: OffscreenCanvasRenderingContext2D | null = null;
    const transform = new TransformStream<VideoFrame, VideoFrame>({
        transform(frame, controller) {
            const caption = overlay();
            if (!captionDrawn(caption)) {
                controller.enqueue(frame);
                return;
            }
            const width = frame.displayWidth;
            const height = frame.displayHeight;
            if (canvas === null || canvas.width !== width || canvas.height !== height) {
                canvas = new OffscreenCanvas(width, height);
                context = canvas.getContext('2d');
            }
            if (context === null) {
                controller.enqueue(frame);
                return;
            }
            try {
                context.drawImage(frame, 0, 0, width, height);
                context.drawImage(caption, 0, 0, width, height);
                controller.enqueue(new VideoFrame(canvas, { timestamp: frame.timestamp }));
            } catch {
                // 描けなかった1枚。次のコマで描き直す
            } finally {
                frame.close();
            }
        },
    });
    void processor.readable
        .pipeThrough(transform)
        .pipeTo(generator.writable)
        .catch(() => undefined);
    return {
        stream: new MediaStream([generator]),
        stop() {
            input.stop();
            generator.stop();
        },
    };
}
