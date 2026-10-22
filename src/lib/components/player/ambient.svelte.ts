import { read, write } from "#lib/keep.js";
import { type GrabSize, shrink } from "#lib/raw/messages.js";
import { AMBIENT_KEY, storedAmbient } from "./ambient";
import type { GlanceReply, GlanceRequest } from "./glance-worker";

/**
 * アンビエントモード。**映像の色を、枠の周りにぼかして広げる。3画面 (ライブ・追っかけ・観る画面) で同じもの。既定はオン。**
 *
 * 光を描くのは `AmbientGlow.svelte` (舞台 `PlayerStage` が枠の周りに置く)。ここが持つのは
 * オン/オフと、いまのコマを小さく写す手立て:
 *
 * - `<video>` で観ているとき … コマ (`VideoFrame`) を worker に渡して縮めてもらう (`glance-worker.ts`)。
 *   `VideoFrame` の無いブラウザは画面の側で `createImageBitmap` で縮める
 * - canvas に描いているとき (放送のままの MPEG-2・互換モード) … 映像は worker の canvas にあって
 *   画面の側からは読めないので、その worker に縮めたものを1枚もらう (`RawEngine.grab` の `size`)
 *
 * どちらも同じオリジンから流しているので、写しても汚れ (CORS) は付かない。
 * **端末ごとに覚える** (`keep.ts`。バックグラウンド再生と同じ)
 */
interface Options {
  /** 再生しているか。止めている間は写さない (光は残す) */
  playing: () => boolean;
  /** canvas に描いているときのプレイヤー (縮めた1枚をくれる)。`<video>` で観ているときは null */
  canvas: () => { grab(size: GrabSize): Promise<ImageBitmap | null> } | null;
  video: () => HTMLVideoElement | null;
}

export interface Ambient {
  /** オンにしているか */
  readonly on: boolean;
  toggle: () => void;
  readonly playing: boolean;
  /** いまのコマを `size` に縮めて写す。まだ映していなければ null */
  glance: (size: GrabSize) => Promise<ImageBitmap | null> | null;
}

/** 縮めてもらう worker の返事を待つ長さ。詰まっていたら諦めて次の回に */
const GLANCE_WAIT = 1_000;

export function ambientMode(options: Options): Ambient {
  /** 開いた端末で決まる。サーバで組むときは無いので、開いてから読む */
  let on = $state(false);
  $effect(() => {
    on = storedAmbient(read(AMBIENT_KEY));
  });

  /** `<video>` のコマを縮める worker。初めて要るときに作り、画面を離れたら畳む */
  let worker: Worker | null = null;
  let broken = false;
  let asked = 0;
  const waiting = new Map<number, (bitmap: ImageBitmap | null) => void>();
  $effect(() => () => {
    worker?.terminate();
    worker = null;
    for (const settle of waiting.values()) settle(null);
    waiting.clear();
  });

  function viaWorker(
    video: HTMLVideoElement,
    size: GrabSize,
  ): Promise<ImageBitmap | null> | null {
    if (broken || typeof VideoFrame !== "function") return null;
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(video);
    } catch {
      return null;
    }
    if (worker === null) {
      try {
        worker = new Worker(new URL("./glance-worker.ts", import.meta.url), {
          type: "module",
        });
      } catch {
        broken = true;
        frame.close();
        return null;
      }
      worker.onmessage = (event: MessageEvent<GlanceReply>) => {
        const settle = waiting.get(event.data.id);
        if (settle === undefined) event.data.bitmap?.close();
        else settle(event.data.bitmap);
      };
      // 読み込めない (CSP など) なら、もう使わない。画面の側で縮める
      worker.onerror = () => {
        broken = true;
        for (const settle of waiting.values()) settle(null);
      };
    }
    const id = ++asked;
    const request: GlanceRequest = { id, frame, size };
    const target = worker;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(null), GLANCE_WAIT);
      const settle = (bitmap: ImageBitmap | null) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(bitmap);
      };
      waiting.set(id, settle);
      try {
        target.postMessage(request, [frame]);
      } catch {
        // コマを worker へ渡せないブラウザ。もう使わない
        frame.close();
        broken = true;
        settle(null);
      }
    });
  }

  function videoGlance(
    video: HTMLVideoElement | null,
    size: GrabSize,
  ): Promise<ImageBitmap | null> | null {
    if (
      video === null ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.videoWidth === 0
    ) {
      return null;
    }
    return viaWorker(video, size) ?? createImageBitmap(video, shrink(size));
  }

  return {
    get on() {
      return on;
    },
    toggle() {
      on = !on;
      write(AMBIENT_KEY, on ? "1" : "0");
    },
    get playing() {
      return options.playing();
    },
    glance(size) {
      const canvas = options.canvas();
      return canvas !== null
        ? canvas.grab(size)
        : videoGlance(options.video(), size);
    },
  };
}
