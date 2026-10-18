/// <reference lib="webworker" />
/**
 * **`<video>` のコマを縮める** worker (アンビエントモード。`ambient.svelte.ts` の `videoGlance`)。
 *
 * 画面の側で `<video>` から直に縮めると、ブラウザが元の大きさのまま RGB に直してから縮めるので、
 * GPU の無い端末では 1 回 5〜10ms 画面が止まる。画面は `new VideoFrame(video)` (コマを指すだけで写さない)
 * を渡すだけにして、直して縮めるのはここでやる。縮め方は `raw/downscale.ts` (半分ずつ縮めて、雑音を平均で消す)
 */
import { downscale } from '#lib/raw/downscale.js';
import type { GrabSize } from '#lib/raw/messages.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;

export interface GlanceRequest {
    id: number;
    frame: VideoFrame;
    size: GrabSize;
}

export interface GlanceReply {
    id: number;
    bitmap: ImageBitmap | null;
}

scope.onmessage = async (event: MessageEvent<GlanceRequest>) => {
    const { id, frame, size } = event.data;
    let bitmap: ImageBitmap | null = null;
    try {
        bitmap = await downscale(frame, frame.displayWidth, frame.displayHeight, size);
    } catch {
        // 縮められなかった。画面は次の回にまたリクエストする
    } finally {
        frame.close();
    }
    const reply: GlanceReply = { id, bitmap };
    scope.postMessage(reply, bitmap === null ? [] : [bitmap]);
};
