/**
 * **iOS でホーム画面へ戻ると止められる `<video>` を、1 回だけ再生し直す** (`background.svelte.ts` のオンのとき)。
 *
 * iOS 27 の Safari とホーム画面の Web アプリでは、バックグラウンド再生をオンにしていても、隠れる直前に
 * `<video>` が止められる (ページからは pause を呼んでいない。#1681)。音つきなら、そこで play() すれば続く。
 *
 * - 隠れる 300ms 前から隠れて 1.5 秒の間に止められたものだけ。1 回だけで、断られても繰り返さない
 * - ページのボタンとロック画面 (MediaSession) で止めたものは戻さない。MediaSession を使えない端末では、
 *   外から止められたのと見分けられないので戻さない
 * - 音を消している・終わった・中身がまだ無い・ほかの音に割り込まれている (`audioSession`) ときも戻さない
 */
export interface NativeVideo extends EventTarget {
  readonly paused: boolean;
  readonly ended: boolean;
  readonly muted: boolean;
  readonly readyState: number;
  play(): Promise<void>;
}

export interface MediaActions {
  setActionHandler(
    action: "play" | "pause",
    handler: (() => void) | null,
  ): void;
}

interface Options {
  video: NativeVideo;
  page: EventTarget;
  visibility: EventTarget & { readonly visibilityState: string };
  /** ロック画面などの操作 (`navigator.mediaSession`)。無い端末は undefined */
  media: MediaActions | undefined;
  /** オンで、小窓を出していないか */
  enabled: () => boolean;
  /** ページのボタンで止めているか */
  userPaused: () => boolean;
  /** 音が出ているか。音を別に鳴らしているときは `<video>` が消音でも鳴っている (無ければ `video.muted` で見る) */
  audible?: () => boolean;
  pause: () => void;
  resume: () => void;
  interrupted: () => boolean;
  now: () => number;
}

const BEFORE_HIDE = 300;
const AFTER_HIDE = 1500;

/** 見張りを始める。返す関数で止める */
export function nativeBackgroundRecovery(options: Options): () => void {
  const { video, page, visibility, media } = options;
  let hidden = visibility.visibilityState === "hidden";
  let gone = false;
  /** 最後に再生していた時刻。再生中は Infinity */
  let playedAt = video.paused ? -Infinity : Infinity;
  /** ここまでに止められたら戻す。戻したら (1 回きり) と、見えたら -Infinity */
  let until = -Infinity;
  let remotePause = false;
  let controls = false;

  const play = () => void video.play().catch(() => {});

  function recover(): void {
    if (!hidden || !video.paused || options.now() > until) return;
    if (!controls || gone || remotePause || !options.enabled()) return;
    if (options.userPaused() || options.interrupted()) return;
    if (
      video.ended ||
      !(options.audible?.() ?? !video.muted) ||
      video.readyState < 2
    )
      return;
    // play() の中で pause が来ても繰り返さないよう、先に閉じる
    until = -Infinity;
    play();
  }

  const listeners: [EventTarget, string, () => void][] = [
    [
      video,
      "playing",
      () => {
        playedAt = Infinity;
        remotePause = false;
      },
    ],
    [
      video,
      "pause",
      () => {
        if (playedAt === Infinity) playedAt = options.now();
        recover();
      },
    ],
    [
      video,
      "ended",
      () => {
        playedAt = -Infinity;
        until = -Infinity;
      },
    ],
    [
      visibility,
      "visibilitychange",
      () => {
        const next = visibility.visibilityState === "hidden";
        if (next && !hidden) {
          const now = options.now();
          until = now - playedAt <= BEFORE_HIDE ? now + AFTER_HIDE : -Infinity;
        } else if (!next) until = -Infinity;
        hidden = next;
        recover();
      },
    ],
    [
      page,
      "pagehide",
      () => {
        gone = true;
        until = -Infinity;
      },
    ],
    [page, "pageshow", () => (gone = false)],
  ];
  for (const [target, event, handler] of listeners)
    target.addEventListener(event, handler);

  try {
    media?.setActionHandler("pause", () => {
      remotePause = true;
      until = -Infinity;
      if (!options.userPaused()) options.pause();
    });
    media?.setActionHandler("play", () => {
      remotePause = false;
      if (options.userPaused()) options.resume();
      else play();
    });
    controls = media !== undefined;
  } catch {
    // 受け付けない端末。外から止めたのと見分けられないので、戻さない (controls のまま false)
  }

  return () => {
    until = -Infinity;
    for (const [target, event, handler] of listeners)
      target.removeEventListener(event, handler);
    try {
      media?.setActionHandler("pause", null);
      media?.setActionHandler("play", null);
    } catch {
      // 受け付けない端末
    }
  };
}
